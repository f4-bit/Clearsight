# Clearsight backend (Fastify + Prisma)

Capa de datos y endpoints de feedback/ETL del backend. Convive con `backend/app/`
(Python/FastAPI, aún con placeholders) hasta que se retire.

```
src/
  app.ts · server.ts          Fastify + arranque
  config/env.ts               validación Zod del entorno
  lib/prisma.ts               PrismaClient (adapter pg, Prisma 7)
  schemas/                    contrato Zod (common, clinical, patient, consultation, image, inference, feedback, auth)
  repositories/               CRUD Prisma: user, patient, consultation, image, inference, feedback
  services/gold-standard-export.ts   export anonimizado JSON/CSV (lo usan la ruta y el ETL)
  services/audit.ts            auditoría transaccional compartida (wrapper + writer)
  services/auth-web-session.ts refresh opaco (rotación/reuso) y logout transaccionales
  services/auth-cookies.ts     cookie clearsight_refresh (serialización/lectura estricta)
  services/web-auth-policy.ts  AUTH_PUBLIC_ORIGIN exacto y guard de origen
  services/refresh-tokens.ts   CSPRNG 32 bytes + hash SHA-256 (nunca token crudo en DB)
  services/admin-bootstrap.ts  bootstrap controlado del primer ADMIN (transacción + auditoría)
  services/admin-users.ts      alta/lectura/ciclo de vida admin (lock global, actor fresco, revocación, auditoría)
  lib/canonical-email.ts       contrato canónico de email compartido login/bootstrap/alta
  middleware/                 auth (JWT HS256) y rbac — mínimos, reemplazables por los del módulo de auth
  routes/feedback.ts          POST /feedback · GET /export/gold-standard
  routes/admin.ts             GET/POST /admin/users y GET/PATCH /admin/users/:id (ADMIN; sin DELETE)
prisma/                       schema.prisma · migrations/ · seed.ts
scripts/bootstrap-admin.ts    CLI env-only del primer administrador
scripts/etl-feedback.ts       ETL feedback validado -> dataset de reentrenamiento
tests/                        Vitest + Postgres efímero
```

## Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env                 # DATABASE_URL, JWT_SECRET, EXPORT_HMAC_SECRET
npx prisma generate                  # genera src/generated (gitignored)
npm run prisma:deploy                # preflight auditable + aplica prisma/migrations
npx prisma db seed                   # datos sintéticos (nunca en production)
npm run dev
```

## Storage provider (3.2)

- `STORAGE_PROVIDER=minio` es el default retrocompatible y `azure` es explícito; cualquier otro valor falla cerrado. `STORAGE_ID` es lógico y por defecto es `minio-local` o `azure-blob-default` según el provider.
- `STORAGE_ALLOWED_BUCKETS` es un CSV opcional del provider activo. Ausente usa `MINIO_BUCKET_RAW` + `MINIO_BUCKET_GRADCAM`; explícito no vacío se valida y deduplica; explícito vacío falla cerrado (no existe “allow all”). El default de cada contexto debe pertenecer a la lista. La resolución de referencias usa solo metadata trusted y no exige credenciales Azure ni red.
- `STORAGE_DOWNLOAD_TTL_SECONDS` acepta enteros de 1 a 3600 con default 3600; es **default, no cap**: un caller explícito puede pedir hasta 3600 aunque el default sea menor. Los callers legacy conservan 3600; la adopción de 300 s queda para 3.4/4.8.
- MinIO mantiene el endpoint interno y el endpoint distinto de `ML_PUBLIC_HOST` con sus puertos. `ensure` crea solo en `404`/not found, acepta `AlreadyOwnedByYou` en carrera y no absorbe `BucketAlreadyExists` ajeno. Upload valida `contentType` antes de I/O y verifica `HeadObject` (longitud/tipo); un mismatch no borra el objeto. Un fallo genérico de upload se normaliza a `storage_upload_failed`; `401`/`403` conservan `storage_permission_denied`. `MINIO_SECURE` solo acepta booleanos o los strings exactos `true`/`false`; `TRUE`/`yes`/`1` fallan cerrado.
- Azure Blob usa el SDK oficial `@azure/storage-blob@12.32.0` con `SharedKeyCredential`. La configuración es explícita: URL HTTPS, nombre de cuenta y clave; la URL debe ser exactamente `https://<account>.blob.core.windows.net` (sin path, query, userinfo ni wildcard) y la cuenta debe ser `AzureCloud`. Si falta o es inválida, falla cerrado y no cae a MinIO.
- Azure `ensure` solo comprueba la existencia del contenedor y **no** lo crea. Upload usa `uploadData` y verifica `getProperties` (longitud y tipo). `sign` comprueba el objeto antes de emitir el SAS por objeto, HTTPS y con expiración acotada; el SDK oficial emite `sp=r`, `sr=b`, `spr=https` (D22 usa `p=r` como abreviatura de permisos de lectura). No se usan APIs privadas ni criptografía SAS casera.
- Managed Identity no está soportada en 3.2; queda para 8.x. No se leen `.env.azure`, no se versionan claves reales y no se crean recursos en runtime.
- `StorageService` conserva la misma API pública (`ensureBucket`, `upload`, `getDownloadUrl`, `getMlDownloadUrl`, `getObjectStream`, export `s3Client`); `getStorageId()` es aditivo. Azure `sign` usa `generateBlobSASQueryParameters` con `StorageSharedKeyCredential`.
- Tests herméticos: dobles de SDK, firma real offline con cuentas/claves sintéticas y MinIO con comandos/reloj fake; no requieren Azure real, Azurite ni Docker. La firma Azure no crea/modifica/destruye recursos.
- **QA final 3.2 PASSED:** focus storage **2 files / 36 tests** (35 + 1 QA), unit completo **33 files / 473 tests** (472 + 1 QA), integración focal **3 files / 41 tests** re-ejecutada final, `typecheck` **0**, `build` **0** reutilizado del mismo source, audit **13** baseline **13** (8 moderate, 5 high; delta 0, sin advisory Azure). `3.2` queda `[x]`; `3.8` sigue `[ ]` parcial y depende de `3.4`.

