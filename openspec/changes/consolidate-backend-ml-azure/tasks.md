# Tasks: consolidate-backend-ml-azure

> **Estado:** plan vivo; solo se consideran implementadas las tareas marcadas `[x]` y con evidencia registrada. Implementadas: documentales 0.1/0.3/0.4, migraciones 1.1-1.6, alta 1.8, 3.1, 5.1-5.9 (5.2 en HITO15; 5.8/5.9 con QA PASSED), **2.1 (QA PASSED HITO18)** y 7.0/7.0.1, más ciclo de vida 5.4/5.6/9.1. 5.9 quedó cerrada en HITO17 con full integration QA **23 files / 444 tests**; B8 (proveedor real/credenciales) sigue pendiente de provisioning y **no bloquea** el cierre de 5.9. El resto de tareas de implementación quedan **pending** con comandos como criterios de verificación futuros. Las tareas de **hito posterior** se marcan `[LATER HITO]`; salvo 9.1 (cerrada en HITO14), quedan unchecked pero **no bloqueadas**; las decisiones/restricciones y el fuera de alcance se listan en la tabla final. **B1/B2 quedan resueltos como restricciones aprobadas; B5 elimina hard delete del hito; B3/B4/B5 aplican solo a producción real/purgas; B6 está parcialmente satisfecho por CLI y no es deployment ready; B9 queda fuera de alcance.**

## 0. Documentación y salvaguardas

- [x] 0.1 Crear `defects/regressions.md` con entradas solo estáticas, activas/resueltas, sin inventar runtime ni datos sensibles.
  - **Scope:** `defects/regressions.md`.
  - **When/Then:** WHEN se revisa el registro THEN cada entrada tiene evidencia `archivo:línea`, categoría, condición límite y test esperado.
  - **Test:** revisión documental; no aplica ejecución.
  - **Coverage:** regresiones REG-001..REG-008.

- [ ] 0.2 Congelar el contrato actual vs target y la matriz de autorización antes de tocar rutas.
  - **Scope:** `contracts/frontend-api-contract.md`; revisión con arquitecto/producto.
  - **When/Then:** WHEN frontend recibe el documento THEN CURRENT VERIFIED y TARGET vNext están separados, con estado, auth, grants, body, response, errores y compatibilidad.
  - **Test:** revisión de contrato; no aplica ejecución.
  - **Coverage:** “Contrato HTTP único y explícito para frontend”, “Separación entre contrato actual verificado y target vnext”, “Autenticación y autorización por endpoint y recurso”.

- [x] 0.3 Añadir guard de merge para no reintroducir llamadas `ensure_buckets` sin método o con provider incorrecto.
  - **Scope:** `ml/service/queue.py`, `ml/service/storage.py`, `ml/tests/test_storage.py`, `ml/tests/test_service.py`.
  - **When/Then:** WHEN arranca una cola con MinIO o Azure THEN invoca el método neutral `ensure_storage` existente en ambos providers y no se repite el bug de master (`queue:73/146`).
  - **Test:** `python -m pytest ml/tests/test_storage.py ml/tests/test_service.py -q`.
  - **Coverage:** “Abstracción de almacenamiento dual y firma por provider”, “Contrato público estricto del servicio ML”.

- [x] 0.4 Crear `contracts/testing-runbook.md` con fases, precondiciones, comandos verificados, comandos `FUTURO` y stop de pasos peligrosos.
  - **Scope:** `contracts/testing-runbook.md`; sin código productivo ni tests fuente.
  - **When/Then:** WHEN se prepara una fase THEN distingue objetivo, precondiciones, comandos actuales vs `FUTURO`, criterio de stop y verificación; WHEN un test falla THEN no se hace commit de esa fase.
  - **Test:** `openspec validate consolidate-backend-ml-azure --strict` y `git diff --check` (comprobación documental).
  - **Coverage:** D13, “Pruebas con recursos creados sin filtrar secretos”, “Separación entre bloqueo de deploy y bloqueo de diseño”.

## 1. Esquema y migraciones (grupos independientes)

- [x] 1.1 Migración A: snapshot clínico, ejecución y selección requerida.
  - **Scope:** `backend/prisma/schema.prisma` (`ClinicalSnapshot`; en `Consultation`: `requiredExecutionIds`/`requiredSetVersion`/`requiredSetFrozenAt`; en `Inference`: `consultationId`, `eyeSide`, `snapshotId` mapeado a `clinical_snapshot_id`, `status` y `reanalysisOfId`), `backend/prisma/migrations/20261118000000_execution/migration.sql`; `docker/init.sql` sin cambios (baseline `0_init` inmutable). El deploy Azure actual no ejecuta migraciones incrementales; esa deuda queda en 1.5/8.x. Los estados de entrega/PDF y los agregados derivados quedan para la migración B/2.x, no para A.
  - **When/Then:** WHEN se aplica sobre baseline verificado THEN existen tabla/columnas/índices/constraints/triggers de snapshot y ejecución, incluido el índice GIN de `requiredExecutionIds`; WHEN se lee una ejecución THEN no hay `PROCESSING` ni enum DB de estados agregados; WHEN una fila legacy se conserva THEN snapshot/metadatos quedan NULL/vacíos y la selección requerida vacía, sin backfill falso; WHEN una ejecución congelada cambia imagen/consulta/ojo, snapshot o procedencia THEN se rechaza, aunque el cambio sea dentro del mismo caso/ojo.
  - **Test:** `npm --prefix backend run test:integration -- tests/migrations.test.ts` → **25 tests passed** (upgrade legacy, replay A, invariantes SQL y regresiones F1/F2/F3); `npm --prefix backend run test:integration` → **8 files / 83 tests passed**; `npm --prefix backend run test:unit` → **6 files / 57 tests passed**; `npm --prefix backend run typecheck` y `build` → exit 0; Prisma `validate`/`generate` válidos con `@@index` GIN.
  - **Coverage:** “Una ejecución analiza una sola retinografía con lateralidad”, “Snapshot clínico inmutable por ejecución”, “Selección explícita de ejecuciones requeridas y cambio tras cierre”, “Reanálisis enlazado sin sobrescribir evidencia” (persistencia SQL; los consumidores de aplicación quedan en 2.x).

- [x] 1.2 Migración B: referencias de artefacto y versiones de PDF.
  - **Scope:** `backend/prisma/schema.prisma` (`ArtifactRecord`, `PdfReport`), `backend/prisma/migrations/20261118010000_artifact_reports/migration.sql`, `backend/tests/artifact-migrations.test.ts`, allowlists de integración; `docker/init.sql` sin cambios (baseline inmutable). No implementa rutas, auth, worker ni generación real de PDF; `result` sigue siendo la proyección inline de `Inference` y `ArtifactRecord` guarda binarios `mask`/`overlay`/`pdf`/`gradcam`/`shap`.
  - **When/Then:** WHEN se aplica sobre A THEN existen tablas/columnas/constraints/índices de artefacto y PDF; WHEN una referencia está `AVAILABLE` THEN todos los campos públicos están completos y la identidad/ubicación queda inmutable; WHEN se publica un PDF THEN su artifact es `pdf`, `AVAILABLE`, `application/pdf` y de la misma inferencia/versión; WHEN se crea una versión nueva THEN la anterior no cambia; WHEN una fila legacy no tiene registros THEN no se rellena artificialmente.
  - **Depends on:** 1.1.
  - **Test:** `npm --prefix backend run test:integration -- tests/artifact-migrations.test.ts` → **1 file / 28 tests passed**; `npm --prefix backend run test:integration` → **9 files / 111 tests passed**; `npm --prefix backend run test:unit` → **6 files / 57 tests passed**; `typecheck`/`build` → exit 0; Prisma `validate`/`generate` con config temporal sin dotenv.
  - **Coverage:** “Referencia de artefacto estructurada y estable”, “Idempotencia y versionado del reporte”, “Estado explícito por artefacto”, “Prohibición de persistir credenciales temporales y URLs arbitrarias”. La generación/consumo queda en 3.5, 6.1, 6.2.

- [x] 1.3 Migración C: auditoría, idempotencia y sesiones.
  - **Scope:** `backend/prisma/schema.prisma` (`User` con `tokenVersion`/contadores; `UserSession`, `AuditEvent`, `RefreshToken`, `PasswordResetToken`, `IdempotencyRecord`), `backend/prisma/migrations/20261118020000_identity_audit/migration.sql`, `backend/tests/identity-migrations.test.ts`, allowlists; `docker/init.sql` sin cambios. Solo persistencia: no auth routes, workers, servicios ni login/reset behavior. El outbox de 4.6 **no** está en C.
  - **When/Then:** WHEN se aplica THEN existen constraints de idempotencia única por alcance, auditoría append-only, sesiones durables y credenciales hash-only; WHEN se modifica una identidad/credencial/historial THEN la inmutabilidad o el append-only lo rechaza; WHEN se reaplica C THEN no se reescriben filas durables.
  - **Depends on:** 1.1.
  - **Test:** `npm --prefix backend run test:integration -- tests/identity-migrations.test.ts` → **1 file / 18 tests passed**; `npm --prefix backend run test:integration` → **10 files / 129 tests passed**; `npm --prefix backend run test:unit` → **6 files / 57 tests passed**; `typecheck`/`build` → exit 0; Prisma `validate`/`generate` con config temporal sin dotenv.
  - **Coverage:** “Idempotencia persistida del backend” (solo unicidad/replay DB; servicio 4.4), “Auditoría append-only de acciones sensibles” (servicio 5.5), “Sesiones, refresh, logout y recuperación seguros” (comportamiento 5.7/5.8/5.9). 5.7, 5.8 y 5.9 están implementadas con QA; 5.9 cerró en HITO17.

- [x] 1.4 Constraints e índices de integridad.
  - **Scope:** `backend/prisma/migrations/20261118030000_integrity_hardening/migration.sql`, `backend/tests/integrity-migrations.test.ts`, allowlists; A/B/C sin editar. Incluye locks deterministas de selección/contexto, guard de reparentado de imagen y rol global `clearsight_app` con grants mínimos. No crea LOGIN, no cambia runtime/DSN ni credenciales.
  - **When/Then:** WHEN freeze y borrado/contexto compiten THEN las dos órdenes terminan con rechazo explícito y sin estado inconsistente; WHEN una imagen con inferencias intenta cambiar consulta/ojo THEN se rechaza; WHEN la app ejecuta DML permitido THEN funciona, pero auditoría/snapshot no se mutan, no hay DELETE/TRUNCATE ni DDL; WHEN D se reaplica THEN no reescribe evidencia ni degrada el rol.
  - **Depends on:** 1.2, 1.3.
  - **Test:** `npm --prefix backend run test:integration -- tests/integrity-migrations.test.ts` → **1 file / 25 tests passed**; `npm --prefix backend run test:integration` → **11 files / 154 tests passed**; `npm --prefix backend run test:unit` → **6 files / 57 tests passed**; `typecheck`/`build` → exit 0; Prisma `validate` con schema sin cambios.
  - **Coverage:** “Idempotencia persistida del backend”, “Auditoría append-only de acciones sensibles”, “Referencia de artefacto estructurada y estable”, integridad transaccional freeze/delete/contexto y mínimo privilegio DB. No declara todas las carreras/superuser/TRUNCATE resueltas.

