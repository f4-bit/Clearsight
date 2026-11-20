# Runbook de pruebas incremental — consolidate-backend-ml-azure

> **Naturaleza:** documento de planificación. No ejecuta pruebas ni declara resultados. Separa comandos **CURRENT** (verificados contra el repo actual) de comandos **FUTURO** (no existen todavía y no deben presentarse como disponibles). Ninguna fase usa producción, datos clínicos reales sin governance, `.env.azure`, secretos, IDs de suscripción ni datos personales reales en el payload clínico. Excepción futura: los correos reales solo se usan para envío controlado autorizado, fuera del payload clínico; el worker productor no maneja PHI. Este runbook no commitea ni ejecuta por sí mismo; un orquestador/commit posterior no convierte la documentación en ejecución.

## 0. Reglas no negociables

1. **Producción prohibida.** Ninguna fase se ejecuta contra una base, bucket, cola o suscripción de producción. Si no se puede demostrar el target aislado, la fase se detiene.
2. **Ownership marker.** Toda DB/almacén/cola usada en pruebas destructivas debe haber sido creada o adoptada explícitamente para el run, con un marcador de ownership. **Que el nombre contenga `test` no es garantía suficiente.**
3. **Stop de pasos peligrosos.** Si falta una precondición, el target no es aislado, aparece un secreto/ID sensible o no hay cleanup verificable, se detiene la fase y se reporta. No se improvisa un bypass.
4. **Sin secretos y sin datos personales en payload.** No se leen ni imprimen `.env.azure` ni credenciales. No se versionan direcciones reales, datos personales, tokens, SAS ni presigned URLs. Los correos reales son una excepción futura únicamente para envío controlado autorizado, fuera del payload clínico; el worker productor no maneja PHI.
5. **Fallar no se oculta.** Un test fallido bloquea el commit de esa fase. Los fallos preexistentes se registran como baseline y no se presentan como éxito.
6. **Una tarea coherente.** Cada tarea se autoverifica y, si es de alto riesgo, requiere QA independiente. No se mezcla un arreglo masivo con una tarea.
7. **Commits/push.** Este change documental no se commitea aquí. La autorización global del usuario para commits/push en el flujo de trabajo ya está dada; no se pide de nuevo por fase. Un orquestador/commit posterior se hará cuando corresponda y no convierte este runbook en ejecución. El commit se limita a la fase/documentación verificada.

## 1. Mapa de fases

| Fase | Objetivo | DB/cloud | Riesgo | Estado |
|---|---|---|---|---|
| 0 | Entorno, versiones y smoke mínimo | No | Bajo | CURRENT |
| 1 | Documentación y specs estáticas | No | Bajo | CURRENT |
| 2 | Unidad/contratos focalizados | No (runner unitario) | Medio | CURRENT: runner unitario aislado |
| 3 | PostgreSQL/Redis/MinIO efímeros con ownership marker | Sí, efímero | Alto | PostgreSQL/Testcontainers EJECUTADO (HITO 3); Redis/MinIO no ejecutados; compose raíz NO LISTO |
| 4 | Stub ML y fault injection | No real | Medio | CURRENT parcial / FUTURO casos |
| 5 | ML local real con pesos y golden tolerances | No cloud | Alto | CURRENT con pesos / FUTURO golden |
| 6 | E2E Azure completo y cleanup | Azure real | Muy alto | FUTURO, bloqueado por B6 |
| B | Benchmarks separados (p95 full-flow, concurrencia) | Entorno aprobado | Alto | FUTURO |

## 1.1 Evidencia INITIAL BASELINE — 2026-11-18

> Evidencia suministrada por el arquitecto y registrada sin emails, IDs de suscripción ni salidas sensibles. Todos los comandos de esta evidencia estuvieron disponibles; ninguno se marca como no disponible.

| Elemento | Resultado observado |
|---|---|
| Node | `v24.18.0` |
| npm | `11.16.0` |
| Python | `3.11.14` |
| pytest | `9.0.3` |
| Docker CLI | `28.5.1` (daemon **no** verificado) |
| Azure CLI | `2.91.0`, lectura read-only, default `Enabled`/`AzureCloud`, `group list` `[]`; **sin creación de recursos** |
| Comando ML ejecutado | `python -m pytest ml/tests/test_service.py ml/tests/test_clinical_normalization.py ml/tests/test_manifest.py -q` con `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` temporal, restaurado en `finally` para evitar plugins externos |
| Resultado exacto | **7 passed, 1 warning, 6.85s** |
| Warning | `StarletteDeprecationWarning` de `httpx` vs `TestClient`; sugiere `httpx2`; **no tocar dependencias automáticamente** |
| Alcance cubierto | `test_service` con `create_app(initialize_runtime=False)` y health; `clinicalNormalization` (5 casos); `manifest` (1 caso) |
| Fuera de alcance de esta evidencia | ML real, Azure, DB, Redis, Docker daemon y suite backend |

## 1.2 Evidencia HITO 1 — preparación de storage neutral (2026-11-18)

> Evidencia de ejecución local del hito 1 (`ArtifactStore.ensure_storage`). No se usó Azure real, MinIO real, Redis real ni pesos: los tests inyectan clientes fake de SDK/cola. La evidencia **INITIAL BASELINE** de 1.1 se conserva sin cambios.

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | `ArtifactStore.ensure_storage`; MinIO delega en `ensure_buckets`; Azure verifica `mask_bucket`/`overlay_bucket` con `exists()` sin crear contenedores y falla seguro si un contenedor configurado no existe cuando hay cliente, aunque el storage sea opcional; ambas colas llaman `ensure_storage` antes de crear el worker. |
| Test focalizado | `python -m pytest ml/tests/test_service.py ml/tests/test_azure_readiness.py ml/tests/test_clinical_normalization.py ml/tests/test_manifest.py ml/tests/test_storage.py -q -k "not database_feedback"` con `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` temporal, restaurado en `finally`. |
| Resultado exacto | **28 passed, 1 deselected, 1 warning, 4.05s** |
| Regresión roja antes del fix | Con las dos llamadas de cola revertidas temporalmente a `ensure_buckets`, `python -m pytest ml/tests/test_storage.py -q -k "queue_start"` → **5 failed, 1 passed, 10 deselected, 4.18s**: fallan los casos Azure/neutral con `AttributeError ... has no attribute 'ensure_buckets'` en `queue.py:84,157` y MinIO sigue pasando porque conserva `ensure_buckets`; restaurado a `ensure_storage` y verificado verde. |
| Lint | `python -m ruff check --config ml/pyproject.toml ml/service/storage.py ml/service/queue.py ml/tests/test_storage.py ml/tests/test_service.py` → **All checks passed.** |
| Tipos | `python -m mypy --config-file ml/pyproject.toml ml/service/storage.py ml/service/queue.py` → **Success: no issues found in 2 source files.** El baseline previo registraba 2 errores por `ArtifactStore` sin `ensure_buckets`; el contrato neutral los resuelve. |
| Validación documental | `openspec validate consolidate-backend-ml-azure --strict` → `Change 'consolidate-backend-ml-azure' is valid`; `git diff --check` sin errores de whitespace. |
| Fuera de alcance | No se ejecutó Azure ni MinIO reales, ni E2E, ni tests con pesos/DB/Redis. El test de readiness usa `InMemoryJobQueue` y `build_runtime` stub; prueba 200/503 por preparación de storage, no un E2E Azure. |
| Deuda conocida | `MinioArtifactStore.ensure_buckets` mantiene el comportamiento actual: solo crea en 404 y no propaga otros errores de `head_bucket` (p. ej. 403); no se declara fail-closed para MinIO en este hito. |

## 1.3 Evidencia HITO 2 — backend test isolation (2026-11-18)

> Evidencia de ejecución local del hito de aislamiento de runners backend. No se usó Azure, Docker/Testcontainers real, `.env` ni datos clínicos. La evidencia anterior se conserva sin cambios.

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | `npm test` y `test:unit` usan una allowlist pura (`tests/schemas.test.ts`, `tests/sanitizer.test.ts`, `tests/unit/**/*.test.ts`) sin `globalSetup`; el runner unitario instala un trap de red. `test:integration` es explícito y conserva los 8 archivos originales de integración/mocks locales. |
| Unit runner | `npm --prefix backend run test:unit` → **6 files passed, 57 tests passed**, sin DB, Redis ni Docker. |
| Default runner | `npm --prefix backend run test` → **6 files passed, 57 tests passed**. `npx vitest run tests/repositories.test.ts` → **No test files found, exit 1**. |
| Filtros focalizados | `test:unit -- tests/sanitizer.test.ts` → **1 file, 1 test passed**; `test:unit -- tests/schemas.test.ts` → **1 file, 16 tests passed**; `test:unit -- tests/repositories.test.ts` → **No test files found, exit 1** (sin setup ni DB). |
| Guard de integración | Rechazo de `TEST_DATABASE_URL` presente/vacía/whitespace/malformada antes de crear cliente/contenedor; URL no se imprime; cleanup de cliente/contenedor en fallo de connect/migración/provide; teardown idempotente. Verificado con mocks en `tests/unit/integration-setup.test.ts`. |
| Ownership | Nombre de BD único por run, label `com.clearsight.test.run-id`, marker `test_meta`; `resetDb` verifica el marker antes del `TRUNCATE`. Contenedor fresco: no se hace `DROP SCHEMA public`. |
| Typecheck | `npm --prefix backend run typecheck` → **exit 0** tras `prisma generate` con config temporal sin dotenv. |
| Límites | No se ejecutó `test:integration` real: el daemon Docker local no está disponible. Los tests de integración (8 archivos) no se declaran verdes. El runner unitario no cubre flujos de negocio/seguridad ni Prisma/Redis/SQL. |
| Residual G1 | El cleanup de `global-setup` cubre fallos posteriores a obtener el handle del contenedor (connect, migración, marker, provide). Un rechazo dentro de `container.start()` antes del handle depende del reaper/Testcontainers y no se ejerce aquí por ausencia de Docker; no se endurecen internals del provider en este hito. |
| Fuera de alcance | E2E real Azure/Postgres, arreglos de inyección de dependencias de rutas y tareas 7.1/7.2. |

