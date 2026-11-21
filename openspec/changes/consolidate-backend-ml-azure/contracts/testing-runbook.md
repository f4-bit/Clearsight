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
| 2 | Unidad/contratos focalizados | No (runner unitario) | Medio | CURRENT: runner unitario aislado; HITO19 2.2 A CURRENT, B/C FUTURO (§4.5); HITO20 3.2 QA PASSED (§4.6); HITO21 3.3 QA PASSED (§4.7); HITO22 3.4/3.8 CURRENT QA PASSED (§4.8); HITO23 3.7 QA PASSED (§4.9); HITO24 4.1(A)+4.2(B)+4.3(C) QA PASSED (§1.29/§1.30/§1.31/§1.32/§1.33/§4.10); HITO25 4.4/4.5 QA PASSED (§1.35/§4.11); HITO26 4.6-4.8 QA PASSED (§1.36/§1.37/§4.12) |
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

## 1.18 Registro HITO19 - preparación documental 2.2 (sin ejecución)

> **Naturaleza:** solo documentación. No se implementó código, no se ejecutaron tests, no se creó un change nuevo y 2.2 **NO** está cerrada. `openspec validate` no se ejecutó en este turno porque la regla de permisos del entorno deniega el CLI; se sustituye por revisión estructural y `git diff --check`.

| Elemento | Evidencia |
|---|---|
| Documentos | `design.md` D21/ADR-041..046 y riesgos; specs `clinical-case-execution` e `inference-orchestration`; `contracts/frontend-api-contract.md`; `tasks.md` 2.2 A/B/C; este runbook §4.5. |
| Código/tests | Ninguno. No se cargaron ni descargaron modelos; no se tocó DB, Redis, MinIO, Azure, frontend ni SRS. |
| Estado | 2.2 estaba abierta en ese turno; se cerró en §1.22 (A/B/C eran FUTURO; A/B/C se implementaron después, ver §1.19/§1.20/§1.21). REG-002/003/004 no se declaran resueltos; 2.4 parcial; 4.2/4.3/4.4/4.6/2.3/2.5/6.x pendientes. |
| Comandos | No ejecutados en ese turno documental; A/B se ejecutan y registran en §1.19/§1.20. |
| Límites | Sin QA, sin evidencia de implementación ni de verde. `docs/` no recibe un runbook nuevo de hito; el registro vive aquí. |

## 1.19 Evidencia HITO19 - tarea A ML context/prepare/pin (B en §1.20; C en §1.21)

> **Naturaleza:** tarea A implementada y verificada; B se implementó después (§1.20) y C se registró en §1.21; 2.2 se cerró en §1.22. Sin commit, sin Azure/frontend/DB/PHI, sin descarga de modelos ni TF/GPU.

| Elemento | Evidencia |
|---|---|
| Código A | `ml/service/context.py` (descriptor inmutable, parámetros efectivos/fuentes, hashes reales, canonical JSON, fingerprint, prepare y verificación de pin; `normalizedPayload` incluye `descriptor` íntegro, `canonicalJson` exacto y `contextFingerprintSha256`), `ml/service/schemas.py` (`expected_context`, prepare request/response, floats finitos), `ml/service/main.py` (`POST /v1/clinical-snapshots/prepare`, 422/503, rechazo temprano de pin), `ml/inference/{classification,onnx_serving}.py` (resolver compartido), `pipeline.py` (verificación antes de descarga y antes del clasificador), `localization.py` (CLAHE desde el manifiesto copiado). |
| Test focal A | `python -m pytest ml/tests/test_clinical_context.py -q` -> **30 passed**. |
| Relacionados | `python -m pytest ml/tests/test_clinical_normalization.py ml/tests/test_service.py ml/tests/test_localization.py ml/tests/test_onnx_serving.py -q` -> **12 passed**; `python -m pytest ml/tests/test_azure_readiness.py -q` -> **4 passed**. |
| Estático | `python -m ruff check ...` -> **All checks passed**; `python -m mypy ...` -> **Success: no issues found in 7 source files**. |
| Contexto real | `OnnxClassificationRunner` con `models_cache` locales + `build_runtime_context`: fingerprint `feec85f9...` (64 hex), backend `onnx`, hashes reales de segmentación/ONNX y `mean/std` source `manifest`; sin descarga, TF ni GPU. |
| Límites | B se registra en §1.20 y C en §1.21. 2.2 se cerró en §1.22. No se tocó `defects/regressions.md` ni se declararon REG-002/003/004 resueltos. |

## 1.20 Evidencia HITO19 - tarea B creación backend (C en §1.21)

> **Naturaleza:** B implementada y verificada sobre PostgreSQL owned de Testcontainers. C se implementa después (§1.21). Sin commit, sin Azure/frontend/PHI/modelos reales.

| Elemento | Evidencia |
|---|---|
| Servicio | `backend/src/services/inference-creation.ts`: ownership/ojo/parent antes de prepare; prepare 15 s; revalidación de principal después del upstream; lock de usuario/sesión, parent inference, parent image y child image en el orden del trigger; snapshot+inference en una TX; sin query externa dentro de TX; sin mutar consulta/required set. |
| Wire | `backend/src/schemas/clinical-context.ts`: DTO estricto, `rawCanonical` exacto, 11 nombres/valores finitos, descriptor con parámetros/checksums/preprocessing, hash SHA-256 exacto sobre `canonicalJson`, descriptor sin paths/tokens, `modelVersions` 5 claves. `MlClient` con URL/token inyectados y errores safe. |
| Repos/rutas | `backend/src/routes/inferences.ts` usa el servicio; `backend/src/repositories/inference.repo.ts` persiste `consultationId/eyeSide/snapshotId/reanalysisOfId/status/modelVersion`; `backend/src/app.ts` inyecta `mlClient`, `authService`, schema y `AppDeps` ML opcional; `inference.queue.ts` solo añade `expectedContext` (C se registra en §1.21). |
| Unit focal B | `tests/unit/clinical-context.test.ts` + `tests/unit/ml-client.test.ts` -> **13 passed**. Unit completo -> **29 files / 418 tests passed**. |
| Integración B+ACL | `tests/inference-creation.integration.test.ts` -> **11 passed**; foco B+ACL+repos+rbac -> **4 files / 61 tests passed** (PostgreSQL owned). |
| Cobertura B | snapshot exacto+descriptor+hash, consulta mutable ignorada, timeout/JSON inválido, 422 unknown model, 404/503 old ML, padre ajeno/ausente 404, consulta/ojo 422, legacy+new image, consulta congelada intacta, fallo storage/cola post-commit con fila `QUEUED`, concurrencia sin deadlock y rollback real forzado. |
| Estático | `npm --prefix backend run typecheck` -> exit 0; `npm --prefix backend run build` -> exit 0. |
| Límites | C registrado en §1.21. 2.2 se cerró en §1.22 con QA PASSED/H1 PASSED; baseline pre-H1 reutilizado. |

## 1.21 Evidencia HITO19 - tarea C worker compatibility (QA PASSED; H1 PASSED)

> **Naturaleza:** C implementada y verificada con processor DI/unit y Prisma real. Sin commit, sin Redis real, sin modelos, sin Azure/frontend/PHI.

| Elemento | Evidencia |
|---|---|
| Processor | `backend/src/workers/inference.processor.ts`: DI db/ML/sleep/clock; valida imagen/ojo/raw/pin/modelo contra snapshot DB antes de ML; usa clinicalFeatures del snapshot; polling 60×2 s; terminales COMPLETED/REVIEW_REQUIRED/FAILED; CAS terminal; REVIEW parcial sin throw/retry; COMPLETED inválido/unknown label/NaN/IDs/eye/versions ⇒ FAILED sin resultado; timeout safe failure; sin mutar consulta/required set; sin publicar artifacts/PDF. |
| Wiring | `inference.worker.ts`: `startInferenceWorker()` no-arg, Redis creado solo dentro del boot, concurrency 4, logs solo IDs/nombres de error. `inference.contracts.ts` puro; `inference.queue.ts` reexporta tipos y no se importa desde processor. `inference-run.repo.ts` con `updateMany` CAS contra terminal. `MlClient` parsea wire estricto de submit/getJobStatus. |
| Unit focal C | `tests/unit/inference.processor.test.ts` + `inference.worker.test.ts` + `ml-client.test.ts` -> **20 passed**. Unit completo -> **31 files / 433 tests passed**. |
| Integración C | `tests/inference-worker.integration.test.ts` -> **4 passed** (COMPLETED real, duplicate terminal, race 2 workers, frozen/snapshot inmutable); foco C+B+ACL+repos+rbac -> **5 files / 65 tests passed**. |
| Estático | `npm --prefix backend run typecheck` -> exit 0; `npm --prefix backend run build` -> exit 0. |
| Límites | 2.2 QA PASSED y H1 PASSED. 4.6/4.7/4.4/4.9 siguen pendientes: no se promete outbox, recuperación durable de job ML ni idempotencia global. `defects/regressions.md` intacto; REG-002/003/004 no declarados resueltos. |

## 1.22 Cierre HITO19 / 2.2 - QA PASSED, H1 PASSED

> **Lectura de cifras:** el baseline global QA es **pre-H1**: unit **31/437** y full integration **25/469**, reutilizado porque las ramas afectadas no cambiaron. ML baseline relacionado **44** (incluye ONNX/localization) pasó antes de H1 con source no afectado. H1 se validó con foco postfix; **no** se ejecutó un full 469 nuevo ni se suman las cifras como “full final”.

| Aceptación | Implementación | Tests/evidencia |
|---|---|---|
| `1e300` finito float64 ⇒ 422; `mean/std` fuera de float32 ⇒ 503 | `ml/service/context.py`, `ml/service/main.py`, `inference-creation.ts` | ML context **37**; H1 añadió **5 tests ML**; B integration **1** |
| Creación/reanálisis/snapshot/pin/estados | `inference-creation.ts`, schemas, repos, rutas | creación **13**; ACL **17** |
| Worker terminal/CAS/sin autocompletado | `inference.processor.ts`, `inference-run.repo.ts`, `inference.worker.ts` | C unit **20**; C integration **4**; baseline 25/469 |
| Legacy/pin/contexto/version drift | processor | unit C + integración C |
| Backend wire estricto | `ml-client.ts` + schemas | backend unit **15** (clinical-context/ml-client) |
| Cierre | 2.2 `[x]` | QA PASSED; H1 PASSED; QA sumó 7 baseline + H1 5 ML + 1 B int |

**Riesgos residuales con dueño:** L1 retry transitorio agotado (BullMQ attempts 3) puede dejar `QUEUED` ⇒ **4.7**; L6 fallo de polling puede reenviar/resubmit ⇒ **4.4/4.6**; fallo storage/queue post-commit deja fila durable y `503` ⇒ **4.6**; agregados completos + PDF faltan ⇒ **2.3/6.x**; la huella identifica bytes, no certifica publisher ONNX; mutación de archivo de arranque entre load/hash queda fuera y no se promete universal; resultado `REVIEW_REQUIRED` desconocido/ajeno se descarta como review vacío sin datos ajenos, no se declara `FAILED` para todo parcial malo; L2 `P0001` no es alcanzable por los prechecks bajo locks y no se corrige. Guards/state machine fuera de 2.2; `defects/regressions.md` no se edita.