## Bootstrap del primer administrador

El alta pública `POST /auth/register` está **retirada** y responde `410 Gone`: no acepta
rol, no consulta la base, no hashea contraseñas y no emite tokens. El primer `ADMIN` se
crea con un CLI controlado contra una base owned/aprobada:

```bash
cd backend
export MIGRATION_DATABASE_URL='postgresql://...'   # o DATABASE_URL; sin fallback localhost
export BOOTSTRAP_ADMIN_EMAIL='<email-operador>'
export BOOTSTRAP_ADMIN_FULL_NAME='<nombre-completo>'
export BOOTSTRAP_ADMIN_PASSWORD='<secreto-gestionado>'
npm run admin:bootstrap
```

- Las credenciales se leen **solo** de `BOOTSTRAP_ADMIN_*`; no existe `--password` por argv
  ni carga de `.env`/dotenv en la ruta del CLI.
- La contraseña debe tener al menos 12 code points Unicode y como máximo 72 bytes UTF-8
  (límite de bcrypt: se rechaza en vez de truncar). El hash usa bcrypt cost 12.
- Solo se crea el **primer** administrador. Si ya existe cualquier `ADMIN` (activo o no) o
  el email normalizado ya pertenece a otro usuario, el comando falla cerrado sin escribir.
- Usuario y auditoría `ADMIN_BOOTSTRAP` (`SYSTEM`/`USER`/`SUCCESS`) se escriben en la misma
  transacción bajo un lock global; si la auditoría falla, no queda ningún admin.
- La salida no imprime email, contraseña, hash ni DSN. Los tests usan credenciales
  sintéticas y una base efímera de Testcontainers; no se usan datos reales.
- Códigos de salida: `0` = commit confirmado y cleanup completo; `1` = fallo de operación
  (el error primario se conserva aunque el cleanup también falle); `2` = commit confirmado
  con cleanup pendiente. En el caso `2` el recibo sigue siendo
  `[bootstrap] ok userId=... role=ADMIN operationStatus=COMMITTED cleanup=PENDING` y stderr
  solo emite el aviso constante `BOOTSTRAP_DISCONNECT_FAILED`; no se declara rollback.
- Un error de red ambiguo no se presenta como rollback garantizado: la base pudo haber
  confirmado antes de perderse la respuesta. El CLI no reintenta el bootstrap ni crea un
  segundo administrador automáticamente.
- `POST /admin/users` conserva el contrato de alta controlada de 1.8 (default `OFTALMOLOGO`, `isActive:true`, password cost 12).
- `GET /admin/users`, `GET /admin/users/:id` y `PATCH /admin/users/:id` están implementados en 5.4/5.6/9.1 para `ADMIN`; `DELETE` no está implementado (404/405) y no hay hard delete.

