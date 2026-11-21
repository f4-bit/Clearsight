# HITO18 - Snapshot clínico inmutable (2.1)

> **Estado:** **QA PASSED HITO18**. La tarea 2.1 queda `[x]` en `tasks.md`. QA focal proporcional sin full integration nueva. Cierre solo documental: sin source/test edits, sin reruns, sin commit/push. No incluye 2.2, auth, worker, endpoints, migraciones, cambios de schema ni backfill legacy.

## 1. Alcance

- Schema de entrada en `backend/src/schemas/clinical.ts`.
- Nuevo repositorio `backend/src/repositories/clinical-snapshot.repo.ts`.
- Exposición `repos.snapshots` en `backend/src/repositories/index.ts`.
- Tests permanentes en `backend/tests/schemas.test.ts` (unit) y `backend/tests/repositories.test.ts` (integration).
- Sin cambios en `backend/prisma/schema.prisma`, migraciones, `docker/init.sql` ni baseline.

## 2. Contrato implementado

`createClinicalSnapshotRepository(db)` acepta `PrismaClient | Prisma.TransactionClient` y expone:

- `create(input)`: valida antes de DB y devuelve la fila Prisma persistida.
- `findById(id)`: UUID inválido o fila ausente devuelven `null`.

El schema exige:

- `consultationId` UUID.
- `rawPayload` y `normalizedPayload` objetos JSON obligatorios e independientes.
- `schemaVersion` string explícito, no vacío, máximo 128 caracteres (sin default inventado).
- `modelVersions` objeto JSON, default `{}` (“no resuelto”), con valores anidados permitidos.
- Objeto estricto: rechaza campos desconocidos como `sources`, `sourceRevision`, `corrections` o hash.

La validación JSON recorre objetos y arrays anidados de datos planos tipados y no coerciona: rechaza `undefined`, `NaN`, `Infinity`, funciones, `bigint`, `Date`, `Map`, `Set`, objetos no planos y ciclos. No se normaliza el payload ni se infieren unidades, revisiones o versiones. El consumo real corresponde a 2.2.

## 3. Inmutabilidad y transacciones

- `create` no muta el input ni devuelve un alias: la fila se serializa en la misma operación DB.
- Cambiar `consultations.clinical_data` o mutar el objeto de entrada después del insert no altera el snapshot.
- El mismo factory funciona con un cliente de transacción; si la TX falla, el snapshot revierte con ella.
- `clearsight_app` no puede `UPDATE`/`DELETE` la tabla; el trigger existente rechaza además `UPDATE`/`DELETE` del owner.
- No se declara inmutabilidad frente a superuser/DDL/TRUNCATE. `resetDb` usa el `TRUNCATE ... CASCADE` del owner y se verificó que alcanza `clinical_snapshots` sin relajar guards.

## 4. Evidencia QA HITO18 (PASSED)

| Comando / evidencia | Resultado final |
|---|---|
| `npm --prefix backend run test:unit -- tests/schemas.test.ts` | **25 tests** (2 nuevos de QA) |
| `npm --prefix backend run test:integration -- tests/repositories.test.ts` | **22 tests**; 4 asserts reforzadas para esperar `ZodError` |
| `npm --prefix backend run test:integration -- tests/migrations.test.ts` | **25 tests** |
| `npm --prefix backend run test:unit` | **27 files / 405 tests** |
| `npm --prefix backend run typecheck` | **0**, ejecutado después de los tests de QA |
| `npm --prefix backend run build` | **0**, reutilizado del mismo source |
| Docker/cleanup | **0** contenedores/volúmenes propios residuales; `redkeep_db` ajeno intacto |

- QA no ejecutó una full integration nueva: foco proporcional sobre schemas, repositorio y migraciones de snapshot.
- El cierre documental no edita source/tests ni relanza suites; registra la evidencia QA proporcionada.
- No se usó Azure, proxy, frontend, `.env` reales, SRS, PDF ni commit/push.

## 5. Límites

- Tarea 2.1 cerrada como `[x]` con QA PASSED HITO18.
- Sin `list`, endpoints, ownership HTTP, cache global, update/delete ni transacción propia.
- Sin migración, cambio de schema, backfill legacy ni fake snapshot cuando `modelVersions` es `{}`.
- Sin normalización funcional, unidades inferidas ni nuevas fuentes/versiones de modelo.
- **Límites QA:** datos JSON planos tipados; profundidad patológica y getters de objetos JS (no HTTP) no cubiertos aún como hardening. No se promete protección universal.
- 2.2 sigue pendiente; Azure/provider/email real siguen pendientes.
- No se reescribió documentación histórica de 5.8/5.9; no había encabezados actuales obsoletos que corregir.