## 1.23 Registro HITO20 - preparación documental 3.2 (sin ejecución)

> **Naturaleza:** solo documentación. No se implementó código, no se instalaron dependencias, no se ejecutaron tests, no se usó Azure/MinIO real ni `.env` reales. 3.2 y 3.8 seguían `[ ]` en este registro histórico; **actualización HITO22: 3.8 QA PASSED**. No se declara validación OpenSpec ni QA en este turno.

| Elemento | Registro |
|---|---|
| Documentos | `design.md` D22/ADR-047..050 y riesgos; `specs/artifact-evidence/spec.md`; `tasks.md` 3.2/3.8; este runbook §4.6. |
| Selección | `STORAGE_PROVIDER=minio` default retrocompatible; `azure` explícito; desconocido fail closed con error seguro. |
| Compatibilidad | `StorageService` conserva `getDownloadUrl`, `getMlDownloadUrl`, `upload`, `ensureBucket`, `getObjectStream` y `s3Client`; fachada con `StorageProvider` DI/lazy y construcción sin red. |
| Azure | SDK oficial `@azure/storage-blob` + `SharedKeyCredential`; config explícita HTTPS accountURL/name/key sin fallback MinIO; SAS por objeto read-only (`sp=r` en el wire del SDK; `p=r` abreviatura de D22), `sr=b`, `spr=https` y expiración acotada; `ensure` solo comprueba contenedor; upload verifica `getProperties`; sign verifica existencia y no traga permisos/red como `404`. Managed Identity queda para 8.x. |
| MinIO | Endpoints interno y `ML_PUBLIC_HOST` distintos; `HeadBucket` crea solo en `404`/not found, acepta `AlreadyOwnedByYou` y no absorbe `BucketAlreadyExists` ajeno; upload verifica `HeadObject`; streams `Readable` sin logs de credenciales. |
| Keys/TTL | Keys exactas sin normalización ni `decodeURI`; `.`/`..` completos se rechazan de forma explícita. TTL 1..3600 default 3600; callers legacy conservan 3600; 300 queda para 4.8 (3.4 usa el default configurado, D24). `storageId` `minio-local`/`azure-blob-default` sin cambio de DB. |
| Código/tests | Ninguno. Sin `@azure/storage-blob` instalado, sin lockfile tocado, sin parser 3.3, ruta 3.4, logs 3.7, migración/DB ni `storagePath`. |
| Límites | Sin QA, sin evidencia de verde y sin `openspec validate` afirmado. En este registro histórico 3.8 seguía parcial; **actualización HITO22: 3.8 QA PASSED**. `.env.example`/README se actualizan en implementación posterior. |
| Comandos | No ejecutados en este turno; §4.6 los deja como FUTURO. |

## 1.24 Evidencia HITO20 - 3.2 provider dual (QA PASSED)

> **Naturaleza:** implementación local y QA final de 3.2. Sin Azure real, Azurite, `.env.azure`, credenciales reales ni recursos cloud creados/destruidos. 3.2 queda `[x]` con QA PASSED; 3.8 seguía `[ ]` parcial en este registro histórico; **actualización HITO22: 3.8 QA PASSED**.

| Elemento | Evidencia |
|---|---|
| SDK | `@azure/storage-blob@12.32.0` (engines `>=20.0.0`), instalado desde el registry permitido y fijado exacto. Lockfile acotado; sin upgrades globales ni `audit fix`. |
| API | `StorageProvider` con `ensure/upload/sign/read/exists`; `StorageService` conserva `ensureBucket/upload/getDownloadUrl/getMlDownloadUrl/getObjectStream` y export `s3Client`; factory DI/lazy sin red. Misma API pública existente. |
| Config | `STORAGE_PROVIDER=minio` default/`azure` explícito; `STORAGE_ID` `minio-local`/`azure-blob-default`; `STORAGE_DOWNLOAD_TTL_SECONDS` 1..3600 default 3600 (default, no cap); Azure URL HTTPS/name/key explícitos y validados sin fallback. `MINIO_SECURE` solo booleanos o `true`/`false` exactos. |
| Findings QA | F1 parseo estricto de `MINIO_SECURE`; F2 MinIO upload genérico -> `storage_upload_failed` (403 sigue `storage_permission_denied`); F3 `contentType` validado antes de I/O y sin borrado post-mismatch (3.5); V4 TTL default≠cap documentado. |
| Azure | `ensure` solo `exists`; `uploadData` + `getProperties`; `sign` verifica `getProperties` antes del SAS. SAS real del SDK: `sp=r` (wire oficial; `p=r` es abreviatura de D22), `sr=b`, `spr=https`, `st`/`se` con reloj inyectado. Managed Identity para 8.x. |
| MinIO | `HeadBucket` crea solo en 404, acepta `AlreadyOwnedByYou` y no absorbe `BucketAlreadyExists` ajeno; upload `HeadObject`; presign real offline con key exacta (incluye `a b%20c#d?e|f` decodificada una vez); `read` devuelve `Readable`. |
| Tests focales | `npm --prefix backend run test:unit -- tests/unit/storage-provider.test.ts tests/unit/storage-service.test.ts` -> **2 files / 36 tests passed** (35 + 1 QA de precedencia de validación). |
| Unit completo | `npm --prefix backend run test:unit` -> **33 files / 473 tests passed** (472 + 1 QA). |
| Integración focal | `npm --prefix backend run test:integration -- tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts` -> **3 files / 41 tests passed**, re-ejecutada final. Sin Azure/MinIO reales; storage mockeado. |
| Estático | `npm --prefix backend run typecheck` -> **0**; `npm --prefix backend run build` -> **0** reutilizado del mismo source. |
| Audit | `npm audit` **13** (8 moderate, 5 high), baseline **13** verificado en QA con temp HEAD; delta **0**, ningún advisory Azure; sin upgrades ni `audit fix`. |
| Límites | QA PASSED, pero sin Azure real ni E2E cloud. La firma Azure fue solo offline con SDK real y clave sintética: no se creó, modificó ni destruyó ningún recurso Azure. En este registro histórico 3.8 seguía parcial; **actualización HITO22: 3.8 QA PASSED**. 300 s no se adopta antes de 4.8. Un mismatch post-upload puede dejar el objeto sin reclamar como `AVAILABLE`; no se borra y la reconciliación pertenece a 3.5. No se tocaron rutas 3.4, parser 3.3, logs 3.7, DB/migraciones, `storagePath`, ML ni worker. |

## 1.25 Registro HITO21 - QA focal 3.3 (PASSED)

> **Naturaleza:** implementación local y QA focal independiente. Sin Azure real, `.env` reales, SRS, commit ni suite completa. 3.3 queda `[x]`.

| Elemento | Evidencia |
|---|---|
| Documentos | `design.md` D23/ADR-051..053 y riesgos; `specs/artifact-evidence/spec.md`; `tasks.md` 3.3; `contracts/frontend-api-contract.md` §4.2/§7; este runbook §1.25/§4.7/§10. |
| Código | Nuevo `backend/src/services/artifact-reference.ts` (parser puro, contexto trusted, mapper) y `backend/src/lib/artifact-key.ts` (política de key compartida); `schemas/inference.ts` (`ArtifactRef` binario); `storage.ts` (contexto aditivo y seam DI); `routes/inferences.ts` (parseo antes de firmar); `config/env.ts`, `.env.example` y `README.md` (`STORAGE_ALLOWED_BUCKETS`). |
| Tests | Nuevo `tests/unit/artifact-reference.test.ts`; ampliados `tests/schemas.test.ts`, `tests/unit/storage-service.test.ts`, `tests/unit/storage-provider.test.ts`, `tests/inference-creation.integration.test.ts` y `tests/clinical-access.integration.test.ts`; mocks de storage actualizados explícitamente. QA sólo endureció tests: errores must-throw/non-leak y fila postcommit `QUEUED`. |
| Comandos | Focus unit **4 files / 84 tests** (83 + 1 QA de contexto con whitespace id); integración **2 files / 33 tests** re-ejecutada tras el fix de key; `typecheck` **0**; `build` **0** reutilizado del mismo source. Sin suite completa. |
| Estado | 3.3 `[x]` QA PASSED; en este registro histórico 3.8 seguía parcial por 3.4; **actualización HITO22: 3.8 QA PASSED**. Publisher 3.5 pendiente. |

## 1.26 Registro HITO22 - preparación documental 3.4 (sin ejecución)

> **Actualización posterior:** ver §1.27; 3.4 y 3.8 quedaron **QA PASSED**.
>
> **Naturaleza:** solo documentación. No se implementó código, no se ejecutaron tests, no se usó Azure/MinIO real, `.env` reales, SRS ni commit. 3.4 y 3.8 seguían `[ ]` en este registro histórico; ver actualización HITO22 arriba.

| Elemento | Registro |
|---|---|
| Documentos | `design.md` D24/ADR-054..058 y riesgos; `specs/artifact-evidence/spec.md`; `specs/clinical-api-contract/spec.md`; `tasks.md` 3.4/3.8; `contracts/frontend-api-contract.md` §3.3/§4.2/§4.3/§7/§11; este runbook §1.26/§4.8/§10. |
| Contrato | `GET /inferences/:id/artifacts` → `{ items: [{ artifactId, version, reference }], total, limit, offset }`; `limit` 20/100, `offset` 0, `type` binario opcional; orden `artifactType ASC`/`version DESC`/`id ASC`; filtro de tipos permitidos antes de paginar/contar. `GET /inferences/:id/artifacts/:type/url` exige `version` positiva `<= 2147483647`; sin `latest` ni fallback; `result` `400`. |
| Autorización | Unión de todos los grants activos `readArtifacts` (mask/overlay/gradcam/shap) y `readPdf` (pdf); sin `ADMIN` implícito; dueño médico todo, no dueño sin grant nada; `readResult` solo no lista ni firma. `404` uniforme para ejecución inexistente/ajena/sin capability; `401` JWT inválido. |
| Storage/TTL | Parser 3.3 con contexto trusted, allowlist ampliada explícitamente a mask/overlay/PDF; contexto no default exige bucket ya allowlisted; sin extender allowlist desde DB ni fallback cross-provider. TTL efectivo con default configurado 1..3600; 300 queda para 4.8; legacy 3600 intacto. |
| Errores/auditoría | Auth antes de metadata/storage; revalidación fresca de sesión/capability tras firmar; URL solo tras commit `ARTIFACT_URL_ISSUED`; objeto ausente `409` + incidente, permisos/red `503`, PDF `AVAILABLE` sin reporte `409`; `Cache-Control: no-store`; `503` genérico. |
| Código/tests | Ninguno. Sin ruta 3.4, sin lectores, sin migraciones, sin publisher 3.5, sin rutas `/reports`, sin cambios de gradcam legacy ni de TTL de callers. |
| Límites | Sin QA, sin evidencia de verde y sin `openspec validate` afirmado. En este registro histórico 3.8 seguía parcial; **actualización HITO22: 3.8 QA PASSED**. 3.7/3.5 siguen unchecked. |
| Comandos | No ejecutados en este turno; §4.8 los deja como FUTURO. |