## Ciclo de vida administrativo (5.4/5.6/9.1)

- Lectura: listado paginado `{items,total,limit,offset}` con `limit` 1..100 (default 20), `offset>=0`, filtros `role`/`isActive` y `q` literal case-insensitive sobre email/fullName; orden `createdAt DESC id ASC`; DTO de 7 campos seguros, sin hash, tokens, contadores ni sesiones.
- Detalle/PATCH validan UUID y `ADMIN`; el PATCH acepta solo `{email?, fullName?, role?, isActive?}` con al menos un campo y rechaza password/hash/tokenVersion/contadores/actor/grants con `400`.
- Email/role/isActive cambian `tokenVersion` exactamente +1 y revocan en la misma transacción todas las sesiones/refresh/reset no revocados (`ACCOUNT_UPDATED` en sesiones); `fullName` solo no revoca. La reactivación no revive credenciales antiguas.
- El último admin activo no puede autodesactivarse ni autodemoverse (`409 LAST_ACTIVE_ADMIN`); el lock global y los locks ordenados de actor/target serializan carreras y mantienen al menos un admin activo.
- `DELETE /admin/users/:id` no existe: responde 404/405 y no borra ni reasigna consultas, inferencias, feedback ni snapshots. Tampoco concede datasets clínicos ni toca contadores/bloqueos HU01.
- Errores seguros: `400` input, `401`/`403` auth/rol, `404` no encontrado, `409` email o último admin, `503` store/auditoría. Runbook: `docs/hito14-account-lifecycle-runbook.md`.
- Evidencia final HITO14: unit 20/351, lifecycle 1/24, full 18/343 (203.56 s), typecheck/build 0. Un actor stale con UUID desconocido responde `403`; un admin válido con target inexistente responde `404` (la autorización fresca precede a la lectura del target).

## Autenticacion y sesiones

- El access token es un JWT HS256 con `{ sub, role, sessionId, tokenVersion }`; `exp` e `iat` son obligatorios. El TTL por defecto es 15 minutos (`JWT_EXPIRES_IN=15m`) y no puede superar 900 s.
- Cada request protegida valida la firma y los claims, y despues consulta una sesion durable, usuario activo y version/rol vigentes. Token invalido o sesion revocada/expirada responde `401` generico; store no disponible responde `503` sin datos.
- La sesion tecnica es absoluta de 7 dias. Los tokens antiguos que no incluyen `sessionId`/`tokenVersion` dejan de ser validos.
- Nuevos hashes (bootstrap, seed y altas administrativas) usan bcrypt cost 12. Hashes legacy con coste menor (por ejemplo cost 10) siguen siendo aceptados para login; no se re-hashean sin la contrasena.
- HU01: cinco fallos consecutivos responden `429` y bloquean el identificador 15 minutos (contador 5); un exito previo reinicia el contador y el siguiente fallo cuenta 1; un exito durante el bloqueo no desbloquea ni emite sesion; al expirar el boundary exacto el login correcto se permite y resetea.
- Cuota IP complementaria: `IP_RATE_LIMIT=100` intentos por `IP_RATE_WINDOW_SECONDS=60` s (enteros positivos; 0/negativo no desactiva). Comparte cuota entre cuentas detras de una NAT; usa `request.ip` y no confia en `X-Forwarded-For` (`trustProxy:false`). El `429` incluye `Retry-After` positivo y un body generico sin contador, email ni estado de cuenta.
- Los contadores son buckets pseudonimos HMAC-SHA256 (email normalizado / IP), sin PII cruda en tablas ni logs. El reset es logico (ventana/bloqueo), no una purga de evidencia clinica. No se garantiza igualdad estricta de timing ni inmunidad DoS: la cuota IP es complementaria, no un escudo global.
- Los clientes Prisma con schema distinto de `public` deben inyectar un `authService` y un guard construidos con `databaseSchema` igual al schema configurado en el cliente.

### Refresh web, logout y origen público (5.8)