## 1.4 Evidencia HITO 3 — backend integration real local (2026-11-18)

> Evidencia de la primera ejecución real de `test:integration` contra PostgreSQL efímero con Testcontainers. No se usó Azure ni se leyó `.env.azure`; no se inspeccionaron recursos globales del host ni se eliminó nada de forma manual o ajena. La evidencia **HITO 2** se conserva como histórica: registraba la ausencia de daemon Docker en ese momento. HITO 3 **supersede únicamente la disponibilidad** del daemon, no los resultados previos ni el residual G1.

| Elemento | Resultado observado |
|---|---|
| Entorno | Docker server/engine `28.5.1` respondía (ya arrancado externamente; el arquitecto no inició Docker Desktop). `TEST_DATABASE_URL` ausente (`presence=False`). No se encontró `backend/.env`. Inventario previo con `docker ps -a` filtrado por `com.clearsight.test.owner=backend-integration` y `org.testcontainers=true`, sin salida. |
| Comando | `npm --prefix backend run test:integration` |
| Resultado exacto | Vitest `5.1.0` backend: **8 files passed, 62 tests passed**, inicio `17:09:59`, duración `18.61 s`, **exit 0**. |
| Runner y ownership | El runner creó su propio PostgreSQL `16-alpine` por Testcontainers con ownership; ejecutó setup, migraciones, fixtures, queries de test y cleanup según el harness ya verificado por QA de seguridad. No hubo cambios de fuente ni fixes necesarios. |
| Cleanup comprobado | Tras el run, `docker ps -a` con los mismos dos filtros de labels y `docker volume ls` filtrado por el label de ownership no devolvieron salida. |
| Límite de la comprobación | Solo se consultaron recursos con esas etiquetas; **no** se inspeccionaron todos los volúmenes ni todos los recursos del host, no se eliminó nada manualmente y no se tocaron recursos ajenos. |
| Cobertura | Cierra la ejecución local pendiente de 7.0.1 para PostgreSQL/Testcontainers. No cubre 7.1 (adversos nuevos), 7.2 (E2E clínico completo), 7.4 (Azure) ni la suite completa de auth/sesión. |
| Residual G1 | El arranque exitoso real ejercita el camino feliz, pero **no** simula un fallo dentro de `container.start()` antes de obtener el handle; el residual G1 no se declara cerrado por esta integración. |
| Validación documental | `openspec validate consolidate-backend-ml-azure --strict` → `Change 'consolidate-backend-ml-azure' is valid` (exit 0); `git diff --check` → exit 0, sin errores de whitespace (solo avisos LF→CRLF de Git). |

## 1.5 Evidencia HITO 4 — migración A de esquema (2026-11-18)

> Evidencia local de la tarea 1.1. Solo se usó PostgreSQL efímero de Testcontainers con ownership; no se usó Azure, `.env.azure`, una DB real ni datos clínicos reales. No se modificaron dependencias ni lockfiles. La evidencia HITO 3 se conserva como histórica (8 files / 62 tests); HITO 4 amplía el recuento por los casos nuevos de migración A.

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | Migración aditiva `20261118000000_execution`: `clinical_snapshots` inmutable; `Consultation.requiredExecutionIds` (`UUID[]` default `{}`), `requiredSetVersion`/`requiredSetFrozenAt` nullable; `Inference.consultationId`/`eyeSide`/`clinical_snapshot_id`/`status`/`reanalysisOfId` nullable; constraints y triggers SQL. `docker/init.sql` quedó idéntico a `0_init`. |
| Migraciones | `npm --prefix backend run test:integration -- tests/migrations.test.ts` → **1 file passed, 25 tests passed**, duración `7.46 s`, exit 0. Incluye upgrade legacy con todas las migraciones, replay de A, casos SQL de snapshot/selección/reanálisis y regresiones F1/F2/F3. |
| Integración completa | `npm --prefix backend run test:integration` → **8 files passed, 83 tests passed**, duración `19.37 s`, exit 0. |
| Unitario | `npm --prefix backend run test:unit` → **6 files passed, 57 tests passed**, duración `600 ms`, exit 0. |
| Typecheck/build | `npm --prefix backend run typecheck` → exit 0; `npm --prefix backend run build` → exit 0. |
| Prisma | `prisma validate --config <temp-config-sin-dotenv>` → schema válido; `prisma generate --config <temp-config-sin-dotenv>` → cliente generado. `@@index([requiredExecutionIds], type: Gin, map: "idx_consultations_required_execution_ids")` coincide con el índice SQL. El config temporal declaró schema/migrations absolutos y una URL sintética; no cargó `.env`/`.env.azure` ni se conectó a una DB real. |
| Regresiones F1/F2/F3 | Añadidas primero contra el SQL previo: **4 failed / 21 passed** (rojo esperado, sin mutar workspace). Tras corregir los triggers: **25 passed** (verde). R1 verificado con introspección `pg_indexes` (`USING gin` sobre `required_execution_ids`). |
| Docker/cleanup | Inventario previo y posterior con `docker ps -a` filtrado por `com.clearsight.test.owner=backend-integration` y `org.testcontainers=true`, y `docker volume ls` por el label de ownership: sin salida. Solo se consultaron recursos con esas etiquetas; no se borró nada manualmente ni se tocaron recursos ajenos. |
| Límites | No cubre consumidores de aplicación 2.x, migración B/C, PDF/artefactos, Azure real ni E2E clínico completo. Diferido explícitamente a 1.4: serialización con locks de freeze/borrado concurrente (sin declarar inmutabilidad concurrente completa), guard de reparentado directo de `images.consultation_id`/`eye_side` y denegación de `TRUNCATE` al rol de aplicación. F4 (TRUNCATE privilegiado) no es defecto de los guards `UPDATE`/`DELETE`; no se añade `BEFORE TRUNCATE` porque rompería los fixtures con ownership. |

## 1.6 Evidencia HITO 5 — migración B de artefactos/PDF (2026-11-18)

> Evidencia local de la tarea 1.2. Solo PostgreSQL efímero de Testcontainers con ownership; sin Azure, `.env.azure`, DB real ni datos clínicos reales. No se modificaron dependencias ni lockfiles. La evidencia HITO 4 se conserva como histórica (8 files / 83 tests).

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | Migración aditiva `20261118010000_artifact_reports`: `artifact_records` (mask/overlay/pdf/gradcam/shap; `result` inline), referencia estructurada, estados, checksum lowercase, versiones únicas y publicación inmutable; `pdf_reports` versionado, snapshot/rendering inputs inmutables, artifact pdf misma inferencia/versión y transiciones PENDING/FAILED. `docker/init.sql` intacto. |
| Migración focalizada | `npm --prefix backend run test:integration -- tests/artifact-migrations.test.ts` → **1 file passed, 28 tests passed**, duración `8.50 s`, exit 0. Incluye fresh schema, estados/refs, negativos SQL, inmutabilidad, versionado, replay B, delete/cascade, linkage PDF y provenance capturada. |
| Migración A/B legacy | `npm --prefix backend run test:integration -- tests/migrations.test.ts` → **25 tests passed**, duración `7.74 s`; el upgrade legacy aplica A y B y conserva filas antiguas con `artifact_records`/`pdf_reports` en 0. |
| Integración completa | `npm --prefix backend run test:integration` → **9 files passed, 111 tests passed**, duración `25.45 s`, exit 0. |
| Unitario | `npm --prefix backend run test:unit` → **6 files passed, 57 tests passed**, duración `595 ms`, exit 0. La allowlist de integración y `runner-isolation` incluyen el nuevo archivo sin ampliar el runner unitario. |
| Typecheck/build | `npm --prefix backend run typecheck` → exit 0; `npm --prefix backend run build` → exit 0. |
| Prisma | `prisma validate --config <temp-config-sin-dotenv>` → schema válido; `prisma generate --config <temp-config-sin-dotenv>` → cliente generado. Config temporal con URL sintética, sin `.env`/`.env.azure` y sin conexión a DB real. |
| Negativos/rojo | QA aportó 28 tests: antes del fix se observó **2 failed / 26 passed** (`renderingInputs` con query signature y `key` con esquemas URI no listados); tras corregir patrones acotados: **28 passed**. No se mutó fuente para forzar otros rojos. Los tests SQL reales fallarían si se retirasen los checks/triggers de completitud, URI, unicidad o inmutabilidad; R1/R2 quedan cubiertos por la prueba de provenance capturada. |
| Docker/cleanup | Inventario previo y posterior con filtros de ownership/Testcontainers y volúmenes: sin salida tras el cleanup. Solo se consultaron recursos etiquetados; no se borró nada manualmente ni ajeno. |
| Límites | No cubre generación PDF real, upload/storage, rutas, auth, consumidores 3.5/6.x, Azure ni E2E clínico. El reparentado directo de `images`, carreras concurrentes y rol DB sin `TRUNCATE` siguen en 1.4. |

## 1.7 Evidencia HITO 6 — migración C identidad/auditoría/sesiones (2026-11-18)