## 1.27 Evidencia HITO22 - 3.4/3.8 QA PASSED

> **Naturaleza:** implementación local y QA final. Sin Azure/MinIO real, Azurite, `.env`/credenciales reales, SRS, PDF real, ML/worker ni commit. **3.4 y 3.8 quedan `[x]`.**

| Elemento | Evidencia |
|---|---|
| Código | `routes/artifacts.ts`; `ArtifactReadScope` en `services/clinical-access.ts`; `repositories/artifact.repo.ts`; DTO/query en `schemas/inference.ts`; contexto trusted row en `services/artifact-reference.ts` y `services/storage.ts`; registro DI en `app.ts`. |
| Contrato | Envelope, orden/filtro antes de count, `version` obligatoria, estados no-`AVAILABLE` sin storage, `reportVersion`/PDF, `409`/`503` y `Cache-Control: no-store` según D24. Partición confirmada: pertenencia inferencia/tipo/versión o acceso `404`; config storage/metadata corrupta `503` seguro antes del SDK. |
| Unit | `npm --prefix backend run test:unit -- tests/schemas.test.ts tests/unit/artifact-reference.test.ts tests/unit/storage-service.test.ts tests/unit/storage-provider.test.ts tests/unit/runner-isolation.test.ts` → **5 files / 102 tests** (mismo estado del maker). Incluye los **36** tests de provider de 3.2. |
| Integración | `npm --prefix backend run test:integration -- tests/artifact-downloads.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts tests/inference-creation.integration.test.ts` → **4 files / 60 tests** (nuevo archivo: **16 tests**, +4 QA). QA añadió `403` boundary, metadata `503` sin eco y cross-inference `404`. |
| Estático | `npm --prefix backend run typecheck` → **0 post-QA**; `npm --prefix backend run build` → **0 reutilizado**. |
| Límites | Sin full integration/unit, sin Azure/E2E, sin PDF real ni migraciones. 3.5 publicación/reconciliación sigue pendiente y depende de 6.2; no se declara generador PDF implementado. URLs ya emitidas siguen válidas hasta su TTL; la ventana entre el último recheck y la respuesta HTTP no es atomicidad absoluta. |

## 1.28 Evidencia HITO23 - 3.7 redacción de logs (CURRENT; QA PASSED)

> **Naturaleza:** implementación local y QA final. Sin Azure/MinIO real, `.env`/credenciales reales, SRS, PDF, ML/worker, suite completa ni commit. **3.7 queda `[x]` con QA PASSED.**

| Elemento | Evidencia |
|---|---|
| Documentos | `design.md` D24 (subsección de logs 3.7); `tasks.md` 3.7; este runbook §1.28/§4.9. |
| Código | `lib/log-redaction.ts`: `req.url`/`req.originalUrl`/`req.query` censurados completos, variantes de casing de headers y `buildLoggerOptions`; `lib/not-found-handler.ts`: 404 genérico instalado en el root antes de plugins/rutas para evitar el mensaje `Route <method>:<url> not found` de Fastify; `app.ts`: logger único + `AppDeps.logDestination` (solo stream de test) + installer. Sin cambios de rutas, storage, auditoría, TTL ni contrato HTTP. |
| Tests | Salida real de Fastify/Pino: 13 tests en `tests/unit/log-redaction.test.ts`; integración: 24 tests en `tests/artifact-downloads.integration.test.ts`. QA red: 6 regresiones (3 unit + 3 download) por `lib/four-oh-four.js:52-59` → `lib/log-controller.js:118-122`, que interpola `request.raw.url` en el mensaje. |
| Comandos | Maker focus **3 files / 65 tests** antes de QA final; QA post **13 unit / 13** y **24 download / 24**; ACL/RBAC **2 files / 29 tests** reutilizado; `typecheck` **0**; `build` **0** mismo source. |
| Estado | **3.7 `[x]` QA PASSED HITO23.** Las 6 regresiones QA rojas (`basic404` → `routeNotFound`) quedan verdes. 3.5/3.6 siguen pendientes de PDF 6.2. |
| Límites | Sin full unit/integration, Azure/E2E ni correlación con métricas externas. Los logs internos de Fastify que interpolan strings fuera de `req`/`res` no se censuran de forma universal; no se modifica `node_modules` ni se añade un redactor de mensajes. El error handler global no es un redactor universal. Un eventual log de doble envío con URL no tiene trigger alcanzable en las rutas 3.4; se documenta sin abrir cambio interno del framework. |

## 1.29 Registro HITO24 - preparación documental 4.1-4.3 (sin ejecución)

> **Naturaleza:** solo documentación. No se implementó código, no se ejecutaron tests, no se usó Azure/MinIO real, `.env` reales, SRS, PDF, SMTP, descarga de modelos ni commit. **4.1-4.3 siguen `[ ]`** en ese turno histórico; posteriormente cerraron con QA PASSED en §1.33. No se declara validación OpenSpec ni QA en este registro histórico.

| Elemento | Registro |
|---|---|
| Documentos | `design.md` D25/ADR-059..061 y riesgos; `specs/inference-orchestration/spec.md`; `tasks.md` 4.1/4.2/4.3; este runbook §1.29/§4.10/§10. |
| 4.1 | Política de URL pura y compartida con `Settings` confiable; allowlist no vacía para HTTP/HTTPS, HTTP solo con flag de desarrollo explícito y allowlist (MinIO localhost/minio:port); rechazo de esquemas/userinfo/fragmento/puerto/host inválidos; `422` antes de encolar; revalidación antes del `GET`, sin redirecciones `301/302/307`, timeout existente y bytes acotados; sin framework global DNS/private-IP ni verificación SAS criptográfica en ML. Auth entrante preservada, sin tokens/scopes nuevos. |
| 4.2 | Migración `20261120000000_inference_result_details` con `model_versions`/`model_predictions` JSONB `DEFAULT '{}' NOT NULL` y CHECK de objeto; baseline intacto; legacy `{}` = desconocido sin copiar `modelVersion`; CAS persiste resultado completo en `COMPLETED`, parcial válido en `REVIEW_REQUIRED`, `{}` en `FAILED`; `GET /inferences/:id` sin exposición nueva; sin `ArtifactRecord`/PDF. |
| 4.3 | Fuente única en `common.ts` derivada de `CLASS_LABELS` con `0 Glaucoma`/`1 Non_Glaucoma`/`2 Suspicious_Glaucoma`; helper `canonicalClassIndex` seguro ante `null`/`__proto__`/`constructor`; solo aliases legacy en minúsculas; desconocido ⇒ `FAILED` seguro o `null` en revisión; validación por modelo sin clase inventada ni label raw en logs. |
| Código/tests | Ninguno. Sin migración creada, sin cambios de schema/rutas/worker/processor/Settings ni tests fuente. |
| Límites | Sin QA, sin evidencia de verde y sin `openspec validate` afirmado. No se ejecutan suites completas, Azure/`.env` reales, PDF, SMTP, commits ni descargas de modelos. Revisor independiente solo si se justifica por migración/seguridad. |
| Comandos | No ejecutados en este turno; §1.30/§1.31/§1.32/§4.10 registran después la evidencia 4.1(A)/4.2(B)/4.3(C). |

## 1.30 Evidencia HITO24-A - 4.1(A) implementada (QA PASSED; cierre en §1.33)

> **Naturaleza:** implementación local y tests focales de 4.1(A). Sin QA del bloque A+B+C, sin suite completa, Azure/`.env` reales, PDF, SMTP, descarga de modelos ni commit. **4.1 seguía `[ ]` en ese turno; QA final PASSED en §1.33.**

| Elemento | Evidencia |
|---|---|
| Documentos | `design.md` D25.1; `tasks.md` 4.1; `specs/inference-orchestration/spec.md`; este runbook §1.30/§4.10/§10. |
| Código | `ml/inference/url_policy.py` (helper puro, `host_is_allowed` fail-closed, `SignedImageUrlError` con códigos fijos); `ml/service/main.py` (`Runtime.settings`, validación `422` antes de pin/queue, `APIRouter(strict_content_type=False)`); `ml/inference/pipeline.py` (revalidación antes de `httpx.Client`, `follow_redirects=False`, bytes/timeout, error de red seguro). |
| Contrato | Allowlist no vacía para HTTP/HTTPS; HTTP solo con flag explícito + allowlist; rechazo de esquema/host/userinfo/fragmento/puerto; `422` sin URL; redirecciones `301/302/307` bloqueadas; JSON sin Content-Type soportado y multipart/CDR/campos extra `422`. |
| Tests | Nuevo `ml/tests/test_service_contract.py` (**35**); ajustes en `test_azure_readiness` (allowlist vacía/exacta) y `test_clinical_context` (fixture con host válido). Foco **5 files / 86 tests passed**. Incluye `urlparse` corrupto, `httpx.InvalidURL` y `content-length` inválido con códigos seguros. |
| Estático | `ruff` limpio; `mypy --follow-imports=skip` limpio en los 6 archivos afectados. |
| Comandos | `python -m pytest ml/tests/test_service_contract.py ml/tests/test_service.py ml/tests/test_clinical_context.py ml/tests/test_azure_readiness.py ml/tests/test_clinical_normalization.py -q`; `python -m ruff check ...`; `python -m mypy --follow-imports=skip ...`. |
| Límites | Sin full ML/test de pesos, Azure model, `.env` real, PDF, SMTP, commit ni QA A+B+C. 4.2/4.3 no se tocaron; 4.1 permanece `[ ]`. Validación OpenSpec `--strict` reportada por el arquitecto en 0; no re-ejecutada aquí. |

## 1.31 Evidencia HITO24-B - 4.2(B) implementada (QA PASSED; cierre en §1.33)

> **Naturaleza:** implementación local y tests focales de 4.2(B). Sin QA A+B+C, suite completa, 4.3, GET nuevo, `ArtifactRecord`/PDF, Azure/`.env` reales, SRS, modelos ni commit. **4.2 seguía `[ ]` en ese turno; QA final PASSED en §1.33.**

