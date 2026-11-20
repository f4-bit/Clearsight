# Design: consolidate-backend-ml-azure

## Context

El repositorio contiene un backend Node/Fastify, un servicio ML Python/FastAPI, PostgreSQL con Prisma, Redis/BullMQ, MinIO y piezas de Azure. La rama activa parte de `origin/feat/backend-core` (`ce2b8c8`) y contiene los fixes ML `ded48db` y `92a6887`. `e5d184a` pertenece solo a `master` y es un subconjunto de trabajo ML; no se asume que deba cherry-pickearse a ciegas ni que forme parte de esta rama. El frontend existe, pero **no se implementa ni se modifica en este change**; los mocks actuales no son fuente de verdad.

La consolidación busca una fuente de verdad documental y verificable. La evidencia estática revisada muestra brechas concretas:

- El servicio ML crea buckets solo en MinIO, pero los dos caminos de arranque lo invocan sin distinguir Azure: `ml/service/storage.py:59-70`, `ml/service/storage.py:95-166`, `ml/service/queue.py:84,157`.
- El worker backend solo espera `COMPLETED`/`FAILED`, ignora `REVIEW_REQUIRED`, persiste un subconjunto del resultado y marca la consulta como `COMPLETED` de forma prematura: `backend/src/workers/inference.worker.ts:33-47,67,74-83,91-95`.
- El repositorio sí soporta más campos de resultado que los que el worker escribe: `backend/src/repositories/inference.repo.ts:30-45`.
- El alta de usuarios es pública y acepta el rol enviado por el cliente: `backend/src/routes/auth.ts:18-60`; la autenticación no comprueba `isActive`: `backend/src/middleware/auth.ts:12-24`.
- La migración cae a `prisma migrate resolve --applied 0_init` de forma indiscriminada: `docker/migrate.Dockerfile:18`.
- Las rutas clínicas de lectura no aplican ownership completo: `backend/src/routes/consultations.ts:173-229`, `backend/src/routes/inferences.ts:93-143`.
- No existe `defects/regressions.md` en la rama; este change crea el registro como primera tarea documental cuando aporta valor, sin inventar runtime.

El SRS `SRS ClearSight.pdf` es un archivo local no trackeado del usuario. El arquitecto lo leyó completo mediante la herramienta de lectura en un turno anterior; sus requisitos RF/HU se citan desde esa lectura y el PDF **no se incluye, versiona ni modifica**. No se añade un hash al change para evitar confundir trazabilidad documental con versionado; la fuente sigue siendo el archivo local del usuario.

Las specs bajo `openspec/specs/` también están ignoradas y no trackeadas (`git ls-files -- openspec/specs` vacío); los archivos de este change sí están trackeados. Se consultaron solo como contexto local para redactar requisitos y no son baseline oficial ni dependencia de entrega. Por eso `azure-deployment-automation`, `azure-readiness-and-init-sql` y `ml-serving-optimization` se empaquetan como capacidades **iniciales** con `ADDED Requirements` completos; un clon limpio no necesita esos archivos locales para validar o archivar el change.

## Goals / Non-Goals

**Goals:**

1. Fijar un contrato único para paciente, consulta y ejecución, incluyendo lateralidad, snapshot clínico, reanálisis y completitud.
2. Definir el ciclo de vida de artefactos y su referencia estable, con autorización y firma de descargas en backend.
3. Especificar el contrato público del servicio ML, la orquestación at-least-once y la persistencia completa e idempotente del resultado.
4. Definir autenticación, roles, ownership, auditoría, bloqueo por intentos y protecciones de administración.
5. Definir el PDF básico obligatorio, su idempotencia y versionado.
6. Preparar Azure como despliegue aislado y limpiable, con decisiones faltantes explícitamente bloqueantes.
7. Entregar una tabla de endpoints y estados suficiente para que frontend implemente sin leer código fuente.
8. Dejar tareas ordenadas y trazables, sin marcar como hechas las que dependen de decisiones pendientes.

**Non-Goals:**

1. Implementar frontend, mocks o estilos.
2. Simular o implementar RF07 unimodal ni RF15 comparación; ambos quedan diferidos y no bloquean el hito.
3. Implementar Grad-CAM o SHAP ahora; se mantienen como requisitos SRS diferidos y entregables separados.
4. Implementar historial/filtros/paginación, administración/auditoría operativa, PDF enriquecido o APIs/documentación adicionales en el primer hito.
5. Desplegar en Azure, leer `.env.azure`, exponer secretos o ejecutar pruebas destructivas.
6. Declarar cumplimiento de RNF sin medición reproducible.
7. Añadir dependencias nuevas (por ejemplo `SQLAlchemy` o `DatabaseFeedbackSource`); ambos quedan fuera de alcance y no bloquean este change.

## Decisions

### D1. Una ejecución analiza una retinografía y un snapshot clínico inmutable

**Decisión (agreed):** La unidad de análisis es `execution` (ejecución). Una ejecución referencia:

- exactamente un `image_id` y una lateralidad `eye_side` (`OD`/`OS`) como **metadato**, no como segundo archivo;
- exactamente un `clinical_snapshot_id` inmutable, con payload crudo, payload normalizado, versión de esquema y revisiones de modelo;
- el paciente y la consulta a los que pertenece.

Un reanálisis crea una **nueva ejecución enlazada** (`reanalysis_of_execution_id`) y nunca modifica la evidencia, el resultado ni el PDF de una ejecución anterior.

**Razón:** Evita perder trazabilidad clínica y permite auditar qué snapshot, modelo y artefactos produjeron cada resultado. Alternativa descartada: actualizar la fila `inferences` existente, que pisaría evidencia pasada.

### D2. Paciente, consulta y ejecución tienen identidades y estados separados

**Decisión (agreed):** Se distinguen tres niveles:

| Nivel | Responsabilidad | Estado |
|---|---|---|
| Paciente | Identidad pseudónima y datos base | Sin estado de análisis |
| Consulta | Agrupa ejecuciones y fija una selección explícita de ejecuciones requeridas | `analysisState` + `reportState` + `completionState` derivados |
| Ejecución | Un análisis de una imagen y un snapshot | `JobStatus` de la ejecución y estados por artefacto |

`COMPLETED` de una ejecución ML **no** es un valor de estado de consulta ni implica consulta completada. La consulta solo se considera completa cuando la selección explícita de ejecuciones requeridas no está vacía y todas ellas tienen resultado válido, evidencia obligatoria y PDF disponible. El estado de ejecución se mantiene separado del estado de entrega y del agregado de consulta.

**Razón:** El pipeline puede completar una ejecución y fallar la publicación del PDF o la segunda lateralidad. Mezclar ambos estados produce falsos positivos de completitud.

### D3. Selección explícita de ejecuciones requeridas y cambio tras cierre

**Decisión (agreed):** La consulta declara una selección explícita de `requiredExecutionIds` y una `requiredSetVersion` (manifiesto) al iniciar el análisis. La selección puede cubrir uno (`OD` u `OS`) o ambos ojos; no se exige bilateralidad siempre. La completitud se evalúa **solo** sobre esos IDs y **nunca** por “latest” automático, porque un reanálisis posterior no debe cambiar la evidencia de un cierre.

Un reanálisis crea una ejecución nueva enlazada y no modifica la selección de una consulta cerrada. Puede existir en el historial con su propio PDF independiente y su propia trazabilidad, pero queda **excluido** de la completitud de la consulta cerrada. **B2 queda RESUELTO como RESTRICCIÓN APROBADA:** una consulta completada no se reabre ni se altera automáticamente y no se promueve ni reemplaza ningún `requiredExecutionId` tras el cierre; los reanálisis históricos independientes no modifican el conjunto requerido congelado. No se asume cierre retroactivo. Cualquier cambio futuro del conjunto requerido requerirá una nueva decisión de producto y una versión documentada; no forma parte de este hito.

**Razón:** Un “último gana” silencioso reescribe la evidencia de cierre y hace imposible auditar qué ejecución sustentó la consulta.

### D4. Estados por artefacto separados del estado de ejecución

**Decisión (agreed):** Cada artefacto (`result`, `mask`, `overlay`, `pdf`, `gradcam`, `shap`) tiene un estado propio:

`NOT_SUPPORTED` | `NOT_REQUESTED` | `PENDING` | `AVAILABLE` | `FAILED`

Reglas:

- `mask`, `overlay`, `result` y PDF básico son obligatorios para una ruta exitosa normal cuando el pipeline los produce.
- `gradcam` y `shap` se reportan como `NOT_SUPPORTED` hasta su entrega diferida; nunca como `AVAILABLE` ni con enlaces ficticios.
- `REVIEW_REQUIRED` puede devolver evidencia parcial (por ejemplo `mask`/`overlay` y `result` parcial) sin fingir éxito.
- `FAILED` incluye una causa segura, un indicador `retryable` y ausencia explícita del artefacto.
- Si un artefacto obligatorio falla, la ejecución no alcanza completitud normal; se registra el fallo y se permite reintentar la publicación sin reinferir cuando el resultado sea recuperable.
- La respuesta de ejecución expone los estados por artefacto y un `completionState` derivado; no se crea un enum de base de datos nuevo para estados agregados ni se usa `PROCESSING` encubierto.

**Razón:** Un único booleano “ok” oculta fallos parciales y produce PDFs o respuestas incompletas presentadas como válidas.

### D5. Referencia de artefacto estable y almacenamiento lógico

**Decisión (agreed):** Se persiste una referencia estructurada, nunca una URL firmada:

```json
{
  "artifactType": "mask",
  "status": "AVAILABLE",
  "storageId": "azure-blob-default",
  "bucketOrContainer": "mask-bucket",
  "key": "inference-id/mask.png",
  "contentType": "image/png",
  "sizeBytes": 12345,
  "checksumSha256": "hex",
  "failureCode": null,
  "retryable": null
}
```

- `storageId` resuelve provider, cuenta y endpoint desde configuración confiable del backend. El backend actual solo implementa S3/MinIO (`backend/src/services/storage.ts:1-98`); Azure Blob requiere la abstracción dual descrita en D13.
- La `key` se conserva **exactamente** como fue producida; no se normaliza de forma que cambie el objeto.
- Prohibido persistir SAS, presigned URLs, claves personales o URLs externas arbitrarias.
- El backend autoriza cada descarga y firma una URL nueva bajo demanda.
- Si la URL expira, el frontend solicita otra; no la infiere ni la reconstruye.
- El parser central acepta referencias legacy `s3://bucket/key` y `azure://container/key` sin `split` ingenuo: separa esquema, primer contenedor y key completa; valida contra ubicaciones allowlisted.
- SAS de Azure debe ser read-only, sobre el objeto, HTTPS y de TTL corto configurable (propuesta técnica: 300 s por defecto). MinIO usa URL firmada equivalente. No se promete revocación inmediata: revocar una cuenta no revoca una URL ya emitida; un proxy revocable es una opción futura no implementada.
- La forma de referencia de artefacto es única en diseño, contrato y API: camelCase en el contrato clínico; los campos nulos son explícitos y solo `AVAILABLE` tiene `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes` y checksum.
- La abstracción de storage debe existir en backend y ML: Azure Blob con SAS read-only sobre objeto, HTTPS y existencia/verificación de upload; MinIO con presign equivalente y `ensure` de buckets. No se implementa un provider como caso especial del otro.

**Razón:** Persistir URLs firmadas filtra credenciales temporales en DB, logs, backups y PDFs, y las vuelve obsoletas de forma inevitable.

### D6. Contrato público del servicio ML: `signed image_url`, JSON estricto

**Decisión (agreed):** El servicio ML mantiene estos invariantes:

- `POST /v1/inferences` recibe JSON con `inference_id`, `image_url` (URL firmada), `eye_side`, `clinical_features` y `model_version` opcional.
- No acepta multipart, no acepta un segundo archivo, no acepta CDR de entrada.
- No normaliza etiquetas desconocidas a una clase inventada. Las clases canónicas son `0 Glaucoma`, `1 Non_Glaucoma`, `2 Suspicious_Glaucoma` (`ml/models/manifest.json`; `backend/src/schemas/common.ts:42-48`).
- `202 Accepted` confirma aceptación, no resultado; el cliente puede consultar antes de reenviar.
- `GET /v1/inferences/{job_id}` devuelve `JobStatus`, etapa, mensaje seguro y resultado completo cuando exista.
- El token interno del ML es obligatorio fuera de desarrollo y de mínimo privilegio.
- El contrato ML usa `snake_case`; el contrato clínico del backend usa `camelCase`. El mapeo se documenta en el contrato de frontend y no se mezclan ambos estilos en la misma API pública.

La descarga firmada se valida contra allowlist de hosts y no sigue redirecciones. La URL firmada para el ML se genera **justo antes** de enviarla desde una referencia confiable, para no persistir una URL obsoleta en BullMQ.

**Razón:** Un multipart con CDR de entrada rompe la trazabilidad y permite alterar la inferencia. Una URL firmada persistida expira durante la espera en cola.

### D7. Idempotencia persistida, obligatoria y con alcance autenticado

**Decisión (agreed):** El backend expone un mecanismo de idempotencia persistido, no solo en memoria:

- `Idempotency-Key` es **obligatoria** en la creación canónica de ejecución (`POST /inferences`) y en cualquier alias de reanálisis que se exponga. No es “recomendada”.
- Clave compuesta por alcance autenticado durable + recurso + `Idempotency-Key`.
- Registro con hash canónico del payload; la URL firmada dinámica **no** forma parte del payload ni del fingerprint.
- Misma clave + mismo payload ⇒ se reproduce el mismo `202` con el mismo `inferenceId`/`jobId` de servidor. Si se perdió el `202`, el cliente reintenta con la misma key y **no** necesita un ID que nunca recibió.
- Misma clave + payload distinto ⇒ `409 Conflict` con código seguro.
- El modelo resuelto se fija en la primera solicitud y no cambia por defaults de reintentos.
- Concurrencia resuelta con restricción única y transacción; nunca con “comprobar luego insertar” sin protección.
- Mientras B3 no esté aprobado, **no se purgan** registros de idempotencia, tombstones ni vínculos de inferencia necesarios para replay. Cuando B3 se apruebe, la retención podrá acotarse sin romper el horizonte de replay definido; la política vigente no promete replay eterno arbitrario, pero tampoco purga.

El hash SHA-256 de bytes **sanitizados** verifica el contenido exacto de la imagen. El fingerprint clínico (imagen + `OD/OS` + snapshot normalizado + versión/config de modelos) detecta duplicados técnicos, pero **nunca** se usa para negar un reanálisis legítimo ni para revelar a un usuario que otro usuario subió la misma imagen. Deshabilitar el botón en frontend es UX, no seguridad.

**Razón:** Sin persistencia, un reintento tras timeout crea trabajos duplicados; sin un `202` recuperable, el cliente no puede reintentar de forma segura sin inventar un ID.

### D8. Orquestación at-least-once, recuperación y persistencia completa

**Decisión (agreed):**

- BullMQ entrega al menos una vez; los efectos deben ser idempotentes.
- El job referencia la ejecución y una referencia de almacenamiento confiable; no un SAS de larga vida.
- El worker persiste la intención de encolado de forma consistente con la creación de la ejecución (outbox o reconciliación sólida) y un identificador de inferencia estable.
- Si se pierde la respuesta `accepted` del ML, el worker consulta el job existente antes de reenviar.
- Ante reinicio, el worker recupera o consulta el job ML existente; no inventa un nuevo trabajo para la misma ejecución.
- La persistencia del resultado es idempotente y cubre todos los campos: `predicted_class`, `confidence`, `probabilities`, `cdr`, `cdr_vertical`, `quality`, `artifacts`, `elapsed_seconds`, `model_versions`, estado.
- `jobTerminal` es true solo si el `JobStatus` de la ejecución es `COMPLETED`, `REVIEW_REQUIRED` o `FAILED`. `deliveryTerminal` es true solo cuando todas las publicaciones solicitadas terminaron `AVAILABLE` o en fallo terminal explícito y ninguna queda `PENDING`. `delivery.complete` nunca es true si el ML está en `REVIEW_REQUIRED` o `FAILED`.
- El polling HTTP al ML para en `jobTerminal`. El polling de la API clínica no para solo por `jobTerminal`: continúa si quedan artefactos o PDF `PENDING`, y para en `deliveryTerminal=true`, `pollingStop` terminal (`COMPLETE`/`ACTION_REQUIRED`/`FAILED`), auth/error acotado o deadline/timeout global con acción de nueva consulta. No se usa un booleano `terminal` indefinido.
- `REVIEW_REQUIRED` no se autoaprueba. **B1 queda RESUELTO como RESTRICCIÓN APROBADA:** el médico no puede convertir una ejecución sin resultado válido en `COMPLETED`; `REVIEW_REQUIRED` se preserva y la resolución es un reanálisis como ejecución nueva, con imagen/snapshot nuevos si procede, PDF independiente y vínculo a la ejecución anterior, sin pisar la evidencia previa. No existe endpoint ejecutable de aprobación de revisión ni auto-completado manual alternativo en este hito. Si la evidencia/PDF se sigue publicando, el cliente continúa hasta que la entrega conocida no tenga `PENDING`; el reporte de revisión no se declara completo ni se corta antes de una entrega terminal conocida.
- La consulta expone `pollingStop`: `CONTINUE`, `COMPLETE`, `ACTION_REQUIRED` o `FAILED`. Para en `COMPLETE` (completionState completo), `ACTION_REQUIRED` (revisión/bloqueo que exige acción) o `FAILED` con reporte terminal sin `PENDING`. Un timeout global configurable dispara aviso y no marca la inferencia como `FAILED` por sí solo.
- La entrega continúa después de que el ML devuelve `COMPLETED`: publicación de artefactos y PDF hasta que la ejecución requerida esté completa. `COMPLETED` de ML no cierra la consulta.
- El polling del cliente usa intervalo/backoff propuesto configurable: 2 s inicial, techo 10 s, `Retry-After` si el servidor lo indica.
- Se permiten reintentos acotados con backoff solo para errores transitorios. Timeout y cancelación tienen semántica explícita; no se permite un job huérfano silencioso.