> Evidencia local de la tarea 1.3. Solo PostgreSQL efímero de Testcontainers con ownership; sin Azure, `.env.azure`, DB real ni datos clínicos reales. No se modificaron dependencias ni lockfiles. La evidencia HITO 5 se conserva como histórica (9 files / 111 tests).

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | Migración aditiva `20261118020000_identity_audit`: contadores/versión de usuario, `user_sessions`, `audit_events`, `refresh_tokens`, `password_reset_tokens` e `idempotency_records`, con hash-only, append-only, unicidad, FKs restrict y checks SQL. Sin auth routes/workers/servicios; `docker/init.sql` intacto. |
| Migración focalizada | `npm --prefix backend run test:integration -- tests/identity-migrations.test.ts` → **1 file passed, 18 tests passed**, QA real, exit 0 (duración no consignada en el consolidado QA). Cubre defaults/legacy, tokenVersion monotónico, auditoría, sesiones, refresh/reset, idempotencia 202, concurrencia y replay C. |
| Migraciones A/B legacy | `npm --prefix backend run test:integration -- tests/migrations.test.ts` → **25 tests passed**, duración `9.97 s`; `artifact-migrations.test.ts` → **28 tests passed**. |
| Integración completa | `npm --prefix backend run test:integration` → **10 files passed, 129 tests passed**, QA real, exit 0 (duración no consignada en el consolidado QA). |
| Unitario | `npm --prefix backend run test:unit` → **6 files passed, 57 tests passed**, duración `554 ms`, exit 0. La allowlist de integración y `runner-isolation` incluyen el nuevo archivo sin ampliar el runner unitario. |
| Typecheck/build | `npm --prefix backend run typecheck` → exit 0; `npm --prefix backend run build` → exit 0. |
| Prisma | `prisma validate --config <temp-config-sin-dotenv>` → schema válido; `prisma generate --config <temp-config-sin-dotenv>` → cliente generado. Config temporal con URL sintética, sin `.env`/`.env.azure` y sin conexión a DB real. |
| Docker/cleanup | Inventario previo y posterior con filtros de ownership/Testcontainers y volúmenes: sin salida tras el cleanup. Solo se consultaron recursos etiquetados; no se borró nada manualmente ni ajeno. |
| Límites | No implementa login/registro/refresh/reset/auditoría/idempotencia de aplicación; solo DB. El outbox de 4.6 requiere migración incremental propia. `TRUNCATE`/DDL privilegiado y carreras siguen en 1.4. No se añadió entrada al registro de regresiones. |

## 1.8 Evidencia HITO 7 — integridad concurrente y rol app (2026-11-18)

> Evidencia local de la tarea 1.4. Solo PostgreSQL efímero de Testcontainers con ownership; sin Azure, `.env.azure`, DB real ni datos clínicos reales. No se modificaron dependencias ni lockfiles. La evidencia HITO 6 se conserva como histórica (10 files / 129 tests QA).

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | Migración aditiva `20261118030000_integrity_hardening`: locks `FOR SHARE` deterministas y schema-qualified en selección/contexto, guard de reparentado de `images` sin locks de hijos (solo EXISTS tras el write lock propio), verificación efectiva de ACL y grupo global `clearsight_app` NOLOGIN con grants mínimos por `current_schema()`. A/B/C sin editar. |
| Migración focalizada | `npm --prefix backend run test:integration -- tests/integrity-migrations.test.ts` → **1 file passed, 25 tests passed**, duración `11.91 s`, exit 0. Incluye ambas órdenes freeze/delete, identidad seleccionada, reparentado, reanálisis, multi-ID, replay, SET ROLE, decoys de `search_path`, deadlock regression y matriz de ACL efectiva. |
| Integración completa | `npm --prefix backend run test:integration` → **11 files passed, 154 tests passed**, duración `43.12 s`, exit 0. |
| Unitario | `npm --prefix backend run test:unit` → **6 files passed, 57 tests passed**, duración `630 ms`, exit 0. Allowlist integración con 11 archivos; runner unitario sin ampliar. |
| Typecheck/build | `npm --prefix backend run typecheck` → exit 0; `npm --prefix backend run build` → exit 0. |
| Prisma | Sin cambios de modelos; `prisma validate --schema=<abs backend/prisma/schema.prisma>` → schema válido. |
| Concurrencia | Dos conexiones reales, `lock_timeout` 3–5 s y observación de `pg_stat_activity`/`pg_blocking_pids`; todas las carreras probadas terminaron con rechazo explícito y estado final consistente. El regression de inversión image/child ya no produce `40P01`: el guard de imagen rechaza por hijos existentes sin esperar locks de filas hijas. No se declara ausencia universal de deadlocks. |
| Correcciones QA | QA reportó **21/23 focused (2 red)**. Q1/Q2: locks/EXISTS de D resuelven relaciones vía `EXECUTE format('%I...', TG_TABLE_SCHEMA)`, verificado con `search_path` decoy. H1: se eliminaron los `PERFORM` de self-image y filas hijas del guard, dejando solo `EXISTS` schema-qualified tras el write lock propio; regression sin `40P01`. R3: se verifica el privilegio efectivo de `clearsight_app` (incluido PUBLIC) y se falla cerrado sin reescribir ACL de PUBLIC. Resultado tras fix: **25/25 focused**. |
| Rol/cleanup | `SET ROLE clearsight_app` permite SELECT/INSERT/UPDATE seguros y auditoría/snapshot INSERT; deniega UPDATE/DELETE de historial, DELETE/TRUNCATE, DDL y `test_meta`. La migración falla si PUBLIC/otro rol concede efectivamente DELETE/TRUNCATE/UPDATE de historial; no modifica el ACL de PUBLIC. `RESET ROLE` permite al owner truncar fixtures/limpiar. Inventario Docker con labels propios sin residuos. |
| Únicos/límites | No crea LOGIN runtime, no cambia `DATABASE_URL` y no afirma mínimo privilegio del DSN actual; provisioning/login y readiness son 8.x. Owner/superuser y `TRUNCATE`/DDL privilegiado siguen fuera de triggers de fila. No cubre outbox 4.6 ni servicios auth. |

## 1.9 Evidencia HITO 9 — bootstrap admin y retiro del alta pública (2026-11-18)

> Evidencia local de la tarea 1.6. Solo PostgreSQL efímero de Testcontainers con ownership; sin Azure, `.env.azure`, DB real, PHI, correos reales ni secretos. No se modificaron dependencias, lockfiles ni SQL histórico. Las credenciales de prueba son sintéticas.

| Elemento | Resultado observado |
|---|---|
| Cambio verificado | `POST /auth/register` responde `410 Gone` con `errorResponseSchema` para cualquier JSON válido, sin body schema, DB, bcrypt ni JWT (JSON malformado: `400` del parser). Se añadió `bootstrapAdmin` inyectado y el CLI `npm run admin:bootstrap` con env-only, lock `clearsight:admin-lifecycle:v1`, transacción `ReadCommitted`, bcrypt cost 12 y auditoría `ADMIN_BOOTSTRAP` en la misma transacción. |
| Unitario | `npm --prefix backend run test:unit` → **11 files passed, 138 tests passed**, duración `1.93 s`, exit 0. Incluye validadores (normalización, 12 code points, 72 bytes UTF-8), errores seguros, control de flujo con cliente inyectado, bordes adversarios y ramas del CLI (`0/1/2`, primario vs cleanup). |
| Integración focalizada | `npm --prefix backend run test:integration -- tests/admin-bootstrap.integration.test.ts` → **1 file passed, 32 tests passed**, duración `18.67 s`, exit 0. Cubre bootstrap real, bcrypt cost 12, datos normalizados, auditoría sin PII, segundo bootstrap con admin inactivo, conflicto case-insensitive, concurrencia, rollback por fallo de auditoría, CLI éxito/errores seguros sin secretos, registro `410` sin efectos, argv ignorado, schema MIGRATION y F01 cleanup. |
| Integración completa | `npm --prefix backend run test:integration` → **13 files passed, 214 tests passed**, duración `98.52 s`, exit 0. |
| Typecheck/build | `npm --prefix backend run typecheck` → exit 0; `npm --prefix backend run build` → exit 0. |
| F01 cleanup | Regresión real en PostgreSQL owned: el bootstrap confirma usuario + auditoría y luego `$disconnect` lanza un error sintético con URL/credencial/host canary; el CLI devuelve **exit 2**, stdout conocido `operationStatus=COMMITTED cleanup=PENDING`, stderr constante `BOOTSTRAP_DISCONNECT_FAILED` sin interpolar el driver ni declarar rollback. La consulta independiente verifica 1 `ADMIN` y 1 auditoría `SYSTEM`/`ADMIN_BOOTSTRAP` con el mismo `targetUserId`. |
| CLI/secretos | El CLI no imprime email, contraseña, hash ni DSN; stdout solo `userId`/`role` más estado/cleanup. Configuración o input inválido fallan antes de construir el cliente/red con códigos `BOOTSTRAP_*`. Exit `0` = commit+cleanup, `1` = fallo primario (sin reemplazo por cleanup), `2` = commit+cleanup pendiente. No se acepta `--password` por argv ni se lee `.env`; no hay reintento automático. |
| Docker/cleanup | Inventario posterior con `docker ps -a` filtrado por `com.clearsight.test.owner=backend-integration` y `docker volume ls` por el label de ownership: sin salida. No se borró nada manualmente ni ajeno. |
| Registro | REG-005 actualizado a `resuelto`/`cubierto` con permiso explícito del arquitecto y test de regresión. REG-006 (JWT/sesión sin `isActive`/revocación) **sigue activo**: login/me/JWT no cambiaron en esta tarea. |
| Límites | No implementa `POST /admin/users` (1.8), el servicio general de auditoría (5.5) ni sesiones/refresh/revocación. No declara el ciclo de vida completo de cuentas ni el despliegue seguro de auth. El bootstrap solo crea el primer `ADMIN`; no hay recuperación, reactivación ni escalado operativo. |