| Elemento | Evidencia |
|---|---|
| Documentos | `design.md` D25.2; `tasks.md` 4.2; `specs/inference-orchestration/spec.md`; este runbook §1.31/§4.10/§10. |
| Migración | `20261120000000_inference_result_details`: `model_versions`/`model_predictions` JSONB `NOT NULL DEFAULT '{}'`, CHECK de objeto vía `pg_constraint`, replay idempotente, privilegios de `clearsight_app` verificados; legacy `model_version` intacto y `{}` = desconocido, sin backfill. |
| Prisma/código | `Inference.modelVersions`/`modelPredictions`; `InferenceResultUpdate`/`saveResult` opcionales para compatibilidad; `TerminalInferenceUpdate`/CAS y processor persisten el resultado real en `COMPLETED`, parcial en `REVIEW_REQUIRED`, `{}` en `FAILED`; sin exposición GET nueva. |
| Tests | Unit **3 files / 59** (`inference.processor`, `ml-client`, `schemas`); integración **3 files / 56** (`migrations`, `inference-worker`, `repositories`); cubre replay/CHECK/defaults/roles, completo/revisión/fallo, identidad foránea, payload mutado y carrera CAS. |
| Estático | `prisma validate` + `prisma generate` con URL sintética (sin `.env` real); `typecheck`/`build` **0**. |
| Límites | Sin full unit/integration, 4.3, GET nuevo, `ArtifactRecord`/PDF, Azure/`.env`, SRS, modelos ni commit. 4.2 permanece `[ ]` hasta QA A+B+C. |

## 1.32 Evidencia HITO24-C - 4.3(C) implementada (QA PASSED; cierre en §1.33)

> **Naturaleza:** implementación local y tests focales de 4.3(C). Sin QA A+B+C, suite completa, migraciones B repetidas, ML, Azure/`.env` reales, SRS/PDF ni commit. **4.3 seguía `[ ]` en ese turno; QA final PASSED en §1.33.**

| Elemento | Evidencia |
|---|---|
| Documentos | `design.md` D25.3; `tasks.md` 4.3; `specs/inference-orchestration/spec.md`; este runbook §1.32/§4.10/§10. |
| Código | `common.ts`: `CLASS_LABEL_INDEX`/`CLASS_LABEL_SET`/`canonicalClassIndex` derivados de `CLASS_LABELS`; aliases legacy acotados; `__proto__`/`constructor`/`toString` ⇒ `null`. Processor sin mapa local; usa helper/set de `common.ts`. |
| Comportamiento | `COMPLETED` desconocido ⇒ `FAILED` con `predictedClass=null`, `modelVersions`/`modelPredictions` `{}`; `REVIEW_REQUIRED` desconocido o predicciones por modelo inválidas ⇒ `predictedClass=null`, `modelPredictions` `{}` y otros parciales preservados; sin clases `0`/`v1` fabricadas. |
| Tests | Unit **4 files / 86** (`schemas`, `inference.processor`, `ml-client`, `inference-run-repo`); integración worker/repo **2 files / 31** (9 worker + 22 repo). Sin migraciones B repetidas. |
| Corrección QA | Records propios proto-safe en processor, `MlClient` con `protoSafeRecord`, CAS JSONB raw **schema-qualified** (`public`/custom validado) para roundtrip PG de `__proto__` own y defensa ante `search_path` decoy, y REVIEW con `probabilities={}` legítimo conserva segmentación. |
| Estático | `typecheck`/`build` **0**. |
| Límites | Sin full unit/integration, ML, Azure/`.env`, SRS/PDF, commits ni refactor de 4.9. 4.3 permanece `[ ]` hasta QA A+B+C. |

## 1.33 Cierre QA final HITO24 - 4.1/4.2/4.3 (PASSED)

> **Naturaleza:** cierre documental post-QA. Sin source/test edits en este turno, sin suite completa, Azure/`.env` reales, SRS/PDF, ML real ni commit. `defects/regressions.md` no se edita.

| Elemento | Evidencia |
|---|---|
| Pre-fix | 3 regresiones QA de prototipo en unit estaban rojas (extra prob `__proto__`, REVIEW per-model proto, model name `__proto__`). |
| Post-fix unit | **4 files / 86 passed** (`schemas`, `inference.processor`, `ml-client`, `inference-run-repo`). |
| Post-fix integración | worker **9** (8 previos + decoy) + repo **22** archivo reutilizado = **2 files / 31 passed**. |
| Migración B | Baseline pre-fix **3 files / 56** (incluye migration tests; SQL/source sin cambios). No se repite en cierre; replay/CHECK/legacy/app-role quedaron verificados en baseline, no se presenta como full final. |
| ML | **5 files / 86 passed** (35 en `test_service_contract`), `ruff`/`mypy --follow-imports=skip` limpios en 6 archivos. |
| Estático backend | `typecheck`/`build` **0**. |
| Fixes confirmados | own proto records; `MlClient` `protoSafeRecord`; CAS JSONB raw schema-qualified (`public`/custom validado, values bound, same terminal guard); REVIEW `probabilities={}` conserva segmentación; `urlparse`/`httpx.InvalidURL`/`content-length` safe codes. |
| Repro edges | 3 QA proto rojo→verde; REVIEW real ML con diagnóstico vacío; PG decoy/search_path + proto roundtrip; safe URL exceptions cubiertas. |
| Clarificaciones | X1: `label`/`confidence` son diagnóstico, no segmentación. X2: Zod `record()` no usado en runtime puede ser hazard futuro 4.9; no se reclama refactor total. X3: per-model válido con aggregate probs `{}` deja label/conf global `null` y conserva metadata validada, sin autodiagnóstico. Columnas nuevas vacías = desconocido, no resultado inventado. |
| Límites | No 4.4/4.6/4.7/4.9/PDF/poll implementados. REG-004 queda para cierre humano; `gradcam` `NOT_SUPPORTED` legítimo, sin sustituir por `mask`. |

## 1.34 Registro HITO25 - preparación documental 4.4/4.5 (sin ejecución)

> **Naturaleza:** solo documentación. No se implementó código, no se ejecutaron tests, no se usó Redis/ML/modelos/Azure/`.env` reales, SRS/PDF ni commit. En este turno histórico 4.4/4.5 seguían `[ ]`; actualización **QA PASSED** en §1.35/§4.11.

| Elemento | Registro |
|---|---|
| Base | `6637a80` (source actual; no modificado en este turno). |
| Documentos | `design.md` D26.1/D26.2/ADR-062..063 y riesgos; `specs/inference-orchestration/spec.md`; `tasks.md` 4.4/4.5; `contracts/frontend-api-contract.md` §1/§3.3/§6/§10/§11; este runbook §1.34/§4.11/§6/§10. |
| 4.4 | Header obligatorio ASCII `[A-Za-z0-9._:-]{1,128}`, `400` antes de ML/fila, `401`/`403` antes del `400`; scope `inferences:create:v1`; hash SHA-256 plano canónico; replay exacto/`409`; snapshot+modelos+pin inmutables; advisory xact lock y único final; `ACCEPTED` solo tras ack con update condicional; `503`/`PENDING` reanudable; replay terminal sin reenvío; retención sin purga hasta B3. |
| 4.5 | `POST /inferences` + `reanalysisOf`; sin alias `/reanalysis`; hash incluye padre; misma key+padre distinto `409`; key nueva crea reanálisis legítimo; frozen/consulta intactos; owner inmutable por trigger. |
| Código/tests | Ninguno. Sin migración nueva, sin rutas/servicio/repos/queue/test edits. |
| Límites | No QA, no evidencia de verde, no `openspec validate` afirmado. Sin Redis real, modelos, Azure/`.env`, SRS/PDF ni commit. La ejecución del script E2E contra DB compartida queda prohibida; solo se actualizará su caller en la implementación. |
| Comandos | FUTURO en §4.11; no ejecutados en este turno. |
| Actualización | 4.4/4.5 QA PASSED; ver §1.35/§4.11. |

## 1.35 Evidencia HITO25 - 4.4/4.5 QA PASSED

> **Naturaleza:** QA focal PASSED sobre source intacto. QAsolo tests+guard nuevos; revisor independiente con 2 LOW confirmados y corregidos. Sin suites completas, Azure/`.env` reales, SMTP, SRS/PDF, descargas de modelos, Redis real ni commit. **4.4/4.5 `[x]`.**

| Elemento | Evidencia |
|---|---|
| Código | `backend/src/services/idempotency.ts` (header/hash/replay estricto), `backend/src/repositories/idempotency.repo.ts` (advisory lock y `ACCEPTED` schema-qualified; `pg_catalog` en lock/`statement_timestamp` y `GREATEST` como expresión SQL), `backend/src/services/inference-creation.ts` (lookup antes de prepare, TX con recheck, dispatch/resume desde DB), `backend/src/routes/inferences.ts` (header obligatorio después de auth/rol) y export en `backend/src/repositories/index.ts`. |
| Contrato | Scope `inferences:create:v1`; hash plano canónico con `imageId`/`eyeSide`/11 features/`modelVersion`/`reanalysisOf`; replay exacto y `409` antes de ML; `PENDING` reanudable; `ACCEPTED` solo tras ack con update condicional; `jobId` público/BullMQ = `inferenceId`; sin migración nueva. |
| Unit foco | QA focal **5 files / 62 tests** (idempotency/idempotency-repo/idempotency-creation-guard/schemas/runner-isolation); post-corrección **3 files / 16 tests**. |
| Integración foco | QA focal **5 files / 82 tests** (inference-idempotency/inference-creation/clinical-access/rbac/identity-migrations); post-corrección **1 file / 19 tests** (decoy/advisory). |
| Estático | `typecheck` **0**; build reutilizable con source intacto. |
| Reviewer | 2 LOW confirmados y corregidos: `pg_catalog` en `pg_advisory_xact_lock`/`hashtext`/`statement_timestamp` (`GREATEST` es expresión SQL no shadowable) y comentario de lock honesto (namespace probabilístico; garantía por índice único + CAS). |
| E2E | `scripts/e2e-backend.ps1` actualizado para enviar una key por intento; **no ejecutado** contra la DB de desarrollo compartida. |
| Límites | 4.6 outbox/reconciliación, 4.7 retries/cancelación, 4.8 URL JIT, 4.9 y PDF/publicación pendientes; BullMQ `removeOnComplete:1000` sin dedup eterna; PENDING resume y `ACCEPTED` replay no reencolan job tras terminal (CAS worker protege); ventana post-dispatch enqueue→markAccepted sin cancelación atómica; sin TTL/borrado/tombstone hasta B3; `defects/regressions.md` no editado. `4.4/4.5 [x]`. |

## 1.36 Registro HITO26 - implementación 4.6/4.7/4.8 (QA PASSED en §1.37)

> **Naturaleza:** implementación y verificación focalizada de HITO26 sobre la base `bb83a3a`. **Actualización:** 4.6/4.7/4.8 implementados y QA PASSED; cerrados `[x]`. No se declaran resueltas REG-002/003/004. Los registros históricos §1.23/§1.26/§4.6/§4.8 que decían “300 queda para 4.8” se leen como planificación previa: D27.3 mantiene 3600 s y resuelve la expiración con firma JIT, sin adoptar 300 s.