**Precedencia de `analysisState` (derivada, no enum DB):**

1. Sin `requiredExecutionIds` (conjunto vacío) ⇒ `OPEN`; nunca `COMPLETED` por vacuidad.
2. Todas las ejecuciones requeridas con resultado válido y evidencia obligatoria ⇒ `COMPLETED`.
3. Alguna ejecución requerida `FAILED` sin recuperación pendiente ⇒ `FAILED`.
4. Alguna ejecución requerida `REVIEW_REQUIRED` ⇒ `REVIEW_REQUIRED`.
5. Alguna ejecución requerida no terminal o artefacto obligatorio `PENDING` ⇒ `IN_PROGRESS`.
6. Al menos una ejecución requerida con resultado/evidencia pero no todas ⇒ `PARTIAL`.
7. En otro caso ⇒ `OPEN`.

`reportState` es formal y separado: `NOT_REQUESTED` si `requiredExecutionIds` está vacío; `AVAILABLE` solo si el conjunto requerido no está vacío y **todos** los `pdfStatus` están `AVAILABLE`; `REPORT_PENDING` si alguno está en generación/publicación y ninguno es fallo terminal; `FAILED` si alguno es fallo terminal. Precedencia: `FAILED > REPORT_PENDING > AVAILABLE`; nunca `AVAILABLE` por vacuidad. `completionState = COMPLETE` solo si el conjunto no está vacío y todas las ejecuciones requeridas tienen resultado, artefactos obligatorios y PDF disponible; no basta “algún reporte” ni un reporte histórico. Cada delivery de ejecución registra su propia completitud y la agregación no sobrescribe histórico. `analysisState` evalúa resultado/ML y no mete PDF en el enum ML.

**Razón:** El comportamiento actual del worker (`backend/src/workers/inference.worker.ts:33-47`) pierde `REVIEW_REQUIRED` y puede marcar la consulta completa antes de que exista evidencia válida.

### D9. Roles, autenticación y matriz de autorización

**Decisión (agreed):**

- `ADMIN` gestiona usuarios y operación, sin lectura clínica por defecto. Cualquier acceso a export/dataset clínico requiere un grant explícito al conjunto de datos; no existe permiso global implícito por rol.
- `OFTALMOLOGO` accede a sus propios casos.
- `INVESTIGADOR` accede solo a conjuntos explícitamente autorizados para investigación, con permiso de research dataset y mínimo PHI.
- No se comparten casos entre médicos en el primer hito.
- Default deny; la autorización se evalúa por endpoint, acción, recurso y dato, incluyendo artefactos, PDF, feedback, export e historial.
- El bootstrap del primer administrador es controlado (procedimiento de despliegue/CLI), no un endpoint público que acepte `role=ADMIN`.
- Altas por invitación solo si se implementan en el hito; la invitación no se inventa como requisito obligatorio.
- La desactivación de un usuario conserva autoría e historial, bloquea login y sesiones emitidas.
- **HU01:** cinco fallos de login **consecutivos** bloquean la cuenta durante 15 minutos. Un éxito intermedio reinicia el contador de fallos; un éxito durante el bloqueo no desbloquea ni concede sesión. El bloqueo se complementa con rate limit por IP y mensajes genéricos. El hash de contraseña es robusto (bcrypt/Argon2 según estándar del proyecto).
- El último administrador activo no puede desactivarse ni perder el rol, incluso con carreras: se verifica dentro de una transacción con bloqueo.
- **Sesiones (decisión técnica propuesta por el arquitecto dentro de la delegación industry, no decisión exacta de producto; acceso durable y contrato web 5.8 implementados y validados por QA, reset 5.9 pendiente):** JWT de acceso breve con default 15 min, `sessionId` y `tokenVersion`; en cada request el servidor consulta la sesión activa, la versión y el usuario activo/rol vigente en un store durable y aplica **fail closed** si no puede verificar. Refresh opaco generado con CSPRNG, hash en reposo, rotación atómica de un solo uso y detección de reutilización que revoca la familia; expiración absoluta simple de 7 días, sin extensión por idle salvo configuración explícita. Logout revoca la sesión de inmediato. Desactivar revoca todas las sesiones e incrementa la versión. Cambios de rol invalidan tokens/permisos de inmediato. Reset de contraseña usa token de un solo uso, 30 min, hash, sin logs, y revoca todas las sesiones; `forgot` responde `202` uniforme con rate limit y proveedor de envío configurable.
- Para web (contrato 5.8, D19), el login conserva el JSON actual y el refresh se transporta únicamente en una cookie opaca `HttpOnly; Secure; SameSite=Lax`, host-only y `Path=/api/auth` (nombre fijo `clearsight_refresh`), nunca en JSON; login y refresh exigen un `Origin` exactamente igual al origen público configurado (`AUTH_PUBLIC_ORIGIN`, sin wildcard) y rechazan con `403` antes de KDF/store si falta o no coincide. El access bearer no se sugiere guardar en `localStorage`. El cliente backend no-browser queda fuera de alcance. La respuesta de refresh no expone el refresh token. **B8 (email):** el usuario autoriza usar sus correos reales cuando se llegue a esa etapa, pero aún no se fijan direcciones ni proveedor. Las pruebas MUST usar primero un adaptador de email con sink en memoria; el envío real solo se habilitará a destinatarios que el usuario indique y autorice explícitamente, para casos sin PHI y sin enlaces secretos no autorizados. No se versionan direcciones, datos personales ni credenciales; el flujo MUST aplicar rate limiting y no revelar existencia de cuentas (no user enumeration). El provisioning/configuración del sender/provider queda pendiente para la etapa no funcional de backend auth y no bloquea diseño, implementación ni pruebas con sink. No se introduce una dependencia bloqueante nueva para esta seguridad prioritaria: se usan primitivas criptográficas y almacenamiento durable existentes en el stack.

**Razón:** `backend/src/routes/auth.ts:18-60` permite que cualquier cliente se registre como `ADMIN`; `backend/src/middleware/auth.ts:12-24` no valida `is_active`. El payload JWT actual (`sub` + `role`) y la firma HS256 sí son correctos (`backend/src/routes/auth.ts:58-60,114-117`) y se conservan; la brecha está en el alta pública, la comprobación de cuenta activa y la autorización por recurso, no en el formato del token.

### D10. Auditoría append-only y borrado

**Decisión (agreed):** Se auditan acciones sensibles con actor, target, acción, resultado y timestamp. El registro es append-only; no se actualiza ni se borra desde la aplicación. No contiene secretos, tokens, URLs firmadas ni PHI innecesaria. Si falla la auditoría de una operación sensible, la operación no se considera exitosa (transacción o compensación explícita).