## 1.10 Evidencia HITO 10 - sesiones de acceso 5.1/5.7 (2026-11-19)

> Ajuste documental final. No cambia fuente ni pruebas; conserva los conteos de QA.

| Elemento | Resultado observado |
|---|---|
| Unit | **15 files / 247 tests passed** |
| Full integration | **14 files / 245 tests passed** |
| Foco auth/JWT/RBAC/feedback/export | **5 files / 72 tests passed** (foco previo 71; conteo final QA 72) |
| Typecheck/build | exit 0 |
| OpenSpec strict | PASS reportado por QA |

- Access JWT HS256 con `sessionId` y `tokenVersion`; TTL 15 min (max 900 s) y sesion tecnica absoluta de 7 dias.
- Tokens legacy sin `sessionId`/`tokenVersion` (o sin exp/iat valido) responden `401` generico.
- Store no disponible responde `503` fail closed, sin datos de cuenta.
- Dummy bcrypt cost 12 compartido por bootstrap/seed/altas futuras; hashes legacy de coste menor siguen aceptados sin rehash offline y conservan variabilidad de timing residual.
- Lock SQL cualificado por `databaseSchema` (default `public`; custom explicito para clientes Prisma con otro schema).
- El guard de produccion rechaza los placeholders publicos de `.env.example` (`replace-me...`), variantes `change-me`/`changeme` y valores vacios o cortos; una clave valida no-placeholder de 32+ caracteres sigue aceptada. No se leen `.env` reales ni `.env.azure`.
- Este hito **no** declara toda la autenticacion como asegurada: en ese momento 5.2, 5.3, 5.6, 5.8 y 5.9 seguían pendientes; se cerraron en hitos posteriores (5.9 QA PASSED en HITO17).

## 1.11 Evidencia HITO 11 - login protection 5.3 (2026-11-19)

> Cierre acotado tras QA PASSED y reviewer sin defectos. Solo PostgreSQL efímero de Testcontainers con ownership; sin Azure, `.env.azure`, DB real, credenciales reales ni datos clínicos. Fuente de producción ya aprobada; este hito añade únicamente la evidencia de cierre y dos pruebas de contrato.

| Elemento | Resultado observado |
|---|---|
| Unit | **16 files / 283 tests passed** |
| Login guard integration | **1 file / 35 tests passed** |
| Full integration | **15 files / 281 tests passed** |
| Typecheck/build | exit 0 |
| OpenSpec strict | Pendiente del CLI del parent (el agente tiene denegado el comando); documentos actualizados de forma nativa |
| Docker/cleanup | labels `com.clearsight.test.owner=backend-integration` y `org.testcontainers=true` y volúmenes de ownership vacíos antes/después; no se tocaron recursos preexistentes (`redkeep_db`), red ni `SRS ClearSight.pdf` |

- **HU01:** cinco fallos consecutivos -> `429` con contador 5 y bloqueo 15 min; 4 fallos -> `401`; éxito previo al umbral -> reset 0 y el siguiente fallo cuenta 1; éxito durante el bloqueo -> `429` sin sesión, sin reset y sin extender `lockedUntil`; boundary exacto -> login correcto y reset. Fallos concurrentes en el umbral -> un solo lock y contador 5.
- **Atomicidad:** el fallo se confirma en su propia transacción antes de lanzar el `401/429`; el reset de éxito ocurre dentro de la tx de sesión/audit/firma, por lo que un fallo de signer/audit revierte el reset y conserva el contador previo. La prueba stale re-registra exactamente un fallo; un intento throttled no duplica el conteo.
- **Desconocidos:** misma secuencia `401/429` y mismo vencimiento que un identificador conocido, sin usuario falso; el estado user/bucket se mantiene coherente y el `max` de ambos sobrevive a la rotación del secreto. Un lock expirado reinicia el contador.
- **IP complementaria:** `IP_RATE_LIMIT=100` intentos por `IP_RATE_WINDOW_SECONDS=60` s; enteros positivos dentro de un cap operativo (0/negativo no desactiva). Cuota compartida por NAT entre cuentas; el peer real de Fastify (`trustProxy:false`) se usa como clave y un `X-Forwarded-For` falsificado no cambia la cuota. `Retry-After` positivo desde la ventana/bloqueo restante; llamadas internas sin metadata usan el bucket `INTERNAL` y no omiten la cuota.
- **Almacenamiento:** buckets pseudónimos HMAC-SHA256 con subclave derivada por propósito (`clearsight:auth-login-protection:v1`) y separador kind+NUL; no se almacenan ni registran emails/IP/secretos/contraseñas crudas. No se declara anonimización universal ni igualdad estricta de timing; la cuota IP es complementaria y no una garantía anti-DoS. El reset es lógico (ventana/lock), no una purga de evidencia clínica.
- **Rol restringido:** `clearsight_app` recibe S/I/U en D+E. Un Prisma real con `-c role=clearsight_app` ejecutó login fallido `401` (contador 1), login correcto `200`, reset de user/bucket a 0, `UserSession` + `AuditEvent` (`AUTH_SESSION_CREATED`, `USER`/`SUCCESS`) y `GET /auth/me` `200`; `CURRENT_USER` siguió siendo `clearsight_app` y `session_user` el owner. `TRUNCATE auth_login_buckets` bajo el rol falló con SQLSTATE `42501` sin perder filas. No se otorgó TRUNCATE, no se creó LOGIN/rol de producción ni se desplegó credencial real; el cleanup lo hizo el owner.
- **Pendientes sin cambios:** 5.6 desactivación/supresión, 5.8 refresh/logout/cookies, 5.9 reset de contraseña, 1.8 alta admin y 5.2 ownership/grants de recursos. Este hito no los declara implementados.

## 1.12 Evidencia HITO 12 - auditoría compartida 5.5 (2026-11-19)

> Cierre documental acotado tras QA + reviewer PASSED. Solo PostgreSQL efímero real de Testcontainers con ownership; sin Azure, `.env.azure`, sin DB compartida, de desarrollo ni de producción, y sin credenciales reales ni datos clínicos. La fuente y las pruebas quedan inmutables en este cierre.

| Elemento | Resultado observado |
|---|---|
| Unit | **18 files / 319 tests passed** |
| Foco 5.5 (bootstrap/session/login/audit) | **4 files / 112 tests passed** |
| Full integration | **16 files / 294 tests passed** |
| Typecheck/build | exit 0 |
| Docker/cleanup | PostgreSQL efímero owned por Testcontainers; sin recursos owned residuales; no se tocaron `.env.azure`, Azure, DB compartida, de desarrollo ni de producción, ni datos clínicos |

| Source 5.5 | Prueba unit/real | Resultado |
|---|---|---|
| `backend/src/services/audit.ts` (`withAuditedTransaction`, `writeAuditEvent`, contexto `WeakMap`) | `tests/unit/audit.test.ts`, `tests/unit/audit-adversarial.test.ts` | unit 18/319 |
| `backend/src/services/admin-bootstrap.ts` (misma tx, `BOOTSTRAP_AUDIT_FAILED`) | `tests/unit/admin-bootstrap*.test.ts`, `tests/admin-bootstrap.integration.test.ts` | incluido en unit/full |
| `backend/src/services/session.ts` (misma tx, `AUTH_STORE_UNAVAILABLE`) | `tests/auth-sessions.integration.test.ts`, `tests/login-protection.integration.test.ts` | foco 4/112 |
| `backend/tests/audit.integration.test.ts` (fila exacta, timestamp DB, append-only, rollback) | PostgreSQL owned de Testcontainers | full 16/294 |

- **Wrapper público:** `withAuditedTransaction(db, work, options?)` abre `db.$transaction` (API pública de Prisma) y emite un `AuditContext` opaco con `.tx`; la identidad se registra en un `WeakMap` privado y se desregistra en `finally`, incluso ante error.
- **Writer:** `writeAuditEvent(context, input)` exige el contexto activo del wrapper; rechaza cliente raíz, `tx` crudo, objetos fabricados, clones y contextos cerrados antes de cualquier escritura. Usa `context.tx.auditEvent.create`; no abre transacción propia ni hace commit.
- **Atomicidad:** un callback exitoso debe escribir al menos un evento (`AUDIT_EVENT_REQUIRED` si no). Si el writer falla por validación o store, el primer fallo queda sticky en el contexto; aunque el callback lo capture y retorne falso éxito, el wrapper aborta la transacción. Los dos llamadores actuales (`admin-bootstrap`, `session`) hacen `await writeAuditEvent(...)`.
- **Sin internals:** no se usa ningún símbolo privado de Prisma ni se inspecciona `$transaction` del `itx`; el prototipo retirado con `Symbol.for('prisma.client.transaction.scope_context')` nunca se commiteó.
- **Límites:** la composición anidada de `withAuditedTransaction` sobre el mismo root DB queda fuera de alcance; no se declara soporte para callbacks fire-and-forget arbitrarios ni para código propio malicioso compilado. No hay endpoint público nuevo, UI admin ni claim de permisos/grants clínicos.
- **Registro de regresiones:** sin edición; REG-005/REG-006 siguen cubiertos por la prueba de fuente y no existen operaciones de UI admin que puedan producir un falso positivo.
- **Pendientes sin cambios:** 1.8, 5.4, 5.6, 5.8, 5.9 y 5.2. Este hito no los declara implementados.

## 1.13 Evidencia HITO 15 - privacidad clinica 5.2 (2026-11-19)