| Elemento | Registro |
|---|---|
| Base | `bb83a3a`; source modificado para 4.6/4.7/4.8. |
| Documentos | `design.md` D27.1-D27.3/ADR-064..066 y riesgos; `specs/inference-orchestration/spec.md`; `specs/artifact-evidence/spec.md` (TTL); `tasks.md` 4.6/4.7/4.8; este runbook §1.36/§1.37/§4.12/§10. |
| 4.6 | Migración aditiva `20261121000000_inference_dispatch` sobre `idempotency_records`; reconciliador con lease `SKIP LOCKED`, resume sin sesión, firma fresca + `jobId=inferenceId`, CAS `markAccepted`, backoff acotado; sin outbox transaccional Redis; schema calificado/params bound/sin URL en logs. |
| 4.7 | `failed` handler persiste `FAILED` una vez cuando el intento es final (`attemptsMade >= opts.attempts` o `UnrecoverableError`, que no consume los 3 intentos) con CAS vacío; H2 exige `await job.isFailed()` antes del persist; H1 preserva `.code` en logs; `429`/`5xx`/timeout/red siguen retry; defaults 3/2s/1000/5000 intactos + test; CAS no pisa terminal. |
| 4.8 | Worker re-firma URL JIT desde `execution.image.storagePath` antes de cada submit; jobs nuevos sin URL en payload; legacy re-firma desde DB e ignora URL obsoleta; sin storagePath+sin URL ⇒ retryable; fallo de firma retryable sin ML; TTL 3600; sin URL en Redis/logs. |
| Código/tests | 4.6/4.7/4.8 implementados en migración/schema/repo/services/worker/processor/creation/contratos y tests unit/integration. |
| Límites | Sin suite completa, Redis real, Azure/`.env`, modelos, PDF ni commit. La migración histórica/`0_init` no se edita. |
| Comandos | Ejecutados para 4.6/4.7/4.8 en §4.12; cifras de cierre en §1.37. |

**Frontend:** sin cambios de contrato; 4.6-4.8 no añaden códigos de error ni headers públicos. `imageUrl` es payload interno de BullMQ y no forma parte de la API clínica.

## 1.37 Evidencia HITO26 - 4.6/4.7/4.8 QA PASSED

> **Naturaleza:** cierre documental sobre source sin cambios adicionales. Sin suite completa, Redis real, Azure/`.env`, PDF, modelos ni commit. `defects/regressions.md` no se edita.

| Elemento | Evidencia |
|---|---|
| 4.7/4.8 | Unit foco **5 files / 65 tests**; integración **3 files / 46 tests**; `typecheck` **0**. |
| Correcciones H1/H2 | Unit **2 files / 55 tests**; `typecheck`/`build` **0**; revisor fase 2 confirmó `.code` en logs y `await job.isFailed()` antes del persist. |
| 4.6 | Unit **6 files / 96 tests** (82 + 14 QA); integración **4 files / 56 tests** (50 + 6 QA); `typecheck` **0**; `build` reutilizado; revisor sin defectos. |
| Migración | `20261121000000_inference_dispatch` aditiva/idempotente; replay, columnas/defaults, índice parcial y privilegios `clearsight_app` verificados. |
| Cierre | 4.6/4.7/4.8 `[x]`. REG-002/003/004 **NO** declarados resueltos; `gradcam`/`mask`/`overlay` y agregados/PDF siguen en 2.3/6.x. |
| Límites | 4.6 no es outbox transaccional Redis (lease+jobId+inferenceId+CAS mitigan réplicas, no at-least-once perfecto); reconciliador recupera `PENDING` sin cliente; persist del failed handler es best-effort y depende del reconciliador; backoff `2s*2^attempts` cap 120 s; inconsistencias reintentan acotado con `last_error_code` observable y sin give-up; `UnrecoverableError` con `attemptsMade=1`; JIT desde `storagePath`, payload nuevo sin URL, legacy ignorado con storagePath, TTL 3600 sin 300 s. |

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

### 4.5 Fase específica HITO19 — 2.2 contexto clínico (A+B+C CURRENT; QA PASSED; H1 PASSED)

**Objetivo:** verificar el contrato D21 de 2.2 en tres etapas dependientes, sin descargar modelos ni tocar cloud real.

**Precondiciones:**

- Fase 1 verde y contrato D21, `contracts/frontend-api-contract.md` §3.3/§4.6 y specs `clinical-case-execution` e `inference-orchestration` revisados.
- A (ML), B (backend) y C (worker) implementadas y verificadas; C se registra en §1.21. El rollout real despliega ML primero.
- Tests ML con `build_runtime` fake y metadata realista; tests backend con `MlClient`/`prisma` inyectados y PostgreSQL owned de Testcontainers. Sin Azure, `.env.azure`, PHI, DB externa ni modelos reales.
- `TEST_DATABASE_URL` ausente para la integración; Docker local disponible.

**Comandos focalizados (A+B+C CURRENT; QA PASSED; H1 PASSED):**

```powershell
# A - ML: prepare, descriptor, pin y normalización real con runtime fake (CURRENT)
python -m pytest ml/tests/test_clinical_context.py ml/tests/test_clinical_normalization.py ml/tests/test_service.py -q

# B - Backend: contrato estricto, creación TX y errores sin ML real (CURRENT)
npm --prefix backend run test:unit -- tests/unit/clinical-context.test.ts tests/unit/ml-client.test.ts
npm --prefix backend run test:integration -- tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts tests/repositories.test.ts tests/rbac.test.ts

# C - Worker: terminales, revisión, pin, IDs/ojo y persistencia condicional sin Redis real (CURRENT)
npm --prefix backend run test:unit -- tests/unit/inference.processor.test.ts tests/unit/inference.worker.test.ts
npm --prefix backend run test:integration -- tests/inference-worker.integration.test.ts
```

**Casos mínimos verificables:**

1. **A — prepare válido:** 11 features + `requested_model_version=null` devuelve `rawCanonical` exacto (sin `eyeSide`), `normalizedPayload` con orden/`float32`/11 valores reales comparados con tolerancia float32, `schemaVersion="ml-zscore-f32-v1"`, `modelVersions` no vacío y huella hex 64; no descarga pesos ni escribe DB.
2. **A — versión/modelo:** `requested_model_version` no nulo distinto del manifiesto ⇒ `422`; runtime/descriptor no verificable ⇒ `503`; nunca `"v1"` ni `modelVersions={}`.
3. **A — descriptor:** media/desviación registran fuente `env`/`manifest`; epsilon `1e-8`; orden/dtype; backend efectivo; revisiones/checksums; SHA ONNX real calculado una vez si aplica; cambiar un secreto no cambia la huella y cambiar modelo/parámetros sí.
4. **A — pin:** pin coincidente acepta; mismatch al aceptar ⇒ error seguro no retryable; mismatch en `run` antes de descargar/segmentar ⇒ `FAILED context_mismatch`; legacy sin pin sigue funcionando.
5. **B — preparación fallida:** `404`/unsupported, timeout 15 s, 5xx, JSON inválido, features alteradas, `eyeSide` en respuesta o huella/versión inválida ⇒ `503` sin snapshot ni inference y sin fallback sin pin.
6. **B — ownership/contexto:** imagen ajena/inexistente ⇒ `404` uniforme; `reanalysisOf` ajeno/inexistente ⇒ `404` uniforme; `eyeSide` contradictorio ⇒ `422`; padre con consulta/ojo contradictorio ⇒ `422` antes de prepare/DB; padre legacy NULL usa la imagen autoritativa.
7. **B — TX:** snapshot + inference `QUEUED` con `id` de servidor, consulta/ojo/snapshot/padre en la misma TX; fallo SQL no deja snapshot huérfano; no se actualiza `consultation.status`; fallo storage/cola post-commit queda pendiente explícito (4.6) y responde `503`, no `202` falso.
8. **C — terminales:** `COMPLETED` persiste campos disponibles y `modelVersions` reales; `REVIEW_REQUIRED` persiste parcial sin throw/retry; `FAILED`/timeout 60×2 s cierra seguro; `result.inference_id`/`eye_side` contradictorios o etiqueta desconocida ⇒ fallo seguro sin datos ajenos ni clase adivinada; entrega duplicada sobre terminal es no-op.
9. **C — sin autocompletado:** ningún job (nuevo o legacy) actualiza `consultation.status` ni completa la consulta; `REVIEW_REQUIRED` se preserva.

**Regresiones (mapeo, sin cerrar el registro):** REG-002 se cubre parcialmente con el caso 8 (`REVIEW_REQUIRED` terminal, sin throw/retry); REG-003 con el caso 9 (sin autocompletado de consulta), pero su solución completa requiere 2.3/6.x; REG-004 con el caso 8 (no perder `cdrVertical`/`quality`/`artifacts`/`elapsedSeconds`/`modelVersions`), pero 4.2 sigue siendo el cierre completo. `defects/regressions.md` no se reescribe y los estados no se cambian a `resuelto` desde 2.2. 2.4 queda parcial; 4.2/4.3 se siguen trackeando de forma independiente aunque un test accidentalmente cubra parte.

**Stop:** si un test necesita descargar/cargar pesos reales, Azure/`.env.azure`, PHI, DB compartida/producción, Redis real o un `MlClient` no inyectado. Si aparece un `context_mismatch`, no se “arregla” quitando el pin; se investiga el descriptor.

**Criterio de salida:** A+B+C verdes con los comandos focalizados pre-H1 (A **30 passed** + relacionados 12 + 4; B unit **13 passed**, integración B **11 passed**; C unit **20 passed**, integración C **4 passed**; foco C+B+ACL+repos+rbac **65 passed**). **QA final global PASSED (baseline 31/437 y 25/469) y H1 PASSED**; post-H1 foco ML **45**, backend unit **15**, B+ACL **30**. Sin descarga de modelos, sin Redis real, sin secretos en salida ni recursos propios residuales. **2.2 cerrada**; no se declara un full post-H1 nuevo.

### 4.6 Fase específica HITO20 — 3.2 provider dual (CURRENT; QA PASSED; 3.8 QA PASSED en HITO22)

**Objetivo:** verificar la selección MinIO/Azure, la fachada `StorageService`, validación previa de inputs y firma/verificación por provider sin Azure real ni red.

**Precondiciones:**

- D22, `specs/artifact-evidence/spec.md` y `tasks.md` 3.2/3.8 revisados; 3.2 QA PASSED; 3.4/3.8 QA PASSED en HITO22.
- Tests con dobles de SDK y firma offline con cuenta/clave sintéticas; MinIO con comandos y reloj fake. Sin Azurite, Docker innecesario, credenciales Azure ni `.env` reales.
- `@azure/storage-blob@12.32.0` instalado desde el registry permitido; lockfile acotado sin upgrades globales ni `audit fix`.

**Comandos CURRENT (QA PASSED):**

```powershell
npm --prefix backend run test:unit -- tests/unit/storage-provider.test.ts tests/unit/storage-service.test.ts
npm --prefix backend run test:unit
npm --prefix backend run typecheck
# build: 0 reutilizado del mismo source en la QA final
npm --prefix backend run build
npm --prefix backend run test:integration -- tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts
```

**Casos mínimos verificados:**