**B5 (delegación técnica del usuario):** la acción soportada es **desactivar + revocar sesiones**, sin cascada ni reasignación de historial. **No se implementa hard delete en este hito**, ni siquiera para cuentas sin actividad; queda como excepción futura sujeta a política aprobada. La supresión de identidad/legal es distinta de la desactivación; su política (B5) y la de retención/consentimiento (B3/B4) siguen pendientes **solo para producción real, purgas y reidentificación**, no para desarrollo ni pruebas con datos sintéticos o dataset autorizado (por ejemplo PAPILA) con acceso mínimo. Si se procesan datos clínicos reales sin governance, el sistema MUST fallar cerrado. No se fijan plazos legales ni se declara cumplimiento legal.

### D11. PDF básico obligatorio, idempotente y versionado

**Decisión (agreed):** El PDF básico es obligatorio para la completitud de cada ejecución requerida. Contiene:

- identificación pseudónima de caso, consulta y ojo;
- `inference_id`, versión de snapshot clínico y versiones de modelo;
- información clínica con unidades solo cuando el mapeo esté verificado; si no, se marca como no interpretable;
- calidad, CDR y **tres imágenes embebidas** para la ruta exitosa normal: fotografía original sanitizada almacenada (sin EXIF del upload original), `mask` y `overlay`;
- fecha de análisis y fecha de generación del PDF;
- warnings, limitaciones y aviso de apoyo a investigación, no sustituto del criterio médico;
- ausencia explícita de Grad-CAM/SHAP hasta su entrega.

No incluye secretos ni URLs temporales. En una ruta exitosa normal no se usan referencias o enlaces como reemplazo visual de las imágenes embebidas. Un reporte parcial de `REVIEW_REQUIRED` documenta qué imagen o artefacto falta y no declara completitud. Reintentar el PDF usa el mismo `inference_id` y la misma versión inmutable de datos: es idempotente y no reinfiere. Feedback posterior o explicaciones nuevas generan una **nueva versión** del reporte, sin pisar la anterior ni recalcular silenciosamente.

**Razón:** El PDF es la evidencia entregable al usuario; si se regenera sobre datos mutables o se presenta como diagnóstico validado, la trazabilidad se pierde.

### D12. Azure aislado por ejecución, nunca recursos compartidos ni `.env.azure`

**Decisión (agreed):** El despliegue futuro:

- crea recursos por ejecución, con prefijo y tags de entorno;
- escribe un manifest de recursos creados durante el run;
- limpia en `finally` y, si hay interrupción, en una ejecución de limpieza separada;
- nunca borra recursos existentes ajenos;
- verifica el borrado, que puede ser asíncrono, y revisa recursos residuales (discos, ACR, storage, DB, IPs);
- si el cleanup falla, reporta `pending` con acciones, sin declarar “destruido” sin verificación.

**B6 (estado actual, lectura CLI):** el arquitecto ejecutó hoy lecturas con Azure CLI 2.91.0: `account list` mostró una única suscripción default `Enabled` en `AzureCloud`, `account show` coincidió y `az group list --query '[].properties.provisioningState' --output json` devolvió `[]`. No se registran IDs, nombres de suscripción ni salidas sensibles en la documentación. El primer intento de query de grupos falló por quoting del wrapper Windows; el reintento válido resolvió la lectura y no cambió recursos. **No se creó ni destruyó ningún recurso.** Esto satisface únicamente el prerequisito de CLI/contexto activo; **no** prueba capa gratuita, cuotas, RBAC de creación ni permiso de gasto. Antes de crear recursos faltan presupuesto numérico, duración y scope del run, confirmar que el contexto default es el correcto justo antes de crear, y verificar permisos/quota con dry-run o lecturas. Suscripción, alcance de recursos, presupuesto numérico y duración **no están acordados**; esos datos bloquean el deploy, no el diseño. No se garantiza capa gratuita. `.env.azure` está prohibido: no se lee, no se imprime y no se usa como evidencia. Cualquier script futuro consumirá configuración solo tras un procedimiento seguro aprobado. La arquitectura futura preferida se registra en D18 (Container Apps, entrada pública web/proxy y backend/ML internos); no altera el bloqueo de B6 ni autoriza deploy.

**Razón:** El recurso persistente y compartido descrito en el archivo local `openspec/specs/azure-deployment-automation/spec.md` contradice el aislamiento y el cleanup verificable. Ese archivo **no está trackeado** (`git ls-files -- openspec/specs` vacío) y se usó solo como contexto; no es baseline oficial ni dependencia de entrega. Además, credenciales locales no son evidencia de un despliegue reproducible.

### D13. Pruebas por contratos antes de Azure real

**Decisión (agreed):** Se prueban primero contratos con stub ML y casos adversos: URL expirada, host no permitido, etiqueta desconocida, payload inválido, pérdida de `accepted`, reinicio de worker, resultado duplicado, objeto ausente, upload OK con DB fallida, storage caído y error de auditoría. Después se prueba contra Azure real solo con aprobación y alcance definido.

Las pruebas E2E cubren autenticación, paciente, consulta, upload sanitizado, request, polling, persistencia completa, artefactos firmados, feedback, export y completitud con PDF. Las pruebas que destruyen datos se ejecutan solo en una base creada o adoptada explícitamente para el run, con marcador de ownership, allowlist de target y denegación de producción; **el nombre que contiene `test` no es garantía suficiente**. El `global-setup` actual hace `DROP SCHEMA public CASCADE` (`backend/tests/global-setup.ts:40-47`): es un comportamiento destructivo del test actual, no una protección; no se ejecuta contra una base ajena o de desarrollo. En este change no se ejecuta ninguna. Los datos de prueba deben ser sintéticos o de un dataset de uso autorizado (por ejemplo PAPILA); no se usa PHI real sin base legal.

La cobertura de storage dual incluye Azure fake/Azurite sin Azure real y un E2E posterior contra Azure real autenticado: imagen → backend Blob → descarga ML → mask/overlay → DB → PDF → URLs, incluyendo almacenes ausentes. Los tests de PDF parsean el PDF real, extraen texto, cuentan imágenes renderizadas y verifican encabezado/numeración de HU08; no se limitan a un mock de snapshot. Las unidades clínicas solo se muestran si su mapeo/codebook está verificado; un mapeo no demostrado bloquea la interpretación clínica de esa etiqueta, no la totalidad del contrato.

**Metas RNF del SRS (no afirmaciones de cumplimiento):**

| RNF | Meta | Regla de evidencia |
|---|---|---|
| Latencia | p95 carga→resultado ≤ 10 s en el 95% de casos | Medir con benchmark reproducible; no afirmar sin resultados. |
| Concurrencia | 50 solicitudes concurrentes soportadas | Medir con carga controlada; no inferir de pruebas unitarias. |
| Cobertura | ≥ 70% | Medir con la herramienta del proyecto; no confundir cobertura con corrección. |
| AUC | ≥ 0.85 | Evidencia real de validación clínica; un gate de MLflow o la aceptación de torch 2.7 por Node no son evidencia de AUC. |
| Disponibilidad | 95% mensual | No demostrable con una prueba efímera; requiere monitoreo y ventana observada. |
| PDF institucional HU08 | ≤ 15 s | Medir generación con numeración/plantilla y registrar entorno y volumen. |

Los gates de MLflow son criterios de promoción, no métricas demostradas. La disponibilidad mensual no se declara a partir de un despliegue de prueba.

### D14. Persistencia local de la migración A (1.1)

**Decisión (implementación local, no contrato nuevo de producto):** La migración A materializa el snapshot y los metadatos de ejecución de forma **aditiva**:

- `clinical_snapshots` es una tabla append-only: payload crudo y normalizado JSONB obligatorios y objetos, `schema_version` no vacío, `model_versions` JSONB objeto (`{}` significa “no resuelto”, nunca un registro inventado), `consultation_id` con FK `ON DELETE RESTRICT` y triggers que rechazan `UPDATE` y `DELETE`.
- `Consultation.requiredExecutionIds` se persiste como `UUID[] NOT NULL DEFAULT '{}'` con índice GIN (`idx_consultations_required_execution_ids`, mismo nombre/tipo en Prisma y SQL); `requiredSetVersion` y `requiredSetFrozenAt` son NULL en legacy. El conjunto no vacío exige versión no vacía y freeze; después del freeze solo se permiten actualizaciones ajenas a la selección. El conjunto vacío permanece abierto y nunca completa por vacuidad.
- `Inference` recibe `consultation_id`, `eye_side`, `clinical_snapshot_id`, `status` y `reanalysis_of_id` **nullable**. No hay backfill: el legado conserva NULL y la imagen sigue siendo la fuente autoritativa para validar copias no nulas. `status` usa exactamente el vocabulario `JobStatus`, sin default ni `PROCESSING`.
- La evidencia congelada tiene identidad inmutable: si una ejecución aparece en `requiredExecutionIds`, cualquier `UPDATE` que cambie `image_id`, `consultation_id` o `eye_side` se rechaza, aunque la nueva imagen comparta consulta/ojo. Los cambios de `status`/resultado siguen permitidos.
- El vínculo `clinical_snapshot_id` es inmutable una vez no nulo (incluido intento de ponerlo a NULL). Una fila legacy con NULL y **no seleccionada** puede recibir su primer snapshot real; una ejecución seleccionada no puede enlazarlo tarde. `reanalysis_of_id` es append-only tras el INSERT: cualquier `UPDATE` que lo cambie (incluido NULL→padre o repunte) se rechaza; el reanálisis es una fila nueva.
- Los triggers SQL validan pertenencia de la selección, duplicados, freeze, identidad de ejecución seleccionada, contexto de reanálisis/lateralidad/consulta, snapshot de la misma consulta y vínculo de snapshot. Las relaciones Prisma son FK simples; los checks por trigger se documentan como no representables en Prisma. Los triggers de fila no protegen frente a `TRUNCATE`/DDL de un owner o schema privilegiado; no se declara inmutabilidad universal.
- `docker/init.sql` se mantiene idéntico a `0_init`; la migración A es incremental. No se reescribe el contrato de producto ni se adelantan artefactos/PDF, estados agregados o consumidores de aplicación (2.x/B).
- El despliegue Azure actual sigue aplicando solo `init.sql` y no ejecuta migraciones incrementales; esa deuda queda para 1.5/8.x y no se cambia en esta tarea.
- **Diferido a 1.4 con evidencia explícita:** serialización con locks de freeze/borrado concurrente (no se declara inmutabilidad concurrente completa), guard de reparentado directo de `images.consultation_id`/`eye_side` y denegación de `TRUNCATE` al rol de aplicación. El cascade legacy sin snapshot se conserva sin cambios; `F4` (TRUNCATE privilegiado) no se trata como defecto de los guards `UPDATE`/`DELETE` y no se añade un trigger `BEFORE TRUNCATE` que rompería los fixtures con ownership.

### D15. Persistencia local de la migración B (1.2)

**Decisión (implementación local, no contrato nuevo de producto):** La migración B añade persistencia versionada de artefactos binarios y PDF, sin consumidores todavía:

- `ArtifactRecord` almacena `mask`, `overlay`, `pdf`, `gradcam` y `shap`; `result` NO se convierte en blob: sigue siendo la proyección inline de `Inference`. Estados `NOT_SUPPORTED`, `NOT_REQUESTED`, `PENDING`, `AVAILABLE` y `FAILED`, sin enum agregado de DB.
- `AVAILABLE` exige referencia completa (`storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes >= 0`, `checksumSha256` hex de 64 en minúsculas y `availableAt`); el resto de estados no admite ubicación parcial. `FAILED` exige un `failureCode` seguro acotado y `retryable`; el resto no admite failure metadata.
- La `key` se conserva exacta (unicode, `%`, espacios); solo se rechaza un esquema URI genérico (`[a-z][a-z0-9+.-]*://`) y parámetros de firma reconocibles del contrato actual (`sig`, `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`). `storageId`/container son identificadores lógicos, no endpoints. No se persisten SAS, presigned URLs ni URLs externas. B no valida que el objeto exista en storage ni declara upload real; eso queda para 3.5.
- `UNIQUE(inferenceId, artifactType, version)` y `UNIQUE(inferenceId, version)` en PDF permiten evidencia histórica y versiones nuevas. La identidad (`id`, inferencia, tipo, versión, `createdAt`) es inmutable; una fila `AVAILABLE` es completamente inmutable y no se borra. Un fallo posterior se representa como nuevo intento/versión explícito, nunca como `AVAILABLE→FAILED` destructivo ni “latest wins”.
- `PdfReport` mantiene `sourceSnapshotId` capturado **en el momento de creación**: si el padre legacy aún no tiene snapshot se guarda NULL como “desconocido histórico”, y solo el `INSERT` valida contra el snapshot del padre. Los `UPDATE` no recopian ni revalidan contra el padre; el vínculo ya es inmutable y una fila NULL puede terminar `FAILED` aunque el padre reciba después su primer snapshot (A impide reescribir un vínculo no nulo). `modelVersions` es objeto, `dataVersion` no vacío, `documentKind` (solo `basic` se genera en este hito; `gradcam`/`shap` quedan reservados sin explicabilidad pretendida) y `renderingInputs` objeto inmutable desde la creación. `renderingInputs` rechaza esquemas URI genéricos y los parámetros de firma reconocibles del contrato actual; estas comprobaciones están acotadas y no se presentan como detección universal de secretos (la allowlist tipada futura es 6.1).
- PDF `AVAILABLE` exige `artifactId` no nulo de un `ArtifactRecord` `pdf`, `AVAILABLE`, `application/pdf`, misma inferencia y versión, **y `sourceSnapshotId` no nulo** (trazabilidad clínica conocida); una fila legacy NULL puede quedar `PENDING`/`FAILED`, pero no publicarse. Transiciones permitidas: `PENDING→PENDING/AVAILABLE/FAILED` y `FAILED→FAILED/PENDING`; una fila publicada es completamente inmutable y no se borra. Una versión nueva es una fila nueva, puede capturar el snapshot ya conocido y no modifica la anterior.
- No hay backfill de artefactos/PDF legacy, ni rutas/repositorios/generador PDF todavía. `docker/init.sql` sigue inmutable y el contrato API existente no se reescribe: esta tarea solo define la forma persistida que consumirán 3.5/6.x. El parentesco directo de `images` y las carreras concurrentes siguen en 1.4.

### D16. Persistencia durable de identidad, auditoría, sesiones e idempotencia (1.3)

**Decisión (implementación local, no comportamiento de auth):** La migración C añade almacenamiento durable para tareas 5.x sin resolver el login o registro inseguro actual:

- `User` añade `tokenVersion` (default 0), `failedLoginCount` (default 0) y `lockedUntil?`. Ambos contadores son no negativos y `tokenVersion` solo puede aumentar mediante trigger, preservando revocaciones. Los usuarios legacy conservan hash/rol/estado y reciben defaults; no se cambia middleware/roles.
- `UserSession` fija usuario, `issuedTokenVersion`, creación y expiración desde el INSERT; la creación exige usuario activo y `issuedTokenVersion` igual al `tokenVersion` vigente. La revocación es append-only (`revokedAt`/`reasonCode` no se restauran ni repuntan) y `lastUsedAt` es monótono. No se almacenan tokens en claro.
- `AuditEvent` es append-only: `UPDATE`/`DELETE` se rechazan. `actorKind=USER` exige `actorUserId`; `SYSTEM`/`ANONYMOUS` lo prohíben. `targetType=USER` usa `targetUserId` y prohíbe `targetId` redundante; el resto no usa `targetUserId`. `action`/`targetType` son códigos acotados, `outcome` es `SUCCESS|DENIED|FAILURE` y `metadata` es objeto con defensa URI/firma acotada. Las FKs restrict impiden borrar usuarios con historial; la desactivación sigue permitida. El servicio de auditoría/transacción es 5.5, no C.
- `RefreshToken` y `PasswordResetToken` guardan solo hash SHA-256 lowercase, nunca el token opaco. Identidad, hash y expiración son inmutables; `consumedAt`/`revokedAt` son append-only. Refresh exige misma sesión/usuario, expiración acotada por la sesión y padre existente/misma sesión; el puntero de padre es insert-only y único (un sucesor), lo que evita ciclos. La detección de reutilización/familia y la rotación quedaron implementadas en 5.8 (QA PASSED); el logout con revocación y limpieza de cookie también; el reset de contraseña es 5.9 y sigue pendiente.
- `IdempotencyRecord` fija `(actorUserId, scope, key)`, hash del payload, ejecución (`inferenceId NOT NULL`) y `resolvedModelVersions`. El actor debe ser el doctor dueño de la consulta de la inferencia (fallback legacy por la imagen). `PENDING` no tiene respuesta; `ACCEPTED` exige 202, `acceptedAt` y un body objeto con `inferenceId/jobId/status=QUEUED` coincidentes con la ejecución. Aceptado es inmutable y no se borra mientras B3 no apruebe retención; no se implementa el servicio de idempotencia (4.4) ni se purga.
- `TRUNCATE`/DDL de owner privilegiado siguen fuera de los triggers de fila y pertenecen a 1.4. No se declara detección universal de PII/secretos: las comprobaciones URI/firma son acotadas y el servicio futuro deberá usar campos tipados.
- El outbox de 4.6 no se incluye en C; requerirá su propia migración incremental al ejecutar 4.6. `docker/init.sql` permanece inmutable.