- `POST /auth/login` conserva el JSON actual y entrega el refresh opaco (32 bytes CSPRNG, base64url) **solo** en la cookie `clearsight_refresh`: `HttpOnly`, `Secure`, `SameSite=Lax`, host-only (sin `Domain`) y `Path=/api/auth`. La cookie expira con la sesión absoluta (≤ 7 d). Si firmar, auditar o el commit falla, no se setea cookie.
- `POST /auth/refresh` lee solo la cookie, rota a un único sucesor y responde solo `accessToken`, `tokenType` y `expiresIn`. En DB se guarda únicamente el hash SHA-256 lowercase; el token crudo nunca va a logs, auditoría ni JSON. “Sin body ni `Bearer`” describe el mecanismo de autenticación: el request recomendado no los envía, pero si llegan nunca se usan como credencial ni sustituyen la cookie.
- La familia es la sesión (`user_sessions`) y sus `refresh_tokens`. El reuso (incluidas dos solicitudes concurrentes del mismo token) confirma la revocación de la sesión y de toda la cadena **antes** de responder `401`; no hay ventana de gracia. El cliente debe hacer single-flight.
- `POST /auth/logout` exige `Bearer` de una sesión válida, responde `204`, revoca sesión y cadena con auditoría y limpia la cookie con los mismos atributos. La cookie sola nunca autoriza. Si el request incluye `Origin`, pasa el mismo guard.
- Login/refresh exigen `Origin` exactamente igual a `AUTH_PUBLIC_ORIGIN` (URL `http(s)` normalizada, sin wildcard) antes de bcrypt/DB. `Origin` ausente/null/mismatch ⇒ `403`; `Sec-Fetch-Site: cross-site` ⇒ `403`. Si la configuración falta, los endpoints de cookie responden `503` fail closed; una configuración inválida aborta el arranque sin fallback. `/auth/me` no cambia.
- Lock order refresh/logout: user → session → refresh. La lectura inicial es no bloqueante; toda decisión se re-lee fresca bajo locks. Los errores de store/auditoría/firma responden `503` con rollback y sin Set-Cookie de éxito.
- **H2 (hardening futuro):** el reuso de un token ya consumido puede escribir auditoría/locks en cada intento; D19 no exige rate-limit adicional. Es un límite conocido de amplificación, no una regresión abierta, y no se promete resuelto.
- **H3 (logging):** la redacción actual cubre `Authorization`, `Cookie`, `Set-Cookie` y campos de credenciales. Serializers custom futuros requieren revisión contra esa lista; no hay fuga actual.
- Este hito no es un release de seguridad completo: reset de contraseña (5.9) y lectura de auditoría (9.2) siguen pendientes. Ownership/grants (5.2), ciclo de vida 5.4/5.6/9.1 y refresh/logout 5.8 están implementados; 5.8 cerrada por QA PASSED.

## Auditoria transaccional (5.5)

- `src/services/audit.ts` expone `withAuditedTransaction(db, work, options?)` y `writeAuditEvent(context, input)`. El wrapper abre la transaccion con el `$transaction` publico de Prisma y entrega un contexto opaco con `.tx`; la identidad del contexto vive en un `WeakMap` privado y solo es valida durante el callback.
- `writeAuditEvent` usa `context.tx.auditEvent.create` en la misma transaccion. Rechaza cliente raiz, `tx` crudo, objetos fabricados, clones y contextos cerrados antes de escribir. Un callback exitoso debe registrar al menos un evento; si la auditoria falla, el fallo es sticky y la transaccion revierte aunque el callback lo capture.
- Los llamadores actuales son `services/admin-bootstrap.ts`, `services/admin-users.ts` y `services/session.ts`, todos con `await writeAuditEvent(...)`. La composicion anidada de `withAuditedTransaction` sobre el mismo root DB queda fuera de alcance; no se promete soporte para callbacks fire-and-forget ni codigo propio malicioso.
- `POST /admin/users` (1.8), GET/PATCH de ciclo de vida (5.4/5.6/9.1), ACL clínico (5.2) y refresh/logout web (5.8) están implementados sin frontend; lectura de auditoría 9.2 y reset de contraseña 5.9 siguen pendientes.

## Migraciones

- El único entrypoint soportado es `npm run prisma:deploy` (`scripts/migrate-deploy.ts`). Sustituye el
  antiguo `prisma migrate deploy || prisma migrate resolve` y nunca resuelve una migración tras un
  error arbitrario. El DSN se toma de `MIGRATION_DATABASE_URL` (preferida) o `DATABASE_URL`; no hay
  valor por defecto `localhost` ni lectura de `.env` en esta ruta.
- El wrapper abre una transacción **solo lectura** para inspeccionar `pg_catalog` y la tabla de
  bookkeeping de Prisma, la cierra y solo después ejecuta el CLI local de Prisma con un lock
  consultivo por base/schema. Su salida no imprime el DSN, credenciales, hosts ni logs crudos.