1. **Selección/fachada:** sin `STORAGE_PROVIDER` o `minio` ⇒ MinIO y firmas/`s3Client`/API actuales; `azure` ⇒ SDK oficial; desconocido ⇒ fail closed sin red. Construir `StorageService` no abre red ni exige credenciales Azure.
2. **Config estricta:** `MINIO_SECURE` solo booleanos o `true`/`false` exactos; `TRUE`/`yes`/`1` fallan cerrado. TTL 1..3600 default 3600 (no cap); override explícito hasta 3600.
3. **Azure upload/ensure:** `ensure` solo `exists` y nunca crea; validación de `contentType` antes de I/O; `upload` verifica `getProperties` (longitud/contentType) y falla sin URL si no coincide.
4. **Azure SAS:** parsing de `sp=r` (wire oficial; `p=r` abreviatura), `sr=b`, `spr=https`, expiración acotada según reloj inyectado y key/path exactos, incluida `a b%20c#d?e|f`; sin permisos extra ni container-wide.
5. **Azure sign/read:** objeto ausente ⇒ ausencia segura sin URL; permisos/red ⇒ error seguro, no `404` falso; `download` devuelve `Readable`.
6. **MinIO:** `HeadBucket` crea solo en `404`, acepta `AlreadyOwnedByYou` y no absorbe `BucketAlreadyExists` ajeno; upload `Buffer`/`Uint8Array` + `contentType` valida y verifica `HeadObject`; fallo genérico de upload ⇒ `storage_upload_failed`, `403` ⇒ `storage_permission_denied`; endpoints interno/`ML_PUBLIC_HOST` no se mezclan.
7. **Keys/mismatch:** espacios, `%`, Unicode, barras y `#`/`?` se preservan; `.`/`..` completos se rechazan explícitamente; un mismatch post-upload no borra el objeto y la reconciliación queda para 3.5; errores SDK genéricos sin causa pública.

**Stop:** si un caso exige Azurite, Docker, Azure real, credenciales, `.env` reales, red o un provider forzado fuera de la configuración. Si aparece un fallback Azure→MinIO, una URL para un objeto ausente o un borrado post-mismatch, se detiene la fase.

**Criterio de salida:** QA final PASSED con focus **2/36**, unit completo **33/473**, integración focal **3/41**, `typecheck` **0**, `build` **0** reutilizado del mismo source y audit **13** baseline **13** (delta 0, sin advisory Azure). **3.2 `[x]`**; **actualización HITO22: 3.8 QA PASSED**. 300 s no se adopta antes de 4.8. La firma Azure fue solo offline: no se creó, modificó ni destruyó ningún recurso Azure. Este runbook no declara validación OpenSpec.

### 4.7 Fase específica HITO21 — 3.3 referencia/parser (CURRENT; QA PASSED)

**Objetivo:** verificar el parser puro, la allowlist, la compatibilidad legacy y el mapper `ArtifactRef` sin SDK/red, Azure real ni suite completa.

**Precondiciones verificadas:**

- D23, `specs/artifact-evidence/spec.md`, `tasks.md` 3.3 y `contracts/frontend-api-contract.md` §4.2 revisados.
- `backend/src/services/artifact-reference.ts` y los tests nuevos existen; `StorageService` mantiene exports/firmas legacy y el seam DI usa el provider activo.
- Sin `STORAGE_ALLOWED_BUCKETS` real, sin `.env.azure`, sin credenciales Azure; integración con PostgreSQL owned de Testcontainers.

**Comandos ejecutados (QA focal independiente):**

```powershell
npm --prefix backend run test:unit -- tests/unit/artifact-reference.test.ts tests/schemas.test.ts tests/unit/storage-service.test.ts tests/unit/storage-provider.test.ts
npm --prefix backend run test:integration -- tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts
npm --prefix backend run typecheck
npm --prefix backend run build
# Sin suite completa
```

**Resultados:** unit **4 files / 84 tests** (83 + 1 QA de contexto con whitespace id); integración **2 files / 33 tests** re-ejecutada tras el fix de key; `typecheck` **0**; `build` **0** reutilizado del mismo source. QA sólo endureció tests: errores must-throw/non-leak y fila postcommit `QUEUED`.

**Casos cubiertos:** URIs Azure/MinIO y structured equivalentes; mismatch de `storageId`/provider/contenedor; allowlist vacía/forbidden; esquema desconocido/autoridad/credenciales/query SAS sin SDK ni red; key Unicode/`%`/`?`/`#`/`&` exacta, `%` literal sin decode, `/` inicial doble preservado, `folder/http://literal.bin` preservada y comienzo `blob:`/`file:`/`data:` rechazado; patrón de firma y `.`/`..` rechazados; bare legacy con defaults y precedencia; DTO binario en todos los estados, `result` fuera de `ArtifactRef` y bigint fuera de rango; integración POST raw conserva args de firma y gradcam URI resuelve args correctos, con no autorizado/corrupto sin llamada al storage.

**Stop:** si un caso exige SDK/red, Azure real, migraciones, `.env`/credenciales o una suite completa; si aparece un fallback cross-provider, una URL para referencia corrupta o un `ArtifactRef AVAILABLE` inventado.

**Criterio de salida:** QA focal independiente PASSED; 3.3 `[x]`. En este registro histórico 3.8 seguía parcial por 3.4; **actualización HITO22: 3.8 QA PASSED**. 3.5 publisher permanece pendiente.

### 4.8 Fase específica HITO22 — 3.4 listado y URL versionada (CURRENT; QA PASSED)

**Objetivo:** verificar el listado paginado/filtrado por capability y la URL firmada por versión explícita, con auth fresca, auditoría y manejo de objeto ausente/reporte PDF.

**Precondiciones:**

- D24, specs `artifact-evidence`/`clinical-api-contract`, `tasks.md` 3.4/3.8 y `contracts/frontend-api-contract.md` revisados; 3.4 y 3.8 QA PASSED.
- Fixture SQL: snapshot → inference → `ArtifactRecord AVAILABLE` (`mask`/`overlay`/`pdf`) → `PdfReport` de la misma inferencia/versión, con `clearsight_app` y triggers vigentes.
- Sin Azure real, Azurite, `.env.azure`, SRS, red real ni credenciales; storage con dobles/stub y PostgreSQL owned de Testcontainers.

**Comandos ejecutados (QA final):**

```powershell
npm --prefix backend run test:unit -- tests/schemas.test.ts tests/unit/artifact-reference.test.ts tests/unit/storage-service.test.ts tests/unit/storage-provider.test.ts tests/unit/runner-isolation.test.ts
npm --prefix backend run test:integration -- tests/artifact-downloads.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts tests/inference-creation.integration.test.ts
npm --prefix backend run typecheck
npm --prefix backend run build
```

**Resultados:** unit **5 files / 102 tests** (mismo estado del maker, incluye los 36 de provider); integración **4 files / 60 tests** (nuevo archivo: **16 tests**, +4 QA); `typecheck` **0 post-QA**; `build` **0 reutilizado**. QA añadió `403` boundary, metadata `503` sin eco y cross-inference `404`. Sin full suite.

**Casos mínimos:**

1. **Listado:** envelope/orden/filtro antes de contar; tipo no autorizado no aparece ni suma; `result`/desconocido `400`; sin filas `200`; ejecución ajena/inexistente/sin capability `404`; JWT inválido `401`.
2. **Grants:** unión `readArtifacts`/`readPdf`; sin `ADMIN` implícito; `readResult` no lista ni firma; dueño médico todo; médico no dueño sin grant nada.
3. **URL versionada:** `version` obligatoria; sin versión/`result` `400`; fila exacta inexistente (pertenencia inferencia/tipo/versión) o acceso `404`; config storage/metadata corrupta `503` seguro antes del SDK; no `latest` ni fallback a versión anterior.
4. **Estados:** no-`AVAILABLE` `200` con `url`/`expiresInSeconds`/`contentType` nulos sin storage; `AVAILABLE` URL + TTL efectivo configurado; 300 no se adopta: 4.8 mantiene 3600 y firma JIT (D27.3).
5. **PDF:** `reportVersion` solo con `PdfReport` válido; PDF `AVAILABLE` sin reporte `409` auditado; no-PDF `null`.
6. **Auth/auditoría:** sesión revocada `401`, grant perdido `404` sin URL; auditoría caída `503` sin URL; URL solo tras commit `ARTIFACT_URL_ISSUED`.
7. **Storage:** `storage_object_missing` `409` + incidente sin mutar `AVAILABLE`; permisos/red `503`; `Cache-Control: no-store` en listado/URL y `503` genérico.

**Stop:** si un caso exige Azure/Azurite, migraciones, SDK/red real, credenciales o suite completa; si aparece un fallback cross-provider, una URL para objeto ausente, un `AVAILABLE` inventado o una URL devuelta antes del commit de auditoría.

**Criterio de salida:** **QA final PASSED**; **3.4, 3.8 y 3.7 quedan `[x]`**. 3.8 se cerró reutilizando 3.2 SDK real offline + 3.4 auth/missing/storage/version, sin Azure/Azurite. 3.7 se cerró con QA PASSED HITO23. 3.5/3.6 siguen pendientes de PDF 6.2 y no se declara generador PDF. URLs ya emitidas siguen válidas hasta su TTL (ventana entre el último recheck y la respuesta HTTP documentada, sin garantía absoluta).

### 4.9 Fase específica HITO23 - 3.7 redacción de logs (CURRENT; QA PASSED)

**Objetivo:** probar la salida real de Fastify/Pino con un stream en memoria, no solo la lista de paths configurados, incluyendo los logs autogenerados por rutas/métodos no encontrados.

**Precondiciones:** tests unitarios puros sin DB; integración con PostgreSQL owned de Testcontainers; storage mock; sin Azure/MinIO/red reales.

**Comandos ejecutados:**

```powershell
npm --prefix backend run test:unit -- tests/unit/log-redaction.test.ts tests/unit/artifact-reference.test.ts tests/schemas.test.ts
npm --prefix backend run test:integration -- tests/artifact-downloads.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts
npm --prefix backend run typecheck
npm --prefix backend run build
```

**Resultados:** maker focus **3 files / 65 tests** antes de QA final; QA post **13 unit / 13** y **24 download / 24**; ACL/RBAC **2 files / 29 tests** reutilizado; `typecheck` **0**; `build` **0** mismo source. Las 6 regresiones QA rojas (3 unit + 3 download, `basic404` → `routeNotFound`) quedan verdes. Sin full suite.

**Casos mínimos:**

1. Query canary/SAS antes de validación (health `200`, sin auth `401`) no aparece en logs; se conservan `reqId`, método y status.
2. Descarga `200`: URL firmada y locators solo en el body HTTP; logs sin URL/query/bucket/key y auditoría `ARTIFACT_URL_ISSUED` con `targetId`.
3. Objeto ausente `409`, permiso/red `503` y auditoría caída `503`: logs sin canary/causa/locators; incidente solo cuando corresponde.
4. Headers sensibles y `req.query` censurados también si un serializer los expone; variantes de casing de `Set-Cookie`/`Authorization`/`Cookie`/`Proxy-Authorization`.
5. Logger deshabilitado por defecto: los tests existentes no escriben a stdout y solo el seam `logDestination` captura en memoria.
6. Ruta de artefacto desconocida, path malformado y método no soportado devuelven `404` genérico sin eco de URL/query ni log `Route <method>:<url> not found`. Causa: `lib/four-oh-four.js:52-59` llama `logController.routeNotFound`; `lib/log-controller.js:118-122` interpola `request.raw.url` en el mensaje y la redacción por path no aplica a strings. Fix: `registerGenericNotFoundHandler` en el root antes de plugins/rutas.