### D17. Integrity hardening y rol de aplicación mínimo (1.4)

**Decisión (SQL/tests, sin runtime auth):** La migración D refuerza carreras y prepara el rol DB de aplicación:

- El freeze de `requiredExecutionIds` bloquea las inferencias existentes con `FOR SHARE` en orden UUID determinista y **schema-qualified** (sin agregados con lock), y después revalida pertenencia/duplicados contra un snapshot fresco READ COMMITTED. Delete-first hace esperar al freeze y este rechaza la fila desaparecida; freeze-first hace esperar al delete y el guard A ve la selección confirmada. Las identidades seleccionadas siguen siendo inmutables.
- El contexto de inferencia conserva los `FOR SHARE` de imagen/padre (padre→imágenes) para validar y serializar. El guard de reparentado **no** toma locks de self-image ni de filas hijas: el UPDATE ya posee el write lock propio y un `EXISTS` schema-qualified detecta hijos comprometidos; así se evita la inversión image→child que producía `40P01`. Un `images` con inferencias no puede cambiar `consultation_id`/`eye_side`; una imagen sin referencias sí puede. No se declara ausencia universal de deadlocks.
- `clearsight_app` es un grupo global `NOLOGIN`, no superuser/createdb/createrole/replication/bypassrls. Si ya existe con atributos inseguros o como miembro de otro rol, la migración falla; no degrada roles ajenos. La creación requiere `CREATEROLE` explícito del login de despliegue.
- Los grants se aplican solo a `current_schema()`: USAGE sin CREATE; SELECT/INSERT/UPDATE en tablas mutables conocidas; SELECT/INSERT en `audit_events`/`clinical_snapshots`; DELETE/TRUNCATE/TRIGGER/REFERENCES revocados. Después se verifica el privilegio **efectivo** de `clearsight_app` (incluido lo heredado de PUBLIC u otro rol) y se falla cerrado sin reescribir ACL de PUBLIC. `test_meta`, `_prisma_migrations` y objetos futuros no reciben grant. No se añade `BEFORE TRUNCATE`.
- El rol es una preparación de seguridad: el runtime actual no cambia de DSN. El provisioning futuro (8.x) debe crear un LOGIN distinto, miembro de `clearsight_app`, y la readiness de producción debe verificar que la sesión no es owner/superuser. No se declara que la `DATABASE_URL` actual sea de mínimo privilegio.
- Los triggers de fila siguen sin proteger `TRUNCATE`/DDL de owner privilegiado; el test owner conserva cleanup. D no reclama integridad concurrente universal ni resuelve retención/B3, outbox 4.6 o servicios de aplicación.

### D18. Preferencia Azure futura: Container Apps con entrada web/proxy pública y backend/ML internos

**Decisión (preferencia futura, no implementada):** Cuando B6 se resuelva, el despliegue Azure prefiere **Azure Container Apps** con una única entrada pública en la capa web/proxy y los servicios backend/ML **solo internos**:

- la capa web/proxy expone el origen HTTPS público único y enruta `/api` al backend quitando el prefijo `/api`; el backend recibe rutas internas `/auth`, `/patients`, etc.;
- backend y ML no exponen ingress público; solo se alcanzan dentro del entorno/VNet;
- el `AUTH_PUBLIC_ORIGIN` de D19 coincide exactamente con esa entrada web/proxy.

**Coste, cuotas, recursos, suscripción, presupuesto numérico y duración siguen pendientes (B6).** Esta decisión **no** autoriza deploy, no crea recursos y **no** promete capa gratuita. No se implementa frontend ni proxy en este change.

**Razón:** Un único origen público con backend/ML internos reduce la superficie de ataque y encaja con la cookie host-only y el guard de `Origin` de D19, sin abrir ingress directo al backend ni al ML.

### D19. Contrato de sesión web 5.8: origen público, cookie de refresh y logout

**Decisión (implementada en 5.8 y validada por QA; reset de contraseña 5.9 sigue pendiente):**

- **Rutas y proxy:** la entrada pública es un proxy HTTPS que quita el prefijo `/api`; el backend expone internamente `/auth/login`, `/auth/refresh`, `/auth/logout` y `/auth/me`. El contrato público es `/api/auth/*`.
- **Login:** conserva la respuesta JSON actual y añade el refresh opaco (CSPRNG) **solo** como cookie `clearsight_refresh` con `HttpOnly; Secure; SameSite=Lax`, host-only (sin `Domain`) y `Path=/api/auth`. La expiración de la cookie no supera la sesión absoluta (≤ 7 d).
- **Refresh:** `POST /api/auth/refresh` autenticado por la cookie; devuelve solo `accessToken`, `tokenType` y `expiresIn`; rota single-use; en DB solo se guarda el hash SHA-256 lowercase; el valor crudo nunca aparece en logs, auditoría ni JSON. “Sin body ni `Bearer`” describe el mecanismo: el request recomendado no los envía, pero si llegan nunca se usan como credencial ni sustituyen la cookie, y su presencia sola no es error (H1).
- **Familia y reuso:** la familia es la sesión (`user_sessions`) y sus `refresh_tokens`. Ante dos solicitudes concurrentes del mismo refresh, como máximo una emite el sucesor (el puntero de padre es único); la otra detecta reuso y revoca **esa sesión y todos sus refresh**, sin tocar otras sesiones del usuario. No se define ventana de gracia; el cliente documenta single-flight.
- **Origen:** login y refresh exigen `Origin` exactamente igual a `AUTH_PUBLIC_ORIGIN` (URL `http(s)` normalizada, sin wildcard), configurado explícitamente; producción HTTPS y `localhost` HTTP solo en configuración no productiva explícita, con cookie siempre `Secure`. `Origin` ausente/null/mismatch ⇒ `403` genérico antes de KDF/store; `Sec-Fetch-Site: cross-site` ⇒ rechazo si viene. No se deriva el origen de `Host`/`X-Forwarded-*` no confiables ni de CORS wildcard. Si `AUTH_PUBLIC_ORIGIN` falta, los endpoints de cookie fallan cerrado (`503`) sin romper la construcción lazy de `buildApp` ni el `410` de `/auth/register`.
- **Logout:** `POST /api/auth/logout` exige `Bearer` de una sesión válida, revoca esa sesión y su cadena con auditoría, responde `204` y limpia `clearsight_refresh` con los mismos atributos (`Path=/api/auth`, `Secure`, `HttpOnly`, `SameSite=Lax`). Si incluye `Origin`, pasa el mismo guard; la cookie sola nunca autoriza.
- **Errores y caché:** `401/403/503` genéricos; `Cache-Control: no-store` en respuestas de credenciales.
- **Atomicidad:** login no setea cookie si falla sign/auditoría/commit; refresh no consume el padre si falla sign/auditoría; el reuso confirma revocación+auditoría y **después** devuelve `401` (no lanza dentro de la transacción revirtiendo la revocación); auditoría caída ⇒ `503` con rollback, nunca un logout exitoso falso. `/auth/me` no cambia.
- **Persistencia:** se usan `refresh_tokens` y `user_sessions` existentes sin editar schema ni migraciones. Sus triggers permiten la revocación append-only desde `NULL` y prohíben mutar identidad/hash/expiry; no hay conflicto crítico con el reuso.
- **H2 (hardening futuro):** el reuso de un token ya consumido puede escribir auditoría/locks en cada intento; D19 no exige rate-limit adicional. Es un límite conocido de amplificación, no una regresión abierta, y no se promete resuelto.
- **H3 (logging):** la redacción actual cubre `Cookie`, `Set-Cookie`, `Authorization` y campos de credenciales; serializers custom futuros requieren revisión contra esa lista. No hay fuga actual.

## ADR Registry

