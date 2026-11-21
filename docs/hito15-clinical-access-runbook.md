# HITO 15 - Runbook real de privacidad clinica y grants (5.2)

> **Alcance:** ownership clinico por medico, grants explicitos por inferencia y export acotado.
> Ejecutado sobre `feat/backend-ml-consolidation` (base `ed35447`), sin commit ni push desde este agente.
> No se uso Azure, `.env.azure`, base de produccion, PHI, correos reales, DB externa ni upgrades de
> dependencias/frontend/ML. Solo PostgreSQL 16 efimero/owned de Testcontainers.

## Invariantes aprobados

- Solo `OFTALMOLOGO` escribe clinica (pacientes, consultas, upload, inferencias, feedback). `ADMIN` e
  `INVESTIGADOR` nunca escriben clinica aunque tengan un grant.
- Un grant es de lectura y se limita a una inferencia concreta: `read_result`, `read_artifacts`,
  `read_pdf`, `can_export_gold_standard`. No hereda al hijo de reanalisis ni a otra inferencia.
- `ADMIN`/`INVESTIGADOR` no acceden a `Patient` ni a `Consultation` (403); solo al resultado/artefacto/PDF
  aprobado de la inferencia exacta. `OFTALMOLOGO` solo ve sus propios casos; el grant de otro medico se
  ignora y el rol de doctor no puede ser receptor de un grant.
- El owner del paciente es una asignacion de acceso server-side, nunca un creador fabricado. Una vez
  asignado no se reasigna; un NULL legacy solo puede recibir la primera asignacion controlada.
- El backfill legacy solo asigna owner cuando TODAS las consultas asociadas apuntan a un unico
  `OFTALMOLOGO`. Mezclas, huerfanos y otros roles quedan NULL. No se reescribe JSON clinico, estado,
  hash, CDR, autorias ni se inventan snapshots.
- La exportacion exige al menos un grant activo `can_export_gold_standard` y se filtra por pares
  `(inferenceId, consultationId)` aprobados ANTES de `since`/`limit`; una lista vacia exporta cero, nunca
  todo el dataset. El ETL offline es el unico modo `trusted-offline` global.
- `POST /inferences` no acepta PK del cliente: `inferenceId` e `imageUrl` son campos desconocidos (`400`)
  y el servidor genera siempre el `inferenceId` con `randomUUID()`. La `Idempotency-Key` obligatoria de D7
  es futura y **no** esta implementada; no se sustituye con un ID de cliente.

## Migracion

`backend/prisma/migrations/20261119010000_clinical_access/migration.sql`

- `patients.owner_doctor_id UUID NULL` + FK `RESTRICT` + indice; trigger de inmutabilidad una vez no-NULL.
- `inference_access_grants` con `inference_id` (FK RESTRICT), `consultation_id` capturado (FK RESTRICT),
  `recipient_user_id` (FK CASCADE), `approved_by_user_id` nullable (FK SET NULL), `approval_reference`
  acotado y no-URL, `expires_at` obligatorio > `created_at`, flags con al menos uno activo.
- Trigger INSERT: bloquea inferencia e imagen `FOR SHARE`, valida que la consulta capturada coincide con
  la imagen autoritativa y que receptor es ADMIN/INVESTIGADOR (aprobador, si existe, ADMIN activo).
- Trigger UPDATE: terminos inmutables; `revoked_at` append-only `NULL -> timestamp >= created_at`.
- Trigger UPDATE de `inferences`: con cualquier historial de grant (incluido revocado/expirado) se rechaza
  cualquier cambio real de las columnas de la propia fila `inferences` (imagen/contexto/snapshot/reanalisis).
  Este trigger **no** anade un guard nuevo sobre la fila padre `images`: una mutacion SQL privilegiada del
  padre queda fuera de E y solo la cubre el guard de reparentado existente de D cuando aplica. No hay writer
  de aplicacion que mueva imagenes en este hito.
- Trigger UPDATE de `consultations`: `patient_id`/`doctor_id` inmutables tras crear (upsert del mismo valor
  sigue permitido).
- Rol `clearsight_app`: solo `SELECT` y `UPDATE (revoked_at)` sobre la tabla nueva; sin `INSERT`, `UPDATE`
  de otros campos, `DELETE`, `TRUNCATE`, `TRIGGER` ni `REFERENCES`.

## Cierre QA final (fuente sin cambios)

> QA ejecuto el full sobre la fuente final sin cambios. Esta es la evidencia de cierre. Los conteos focales de la correccion se conservan abajo, claramente etiquetados como historicos.

| Fase | Comando | Resultado |
|---|---|---|
| Unit final QA | `npm --prefix backend run test:unit` | **21 files / 355 tests passed (3.06 s)** |
| Integration final QA | `npm --prefix backend run test:integration` | **20 files / 380 tests passed (235.17 s)** |
| Diff check | `git diff --check` | limpio (solo warnings CRLF preexistentes) |
| Docker/cleanup | `docker ps -a` | solo `redkeep_db` detenido no relacionado; cero contenedores propios residuales |
| Typecheck/build | runs verdes reutilizados del mismo estado, inspeccionados por QA | exit 0 |

