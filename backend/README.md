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
  services/admin-bootstrap.ts  bootstrap controlado del primer ADMIN (transacción + auditoría)
  middleware/                 auth (JWT HS256) y rbac — mínimos, reemplazables por los del módulo de auth
  routes/feedback.ts          POST /feedback · GET /export/gold-standard
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
- `POST /admin/users` y las sesiones/revocación son tareas posteriores (1.8/5.5); este CLI
  no implementa el ciclo de vida completo de cuentas.

## Autenticacion y sesiones

- El access token es un JWT HS256 con `{ sub, role, sessionId, tokenVersion }`; `exp` e `iat` son obligatorios. El TTL por defecto es 15 minutos (`JWT_EXPIRES_IN=15m`) y no puede superar 900 s.
- Cada request protegida valida la firma y los claims, y despues consulta una sesion durable, usuario activo y version/rol vigentes. Token invalido o sesion revocada/expirada responde `401` generico; store no disponible responde `503` sin datos.
- La sesion tecnica es absoluta de 7 dias. Los tokens antiguos que no incluyen `sessionId`/`tokenVersion` dejan de ser validos.
- Nuevos hashes (bootstrap, seed y futuras altas administrativas) usan bcrypt cost 12. Hashes legacy con coste menor (por ejemplo cost 10) siguen siendo aceptados para login; no se re-hashean sin la contrasena.
- HU01: cinco fallos consecutivos responden `429` y bloquean el identificador 15 minutos (contador 5); un exito previo reinicia el contador y el siguiente fallo cuenta 1; un exito durante el bloqueo no desbloquea ni emite sesion; al expirar el boundary exacto el login correcto se permite y resetea.
- Cuota IP complementaria: `IP_RATE_LIMIT=100` intentos por `IP_RATE_WINDOW_SECONDS=60` s (enteros positivos; 0/negativo no desactiva). Comparte cuota entre cuentas detras de una NAT; usa `request.ip` y no confia en `X-Forwarded-For` (`trustProxy:false`). El `429` incluye `Retry-After` positivo y un body generico sin contador, email ni estado de cuenta.
- Los contadores son buckets pseudonimos HMAC-SHA256 (email normalizado / IP), sin PII cruda en tablas ni logs. El reset es logico (ventana/bloqueo), no una purga de evidencia clinica. No se garantiza igualdad estricta de timing ni inmunidad DoS: la cuota IP es complementaria, no un escudo global.
- Los clientes Prisma con schema distinto de `public` deben inyectar un `authService` y un guard construidos con `databaseSchema` igual al schema configurado en el cliente.
- Este hito no es un release de seguridad completo: ownership/grants (5.2), ciclo de vida administrativo/revocacion masiva (5.6/admin), refresh/logout/cookies (5.8), reset (5.9) y alta admin (1.8) siguen pendientes.

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
| `POST /auth/login` | Público (rate limit/HU01) | Zod; `200` token; `401` genérico; `429` genérico con `Retry-After` (5 fallos/15 min y cuota IP 100/60); `503` fail closed sin datos. |
| `GET /auth/me` | Bearer + sesión vigente | Valida firma/claims, sesión durable, usuario activo y rol/versión; `401`/`503`. |
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
