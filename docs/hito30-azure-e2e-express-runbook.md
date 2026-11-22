# HITO 30 — Runbook del despliegue Azure real en tier express (E2E PASSED)

> **Estado:** QA PASSED. Cierre documental; sin source/test edits, reruns de suites ni commit desde este runbook.
> **Alcance:** despliegue real en una cuenta Azure for Students (región `northcentralus`) cuyo entorno de
> Container Apps es de tier **`express`** (HTTP-only) y ejecución del E2E clínico completo contra ese entorno.
> **Resultado:** pipeline clínico en verde; `export` SKIPPED por falta de grant (esperado en un run API-only).
> Teardown limpio (`ResourceGroupNotFound`), sin recursos Azure residuales.
> **No resuelve** REG-002/003/004/008; el cierre de regresiones sigue siendo humano.

## 1. Arquitectura resultante

Un run aislado identificado por `clearsight-<runId>` y tags `project`/`runId`/`owner`/`expiresAt`/`managedBy`
en todos los recursos:

| Recurso | Detalle |
|---|---|
| Resource group | `clearsight-<runId>`; el manifest registra si fue creado por el run. |
| Blob Storage | Cuenta con contenedores `raw-retinas`, `gradcam-overlays`, `segmentation-masks`, `segmentation-overlays`, `clinical-reports` y `models`. |
| Azure Container Registry | Basic, con **4 imágenes SHA**: `backend`, `worker`, `ml-service`, `frontend`. |
| PostgreSQL Flexible Server | Base `clearsight` + firewall `AllowAzureServices`. `DATABASE_URL` con `sslmode=require`. |
| Container Apps environment | Tier **`express`** (HTTP-only; escala a cero). |
| `ml-service` | Ingress externo HTTP en `8000`, `--transport http`, `min-replicas 0`. |
| `backend` | Ingress externo HTTP en `8000`, `--transport http`, `min-replicas 1`. |
| `worker` | Sin ingress; `min-replicas 1`, `max-replicas 1`. |
| `frontend` | Ingress externo HTTP en `3000`, `min-replicas 0`. |

No se aprovisiona Redis. El backend y el worker usan la cola PostgreSQL y el servicio ML corre con cola en
memoria (`ML_REDIS_URL` nunca se define). Las imágenes se referencian con el `loginServer` del ACR
(`<acr>.azurecr.io/clearsight-<componente>:<sha>`).

## 2. Flujo migrate-on-startup

El tier express no soporta Container Apps Jobs, así que la migración y el bootstrap del administrador se
mueven al arranque del contenedor de backend (`docker/backend-entrypoint.sh`):

1. `npm run prisma:deploy` aplica las migraciones con el wrapper auditable.
2. Si existen `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`, ejecuta `npm run admin:bootstrap`. Un
   error `BOOTSTRAP_ALREADY_INITIALIZED` es idempotente y se ignora; cualquier otro error aborta el arranque.
3. `exec npm start` inicia el servidor.

Esto elimina los Jobs `prisma:deploy` y `admin:bootstrap` del despliegue y hace que el backend sea el único
punto que toca el esquema en cada arranque.

## 3. Cola PostgreSQL y worker keep-alive

- La tabla durable `inferences` **es** la cola: reclamo con `SELECT ... FOR UPDATE SKIP LOCKED`, lease de
  300 s (`process_lease_until`), backoff exponencial y CAS terminal. `enqueueInference` solo marca la fila due.
- `startInferenceWorker()` corre en el mismo proceso el poller PostgreSQL y el reconciliador de
  dispatch/publicación. No hay BullMQ ni conexión a Redis; `REDIS_URL` queda opcional y sin uso.