## Cierre de hallazgos del reviewer

- **H-01 resuelto:** `POST /inferences` elimino `inferenceId` del DTO HTTP (`.strict()`); fresh/own/foreign reciben un `400` identico antes de writes/sign/queue; sin el campo se genera UUID de servidor y se devuelve `202`. La matriz de regresion vive en `tests/clinical-access.integration.test.ts`; no queda oraculo de existencia cross-case ni colision de PK de cliente.
- **H-02 latente documentado:** la migracion E congela columnas de la fila `inferences`; no agrega trigger sobre `images`. Una mutacion SQL privilegiada del padre queda fuera de E y solo la cubre el guard D existente cuando aplica; no hay writer de aplicacion para mover imagenes.
- **H-03 validado / worker diferido:** produccion resuelve `DATABASE_URL` una sola vez en `app.ts` y las rutas/servicio clinico comparten el mismo `prisma`+access inyectado. No se refactoriza el factory global ni el worker en este hito; quedan diferidos.

## Historico de la correccion acotada H-01/H-02 (pre-QA final)

| Fase | Comando | Resultado |
|---|---|---|
| Typecheck | `npm --prefix backend run typecheck` | exit 0 |
| Build | `npm --prefix backend run build` | exit 0 |
| Unit/schema focalizado | `npm --prefix backend run test:unit -- tests/schemas.test.ts tests/unit/export-policy.test.ts tests/unit/runner-isolation.test.ts tests/unit/db-ownership.test.ts` | **4 files / 41 tests passed** |
| Integracion focalizada | `npm --prefix backend run test:integration -- tests/clinical-access.integration.test.ts tests/clinical-access-migrations.test.ts tests/repositories.test.ts` | **3 files / 44 tests passed** |

> La correccion H-01 sustituyo el caso de "duplicate explicit inferenceId" por la matriz fresh/own/foreign
> 400 identico + ausencia 202 con UUID de servidor. H-02 solo ajusto comentario/documentacion; no se anadio
> ningun trigger nuevo. El test de cliente inyectado de QA se conserva.

## Matriz source-test 5.2

| Source | Cobertura | Resultado |
|---|---|---|
| `backend/src/services/clinical-access.ts` | rol antes de query, owner de paciente/consulta/imagen, lectura de inferencia por owner o grant activo, redaccion de gradcam, scope de export | `tests/clinical-access.integration.test.ts` |
| `backend/src/routes/patients.ts`, `consultations.ts`, `inferences.ts` | strict body, owner server-side, 403/404 uniformes, eyeSide explicito, rechazo de `imageUrl`/`inferenceId`, UUID de servidor, 422 previo a create/sign/queue | cubierto por el foco ACL/migracion (historico) y por el full final QA |
| `backend/src/routes/feedback.ts`, `services/gold-standard-export.ts`, `repositories/feedback.repo.ts` | export por pares aprobados, filtro antes de since/order/take, grants expirados/revocados/flag insuficiente | `tests/export.route.test.ts`, `tests/rbac.test.ts` |
| `backend/src/services/admin-users.ts` | revocacion de grants en la misma tx al cambiar rol o estado activo; email/credencial no revoca | `tests/clinical-access.integration.test.ts` + `tests/user-lifecycle.integration.test.ts` |
| `backend/prisma/migrations/20261119010000_clinical_access/migration.sql` | backfill determinista, inmutabilidad, FK/checks, ACL efectiva, replay estable | `tests/clinical-access-migrations.test.ts` |
| `backend/scripts/etl-feedback.ts` + `services/export-policy.ts` | modo offline global explicito, columnas/neutralizer intactos, guard HMAC en produccion | `tests/etl.test.ts` + unit |

## Limites conocidos (no se declaran resueltos)

- 1.7 (parser legacy, hashes, cursor) sigue pendiente.
- 3.2 (storage provider), 4.x (orquestacion), 2.x (snapshots completos) y 6.x (PDF) siguen pendientes.
- 9.7 (descubrimiento de IDs autorizados) y el watermark con empate de timestamp (`since >`) siguen en su
  hito; no se corrigieron aqui.
- Los grants se aprovisionan por operador offline sobre DB confiable; no hay endpoint HTTP de creacion,
  aprobacion ni self-service, y el flujo de gobierno real (B4) sigue pendiente de produccion.
- El trigger de identidad de E congela columnas de la fila `inferences`, no la fila padre `images`. Una
  mutacion SQL privilegiada del padre queda fuera de ese trigger; no se anadio un guard nuevo y no hay
  writer de aplicacion para mover imagenes.
- `POST /inferences` usa siempre un UUID de servidor y rechaza `inferenceId`/`imageUrl`. La idempotencia
  persistida con `Idempotency-Key` (D7) sigue pendiente y no debe simularse con un PK de cliente.
- No se declara anonimizacion por HMAC ni cumplimiento legal; HMAC es seudonimizacion.
- Release clinica completa **no** declarada lista.