| ID | Decisión | Estado | Fuente |
|---|---|---|---|
| ADR-001 | Ejecución única por imagen + lateralidad y snapshot inmutable | agreed | D1, D2 |
| ADR-002 | Reanálisis crea nueva ejecución enlazada | agreed | D1 |
| ADR-003 | Selección explícita de `requiredExecutionIds`; uno o ambos ojos, sin latest automático | agreed | D3 |
| ADR-004 | Restricción aprobada: sin reapertura ni promoción de IDs requeridos tras cierre; frozen set | agreed (restriction) | D3, B2 |
| ADR-005 | Estados por artefacto separados del estado de ejecución | agreed | D4 |
| ADR-006 | Referencia de artefacto estructurada; sin SAS persistido | agreed | D5 |
| ADR-007 | Parser legacy `s3://`/`azure://` central y allowlisted | agreed | D5 |
| ADR-008 | `POST /v1/inferences` con `signed image_url` JSON estricto | agreed | D6 |
| ADR-009 | Idempotencia persistida con alcance autenticado | agreed | D7 |
| ADR-010 | Worker at-least-once, recuperación y persistencia completa | agreed | D8 |
| ADR-011 | Roles y ownership con default deny | agreed | D9 |
| ADR-012 | Bootstrap de admin controlado, sin registro público de rol | agreed | D9 |
| ADR-013 | Bloqueo HU01: 5 fallos consecutivos/15 min, éxito intermedio reinicia contador | agreed | D9 |
| ADR-014 | Sesiones: JWT 15 min + sessionId/tokenVersion, refresh opaco rotado, cookie web | implemented 5.8 (QA PASSED); reset 5.9 pending | D9, D19 |
| ADR-015 | Auditoría append-only; fallo bloquea operación sensible | agreed | D10 |
| ADR-016 | Desactivación + revocación de sesiones; sin hard delete en el hito | agreed (B5 restriction) | D10 |
| ADR-017 | Supresión/retención pendientes solo producción; sin plazos legales fijados | deferred (production only) | D10, B3, B4, B5 |
| ADR-018 | PDF básico obligatorio, con original sanitizada + mask + overlay embebidas | agreed | D11 |
| ADR-019 | Grad-CAM/SHAP diferidos y explícitamente ausentes | agreed | D4, D11 |
| ADR-020 | Deploy Azure aislado con cleanup verificado; CLI prereq parcial, no deployment ready (B6) | agreed (deploy blocked) | D12, B6 |
| ADR-021 | No leer `.env.azure` ni usarlo como evidencia | agreed | D12 |
| ADR-022 | Resolución de `0_init` condicionada a esquema verificado | agreed | D12, Migration Plan |
| ADR-023 | RF07 unimodal y RF15 comparación diferidos; no se implementan ni simulan | deferred (non-blocking) | B7 |
| ADR-024 | Métricas RNF solo tras medición reproducible | agreed | D13, Risks |
| ADR-025 | `requiredExecutionIds` explícitos y precedencia determinista de consulta | agreed | D3, D8 |
| ADR-026 | `Idempotency-Key` obligatoria, replay del mismo `202` y modelo fijado | agreed | D7 |
| ADR-027 | Abstracción dual de storage backend/ML (Azure Blob y MinIO) | agreed (implementación pendiente) | D5, D13 |
| ADR-028 | B1: médico no convierte ejecución sin resultado válido en `COMPLETED`; revisión se resuelve por reanálisis con PDF independiente | agreed (restriction) | D8, B1 |
| ADR-029 | B5: no hard delete en el hito; desactivación + revocación es la acción soportada | agreed (restriction) | D10, B5 |
| ADR-030 | B3/B4/B5 solo aplican a producción real/purgas; desarrollo con datos sintéticos/PAPILA no se bloquea; fail closed con datos reales sin governance | agreed (scope) | D10, Open Questions |
| ADR-031 | B8: sink en memoria primero; envío real solo a destinatarios autorizados, sin PHI/enlaces secretos, sin versionar direcciones/credenciales | agreed (restriction) | D9, B8 |
| ADR-032 | Runbook de pruebas incremental con fases, precondiciones y stop de pasos peligrosos | agreed | D13, `contracts/testing-runbook.md` |
| ADR-033 | B9: `DatabaseFeedbackSource` y SQLAlchemy fuera de alcance, no bloquean el change | out of scope | Open Questions |
| ADR-034 | Migración A aditiva: snapshot inmutable, selección `UUID[]` con freeze, metadatos legacy nullable y `init.sql` baseline sin cambios | agreed (implemented 1.1) | D14, D1, D3 |
| ADR-035 | Migración B aditiva: artifact records versionados, PDF versionado inmutable, `result` inline y sin URLs/SAS persistidas | agreed (implemented 1.2) | D15, D4, D5, D11 |
| ADR-036 | Migración C aditiva: sesiones/credenciales hash-only, auditoría append-only e idempotencia DB; outbox diferido a 4.6 | agreed (implemented 1.3) | D16, D7, D9, D10 |
| ADR-037 | Migración D: locks deterministas freeze/contexto, guard de reparentado de imagen y rol `clearsight_app` mínimo; LOGIN runtime queda 8.x | agreed (implemented 1.4) | D17, ADR-004, ADR-015 |
| ADR-038 | Preferencia futura Azure: Container Apps con ingress público solo en web/proxy y backend/ML internos; B6 sigue bloqueando deploy y no se promete capa gratuita | future preference (deploy blocked) | D18, B6 |
| ADR-039 | 5.8: cookie de refresh `clearsight_refresh` (host-only, `Path=/api/auth`, `Secure/Lax/HttpOnly`), `AUTH_PUBLIC_ORIGIN` exacto, refresh cookie-only, logout en 5.8 y reuso revoca la sesión | implemented 5.8 (QA PASSED) | D9, D19 |

## Risks / Trade-offs

| Riesgo | Mitigación |
|---|---|
| URL firmada ya emitida sigue válida tras revocar una cuenta | TTL corto, documentar la limitación y evaluar proxy revocable futuro; no prometer revocación inmediata. |
| Revisión humana sin conversión a completada | B1 resuelto como restricción: `REVIEW_REQUIRED` no se autoaprueba y el médico no puede convertir una ejecución sin resultado válido; la resolución es un reanálisis con PDF independiente. |
| Cambio del conjunto de ojos tras cierre | B2 resuelto como restricción: no reapertura, no promoción y frozen set; reanálisis históricos solo en historial. |
| Reanálisis legítimo bloqueado por fingerprint | El fingerprint solo detecta duplicados técnicos; nunca deniega ni revela a otros usuarios. |
| URLs o tokens en logs/PDF/DB | Referencias estructuradas, prohibición de SAS persistido, redacción de logs y pruebas de fuga. |
| Pérdida del `202` y reintento | `Idempotency-Key` obligatoria y replay del mismo `202` con el mismo ID de servidor; no exigir un ID nunca recibido. |
| Store de sesiones no verificable | Fail closed; no emitir/validar acceso si no se puede comprobar sesión, versión y usuario activo/rol. |
| Precedencia de estados ambigua | `requiredExecutionIds` explícitos y precedencia FAILED > REVIEW_REQUIRED > IN_PROGRESS > PARTIAL > OPEN; COMPLETED solo con todo satisfecho. |
| Unidades clínicas no verificadas | No mostrar etiquetas/unidades como validadas; marcar el mapeo como no demostrado y bloquear la interpretación clínica de ese campo. |
| Objeto en storage sin fila DB o fila DB sin objeto | Reconciliación y estado `FAILED`/incidente; nunca URL ficticia. |
| Upload OK y fallo de DB | Reconciliación y limpieza controlada de huérfanos; no éxito parcial silencioso. |
| Worker reiniciado y job ML huérfano | Recuperación por `inference_id` estable y consulta antes de reenviar. |
| Migración `0_init` indiscriminada | Resolver solo tras verificar el esquema real; no enmascarar divergencias. |
| Merge con master introduce `ensure_buckets` sin método | No repetir el bug de master (`queue:73/146`): toda llamada debe usar el método existente y el provider correcto. |
| Deploy Azure sin presupuesto/suscripción/alcance | B6 bloquea deploy; el diseño no se declara listo para ejecutar. |
| Costos residuales o borrado asíncrono incompleto | Manifest, verificación post-delete y reporte `pending` con acciones. |
| RNF declarados sin medición | Prohibido afirmar p95, concurrencia, AUC, cobertura o disponibilidad; se exige evidencia real. |
| PDF presentado como diagnóstico validado | Aviso explícito, pseudonimización y lenguaje de apoyo; reportes de revisión no declaran completitud. |
| Retención y consentimiento sin política | B3/B4/B5 aplican solo a producción real/purgas/reidentificación; no se fijan plazos ni se declara cumplimiento legal; fail closed con datos reales sin governance. |
| Pruebas destructivas contra DB compartida | Solo base aislada por prueba; no ejecutar en este change. |