- Estados:
  - schema vacío sin historial: un único `migrate deploy`;
  - baseline exacto de `0_init` sin historial (o con `_prisma_migrations` vacía): verifica catálogo,
    columnas, defaults, constraints, índices y triggers; si coincide, `migrate resolve --applied 0_init`
    una vez y después `migrate deploy` una vez. Se permiten datos legacy poblados: no se leen filas
    clínicas ni se exige que estén vacías;
  - historial Prisma válido, con prefijo exacto de migraciones conocidas y checksums de archivo:
    `migrate deploy` normal, sin resolve;
  - historial fallido/incompleto/desconocido o esquema divergente: fallo cerrado antes de cualquier
    resolve/deploy. Las bases actualizadas manualmente sin historial Prisma requieren una adopción
    manual fuera de este wrapper.
- La adopción de una base inicializada solo con `init.sql` presupone una ventana de mantenimiento
  exclusiva: no protege frente a DDL administrativo concurrente.
- El preflight exige PostgreSQL >= 13 (`gen_random_uuid()` en el core) y la comparación de catálogo se
  validó contra PostgreSQL 16. Una versión con forma de catálogo distinta no coincide con el manifiesto
  y falla cerrada, sin autocorregir.
- El manifiesto y el inventario usan checksums canónicos LF (solo `CRLF -> LF`, sin trim, BOM ni
  reescritura SQL). El historial acepta únicamente las variantes LF/CRLF del mismo SQL canónico;
  `.gitattributes` fija `eol=lf` para migraciones, manifiesto e `init.sql`. Un cambio semántico del SQL
  sigue fallando por checksum.
- Además de tablas/columnas/constraints/índices/triggers, el baseline rechaza objetos inesperados en el
  schema objetivo: vistas, matviews, foreign tables, secuencias, tipos/dominios/composites/ranges,
  funciones/procedimientos/agregados y extensiones. Solo captura tipo+nombre, nunca el cuerpo.
- `0_init` es `docker/init.sql` **tal cual** (idempotente: `IF NOT EXISTS`); un test compara ambos
  ficheros y el manifiesto de baseline fija su SHA-256. `prisma.migrate.config.ts` es la configuración
  dedicada del wrapper (sin dotenv ni fallback).
- `20261027000000_prisma_alignment` aplica los cambios sobre el baseline (también re-ejecutable):
  - tabla `users` (+ enum `user_role`); FKs `consultations.doctor_id` y `clinical_feedback.doctor_id` → `users`
    (los `doctor_id` huérfanos se convierten en usuarios placeholder desactivados);
  - `consultations.status` con el vocabulario único de `ml/service/schemas.py` (`PENDIENTE→QUEUED`,
    `EN_PROCESO→QUEUED`, `COMPLETADA→COMPLETED`, `FALLIDA→FAILED`) + CHECK;
  - `inferences`: `job_id` (único), `cdr`, `cdr_vertical`, `quality`, `artifacts`, `elapsed_seconds`;
  - `clinical_feedback`: `validated_class` admite NULL (no concluyente), `updated_at`,
    único `(inference_id, doctor_id)` (los duplicados previos se reducen al más reciente) y
    CHECK «un NULL nunca es gold standard».
- Cambios futuros: editar `schema.prisma` y `npx prisma migrate dev --name <cambio>`.
- Comprobar que `schema.prisma` y la BD no difieren (0 drift):
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
- Equivalente al `db pull` inicial, para comparar: `npx prisma db pull --print` sobre una BD creada solo con `init.sql`.

## Endpoints

| Ruta | Rol | Notas |
| --- | --- | --- |
| `POST /auth/login` | Público (rate limit/HU01 + `Origin` exacto) | Zod; `200` JSON actual + cookie `clearsight_refresh`; `401` genérico; `403` origen; `429` genérico con `Retry-After` (5 fallos/15 min y cuota IP 100/60); `503` fail closed sin datos ni cookie. |
| `POST /auth/refresh` | Cookie `clearsight_refresh` (sin body/Bearer) | Rota single-use; `200 {accessToken,tokenType,expiresIn}`; `401` genérico (incluye reuso); `403` origen; `503` sin Set-Cookie de éxito. |
| `POST /auth/logout` | Bearer + sesión válida | `204`; revoca sesión/cadena con auditoría y limpia la cookie; `401`/`403`/`503`; la cookie sola no autoriza. |
| `GET /auth/me` | Bearer + sesión vigente | Valida firma/claims, sesión durable, usuario activo y rol/versión; `401`/`503`. Sin cambios por 5.8. |
| `POST /feedback` | `OFTALMOLOGO` (dueño de la consulta) | Zod + upsert por `(inference_id, doctor_id)`. `doctor_id` sale del JWT; `predicted_class`, `confidence` y `agreement` se derivan de la inferencia guardada (lo que mande el cliente se ignora). `validated_class: null` = no concluyente y no puede ser gold standard. Siempre responde 200 con la fila guardada. |
| `GET /export/gold-standard?format=json\|csv&since=<ISO>&limit=<n>` | `INVESTIGADOR`, `ADMIN` | Solo `is_gold_standard = true`. Anonimizado: `doctor_id` = HMAC-SHA256 con `EXPORT_HMAC_SECRET`; sin notas, sin ids de paciente/consulta. Cabecera `x-has-more`. El CSV tiene las columnas que lee `scripts/retrain_cycle.py --samples`. |