> Cierre documental final tras QA PASSED sobre fuente sin cambios. Solo PostgreSQL 16 efimero/owned de Testcontainers; sin Azure, `.env.azure`, DB real, PHI, correos reales ni datos clinicos. No se editaron fuente ni pruebas en este cierre.

| Elemento | Resultado observado |
|---|---|
| Unit final QA | **21 files / 355 tests passed (3.06 s)** |
| Full integration final QA | **20 files / 380 tests passed (235.17 s)** |
| Typecheck/build | runs verdes reutilizados del mismo estado, inspeccionados por QA; exit 0 |
| Diff/cleanup | `git diff --check` limpio (solo warnings CRLF preexistentes); `docker ps -a` solo `redkeep_db` detenido no relacionado; cero contenedores propios residuales |
| H-01 | Resuelto: `POST /inferences` rechaza `inferenceId`/`imageUrl` (400 identico fresh/own/foreign) antes de writes/sign/queue; sin el campo genera UUID de servidor (202). Sin oraculo cross-case ni PK de cliente. |
| H-02 | Latente documentado: E congela columnas de la fila `inferences`; no agrega trigger sobre `images`. La mutacion SQL privilegiada del padre queda fuera de E y solo la cubre el guard D existente cuando aplica; sin writer de aplicacion. |
| H-03 | Validado: el cliente Prisma (`backend/src/lib/prisma.ts`) resuelve `DATABASE_URL` una sola vez; rutas/servicio clinico comparten el mismo `prisma`+access inyectado. Factory global y worker diferidos. |
| Historico pre-QA | Foco unit/schema 4 files / 41 tests y foco ACL/migracion/repositorios 3 files / 44 tests; no son conteos finales. |

- Sin cambios de fuente/pruebas en este cierre documental; no se ejecutaron suites desde el agente de documentacion.
- La tarea 5.2 quedó cerrada con la evidencia QA anterior; 5.8/5.9 se cerraron después con QA PASSED y 9.2 sigue pendiente. No se declara release clinica completa.

## 1.14 Evidencia HITO16 — contrato de sesión web 5.8 (QA PASSED)

> **Naturaleza:** QA independiente sobre PostgreSQL efímero/owned. 5.8 queda `[x]`. Full integration **21 files / 401 tests (270 s)**; `typecheck` **0** repetido después de los tests de QA; `build` reutilizado del mismo source (0). Sin `.env`, `.env.azure`, Azure, PHI ni correos reales. Docker propios PG/Ryuk limpiados; `redkeep_db` ajeno intacto.

| Elemento | Resultado |
|---|---|
| Alcance | Login con JSON actual + cookie `clearsight_refresh`; refresh cookie-only single-use; logout `204`; guard de `Origin`; `AUTH_PUBLIC_ORIGIN`; reuso revoca la sesión/familia. |
| Proxy local | Un proxy HTTPS documentado (no productivo) termina TLS, expone el origen público y quita `/api`; el backend recibe `/auth/*`. El `Origin` se valida contra el valor exacto; no se deriva de `Host` ni `X-Forwarded-*`. |
| Cookie | Siempre `Secure`; `HttpOnly`; `SameSite=Lax`; host-only; `Path=/api/auth`; expiración ≤ 7 d. No se deshabilita `Secure` en producción ni como excepción silenciosa. `localhost` HTTP solo con configuración no productiva explícita y flujo HTTPS recomendado. |
| Test real | `tests/refresh-session.integration.test.ts` → **21 tests** (QA amplió la suite con casos de guard/cookie). No existen `auth-refresh.integration.test.ts` ni `auth-origin.integration.test.ts`; esos nombres fueron solo prospectivos. |
| DB/almacenamiento | PostgreSQL owned de Testcontainers; `refresh_tokens`/`user_sessions` existentes sin editar. Los triggers permiten revocación append-only desde `NULL`; no requieren migración nueva. |
| Stop | Si hay que deshabilitar `Secure`, usar wildcard de origen, leer `.env`/`.env.azure`, tocar Azure/PHI o existe conflicto con triggers, se detiene la fase. |

### Resultados HITO16 (QA final)

| Comando | Resultado |
|---|---|
| `npm --prefix backend run test:unit` | **25 files / 377 tests passed** (QA final) |
| `npm --prefix backend run test:integration` | **21 files / 401 tests passed (270 s)** |
| `tests/refresh-session.integration.test.ts` | **21 tests** (incluidos en el full; QA añadió casos) |
| `npm --prefix backend run typecheck` | exit `0`, repetido después de los tests de QA |
| `npm --prefix backend run build` | reutilizado del mismo source, exit `0` |

- **H1 (lectura estricta):** “sin body/Bearer” describe el mecanismo de autenticación de refresh, no una prohibición de coexistencia de headers. El request recomendado no envía body ni `Authorization`; si llegan, nunca se usan como credencial ni sustituyen la cookie, y su presencia sola no es error. Coincide con los tests de QA y no cambia el source.
- **H2 (hardening futuro):** reutilizar un token ya consumido puede escribir auditoría/locks en cada intento; D19 no exige un rate-limit adicional. Es un límite conocido de amplificación, no una regresión abierta; no se promete resuelto.
- **H3 (logging):** la redacción actual cubre `Cookie`, `Set-Cookie`, `Authorization` y campos de credenciales. Serializers custom futuros requieren revisión contra esa lista; no hay fuga actual.
- QA añadió casos a `refresh-session.integration.test.ts` (21 tests) y la aserción de cookie duplicada con el mismo valor en unit.
- Detalle: `docs/hito16-auth-refresh-runbook.md`.

## 1.15 Evidencia HITO17 - R1 persistencia y guard de cuotas de recuperación (2026-11-19)

> **Naturaleza:** evidencia de una tarea parcial. R1 implementa la migración incremental y el guard de cuotas; en su momento 5.9 seguía pendiente, pero R2 y QA final la cerraron en HITO17 (ver §1.16).

| Elemento | Evidencia |
|---|---|
| Migración | `backend/prisma/migrations/20261119020000_password_recovery_quotas/migration.sql`: `auth_recovery_buckets` con `PK(kind,key_hash)`, `kind IN ('FORGOT_EMAIL','FORGOT_IP','RESET_IP')`, hash lowercase 64 hex, contador acotado por kind, ventana e `updated_at >= window_started_at`. Sin editar migraciones históricas, `0_init` ni `docker/init.sql`; sin reutilizar `auth_login_buckets`. |
| Modelo | `AuthRecoveryBucket` en `backend/prisma/schema.prisma` mapeado a `auth_recovery_buckets`. |
| Guard | `backend/src/services/password-recovery-quota.ts`: DI de Prisma/schema/reloj, secreto HMAC con propósito `clearsight:auth-password-recovery:v1` distinto de login, cuotas fijas, transición pura y errores genéricos de store/input. No lockea usuarios, no hace KDF y no consulta cuentas. |
| Permisos | `clearsight_app` recibe solo `SELECT/INSERT/UPDATE`; `DELETE/TRUNCATE/TRIGGER/REFERENCES` revocados; el bloque falla cerrado ante rol ausente/inseguro, ownership o grant efectivo prohibido, incluido PUBLIC. |
| Tests unitarios | `backend/tests/unit/password-recovery-quota.test.ts`: vectores HMAC externos, normalización de email/IP, límites, boundary exacto, errores genéricos y rechazo barato sin store. |
| Tests integración | `backend/tests/password-recovery-quota.integration.test.ts`: límites/boundary, concurrencia, aislamiento IP/email/login, datos no crudos, constraints/replay/privilegios/PUBLIC en schema real, harness reset y allowlist. |
| Harness | `backend/tests/helpers/db.ts` y `backend/tests/unit/db-ownership.test.ts` incluyen `auth_recovery_buckets` en el `TRUNCATE`; `backend/vitest.integration.config.ts` y `backend/tests/unit/runner-isolation.test.ts` incluyen la nueva suite sin relajar guards. |
| Prisma | `npx prisma validate --schema prisma/schema.prisma` y `npx prisma generate --schema prisma/schema.prisma` con `DATABASE_URL` sintética; no se leyeron `.env` reales. |
| Unit focal | `npm --prefix backend run test:unit -- tests/unit/password-recovery-quota.test.ts` -> **1 file / 12 tests passed**. |
| Unit completo | `npm --prefix backend run test:unit` -> **26 files / 389 tests passed**. |
| Integración foco R1 | `npm --prefix backend run test:integration -- tests/password-recovery-quota.integration.test.ts` -> **1 file / 15 tests passed (11.45 s)**; PostgreSQL 16-alpine owned. |
| Estático | `npm --prefix backend run typecheck` -> exit 0; `npm --prefix backend run build` -> exit 0. |
| Docker/cleanup | Inventario posterior con labels `com.clearsight.test.owner=backend-integration` y `com.clearsight.test.run-id`: sin contenedores ni volúmenes propios residuales. |
| Límites | Evidencia pre-QA de R1: sin endpoints/token lifecycle en ese momento; R2 y full integration QA los cubrieron después (§1.16). Sin frontend, proxy, Azure, PHI, PDF ni correo real. |

## 1.16 Evidencia HITO17 - R2 endpoints y ciclo de vida de reset (2026-11-19)

> **Naturaleza:** R2 implementa endpoints y ciclo de token/email; **5.9 QA PASSED** en HITO17 con full integration **23 files / 444 tests**. B8 (proveedor/credenciales reales) sigue pendiente de provisioning y no bloquea el cierre.