## Migration Plan

1. **Documentación primero:** proposal, design, specs, contrato de frontend, tareas y `contracts/testing-runbook.md`. La fase documental no implementa por sí misma; las tareas `[x]` con evidencia (incluida 5.8/QA) sí están implementadas.
2. **Registro de regresiones:** crear `defects/regressions.md` con entradas solo estáticas y verificadas, distinguiendo activas y resueltas.
3. **Esquema y migración:** añadir tablas/columnas de ejecución, evidencia, PDF, auditoría e idempotencia mediante migraciones incrementales; cambiar la resolución de `0_init` a un chequeo de esquema verificado, sin enmascarar fallos.
4. **Compatibilidad:** mantener lectura de referencias legacy `s3://`/`azure://` y aceptar payloads clínicos con alias canónico; no romper clientes actuales sin aviso.
5. **Storage:** implementar la abstracción dual backend/ML (Azure Blob y MinIO), `ensure` por provider, referencias estructuradas, verificación de existencia/upload y firma de descargas bajo demanda; conservar el comportamiento local actual.
6. **ML/worker:** fijar contrato JSON, recuperación, persistencia completa, estados terminales y revisión; reintentos solo transitorios.
7. **Seguridad:** cerrar registro público de rol, validar `is_active`, implementar ownership, bloqueo HU01, sesiones con `sessionId`/`tokenVersion`, protecciones del último admin y auditoría.
8. **PDF:** generar básico idempotente y versionado con original sanitizada + mask + overlay embebidas; bloquear completitud si falta un artefacto obligatorio.
9. **Azure:** preparar scripts aislados y manifest de cleanup; ejecutar solo tras aprobación de B6.
10. **Rollback:** conservar datos y evidencia; deshabilitar nuevas rutas/flags sin borrar historial. La migración de datos legacy debe ser reversible o mantener lectura dual.

## Open Questions / Decisiones y restricciones

| ID | Estado | Decisión / restricción | Efecto |
|---|---|---|---|
| B1 | **RESUELTO / RESTRICCIÓN APROBADA** | El médico no convierte una ejecución sin resultado válido en `COMPLETED`; `REVIEW_REQUIRED` se preserva. La resolución es un reanálisis como ejecución nueva, con imagen/snapshot nuevos si procede y PDF independiente vinculado, sin pisar la anterior. No hay endpoint approve-review ejecutable ni auto-complete manual; el endpoint review queda deferred y no es target del producto actual. | No bloquea; se implementa la restricción. |
| B2 | **RESUELTO / RESTRICCIÓN APROBADA** | Una consulta completada no se reabre ni altera automáticamente; no se promueven ni reemplazan `requiredExecutionIds` tras cierre; los reanálisis históricos independientes no modifican el frozen set. | No bloquea; se implementa el conjunto congelado. |
| B3 | PENDIENTE SOLO PRODUCCIÓN | Retención numérica de evidencia, PDF, auditoría y export. No se fijan plazos ni se declara cumplimiento legal. | No bloquea desarrollo ni pruebas sintéticas/PAPILA con acceso mínimo; bloquea purgas y producción real. |
| B4 | PENDIENTE SOLO PRODUCCIÓN | Consentimiento, privacidad y anonimización. No se afirma anonimización por HMAC ni cumplimiento legal. | No bloquea desarrollo ni pruebas sintéticas/PAPILA; fail closed con datos clínicos reales sin governance. |
| B5 | PENDIENTE SOLO PRODUCCIÓN | Supresión de identidad/legal y futura excepción de hard delete. Desactivación + revocación es la acción del hito; sin cascada ni reasignación. | No bloquea desarrollo ni pruebas sintéticas/PAPILA; bloquea purgas/supresión real. |
| B6 | **PARCIALMENTE SATISFECHO (CLI) / NO DEPLOYMENT READY** | Lectura CLI read-only verificada (default `Enabled`/`AzureCloud`, `group list` vacío) sin crear ni destruir recursos. Faltan presupuesto numérico, duración, scope, confirmación de contexto y permisos/quota justo antes de crear. No se declaran capa gratuita, cuotas ni RBAC de creación. | El prereq CLI no autoriza gasto ni despliegue; el deploy real sigue bloqueado. Arquitectura futura preferida: Container Apps con entrada web/proxy pública y backend/ML internos (D18); no cambia el bloqueo ni promete capa gratuita. |
| B7 | DEFERRED / NO BLOQUEO | RF07 unimodal y RF15 comparación no se implementan ni simulan. | No bloquea el hito. |
| B8 | PENDIENTE SOLO PROVISIONING | Email real autorizado cuando se llegue; direcciones y proveedor aún no fijados. Tests primero con sink en memoria; envío real solo a destinatarios autorizados, sin PHI/enlaces secretos, sin versionar direcciones/credenciales, con rate limit y sin user enumeration. | No bloquea diseño/implementación ni tests con sink; bloquea solo provisioning/envío real. |
| B9 | **FUERA DE ALCANCE / NO BLOQUEO** | `DatabaseFeedbackSource` y SQLAlchemy quedan expresamente fuera de este hito. | No bloquea el change. |

## Evidence Map (static, not runtime)

| Tema | Evidencia |
|---|---|
| Storage solo MinIO crea buckets | `ml/service/storage.py:59-70`; Azure no implementa `ensure_buckets` (`ml/service/storage.py:95-166`); arranque lo invoca (`ml/service/queue.py:84,157`). |
| Normalización y aislamiento de payload | `ml/service/queue.py:16-32,187-202`; helper `request_to_dict` sin llamador. |
| Pipeline y revisión | `ml/inference/pipeline.py:104-127,184-186`. |
| Worker incompleto | `backend/src/workers/inference.worker.ts:33-47,51-64,67,74-83,91-95`. |
| Persistencia disponible | `backend/src/repositories/inference.repo.ts:30-45`; contrato `backend/src/schemas/inference.ts:27-40`. |
| Auth y roles | `backend/src/routes/auth.ts:18-60,93-112`; `backend/src/middleware/auth.ts:12-24`; `backend/src/middleware/rbac.ts:5-11`. |
| Ownership incompleto | `backend/src/routes/consultations.ts:173-229`; `backend/src/routes/inferences.ts:93-143`. |
| Migración indiscriminada | `docker/migrate.Dockerfile:18`. |
| Compose y red externa | `docker-compose.yml:27-37,197-200`. |
| Contrato clínico estricto y alias | `backend/src/schemas/clinical.ts:8-65`; `ml/service/schemas.py:30-49`. |
| Clases canónicas | `backend/src/schemas/common.ts:42-48`; `ml/service/schemas.py:19-27`. |
| Estado de artefactos actual | `ml/inference/pipeline.py:163-183`; `backend/src/schemas/inference.ts:28-39`. |
| Suite de pruebas destructiva | `backend/tests/global-setup.ts:40-47` (`DROP SCHEMA public CASCADE`); es comportamiento destructivo actual, no una salvaguarda; requiere DB creada/adoptada con ownership marker, allowlist de target y deny producción. |
| Storage backend actual | `backend/src/services/storage.ts:1-98` solo S3/MinIO; Azure Blob no está implementado en backend y requiere abstracción dual. |
| Fixes ML de la rama | `ded48db`, `92a6887`; `e5d184a` es solo de `master`, subconjunto, y no se cherry-pickea a ciegas. |
| Test runner destructivo | `backend/vitest.config.ts:6` fuerza `globalSetup`; `backend/tests/global-setup.ts:24-47` exige que el nombre contenga `test` y hace `DROP SCHEMA public CASCADE`. Un test focalizado no evita ese setup. Runbook: `contracts/testing-runbook.md`. |
| Comandos actuales | `backend/package.json` scripts `test`, `typecheck`; `ml/pyproject.toml` pytest `testpaths=["tests"]`; `scripts/e2e-backend.ps1`, `scripts/test_azure_e2e.py`, `scripts/benchmark_latency.py`. No existe un script `e2e` en `package.json`. |
