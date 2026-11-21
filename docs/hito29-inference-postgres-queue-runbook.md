# HITO 29 - Runbook de la cola de inferencia PostgreSQL (task 4.11)

> **Estado:** QA PASSED. Cierre documental; sin source/test edits, reruns ni commit desde este runbook.
> **Alcance:** sustituir BullMQ/Redis por la tabla durable `inferences` como cola de inferencia, conservando el processor DI, la reconciliación 4.6, la publicación 3.6 y la firma JIT 4.8.

## 1. Cambio de transporte

- La cola ya no es BullMQ ni Redis. `enqueueInference` conserva su firma para call-sites, pero solo marca la fila `QUEUED` como due (`next_process_at=now()`); no importa `bullmq`/`ioredis` ni abre conexiones.
- `startInferenceWorker()` arranca en el mismo proceso el reconciliador de dispatch/publicación y un poller PostgreSQL no bloqueante. El `jobId` público sigue siendo `inferenceId`.
- `REDIS_URL` queda opcional y sin uso: el backend arranca sin Redis. No se requieren cambios de frontend.

## 2. Modelo de datos y semántica

Migración aditiva/idempotente `backend/prisma/migrations/20261124000000_inference_process_queue/migration.sql`:

| Columna | Uso |
|---|---|
| `process_attempts INTEGER NOT NULL DEFAULT 0 CHECK >= 0` | Intentos consumidos. |
| `next_process_at TIMESTAMPTZ NOT NULL DEFAULT now()` | Momento en que la fila es elegible. |
| `process_lease_until TIMESTAMPTZ` | Lease explícito del poller que la reclamó. |

Índice parcial `idx_inferences_process_queue (next_process_at) WHERE status='QUEUED'`.

Flujo:

1. `POST /inferences` crea la ejecución `QUEUED` con `next_process_at` due.
2. `enqueueInference` solo la marca due si `status='QUEUED'` y no tiene lease vivo; nunca re-arma una fila en procesamiento.
3. El poller reclama hasta 4 filas con `SELECT ... FOR UPDATE SKIP LOCKED` sobre `QUEUED`, due y sin lease; en la misma sentencia fija `process_lease_until=now()+300s`.
4. Carga `findExecution`, reconstruye el job desde snapshot/storagePath y ejecuta el processor sin cambios.
5. Terminal `COMPLETED`/`REVIEW_REQUIRED` lo persiste el processor (CAS) y el poller solo limpia el lease. No se muta `consultation.status`.
6. Error retryable: `process_attempts++`, `next_process_at=now()+2s·2^attempts` (cap 120 s) y `process_lease_until=NULL`; sigue `QUEUED`.
7. Tercer intento agotado o error terminal: `FAILED` por CAS y limpieza de lease.

## 3. Operación y diagnóstico

```bash
# Migración
cd backend
npm run prisma:deploy

# Worker (poller + reconciliador en el mismo proceso)
npm run worker

# Chequeos sin Redis
env | Select-String REDIS_URL   # opcional; ausente es válido
```

Consulta de observabilidad segura (sin URLs/PHI). Ajustar el schema si no es `public`:

```sql
SELECT status, process_attempts, next_process_at, process_lease_until
  FROM public.inferences
 WHERE status = 'QUEUED'
 ORDER BY next_process_at
 LIMIT 20;
```

- Filas con `process_lease_until` futuro están reclamadas; no deben re-armarse.
- Filas `QUEUED` con `next_process_at` futuro están en backoff.
- Filas `FAILED` no vuelven a reclamarse.

Logs esperados (seguros): `[Worker] PostgreSQL inference poller started`, `[Worker] Inference completed`, `[Worker] Inference processing issue` con `code`/`inferenceId`/`attempt`/`errorCode`. No se imprimen URLs, SAS, PHI ni credenciales.

## 4. Invariantes conservados

- Inferencia asíncrona y processor DI (4.2/4.3/4.8) sin cambios.
- Reintentos acotados con backoff y timeout; terminal sin reintento.
- Reconciliación de dispatch 4.6 y publicación 3.6 en el mismo worker.
- Firma JIT desde `storagePath`; el payload nuevo no lleva `imageUrl`.
- CAS terminal: `COMPLETED`/`REVIEW_REQUIRED` no se sobrescriben.
- Idempotencia de dispatch y `jobId=inferenceId`.
- `REDIS_URL` opcional; sin Redis real en tests.

## 5. Límites explícitos

1. **Fencing residual:** si el lease de 300 s expira mientras el processor original sigue vivo, otro poller puede reclamar y repetir trabajo. Es solo desperdicio: el CAS terminal garantiza un único resultado. Un finisher tardío puede limpiar el lease de un reclamante nuevo porque no hay `lease_id` por intento; no se añadió para no cambiar las firmas acordadas.
2. **Legacy sin snapshot:** una fila `QUEUED` sin snapshot termina `FAILED invalid_job_context`; la cola ya no almacena `clinicalFeatures`.
3. **Schema:** `enqueueInference` usa el `prisma` global y el schema `public`. Un despliegue con schema no-public requiere una inyección schema-bound (pendiente).
4. **Regresiones:** REG-002/003/004/008 **no** se declaran resueltos; el cierre es humano y `defects/regressions.md` no se edita.

## 6. Evidencia QA HITO29

| Verificación | Resultado |
|---|---|
| Unit | **46 files / 714 tests** |
| Integración | **32 files / 600 tests** |
| `typecheck` | **0** |
| `build` | **0** |
| Docker | limpio (`redkeep_db` ajeno intacto) |

Foco: `tests/unit/inference.worker.test.ts` e `tests/inference-poller.integration.test.ts` (claim concurrente, lease, `markReady` sin re-armar, backoff 2/4/8/120 s, agotamiento, terminal, JIT, migración). Sin full suite adicional, Redis real, Azure/`.env`, PDF/ML reales, modelos ni commit.