| Elemento | Evidencia |
|---|---|
| Servicio | `backend/src/services/password-reset.ts`: forgot/reset públicos, cuotas R1 en orden IP→email y IP→lookup/KDF, token 32 bytes/base64url 43/SHA-256/30 min, último token bajo lock de usuario, reset con bcrypt cost 12, `tokenVersion + 1`, consumo del token, revocación de otros reset/sesiones/refresh y auditoría en la misma tx. |
| Entrega | `backend/src/services/password-reset-delivery.ts`: `DISABLED` por defecto y memory sink explícito de pruebas; post-commit; fallo de entrega responde 202, revoca condicionalmente solo el token exacto y registra código operativo sin email/token. |
| Rutas | `/auth/password/forgot` y `/auth/password/reset` públicas, sin cookie/sesión; `onRequest` no-store + Origin opcional igual a logout; JSON estricto; 202/204/400/401/403/429/503 genéricos. Path público previsto `/api/auth/password/*`; proxy no implementado. |
| Esquemas/DI | `passwordSchema` compartido alta/reset (12 code points/72 UTF-8), schemas estrictos, `AppDeps`/decoración/tipos Fastify, redacción `req.body.token/email/newPassword`. |
| Tests R2 | `tests/unit/password-reset.test.ts` y `tests/password-reset.integration.test.ts`: noenum, último token, reset concurrente, reset+forgot, reset+refresh, admin deactivation race, 401 variantes, expiry exacto, HU01 preservado, cuotas 20/900 y forgot email/IP, disabled, sink failure/compensación exacta, audit rollback, store failure, JWT/refresh previos inválidos y DB final. |
| Unit focal R2 | `tests/unit/password-reset.test.ts` -> **7 tests** (el 8 previo incluía `log-redaction`). |
| Unit focal R1+R2 | `tests/unit/password-recovery-quota.test.ts tests/unit/password-reset.test.ts` -> **19 tests**. |
| Integration R2 | QA final, `tests/password-reset.integration.test.ts` -> **28 tests**; incluye 6 QA nuevos: default disabled, IP exhaust, 503 uniforme, carreras, no auth substitute y 400 sin consumo de cuota. |
| Foco combinado pre-QA | R2+R1+refresh+login-protection+lifecycle -> **5 files / 117 tests** (histórico pre-QA; no rerun de maker). |
| Full integration QA | **23 files / 444 tests** (401 baseline + 15 R1 + 22 R2 + 6 QA). |
| Unit completo | **27 files / 396 tests**. |
| Estático | `typecheck` 0 después de los tests QA; `build` reutilizado del mismo source maker 0. |
| Docker/cleanup | Contenedores/volúmenes propios sin residuos; recursos ajenos intactos. |
| Límites | 5.9 cerrada; B8 provider/credenciales reales pendiente de provisioning sin bloquear cierre. Sin frontend, proxy, Azure, `.env` reales, correo real, PHI ni PDF. Detalle: `docs/hito17-password-recovery-runbook.md`. |

## 1.17 Evidencia HITO18 - snapshot clínico 2.1 (QA PASSED)

> **Naturaleza:** QA focal sobre PostgreSQL owned y runner unitario aislado. 2.1 queda `[x]`. Sin full integration nueva; cierre solo documental, sin source/test edits ni reruns.

| Elemento | Evidencia |
|---|---|
| Alcance | Schema de snapshot en `backend/src/schemas/clinical.ts`, repositorio `backend/src/repositories/clinical-snapshot.repo.ts` y `repos.snapshots` en `backend/src/repositories/index.ts`. Sin 2.2, auth, worker, endpoints ni migración/schema. |
| Validación | `create` valida estructura y JSON anidado de datos planos tipados antes de DB, sin normalizar/coercionar. Raw y normalized independientes; `schemaVersion` explícito/nonblank/<=128; `modelVersions` JSON anidado con `{}` = no resuelto. |
| Schemas focal | `npm --prefix backend run test:unit -- tests/schemas.test.ts` -> **25 tests** (2 QA nuevos). |
| Repositorio focal | `npm --prefix backend run test:integration -- tests/repositories.test.ts` -> **22 tests**; 4 asserts reforzadas para esperar `ZodError`. Cubre roundtrip, mutación de input/consulta, TX rollback, UUID inválido, app role y `resetDb` cascade. |
| Migraciones snapshot | `npm --prefix backend run test:integration -- tests/migrations.test.ts` -> **25 tests**. |
| Unit completo | `npm --prefix backend run test:unit` -> **27 files / 405 tests**. |
| Estático | `typecheck` **0** después de los tests QA; `build` **0** reutilizado del mismo source. |
| Docker/cleanup | Cero contenedores/volúmenes propios residuales; `redkeep_db` ajeno intacto. |
| Límites | Datos JSON planos tipados; profundidad patológica y getters de objetos JS (no HTTP) no cubiertos aún como hardening; no se promete protección universal ni nuevas fuentes/versiones. Sin full integration nueva. 2.2, Azure/provider y email real siguen pendientes. Detalle: `docs/hito18-clinical-snapshot-runbook.md`. |

## 2. Fase 0 — Entorno, versiones y smoke mínimo

**Objetivo:** confirmar toolchain y contexto sin importar código pesado, sin levantar servicios y sin leer secretos.

**Precondiciones:** repo en la rama esperada; shell local; no se requiere Docker para los comandos de versión.

**Comandos CURRENT:**

```powershell
git status --porcelain=v1 -b
node --version
npm --version
python --version
docker --version
az version
openspec status --change consolidate-backend-ml-azure
```

**Notas verificadas del repo:**

- `az` está instalado; el arquitecto reportó Azure CLI 2.91.0 y un contexto default `Enabled`/`AzureCloud` leído en modo read-only. Eso es solo un prerequisito: no autoriza gasto ni despliegue.
- No se pide login ni se elige suscripción de nuevo de forma genérica; si el contexto no está activo, se detiene y se reporta.
- No se ejecutan imports de modelos, `npm test`, `docker compose up` ni scripts E2E en esta fase.

**Stop:** si falta una herramienta, si el contexto Azure no es el esperado o si algún comando imprime credenciales/IDs sensibles.

**Criterio de salida:** versiones registradas y estado del repo conocido; sin servicios iniciados y sin secretos en la salida.

## 3. Fase 1 — Documentación y specs estáticas

**Objetivo:** validar que el change documental es coherente, sin ejecutar código productivo.

**Precondiciones:** fase 0 completada.

**Comandos CURRENT:**

```powershell
openspec validate consolidate-backend-ml-azure --strict
openspec status --change consolidate-backend-ml-azure
git diff --check
git diff --stat
```

**Criterio de salida:** validación estricta sin errores, sin whitespace errors y con un diff limitado a documentación. Si falla, se corrige la documentación y se repite; no se avanza a fases con servicios.

## 4. Fase 2 — Unidad y contratos focalizados

**Objetivo:** probar contratos puros (schemas, normalización, manifiesto, servicio ML con stubs) sin tocar cloud real.

**Precondiciones:** fase 1 verde. El runner unitario no requiere DB ni Docker; la integración real se trata en la fase 3.

### 4.1 Runner unitario aislado (verificado)

- `backend/package.json`: `test`/`test:unit` usan `vitest.unit.config.ts`; `test:watch` también; `test:integration` usa `vitest.integration.config.ts`.
- `backend/vitest.unit.config.ts` define una allowlist explícita y **no** declara `globalSetup`; `tests/unit/network-guard.ts` bloquea TCP directo, `fetch`, `http.request` y `https.get`.
- `backend/vitest.config.ts` reexporta la config unitaria, por lo que `npx vitest` sin `--config` sigue siendo seguro.
- Un filtro CLI solo reduce la allowlist: `npm run test:unit -- tests/repositories.test.ts` termina con «No test files found» (exit 1) sin cargar setup ni DB.

### 4.2 Comandos CURRENT (verificados)

```powershell
npm --prefix backend run test:unit
npm --prefix backend run test
npm --prefix backend run test:unit -- tests/schemas.test.ts
npm --prefix backend run test:unit -- tests/sanitizer.test.ts
npm --prefix backend run typecheck
```

Resultado observado: `test:unit`/`test` → **6 files / 57 tests passed**; schemas → **16 passed**; sanitizer → **1 passed**; typecheck → **exit 0** (tras `prisma generate` con config temporal sin dotenv).

### 4.3 Integración explícita (no ejecutada aquí)

```powershell
# Requiere un daemon Docker local; conserva los 8 archivos de integración/mocks locales.
npm --prefix backend run test:integration
```

- `backend/vitest.integration.config.ts` es la única config con `globalSetup`; el setup crea un contenedor efímero, rechaza `TEST_DATABASE_URL` antes de crear cliente/contenedor y verifica el marker `test_meta`.
- En el HITO 2 no se ejecutó porque el daemon Docker local no estaba disponible; la ejecución real posterior se registra en §1.4 (HITO 3). No se declara integración real verde en el HITO 2.
- La cobertura de negocio/seguridad/DB sigue siendo responsabilidad de la integración/E2E; el runner unitario no la sustituye.

> **Nota de vigencia:** este apartado conserva el estado del HITO 2. La ejecución real posterior se registra en §1.4 (HITO 3).

**Stop:** si el comando intenta conectarse a una DB no aislada, si el contenedor no puede crearse o si aparece un error preexistente no registrado.

### 4.4 Fase específica 5.9 — R1+R2 (CURRENT; QA PASSED)

**Objetivo:** verificar el contrato D20 de recuperación de contraseña. R1 (persistencia/guard) y R2 (endpoints/token/entrega) están implementados y **5.9 QA PASSED** según §1.16. B8 proveedor real sigue pendiente sin bloquear el cierre.

**Precondiciones:**