Orden de clases del ML (¡no es «Normal» = 0!): `0 = Glaucoma`, `1 = Non_Glaucoma`, `2 = Suspicious_Glaucoma`.

## ETL de reentrenamiento

```bash
export DATABASE_URL=... EXPORT_HMAC_SECRET=...
npm run etl:feedback -- --out data/gold.csv --state data/.etl-state.json --min-samples 50
python ../scripts/retrain_cycle.py --samples data/gold.csv
```

`--state` guarda la marca de agua (solo exporta lo validado desde la última corrida);
`--min-samples N` no escribe nada y sale con código 3 hasta acumular N filas nuevas.

## Tests

El runner está dividido en dos allowlists explícitas:

```bash
npm test                 # runner unitario por defecto (seguro, sin DB/Redis/red)
npm run test:unit        # idéntico: schemas, sanitizer y tests/unit/**
npm run test:watch       # watch del runner unitario
npm run test:integration # explícito; requiere Docker/Testcontainers
```

- `npm test` y `test:unit` no ejecutan `globalSetup`, no abren DB ni levantan servicios. Un filtro
  CLI solo puede reducir la allowlist (p. ej. `npm run test:unit -- tests/repositories.test.ts`
  termina con «No test files found», exit 1).
- `test:integration` conserva los archivos originales de integración/mocks locales y **siempre** crea
  un PostgreSQL efímero en Testcontainers con nombre único, label y marker de ownership. No adopta
  bases externas: si `TEST_DATABASE_URL` está presente (aunque esté vacía o contenga `test`), falla
  antes de crear cliente/contenedor y no imprime la URL.
- El setup cierra cliente y contenedor ante fallo de connect/migración/provide; `resetDb` verifica el
  marker `test_meta` antes de truncar.
- `tests/migration-deploy.integration.test.ts` cubre el wrapper real (Prisma CLI incluido) sobre
  schemas independientes: schema vacío, baseline poblado, repetición sin resolve, historial fallido o
  con checksum alterado y matriz de divergencias.
- Límites: el runner unitario no cubre flujos de negocio/seguridad ni Prisma/Redis/SQL. La
  integración real se ejecutó con Docker/Testcontainers en PostgreSQL 16; no se probó Azure ni una
  base de producción.

### Cierre 5.8 (HITO16, QA PASSED)

```bash
npm --prefix backend run test:unit
npm --prefix backend run test:integration
npm --prefix backend run typecheck
npm --prefix backend run build
```

- Resultado QA final: unit **25 files / 377 tests**; full integration **21 files / 401 tests (270 s)**; `typecheck` **0** repetido después de los tests de QA; `build` reutilizado del mismo source.
- Unitarios nuevos: `tests/unit/auth-cookies.test.ts`, `tests/unit/refresh-tokens.test.ts`, `tests/unit/web-auth-policy.test.ts` y `tests/unit/log-redaction.test.ts`; QA añadió la aserción de cookie duplicada con el mismo valor.
- Integración real: `tests/refresh-session.integration.test.ts` (**21 tests**; QA añadió casos de guard/cookie). No existen `auth-refresh.integration.test.ts` ni `auth-origin.integration.test.ts`; fueron nombres prospectivos.
- Los tests legítimos usan `TEST_ENV.AUTH_PUBLIC_ORIGIN`/`TEST_AUTH_ORIGIN`; los tests de guard inyectan `Origin` explícitamente sin ese helper.
- Docker propios PG/Ryuk limpiados; `redkeep_db` ajeno intacto. Runbook: `docs/hito16-auth-refresh-runbook.md`.