**Stop:** si la redacción exige regex sobre URL, un redactor universal, desactivar la redacción, Azure/red real o suite completa.

**Criterio de salida:** **3.7 QA PASSED**; checkbox `[x]`. 3.5/3.6 siguen pendientes de PDF 6.2.

### 4.10 Fase específica HITO24 - 4.1(A)+4.2(B)+4.3(C) CURRENT; QA PASSED

**Estado:** 4.1, 4.2 y 4.3 **QA PASSED**; cierre en §1.33 y checkboxes `[x]`.

**Objetivo:** verificar en tres unidades secuenciales la admisión ML estricta, la persistencia real de versiones/predicciones y el catálogo canónico único, con foco acotado y sin suite completa.

**Precondiciones:** fase 1 documental revisada; D25/ADR-059..061 y specs de orquestación leídos; sin Azure/`.env` reales, PDF, SMTP, descarga de modelos ni commit. La integración 4.2 usa PostgreSQL owned de Testcontainers o la base aislada ya verificada por el runner; no se usa el compose raíz.

**Comandos (4.1A/4.2B/4.3C CURRENT; QA PASSED):**

```powershell
# 4.1(A) - CURRENT: helper de URL/admisión y foco de regresión
python -m pytest ml/tests/test_service_contract.py ml/tests/test_service.py ml/tests/test_clinical_context.py ml/tests/test_azure_readiness.py ml/tests/test_clinical_normalization.py -q
python -m ruff check ml/inference/url_policy.py ml/inference/pipeline.py ml/service/main.py ml/tests/test_service_contract.py ml/tests/test_azure_readiness.py ml/tests/test_clinical_context.py
python -m mypy --follow-imports=skip ml/inference/url_policy.py ml/inference/pipeline.py ml/service/main.py ml/tests/test_service_contract.py ml/tests/test_azure_readiness.py ml/tests/test_clinical_context.py
# 4.2(B) - CURRENT: migración, Prisma y persistencia real
npm --prefix backend run test:unit -- tests/unit/inference.processor.test.ts tests/unit/ml-client.test.ts tests/schemas.test.ts
npm --prefix backend run test:integration -- tests/migrations.test.ts tests/inference-worker.integration.test.ts tests/repositories.test.ts
# Prisma validate/generate con URL sintética (sin .env real)
$env:DATABASE_URL="postgresql://user:pass@localhost:5432/clearsight_synthetic"; npx prisma validate; npx prisma generate
# 4.3(C) - CURRENT: catálogo único y processor (sin repetir migraciones B)
npm --prefix backend run test:unit -- tests/schemas.test.ts tests/unit/inference.processor.test.ts tests/unit/ml-client.test.ts tests/unit/inference-run-repo.test.ts
npm --prefix backend run test:integration -- tests/inference-worker.integration.test.ts tests/repositories.test.ts
npm --prefix backend run typecheck
```

**Resultados finales (sin fusionar históricos):** 4.1A ML **5 files / 86** (35 nuevos), `ruff`/`mypy --follow-imports=skip` limpios en 6. **4.2B pre-fix** migración **3 files / 56** (incluye migration tests; SQL/source sin cambios; no es full final); **post-fix** worker/repo **2 files / 31**. **4.3C** unit **4 files / 86** (incluye `inference-run-repo`) e integración worker/repo **2 files / 31** (9 worker + 22 repo). `typecheck`/`build` **0**. 3 regresiones proto QA: rojo pre-fix, verde post-fix.

**Casos mínimos:**

1. 4.1: allowlist vacía y HTTP sin flag ⇒ `422` antes de encolar; URL válida allowlisted ⇒ `202` sin inferencia real; esquema `file:`/`data:`/`ftp:`, hostname ausente, userinfo, fragmento raw, puerto inválido y host no allowlisted ⇒ `422` con mensaje seguro sin URL; redirect `301/302/307` bloqueado; timeout/bytes excedidos sin procesar; auth existente preservada.
2. 4.2: migración replay idempotente, CHECK de objeto, defaults `{}` en filas legacy, privilegios de `clearsight_app`; `COMPLETED` persiste `modelVersions`/`modelPredictions` completos; `REVIEW_REQUIRED` persiste parcial válido, incluido `probabilities={}` real con label/conf null y segmentación preservada; `FAILED` `{}`; CAS/duplicados no sobrescriben terminal; `GET /inferences/:id` sin exposición nueva.
3. 4.3: tres clases canónicas y casing legacy; `null`/`unknown`/`__proto__`/`constructor`/`toString` ⇒ `null` sin crash; model name `__proto__` legítimo preservado; `COMPLETED` desconocido ⇒ `FAILED` con código fijo sin label raw; `REVIEW_REQUIRED` desconocido ⇒ `predictedClass=null` con parcial preservado; predicción por modelo desconocida fail closed.

**Stop:** si el test exige runtime/modelos/descarga real, Azure/`.env`, PDF, SMTP, suite completa, commit, un framework global DNS/private-IP, verificación SAS en ML o modificar el fallback de producción para pasar.

**Criterio de salida:** QA final focal PASSED sobre 4.1-4.3, con fix proto/review y evidencia de §1.33. 4.1-4.3 quedan `[x]`; no se marca suite completa.

### 4.11 Fase específica HITO25 - 4.4/4.5 (CURRENT; QA PASSED)

**Estado:** QA PASSED sobre source intacto. 4.4/4.5 `[x]`.

**Objetivo:** verificar idempotencia obligatoria, replay exacto, resume y reanálisis canónico con foco, sin suite completa.

**Precondiciones:** fase 1 y D26/ADR-062..063 revisados; `idempotency_records` de C aplicada; PostgreSQL owned de Testcontainers o DB aislada ya verificada; sin Redis real, modelos, Azure/`.env`, SRS/PDF ni commit. No usar la DB de desarrollo compartida.

**Comandos (QA focal PASSED):**

```powershell
npm --prefix backend run test:unit -- tests/unit/idempotency.test.ts tests/unit/idempotency-repo.test.ts tests/unit/idempotency-creation-guard.test.ts tests/schemas.test.ts tests/unit/runner-isolation.test.ts
npm --prefix backend run test:integration -- tests/inference-idempotency.integration.test.ts tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts tests/identity-migrations.test.ts
npm --prefix backend run typecheck
```

**Resultados:** unit **5 files / 62 tests**; integración **5 files / 82 tests**; `typecheck` **0**. Post-corrección reviewer: unit **3 files / 16**, integración **1 file / 19** (decoy/advisory), `typecheck` **0**; build reutilizable con source intacto.

**Casos mínimos:** header ausente/vacío/whitespace/array/duplicado por comas ⇒ `400` antes de ML/fila; `401`/`403` antes del `400`; replay idéntico y `202` perdido; misma key con body/padre distinto ⇒ `409`; concurrencia misma/distinta key; `PENDING` resume y rollback DB; fallo storage/cola; `ACCEPTED` con ML/storage caídos; snapshot corrupto o contexto inconsistente; `PENDING` terminal sin enqueue; schema-qualified decoy y schema inválido; aislamiento de scope/usuario; auth revocada/ownership fresco; reanálisis congelado. Sin descargas de modelos ni Redis real: cola fake determinista y firma SDK offline ya cubierta por 3.x.

**Script E2E:** actualizar el caller para enviar `Idempotency-Key` UUID y verificar replay/`409`; **no ejecutar** `scripts/e2e-backend.ps1` contra la DB de desarrollo compartida. No inyectar el header globalmente en tests (ocultaría el caso faltante); cada POST válido existente debe enviar una key UUID explícita y los mocks de enqueue verifican body canónico/`inferenceId` real.

**Stop:** si el test exige Redis/ML/modelos reales, Azure/`.env`, PDF, suite completa, DB compartida, inyección global del header o modificar el contrato actual para pasar.

**Criterio de salida:** QA focal PASSED con evidencia; 4.4/4.5 `[x]`. Límites: 4.6/4.7/4.8/4.9 y PDF/publicación pendientes; BullMQ `removeOnComplete:1000` sin dedup eterna; PENDING resume/`ACCEPTED` replay no reencolan job tras terminal (CAS worker protege); ventana post-dispatch sin cancelación atómica; sin TTL/B3; E2E no ejecutado; `defects/regressions.md` no editado.

### 4.12 Fase específica HITO26 - 4.6/4.7/4.8 (QA PASSED)

**Estado:** 4.6/4.7/4.8 implementados, QA PASSED y cerrados `[x]`.

**Resultados:** 4.7/4.8 unit **5 files / 65 tests**, integración **3 files / 46 tests**, `typecheck` **0**; correcciones H1/H2 unit **2 files / 55 tests**, `typecheck`/`build` **0**. 4.6 unit **6 files / 96 tests** (82+14 QA), integración **4 files / 56 tests** (50+6 QA), `typecheck` **0**, `build` reutilizado; revisor sin defectos. Sin Redis real, Azure/`.env`, PDF, modelos ni suite completa.

**Objetivo:** verificar reconciliación de dispatch, cierre de reintentos/terminal y firma JIT con foco, sin Redis real ni suite completa.

**Precondiciones:** D27/ADR-064..066 y specs revisados; migración `20261121000000_inference_dispatch` aplicada en PostgreSQL owned/aislado; worker con DB real y dobles de cola/firmador/ML; sin Redis real, Azure/`.env`, modelos, PDF, DB compartida ni commit.

**Comandos (ejecutados):**

```powershell
npm --prefix backend run test:unit -- tests/unit/idempotency-repo.test.ts tests/unit/inference-dispatch.test.ts tests/unit/inference-reconciler.test.ts tests/unit/inference.worker.test.ts tests/unit/inference.processor.test.ts tests/unit/runner-isolation.test.ts
npm --prefix backend run test:integration -- tests/inference-dispatch.integration.test.ts tests/inference-creation.integration.test.ts tests/inference-idempotency.integration.test.ts tests/inference-worker.integration.test.ts
npm --prefix backend run typecheck
npm --prefix backend run build
```

**4.6:** migración y reconciliador implementados; su integración `tests/inference-dispatch.integration.test.ts` se ejecutó en el foco anterior.

**Casos mínimos:** migración replay idempotente, constraints/índice parcial y privilegios `clearsight_app`; claim con lease/`SKIP LOCKED`, lease vencido y dos réplicas; resume con firma fresca y `jobId=inferenceId`; CAS `markAccepted`; fallo de firma/cola deja `PENDING`, incrementa `dispatch_attempts`, aplica backoff y limpia lease; ejecución terminal ⇒ `ACCEPTED` sin reencolar; reencolado del mismo jobId tras retención; `failed` handler solo al agotar intentos y CAS vacío; no escritura en intento no final; `UnrecoverableError` para terminales; `429`/`5xx`/timeout/red con retry; `defaultJobOptions` 3/2s/1000/5000; `FAILED` tardío no pisa `COMPLETED`/`REVIEW_REQUIRED`; JIT re-firma antes de cada submit, ignora URL legacy si hay `storagePath`, falla retryable si faltan ambas fuentes y no llama al ML si falla la firma; logs sin URL/SAS.