- Fase 1 verde y contrato D20/§3.1.2/spec de identidad revisados.
- R1/R2 CURRENT: `backend/tests/unit/password-recovery-quota.test.ts`, `backend/tests/password-recovery-quota.integration.test.ts`, `backend/tests/unit/password-reset.test.ts` y `backend/tests/password-reset.integration.test.ts` existen y están en la allowlist.
- Docker local y PostgreSQL owned de Testcontainers; `TEST_DATABASE_URL` ausente; sin `.env.azure`, Azure, correos reales ni DB externa/producción.
- Memory sink inyectado solo por DI de pruebas; `DISABLED` por defecto; ningún envío real ni proveedor configurado.

**Comandos R1+R2 CURRENT (focalizados; ver §1.15/§1.16):**

```powershell
npm --prefix backend run test:unit -- tests/unit/password-recovery-quota.test.ts
npm --prefix backend run test:unit -- tests/unit/password-reset.test.ts
npm --prefix backend run test:integration -- tests/password-recovery-quota.integration.test.ts
npm --prefix backend run test:integration -- tests/password-reset.integration.test.ts
```

**QA final HITO17 (evidencia reportada por QA; sin rerun de maker):**

- Unit total `27 files / 396 tests`.
- Full integration `23 files / 444 tests` (401 baseline + 15 R1 + 22 R2 + 6 QA).
- Foco R2 `28 tests`; typecheck `0` después de QA; build reutilizado del mismo source maker `0`.
- Docker propio limpio; ajeno intacto.

**Casos mínimos verificables:**

1. `forgot` con email conocido, desconocido e inactivo devuelve el mismo `202 {accepted:true}` sin token/usuario/estado; body inválido `400` sin cuota.
2. Cuotas `forgot` 3/3600 s por email y 20/3600 s por IP: orden IP→email, consumo de IP aunque email esté agotado, `429` con `Retry-After >= 1` y sin efecto en login/HU01.
3. Cuota `reset` 20/900 s por IP antes del lookup/bcrypt; token inválido también consume; fallo del store de cuotas `503` para cualquiera.
4. `DISABLED`: `202` sin crear token ni revocar anteriores. Sink de pruebas: token 32 bytes/43 chars, hash SHA-256 en DB, 30 min, revocación de anteriores y auditoría antes de entregar; fallo de auditoría revierte y no entrega; fallo de entrega `202` y revocación condicional del token exacto.
5. Dos `forgot` concurrentes del mismo usuario: solo el último token comprometido queda válido; la entrega fuera de orden no revive tokens anteriores.
6. `reset` exitoso: `204` sin sesión/cookie, bcrypt cost 12, `tokenVersion + 1` una vez, consume el token usado y revoca otros reset/sesiones/refresh en la tx auditada; `failedLoginCount`/`lockedUntil` no cambian.
7. `reset` inválido/expirado/usado/revocado/inactivo: `401` genérico sin reactivar; fallo de store/auditoría/hash: `503` con rollback sin consumo.
8. Transporte y fugas: sin lectura/emisión de cookies, `Authorization` no sustituye al token, `Origin` opcional con política de logout, `Cache-Control: no-store` también en errores, y ningún token/email en logs, JSON, cabeceras, URLs o artefactos de prueba.

**Stop:** si un test necesita un proveedor real, lee `.env.azure`, usa una DB compartida/producción, imprime token/email crudos o no puede aislar PostgreSQL/recursos. Un `429` no se reintenta en bucle; se respeta `Retry-After`.

**Criterio de salida:** unit/integration/typecheck/build en verde sobre el mismo source, recursos Docker propios limpios y ningún secreto/dato personal en la salida. R1/R2 tienen código y pruebas reales; 5.9 QA PASSED con full integration 23/444.

## 5. Fase 3 — PostgreSQL, Redis y MinIO efímeros con ownership marker

**Objetivo:** probar integración local de DB/cola/storage sin tocar recursos ajenos.

**Precondiciones:**

- Fase 2 verde en los contratos que no requieren DB.
- Run ID generado por el setup del run; no se adopta una DB externa.
- `TEST_DATABASE_URL` debe estar ausente: si la variable existe (aunque esté vacía), el setup falla antes de crear cliente/contenedor.
- Docker local disponible; puertos libres o configuración aislada.
- Compose test-only verificado con puertos, red y volúmenes aislados, o Testcontainers con ownership explícito; el compose raíz no se usa.
- No se usa `.env.azure`.

**Estado local (2026-11-18):** **EJECUTADA para PostgreSQL** con `test:integration` (ver §1.4, HITO 3): 8 archivos / 62 tests, contenedor `16-alpine` de Testcontainers con marker y cleanup etiquetado verificado. Redis y MinIO no se levantaron; los guards de rechazo/cleanup también se verificaron con mocks en el runner unitario (`tests/unit/integration-setup.test.ts`). El compose raíz sigue **NO LISTO** por las razones de aislamiento siguientes.

**Aislamiento del proyecto compose (verificado en `docker-compose.yml`):**

- `name: clearsight` (línea 1) fija el nombre base del proyecto; `docker compose` sin `-p` puede reutilizar el proyecto de desarrollo.
- Los volúmenes nombrados `postgres-data`, `redis-data`, `minio-data`, etc. (líneas 189-195) no llevan labels de run/ownership por defecto.
- La red `clearsight` es `external: true` (líneas 197-200) y puede ser compartida; **no se borra jamás** desde el run.
- Por eso la receta CURRENT con el compose raíz **NO está lista para ejecución segura** si no se pueden aislar puertos, red y volúmenes sin cambios de fuente. No se usa `docker compose up` literal. La vía preferida es Testcontainers con ownership explícito, ya implementada en `test:integration`; PostgreSQL se ejecutó realmente con esa vía en el HITO 3, mientras que Redis/MinIO y el compose raíz siguen **NO EJECUTADOS**.

**Comandos CURRENT ilustrativos (placeholders, NO ejecutar literal):**

```powershell
# <proyecto-efimero-unico> NO es suficiente por sí solo.
docker compose -p <proyecto-efimero-unico> config --quiet
docker compose -p <proyecto-efimero-unico> config --services
docker compose -p <proyecto-efimero-unico> ps
```

`config --quiet` y `config --services` validan el merge efectivo sin imprimir valores de entorno. **No ejecutar `docker compose config` completo**, porque puede volcar secretos.

**Si y solo si** existe un compose test-only verificado con puertos, red y volúmenes aislados y labels de ownership:

```powershell
# FUTURO: condicionado a un compose test-only verificado, no al compose raíz.
docker compose -p <proyecto-efimero-unico> -f <compose-test-only-verificado.yml> up -d postgres redis minio
docker compose -p <proyecto-efimero-unico> -f <compose-test-only-verificado.yml> ps
```

- Antes de `up`, comprobar colisiones de puertos; si hay colisión, **abortar**, no reutilizar ni reasignar el puerto de otro servicio.
- Verificar que la red no sea la `clearsight` externa compartida; si lo es, no borrar la red ni tocar recursos fuera del manifest.
- Verificar labels `project`/`run`/ownership en volúmenes y recursos; el nombre único del proyecto **no** es garantía suficiente.

**Preferencia segura:** Testcontainers con ownership explícito para tests backend, ya implementado en `test:integration`, en lugar de levantar el compose raíz. No se creó infraestructura real en este hito.

**Regla de ownership (obligatoria):**

- Antes de truncar/borrar, el runner comprueba el marcador de ownership y el target permitido. **No se permite `DROP`/`TRUNCATE` solo porque el nombre contenga `test`.**
- El `global-setup` actual crea un contenedor nuevo con nombre único y label `com.clearsight.test.run-id`, y escribe el marker `test_meta`; no hay branch de adopción externa.
- `resetDb` verifica que el marker coincida con el run ID inyectado antes de truncar. `TEST_DATABASE_URL` se rechaza antes de crear cliente/contenedor.

**Tests de integración que usan esta fase (config explícita):**

```powershell
# Requiere Docker/Testcontainers; no ejecutar sin daemon local y sin TEST_DATABASE_URL.
npm --prefix backend run test:integration -- tests/migrations.test.ts
npm --prefix backend run test:integration -- tests/repositories.test.ts
npm --prefix backend run test:integration -- tests/rbac.test.ts
```

**Cleanup (solo con ownership verificado):**

```powershell
# Nunca -v por defecto. Primero verificar que el proyecto y los volúmenes tienen labels del run
# y que no son de desarrollo. Si no se puede demostrar, no borrar nada.
docker compose -p <proyecto-efimero-unico> -f <compose-test-only-verificado.yml> down
```

- **No usar `-v`** sin comprobar labels `project`/`run`/ownership y el manifest del run.
- No borrar la red externa `clearsight` ni recursos fuera del manifest.
- Si el cleanup no puede demostrar ownership, se reporta `pending` y no se declara destruido.

**Stop:** si el marker no coincide, si el target no está allowlisted, si hay colisión de puertos, si se reutiliza el compose raíz o la red externa compartida, si faltan labels de ownership, si el stack reutiliza volúmenes de desarrollo o si el cleanup afectaría datos ajenos.

## 6. Fase 4 — Stub ML y fault injection

**Objetivo:** cubrir fallos del contrato sin ML real ni Azure real.

**Casos mínimos:**

- clave duplicada / idempotencia concurrente;
- pérdida del `202` y reintento con la misma key;
- `REVIEW_REQUIRED` sin auto-complete ni conversión manual;
- artefacto faltante (`mask`/`overlay`/PDF);
- token/credencial revocada;
- Azure Blob stub (sin Azure real);
- host no allowlisted, URL expirada, payload inválido, etiqueta desconocida.

**Comandos CURRENT (baseline, no cubren todos los casos nuevos):**

```powershell
python -m pytest ml/tests/test_service.py -q
python -m pytest ml/tests/test_azure_readiness.py -q
```