- [x] 1.5 Condicionar la resolución de `0_init` a un esquema verificado.
  - **Scope:** `backend/scripts/migrate-deploy.ts`, `backend/scripts/helpers/migration-preflight.ts`, `backend/scripts/helpers/postgres-migration-introspection.ts`, `backend/scripts/helpers/postgres-migration-runtime.ts`, `backend/src/services/migration-deployment.ts`, `backend/prisma.migrate.config.ts`, `backend/prisma/baseline/0_init.baseline.json`, `.gitattributes`, `docker/migrate.Dockerfile`, `backend/package.json`, `scripts/e2e-backend.ps1`, `backend/README.md`, `docs/hito8-migration-deploy-runbook.md`.
  - **When/Then:** WHEN el esquema diverge del baseline exacto, contiene objetos inesperados (vistas, secuencias, funciones, dominios, composites, extensiones) o cambia el SQL semánticamente THEN el wrapper falla con código/fase estables antes de cualquier `resolve`/`deploy`; WHEN el catálogo coincide exactamente con `0_init` sin historial THEN ejecuta `migrate resolve --applied 0_init` una vez y `migrate deploy` una vez; WHEN el schema está vacío o el historial Prisma es válido THEN despliega sin resolve; WHEN el historial está fallido/incompleto/desconocido o cambió un checksum THEN falla cerrado sin CLI; WHEN el checkout es CRLF o LF THEN el checksum canónico LF y las variantes LF/CRLF del mismo SQL se aceptan sin reescribir historial.
  - **Test:** `npm --prefix backend run test:unit` → **8 files / 109 tests passed**; `npm --prefix backend run test:integration -- tests/migration-deploy.integration.test.ts` → **1 file / 27 tests passed** (histórico previo: 26); `npm --prefix backend run test:integration` → **12 files / 182 tests passed** (histórico previo: 180); `typecheck`/`build` → exit 0; Prisma `validate`/`generate` con `prisma.migrate.config.ts` y URL sintética → exit 0; Docker build + árbol LF + URL inválida → readiness gate OK, `MIGRATION_CONNECTION_FAILED`, exit 1 sin filtrar el DSN.
  - **Coverage:** “Database Schema Initialization (init.sql)”, resolución condicionada, fallo cerrado, portabilidad CRLF/LF y objetos inesperados. No declara verificado el deploy real en Azure ni una base de producción.

- [x] 1.6 Implementar bootstrap de administrador controlado y eliminar el alta pública con rol.
  - **Scope:** `backend/prisma/seed.ts`, `backend/src/routes/auth.ts:18-60`, `backend/src/schemas/auth.ts`; nuevo script de bootstrap.
  - **When/Then:** WHEN un cliente público envía `role=ADMIN` THEN no se crea un administrador; WHEN se ejecuta el bootstrap aprobado THEN se crea el primer admin de forma auditable.
  - **Test:** `npm --prefix backend run test:unit` → **11 files / 138 tests passed**; `npm --prefix backend run test:integration -- tests/admin-bootstrap.integration.test.ts` → **1 file / 32 tests passed**; `npm --prefix backend run test:integration` → **13 files / 214 tests passed**; `typecheck`/`build` → exit 0. Incluye la regresión real de `result` conocido + `$disconnect` que falla: exit `2`, `operationStatus=COMMITTED cleanup=PENDING`, aviso constante y sin secreto.
  - **Coverage:** “Bootstrap de administrador controlado”, “Tres roles con mínimo privilegio y default deny”. No implementa `POST /admin/users` (1.8), sesiones/refresh/revocación (5.5) ni el ciclo de vida completo de administración.

- [ ] 1.7 Backfill y compatibilidad de datos legacy.
  - **Scope:** migraciones A/B; normalización de `consultations.status`, referencias `s3://`/`azure://`, alias `Phakic_Pseudophakic`, `hashMd5` actual vs `checksumSha256` target.
  - **When/Then:** WHEN se migra una base legacy THEN las filas siguen legibles y ningún estado, hash o key cambia de significado.
  - **Depends on:** 1.1, 1.2.
  - **Test:** `npm --prefix backend run test -- tests/migrations.test.ts tests/schemas.test.ts`.
  - **Coverage:** “Compatibilidad de referencias legacy”, “Compatibilidad y evolución del contrato”, “Nombres canónicos, mapeo y lateralidad”.