**Allowlists:** añadir `tests/inference-dispatch.integration.test.ts` a `vitest.integration.config.ts` y a `INTEGRATION_INCLUDE` de `tests/unit/runner-isolation.test.ts`; mantener la sincronización de `vitest.unit.config.ts`/`vitest.config.ts` si se añaden tests unitarios explícitos.

**Stop:** si el test exige Redis/ML/modelos reales, Azure/`.env`, PDF, suite completa, DB compartida o modificar source antes de `arquitectovalidate`.

**Criterio de salida:** QA PASSED con evidencia; 4.6/4.7/4.8 quedan `[x]`. REG-002/003/004 siguen sin cierre humano.

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
- host no allowlisted, URL expirada, payload inválido, etiqueta desconocida;
- 2.2 A: `prepare` 404/no soportado, timeout 15 s, versión solicitada inexistente, respuesta con `eyeSide`/features alteradas/huella inválida, `context_mismatch` al aceptar y en `run`, request legacy sin pin, tokens/rutas fuera de la respuesta y descarga no iniciada con pin inválido.
- 4.4: header ausente/inválido/array/comas ⇒ `400` antes de ML/fila; `401`/`403` antes del `400`; replay idéntico y `202` perdido; misma key con body/padre distinto ⇒ `409`; concurrencia misma/distinta key; `PENDING` resume/rollback/fallo storage/cola; `ACCEPTED` con ML/storage caídos; snapshot corrupto; `PENDING` terminal sin enqueue; schema-qualified decoy/bad schema; retención sin purga.
- 4.5: reanálisis canónico sin alias; hash con padre; misma key+padre distinto ⇒ `409`; key nueva crea reanálisis; frozen set/consulta intactos; auth revocada/ownership fresco.

**Comandos CURRENT (baseline, no cubren todos los casos nuevos):**

```powershell
python -m pytest ml/tests/test_service.py -q
python -m pytest ml/tests/test_azure_readiness.py -q
```

**FUTURO:** tests backend/ML nuevos para los casos anteriores. Hasta que existan, se etiquetan como `FUTURO` y no se declaran ejecutados. Cualquier comando backend que use DB sigue el guard de la fase 3.

**Stop:** si un test requiere Azure real, si inyecta datos clínicos reales o si el fallo se enmascara con un mock que no reproduce el contrato.

## 7. Fase 5 — ML local real con pesos y golden tolerances

**Objetivo:** verificar readiness y estabilidad numérica con pesos locales, sin cloud.

> **2.2 A no pertenece a esta fase:** la preparación de contexto y el pin se prueban con runtime fake (`§4.5`) y no requieren pesos. No se descargan modelos para verificar `prepare`, la huella ni el mismatch. La verificación real de A usó `models_cache` locales y `OnnxClassificationRunner` sin inferencia, TF ni GPU.

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

> **Lectura de cifras:** 31/437 y 25/469 son baseline QA **pre-H1** reutilizado; 45 ML, 15 unit B y 30 integración B+ACL son foco post-H1. No se ejecutó full 469 post-H1 ni se suman como “full final”.

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
| `python -m pytest ml/tests/test_clinical_context.py -q` | CURRENT (2.2 A) | 30 passed; runtime fake, sin descarga de modelos ni cloud. |
| `python -m pytest ml/tests/test_clinical_normalization.py ml/tests/test_service.py ml/tests/test_localization.py ml/tests/test_onnx_serving.py -q` | CURRENT (2.2 A relacionados) | 12 passed; sin descarga de modelos. |
| `python -m pytest ml/tests/test_azure_readiness.py -q` | CURRENT (2.2 A relacionados) | 4 passed; `build_runtime` con fakes no exige contexto. |
| `npm --prefix backend run test:unit -- tests/unit/clinical-context.test.ts tests/unit/ml-client.test.ts` | CURRENT (2.2 B) | 13 passed; wire/hash y cliente ML inyectado, sin red. |
| Unit backend completo | CURRENT (2.2 A+B+C) | 31 files / 433 tests passed. |
| `npm --prefix backend run test:integration -- tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts tests/repositories.test.ts tests/rbac.test.ts` | CURRENT (2.2 B foco) | 4 files / 61 tests passed; B 11 tests; PostgreSQL owned. |
| `npm --prefix backend run test:unit -- tests/unit/inference.processor.test.ts tests/unit/inference.worker.test.ts tests/unit/ml-client.test.ts` | CURRENT (2.2 C) | 20 passed; processor/wiring/wire estricto sin Redis real. |
| `npm --prefix backend run test:integration -- tests/inference-worker.integration.test.ts` | CURRENT (2.2 C) | 4 passed; CAS/duplicate/race/frozen con Prisma real. |
| `npm --prefix backend run test:unit -- tests/unit/artifact-reference.test.ts tests/schemas.test.ts tests/unit/storage-service.test.ts tests/unit/storage-provider.test.ts` | CURRENT (3.3; QA PASSED) | **4 files / 84 tests** (83 + 1 QA whitespace id); parser/DTO/contexto sin SDK/red. |
| `npm --prefix backend run test:integration -- tests/inference-creation.integration.test.ts tests/clinical-access.integration.test.ts` | CURRENT (3.3; QA PASSED, re-ejecutada) | **2 files / 33 tests** tras el fix de key; args raw/gradcam y corrupto/no autorizado sin storage. |
| `npm --prefix backend run test:unit -- tests/schemas.test.ts tests/unit/artifact-reference.test.ts tests/unit/storage-service.test.ts tests/unit/storage-provider.test.ts tests/unit/runner-isolation.test.ts` | CURRENT (3.4/3.8, QA PASSED) | **5 files / 102 tests**; DTO/query/contexto row y 36 de provider. |
| `npm --prefix backend run test:integration -- tests/artifact-downloads.integration.test.ts tests/clinical-access.integration.test.ts tests/rbac.test.ts tests/inference-creation.integration.test.ts` | CURRENT (3.4, QA PASSED) | **4 files / 60 tests**; nuevo archivo **16 tests** (+4 QA); PostgreSQL owned, sin Azure/Azurite. |
| Cierre 3.8 | QA PASSED | 3.2 SDK real offline + 3.4 auth/missing/storage/version; sin Azure ni Azurite. |
| `python -m pytest ml/tests/test_service_contract.py ml/tests/test_service.py ml/tests/test_clinical_context.py ml/tests/test_azure_readiness.py ml/tests/test_clinical_normalization.py -q` (4.1A) | **CURRENT (QA PASSED)** | **5 files / 86 tests passed**; 35 nuevos; sin full ML, Azure ni descarga real de modelos. |
| `python -m ruff check ...` / `python -m mypy --follow-imports=skip ...` (4.1A) | **CURRENT** | Limpios en los 6 archivos afectados. |
| Pre-fix B: `npm --prefix backend run test:unit -- tests/unit/inference.processor.test.ts tests/unit/ml-client.test.ts tests/schemas.test.ts` | **BASELINE** | **3 files / 59**; no es full final; cierre post-fix unit **4 files / 86** en fila 4.3C. |
| Pre-fix B: `npm --prefix backend run test:integration -- tests/migrations.test.ts tests/inference-worker.integration.test.ts tests/repositories.test.ts` | **BASELINE** | **3 files / 56** incluye migration tests; SQL/source sin cambios; cierre post-fix worker/repo **2 files / 31**. |
| `prisma validate` + `prisma generate` con URL sintética (4.2B) | **CURRENT** | Schema válido y cliente generado; sin `.env` real. |
| `npm --prefix backend run test:unit -- tests/schemas.test.ts tests/unit/inference.processor.test.ts tests/unit/ml-client.test.ts tests/unit/inference-run-repo.test.ts` (4.3C) | **CURRENT (QA PASSED)** | **4 files / 86 tests passed**; catálogo único, aliases legacy, prototipos, repo schema validation/desconocido y predicciones por modelo. |
| `npm --prefix backend run test:integration -- tests/inference-worker.integration.test.ts tests/repositories.test.ts` (4.3C) | **CURRENT (QA PASSED)** | **2 files / 31 tests passed**; 9 worker + 22 repo, sin repetir migraciones B. |
| QA focal unit 4.4/4.5: idempotency/idempotency-repo/idempotency-creation-guard/schemas/runner-isolation | **CURRENT (QA PASSED)** | **5 files / 62 tests**. |
| QA focal integración 4.4/4.5: inference-idempotency/inference-creation/clinical-access/rbac/identity-migrations | **CURRENT (QA PASSED)** | **5 files / 82 tests**. |
| Post-corrección reviewer: unit/integration | **CURRENT (QA PASSED)** | Unit **3 files / 16**; integración **1 file / 19** (decoy/advisory); `typecheck` **0**; build reutilizable. |
| `scripts/e2e-backend.ps1` con `Idempotency-Key` (4.4) | FUTURO / NO EJECUTAR | Solo actualizar el caller; no correr contra la DB de desarrollo compartida. |
| Unit 4.6-4.8: reconciler/failed-handler/processor/queue-options/worker + runner-isolation | **CURRENT QA PASSED (HITO26)** | 4.7/4.8 **5 files / 65**; H1/H2 **2 files / 55**; 4.6 **6 files / 96** (82+14 QA); sin Redis real. |
| Integración 4.6-4.8: dispatch + worker con PostgreSQL real | **CURRENT QA PASSED (HITO26)** | 4.7/4.8 **3 files / 46**; 4.6 **4 files / 56** (50+6 QA); Testcontainers/DB aislada, sin Redis/Azure. |
| E2E Azure completo | FUTURO | Requiere B6 confirmado y cleanup. |
| Benchmark p95 full-flow | FUTURO | Requiere script y entorno aprobado. |

## 11. Disciplina de entrega por fase

1. **Autoverificación:** ejecutar primero los comandos focalizados de la fase y los checks del brief; ampliar solo si el riesgo lo exige.
2. **Fallo = stop:** si un test falla, no se hace commit de esa fase; se corrige o se reporta bloqueo con comando y error exactos.
3. **Baseline:** los errores preexistentes se registran como baseline; no se presentan como éxito ni se “arreglan” fuera del alcance.
4. **QA independiente:** las tareas de alto riesgo (migraciones, auth/sesiones, storage dual, PDF, Azure) requieren revisión independiente además de la autoverificación.
5. **Commit/push:** la autorización global del usuario para commits/push ya está dada; no se pide de nuevo por fase. Este runbook no commitea por sí mismo; el orquestador/commit posterior se hará cuando corresponda. Solo se commitea documentación/pruebas verificadas de una tarea coherente; tests fuente futuros por hito.
6. **Sin atajos:** no se usa un mock para declarar un E2E real, no se usa el nombre `test` como guard y no se lee `.env.azure`.