**FUTURO:** tests backend/ML nuevos para los casos anteriores. Hasta que existan, se etiquetan como `FUTURO` y no se declaran ejecutados. Cualquier comando backend que use DB sigue el guard de la fase 3.

**Stop:** si un test requiere Azure real, si inyecta datos clínicos reales o si el fallo se enmascara con un mock que no reproduce el contrato.

## 7. Fase 5 — ML local real con pesos y golden tolerances

**Objetivo:** verificar readiness y estabilidad numérica con pesos locales, sin cloud.

**Precondiciones verificadas en el repo:**

- `ml/models/manifest.json` existe (versión, clases canónicas, 11 features, umbrales, ensemble).
- `models_cache/` contiene pesos/ONNX locales: `efficientnet_b3.fp16.onnx`, `resnet50.fp16.onnx`, checkpoints `.pth` y segmentación `.h5`.
- No se versionan pesos ni rutas personales; no se imprimen rutas con datos sensibles.

**Comandos CURRENT:**

```powershell
python -m pytest ml/tests/test_manifest.py -q
python -m pytest ml/tests/test_cdr.py -q
python -m pytest ml/tests/test_ensemble.py -q
python -m pytest ml/tests/test_onnx_serving.py -q
```

**Golden tolerances (FUTURO):** comparar probabilidades de clase, CDR y artefactos contra fixtures dorados con tolerancias declaradas. Si falta un peso o un fixture, la fase se detiene; no se sustituye por una salida inventada.

**Stop:** pesos ausentes/corruptos, diferencias fuera de tolerancia no explicadas, o intento de usar Azure real.

## 8. Fase 6 — E2E Azure completo y cleanup

**Objetivo:** validar el flujo backend Blob → ML → persistencia → PDF → descarga → feedback/export, con negative-auth y cleanup final.

**Precondiciones bloqueantes (B6 parcial, no deployment ready):**

- presupuesto numérico, duración y scope del run confirmados;
- contexto default correcto confirmado **justo antes** de crear;
- permisos/quota verificados con dry-run o lecturas;
- manifest de recursos y cleanup en `finally` con verificación de residuos;
- sin `.env.azure`, sin IDs/nombres de suscripción en docs o logs;
- datos sintéticos o dataset autorizado (por ejemplo PAPILA); nunca PHI real sin governance.

**Estado actual verificado:**

- El contexto CLI read-only está satisfecho; **no** prueba capa gratuita, cuotas, RBAC de creación ni permiso de gasto.
- `scripts/test_azure_e2e.py` existe, pero cubre el **servicio ML** (health, submit, polling, CDR/probabilidades), no el flujo backend completo. Se etiqueta como **CURRENT PARCIAL**, no como E2E completo.
- No existe un script de E2E completo ni un script `e2e` en `package.json`. **No usar `npm run e2e`** (no existe).

**Comando CURRENT parcial (solo si hay un ML service autorizado):**

```powershell
python scripts/test_azure_e2e.py --base-url <endpoint-autorizado>
```

**FUTURO (no disponible):** script de E2E completo backend/Blob/ML/DB/PDF/descarga/feedback/export, con negative-auth y cleanup verificado. Se etiqueta `FUTURO` hasta que exista y esté revisado.

**Stop:** cualquier recurso creado sin tag/manifest, falta de cleanup, secreto en salida, target no confirmado o intento de reutilizar recursos ajenos.

## 9. Benchmarks separados (p95 full-flow, concurrencia)

**Objetivo:** medir RNF sin declarar cumplimiento anticipado.

**Estado actual:**

- `scripts/benchmark_latency.py` existe, pero mide **forward** de clasificadores (PyTorch vs ONNX) con un checkpoint; no mide el flujo completo carga→resultado.
- No se usa como evidencia del p95 del SRS ni de concurrencia.

**FUTURO:**

- benchmark de p95 **full-flow** (carga→resultado) con volumen y entorno declarados;
- 50 solicitudes concurrentes;
- PDF HU08 (≤15 s) con plantilla/numeración;
- cobertura, AUC y disponibilidad con metodología explícita.

**Regla:** reportar valores observados, entorno y límites; no afirmar cumplimiento sin evidencia.

## 10. Inventario de comandos: CURRENT vs FUTURO

| Comando | Estado | Seguridad |
|---|---|---|
| `node --version`, `npm --version`, `python --version`, `docker --version`, `az version` | CURRENT | Seguro, read-only. |
| `openspec validate consolidate-backend-ml-azure --strict` | CURRENT | Seguro, documental. |
| `npm --prefix backend run typecheck` | CURRENT | Estático, sin DB. |
| `npm --prefix backend run test` / `test:unit` | CURRENT | Runner unitario aislado: allowlist pura, sin `globalSetup`/DB/red. |
| `npm --prefix backend run test:unit -- tests/schemas.test.ts` | CURRENT | Seguro; un filtro solo reduce la allowlist. |
| `npm --prefix backend run test:watch` | CURRENT | Watch del runner unitario; sin DB. |
| `npm --prefix backend run test:integration` | CURRENT (ejecutado en HITO 3) | Requiere Docker; crea un PostgreSQL efímero Testcontainers con ownership, rechaza `TEST_DATABASE_URL` y su cleanup solo se verifica sobre recursos etiquetados. |
| `TEST_DATABASE_URL=... test:integration` | **RECHAZADO** | Cualquier presencia de la variable aborta antes de cliente/contenedor. |
| `python -m pytest ml/tests/test_service.py -q` | CURRENT | Stubs, sin cloud real. |
| `python -m pytest ml/tests/test_onnx_serving.py -q` | CURRENT | Requiere pesos locales. |
| `docker compose -p <proyecto> config --quiet` / `config --services` | CURRENT | Valida merge efectivo sin imprimir secretos. |
| `docker compose -p <proyecto> up ...` sobre el compose raíz | **NO LISTO** | `name: clearsight`, volúmenes sin labels y red externa compartida; no ejecutar literal. |
| Testcontainers con ownership explícito | CURRENT (ejecutado en HITO 3) | Usado por `test:integration`: PostgreSQL `16-alpine`, 8 files / 62 tests; el compose raíz no se usó. |
| `scripts/e2e-backend.ps1` | CURRENT | E2E local parcial; requiere stack/seed; no usar contra producción. |
| `scripts/test_azure_e2e.py` | CURRENT PARCIAL | Solo ML service; no flujo backend completo. |
| `scripts/benchmark_latency.py` | CURRENT | Solo forward; no p95 full-flow. |
| `npm run e2e` | **NO EXISTE** | No usar ni documentar como disponible. |
| `backend/vitest.unit.config.ts` + `test:unit` | CURRENT | Runner puro sin `globalSetup`; verificado 6 files / 57 tests. |
| Guard de ownership marker | CURRENT | `test_meta` + label de run; verificado con mocks. |
| `tests/refresh-session.integration.test.ts` | CURRENT (5.8, QA PASSED) | 21 tests; cubre login cookie, rotación/reuso, guard de Origin y logout. PostgreSQL owned de Testcontainers. |
| `npm --prefix backend run test:unit -- tests/unit/password-recovery-quota.test.ts` | CURRENT (R1, HITO17) | 12 tests; HMAC externo, límites, boundary y validación barata. |
| `npm --prefix backend run test:integration -- tests/password-recovery-quota.integration.test.ts` | CURRENT (R1, HITO17) | 15 tests; PostgreSQL owned, constraints/replay/privilegios/concurrencia/aislamiento. |
| `npm --prefix backend run test:unit -- tests/unit/password-reset.test.ts` | CURRENT (R2, HITO17) | 7 tests; token, política compartida y puertos de entrega. |
| `npm --prefix backend run test:unit -- tests/unit/password-recovery-quota.test.ts tests/unit/password-reset.test.ts` | CURRENT (R1+R2, HITO17 QA) | 19 tests. |
| `npm --prefix backend run test:integration -- tests/password-reset.integration.test.ts` | CURRENT (R2, HITO17 QA PASSED) | 28 tests; 6 QA: default disabled, IP exhaust, 503 uniforme, carreras, no auth substitute, 400 sin cuota; más revocaciones/expiry/audit rollback/compensación. |
| Foco R2+R1+refresh+login-protection+lifecycle | HISTÓRICO PRE-QA | 5 files / 117 tests; no rerun de maker. |
| Full integration QA HITO17 | QA PASSED | 23 files / 444 tests (401 baseline + 15 R1 + 22 R2 + 6 QA). |
| E2E Azure completo | FUTURO | Requiere B6 confirmado y cleanup. |
| Benchmark p95 full-flow | FUTURO | Requiere script y entorno aprobado. |

## 11. Disciplina de entrega por fase

1. **Autoverificación:** ejecutar primero los comandos focalizados de la fase y los checks del brief; ampliar solo si el riesgo lo exige.
2. **Fallo = stop:** si un test falla, no se hace commit de esa fase; se corrige o se reporta bloqueo con comando y error exactos.
3. **Baseline:** los errores preexistentes se registran como baseline; no se presentan como éxito ni se “arreglan” fuera del alcance.
4. **QA independiente:** las tareas de alto riesgo (migraciones, auth/sesiones, storage dual, PDF, Azure) requieren revisión independiente además de la autoverificación.
5. **Commit/push:** la autorización global del usuario para commits/push ya está dada; no se pide de nuevo por fase. Este runbook no commitea por sí mismo; el orquestador/commit posterior se hará cuando corresponda. Solo se commitea documentación/pruebas verificadas de una tarea coherente; tests fuente futuros por hito.
6. **Sin atajos:** no se usa un mock para declarar un E2E real, no se usa el nombre `test` como guard y no se lee `.env.azure`.