- [x] 1.8 Implementar `POST /admin/users` como alta controlada prioritaria desde el primer release.
  - **Scope:** nueva ruta admin `backend/src/routes/admin.ts` y registro en `backend/src/app.ts`; DTO canónico de email y alta en `backend/src/schemas/auth.ts`; servicio transaccional `backend/src/services/admin-users.ts` sobre `withAuditedTransaction` y `ADMIN_LIFECYCLE_LOCK_KEY`; helper puro `backend/src/lib/canonical-email.ts` compartido con login/bootstrap/guard; ajustes de email literal en `backend/src/services/{admin-bootstrap,session,login-guard}.ts`; tests unitarios e integración owned. Sin frontend. `GET/PATCH /admin/users`, desactivación, cambio de rol y protección del último admin se implementan en 5.4/5.6/9.1 (HITO14); la lectura de auditoría sigue en 9.2.
  - **When/Then:** WHEN se retira el registro público (`410`) THEN el alta admin está disponible; WHEN se crea una cuenta THEN el default es `OFTALMOLOGO` e `isActive:true` es server-owned; WHEN se asigna `ADMIN` o un grant THEN solo un admin autenticado puede hacerlo y se audita alta/rol en la misma transacción; WHEN llegan campos de actor/actividad/hash/versión/contador en el body THEN `400` sin efecto; WHEN el email no es compatible con el DTO de login THEN bootstrap y alta lo rechazan antes de DB; WHEN dos altas compiten por el mismo email/case THEN exactamente una `201` y una `409` con un usuario y una auditoría; WHEN falla la auditoría THEN rollback sin USER fantasma.
  - **Depends on:** 1.3, 1.6, 5.5.
  - **Test:** `npm --prefix backend run test:unit` -> **19 files / 335 tests passed**; `npm --prefix backend run test:integration -- tests/user-admin.integration.test.ts` -> **1 file / 24 tests passed**; foco auth/admin `npm --prefix backend run test:integration -- tests/admin-bootstrap.integration.test.ts tests/auth-sessions.integration.test.ts tests/login-protection.integration.test.ts tests/user-admin.integration.test.ts` -> **4 files / 117 tests passed (histórico pre-QA)**; `npm --prefix backend run test:integration` -> **17 files / 319 tests passed (259.43 s)**; `npm --prefix backend run typecheck` y `npm --prefix backend run build` -> exit 0. PostgreSQL 16 de Testcontainers owned; sin Azure, `.env.azure`, PHI, correos reales ni DB externa/producción.
  - **Histórico pre-QA conservado:** unit 19/333, foco auth/admin 4/117 e integración completa 17/312; no es el resumen final.
  - **Coverage:** "Bootstrap de administrador controlado", "Tres roles con mínimo privilegio y default deny", "Auditoría append-only de acciones sensibles". El alta no concede datasets clínicos por rol y no sustituye 5.2/5.8/5.9.
  - **Trazabilidad 1.8:**

    | Source | Prueba unit/real | Resultado |
    |---|---|---|
    | `backend/src/lib/canonical-email.ts` (contrato compartido + escape literal `\`, `%`, `_`) | `tests/unit/admin-users.test.ts`, `tests/unit/admin-bootstrap-adversarial.test.ts` | unit 19/335 |
    | `backend/src/services/admin-users.ts` (lock global, actor/sesión frescos, USER+audit same tx) | `tests/user-admin.integration.test.ts` | 1 file / 24 tests |
    | `backend/src/routes/admin.ts`, `backend/src/app.ts` (auth/rol, DTO seguro, DI) | `tests/user-admin.integration.test.ts` | incluido en 1/24 |
    | `backend/src/services/admin-bootstrap.ts`, `session.ts`, `login-guard.ts` (email literal/compatible) | `tests/admin-bootstrap.integration.test.ts`, `auth-sessions.integration.test.ts`, `login-protection.integration.test.ts` | histórico foco 4/117 |
    | PostgreSQL owned, rol `clearsight_app`, auditoría y rollback | full integration + labels Docker | full 17/319; sin residuos |

  - **Estado histórico en 1.8:** 5.2 (ACL/ownership clínico), 5.8/5.9 (refresh/reset) y 9.2 (lectura de auditoría) seguían pendientes. Actualización: 5.2 quedó cerrada en HITO15, 5.8 en HITO16 y 5.9 en HITO17 con QA PASSED; 9.2 sigue pendiente. 5.4/5.6/9.1 quedan implementados en HITO14; el alta 1.8 conserva su contrato y default `OFTALMOLOGO`. Release clínica **no** declarada lista.

## 2. Modelo clínico de ejecución

- [x] 2.1 Implementar snapshot clínico inmutable y su repositorio. **QA PASSED HITO18.**
  - **Scope:** nuevo `backend/src/repositories/clinical-snapshot.repo.ts`; `backend/src/repositories/index.ts`; `backend/src/schemas/clinical.ts`. Sin migración/schema, sin endpoints y sin consumidores de 2.2.
  - **When/Then:** WHEN se crea una ejecución THEN se persiste snapshot crudo, normalizado, versión y revisiones; WHEN el payload/versión no es JSON válido THEN se rechaza antes de DB; WHEN cambian datos de consulta o el objeto de entrada THEN el snapshot no cambia; WHEN el repositorio se usa dentro de una TX que falla THEN no queda snapshot.
  - **Test:** `npm --prefix backend run test:unit -- tests/schemas.test.ts` (focal unit) y `npm --prefix backend run test:integration -- tests/repositories.test.ts` (focal repos). El comando anterior `npm --prefix backend run test -- ...` era erróneo para aislamiento unitario; se sustituye por la allowlist unit y la integración explícita.
  - **Evidence HITO18 (QA PASSED; sin source/test edits ni reruns en el cierre):** schemas focal **25 tests** (2 nuevos de QA); repositories **22 tests** (4 asserts reforzadas para esperar `ZodError`); migrations **25 tests**; unit completo **27 files / 405 tests**; `typecheck` **0** post-tests; `build` **0** reutilizado del mismo source; Docker propios **0 residuales** y `redkeep_db` ajeno intacto. No se ejecutó una full integration nueva; QA focal proporcional. Runbook: `docs/hito18-clinical-snapshot-runbook.md`.
  - **Límites:** `create` valida estructura y JSON anidado de datos planos tipados (rechaza `undefined`, `NaN`, `Infinity`, función, bigint, `Date`, `Map`, `Set` y ciclos) y persiste `rawPayload`/`normalizedPayload` verbatim; no normaliza ni resuelve unidades/revisiones. `modelVersions` admite JSON anidado y `{}` significa “no resuelto”. Sin `sources`/`sourceRevision`/`corrections`/hash. No se declara inmutabilidad frente a superuser/DDL/TRUNCATE; solo app role y triggers `UPDATE`/`DELETE`. **Límites QA:** datos JSON planos tipados; profundidad patológica y getters de objetos JS (no HTTP) no cubiertos aún como hardening; no se promete protección universal ni nuevas fuentes/versiones. 2.2 pendiente; Azure/provider/email real pendientes.
  - **Coverage:** “Snapshot clínico inmutable por ejecución”.

- [ ] 2.2 Implementar creación de ejecución con `requiredExecutionIds`, lateralidad validada y reanálisis canónico.
  - **Scope:** `backend/src/routes/inferences.ts`, `backend/src/repositories/inference.repo.ts`, `backend/src/repositories/consultation.repo.ts`, `backend/src/schemas/inference.ts`, `backend/src/schemas/consultation.ts`.
  - **When/Then:** WHEN `eyeSide` no coincide con la lateralidad almacenada de `imageId` THEN `422`; WHEN se solicita reanálisis THEN se usa `POST /inferences` con `reanalysisOf` y no se sobrescribe la ejecución previa.
  - **Depends on:** 1.1, 2.1.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts tests/schemas.test.ts`.
  - **Coverage:** “Una ejecución analiza una sola retinografía con lateralidad”, “Creación y reanálisis canónicos sin endpoints alternativos”, “Nombres canónicos, mapeo y lateralidad”.

- [ ] 2.3 Implementar agregación de consulta con precedencia determinista y `reportState`.
  - **Scope:** nuevo `backend/src/services/consultation-completion.ts`; uso en `backend/src/workers/inference.worker.ts`.
  - **When/Then:** WHEN hay mezcla `FAILED` + `REVIEW_REQUIRED` + running THEN `analysisState=FAILED`; WHEN todo resultado+evidencia está pero falta PDF THEN `reportState=REPORT_PENDING` y `completionState=INCOMPLETE`; WHEN `requiredExecutionIds` vacío THEN `OPEN`.
  - **Depends on:** 6.1, 6.2.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` con casos de una/dos ejecuciones y mezcla de estados.
  - **Coverage:** “Estado agregado de consulta con precedencia determinista”, “Separación entre estado de ejecución, etapa, artefacto y consulta”.

- [ ] 2.4 Tratar `REVIEW_REQUIRED` como terminal de espera automática y evitar cierre o conversión automática.
  - **Scope:** `backend/src/workers/inference.worker.ts:33-47`, estado de revisión en repositorio, caso de reanálisis en `backend/src/routes/inferences.ts`.
  - **When/Then:** WHEN el ML devuelve `REVIEW_REQUIRED` THEN el worker deja de esperar y persiste revisión; WHEN el médico intenta cerrar sin resultado válido THEN no se convierte a `COMPLETED`; WHEN existe PDF THEN no cambia a `COMPLETED` ni se autoaprueba; la resolución es un reanálisis como ejecución nueva con PDF independiente vinculado, sin pisar la anterior.
  - **Depends on:** 2.3.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` (worker stub) y `python -m pytest ml/tests/test_service.py -q`; ver guard de DB en `contracts/testing-runbook.md`.
  - **Coverage:** “Revisión humana terminal sin cierre automático”, B1 como restricción aprobada, “Estados de job y resultado completo”.

- [ ] 2.5 Fijar selección requerida al iniciar y excluir reanálisis históricos no seleccionados.
  - **Scope:** `backend/src/services/consultation-completion.ts`, `backend/src/repositories/consultation.repo.ts`, `backend/src/routes/consultations.ts`.
  - **When/Then:** WHEN se inicia la consulta THEN `requiredExecutionIds` y `requiredSetVersion` quedan fijados; WHEN existe un reanálisis posterior no seleccionado THEN no cambia la completitud de la consulta cerrada; WHEN se intenta promover o reemplazar un ID tras cierre THEN se rechaza por B2 (restricción aprobada) y no se reabre ni altera la consulta automáticamente.
  - **Depends on:** 2.2, 2.3.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts`; ver guard de DB en `contracts/testing-runbook.md`.
  - **Coverage:** “Selección explícita de ejecuciones requeridas y cambio tras cierre” como frozen set, “Reanálisis enlazado sin sobrescribir evidencia”, B2 como restricción aprobada.

- [ ] 2.6 Exponer agregados de consulta sin enum DB nuevo.
  - **Scope:** `backend/src/services/consultation-completion.ts`, `backend/src/routes/consultations.ts`, `backend/src/schemas/consultation.ts`.
  - **When/Then:** WHEN se lee una consulta THEN recibe `requiredExecutionIds`, `requiredSetVersion`, `analysisState`, `reportState`, `completionState`; no se persiste un enum agregado ni `PROCESSING`.
  - **Depends on:** 2.3.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts`.
  - **Coverage:** “Estado agregado de consulta con precedencia determinista”, “Separación entre estado de ejecución, etapa, artefacto y consulta”.

## 3. Storage y artefactos

- [x] 3.1 Implementar `ensure_storage` neutral por provider en ML.
  - **Scope:** `ml/service/storage.py:10-18,62-76,138-148`, `ml/service/queue.py:84,157`; `ml/tests/test_storage.py`.
  - **When/Then:** WHEN el storage es Azure THEN `ensure_storage` verifica con el SDK la existencia de `mask_bucket`/`overlay_bucket` configurados sin crearlos y falla antes de crear el consumer si falta alguno o el SDK falla; WHEN es MinIO THEN delega en `ensure_buckets` y conserva el comportamiento actual; WHEN no hay cliente por configuración opcional THEN no-op.
  - **Test:** `python -m pytest ml/tests/test_storage.py ml/tests/test_service.py ml/tests/test_azure_readiness.py -q`.
  - **Coverage:** “Abstracción de almacenamiento dual y firma por provider”, REG-001.

- [ ] 3.2 Implementar abstracción dual en backend: Azure Blob y MinIO/S3.
  - **Scope:** `backend/src/services/storage.ts` (hoy solo S3/MinIO, líneas 1-98), nuevo `backend/src/services/storage-provider.ts`; Azure SAS read-only objeto/HTTPS/TTL, verificación de existencia y upload; MinIO presign y `ensure`.
  - **When/Then:** WHEN el provider es Azure THEN firma SAS read-only y verifica existencia/upload; WHEN es MinIO THEN usa presign y no asume API Azure; WHEN el provider es desconocido THEN rechaza.
  - **Depends on:** 0.3, 3.1.
  - **Test:** tests nuevos de provider con `Azure fake/Azurite` y MinIO; `npm --prefix backend run test -- tests/repositories.test.ts`.
  - **Coverage:** “Abstracción de almacenamiento dual y firma por provider”.

- [ ] 3.3 Implementar referencia estructurada única y parser legacy central.
  - **Scope:** nuevo `backend/src/services/artifact-reference.ts`; `backend/src/services/storage.ts`; `backend/src/schemas/inference.ts`.
  - **When/Then:** WHEN se guarda una referencia THEN usa `artifactType`, `status`, `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes`, `checksumSha256`, `failureCode`, `retryable`; WHEN llega `s3://`/`azure://` THEN valida esquema/allowlist y conserva key exacta.
  - **Depends on:** 3.2.
  - **Test:** `npm --prefix backend run test -- tests/schemas.test.ts tests/repositories.test.ts` con casos legacy.
  - **Coverage:** “Referencia de artefacto estructurada y estable”, “Compatibilidad de referencias legacy”.

- [ ] 3.4 Implementar listado de artefactos y firma de descarga bajo demanda para ambos providers.
  - **Scope:** nueva ruta `backend/src/routes/artifacts.ts`; `backend/src/services/storage.ts`; `backend/src/app.ts`; TTL configurable (300 s propuesto).
  - **When/Then:** WHEN un usuario autorizado pide URL THEN el backend autoriza y firma; WHEN la URL expira THEN se pide nueva; WHEN no hay permisos THEN se deniega la nueva firma; WHEN el objeto falta THEN se marca inconsistencia.
  - **Depends on:** 3.2, 3.3.
  - **Test:** `npm --prefix backend run test -- tests/rbac.test.ts tests/repositories.test.ts` con storage stub por provider.
  - **Coverage:** “Autorización y firma de descargas bajo demanda”, “Estado explícito por artefacto”.

- [ ] 3.5 Implementar ciclo de vida de artefacto y reconciliación storage/DB.
  - **Scope:** nuevo `backend/src/services/artifact-publication.ts`; `backend/src/repositories/inference.repo.ts`.
  - **When/Then:** WHEN upload OK y falla DB THEN se registra huérfano y se reconcilia/limpia; WHEN DB referencia objeto ausente THEN se marca inconsistencia; WHEN storage no responde THEN reintento acotado y estado explícito.
  - **Depends on:** 1.2, 3.3, 6.2 (ciclo de vida del artefacto PDF).
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` con fallos inyectados.
  - **Coverage:** “Reintento de publicación sin reinferir y consistencia con almacenamiento”.

- [ ] 3.6 Reintentar publicación de artefactos y PDF sin reinferir.
  - **Scope:** `backend/src/workers/inference.worker.ts`, `backend/src/services/artifact-publication.ts`.
  - **When/Then:** WHEN falla la publicación o el PDF pero el resultado es recuperable THEN se reintenta sin volver a llamar al ML.
  - **Depends on:** 6.2, 3.5.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` con stub de ML que cuenta llamadas.
  - **Coverage:** “Reintento de publicación sin reinferir y consistencia con almacenamiento”, “Publicación de artefactos sin reinferir y credenciales internas”.

- [ ] 3.7 Redactar logs de storage y descargas.
  - **Scope:** `backend/src/services/storage.ts`, `backend/src/routes/artifacts.ts`, logger de backend.
  - **When/Then:** WHEN se registra una descarga THEN no aparecen tokens, SAS ni URL completa; solo IDs y resultado.
  - **Test:** `npm --prefix backend run test -- tests/rbac.test.ts` con captura de logs.
  - **Coverage:** “Prohibición de persistir credenciales temporales y URLs arbitrarias”, “Auditoría append-only de acciones sensibles”.

- [ ] 3.8 Tests de provider dual sin Azure real.
  - **Scope:** tests nuevos con Azure fake/Azurite y MinIO; casos de SAS read-only, TTL, HTTPS, existencia, upload y store ausente.
  - **When/Then:** WHEN corre la suite de provider THEN cubre ambos providers y fallos de store sin crear recursos Azure reales.
  - **Depends on:** 3.2, 3.4.
  - **Test:** comando nuevo de tests de integración de storage (prospectivo; no ejecutar en este change).
  - **Coverage:** “Abstracción de almacenamiento dual y firma por provider”, “Reintento de publicación sin reinferir y consistencia con almacenamiento”.

## 4. Contrato ML y orquestación

- [ ] 4.1 Endurecer `POST /v1/inferences` y el contrato estricto.
  - **Scope:** `ml/service/schemas.py:30-49`, `ml/service/main.py:124-149`, `ml/inference/pipeline.py:71-102`.
  - **When/Then:** WHEN llega JSON estricto con `signed image_url` THEN se acepta; WHEN llega multipart, CDR de entrada, host no allowlisted o redirección THEN se rechaza sin inferir.
  - **Test:** `python -m pytest ml/tests/test_service.py -q`.
  - **Coverage:** “Contrato público estricto del servicio ML”.

- [ ] 4.2 Completar la persistencia del resultado en worker y cliente ML.
  - **Scope:** `backend/src/workers/inference.worker.ts:67-83`, `backend/src/services/ml-client.ts:60-93`, `backend/src/schemas/inference.ts:28-40`.
  - **When/Then:** WHEN el ML completa THEN se persisten `cdr`, `cdr_vertical`, `quality`, `artifacts`, `elapsed_seconds` y `model_versions`, no solo un subconjunto.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts tests/schemas.test.ts`.
  - **Coverage:** “Estados de job y resultado completo”, REG-004.

- [ ] 4.3 Rechazar etiquetas desconocidas sin mapeo inventado.
  - **Scope:** `backend/src/workers/inference.worker.ts:51-64`, `backend/src/schemas/common.ts:42-48`.
  - **When/Then:** WHEN llega una etiqueta fuera del catálogo THEN se registra error seguro y no se persiste una clase adivinada.
  - **Test:** `npm --prefix backend run test -- tests/schemas.test.ts` con etiqueta desconocida.
  - **Coverage:** “Etiquetas canónicas y rechazo de etiquetas desconocidas”.

- [ ] 4.4 Implementar idempotencia obligatoria, replay del mismo `202` y modelo fijado.
  - **Scope:** nuevo `backend/src/services/idempotency.ts`, `backend/src/repositories/idempotency.repo.ts`, `backend/src/routes/inferences.ts`.
  - **When/Then:** WHEN misma key+payload THEN mismo `202` con mismo `inferenceId`/`jobId`; WHEN se pierde el `202` THEN reintento con misma key sin ID previo; WHEN payload distinto THEN `409`; WHEN reintento cambia URL/default de modelo THEN no cambia el trabajo ni el modelo resuelto; WHEN B3 no está aprobado THEN no se purgan registros de idempotencia/tombstones/vínculos de inferencia.
  - **Depends on:** 1.3.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts tests/schemas.test.ts` con concurrencia y pérdida de respuesta.
  - **Coverage:** “Idempotencia persistida del backend”, “Fingerprint y hash sin bloquear reanálisis legítimo”.

- [ ] 4.5 Canonicalizar creación/reanálisis y validar lateralidad.
  - **Scope:** `backend/src/routes/inferences.ts`, `backend/src/schemas/inference.ts`, `backend/src/repositories/inference.repo.ts`.
  - **When/Then:** WHEN se crea/reanaliza THEN se usa `POST /inferences` con `reanalysisOf`; WHEN se expone alias THEN delega en el mismo caso de uso e idempotencia; WHEN `eyeSide` contradice la imagen THEN `422`.
  - **Depends on:** 2.2, 4.4.
  - **Test:** `npm --prefix backend run test -- tests/schemas.test.ts tests/repositories.test.ts`.
  - **Coverage:** “Creación y reanálisis canónicos sin endpoints alternativos”, “Nombres canónicos, mapeo y lateralidad”.

- [ ] 4.6 Implementar outbox/reconciliación de encolado y recuperación de worker.
  - **Scope:** `backend/src/workers/inference.queue.ts`, `backend/src/workers/inference.worker.ts`, **nueva migración incremental propia para el outbox al ejecutar 4.6** (no incluida en la migración C de 1.3).
  - **When/Then:** WHEN se crea ejecución y falla encolado THEN la reconciliación la recupera; WHEN el worker reinicia THEN consulta el job ML existente y no reinventa otro.
  - **Depends on:** 1.3, 4.4.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` con cola/stub.
  - **Coverage:** “Entrega at-least-once y recuperación del worker”.

- [ ] 4.7 Implementar reintentos acotados, timeout y cancelación sin jobs huérfanos.
  - **Scope:** `backend/src/workers/inference.queue.ts:20-31`, `backend/src/workers/inference.worker.ts`.
  - **When/Then:** WHEN error transitorio THEN backoff acotado; WHEN se agota el límite THEN `FAILED` con causa; WHEN se cancela THEN se registra y no queda job sin dueño.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts`.
  - **Coverage:** “Reintentos acotados y semántica de timeout/cancelación”.

- [ ] 4.8 Generar URL firmada just-in-time y validar SSRF en la descarga.
  - **Scope:** `backend/src/routes/inferences.ts:69-83`, `backend/src/services/storage.ts:25-40`, `ml/inference/pipeline.py:71-102`.
  - **When/Then:** WHEN el job espera más que el TTL THEN se firma URL nueva antes de enviar; WHEN host no allowlisted THEN se rechaza; la URL firmada no entra en el fingerprint.
  - **Depends on:** 3.2, 4.5.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` y `python -m pytest ml/tests/test_service.py -q`.
  - **Coverage:** “URL firmada just-in-time y protección SSRF”, “Fingerprint y hash sin bloquear reanálisis legítimo”.

- [ ] 4.9 Hacer idempotente la persistencia duplicada del resultado.
  - **Scope:** `backend/src/repositories/inference.repo.ts:30-45`, `backend/src/workers/inference.worker.ts`.
  - **When/Then:** WHEN el mismo resultado se persiste dos veces THEN no duplica artefactos, feedback ni transiciones.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` con doble persistencia.
  - **Coverage:** “Entrega at-least-once y recuperación del worker”.

- [ ] 4.10 Implementar polling/backoff/Retry-After y entrega posterior a `COMPLETED`.
  - **Scope:** `backend/src/routes/inferences.ts`, `backend/src/routes/artifacts.ts`, contrato de estado.
  - **When/Then:** WHEN el cliente consulta THEN usa 2 s inicial/techo 10 s y `Retry-After`; WHEN ML `COMPLETED` pero faltan artefactos/PDF THEN la entrega continúa y no se declara completitud.
  - **Depends on:** 2.3, 3.5, 4.2.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` con estados simulados.
  - **Coverage:** “Polling, Retry-After y entrega posterior a COMPLETED”, “Estado agregado de consulta con precedencia determinista”.

## 5. Seguridad, roles, sesiones y auditoría

- [x] 5.1 Validar `isActive`, sesion y `tokenVersion` por request; fail closed.
  - **Scope:** `backend/src/middleware/auth.ts`, `backend/src/routes/auth.ts`, `backend/src/services/session.ts`, repositorio de usuarios/sesiones.
  - **When/Then:** WHEN una cuenta inactiva, rol/version cambiados o sesion revocada/expirada usa token THEN `401`; WHEN el store no se puede verificar THEN `503` fail closed sin datos.
  - **Depends on:** 1.3.
  - **Test:** `npm --prefix backend run test:integration -- tests/auth-sessions.integration.test.ts tests/jwt.test.ts tests/rbac.test.ts tests/feedback.route.test.ts tests/export.route.test.ts` -> 5 files / 72 tests passed (foco previo 71; conteo final QA 72); full integration 14 files / 245 tests; unit 15 files / 247 tests; typecheck/build exit 0.
  - **Coverage:** "Sesiones, refresh, logout y recuperacion seguros" (lector durable y fail closed; refresh/logout cerrados en 5.8 con QA PASSED), "Desactivacion y preservacion de autoria" (rechazo de cuentas inactivas), REG-006.
- [x] 5.2 Aplicar ownership y grants a pacientes, consultas, ejecuciones y artefactos.
  - **Scope:** `backend/src/routes/patients.ts:55-134`, `backend/src/routes/consultations.ts:173-229`, `backend/src/routes/inferences.ts:93-143`, middleware/helper de ownership.
  - **When/Then:** WHEN un médico pide recurso ajeno THEN `403`/`404` sin datos; WHEN `/patients` se lista THEN solo pacientes propios; WHEN admin/investigador no tiene grant THEN se deniega export/dataset.
  - **Test:** `npm --prefix backend run test -- tests/rbac.test.ts`.
  - **Evidencia HITO15 (cierre 5.2):** migración nueva `20261119010000_clinical_access` (owner de paciente, grants por inferencia, inmutabilidad y ACL de `clearsight_app`); `backend/src/services/clinical-access.ts`; rutas clínicas con `prisma`+access inyectados y sin imports globales; export con scope obligatorio por pares aprobados; revocación de grants en el ciclo de vida admin; guard HMAC de export en producción. Sin `.env.azure`, Azure, PHI, correos reales, DB externa, upgrades de dependencias ni cambios de frontend/ML. Tests: `tests/clinical-access-migrations.test.ts` y `tests/clinical-access.integration.test.ts` añadidos a la allowlist; `rbac`/`export`/`repositories`/`db-ownership` actualizados a la política aprobada.
  - **Cierre QA final (fuente sin cambios):** `npm --prefix backend run test:unit` -> **21 files / 355 tests passed (3.06 s)**; `npm --prefix backend run test:integration` -> **20 files / 380 tests passed (235.17 s)**; `git diff --check` limpio (solo warnings CRLF preexistentes); `docker ps -a` solo `redkeep_db` detenido no relacionado, cero residuales propios; `typecheck`/`build` reutilizados del mismo estado e inspeccionados por QA (exit 0).
  - **H-01 resuelto:** `POST /inferences` rechaza `inferenceId`/`imageUrl` como campos desconocidos (`400` identico para fresh/own/foreign) antes de writes/sign/queue y genera siempre UUID de servidor (`202` sin el campo); matriz en `tests/clinical-access.integration.test.ts`.
  - **H-02 latente documentado:** la migracion E congela columnas de la fila `inferences`; no agrega trigger sobre `images`. La mutacion SQL privilegiada del padre queda fuera de E y solo la cubre el guard D existente cuando aplica; no hay writer de aplicacion.
  - **H-03 validado / worker diferido:** el cliente Prisma (`backend/src/lib/prisma.ts`) resuelve `DATABASE_URL` una sola vez y las rutas/servicio clinico comparten el mismo `prisma`+access inyectado; no se refactoriza el factory global ni el worker.
  - **Historico pre-QA de la correccion acotada:** unit/schema **4 files / 41 tests passed**; integracion foco ACL+migracion+repositorios **3 files / 44 tests passed** (no son conteos finales). Runbook: `docs/hito15-clinical-access-runbook.md`.
  - **Coverage:** “Tres roles con mínimo privilegio y default deny”, “Autenticación y autorización por endpoint y recurso”.

- [x] 5.3 Implementar HU01: cinco fallos consecutivos, 15 minutos, éxito reinicia contador.
  - **Scope:** `backend/src/services/login-guard.ts`, `backend/src/services/session.ts`, `backend/src/routes/auth.ts`, `backend/src/lib/postgres-schema.ts`; migración `20261119000000_login_protection` y `backend/prisma/schema.prisma` (`AuthLoginBucket`).
  - **When/Then:** WHEN cinco fallos consecutivos THEN `429` y bloqueo 15 min (contador 5); WHEN éxito intermedio THEN contador 0 y el siguiente fallo es 1; WHEN éxito durante bloqueo THEN `429` sin sesión, sin reset y sin extender el lock; WHEN dos fallos concurrentes cruzan el umbral THEN se bloquea una sola vez (contador 5, user/bucket coherentes); WHEN el boundary exacto expira THEN login correcto y reset; WHEN la IP supera 100 intentos/60 s THEN `429` con `Retry-After`; WHEN falla signer/audit THEN el reset se revierte y se conserva el contador previo; WHEN el identificador es desconocido THEN misma secuencia `401/429` sin usuario falso.
  - **Depends on:** 1.3, 1.4.
  - **Test:** `npm --prefix backend run test:unit` -> **16 files / 283 tests passed**; `npm --prefix backend run test:integration -- tests/login-protection.integration.test.ts` -> **1 file / 35 tests passed**; `npm --prefix backend run test:integration` -> **15 files / 281 tests passed**; `typecheck`/`build` exit 0.
  - **Evidence:** vectores HMAC independientes (Python `hmac`/`hashlib`) en `backend/tests/unit/login-protection.test.ts`; pipeline real bajo `clearsight_app` en `backend/tests/login-protection.integration.test.ts` (CURRENT_USER app, login/me con S/I/U de D+E, TRUNCATE `42501` sin pérdida de filas); fallo durable se confirma en su tx antes de lanzar y reset de éxito dentro de la tx de sesión/audit/sign.
  - **Coverage:** "Autenticación con bloqueo HU01 y rate limit".

- [x] 5.4 Proteger al último administrador activo con transacción y bloqueo.
  - **Scope:** `backend/src/services/admin-users.ts` (`updateUser`), `backend/src/routes/admin.ts`, `backend/src/schemas/auth.ts`, tests `user-lifecycle.integration.test.ts`; lock global compartido, locks actor/target ordenados, conteo de admins activos bajo lock y auditoría DENIED. Sin endpoints clínicos ni grants.
  - **When/Then:** WHEN se intenta desactivar o quitar rol al último admin THEN `409 LAST_ACTIVE_ADMIN` sin cambios de perfil ni credenciales; WHEN queda otro admin activo THEN el self-deactivate/self-demote se permite y el JWT actual queda revocado; WHEN dos admins se desactivan concurrentemente THEN el lock global serializa, una mutación es válida, la otra es denegada y nunca quedan cero admins activos; WHEN falla la auditoría THEN rollback completo.
  - **Depends on:** 1.8, 5.5.
  - **Test:** `npm --prefix backend run test:integration -- tests/user-lifecycle.integration.test.ts` -> **1 file / 24 tests passed**; foco lifecycle/userAdmin -> **2 files / 48 tests passed**; unit -> **20 files / 351 tests passed**; full integration -> **18 files / 343 tests passed (203.56 s)**; `typecheck`/`build` -> exit 0. PostgreSQL owned de Testcontainers; sin Azure, `.env.azure`, PHI ni DB externa.
  - **Coverage:** "Protección del último administrador activo". Runbook: `docs/hito14-account-lifecycle-runbook.md`.

- [x] 5.5 Implementar auditoría append-only y bloquear la operación si falla.
  - **Scope:** `backend/src/services/audit.ts` (wrapper público `withAuditedTransaction` sobre `db.$transaction` + `writeAuditEvent` con contexto opaco registrado en `WeakMap`), `backend/src/services/admin-bootstrap.ts` y `backend/src/services/session.ts` (llamadores actuales), `backend/tests/unit/audit.test.ts`, `backend/tests/unit/audit-adversarial.test.ts`, `backend/tests/audit.integration.test.ts` y allowlists de runners. Sin `audit.repo.ts` ni migración nueva: la migración C ya existía.
  - **When/Then:** WHEN se ejecuta acción sensible THEN se registra actor/target/acción/resultado/time en la misma transacción; WHEN falla la auditoría THEN la operación no es exitosa y la transacción revierte; WHEN el callback captura el fallo y retorna falso éxito THEN el wrapper aborta por el primer fallo sticky; WHEN el callback exitoso no escribe ningún evento THEN aborta con `AUDIT_EVENT_REQUIRED`.
  - **Depends on:** 1.3.
  - **Test:** `npm --prefix backend run test:unit` → **18 files / 319 tests passed**; `npm --prefix backend run test:integration -- tests/admin-bootstrap.integration.test.ts tests/auth-sessions.integration.test.ts tests/login-protection.integration.test.ts tests/audit.integration.test.ts` → **4 files / 112 tests passed**; `npm --prefix backend run test:integration` → **16 files / 294 tests passed**; `typecheck`/`build` → exit 0. PostgreSQL efímero real de Testcontainers con ownership; sin Azure, `.env.azure`, sin DB compartida, de desarrollo ni de producción, y sin datos clínicos.
  - **Coverage:** “Auditoría append-only de acciones sensibles”.
  - **Trazabilidad 5.5:**

  | Source | Prueba unit/real | Resultado |
  |---|---|---|
  | `backend/src/services/audit.ts` (`withAuditedTransaction`, `writeAuditEvent`, contexto `WeakMap`) | `tests/unit/audit.test.ts`, `tests/unit/audit-adversarial.test.ts` | unit 18/319 |
  | `backend/src/services/admin-bootstrap.ts` (misma tx, `BOOTSTRAP_AUDIT_FAILED`) | `tests/unit/admin-bootstrap*.test.ts`, `tests/admin-bootstrap.integration.test.ts` | incluido en unit/full |
  | `backend/src/services/session.ts` (misma tx, `AUTH_STORE_UNAVAILABLE`) | `tests/auth-sessions.integration.test.ts`, `tests/login-protection.integration.test.ts` | foco 4/112 |
  | `backend/tests/audit.integration.test.ts` (fila exacta, timestamp DB, append-only, rollback) | PostgreSQL owned de Testcontainers | full 16/294 |

  - **Pendientes al cierre de 5.5 (histórico):** 1.8, 5.4, 5.6, 5.8, 5.9 y 5.2. Estado actual: 1.8/5.2/5.4/5.6/5.8/5.9/9.1 cerrados; 9.2 pendiente. Este hito no añade endpoint público, UI admin ni permisos/grants clínicos.

- [x] 5.6 Implementar desactivación segura y bloqueo de supresión; hard delete fuera de este hito.
  - **Scope:** `backend/src/services/admin-users.ts` (`updateUser`), `backend/src/routes/admin.ts`, `backend/src/schemas/auth.ts`, tests `user-lifecycle.integration.test.ts`; desactivación/reactivación, revocación durable de `UserSession`/`RefreshToken`/`PasswordResetToken`, incremento de `tokenVersion`, auditoría y verificación de historial clínico intacto. **No se implementa DELETE/hard delete.**
  - **When/Then:** WHEN cambia email/role/isActive THEN `tokenVersion` incrementa exactamente 1 y se revocan todas las credenciales no revocadas (sesiones con `ACCOUNT_UPDATED`, refresh y reset); WHEN solo cambia `fullName` THEN no hay bump ni revocación; WHEN se repite una desactivación ya inactiva THEN se limpian credenciales legacy no revocadas una sola vez y la repetición es idempotente; WHEN se solicita DELETE THEN `404`/no disponible y el usuario/consultas/inferencias/feedback conservan IDs y autoría; WHEN se reactiva THEN no se reviven sesiones antiguas y un login nuevo funciona.
  - **Depends on:** 5.4, 5.5.
  - **Test:** `npm --prefix backend run test:integration -- tests/user-lifecycle.integration.test.ts` -> **1 file / 24 tests passed**; full integration -> **18 files / 343 tests passed**; unit -> **20 files / 351 tests**; `typecheck`/`build` -> exit 0. Runbook: `docs/hito14-account-lifecycle-runbook.md`.
  - **Coverage:** "Desactivación y preservación de autoría", "Borrado físico excepcional y supresión de identidad" como restricción, B3/B4/B5 solo producción. Sin grants clínicos ni borrado/anonimización automática.

- [x] 5.7 Implementar sesiones tecnicas: JWT 15 min, `sessionId`, `tokenVersion`, store durable.
  - **Scope:** `backend/src/routes/auth.ts`, `backend/src/middleware/auth.ts`, `backend/src/services/session.ts`, `backend/src/services/auth-policy.ts`, `backend/src/services/password-policy.ts`.
  - **When/Then:** WHEN se emite acceso THEN incluye `sessionId`/`tokenVersion`, TTL 900 s y sesion absoluta de 7 d; WHEN cambia rol, version, password o se desactiva THEN tokens/permisos anteriores dejan de valer; WHEN store no verificable THEN fail closed; WHEN el cliente Prisma usa un schema explicito THEN el lock usa ese schema; los writers actuales comparten bcrypt cost 12.
  - **Depends on:** 1.3.
  - **Test:** `npm --prefix backend run test:integration -- tests/auth-sessions.integration.test.ts` -> 31 tests passed (suite focalizada de auth 5 files / 72 tests; foco previo 71, conteo final QA 72).
  - **Coverage:** "Sesiones, refresh, logout y recuperacion seguros" (acceso durable, lock schema-qualified y password policy cost 12; refresh/logout 5.8, reset 5.9 y lockout 5.3 cerrados con QA).
- [x] 5.8 Implementar refresh opaco, rotación single-use, logout y revocación por familia.
  - **Scope:** `backend/src/routes/auth.ts` (login/refresh/logout), `backend/src/services/session.ts` (refresh de login), nuevos `backend/src/services/auth-web-session.ts`, `auth-cookies.ts`, `web-auth-policy.ts` y `refresh-tokens.ts`; `backend/src/app.ts` (DI/decoraciones, logger redactado), `backend/src/config/env.ts`, `backend/src/schemas/auth.ts`, `backend/src/types/fastify-auth.d.ts`; configuración `AUTH_PUBLIC_ORIGIN` (URL `http(s)` normalizada, sin wildcard); uso de `refresh_tokens`/`user_sessions` existentes **sin editar schema ni migraciones**. Documentación: `contracts/frontend-api-contract.md`, `contracts/testing-runbook.md`, `backend/README.md`, `docs/hito16-auth-refresh-runbook.md`. No frontend ni proxy implementado.
  - **When/Then:** WHEN login correcto THEN conserva el JSON actual y entrega el refresh opaco solo en la cookie `clearsight_refresh` (`HttpOnly; Secure; SameSite=Lax`, host-only, `Path=/api/auth`, expiración ≤ 7 d); WHEN `Origin` falta, es null o no coincide exactamente con `AUTH_PUBLIC_ORIGIN` THEN `403` antes de KDF/store; WHEN `Sec-Fetch-Site: cross-site` THEN rechazo; WHEN `AUTH_PUBLIC_ORIGIN` falta THEN endpoints de cookie `503` fail closed sin romper `buildApp` lazy ni el `410` de `/auth/register`; WHEN refresh web THEN `POST /auth/refresh` usa solo la cookie, rota single-use y devuelve solo `accessToken/tokenType/expiresIn` (“sin body/Bearer” describe el mecanismo: si llegan, no se usan como credencial ni sustituyen la cookie, y su presencia sola no es error); WHEN se reutiliza (incluidas dos solicitudes concurrentes del mismo token) THEN como máximo una emite y la otra revoca esa sesión y todos sus refresh (familia = sesión), sin otras sesiones del usuario y sin ventana de gracia; WHEN logout con `Bearer` de sesión válida THEN `204`, revoca sesión y cadena auditada y limpia la cookie con los mismos atributos (la cookie sola no autoriza; un `Origin` presente pasa el mismo guard); WHEN falla firma/auditoría/commit THEN login no setea cookie, refresh no consume el padre y el reuso confirma revocación+auditoría antes de `401`; WHEN la auditoría cae THEN `503` con rollback, sin logout exitoso falso; WHEN respuesta de credenciales THEN `Cache-Control: no-store`; `/auth/me` no cambia.
  - **Decisiones registradas:** cookie `clearsight_refresh`; `AUTH_PUBLIC_ORIGIN` explícito como solución limpia (no se deriva de `Host`/`X-Forwarded-*` ni de CORS wildcard); proxy HTTPS quita `/api` y el backend expone `/auth/*`; solo hash SHA-256 lowercase en DB; token crudo jamás en logs/auditoría/JSON; `refresh_tokens`/`user_sessions` sin cambios; single-flight en cliente documentado.
  - **Depends on:** 5.7.
  - **Test QA HITO16 (PASSED):** unit `npm --prefix backend run test:unit` → **25 files / 377 tests passed**; full integration `npm --prefix backend run test:integration` → **21 files / 401 tests passed (270 s)**; `tests/refresh-session.integration.test.ts` → **21 tests** (QA añadió casos; también la aserción de cookie duplicada con el mismo valor en unit); `typecheck` → **exit 0** repetido después de los tests de QA; `build` reutilizado del mismo source (exit 0). PostgreSQL/Ryuk propios limpiados; `redkeep_db` ajeno intacto; sin `.env`, `.env.azure`, Azure, PHI ni correos reales.
  - **Coverage:** “Sesiones, refresh, logout y recuperación seguros”; D19. 5.8 y 5.9 cerradas por QA PASSED. Runbook: `docs/hito16-auth-refresh-runbook.md` y `docs/hito17-password-recovery-runbook.md`.

- [x] 5.9 Implementar forgot/reset con token 30 min, hash, sin logs y proveedor configurable (QA PASSED HITO17).
  - **Scope:** `backend/src/routes/auth.ts` (rutas públicas sin sesión/cookie), nuevo `backend/src/services/password-reset.ts` (servicio + puerto `PasswordResetDelivery` con `DISABLED` por defecto y memory sink solo de pruebas), `backend/src/app.ts` (DI/decoración), `backend/src/schemas/auth.ts` (DTO `forgot`/`reset` y política de password compartida), `backend/src/lib/log-redaction.ts` (`req.body.token`, `req.body.email`), `backend/src/lib/postgres-schema.ts` si aplica al schema explícito; nueva migración incremental `20261119020000_password_recovery_quotas` y modelo `AuthRecoveryBucket` en `backend/prisma/schema.prisma`; tests `backend/tests/unit/password-reset.test.ts`, `backend/tests/password-reset.integration.test.ts` y allowlist de `backend/vitest.integration.config.ts`. Reutiliza `PasswordResetToken` existente (30 min, SHA-256, append-only), `canonical-email.ts`, `password-policy.ts` (bcrypt cost 12/12 code points/72 UTF-8 bytes), `audit.ts` (`withAuditedTransaction`) y `web-auth-policy.ts` (Origin opcional como logout). **No** edita migraciones publicadas (`20261118020000_identity_audit`, `20261119000000_login_protection`), `0_init`, `docker/init.sql` ni el baseline; **no** altera `login-guard.ts`/`auth_login_buckets`; sin frontend, proxy, Azure, `.env.azure`, entornos reales, PDF, proveedor real de email ni dependencias nuevas de correo.
  - **R1 implementado (HITO17; evidencia pre-QA, 5.9 cerrada después):** migración `backend/prisma/migrations/20261119020000_password_recovery_quotas/migration.sql`, modelo `AuthRecoveryBucket` en `backend/prisma/schema.prisma`, guard `backend/src/services/password-recovery-quota.ts`, tests `backend/tests/unit/password-recovery-quota.test.ts` y `backend/tests/password-recovery-quota.integration.test.ts`, reset de harness `backend/tests/helpers/db.ts`, allowlist/runner `backend/vitest.integration.config.ts` y `backend/tests/unit/{runner-isolation,db-ownership}.test.ts`. No incluye endpoints, token lifecycle, entrega, frontend ni proveedor real. Evidencia: unit focal **12/12**, unit completo **26 files / 389 tests**, integration foco R1 **1 file / 15 tests**, `typecheck`/`build` exit 0, Prisma `validate`/`generate` con URL sintética; sin leer `.env` reales.
  - **Firma R1 para R2:** `createPasswordRecoveryQuotaGuard(db, { jwtSecret, databaseSchema?, now? })` devuelve `reserveForgotIp(clientIp)` / `reserveForgotEmail(email)` / `reserveResetIp(clientIp)`, cada una `Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>`; los fallos usan `PasswordRecoveryQuotaInputError` o `PasswordRecoveryQuotaStoreError` con mensaje genérico. R2 llama `reserveForgotIp` antes de `reserveForgotEmail` y `reserveResetIp` antes del lookup/bcrypt.
  - **R2 implementado y QA PASSED (HITO17):** `backend/src/services/password-reset.ts`, `backend/src/services/password-reset-delivery.ts` (`DISABLED` por defecto + memory sink explícito sin endpoint de inspección), rutas internas `/auth/password/forgot|reset`, schemas estrictos/política compartida, DI/decoración y tipos Fastify, redacción `req.body.token/email/newPassword`, tests `backend/tests/unit/password-reset.test.ts` y `backend/tests/password-reset.integration.test.ts`, allowlist/runner actualizados. QA final (sin source bugs): unit focal R2 **7/7** (no 8; el 8 incluía log-redaction), focal R1+R2 **19/19**, unit completo **27 files / 396 tests**, integration foco R2 **28 tests**, full integration **23 files / 444 tests** (401 baseline + 15 R1 + 22 R2 + 6 QA), `typecheck` exit 0 después de los tests QA, `build` reutilizado del mismo source maker exit 0, Docker propio sin residuos y ajeno intacto. Evidencia detallada en `docs/hito17-password-recovery-runbook.md`. El path público `/api/auth/password/*` queda documentado pero el proxy no se implementa.
  - **QA final HITO17 (PASSED, 6 tests QA nuevos):** default disabled, IP exhaust, 503 uniforme, carreras, no auth substitute y 400 sin consumo de cuota. B8 (proveedor/credenciales reales) sigue pendiente de provisioning y no bloquea el cierre de 5.9; la entrega sigue siendo contrato vigente con `DISABLED`/memory sink.
  - **When/Then:** WHEN `forgot` recibe `{email}` canónico válido THEN consume primero cuota `FORGOT_IP` 20/3600 s y después `FORGOT_EMAIL` 3/3600 s, responde `202 {accepted:true}` fijo para conocida/desconocida/inactiva, no enumera y no prueba emisión/entrega; WHEN el body es inválido THEN `400` sin cuota; WHEN el store de cuotas falla antes del lookup THEN `503` genérico para cualquiera; WHEN la cuota se agota THEN `429` con `Retry-After` entero `>=1`; WHEN el puerto está `DISABLED` THEN `202` sin generar token ni invalidar anteriores; WHEN el sink de pruebas está habilitado THEN token de 32 bytes CSPRNG/base64url 43, hash SHA-256 en DB, expiración 30 min, revocación de anteriores y auditoría en la misma tx antes de entregar, y solo el token de la última tx comprometida queda válido; WHEN falla lookup/token/auditoría/entrega después de cuotas THEN `202` uniforme (auditoría revierte creación y no entrega; entrega fallida se registra sin email/token y solo revoca condicionalmente ese token exacto); WHEN dos `forgot` compiten THEN se serializan por usuario sin afectar a otros.
  - **When/Then (reset):** WHEN `reset` recibe `{token,newPassword}` válido THEN consume cuota `RESET_IP` 20/900 s antes del lookup y de bcrypt, y responde `204` sin sesión/cookie nueva; WHEN el token es inválido/expirado/usado/revocado o el usuario inactivo THEN `401` genérico idéntico sin reactivar; WHEN el DTO es inválido THEN `400`; WHEN el reset es efectivo THEN bcrypt cost 12, `tokenVersion` incrementa una vez, consume el token usado y revoca otros reset tokens, todas las sesiones y todos los refresh en una tx auditada; WHEN termina THEN conserva `failedLoginCount`, `lockedUntil` y `auth_login_buckets` (lockout vigente); WHEN falla store/auditoría/hash THEN `503` con rollback sin cambio ni consumo; WHEN `Authorization` o un claim intenta sustituir el token THEN no se acepta; WHEN llega `Origin` THEN pasa la misma política opcional que logout, y todas las respuestas llevan `Cache-Control: no-store`, sin token en logs/JSON/URLs ni enlaces con token.
  - **Depends on:** 5.7, 5.8.
  - **Test QA final (PASSED; sin reruns de maker):** unit focal R2 **7/7**; focal unit R1+R2 **19/19**; unit completo **27 files / 396 tests**; integration foco R2 **28 tests**; full integration **23 files / 444 tests** (401 baseline + 15 R1 + 22 R2 + 6 QA); `typecheck` exit 0 después de los tests QA; `build` reutilizado del mismo source maker exit 0; Docker propio limpio y ajeno intacto. PostgreSQL owned de Testcontainers, sin `.env.azure`, Azure, correos reales ni DB externa; memory sink solo por DI de prueba. Ver `contracts/testing-runbook.md` §1.16 y `docs/hito17-password-recovery-runbook.md`.
  - **Coverage:** “Sesiones, refresh, logout y recuperación seguros”; D20; B8 como restricción de provisioning. Contrato registrado en `design.md` D20, `specs/identity-access-audit/spec.md`, `contracts/frontend-api-contract.md` §3.1.2 y `contracts/testing-runbook.md` §4.4.

## 6. PDF básico y reportes

- [ ] 6.1 Implementar PDF básico con original sanitizada + mask + overlay embebidas.
  - **Scope:** nuevo `backend/src/services/pdf-report.ts`; worker/servicio de publicación; artefacto `pdf`.
  - **When/Then:** WHEN ruta exitosa normal THEN el PDF incluye original sanitizada (sin EXIF del upload), `mask` y `overlay` embebidas, identificación, snapshot, versiones, clínica con unidades solo verificadas, probabilidades, calidad, CDR, fechas, warnings y aviso; WHEN falta una imagen obligatoria THEN no completa.
  - **Depends on:** 3.2, 3.3, 4.2 (storage y resultado completos; el agregador consume PDF, no al revés).
  - **Test:** test nuevo que genere un PDF real, extraiga texto, cuente imágenes renderizadas y verifique contenido; no solo un mock snapshot.
  - **Coverage:** “PDF básico obligatorio para completitud”, “Contenido clínico y trazabilidad del PDF”.

- [ ] 6.2 Implementar idempotencia, `reportId`/`version` inmutables y versionado de reporte.
  - **Scope:** `backend/src/services/pdf-report.ts`; repositorio `PdfReport`; migración B; endpoints `/reports`.
  - **When/Then:** WHEN se reintenta sin cambios THEN reutiliza/reproduce el mismo reporte; WHEN feedback nuevo THEN crea `version` nueva sin pisar la anterior; WHEN se consulta THEN `reportId`/`version` son explícitos e inmutables.
  - **Depends on:** 6.1, 1.2.
  - **Test:** `npm --prefix backend run test -- tests/repositories.test.ts` y test de PDF real para versiones.
  - **Coverage:** “Idempotencia y versionado del reporte”, “URLs de artefactos y PDF en el contrato”.

- [ ] 6.3 Aplicar limitaciones de revisión y ausencia de explicabilidad en PDF.
  - **Scope:** `backend/src/services/pdf-report.ts`; contrato de artefactos.
  - **When/Then:** WHEN ejecución `REVIEW_REQUIRED` THEN el PDF indica revisión, evidencia parcial y qué imagen/artefacto falta; WHEN Grad-CAM/SHAP no existen THEN declara `NOT_SUPPORTED` y no simula.
  - **Depends on:** 6.1.
  - **Test:** test de PDF real que verifique texto de limitación y ausencia de imágenes simuladas.
  - **Coverage:** “Reporte de revisión con limitación explícita”, “Explicabilidad diferida explícita”.

- [ ] 6.4 Medir HU08 con encabezado, numeración y plantilla.
  - **Scope:** script de benchmark de PDF; documentación de entorno/volumen.
  - **When/Then:** WHEN se ejecuta THEN el PDF incluye encabezado/numeración institucional y se registra tiempo, entorno y volumen; no se declara cumplimiento sin evidencia.
  - **Test:** benchmark en entorno aislado (no ejecutar en este change).
  - **Coverage:** “Criterio medible de generación institucional (HU08)”.

## 7. Pruebas transversales y métricas

- [x] 7.0 Aislar el runner backend: unitario puro por defecto e integración explícita con Testcontainers y ownership.
  - **Scope:** `backend/package.json`, `backend/vitest.config.ts`, `backend/vitest.unit.config.ts`, `backend/vitest.integration.config.ts`, `backend/tests/global-setup.ts`, `backend/tests/integration-setup.ts`, `backend/tests/helpers/{ownership,db}.ts`, `backend/tests/fixtures/clinical.ts`, `backend/tests/unit/`, `backend/README.md`, `contracts/testing-runbook.md`.
  - **When/Then:** WHEN se ejecuta `npm test`/`test:unit` THEN solo corre la allowlist pura sin `globalSetup`, DB ni red, y un filtro CLI no puede ampliarla; WHEN se ejecuta la integración explícita THEN rechaza `TEST_DATABASE_URL` antes de crear cliente/contenedor y crea un PostgreSQL efímero con nombre único, label y marker `test_meta`; WHEN falla connect/migración/provide THEN cierra cliente y contenedor y no oculta errores; WHEN termina THEN el teardown es idempotente.
  - **Test:** `npm --prefix backend run test:unit` (6 files / 57 tests, incluyendo la ampliación QA de marker/ownership/env), `npm --prefix backend run test` (6 / 57), `npm --prefix backend run test:unit -- tests/repositories.test.ts` (no tests, exit 1), `npm --prefix backend run typecheck` (exit 0).
  - **Coverage:** aislamiento de runner y guard de ownership; no cubre E2E real ni las tareas 7.1/7.2.

- [x] 7.0.1 Ejecutar `test:integration` real cuando haya daemon Docker local, sin `TEST_DATABASE_URL`, y registrar el resultado.
  - **Scope:** entorno local con Docker; sin Azure ni DB externa.
  - **When/Then:** WHEN exista daemon Docker THEN los 8 archivos de integración se ejecutan contra el contenedor efímero con ownership y cleanup verificado.
  - **Test:** `npm --prefix backend run test:integration` → **8 files passed, 62 tests passed**, Vitest 5.1.0, inicio 17:09:59, duración 18.61 s, exit 0 (2026-11-18).
  - **Coverage:** ejecutado localmente con PostgreSQL 16-alpine de Testcontainers y ownership; setup/migraciones/fixtures, queries de test y cleanup según el harness verificado por QA de seguridad. Tras el run, `docker ps -a` con los filtros `com.clearsight.test.owner=backend-integration` y `org.testcontainers=true`, y `docker volume ls` con el label de ownership, no devolvieron salida. Solo se consultaron recursos con esas etiquetas; no se inspeccionaron todos los volúmenes/recursos del host ni se eliminó nada manualmente o ajeno. No cubre 7.1 (adversos nuevos), 7.2 (E2E clínico completo), 7.4 (Azure) ni la suite completa de auth/sesión.

- [ ] 7.1 Crear suite de contratos con stub ML y casos adversos.
  - **Scope:** `backend/tests/` nuevos casos; `ml/tests/` stubs; sin Azure real; seguir `contracts/testing-runbook.md`.
  - **When/Then:** WHEN corre la suite THEN cubre URL expirada, host no permitido, etiqueta desconocida, payload inválido, `202` perdido, reinicio, duplicado, objeto ausente, upload OK/DB fail, storage caído, provider desconocido y auditoría fallida.
  - **Test:** `npm --prefix backend run test` y `python -m pytest ml/tests -q` solo en entorno aislado; **no ejecutar en este change** y no tratar un test focalizado como libre del `globalSetup` destructivo.
  - **Coverage:** todas las capacidades adversas.

- [ ] 7.2 Crear E2E completo con DB creada/adoptada explícitamente y ownership marker.
  - **Scope:** suite E2E; `TEST_DATABASE_URL` con DB creada/adoptada para el run, marker de ownership, allowlist de target y deny producción; **no** basta que el nombre contenga `test`. Ver `contracts/testing-runbook.md` fase 3.
  - **When/Then:** WHEN corre el E2E THEN verifica marker/allowlist antes de tocar datos y cubre auth, paciente, consulta, upload sanitizado, request, polling, persistencia completa, artefactos firmados, feedback, export y PDF; nunca hace `DROP` por string `test`.
  - **Test:** comando E2E con guard de ownership (prospectivo; no ejecutar en este change; no inventar `npm run e2e`).
  - **Coverage:** flujo prioritario completo; “Contrato HTTP único y explícito para frontend”.

- [ ] 7.3 Verificar sanitización, tamaño, formato y lateralidad antes de persistir.
  - **Scope:** `backend/src/services/sanitizer.ts`, `backend/src/routes/consultations.ts:100-160`, `backend/src/app.ts:64-68`.
  - **When/Then:** WHEN llega JPEG/PNG >=512 px y <=20 MB THEN se acepta y sanitiza; WHEN excede o no es válido THEN se rechaza antes de persistir; límites API/ML alineados; `eyeSide` contradictorio `422`.
  - **Test:** `npm --prefix backend run test -- tests/sanitizer.test.ts tests/schemas.test.ts`.
  - **Coverage:** RF02; “Nombres canónicos, mapeo y lateralidad”.

- [ ] 7.4 Crear E2E real Azure posterior con autenticación, imagen → Blob → ML → mask/overlay → DB → PDF → URLs.
  - **Scope:** E2E de Azure real solo con B6 confirmado (presupuesto/duración/scope y contexto/permisos) y cleanup final; incluye stores ausentes; ver `contracts/testing-runbook.md` fase 6.
  - **When/Then:** WHEN se ejecuta en Azure autorizado THEN verifica el flujo completo, negative-auth y la firma/descarga; WHEN falta un store THEN reporta fallo explícito; WHEN termina THEN limpia con manifest y verifica residuos.
  - **Depends on:** 3.2, 3.4, 6.1, 6.2.
  - **Test:** comando E2E Azure (no ejecutar en este change; B6 parcial, no deployment ready).
  - **Coverage:** “Pruebas con recursos creados sin filtrar secretos”, “Abstracción de almacenamiento dual y firma por provider”.

- [ ] 7.5 Crear medición reproducible de RNF sin declarar cumplimiento anticipado.
  - **Scope:** benchmark de p95 carga→resultado **de flujo completo** (no solo forward), 50 concurrentes, cobertura, AUC y disponibilidad; documentación de entorno; `scripts/benchmark_latency.py` actual es baseline forward-only y no evidencia el p95 full-flow.
  - **When/Then:** WHEN se ejecuta THEN reporta valores observados y metodología; WHEN no hay evidencia THEN no se afirma cumplimiento; los benchmarks se ejecutan separados de las fases funcionales.
  - **Test:** scripts de benchmark en entorno aprobado (no ejecutar en este change; p95 full-flow es `FUTURO` hasta que exista el script).
  - **Coverage:** RNF medibles.

## 8. Azure aislado

- [ ] 8.1 Implementar script de despliegue aislado con tags, manifest y prohibición de `.env.azure`.
  - **Scope:** `scripts/deploy_azure.ps1` o nuevo script; configuración solo por procedimiento seguro aprobado. Incluye provisioning futuro de un LOGIN distinto con membresía en `clearsight_app` para runtime; no leer credenciales/`DATABASE_URL` actuales en esta tarea.
  - **When/Then:** WHEN se ejecuta con decisiones confirmadas THEN crea recursos con prefijo/tags y escribe manifest; WHEN falta presupuesto/alcance THEN aborta antes de crear.
  - **Test:** dry-run/stub; revisión de logs sin secretos.
  - **Coverage:** “Provisión aislada por ejecución con alcance confirmado”, “Prohibición de leer o exponer `.env.azure`”, “Azure Infrastructure Provisioning Automation”.

- [ ] 8.2 Implementar cleanup `finally` y verificación de borrado asíncrono.
  - **Scope:** script de 8.1; verificación de recursos residuales.
  - **When/Then:** WHEN termina/falla/se interrumpe el run THEN limpia desde manifest y verifica; WHEN queda residual THEN reporta `pending` con acciones.
  - **Test:** simulación con provider stub; no crear recursos reales.
  - **Coverage:** “Manifest de recursos y cleanup en `finally`”, “Verificación de borrado y recursos residuales”.

- [ ] 8.3 Documentar y probar el bloqueo de deploy hasta confirmar suscripción, alcance, presupuesto, duración, contexto y permisos justo antes de crear.
  - **Scope:** script/README operativo; registro de decisiones; sin IDs ni nombres de suscripción en docs.
  - **When/Then:** WHEN faltan datos o no se confirmó el contexto default/permisos con dry-run o lecturas THEN el script no crea recursos y el hito no se declara listo para desplegar; WHEN solo existe el contexto CLI leído THEN se registra como prerequisito parcial, no como deployment ready.
  - **Test:** validación de precondiciones con valores ausentes; lectura CLI read-only no crea recursos.
  - **Coverage:** “Separación entre bloqueo de deploy y bloqueo de diseño”, “Provisión aislada por ejecución con alcance confirmado”, B6 parcialmente satisfecho.

## 9. Hito posterior — deferred, unchecked, NO bloqueado por producto

> 9.1 se cerró en HITO14; 9.2 sigue unchecked. Las tareas restantes son alcance posterior sin frontend y no deben mezclarse con la tabla de bloqueos.

- [x] 9.1 Lectura/edición administrativa de usuarios, desactivación y cambios de rol (implementada en HITO14; el alta `POST /admin/users` sigue en 1.8).
  - **Scope:** `backend/src/routes/admin.ts`, `backend/src/services/admin-users.ts`, `backend/src/schemas/auth.ts`, tests `user-lifecycle.integration.test.ts`; GET listado paginado/filtrado, GET detalle, PATCH estricto de email/fullName/role/isActive; sin frontend.
  - **When/Then:** WHEN se lista THEN `{items,total,limit,offset}`, orden `createdAt DESC id ASC`, filtros `role`/`isActive`/`q` literal insensible (`_`/`%` escapados), límites 20/100 y offset >=0; WHEN un actor pierde permisos mientras espera la TX y el target no existe THEN `403` antes de revelar `404`; WHEN un admin válido pide un detalle inexistente THEN `404`; WHEN PATCH recibe campos de password/hash/versión/contadores/actor/grants THEN `400` sin efectos; WHEN cambia identidad/rol/actividad THEN se revoca según 5.6 y el último admin se protege según 5.4; WHEN DELETE THEN no disponible (`404`) y sin borrado.
  - **Test:** `npm --prefix backend run test:integration -- tests/user-lifecycle.integration.test.ts` -> **1 file / 24 tests passed**; foco lifecycle/userAdmin -> **2 files / 48 tests passed**; unit -> **20 files / 351 tests**; full integration -> **18 files / 343 tests (203.56 s)**; `typecheck`/`build` -> exit 0. Runbook: `docs/hito14-account-lifecycle-runbook.md`.
  - **Coverage:** "Tres roles con mínimo privilegio y default deny", "Desactivación y preservación de autoría", "Protección del último administrador activo". Sin lectura clínica ni grants implícitos.

- [ ] 9.2 [LATER HITO] API de lectura de auditoría operativa.
  - **Scope:** ruta admin de auditoría, filtros, mínimo PHI.
  - **Coverage:** “Auditoría append-only de acciones sensibles”.

- [ ] 9.3 [LATER HITO] Historial, filtros y paginación de consultas.
  - **Scope:** `GET /consultations` con filtros/paginación, ownership/grant.
  - **Coverage:** “Contrato HTTP único y explícito para frontend”, “Autenticación y autorización por endpoint y recurso”.

- [ ] 9.4 [LATER HITO] PDF enriquecido.
  - **Scope:** nuevo layout/contenido posterior al PDF básico; versionado.
  - **Coverage:** “Idempotencia y versionado del reporte”, “Contenido clínico y trazabilidad del PDF”.

- [ ] 9.5 [LATER HITO] Grad-CAM como reporte independiente digital/PDF.
  - **Scope:** payload explicativo, reporte independiente, export; no mezclar con PDF básico.
  - **Coverage:** “Generador de explicabilidad Grad-CAM”, “Explicabilidad diferida explícita”.

- [ ] 9.6 [LATER HITO] SHAP como reporte independiente digital/PDF.
  - **Scope:** datos/gráfico, payload explicativo, reporte independiente, export; no mezclar con PDF básico.
  - **Coverage:** “Explicabilidad diferida explícita”.

- [ ] 9.7 [LATER HITO] APIs/documentación adicionales.
  - **Scope:** documentación y endpoints no prioritarios.
  - **Coverage:** “Contrato HTTP único y explícito para frontend”.

## 10. Decisiones, restricciones y fuera de alcance

> No es una lista de tareas a activar. Las filas `RESUELTO/RESTRICCIÓN` se implementan como restricción; las filas `SOLO PRODUCCIÓN` no bloquean desarrollo ni pruebas sintéticas/PAPILA con acceso mínimo; `B6` está parcialmente satisfecho por CLI y no es deployment ready; `B9` queda fuera de alcance.

| ID | Tarea / decisión | Estado | Efecto |
|---|---|---|---|
| D-01 | Resolución de `REVIEW_REQUIRED` (B1) | **RESUELTO / RESTRICCIÓN APROBADA** | El médico no convierte una ejecución sin resultado válido en `COMPLETED`; `REVIEW_REQUIRED` se preserva y se resuelve por reanálisis como ejecución nueva con imagen/snapshot nuevos si procede y PDF independiente vinculado, sin pisar la anterior. No endpoint approve-review ejecutable ni auto-complete manual; el endpoint review queda deferred y no es target del producto actual. |
| D-02 | Cambio/promoción de `requiredExecutionIds` tras cierre (B2) | **RESUELTO / RESTRICCIÓN APROBADA** | No se reabre ni altera automáticamente una consulta completada; no se promueven ni reemplazan IDs tras cierre; los reanálisis históricos independientes no modifican el frozen set. |
| D-03 | Retención/purga numérica (B3) | PENDIENTE SOLO PRODUCCIÓN | No se fijan plazos ni se declara cumplimiento legal. No bloquea desarrollo ni pruebas sintéticas/PAPILA; bloquea purgas y producción real. |
| D-04 | Consentimiento, privacidad y anonimización (B4) | PENDIENTE SOLO PRODUCCIÓN | No se afirma anonimización por HMAC ni cumplimiento legal. No bloquea desarrollo ni pruebas sintéticas/PAPILA; fail closed con datos clínicos reales sin governance. |
| D-05 | Supresión de identidad/legal y hard delete (B5) | PENDIENTE SOLO PRODUCCIÓN | Desactivación + revocación es la acción del hito; no hay hard delete en este hito, ni siquiera sin actividad; sin cascada ni reasignación. La excepción futura requiere política. |
| D-06 | Ejecutar deploy real en Azure (B6) | **PARCIALMENTE SATISFECHO (CLI) / NO DEPLOYMENT READY** | Lectura CLI read-only verificada sin crear/destruir recursos; faltan presupuesto numérico, duración, scope y confirmación de contexto/permisos. No se declaran capa gratuita, cuotas ni RBAC. El deploy real sigue bloqueado. |
| D-07 | RF07 unimodal / RF15 comparación (B7) | DEFERRED / NO BLOQUEO | No se implementan ni simulan. |
| D-08 | Envío real de email para forgot/reset (B8) | PENDIENTE SOLO PROVISIONING | Diseño/implementación y tests con sink en memoria no bloqueados; el envío real solo a destinatarios autorizados explícitos, sin PHI/enlaces secretos, sin versionar direcciones/datos personales/credenciales, con rate limit y sin user enumeration. |
| D-09 | `DatabaseFeedbackSource` con SQLAlchemy (B9) | **FUERA DE ALCANCE / NO BLOQUEO** | No se añade la dependencia ni se implementa en este hito; no bloquea el change. |

## 11. Trazabilidad aceptación → spec → tarea → test

> Códigos RF/HU usados solo cuando están citados por el encargo/SRS: RF02 (imagen), HU01 (login), HU08 (PDF), RF07/RF15 (diferidos). Las filas sin código no inventan uno; se apoyan en el título de requirement y en el test planificado. Los comandos con DB siguen el guard de `contracts/testing-runbook.md`.

| Aceptación | Requirement existente | Tareas | Test planificado |
|---|---|---|---|
| Ejecución única, lateralidad y snapshot | “Una ejecución analiza una sola retinografía con lateralidad”; “Snapshot clínico inmutable por ejecución” | 1.1, 2.1, 2.2 | `npm --prefix backend run test -- tests/repositories.test.ts tests/schemas.test.ts` (nuevos casos) |
| Reanálisis sin sobrescritura y reanálisis histórico excluido | “Reanálisis enlazado sin sobrescribir evidencia” | 2.2, 2.5, D-01, D-02 | `npm --prefix backend run test -- tests/repositories.test.ts` (nuevo caso histórico); PDF independiente |
| IDs requeridos explícitos y cambio tras cierre | “Selección explícita de ejecuciones requeridas y cambio tras cierre” | 2.5, D-02 | Test de frozen set; B2 restricción aprobada (sin promoción tras cierre) |
| Precedencia de estados y `REPORT_PENDING` | “Estado agregado de consulta con precedencia determinista” | 2.3, 2.6, 4.10 | `npm --prefix backend run test -- tests/repositories.test.ts` (mezcla FAILED/REVIEW/running) |
| Revisión terminal sin autoaprobar ni convertir | “Revisión humana terminal sin cierre automático”; “Reporte de revisión con limitación explícita” | 2.4, 6.3, D-01 | Worker stub; PDF de revisión; reanálisis con PDF independiente; B1 restricción aprobada |
| Artefactos, estados y referencia única | “Catálogo de artefactos y obligatoriedad por ruta”; “Estado explícito por artefacto”; “Referencia de artefacto estructurada y estable” | 1.2, 3.3, 3.4 | `npm --prefix backend run test -- tests/schemas.test.ts tests/repositories.test.ts` |
| Storage dual Azure/MinIO | “Abstracción de almacenamiento dual y firma por provider” | 3.1, 3.2, 3.8, 7.4 | Tests Azure fake/Azurite + MinIO; E2E real Azure condicionado a B6 (parcial, no deployment ready) |
| URLs firmadas, permisos y logs | “Autorización y firma de descargas bajo demanda”; “Prohibición de persistir credenciales temporales y URLs arbitrarias” | 3.4, 3.7 | `npm --prefix backend run test -- tests/rbac.test.ts` |
| Contrato ML estricto | “Contrato público estricto del servicio ML” | 4.1 | `python -m pytest ml/tests/test_service.py -q` |
| Idempotencia obligatoria y `202` recuperable | “Idempotencia persistida del backend” | 1.3, 4.4, 4.5 | Test nuevo de pérdida de `202`, replay y concurrencia |
| Worker at-least-once y resultado completo | “Entrega at-least-once y recuperación del worker”; “Estados de job y resultado completo” | 4.2, 4.6, 4.9 | `npm --prefix backend run test -- tests/repositories.test.ts` |
| Etiquetas canónicas | “Etiquetas canónicas y rechazo de etiquetas desconocidas” | 4.3 | `npm --prefix backend run test -- tests/schemas.test.ts` |
| Polling/backoff y entrega posterior | “Polling, Retry-After y entrega posterior a COMPLETED” | 4.10 | Test nuevo de polling/entrega |
| Roles, grants y ownership | “Tres roles con mínimo privilegio y default deny”; “Autenticación y autorización por endpoint y recurso” | 5.1, 5.2 | `npm --prefix backend run test -- tests/rbac.test.ts` |
| HU01 5 consecutivos/15 min | “Autenticación con bloqueo HU01 y rate limit” | 5.3 | `npm --prefix backend run test -- tests/jwt.test.ts` (reloj/concurrencia) |
| Sesiones/refresh/reset técnicos | “Sesiones, refresh, logout y recuperación seguros” | 5.1, 5.7, 5.8, 5.9 | `tests/refresh-session.integration.test.ts` (5.8, 21 tests QA), `tests/password-reset.integration.test.ts` (5.9, 28 tests QA) + `tests/jwt.test.ts tests/rbac.test.ts`; 5.9 QA PASSED |
| Último admin | “Protección del último administrador activo” | 5.4 | `npm --prefix backend run test -- tests/rbac.test.ts` (concurrencia) |
| Auditoría/desactivación/supresión | “Auditoría append-only de acciones sensibles”; “Desactivación y preservación de autoría”; “Borrado físico excepcional y supresión de identidad” | 5.5, 5.6, D-03/D-04/D-05 | `npm --prefix backend run test -- tests/rbac.test.ts` (fallo inyectado); sin hard delete en el hito |
| PDF básico con original+mask+overlay | “PDF básico obligatorio para completitud”; “Contenido clínico y trazabilidad del PDF” | 6.1, 6.3 | Test nuevo de PDF real: texto, imágenes renderizadas, faltantes |
| PDF versionado y HU08 | “Idempotencia y versionado del reporte”; “Criterio medible de generación institucional (HU08)” | 6.2, 6.4 | Test de versiones; benchmark HU08 |
| DB/migración condicionada | “Database Schema Initialization (init.sql)” | 1.1, 1.2, 1.3, 1.5 | `npm --prefix backend run test -- tests/migrations.test.ts` |
| Azure aislado/cleanup | “Provisión aislada por ejecución con alcance confirmado”; “Manifest de recursos y cleanup en `finally`”; “Verificación de borrado y recursos residuales” | 8.1, 8.2, 8.3, D-06 | Dry-run/stub; CLI solo prereq parcial; deploy real bloqueado hasta presupuesto/duración/scope/contexto/permisos |
| Grad-CAM/SHAP diferidos | “Generador de explicabilidad Grad-CAM”; “Explicabilidad diferida explícita” | 9.5, 9.6 | Test de reporte independiente futuro |
| Imagen JPEG/PNG >=512 px y <=20 MB (RF02) | “Nombres canónicos, mapeo y lateralidad”; “Endpoints prioritarios de la consolidación” | 7.3 | `npm --prefix backend run test -- tests/sanitizer.test.ts tests/schemas.test.ts` |
| RF07 unimodal / RF15 comparación | No implementar ni simular; B7 diferido | D-07 | Revisión de alcance; no se simula ni se declara implementado |
| Email real con governance (B8) | “Sesiones, refresh, logout y recuperación seguros”; “Envío real de email no configurado” | 5.9, D-08 | Memory sink; envío real solo a destinatarios autorizados, sin PHI/enlaces secretos ni versionado de direcciones/credenciales |
| DB feedback/SQLAlchemy fuera de alcance (B9) | “Database Feedback Source for Retraining” | D-09 | Revisión de alcance; sin dependencia nueva |
| RNF medidos | “Criterio medible de generación institucional (HU08)” + metas RNF del design | 6.4, 7.5 | Benchmarks aislados; no afirmar sin evidencia |