- El proceso del worker se mantiene vivo con un keep-alive con referencia (intervalo ref'd). **No** se usa
  `timer.unref()`: un timer no referenciado dejaba drenar el event loop y el poller nunca corría.

## 4. Modelos empaquetados en la imagen ML

- `docker/ml-service.Dockerfile` copia `models_cache` a `/models`; el runtime no descarga modelos desde
  HuggingFace ni depende de disco efímero adicional.
- `ML_INFERENCE_BACKEND=pytorch`, `ML_DEVICE=cpu`, `ML_MODEL_CACHE_DIR=/models` y
  `ML_MANIFEST_PATH=/app/ml/models/manifest.json`.
- Se usa el backend PyTorch porque los artefactos `.onnx` no se aprovisionaban en este entorno.

## 5. Evidencia E2E PASSED (API-only)

`scripts/e2e_azure_pipeline.ps1` ejecutó el flujo clínico completo contra el backend real:

| Paso | Resultado |
|---|---|
| `negative-auth` | `401` en `GET /inferences/<uuid>` sin Bearer. |
| `login-admin` / `create-doctor` / `login-doctor` | Admin autenticado y oftalmólogo provisionado vía `POST /admin/users`. |
| `create-patient` / `create-consultation` | Paciente pseudonimizado y consulta creados. |
| `upload-image` | Subida multipart, imagen sanitizada, `eyeSide` preservado. |
| `create-inference` / `poll-inference` | `202 QUEUED` con `Idempotency-Key` y avance a `COMPLETED`. |
| `artifacts` | `mask` y `overlay` **AVAILABLE**. |
| `reports` | PDF **AVAILABLE** (versión 1). |
| `artifact-urls` / `downloads` | URLs firmadas y descarga validada como PNG (mask/overlay) y `%PDF-` (reporte). |
| `feedback` | Feedback clínico persistido (`validated_class`/`is_gold_standard` preservados). |
| `delivery-recheck` | Estado de entrega consistente con los artefactos. |
| `export` | **SKIPPED** (`403`, sin grant); esperado en el run API-only. |

El reporte del run queda en el directorio de salida del E2E (steps, checks e IDs seguros; sin secretos,
tokens ni URLs firmadas).

## 6. Diagnóstico de fallos típicos en tier express

| Síntoma | Causa | Mitigación |
|---|---|---|
| `(ExpressEnvironmentResourceNotSupported)` al crear Jobs, ingress TCP, workload profile dedicado, init container o sidecar | El tier express no soporta esas capacidades | Usar ingress HTTP, migrate-on-startup, cola PostgreSQL y keep-alive; no depender de Jobs/sidecars. |
| Pull de imagen falla o se despliega una imagen equivocada | Nombre sin prefijo del ACR (`clearsight-backend:<sha>`) | Nombre totalmente calificado `<acr>.azurecr.io/clearsight-<componente>:<sha>`. |
| El worker arranca y sale de inmediato; inferencias quedan `QUEUED` | Timer `unref()` drena el event loop y el poller no corre | Keep-alive con referencia; no `unref()` en el proceso standalone. |
| El worker se detiene por escala a cero o pierde secretos | `min-replicas 0` y falta de `JWT_SECRET`/`EXPORT_HMAC_SECRET` | `min-replicas 1` y secretos `JWT/HMAC` en el worker. |
| ML sin modelos / intento de descarga en runtime | Los modelos no estaban en la imagen y no hay disco/runtime download | Empaquetar `models_cache` en `/models` (`COPY models_cache /models`). |
| Error de ML por `strict_content_type` o pin incompatible | `strict_content_type` requiere FastAPI>=0.132 | Pines alineados de `fastapi`/`pydantic`/`uvicorn`. |
| `az` reporta fallo aunque el comando nativo tuvo éxito | stderr nativo bajo `ErrorActionPreference=Stop` | Manejo explícito del stderr de `az` en el script de deploy. |
| Runtime ML exige ONNX no aprovisionado | Artefactos `.onnx` no disponibles en el entorno | `ML_INFERENCE_BACKEND=pytorch`. |

## 7. Los 8 fixes del hito

| Commit | Cambio |
|---|---|
| `e919073` | Backend ML a PyTorch (los `.onnx` no se aprovisionaban). |
| `0dc0b32` | Manejo del stderr nativo de `az` bajo `ErrorActionPreference=Stop`. |
| `e95ba96` | migrate-on-startup: elimina los Jobs `migrate`/`bootstrap` (tier express). |
| `94c98ef` | Nombres de imagen totalmente calificados con el `loginServer` del ACR. |
| `1154869` | Pines `fastapi`/`pydantic`/`uvicorn` alineados (`strict_content_type` requiere FastAPI>=0.132). |
| `56c3bc4` | Modelos empaquetados en la imagen ML para evitar descarga runtime sin disco. |
| `79a5e98` | Secretos JWT/HMAC y `min-replicas 1` en el worker. |
| `1680c1a` | Keep-alive del worker: se quitó `timer.unref()` que vaciaba el event loop. |

## 8. Operación y verificación

```powershell
# Manifest del run (sin secretos)
Get-Content artifacts/azure-runs/<runId>/manifest.json

# Logs seguros del worker / backend
az containerapp logs show --name clearsight-<runId>-worker --resource-group clearsight-<runId> --tail 100
az containerapp logs show --name clearsight-<runId>-backend --resource-group clearsight-<runId> --tail 100

# Cola PostgreSQL (ajustar schema si no es public)
#   SELECT status, process_attempts, next_process_at, process_lease_until
#     FROM public.inferences ORDER BY next_process_at LIMIT 20;

# Teardown y verificación de residuos
pwsh ./scripts/teardown_azure.ps1 -ManifestPath artifacts/azure-runs/<runId>/manifest.json
```

Tras el teardown, una comprobación del resource group responde `ResourceGroupNotFound` (sin residuos).

## 9. Límites explícitos

1. El entorno es **tier express**: no soporta Jobs, ingress TCP, workload profiles dedicados, init
   containers ni sidecars; escala a cero. Las mitigaciones (migrate-on-startup, cola PostgreSQL, keep-alive,
   `min-replicas 1` donde se requiere) son funcionales, no equivalen a un tier dedicado.
2. `export` se omitió por falta de grant (`403`); no se declara cobertura de export en este run.
3. Este hito no resuelve REG-002/003/004/008; `defects/regressions.md` no se edita y el cierre es humano.
4. No se cambia código fuente ni tests: este documento solo registra el despliegue y su operación.
