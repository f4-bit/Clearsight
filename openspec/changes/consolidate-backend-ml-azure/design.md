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

- `storageId` resuelve provider, cuenta y endpoint desde configuración confiable del backend. El backend **CURRENT** implementa provider dual S3/MinIO y Azure Blob (`backend/src/services/storage.ts`, providers y factory); 3.2 tiene QA PASSED y conserva la API pública de `StorageService`.
- La `key` se conserva **exactamente** como fue producida; no se normaliza de forma que cambie el objeto.
- Prohibido persistir SAS, presigned URLs, claves personales o URLs externas arbitrarias.
- El backend autoriza cada descarga y firma una URL nueva bajo demanda.
- Si la URL expira, el frontend solicita otra; no la infiere ni la reconstruye.
- El parser central acepta referencias legacy `s3://bucket/key` y `azure://container/key` sin `split` ingenuo: separa esquema, primer contenedor y key completa; valida contra ubicaciones allowlisted.
- SAS de Azure debe ser read-only, sobre el objeto, HTTPS y de TTL configurable acotado. D5 mantiene 300 s como objetivo de 4.8; 3.4 no adopta ese cambio y usa el default configurado 1..3600 (ver D24); 3.2 conserva 3600 s por compatibilidad con los callers actuales (ver D22). MinIO usa URL firmada equivalente. No se promete revocación inmediata: revocar una cuenta no revoca una URL ya emitida; un proxy revocable es una opción futura no implementada.
- La forma de referencia de artefacto es única en diseño, contrato y API: camelCase en el contrato clínico; los campos nulos son explícitos y solo `AVAILABLE` tiene `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes` y checksum.
- La abstracción de storage **CURRENT** existe en backend y ML: Azure Blob con SAS read-only sobre objeto, HTTPS, existencia/verificación de upload y `ensure` de solo lectura; MinIO con presign equivalente y `ensure` de buckets. D22/3.2 tienen QA PASSED; 3.8 quedó QA PASSED en HITO22. No se implementa un provider como caso especial del otro.

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
- **Sesiones (decisión técnica propuesta por el arquitecto dentro de la delegación industry, no decisión exacta de producto; acceso durable y contrato web 5.8 implementados/QA PASSED; reset implementado en R2 y 5.9 QA PASSED):** JWT de acceso breve con default 15 min, `sessionId` y `tokenVersion`; en cada request el servidor consulta la sesión activa, la versión y el usuario activo/rol vigente en un store durable y aplica **fail closed** si no puede verificar. Refresh opaco generado con CSPRNG, hash en reposo, rotación atómica de un solo uso y detección de reutilización que revoca la familia; expiración absoluta simple de 7 días, sin extensión por idle salvo configuración explícita. Logout revoca la sesión de inmediato. Desactivar revoca todas las sesiones e incrementa la versión. Cambios de rol invalidan tokens/permisos de inmediato. Reset de contraseña usa token de un solo uso, 30 min, hash, sin logs, y revoca todas las sesiones; `forgot` responde `202` uniforme con rate limit y proveedor de envío configurable. El contrato operativo detallado de `forgot`/`reset` (cuotas independientes, token solo en body, entrega deshabilitada por defecto y preservación de HU01) está en D20.
- Para web (contrato 5.8, D19), el login conserva el JSON actual y el refresh se transporta únicamente en una cookie opaca `HttpOnly; Secure; SameSite=Lax`, host-only y `Path=/api/auth` (nombre fijo `clearsight_refresh`), nunca en JSON; login y refresh exigen un `Origin` exactamente igual al origen público configurado (`AUTH_PUBLIC_ORIGIN`, sin wildcard) y rechazan con `403` antes de KDF/store si falta o no coincide. El access bearer no se sugiere guardar en `localStorage`. El cliente backend no-browser queda fuera de alcance. La respuesta de refresh no expone el refresh token. **B8 (email):** el usuario autoriza usar sus correos reales cuando se llegue a esa etapa, pero aún no se fijan direcciones ni proveedor. Las pruebas MUST usar primero un adaptador de email con sink en memoria; el envío real solo se habilitará a destinatarios que el usuario indique y autorice explícitamente, para casos sin PHI y sin enlaces secretos no autorizados. No se versionan direcciones, datos personales ni credenciales; el flujo MUST aplicar rate limiting y no revelar existencia de cuentas (no user enumeration). El provisioning/configuración del sender/provider queda pendiente para la etapa no funcional de backend auth y no bloquea diseño, implementación ni pruebas con sink. No se introduce una dependencia bloqueante nueva para esta seguridad prioritaria: se usan primitivas criptográficas y almacenamiento durable existentes en el stack.

**Razón:** `backend/src/routes/auth.ts:18-60` permite que cualquier cliente se registre como `ADMIN`; `backend/src/middleware/auth.ts:12-24` no valida `is_active`. El payload JWT actual (`sub` + `role`) y la firma HS256 sí son correctos (`backend/src/routes/auth.ts:58-60,114-117`) y se conservan; la brecha está en el alta pública, la comprobación de cuenta activa y la autorización por recurso, no en el formato del token.

### D10. Auditoría append-only y borrado

**Decisión (agreed):** Se auditan acciones sensibles con actor, target, acción, resultado y timestamp. El registro es append-only; no se actualiza ni se borra desde la aplicación. No contiene secretos, tokens, URLs firmadas ni PHI innecesaria. Si falla la auditoría de una operación sensible, la operación no se considera exitosa (transacción o compensación explícita).

**Acuse `202` vs éxito sensible (D20):** en `forgot`, `202` es solo acuse de recepción; no prueba que se emitió un token ni que se entregó un correo. Si falla la auditoría, la creación del token se revierte y no se entrega, aunque la respuesta HTTP siga siendo `202`. En `reset`, el `204` solo se emite después del commit auditado; un fallo de almacenamiento, auditoría o hash responde `503` con rollback y sin consumir el token. La distinción evita tratar un acuse uniforme como éxito de una operación sensible.

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

La cobertura de storage dual incluye dobles de SDK y firma real offline con cuenta/clave sintéticas, sin Azure real, y un E2E posterior contra Azure real autenticado: imagen → backend Blob → descarga ML → mask/overlay → DB → PDF → URLs, incluyendo almacenes ausentes. Los tests de PDF parsean el PDF real, extraen texto, cuentan imágenes renderizadas y verifican encabezado/numeración de HU08; no se limitan a un mock de snapshot. Las unidades clínicas solo se muestran si su mapeo/codebook está verificado; un mapeo no demostrado bloquea la interpretación clínica de esa etiqueta, no la totalidad del contrato.

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
- `RefreshToken` y `PasswordResetToken` guardan solo hash SHA-256 lowercase, nunca el token opaco. Identidad, hash y expiración son inmutables; `consumedAt`/`revokedAt` son append-only. Refresh exige misma sesión/usuario, expiración acotada por la sesión y padre existente/misma sesión; el puntero de padre es insert-only y único (un sucesor), lo que evita ciclos. La detección de reutilización/familia y la rotación quedaron implementadas en 5.8 (QA PASSED); el logout con revocación y limpieza de cookie también; el reset de contraseña quedó implementado en R2 y 5.9 QA PASSED.
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

**Decisión (implementada en 5.8 y validada por QA; reset de contraseña R2 con 5.9 QA PASSED):**

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

### D20. Recuperación de contraseña 5.9: forgot/reset sin sesión, cuotas independientes y entrega deshabilitada por defecto

**Decisión (aprobada por el usuario; R1+R2 implementados y 5.9 QA PASSED en HITO17):** `forgot` y `reset` son endpoints públicos sin sesión ni cookie, con token de recuperación transportado solo en el body de `reset`. Las cuotas de recuperación son durables y **independientes** del login/HU01; el envío real de email queda deshabilitado por defecto y limitado a un puerto inyectable con sink en memoria solo para pruebas. R1 implementa la migración incremental y el guard de cuotas; R2 implementa endpoints, token lifecycle, revocaciones y entrega disabled/memory sink. No se implementa frontend, proxy, Azure ni envío real.

**Persistencia existente que se reutiliza**

- `PasswordResetToken` (`backend/prisma/schema.prisma:386-399`; migración C `backend/prisma/migrations/20261118020000_identity_audit/migration.sql:344-405`) ya impone hash SHA-256 lowercase de 64 hex, `expires_at <= created_at + 30 minutes`, identidad/expiry inmutables y `consumed_at`/`revoked_at` append-only. 5.9 usa esa tabla sin editar la migración C, `docker/init.sql` ni `0_init`.
- **No se reutiliza ni se altera** `auth_login_buckets` ni `login-guard.ts`: sus `kind` `IDENTIFIER`/`IP`, su dominio HMAC y sus cuotas 5/15 min y 100/60 s pertenecen a login. Cambiar su semántica o mezclar propósitos rompería HU01 y sus pruebas.
- La migración incremental implementada es `20261119020000_password_recovery_quotas`. Es aditiva, idempotente y no reescribe migraciones publicadas ni el baseline. Añade el modelo Prisma `AuthRecoveryBucket` mapeado a `auth_recovery_buckets`, sin FK a `users` y con grants de mínimo privilegio a `clearsight_app` coherentes con la migración E: `SELECT/INSERT/UPDATE`; `DELETE/TRUNCATE/TRIGGER/REFERENCES` revocados; fallo cerrado si el rol falta, es inseguro, es owner o existe un grant efectivo prohibido (incluido PUBLIC).
- **R1 implementado (HITO17):** migración `20261119020000_password_recovery_quotas`, modelo `AuthRecoveryBucket`, guard `backend/src/services/password-recovery-quota.ts`, tests unitarios/integración y evidencia en `tasks.md`/`contracts/testing-runbook.md`.
- **R2 implementado y QA PASSED (HITO17):** `backend/src/services/password-reset.ts`, puerto `password-reset-delivery.ts` con `DISABLED` por defecto y memory sink explícito, rutas públicas `/auth/password/forgot|reset`, schemas estrictos, DI Fastify, redacción de `token/email/newPassword`, pruebas unitarias e integración. QA final: unit R2 **7/7**, focal unit R1+R2 **19/19**, unit total **27 files / 396 tests**, foco integración R2 **28 tests**, full integration **23 files / 444 tests** (401 baseline + 15 R1 + 22 R2 + 6 QA), `typecheck` 0 después de QA y `build` reutilizado del mismo source maker 0. El proxy público `/api/auth/password/*` no se implementa; el backend expone internamente `/auth/password/*`. B8 (proveedor/credenciales reales) sigue pendiente de provisioning y no bloquea el cierre de 5.9.
- Tabla implementada:

  ```sql
  auth_recovery_buckets (
    kind               VARCHAR(16) NOT NULL, -- FORGOT_EMAIL | FORGOT_IP | RESET_IP
    key_hash           VARCHAR(64) NOT NULL, -- HMAC-SHA256 lowercase, 64 hex
    attempt_count      INTEGER     NOT NULL DEFAULT 0,
    window_started_at  TIMESTAMPTZ(6) NOT NULL,
    updated_at         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, key_hash),
    CHECK (kind IN ('FORGOT_EMAIL','FORGOT_IP','RESET_IP')),
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    CHECK (
      (kind = 'FORGOT_EMAIL' AND attempt_count BETWEEN 0 AND 3)
      OR (kind IN ('FORGOT_IP','RESET_IP') AND attempt_count BETWEEN 0 AND 20)
    ),
    CHECK (updated_at >= window_started_at)
  )
  ```

  No hay `locked_until`: la cuota es una ventana fija calculada, no un lock persistido. No se guardan email, IP, token ni secretos en claro.

**Dominio HMAC separado y normalización**

- Subclave: `HMAC-SHA256(jwtSecret, "clearsight:auth-password-recovery:v1")`, distinta de `clearsight:auth-login-protection:v1`.
- Clave de bucket: `HMAC-SHA256(subclave, kind || 0x00 || valorCanonico)` en hex lowercase, donde `kind` es `FORGOT_EMAIL`, `FORGOT_IP` o `RESET_IP`. El valor canónico es el email canónico (`trim`/lowercase, mismo `canonicalEmailSchema`) para `FORGOT_EMAIL`, y la IP literal del socket para los dos `kind` de IP.
- La IP se toma de `request.socket.remoteAddress`; **no** se habilita `trustProxy` global ni se lee `X-Forwarded-For`/`Forwarded` controlado por el cliente. Si una llamada directa no expone IP, se usa un bucket sintético `INTERNAL`, nunca una ruta sin cuota. Limitación aceptada: detrás de un proxy todos los clientes pueden compartir la IP del proxy; no se corrige confiando en headers del cliente.

**Cuotas durables y orden de consumo**

| Operación | `kind` | Valor | Límite | Ventana fija |
|---|---|---:|---:|---:|
| `forgot` | `FORGOT_EMAIL` | email canónico | 3 | 3600 s |
| `forgot` | `FORGOT_IP` | socket IP / `INTERNAL` | 20 | 3600 s |
| `reset` | `RESET_IP` | socket IP / `INTERNAL` | 20 | 900 s |

- Ventana fija desde el primer intento: `window_started_at` se fija con el primer consumo; al cumplirse la ventana se reinicia a `now`; el contador se incrementa bajo `SELECT ... FOR UPDATE` por fila. La decisión es atómica y durable.
- `forgot`: con body válido se consume **primero `FORGOT_IP` y después `FORGOT_EMAIL`**, aunque el email ya esté agotado. Si la IP está bloqueada, no se consume el email. Después de ambas cuotas se hace el lookup.
- `reset`: con body válido se consume **`RESET_IP` antes del lookup del token y de bcrypt**. Un token inválido/expirado/usado/revocado o un usuario inactivo también consume la cuota IP.
- Body inválido (`400`) no consume cuota. El store de cuotas no disponible antes del lookup responde `503` genérico para conocido, desconocido e inactivo por igual.
- `429` usa body genérico fijo y `Retry-After` entero en segundos, `ceil` del tiempo restante con mínimo 1. No revela email, estado de cuenta ni contador.
- Estas cuotas **no** leen, escriben ni reinician las cuotas/contadores de login (HU01).

**Contrato `POST /auth/password/forgot`**

- Request estricto `{ email: string(email canónico, trim/lowercase, <=255) }`; campos desconocidos `400`.
- Sin cookie, sin sesión y sin `preHandler` de autenticación. `Authorization`, si llega, no se usa como credencial. `Origin` es opcional como en logout: si el header está presente se aplica la misma política exacta (`403` mismatch/null, `503` si falta configuración); si está ausente se permite porque no hay cookie como credencial.
- Respuesta uniforme para conocido, desconocido e inactivo: `202` con body fijo `{ "accepted": true }`, `Cache-Control: no-store`, sin token, usuario, rol ni estado de entrega. Es un **acuse de recepción**, no prueba de emisión ni de entrega.
- Flujo implementado:
  1. Validar body; consumir cuota IP y email.
  2. Si el puerto está `DISABLED` (default): `202` inmediatamente después de las cuotas, **antes del lookup de usuario**, sin generar token y **sin invalidar tokens anteriores**. Es la ruta más uniforme y evita tocar la DB de usuario.
  3. Buscar usuario por email canónico. Si no existe o `isActive=false`: `202`, sin token y sin cambios.
  4. Si el sink de pruebas está habilitado explícitamente: transacción auditada con lock de la fila de usuario, generación del token, inserción, revocación de tokens anteriores no revocados y auditoría; commit **antes** de intentar la entrega.
  5. Errores posteriores a las cuotas (lookup, creación de token, auditoría o entrega) responden `202` uniforme. Un fallo de auditoría revierte la creación y no se entrega; un fallo de entrega no promete entrega y se registra como fallo operativo sin email ni token crudos.
- Concurrencia: dos `forgot` exitosos del mismo usuario se serializan por la fila de usuario. El token creado por la transacción que confirma en último lugar es el único válido; su transacción revoca los anteriores no revocados. La entrega puede llegar fuera de orden; un token anterior sigue siendo inválido aunque su correo llegue después.
- Fallo de entrega: se intenta revocar **solo ese token exacto** de forma condicional (`revoked_at IS NULL` y `consumed_at IS NULL`) con auditoría; nunca se revoca en bloque ni se afecta a un token creado después o a otro usuario. Si la compensación/auditoría falla, se registra el fallo operativo sin secreto y se mantiene el `202`.

**Token de recuperación y entrega**

- Token crudo: 32 bytes de CSPRNG (`randomBytes`) codificados base64url, 43 caracteres; en DB solo SHA-256 lowercase; expiración `now + 30 min` usando el reloj inyectado; sin extensión ni reutilización. El boundary `expiresAt <= now` es inválido.
- El puerto de entrega es inyectable (`PasswordResetDelivery`), con modo por defecto `DISABLED`. No hay proveedor real, dependencia de email nueva, endpoint que exponga el sink ni variable de entorno que habilite envío real en este hito.
- El sink en memoria es **solo para pruebas explícitas** y recibe `recipient` + `rawToken` en una instancia local, no global. No se registra en logs/JSON/URLs ni se persiste; no se expone por HTTP. El correo de prueba no contiene el token en una URL, query ni fragmento: el token se entrega como texto para que el usuario lo introduzca en el formulario.
- No hay outbox de correo en 5.9. Se declara explícitamente que `202` **no garantiza entrega**; un crash después del commit y antes de la entrega puede dejar un token persistido sin correo. El proveedor real y sus credenciales siguen en B8, pendiente de provisioning sin bloquear el cierre de 5.9.

**Contrato `POST /auth/password/reset`**

- Request estricto `{ token: string, newPassword: string }`; campos/claims desconocidos `400`. `newPassword` usa la misma política actual: al menos 12 code points Unicode y como máximo 72 bytes UTF-8; hash bcrypt con cost 12. Body inválido `400` sin consumir cuota.
- Sin cookie, sin sesión y sin autenticación Bearer. `Authorization` no sustituye al token y el token solo se acepta en el body. `Origin` opcional con la misma política que logout.
- Estados: token inválido, expirado (`expiresAt <= now`), ya consumido, revocado o usuario inactivo ⇒ `401` genérico idéntico; cuota IP agotada ⇒ `429` con `Retry-After`; store/auditoría/hash no disponible ⇒ `503` genérico con rollback. No se reactiva un usuario inactivo.
- Éxito: transacción auditada con orden de locks `user -> password_reset_token` (y después actualizaciones de sesiones/refresh), revalidación del token bajo lock, `passwordHash` nuevo con cost 12, `tokenVersion + 1` exactamente una vez (invalida los access tokens previos), `consumedAt` del token usado y revocación de:
  - todos los demás `PasswordResetToken` no revocados del usuario;
  - todas las `UserSession` no revocadas, con `reasonCode = PASSWORD_RESET`;
  - todos los `RefreshToken` no revocados del usuario;
  - auditoría append-only en la misma transacción.
- `204` sin body, sin `Set-Cookie`, sin access token y sin crear sesión nueva. El usuario debe autenticarse de nuevo.
- **No** modifica `failedLoginCount`, `lockedUntil` ni `auth_login_buckets`; el lockout de login vigente se conserva. Un reset exitoso no desbloquea la cuenta. No toca grants clínicos, historial, inferencias ni PDFs.
- Dos `reset` concurrentes del mismo token: como máximo uno confirma `204`; el otro ve el token consumido y responde `401`. Dos tokens distintos del mismo usuario: el que confirma primero revoca el otro y el segundo responde `401`.

**Errores, caché y redacción**

- Todas las respuestas de `forgot`/`reset`, incluidas las de error, llevan `Cache-Control: no-store`.
- Bodies de error genéricos y constantes; sin email, token, usuario, rol ni estado de cuenta. `Retry-After` solo en `429`.
- Extender la redacción de logs con `req.body.token` y `req.body.email` (`newPassword` ya está cubierto) y mantener `Authorization`/cookies. La entrega y la compensación registran solo resultado/acción segura, nunca recipient, email, token crudo ni hash.
- No se construyen enlaces con el token en URL, query o fragmento; no se devuelve el token en JSON ni en cabeceras.

**Relación con D10 y con el ciclo de vida existente**

- `forgot` `202` y `reset` `204` no son equivalentes: el primero es un acuse que puede ocultar fallos post-cuota; el segundo es un éxito sensible que solo se declara tras commit auditado. Un fallo de auditoría en `forgot` revierte la creación y no entrega; en `reset` produce `503` con rollback.
- El patrón de DI, schema explícito, reloj inyectado y `withAuditedTransaction` sigue a `auth-web-session.ts`; la revocación de sesiones/refresh/reset y el bump de `tokenVersion` sigue el lifecycle ya implementado en `admin-users.ts:624-656`, con la diferencia de que `reset` consume el token usado y **no** altera el lockout de login.

**Fuera de alcance de 5.9**

- Frontend, proxy, Azure, `.env.azure`, entornos reales, PDFs, PHI, proveedor real de correo, outbox y nuevas dependencias de email.
- Cambiar `/auth/register` (`410`), el JSON de login, `/auth/me` o el contrato de access/sesión vigente. 5.9 quedó cerrada con QA PASSED; B8 (proveedor/credenciales reales) sigue pendiente de provisioning y no bloquea el cierre.

### D21. Contexto clínico preparado, snapshot veraz y pin de contexto (HITO19, tarea 2.2)

**Decisión (aprobada por el usuario; A, B y C completas; QA final global PASSED; H1 PASSED):** La creación de una ejecución contextualizada usa la `clinicalFeatures` de la request como fuente autoritativa y obtiene del runtime ML el snapshot normalizado real y la huella de contexto. El objetivo es que el snapshot persistido no pueda mentir por un redeploy, un cambio de parámetros, una diferencia de backend o un artefacto sustituido. A (ML), B (backend) y C (worker) tienen implementación, tests y QA; 2.4/4.2/4.3 siguen parciales con dueño independiente.

**Alcance y límites duros**

- 2.2 **NO** modifica `requiredExecutionIds`, **NO** adelanta el freeze/`requiredSetVersion` de 2.5 y **NO** implementa la agregación de consulta de 2.3.
- **NO** implementa idempotencia 4.4, outbox/reconciliación 4.6, publicación/reintento de artefactos 3.5/3.6 ni PDF 6.x.
- **NO** publica PDF, **NO** reintenta outbox, **NO** hace backfill y **NO** toca Azure, frontend, `.env` reales ni el SRS.
- `COMPLETED` de ML sigue sin equivaler a consulta completada. 2.4 queda **parcial**: 2.2 solo elimina el autocompletado prematuro y preserva `REVIEW_REQUIRED`; la agregación y el PDF siguen en 2.3/2.5/6.x.
- **REG-002/REG-003/REG-004 no se declaran resueltos.** `defects/regressions.md` es del humano y no se reescribe; 2.2 documenta mitigación/parcialidad y 4.2/4.3 siguen siendo las tareas que cierran su contrato completo cuando corresponda.

**Fuente autoritativa y forma del snapshot**

- `imageId`, consulta y ojo salen de la DB y del ownership. `eyeSide` de la request MUST coincidir con `Image.eyeSide` o `422`; el ojo **nunca** se toma de la respuesta ML.
- `clinicalFeatures` de la request validada es la única fuente del payload crudo; **nunca** se lee `consultation.clinicalData` para construirlo.
- `rawPayload` persistido: objeto `{ eyeSide, clinicalFeatures }` con las 11 claves canónicas y números finitos, exactamente los enviados (sin conversión de unidades, defaults ni recortes). El backend reconstruye el objeto en el orden de `CLINICAL_FEATURE_NAMES`; el orden efectivo también se documenta en el descriptor.
- `normalizedPayload` persistido: objeto `{ eyeSide, orderedFeatureNames, dtype, values, descriptor, canonicalJson, contextFingerprintSha256 }`, donde `values` son 11 números producidos por el helper real `normalize_clinical_features` (`ml/inference/classification.py:17-33`) con `float32` y epsilon `1e-8`, `descriptor` es el descriptor efectivo completo (modelo/backend/artefactos/binarios, mean/std con fuente, orden, dtype, epsilon y preprocessing), `canonicalJson` son los bytes canónicos exactos usados para la huella y `contextFingerprintSha256` debe coincidir con la huella de nivel superior. El backend **no recalcula** el z-score en JS; solo copia los valores ya calculados y verifica SHA-256 sobre `canonicalJson` sin canonicalizar de nuevo. Un vector todo cero es válido (features en la media); “no vacío” significa 11 valores finitos, no “no cero”.
- `schemaVersion` persistido: constante local del algoritmo `ml-zscore-f32-v1`. Describe z-score/float32/epsilon; **no inventa unidades clínicas** ni afirma equivalencia con el codebook.
- `modelVersions` persistido: objeto no vacío y real, sin `{}` ni `"v1"` fabricado. Contiene `manifest`, `backend` (`pytorch`|`onnx` **efectivo**, no el solicitado si hubo fallback) y `segmentation`/`efficientnet_b3`/`resnet50` como `repository@revision` verificados del manifiesto. Si no se puede resolver, la preparación falla `503`; no se persiste un snapshot parcial.

**Endpoint interno `POST /v1/clinical-snapshots/prepare` (ML)**

- Autenticado con el mismo `require_service_token`; si el runtime no está disponible, `current_runtime()` responde `503` antes de tocar DB. No es un endpoint público y el frontend no lo llama.
- Request estricto (`extra=forbid`): `{ clinical_features: <11 campos>, requested_model_version?: string | null }`. No acepta `eye_side`, `consultation_id`, `clinical_data` libre, URLs ni archivos.
- `requested_model_version` no nulo MUST ser igual a la versión efectiva del manifiesto del runtime; si difiere, `422` seguro sin cargar/descargar modelos ni escribir DB. `null` resuelve el runtime actual; **nunca** se inventa `"v1"`.
- Response estricta: `{ rawCanonical, normalizedPayload, schemaVersion, modelVersions, contextFingerprintSha256 }`.
  - `rawCanonical = { clinicalFeatures: { ...11... } }`, sin `eyeSide` ni claves extra.
  - `normalizedPayload = { orderedFeatureNames: [...11...], dtype: "float32", values: [...11...] }`, sin `eyeSide`.
  - `schemaVersion = "ml-zscore-f32-v1"`.
  - `contextFingerprintSha256` = SHA-256 hex lowercase 64 de la serialización canónica del descriptor, sin el campo de huella.
- El backend añade `eyeSide` autoritativo al persistir. Si la respuesta ML contiene `eyeSide`, claves extra, valores no finitos, orden distinto, versión distinta o huella no hex, rechaza `503` y no escribe DB.
- Errores seguros: `401` token interno inválido; `404` endpoint inexistente (ML viejo) ⇒ backend `503`; `422` versión solicitada inexistente o `clinical_features` finitas no representables en float32 (`invalid_clinical_features`); `503` runtime/contexto/artefacto no verificable, incluidos `mean`/`std` efectivos fuera de float32. El backend propaga cualquier `prepare` 422 como `422` genérico seguro y 404/otros como `503`. Sin URL, PHI, tokens, rutas ni valores crudos en body/log.

**Descriptor inmutable y huella de contexto**

El runtime construye una sola vez, al arrancar, un descriptor inmutable con:

- `manifest_version`, `backend` efectivo y, por artefacto, `repository`, `revision` y `sha256` verificados del manifiesto;
- si `backend=onnx`, SHA-256 real de los archivos ONNX fijados (`efficientnet_b3.fp16.onnx`, `resnet50.fp16.onnx`) calculado **una vez** al runtime, no por request;
- normalización efectiva: `algorithm="zscore"`, `dtype="float32"`, `epsilon=1e-8`, `ordered_feature_names` del manifiesto, y `mean`/`std` con `value` y `source` (`env` si `ML_CLINICAL_MEAN_JSON`/`ML_CLINICAL_STD_JSON` aportó la lista completa; si no, `manifest`). Se conserva la semántica actual todo-o-nada: no se mezclan fuentes por elemento ni se relee env por request;
- settings no secretos de preprocessing/segmentation que afectan el resultado (por ejemplo `image_size`, `disc_threshold`, `cup_threshold`, `crop_margin`, `classifier_crop_size/min/max`, `clahe_*`). No incluye tokens, endpoints, buckets, DSNs, rutas locales, device ni timeouts; la validación de tamaño mínimo de entrada no forma parte del descriptor porque rechaza antes de inferir y no cambia el resultado.

La serialización canónica es JSON con claves ordenadas, sin espacios, UTF-8, listas en orden de manifiesto y números en su forma JSON estable. `contextFingerprintSha256 = sha256(canonical_json(descriptor))`; el propio campo de huella no se incluye. Cambiar backend, revisión, checksum, media/desviación, epsilon, dtype, orden de features o un setting de preprocessing/segmentation cambia la huella; cambiar un secreto, un endpoint o una ruta de caché no.

**Pin `expected_context` en el contrato ML**

- `InferenceRequest` de `/v1/inferences` añade `expected_context?: { schema_version: string, fingerprint_sha256: string }` opcional, estricto si existe: `schema_version` no vacío (el valor preparado es `ml-zscore-f32-v1`) y `fingerprint_sha256` hex lowercase 64.
- Los jobs nuevos del backend **siempre** envían el pin preparado. El worker lo transmite sin recortarlo ni sustituirlo.
- ML compara el pin con el contexto del runtime:
  - al aceptar el job, si puede comparar y difiere, responde error seguro no retryable (propuesta: `409` con `detail="context_mismatch"`, sin URL/PHI);
  - en `run`, antes de descargar la imagen y de segmentar, revalida; si difiere, termina `FAILED` con `message="context_mismatch"` seguro;
  - **nunca** hace fallback silencioso al contexto nuevo ni descarta el pin para “arreglar” el job.
- Requests legacy sin `expected_context` siguen aceptándose y ejecutándose con el runtime actual (compatibilidad de rollout). El orden de despliegue es **ML primero** (entiende el campo opcional), después backend (prepara y envía pin) y después worker (transmite/valida). Un request legacy nunca obtiene un pin inventado.
- `model_version` legado sigue aceptándose; en el camino nuevo de preparación, un valor no nulo distinto del manifiesto deja de ignorarse: `prepare` responde `422`. No se rompen llamadas legacy desconocidas que no traen contexto.

**Creación backend transaccional (B)**

- `POST /inferences` mantiene el `202 { inferenceId, jobId, status: "QUEUED" }` actual y añade errores de contrato `400/401/403/404/422/503`. `409` queda reservado a 4.4 y **no** lo emite 2.2.
- Body: `{ imageId, eyeSide, clinicalFeatures, modelVersion?, reanalysisOf? }`; `reanalysisOf` es UUID opcional. No acepta `expected_context`, `eyeSide` de ML, `imageUrl`, `consultationId` ni `clinicalData`.
- Orden: auth/rol → ownership de imagen (`404` uniforme ajeno/inexistente) → si hay `reanalysisOf`, ownership del padre (`404` uniforme) → validar `eyeSide` contra imagen (`422`) → validar contexto del padre (`422` antes de prepare/DB) → `prepare` ML (timeout 15 s, sin reintentos infinitos) → validar respuesta → TX DB → commit → firmar URL/enqueue.
- Padre legacy: si `consultationId`/`eyeSide` son NULL, manda la imagen autoritativa; si no son NULL y contradicen consulta/ojo, `422`. No se compara el snapshot del padre con el contexto nuevo: el reanálisis crea snapshot nuevo.
- `prepare` 404/unsupported, timeout, 5xx, JSON inválido, `clinicalFeatures` alteradas, `eyeSide` en la respuesta o huella/versión inválida ⇒ `503` seguro sin DB y **sin fallback sin pin**. Un `422` de prepare por versión solicitada inexistente se propaga como `422` sin DB, sin confundirlo con un fallo de disponibilidad.
- TX misma DB: `ClinicalSnapshot` + `Inference` con `id` de servidor, `consultationId`, `eyeSide`, `snapshotId`, `reanalysisOfId`, `status="QUEUED"` y `modelVersion` igual a `modelVersions.manifest` de la preparación (versión efectiva; no el `requested_model_version` crudo ni `"v1"`). Si falla el SQL, no queda snapshot huérfano. Antes de insertar se releen imagen y padre bajo locks `FOR SHARE` en orden determinista (UUID), siguiendo los triggers de A/D; no se confía en la lectura previa de ownership (no TOCTOU). No se lockea la consulta completa ni agregados.
- **NO** se actualiza `consultation.status` en creación ni en worker para ningún job (nuevo o legacy). `COMPLETED`/`REVIEW_REQUIRED`/`FAILED` son estados de ejecución; la consulta se deriva en 2.3/6.x. Se elimina el autocompletado actual, no se conserva un shim legacy que perpetúe REG-003.
- Post-commit: si falla storage/firma/Redis/cola, la ejecución y el snapshot quedan persistidos y la cola queda pendiente explícita; se responde `503` seguro sin fingir `202`. No se promete atomicidad Redis/outbox; 4.6 la implementa. Mientras 4.4 no exista, esto es un riesgo residual documentado.

**Worker (C) y regresiones**

- `startInferenceWorker()` se conserva como bootstrap. El procesamiento se extrae a un processor con DI (`mlClient`, repos/`prisma`, reloj/sleep, intervalo 2 s, máximo 60 polls) para poder testear sin Redis ni import side effects.
- El job data incluye `expectedContext` (camelCase) con `{ schemaVersion, fingerprintSha256 }`; `MlClient` lo mapea a `expected_context` snake_case. El worker **nunca** lo omite.
- Terminales: `COMPLETED`, `REVIEW_REQUIRED`, `FAILED`. `REVIEW_REQUIRED` persiste resultado parcial disponible y **no** se lanza como fallo/retry. `FAILED` persiste causa segura. Un `409 context_mismatch` al aceptar se trata como `FAILED` terminal seguro, sin quitar el pin ni reintentar con el contexto nuevo. Poll acotado a 120 s (60×2 s); timeout ⇒ `FAILED` seguro, sin bucle infinito.
- Antes de persistir valida `result.inference_id === job.inferenceId` y `result.eye_side === job.eyeSide`; si no, fallo terminal seguro sin persistir datos ajenos. Valida etiqueta canónica; etiqueta desconocida en `COMPLETED` ⇒ rechazo seguro/no adivinar (4.3 formaliza).
- Persistencia terminal condicional: si la ejecución ya está `COMPLETED`/`REVIEW_REQUIRED`/`FAILED`, no se sobrescribe con una entrega duplicada; el segundo intento es no-op idempotente. No se pierden `cdrVertical`, `quality`, `artifacts`, `elapsedSeconds` ni `modelVersions` ya disponibles. `modelVersion` se deriva de `modelVersions.manifest` ya fijado (o de las versiones reales del resultado); **nunca** `"v1"`. La persistencia completa y su exposición siguen en 4.2.
- **NO** se actualiza `consultation.status` ni se auto-completa la consulta para ningún job, incluido legacy. REG-002/003/004 quedan mitigados/parcialmente cubiertos, **no** declarados resueltos.

### D22. Proveedor de storage dual backend: MinIO/S3 por defecto y Azure Blob por SDK oficial (HITO20, tarea 3.2)

**Decisión (aprobada por el usuario; implementación completada; QA final PASSED):** 3.2 introduce en el backend una abstracción explícita de provider para MinIO/S3 y Azure Blob sin cambiar el comportamiento local ni el contrato público actual de `StorageService`. QA final: focus storage **2 files / 36 tests** (35 + 1 QA de precedencia de validación), unit completo **33 files / 473 tests**, integración focal **3 files / 41 tests**, `typecheck` **0**, `build` **0** reutilizado del mismo source y audit **13** baseline **13** (delta 0). 3.2 queda cerrada `[x]`; 3.8 quedó `[x]` QA PASSED en HITO22.

**Selección, fachada y compatibilidad**

- `STORAGE_PROVIDER` acepta exactamente `minio` o `azure`. Ausente ⇒ `minio` (default retrocompatible). Cualquier otro valor ⇒ **fail closed** con error seguro, sin elegir un provider por defecto ni intentar firmar/leer.
- Se conservan las firmas públicas y el export actual de `backend/src/services/storage.ts`: `getDownloadUrl`, `getMlDownloadUrl`, `upload`, `ensureBucket`, `getObjectStream` y `s3Client`. `s3Client` sigue siendo el cliente MinIO/S3; no se reutiliza como Azure.
- `StorageService` actúa como fachada y delega en un `StorageProvider` resuelto por configuración confiable e inyección de dependencias. La construcción no abre red ni valida credenciales contra el proveedor; el provider se resuelve de forma perezosa y el default de unit tests sigue siendo MinIO, sin exigir configuración Azure.
- La interfaz interna `StorageProvider` expone como mínimo `ensure`, `upload`, `sign`, `read` y `exists`. Un provider no debe simular una capacidad que no soporta; si una operación no aplica, falla de forma explícita y segura.
- `storageId` es lógico y local a configuración: `minio-local` para MinIO y `azure-blob-default` para Azure. No se persiste ni se cambia el esquema de DB; 3.3 definirá el parser y la referencia estructurada que consumirá este `storageId`.

**Azure Blob**

- Se usa el SDK oficial `@azure/storage-blob` (hoy ausente). La autenticación usa `SharedKeyCredential` con la clave de cuenta; no se implementa firma SAS casera ni criptografía propia.
- La configuración Azure es explícita: URL HTTPS de cuenta, nombre de cuenta y clave. No se leen `.env.azure`, cadenas de conexión existentes ni se asume una conexión ya creada. La `accountURL` debe ser HTTPS y coherente con el nombre de cuenta; si falta, es inválida o no es `AzureCloud`, falla de forma segura y **no** cae a MinIO.
- `ensure` de Azure solo comprueba la existencia del contenedor; **nunca** lo crea. Contenedor ausente o error del SDK ⇒ fallo seguro, sin provisioning en runtime.
- `upload` acepta `Buffer`/`Uint8Array` y un `contentType` no vacío y bien formado (rechaza controles/CRLF/whitespace-only), validado antes de cualquier I/O. Sube el objeto y verifica con `getProperties` que `contentLength` y `contentType` coinciden. Si el objeto no existe o los metadatos no coinciden, falla de forma segura y no devuelve una URL ficticia. **No** borra el objeto tras un mismatch post-upload: la reconciliación/limpieza de huérfanos pertenece a 3.5 y un borrado ciego podría destruir evidencia previa.
- `sign` verifica primero que el objeto existe. Un objeto ausente se reporta como ausente; un error de permisos o de red **no** se confunde con un `404` ni se traga. El SAS es por objeto, con permisos read-only (`p=r` como abreviatura; el SDK oficial emite `sp=r`), `sr=b`, `spr=https` y expiración acotada; no concede otros permisos ni se emite a nivel de contenedor.
- La expiración usa un reloj inyectable (`now`) para poder probar TTL de forma determinista. La clave y la configuración sensible no se exponen en logs, errores, URLs ni respuestas.
- Managed Identity no se soporta en 3.2; queda anotado para 8.x. No se declara ni se asume permiso de provisioning en runtime. La QA de firma Azure es **solo offline con SDK real y clave sintética**: no se creó, modificó ni destruyó ningún recurso Azure.

**MinIO/S3**

- Se preservan el endpoint interno y el endpoint distinto de `ML_PUBLIC_HOST` con sus puertos: `sign` usa el cliente correspondiente y no mezcla ambos.
- `ensure` usa `HeadBucket`: crea el bucket **solo** ante `404`/not found. Otros errores de permisos o de red se propagan de forma segura; no se declaran “inexistentes”. En creación concurrente se acepta `AlreadyOwnedByYou`; un `BucketAlreadyExists` de un bucket ajeno **no** se absorbe.
- `upload` usa `PutObject` con `contentType` validado antes de I/O y verifica con `HeadObject` longitud y tipo. Si la verificación falla, no se declara éxito ni se borra el objeto; 3.5 decide la reconciliación. Un fallo genérico de `PutObject` se normaliza a `storage_upload_failed`; `401`/`403` conservan `storage_permission_denied`.
- `read` devuelve un `Readable`. No se registran signed URLs, credenciales ni parámetros de firma.

**TTL y deuda vigente**

- `MINIO_SECURE` solo acepta booleanos reales o los strings exactos `true`/`false`; valores como `TRUE`, `yes`, `1`, vacío o con espacios fallan cerrado y nunca se convierten en `false` silenciosamente.
- Los callers legacy conservan el default actual de 3600 s; no se modifica la cola de delivery antes de 4.8. Se añade configuración de TTL entero en el rango 1..3600 con default 3600; ese valor es **default, no cap**, y un override explícito del caller puede subir hasta 3600 aunque el default configurado sea menor.
- La adopción de 300 s queda para 4.8; 3.4 no la adopta y usa el default configurado 1..3600 (D24), por lo que **no** se promete en 3.2. D5 conserva 300 s como objetivo futuro; este apartado documenta la deuda sin cambiar defaults existentes.

**Keys de objeto**

- La key se preserva exactamente: espacios, `%`, Unicode y barras no se normalizan, no se decodifican con `decodeURI`, no se convierten a rutas de filesystem y no se parten de forma ingenua.
- Si una representación de key no puede enviarse exactamente por el SDK (por ejemplo, segmentos completos `.` o `..`), se rechaza explícitamente con error seguro en vez de normalizarla en silencio. No se inventan reglas adicionales para keys codificadas o Unicode fuera de lo que el SDK no soporte.
- No se aceptan bucket, contenedor, host ni endpoint desde input HTTP. La resolución es interna y confiable. La allowlist obligatoria de referencias no forma parte de 3.2; llega con 3.3.

**Errores y fuera de alcance**

- Las excepciones crudas del SDK se envuelven en un error genérico con código seguro; la causa queda privada/omitida. Nunca se exponen cuentas, URLs, claves, SAS ni detalles internos.
- 3.2 **no** implementa el parser de artefactos (3.3), la ruta nueva de artefactos (3.4), el endurecimiento de logs (3.7), migraciones/cambios de DB ni modifica `storagePath` actual. Tampoco toca la cola de delivery (4.8), el storage ML (3.1) ni Azure real.
- Tests de 3.8 (combinados con 3.4, QA PASSED): dobles de SDK y firma real del SDK con cuenta/clave sintéticas sin red. Azure se valida por parsing del SAS (`sp=r` en el wire oficial; `p=r` es la abreviatura de D22), `sr=b`, `spr=https`, TTL con reloj inyectado y key/path exactos; MinIO por comandos del SDK y reloj fake. Se prueban `no fallback`, trampa de red, que el cliente S3 solo recibe llamadas MinIO, que Azure no crea contenedores y que los errores se propagan. Todo hermético, sin Azurite, Docker innecesario ni credenciales Azure.
- La dependencia `@azure/storage-blob` solo se instala desde el registry permitido, sin modelos ni Azure CLI, y el lockfile se actualiza de forma acotada sin upgrades globales ni `audit fix` masivo. Los `.env.example`/README se actualizan en la implementación posterior, no en este turno documental.
- 3.2 queda `[x]` con QA PASSED; 3.8 quedó `[x]` con QA PASSED en HITO22 (cobertura combinada con 3.4).

### D23. Referencia estructurada, allowlist y parser legacy central (HITO21, tarea 3.3)

**Decisión (implementada; QA focal 3.3 PASSED; `[x]`):** 3.3 fija una única interpretación de las referencias de artefacto: parser puro, contexto de storage confiable, allowlist explícita, compatibilidad legacy determinista y DTO seguro. No se añaden repositorios nuevos, no se toca la DB y no se implementa la ruta 3.4 ni la publicación 3.5.

**Parser y contexto confiable**

- El parser (`backend/src/services/artifact-reference.ts`) es puro: recibe un `string` (URI o bare legacy) o una ubicación estructurada `{ storageId, bucketOrContainer, key }`, más un contexto confiable `{ provider, storageId, allowedBuckets, defaultBucket }`. No usa SDK, red, filesystem ni variables de entorno globales.
- Parser y DTO comparten la política pura de `backend/src/lib/artifact-key.ts`, para que un `ArtifactRef AVAILABLE` no exponga una key que el firmante rechazaría.
- `provider`, `storageId`, `allowedBuckets` y `defaultBucket` provienen solo de configuración interna del backend. Nunca se aceptan bucket, contenedor, endpoint, provider ni `storageId` desde HTTP.
- La identidad de una ubicación estructurada MUST coincidir con el `storageId` y provider activos. Si `storageId` no coincide, o el provider/contenedor es desconocido, se rechaza fail closed antes de cualquier firma o SDK. En producción solo existe el provider activo: no hay registry cross-provider ni fallback de red para adivinar.
- Una migración multi-cuenta no se implementa en 3.3. Cualquier referencia cross-provider legacy se rechaza de forma segura hasta que un operador configure una migración explícita.

**URIs, esquemas y keys**

- Se aceptan exactamente `s3://bucket/key` y `azure://container/key`. El esquema es case-insensitive solo para `s3`/`azure`; el resto del valor no se reinterpreta. El primer `/` tras `://` separa bucket/container del resto, que es la key exacta. No se usa `new URL()`, `path.normalize`, `trim` de la key ni `decodeURI`/percent-decoding.
- Esquemas/URLs externos (`file://`, `http://`, `https://`, `blob:` u otro desconocido), credenciales, autoridad, host/puerto y query SAS se rechazan. La forma soportada no tiene usuario, autoridad ni query de firma.
- La key conserva literalmente espacios, Unicode, `%`, `?`, `#` y `&`, que son caracteres válidos de object key. Se rechazan solo: blank o whitespace-only, NUL/controles, segmentos completos `.`/`..` que el SDK no puede representar (regla 3.2), un comienzo de URI genérica `^[A-Za-z][A-Za-z0-9+.-]*:` (incluidos `blob:`/`file:`/`data:` sin `//`) y keys que contienen un patrón de firma. El `://` no inicial se preserva: `folder/http://literal.bin` es una key válida.
- El patrón de firma es el mismo de la migración B, case-insensitive: `(^|[?&])(sig|x-amz-signature|x-amz-credential|x-amz-security-token)=`. Una referencia rechazada nunca se ecoa completa en errores ni logs; solo se reporta un error seguro.
- El nombre de bucket/container se valida con la regla del provider activo. Un bucket/contenedor no allowlisted se rechaza; no se consulta el provider para decidir si “podría” existir.

**Bare legacy determinista**

- Sin esquema, si el primer segmento es un bucket/contenedor allowlisted, la referencia se interpreta como `bucket/container` + key exacta del resto.
- Si el primer segmento no es allowlisted, la cadena entera se interpreta como key y exige un `defaultBucket` confiable y allowlisted; la key se preserva completa, sin recortes.
- La precedencia es determinista y no consulta la red: `raw-retinas/foo` se trata por convención como bucket `raw-retinas` y key `foo`. Un caller que realmente tenga una key que empiece por el nombre de un bucket debe usar la ubicación estructurada con la key entera; no se promete reconstrucción universal de bare legacy ni se adivina entre ambas interpretaciones.
- El default de imagen es `MINIO_BUCKET_RAW` y el de Grad-CAM es `MINIO_BUCKET_GRADCAM`. En Azure se usan esos mismos valores como contenedores lógicos legacy de la configuración actual, sin inventar cuentas ni endpoints.

**Allowlist**

- `STORAGE_ALLOWED_BUCKETS` es un CSV opcional del provider activo, leído solo de configuración confiable. Ausente ⇒ defaults `MINIO_BUCKET_RAW` + `MINIO_BUCKET_GRADCAM`. Explícito no vacío ⇒ se valida, se normaliza y se deduplica; el default debe pertenecer a la lista cuando ese contexto se use. Explícito vacío o lista vacía ⇒ fail closed: no existe “allow all”.
- No se añaden automáticamente buckets/contenedores ajenos. En el futuro la configuración podrá extender la allowlist a `mask`/`overlay`/`pdf`; 3.3 no lo activa.
- Un `defaultBucket` que no pertenezca a una lista explícita es error de configuración/contexto, no un fallback silencioso.

**DTO y mapper**

- El `ArtifactRef` binario target excluye `result` y contiene explícitamente `artifactType`, `status`, `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes`, `checksumSha256`, `failureCode`, `retryable` y `updatedAt`. El catálogo de `ArtifactType` incluye `result` por separado para el `ExecutionResult` inline existente; `result` no tiene objeto storage ni `ArtifactRef` con ubicación.
- Todos los campos se emiten explícitamente; los no aplicables son `null`, salvo `retryable`, que siempre es booleano (`false` si no aplica). Solo `AVAILABLE` tiene `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes` y `checksumSha256` válidos; `updatedAt` es ISO válido en todos los estados. `sizeBytes` es entero seguro `>= 0`: un bigint de DB mayor que `Number.MAX_SAFE_INTEGER` se rechaza, no se redondea. El checksum es hex de 64 caracteres; el PDF `AVAILABLE` usa `application/pdf`.
- En estados no `AVAILABLE`, los campos de storage/key/contentType/size/checksum son `NULL`. `FAILED` exige `failureCode` válido de hasta 64 caracteres y `retryable` booleano; cualquier otro estado exige `failureCode=null` y `retryable=false`. El mapper canónico emite `false` (no `null`) para `retryable` y no inventa metadata `null` donde la DB ya define `false`.
- El mapper de fila DB a `ArtifactRef` no fabrica hash, tamaño ni un `AVAILABLE` sin metadata. El parser de ubicación no fabrica un `ArtifactRef AVAILABLE` legacy (una referencia legacy no tiene checksum/tipo): `ArtifactLocation` es un tipo separado de la referencia completa.
- 3.3 no necesita un repositorio nuevo de `ArtifactRecord`; la publicación/versionado pertenece a 3.5. No hay backfill de filas legacy.

**Integración actual y errores**

- POST `/inferences`: el parser se ejecuta en el punto actual de firma de la imagen, después de auth, preparación clínica y la transacción de creación, inmediatamente antes de `signMlDownloadUrl`/storage. No se mueve la firma antes de la DB ni se añade un assert “sin DB antes del parser”: 4.6 ya persiste el contexto.
- GET `/inferences/:id/gradcam`: el parser se ejecuta después de `access.getInferenceForRead(..., "readArtifacts")` y antes de cualquier sign/read. El parser no enumera buckets ni se ejecuta antes de auth/ownership.
- Los uploads y el seed actuales no se reescriben: uploads siguen guardando `bucket/key` en `storagePath`, el seed conserva su key raw-only (`2026/10`) y Grad-CAM conserva su key-only. El parser solo interpreta/valida al leer o firmar; no migra ni normaliza esos datos existentes.
- La fachada `StorageService` gana solo métodos aditivos para resolver el contexto/allowlist desde configuración confiable; sus exports/firmas legacy (`getDownloadUrl`, `getMlDownloadUrl`, `upload`, `ensureBucket`, `getObjectStream`, `s3Client`) no cambian. El seam DI usa el mismo provider activo que firma; resolver una referencia no exige credenciales Azure reales.
- La configuración/DI de app debe ser consistente y no caer a un fallback global de entorno para auth/schema/DB. El diseño mínimo elegido por el maker debe mantener esa consistencia.
- Una referencia corrupta o no resoluble es dato server-owned inválido: se responde `503` seguro por el path de artefacto existente, sin datos raw, sin log de la referencia y sin llamar al storage; no se convierte en `400` de cliente. Objeto ausente/artefacto faltante conserva `404`; no autorizado conserva `403`/`404` actuales.
- No cambian las respuestas `{ url, expiresIn }`, ni el TTL actual de 3600. No se implementa la ruta nueva 3.4, el publisher 3.5, el trabajo de logs 3.7, criptografía Azure, cambios de modelo ni cambios de DB.

**Casos de test (implementados localmente; QA focalizada pendiente)**

- URI `s3://`/`azure://` válidas, equivalentes estructurados, mismatch de `storageId`/provider/container, allowlist vacía/forbidden, esquema desconocido y autoridad/credenciales/query SAS rechazados sin SDK ni red.
- Key exacta con Unicode/`%`/`?`/`#`/`&` preservada, `%` literal sin decode, key con `/` inicial doble preservada, key con esquema o patrón de firma rechazada, y `.`/`..` completos rechazados.
- Bare legacy con defaults correctos, precedencia `raw-retinas/foo` como bucket/key, key-only preservada y default fuera de allowlist fail closed.
- DTO binario en todos los estados, campos requeridos/null, `result` fuera de `ArtifactRef`, bigint fuera de rango rechazado y mapper `retryable=false`.
- Integración: POST raw existente conserva los args de firma; gradcam con URI resuelve los args correctos; autorizado firma y no autorizado no llama al storage.

### D24. Listado paginado y URL versionada de artefactos bajo demanda (HITO22, tarea 3.4; QA PASSED)

**Decisión (implementada; QA PASSED):** 3.4 añade dos endpoints de lectura sobre `ArtifactRecord`/`PdfReport` sin tablas, migraciones, publisher ni rutas de reportes. El contrato vNext se corrigió porque no existe caller actual ni placeholder de frontend que consuma el `ArtifactRef[]` plano ni una URL sin `version`; no se ofrece compatibilidad con esa forma plana.

**Listado `GET /inferences/:id/artifacts`**

- Respuesta `{ items: [{ artifactId, version, reference: ArtifactRef }], total, limit, offset }`. `artifactId` y `version` son el envelope y no forman parte de `ArtifactRef` (forma única de 3.3); `reference` conserva exactamente sus campos y nulls.
- Query estricta: `limit` entero con default 20 y máximo 100; `offset` entero seguro con default 0; `type` opcional limitado a tipos binarios (`mask`, `overlay`, `gradcam`, `shap`, `pdf`). Un `type` desconocido o `result` devuelve `400`.
- El `type` válido filtra **además** sobre la capability: si el actor tiene alguna capability de artefacto pero no sobre ese tipo, la intersección es vacía y responde `200` con `items=[]`/`total=0`, sin revelar si existen filas de ese tipo. Sin ninguna capability de artefacto (incluido `readResult` solo), la ejecución es `404` uniforme.
- Orden estable `artifactType ASC`, `version DESC`, `id ASC`. El filtro de tipos permitidos se aplica en SQL **antes** de ordenar, paginar y contar; `total` solo cuenta tipos autorizados y no se devuelven filas de tipos no permitidos.
- Una lista vacía por falta de filas con capability vigente es `200`. Ejecución inexistente, ajena o sin capability devuelve `404` uniforme; JWT inválido devuelve `401`.
- Autorización = unión de **todos** los grants activos del actor: `readArtifacts` sobre `mask`/`overlay`/`gradcam`/`shap` y `readPdf` sobre `pdf`; `ADMIN` no implica acceso clínico. El médico dueño accede a todo; un médico no dueño sin grant no accede (5.2); `readResult` solo no permite listar ni firmar artefactos. Los locators de tipos no autorizados no se exponen ni se filtran en la respuesta: simplemente no se devuelven. Los locators autorizados son el `ArtifactRef` binario; no se persisten URLs/SAS.

**URL `GET /inferences/:id/artifacts/:type/url`**

- `version` es obligatoria en query, entera positiva y `<= 2147483647`; ausente o inválida devuelve `400`. No hay `latest` implícito ni fallback a una versión `AVAILABLE` anterior. `result` devuelve `400` porque se sirve inline.
- La fila exacta inexistente (pertenencia a la inferencia/tipo/versión) o la falta de acceso devuelven `404`. Una configuración de storage inválida (`storageId`/provider/bucket allowlist/location) o metadata de fila corrupta devuelve `503` seguro antes del SDK; no se convierte en `404` ni se finge un bugfix de fuente.
- DTO binario `{ artifactType, status, url, expiresInSeconds, contentType, reportVersion }`. Un `AVAILABLE` válido devuelve `url`, `contentType` y el TTL efectivo configurado (default 1..3600; 3.2 conserva 3600; 300 queda para 4.8). Un estado no `AVAILABLE` devuelve `200` con `url`/`expiresInSeconds`/`contentType` nulos y sin llamar al storage.
- `reportVersion` solo existe para PDF con un `PdfReport` válido de la misma inferencia/versión. Un PDF `AVAILABLE` sin reporte publicado devuelve `409` y registra incidente; no se fabrica publicación. Para tipos no PDF es `null`.
- 3.4 no añade rutas `/reports` (6.2) ni cambia la API legacy `GET /inferences/:id/gradcam`. No extrae `ArtifactRecord` ficticios desde strings de `Inference.artifacts` ni inventa hash/checksum (publisher 3.5 pendiente).

**Dependencias, storage y TTL**

- DB: la lectura se apoya en la unicidad existente de `ArtifactRecord` por (`inferenceId`, `artifactType`, `version`) y en el vínculo de `PdfReport` de la misma inferencia/versión; `AVAILABLE` es inmutable. 3.4 no crea tablas, constraints ni migraciones.
- Las rutas usan las mismas fuentes inyectadas de DB/access/authService/storage. Se añade un helper `ArtifactReadScope` que resuelve la unión de grants con `findMany`/flags, sin cache de grants, y filtra los tipos permitidos de la query.
- La ubicación de la fila pasa por el parser 3.3 con contexto trusted para `row.bucket` y la allowlist activa; 3.4 amplía explícitamente la configuración para incluir `mask`/`overlay`/PDF. Un contexto no default debe comprobar que el bucket ya esté allowlisted; nunca se usa el bucket de DB para extender la allowlist ni se inventa un default. Se reutilizan el mismo resolver de objeto y signer; el resolver de metadata Azure debe poder operar sin credenciales y sin fallback cross-provider.
- No se cambia el TTL de contrato a 300 antes de 4.8: se usa el default configurado 1..3600 y se devuelve el TTL efectivo; los callers legacy conservan 3600.

**Auth fresca, auditoría y fallos**

- Auth se ejecuta antes de leer metadata o storage. Después de la firma se relee la sesión con `authService.verifySession(claims)` y se revalida la capability del tipo antes de auditar y responder: sesión revocada/inactiva `401`; pérdida de grant `404` sin URL. No se mantienen locks de DB durante I/O de red y no se promete cancelar una firma en vuelo tras la última comprobación ni revocar un SAS ya emitido (limitación de TTL); no se promete atomicidad absoluta entre permiso y HTTP.
- La URL solo se devuelve tras el commit de `AuditEvent` con acción `ARTIFACT_URL_ISSUED`, `targetType=ARTIFACT`, `targetId=artifactId`, actor `USER` real y `metadata.reasonCode` fijo, sin locators raw, URL ni PHI. Si la auditoría falla: `503` sin URL. No se crea un canal especial: se usa el metadata opcional `reasonCode`.
- Objeto ausente con fila `AVAILABLE`: solo `StorageProviderError storage_object_missing` se traduce en auditoría de incidente `ARTIFACT_OBJECT_MISSING`/`STORAGE_OBJECT_MISSING` y `409`, sin URL ni mutación de `ArtifactRecord`/`PdfReport`. Permisos o red devuelven `503`, nunca un `404` falso. PDF sin reporte publicado: `409` con auditoría `REPORT_NOT_AVAILABLE`. Auditoría caída: `503` genérico, sin incidente inventado.
- No hay tablas, migraciones, actores/labels falsos ni detalles inventados. La inconsistencia se marca como auditoría append-only, no cambiando `AVAILABLE` (inmutable); la reconciliación es 3.5. Todas las respuestas de URL (éxito o fallo) y de listado llevan `Cache-Control: no-store`; los `503` no exponen URL ni causa del servidor.

**Alcance de implementación y cierre**

- El encargo puede dividirse en A (repositorio/lectores, `ArtifactReadScope`, filtro/orden/paginación) y B (HTTP, auth fresca post-I/O, auditoría, guard PDF/reporte y errores de storage), pero se implementa como un encargo cohesivo. Los tests usan fixture snapshot → inference → `ArtifactRecord AVAILABLE` → `PdfReport` respetando el SQL real.
- 3.4 y 3.8 quedan cerradas con QA PASSED. 3.8 combina el SDK real offline de 3.2 con los tests de 3.4 (auth, objeto ausente, fallo de storage y versiones), sin Azure ni Azurite. La publicación/reconciliación 3.5 y las rutas `/reports` de 6.2 siguen pendientes; no se declara generador PDF implementado.

**Logs de descarga (3.7; QA PASSED HITO23)**

- La redacción de la URL es total, no selectiva: `req.url`, `req.originalUrl` y `req.query` se censuran completos en el logger. No se limpian `X-Amz-Signature`/SAS con expresiones regulares porque la query es adversarial y puede venir codificada; el `reqId`, método y status cubren la correlación operativa.
- Se conservan las rutas de credenciales y se añaden variantes de casing para headers sensibles (`Authorization`, `Cookie`, `Proxy-Authorization`, `Set-Cookie`) como defensa si un serializer expone headers con otra capitalización. No se introduce un redactor universal de strings ni un framework nuevo.
- `buildLoggerOptions` es la única configuración del logger; un test real de Fastify captura el stream Pino en memoria mediante el seam tipado `AppDeps.logDestination`. No existe una opción para desactivar la redacción y el logger sigue deshabilitado por defecto en tests.
- Causa raíz del QA 3.7: el 404 stock de Fastify (`lib/four-oh-four.js:52-59`) llama `logController.routeNotFound`; `lib/log-controller.js:118-122` interpola `request.raw.url` en el mensaje `Route <method>:<url> not found`, que la redacción por path no puede limpiar. `registerGenericNotFoundHandler` se instala en el root público antes de plugins/rutas y responde `{ message: "Route not found", error: "Not Found", statusCode: 404 }` sin invocar `routeNotFound` ni ecoar URL/query en body/log; cubre ruta desconocida, path malformado y método no soportado. Los `400`/`401` de auth/schema ya seguros no cambian.
- Límite residual: otros logs internos de Fastify que interpolan strings (fuera de `req`/`res`) no se censuran de forma universal; no se modifica `node_modules` ni se añade un redactor de mensajes. Un eventual log interno de doble envío con URL no tiene trigger alcanzable en las rutas 3.4 y queda documentado, sin abrir un cambio interno del framework.
- Escenarios cubiertos: query canary antes de validación (health, `401`), descarga exitosa con URL firmada solo en el body, objeto ausente, permiso/red con secreto y fallo de auditoría. En todos, los logs conservan `reqId`/método/status y no incluyen URL, locators, SAS ni causa. Los tests usan la misma configuración de producción (`buildLoggerOptions` + installer 404), no un mirror.
- QA final: maker focus **3 files / 65 tests** antes de QA; QA post **13 unit / 13** y **24 download / 24**; las 6 regresiones rojas de 404 (`basic404` → `routeNotFound`) quedan verdes. `typecheck`/`build` **0** reutilizados del mismo source. **3.7 queda `[x]` con QA PASSED.**

### D25. Admisión ML estricta, persistencia de versiones/predicciones y catálogo canónico único (HITO24, tareas 4.1-4.3; QA PASSED)

**Decisión (aprobada por el usuario; 4.1-4.3 QA PASSED HITO24):** este bloque fija el contrato de tres unidades secuenciales. El cierre no ejecuta suites completas ni toca Azure/`.env` reales, PDF, commits, descargas de modelos, SMTP ni `defects/regressions.md`.

**4.1 Admisión y política de URL (D25.1)**

- La política de URL es un helper puro y compartido, sin red, SDK ni DB, alimentado solo por `Settings` confiable. Se usa en la admisión de `POST /v1/inferences` y otra vez antes del `GET` real de la imagen; no hay una segunda interpretación divergente entre API y pipeline.
- `ML_ALLOWED_SIGNED_URL_HOSTS` debe ser no vacío para HTTP y HTTPS. Lista vacía o ausente ⇒ fail closed; no existe “allow all” ni default permisivo. HTTPS es el default de producción; HTTP solo se admite con `ML_ALLOW_HTTP_SIGNED_URLS=true` explícito y allowlist no vacía (compatibilidad de desarrollo MinIO `localhost`/`minio` con puerto). El flag no habilita HTTP en producción.
- Se rechazan sin inferir y sin encolar: esquemas distintos de `http`/`https` (`file:`, `data:`, `ftp:` y cualquier otro), hostname ausente, credenciales/userinfo, fragmento en la URL raw, puerto inválido, host vacío y host fuera de la allowlist. Los mensajes de error son códigos seguros sin URL, host ni query; no se loguea la URL raw.
- La allowlist se evalúa por hostname/patrón, no por URL completa. Se conserva el wildcard legacy acotado `*.blob.core.windows.net` con semántica de sufijo conocido; no se aceptan comodines globales ni patrones no acotados. No se añade un framework global de resolución DNS/private-IP en esta tarea: la allowlist es la autoridad y el residual de DNS rebinding/redes privadas queda documentado, no resuelto por una capa nueva. Tampoco se valida criptografía/SAS en el ML: la autoridad de firma es storage.
- El DTO sigue siendo JSON estricto (`extra=forbid`), con las once features clínicas finitas. Se rechazan multipart, CDR de entrada, `cdr_vertical` y campos desconocidos con `422` antes de encolar; `image_url` con host/esquema inválido, HTTP deshabilitado o allowlist vacía también devuelve `422` antes de encolar, sin inferencia. La política de auth del servicio entrante se conserva; no se introducen tokens ni scopes nuevos en producción.
- La descarga revalida la URL justo antes del `GET`, usa `follow_redirects=False`, bloquea cualquier `301`/`302`/`307` como redirección no permitida (no sigue ni reconstruye una URL nueva) y mantiene el `ML_REQUEST_TIMEOUT_SECONDS` actual (no se fija 15 s en este bloque). El tamaño se acota por `Content-Length` y por bytes realmente leídos en stream hasta `ML_MAX_IMAGE_BYTES`.
- Tests 4.1(A) con `httpx` monkeypatched, sin runtime ni descarga real de modelos, y cola fake/seam. Los fixtures configuran allowlist correcta y URL válida; no se modifica el fallback de producción para hacer pasar un test.

**Evidencia HITO24-A (2026-11-20; 4.1 QA PASSED):** helper puro en `ml/inference/url_policy.py`; `Runtime.settings` explícito; `POST /v1/inferences` valida antes de pin/queue con `422` y códigos fijos; `_download_image` revalida antes de `httpx.Client` con `follow_redirects=False`; JSON sin Content-Type sigue soportado vía `APIRouter(strict_content_type=False)`; `host_is_allowed(())` falla cerrado; `urlparse` corrupto ⇒ `invalid_image_url` y `httpx.InvalidURL`/`content-length` inválido ⇒ `image_download_failed`, sin catch global. Foco **5 files / 86 tests passed** (35 nuevos en `ml/tests/test_service_contract.py`); `ruff`/`mypy` limpios. Sin full ML, Azure/`.env`, modelos, PDF, SMTP ni commit.

**4.2 Persistencia de versiones y predicciones (D25.2)**

- Nueva migración incremental `20261120000000_inference_result_details` (timestamp libre; la última migración existente es `20261119020000_password_recovery_quotas`): añade a `inferences` las columnas `model_versions JSONB NOT NULL DEFAULT '{}'` y `model_predictions JSONB NOT NULL DEFAULT '{}'`, con CHECK de objeto JSON, replay idempotente y privilegios de `clearsight_app`. `0_init` y el baseline quedan intactos.
- Las filas históricas conservan `{}` como “resultado desconocido”; no se copia el string legacy `modelVersion` como si fuera el resultado real de `modelVersions` ni se rellena un objeto inventado. `snapshot.modelVersions` sigue siendo el input inmutable de la preparación clínica, no el resultado efectivo.
- Prisma `Inference` expone `modelVersions` y `modelPredictions`. `TerminalInferenceUpdate`/CAS `saveTerminalResult` persisten ambos objetos completos, con las claves tal como las devuelve el wire ML y validación estricta existente. `COMPLETED` guarda el resultado completo; `REVIEW_REQUIRED` guarda la evidencia parcial válida disponible; `FAILED` guarda `{}` y no inventa clases ni predicciones. `cdr`, `cdrVertical`, `quality`, `artifacts` y `elapsedSeconds` ya implementados se conservan.
- `modelVersion` primario sigue siendo compatibilidad resuelta (sin `"v1"` fabricado). El `saveResult` deprecated puede aceptar los campos nuevos como opcionales por compatibilidad, pero no tiene caller de producción; no se refactoriza el CAS de 4.9 en esta tarea.
- `GET /inferences/:id` no cambia: los límites son de persistencia, no de exposición pública nueva, y `readResult` no puede filtrar artefactos. No se implementan `ArtifactRecord` ni PDF en este bloque.
- El JSON de `modelVersions`/`modelPredictions` mantiene los tipos ya tipados en el cliente: `snake_case` del wire ML se mapea a `camelCase` como hoy; los labels se preservan como strings reales, sin transformarlos, normalizarlos ni deducir una clasificación.
- Tests 4.2(B) reales: replay de migración, CHECK JSON, defaults de filas legacy, privilegios de app, CAS/duplicados y round-trip de campos `REVIEW_REQUIRED`; sin suite completa.

**Evidencia HITO24-B (2026-11-20; 4.2 QA PASSED):** migración `20261120000000_inference_result_details` aplicada/verificada con replay, CHECK de objeto, defaults `{}` en legacy y privilegios de `clearsight_app`; Prisma validado/generado con URL sintética desde `prisma.config.ts` (sin `.env` real); `TerminalInferenceUpdate`/CAS y processor persisten `modelVersions`/`modelPredictions` reales en `COMPLETED`/`REVIEW_REQUIRED` y `{}` en `FAILED`. **Counts pre/post separados:** baseline migración **3 files / 56** (pre-fix, incluye migration tests; SQL/source sin cambios), cierre worker/repo **2 files / 31** y unit **4 files / 86**; `typecheck`/`build` **0**. **Corrección QA:** `REVIEW_REQUIRED` con `probabilities={}` legítimo conserva segmentación; CAS JSONB raw **schema-qualified** (`public`/custom validado) preserva keys propias y evita `search_path` decoy. En su unidad B no se incluyó GET nuevo, `ArtifactRecord`/PDF, full suites, Azure/`.env`, SRS, modelos ni commit.

**4.3 Catálogo canónico único (D25.3)**

- `backend/src/schemas/common.ts` es la fuente única. `CLASS_LABELS` conserva exactamente `0 Glaucoma`, `1 Non_Glaucoma`, `2 Suspicious_Glaucoma`; se exportan un mapa tipado y un helper `canonicalClassIndex` derivados de esa lista, y el processor los usa en lugar de su mapa local.
- Solo se preservan los aliases/casing legacy que el processor local ya aceptaba: `glaucoma`, `non_glaucoma`, `suspicious_glaucoma`. El matching legacy usa `toLowerCase()` únicamente para esos tres nombres (incluye mixed/uppercase), sin `trim`, substring ni otras variantes; cualquier valor restante es desconocido. El helper es seguro para `null`/`undefined` y para claves de prototipo como `__proto__`, `constructor` y `toString`, devolviendo `null` sin lanzar.
- En `COMPLETED`, una etiqueta desconocida termina en `FAILED` con código de error fijo y seguro, sin label raw en logs de producción. En `REVIEW_REQUIRED`, una etiqueta desconocida deja `predictedClass=null` y conserva la demás evidencia parcial válida; la revisión no se autoaprueba ni se convierte en `COMPLETED`, y no se fabrica `0`/`1`.
- La validación de `modelPredictions` por modelo no puede guardar un label desconocido mapeado como diagnóstico. Si un modelo trae una etiqueta desconocida, se aplica fail closed de forma consistente con el estado (sin inventar clase) y nunca se loguea el label raw en producción.
- Tests 4.3(C): tres clases canónicas, casing legacy, `unknown`/`null`, `__proto__`/`constructor`/`toString`, `COMPLETED` desconocido ⇒ `FAILED` seguro, `REVIEW_REQUIRED` desconocido ⇒ `null` preservando el resto y predicciones por modelo desconocidas/malformadas fail closed. Fuera de alcance: 4.4, 4.6, 4.7, 4.9, polling/GET nuevos y edición de `defects/regressions.md`.

**Evidencia HITO24-C (2026-11-20; 4.3 QA PASSED):** `CLASS_LABEL_INDEX`/`CLASS_LABEL_SET`/`canonicalClassIndex` se derivan de `CLASS_LABELS` en `common.ts`; el processor retiró su mapa local; aliases legacy acotados y claves `__proto__`/`constructor`/`toString` devuelven `null`; `COMPLETED` desconocido ⇒ `FAILED` con `predictedClass=null` y metadata `{}`; `REVIEW_REQUIRED` desconocido o `modelPredictions` inválidas ⇒ `predictedClass=null`, predicciones inválidas descartadas y parciales válidos preservados. **Corrección QA:** records propios proto-safe, `MlClient` conserva `__proto__` own y valida valores, CAS JSONB raw schema-qualified (`public`/custom validado) para roundtrip PG y defensa ante `search_path` decoy, y REVIEW con `probabilities={}` legítimo conserva segmentación. Las 3 regresiones QA de prototipo pasaron de rojo a verde. Unit **4 files / 86**, integración worker/repo **2 files / 31**, `typecheck`/`build` **0**. Sin 4.9, full suites, ML, Azure/`.env`, SRS/PDF ni commit; 4.9 sigue conocido/parcial y no se refactoriza su método latente.

### D26. Idempotencia obligatoria, replay exacto y reanálisis canónico (HITO25, tareas 4.4-4.5; QA PASSED)

**Decisión (aprobada por el usuario; implementada en HITO25 con QA PASSED; 4.4/4.5 `[x]`):** este bloque documenta el contrato de idempotencia sobre la tabla existente `idempotency_records` (migración C, `backend/prisma/migrations/20261118020000_identity_audit/migration.sql:407-551`) **sin nueva migración**, sin auth nueva y sin tocar Azure/`.env` reales, SRS/PDF ni commit. La tabla ya impone `unique(actor_user_id, scope, key)`, `key VARCHAR(128)`, `inference_id NOT NULL`, `resolved_model_versions` JSONB objeto, `PENDING` sin respuesta y `ACCEPTED` inmutable con `response_status=202`, `response_body` exacto (`inferenceId`/`jobId`/`status=QUEUED`) y `accepted_at >= created_at`; el trigger valida el `jobId` contra `COALESCE(inference.job_id, inference.id)` y exige que el actor sea dueño del caso.

**4.4 Idempotencia obligatoria (D26.1)**

- **Header:** `Idempotency-Key` obligatoria en `POST /inferences` y en cualquier alias de reanálisis. Debe ser un único valor ASCII que cumpla `^[A-Za-z0-9._:-]{1,128}$`; ausente, vacío, solo whitespace, array, duplicado por comas o valor no válido ⇒ `400` seguro antes de ML, red de modelos y creación de fila. El servidor no genera ni completa la clave por el cliente. `requireRole("OFTALMOLOGO")` se ejecuta en `preHandler` antes de validar el header: `401`/`403` tienen prioridad sobre el `400` del header. El body sigue siendo el `inferenceCreateSchema` estricto actual (`imageId`, `eyeSide`, `clinicalFeatures`, `modelVersion?`, `reanalysisOf?`), sin campos nuevos.
- **Alcance:** fijo `scope="inferences:create:v1"` (versión del algoritmo de hash) y tupla `(actor, scope, key)`; el actor es el usuario autenticado y debe ser dueño del caso de la inferencia (trigger DB). El lookup de `PENDING`/`ACCEPTED` se hace antes de `prepare` y de cualquier llamada de modelo. Cada replay revalida sesión/`tokenVersion`/rol y ownership actual; no se consulta ni revela el registro de otro usuario (`404` uniforme para recurso ajeno). Las respuestas, logs y errores de header/hash no ecoan credenciales, tokens, URLs firmadas ni payload crudo.
- **Hash canónico:** SHA-256 hexadecimal lowercase sobre un payload plano y cerrado, serializado en este orden exacto: `imageId` (UUID lowercase), `eyeSide`, `clinicalFeatures` (las 11 claves en el orden de `CLINICAL_FEATURE_NAMES`, números finitos ya validados), `modelVersion` (`null` si se omite) y `reanalysisOf` (`null` si se omite; UUID lowercase). Quedan fuera URLs firmadas, timestamps, IDs de servidor (`inferenceId`, `jobId`) y defaults resueltos por el servidor. El algoritmo queda congelado bajo `inferences:create:v1`; cambiarlo exige un scope nuevo.
- **Replay y conflicto:** misma `key` + mismo hash ⇒ mismo `202` exacto con el mismo `inferenceId`/`jobId` y `status:"QUEUED"`. Misma `key` + hash distinto ⇒ `409` seguro antes de ML, sin mutar el registro previo. Un `202` perdido se recupera con la misma key sin exigir un ID no recibido.
- **Primera resolución inmutable:** el primer request válido guarda snapshot clínico + modelos resueltos + pin (`expectedContext`) de forma inmutable. El replay/resume reconstruye desde DB (snapshot/modelos/pin), nunca vuelve a llamar a `prepare`, no genera un UUID nuevo ni cambia defaults de versión. Un request nuevo sin registro existente conserva el orden actual de 2.2: ownership de imagen, padre y lateralidad antes de `prepare`.
- **Concurrencia y transacción:** no hay caché local ni lock sobre la preparación externa; dos requests concurrentes pueden preparar antes de la TX (sin efecto de modelo). La TX toma un advisory lock `xact` probabilístico por `hashtext` sobre `(purpose, schema, actor, scope, key)`, locks de principal fresco, recheck de la key y, o bien lee el registro existente, o crea snapshot + inferencia + registro `PENDING` de forma atómica. La corrección/unicidad la garantizan el índice único `(actor_user_id, scope, key)` y el compare-and-set; el lock solo reduce trabajo duplicado y no promete aislamiento estructural perfecto del espacio de advisory locks. No se mantienen locks DB durante la preparación/storage/BullMQ.
- **Postcommit y ACCEPTED:** para un registro nuevo o `PENDING`, se reconstruye el job desde DB (snapshot/modelos/pin, imagen fresca y `storagePath` de DB, nunca datos HTTP), se firma una URL nueva (excluida del hash) y se encola con el mismo `jobId` BullMQ = `inferenceId` (UUID). El `jobId` público es el `inferenceId` canónico; se ignoran IDs arbitrarios del ML/mocks y el `jobId` string del ML no se persiste en `Inference.jobId`. Solo tras el ack de la cola se marca `ACCEPTED` con un `UPDATE` condicional `state='PENDING'`; si afecta 0 filas, se relee el registro inmutable `ACCEPTED` y se devuelve su respuesta exacta.
- **Timestamps:** `created_at` usa time de sentencia DB; `accepted_at` usa `GREATEST(created_at, pg_catalog.statement_timestamp())` o un reloj confiable consistente, de modo que `accepted_at >= created_at` (CHECK DB). `GREATEST` es una expresión SQL, no una función de catálogo shadowable; `statement_timestamp()` sí va calificada.
- **Fallo y resume:** cualquier error SQL o fallo al marcar `ACCEPTED` devuelve `503` seguro y deja `PENDING` con la misma ejecución reanudable (no se crea otra). Fallo de storage/cola ⇒ `503` y `PENDING` sin cambios. Replay de `ACCEPTED` es read-only aunque ML/storage estén caídos: no firma ni encola. `PENDING` con snapshot ausente/corrupto, modelos no fijados o contexto/payload inconsistente ⇒ `503`, sin fallback ni re-`prepare`. Si el `PENDING` ya tiene ejecución terminal validada y el snapshot coincide, se marca `ACCEPTED` con el `202` original sin reenviar ni firmar (evita duplicar un job antiguo por retención BullMQ); no se promete outbox/reconciliación de 4.6.
- **Retención y semántica:** el registro `ACCEPTED` no se borra, no tiene TTL ni purga de tombstones mientras B3 no esté aprobado. El replay no simula estado terminal: devuelve siempre el `202` original con `status:"QUEUED"` aunque el worker ya haya terminado. No se implementa persistencia durable del job ML, outbox/auto-recuperación (4.6), agotamiento de reintentos (4.7), firma just-in-time antes del worker (4.8) ni de-duplicación eterna; BullMQ conserva `removeOnComplete: 1000`. Un retry `PENDING` puede apoyarse en la deduplicación de BullMQ mientras el job exista, sin garantía eterna; el CAS del worker protege la evidencia ya terminal.

**4.5 Reanálisis canónico (D26.2)**

- El único contrato es `POST /inferences` con `reanalysisOf`; no se añade endpoint `/reanalysis` ni alias independiente. El hash de idempotencia incluye el `reanalysisOf` normalizado (UUID lowercase) además del resto del payload.
- Misma key + mismo payload (incluido el padre) ⇒ replay exacto del `202`. Misma key + padre distinto ⇒ `409` antes de ML, sin segunda ejecución. Key distinta ⇒ nueva ejecución de reanálisis legítima, con PDF independiente en el futuro (6.x), sin reabrir ni alterar la consulta.
- `requiredExecutionIds`/`requiredSetVersion` congelados y `consultation.status` no se tocan; un reanálisis histórico no modifica el frozen set (B2). `eyeSide` contradictorio sigue `422`.
- **Contra-evidencia registrada:** el trigger de `20261119010000_clinical_access` (`migration.sql:72-93`) hace inmutables `consultations.patient_id`/`doctor_id`; no existe un test que desactive triggers para cambiar de dueño. Por eso no se diseña un escenario de cambio de owner en fixtures; aun así, cada replay revalida principal/ownership actual porque la autorización/sesión sí puede cambiar.
- **Tests (QA PASSED):** unit **5 files / 62** (idempotency/idempotency-repo/idempotency-creation-guard/schemas/runner-isolation) e integración **5 files / 82** (inference-idempotency/inference-creation/clinical-access/rbac/identity-migrations); `typecheck` **0**. Post-corrección: unit **3 files / 16** e integración **1 file / 19** (decoy/advisory), `typecheck` **0**. QAsolo tests+guard nuevos; source intacto. El script E2E solo actualiza el caller para enviar el header y no se ejecuta contra la DB de desarrollo compartida. Sin descargas de modelos ni Redis real: cola fake determinista y firma SDK offline ya cubierta por 3.x.
- **Reviewer independiente (2 LOW confirmados y corregidos):** `pg_advisory_xact_lock`/`hashtext`/`statement_timestamp` van bajo `pg_catalog`; `GREATEST` es una expresión SQL no shadowable y queda sin calificar. El comentario del lock se ajustó a namespace probabilístico vía `hashtext`, con unicidad/corrección garantizadas por el índice único + CAS, sin afirmar separación estructural total.
- **Límites explícitos:** 4.6 outbox/reconciliación, 4.7 retries/cancelación, 4.8 URL JIT, 4.9 y PDF/publicación pendientes; BullMQ `removeOnComplete:1000` sin dedup eterna; PENDING resume y `ACCEPTED` replay no reencolan job tras terminal (CAS worker protege); ventana post-dispatch enqueue→markAccepted documentada sin cancelación atómica; sin TTL/borrado/tombstone hasta B3; `defects/regressions.md` no editado.

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
| ADR-014 | Sesiones: JWT 15 min + sessionId/tokenVersion, refresh opaco rotado, cookie web | implemented 5.8 + reset 5.9 (QA PASSED) | D9, D19 |
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
| ADR-027 | Abstracción dual de storage backend/ML (Azure Blob y MinIO) | implemented (3.1 ML; 3.2 backend QA PASSED; 3.8 partial until 3.4) | D5, D13, D22 |
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
| ADR-040 | Forgot/reset: cuotas durables independientes de login, token single-use solo en body, revocación total en reset y entrega deshabilitada por defecto | implemented R1+R2 (HITO17); 5.9 QA PASSED; B8 provider pending (non-blocking) | D20 |
| ADR-041 | 2.2: `clinicalFeatures` de la request es autoritativa; el runtime ML prepara `rawCanonical`/`normalizedPayload` reales, `schemaVersion=ml-zscore-f32-v1`, `modelVersions` verificados y huella de contexto | implemented (HITO19 QA PASSED; H1 PASSED) | D21 |
| ADR-042 | 2.2: descriptor inmutable runtime/modelo/normalización + SHA-256 canónico sin el campo huella; `expected_context` opcional en el contrato ML y pin obligatorio en jobs nuevos | implemented (HITO19 QA PASSED; H1 PASSED) | D21 |
| ADR-043 | 2.2: parámetros efectivos capturados del runner cargado (mean/std con fuente, epsilon 1e-8, orden, dtype), backend efectivo pytorch/onnx y checksums; sin JS duplicado, sin env posterior contradictorio y sin `"v1"` | implemented (HITO19 QA PASSED; H1 PASSED) | D21 |
| ADR-044 | 2.2: snapshot + inference `QUEUED` en una TX con relectura bajo locks; sin mutar `consultation.status`; fracaso post-commit queda pendiente de 4.6 y no se finge `202` | implemented (HITO19 QA PASSED; H1 PASSED) | D21 |
| ADR-045 | 2.2: worker con processor DI sin Redis import side effect; `COMPLETED`/`REVIEW_REQUIRED`/`FAILED` terminales, revisión sin retry, persistencia condicional y validación de IDs/ojo/etiqueta | implemented (HITO19 QA PASSED; H1 PASSED) | D21 |
| ADR-046 | 2.2 no cierra 2.4/4.2/4.3 ni resuelve REG-002/003/004; solo mitiga/parcializa y el registro humano permanece intacto | agreed (scope restriction) | D21 |
| ADR-047 | 3.2: `STORAGE_PROVIDER=minio` default retrocompatible y `azure` explícito; desconocido fail closed; fachada `StorageService` con provider DI/lazy sin red al construir y firmas actuales preservadas | implemented (QA PASSED) | D22 |
| ADR-048 | 3.2: Azure Blob vía `@azure/storage-blob` + `SharedKeyCredential`, SAS por objeto read-only (`sp=r` en el wire del SDK; `p=r` abreviatura de D22), `sr=b`, `spr=https` y expiración acotada; `ensure` solo verifica contenedor, upload verifica `getProperties` y sign verifica existencia; sin SAS casero ni fallback MinIO | implemented (QA PASSED) | D22 |
| ADR-049 | 3.2: TTL actual 3600 preservado y configurable 1..3600 (default, no cap); 300 s queda para 4.8 y no se promete en 3.2; 3.4 usa el default configurado (D24) | implemented (QA PASSED; deuda 4.8) | D22 |
| ADR-050 | 3.2: keys de objeto exactas sin normalización; representaciones no soportadas por el SDK se rechazan de forma explícita; `storageId` local por configuración sin cambio de DB | implemented (QA PASSED) | D22 |
| ADR-051 | 3.3: parser puro con contexto trusted, solo provider activo, URIs `s3://`/`azure://` estrictas, key exacta sin URL/decode/normalize, rechazo de comienzo URI genérica/credenciales/query SAS y `://` embebido permitido mediante política compartida parser/DTO | implemented (QA PASSED) | D23 |
| ADR-052 | 3.3: bare legacy determinista (bucket allowlisted o key-only con default) y `STORAGE_ALLOWED_BUCKETS` fail-closed; sin reconstrucción universal ni fallback cross-provider | implemented (QA PASSED) | D23 |
| ADR-053 | 3.3: `ArtifactRef` binario excluye `result` (inline aparte), mapper estricto de campos/null/bigint y `ArtifactLocation` separado; sin repo/publicación/DB en 3.3 | implemented (QA PASSED) | D23 |
| ADR-054 | 3.4: `GET /artifacts` devuelve envelope paginado `{items:[{artifactId,version,reference}],total,limit,offset}` (limit 20/100, offset 0, `type` binario), orden `artifactType ASC/version DESC/id ASC` y filtro de tipos permitidos en SQL antes de count; contrato propuesto corregido sin caller actual | implemented (3.4 QA PASSED) | D24 |
| ADR-055 | 3.4: autorización por unión de grants activos `readArtifacts`/`readPdf`, sin `ADMIN` implícito; dueño médico todo, no dueño sin grant nada, `readResult` no lista ni firma; locators autorizados son `ArtifactRef`, sin URLs/SAS persistidas | implemented (3.4 QA PASSED) | D24 |
| ADR-056 | 3.4: URL exige `version` explícita positiva `<= int32 max`, sin `latest` ni fallback; `result`/sin versión `400`, pertenencia inferencia/tipo/versión o acceso `404`, config storage/metadata corrupta `503` antes del SDK; no-`AVAILABLE` `200` con nulos sin storage; PDF `AVAILABLE` sin `PdfReport` válido `409` | implemented (3.4 QA PASSED) | D24 |
| ADR-057 | 3.4: auth antes de metadata/storage y revalidación fresca de sesión/capability tras firmar; URL solo tras commit `ARTIFACT_URL_ISSUED`; objeto ausente `409` + incidente vs permisos/red `503`; `Cache-Control: no-store` y `503` genérico | implemented (3.4 QA PASSED) | D24 |
| ADR-058 | 3.4: TTL efectivo con default configurado 1..3600 (300 diferido a 4.8), sin migraciones/publisher/rutas `/reports`; 3.8 cierra con 3.4 + tests combinados sin Azure/Azurite | implemented (3.4/3.8 QA PASSED) | D24 |
| ADR-059 | 4.1: política de URL pura y compartida, allowlist no vacía para HTTP/HTTPS, HTTP solo con flag de desarrollo explícito + allowlist, rechazo de esquemas/userinfo/fragmento/puerto/host inválidos, `422` antes de encolar, sin redirecciones y descarga acotada por timeout/bytes; sin framework global DNS/private-IP ni verificación SAS en ML | implemented (QA PASSED HITO24) | D25.1 |
| ADR-060 | 4.2: migración `20261120000000_inference_result_details` con `model_versions`/`model_predictions` JSONB NOT NULL DEFAULT `{}` y CHECK de objeto; resultado real en `COMPLETED`/`REVIEW_REQUIRED`, `FAILED` `{}`; legacy desconocido sin copiar `modelVersion`; persistencia interna sin exposición GET nueva; CAS JSONB raw schema-qualified y atómico; sin `ArtifactRecord`/PDF | implemented (QA PASSED HITO24) | D25.2 |
| ADR-061 | 4.3: catálogo canónico único en `common.ts` derivado de `CLASS_LABELS`, helper `canonicalClassIndex` seguro ante `__proto__`/`constructor`/`toString`, solo aliases legacy acotados, desconocido ⇒ `FAILED` seguro o `null` en revisión, validación por modelo sin clases inventadas ni label raw en logs; model name `__proto__` legítimo preservado | implemented (QA PASSED HITO24) | D25.3 |
| ADR-062 | 4.4: `Idempotency-Key` obligatoria (ASCII `[A-Za-z0-9._:-]{1,128}`, `400` antes de ML), scope `inferences:create:v1`, hash SHA-256 plano canónico, replay exacto/`409`, snapshot+modelos+pin inmutables, advisory xact lock y único final, `ACCEPTED` solo tras ack con update condicional, `503`/`PENDING` reanudable, replay terminal sin reenvío, retención sin purga (B3) | implemented (QA PASSED) | D26.1 |
| ADR-063 | 4.5: reanálisis solo por `POST /inferences` + `reanalysisOf`; hash incluye padre, misma key con padre distinto `409`, key distinta nueva ejecución; frozen/consulta intactos; sin alias independiente | implemented (QA PASSED) | D26.2 |

## Risks / Trade-offs

| Riesgo | Mitigación |
|---|---|
| URL firmada ya emitida sigue válida tras revocar una cuenta | TTL corto, documentar la limitación y evaluar proxy revocable futuro; no prometer revocación inmediata. |
| Revisión humana sin conversión a completada | B1 resuelto como restricción: `REVIEW_REQUIRED` no se autoaprueba y el médico no puede convertir una ejecución sin resultado válido; la resolución es un reanálisis con PDF independiente. |
| Cambio del conjunto de ojos tras cierre | B2 resuelto como restricción: no reapertura, no promoción y frozen set; reanálisis históricos solo en historial. |
| Reanálisis legítimo bloqueado por fingerprint | El fingerprint solo detecta duplicados técnicos; nunca deniega ni revela a otros usuarios. |
| URLs o tokens en logs/PDF/DB | Referencias estructuradas, prohibición de SAS persistido, redacción de logs y pruebas de fuga. |
| Referencia legacy ambigua (`bucket/key` vs key con prefijo de bucket) | Precedencia determinista por allowlist sin red; el caller con esa key usa ubicación estructurada. No se promete reconstrucción universal ni se adivina. |
| Allowlist vacía o bucket ajeno | `STORAGE_ALLOWED_BUCKETS` explícito vacío falla cerrado; sin “allow all”, sin extensión automática y sin fallback cross-provider. |
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
| 2.2: drift de modelo/artefacto entre preparación y ejecución | Descriptor inmutable con manifiesto, revisiones, checksums y huella; `expected_context` se revalida al aceptar y antes de descargar/segmentar; mismatch falla seguro, sin fallback. |
| 2.2: parámetros `env` posteriores contradicen el runner cargado | Se capturan una vez al construir el runtime y se declaran con fuente `env`/`manifest` por vector; `prepare` y `predict` consumen la misma resolución, sin releer env por request. |
| 2.2: float32 no reproducible o recalculado en JS | Se usa el helper existente `normalize_clinical_features` con `float32`/epsilon 1e-8; el backend copia valores ya calculados y no re-normaliza. Tests con golden/tolerancia. |
| 2.2: bloqueos cruzados entre casos | Locks solo de imagen/padre implicados, en orden determinista por UUID; no se bloquea la consulta ni agregados globales. |
| 2.2: spoof de contexto/ojo/padre | `eyeSide` y ojo salen de la imagen DB; IDs son de servidor; `expected_context` no lo envía el cliente; padre se valida por ownership y contexto. |
| 2.2: snapshot huérfano por fallo SQL | Snapshot + inference en la misma TX; rollback completo si falla el insert. |
| 2.2: entrega duplicada sobrescribe una ejecución terminal | Persistencia terminal condicional; si ya es `COMPLETED`/`REVIEW_REQUIRED`/`FAILED`, la segunda entrega es no-op. |
| 2.2: reapertura o autocompletado de consulta cerrada | Se elimina toda mutación de `consultation.status` en creación/worker; la agregación y el PDF quedan en 2.3/6.x. |
| 2.2: fallo post-commit de storage/cola | Estado pendiente explícito y `503` seguro; 4.6 aporta outbox/reconciliación y 4.4 la idempotencia. No se promete atomicidad Redis. |
| 3.2: Azure mal configurado cae silenciosamente a MinIO | Selección `STORAGE_PROVIDER` explícita, validación de URL/nombre HTTPS y fail closed; tests de `no fallback`. |
| 3.2: SAS demasiado amplio u objeto ausente con URL ficticia | SAS por objeto read-only (`sp=r` en el wire del SDK), `sr=b`, `spr=https` con expiración acotada; `sign` verifica `exists` y no traga permisos/red como `404`; tests de parsing y ausencia. |
| 3.2: TTL 3600 difiere del objetivo 300 | Deuda explícita de 4.8; 3.4 no adopta 300 y usa el default configurado (D24), sin modificar callers legacy. |
| 3.4: listado expone o cuenta tipos no autorizados | Unión de grants por tipo, filtro en SQL antes de orden/paginación/count y ninguna fila de tipo no permitido en `items`/`total`. |
| 3.4: URL emitida antes de auditar o tras perder permisos | Auth antes de metadata/storage, revalidación fresca después de firmar y respuesta solo tras commit de `ARTIFACT_URL_ISSUED`; fallo de auditoría `503` sin URL. |
| 3.4: objeto ausente confundido con `404` de acceso | Solo `storage_object_missing` ⇒ `409` con incidente auditado; permisos/red ⇒ `503`; `AVAILABLE` no se muta. |
| 3.4: PDF sin reporte publicado finge disponibilidad | `409` + auditoría `REPORT_NOT_AVAILABLE`; `reportVersion` solo con `PdfReport` válido de la misma versión. |
| 4.1: allowlist vacía o HTTP abierto permite SSRF | Allowlist no vacía obligatoria para HTTP/HTTPS; HTTP solo con flag explícito de desarrollo y allowlist; `422` antes de encolar y revalidación antes del `GET`. |
| 4.1: redirección o DNS rebinding elude la allowlist | Sin seguir redirecciones (`301/302/307` bloqueadas), matching por hostname con `*.blob.core.windows.net` acotado y sin framework global DNS/private-IP en este bloque; residual documentado. |
| 4.2: perder versiones/predicciones reales o inventar versiones | JSONB de resultado real separado de `snapshot.modelVersions`; `COMPLETED`/`REVIEW_REQUIRED` completos o parciales, `FAILED` `{}`, legacy `{}` desconocido, sin copiar `modelVersion` ni fabricar `"v1"`. |
| 4.3: etiqueta desconocida adivinada, crash por prototipo o label raw en logs | Fuente única con helper own-property/null-safe; desconocido ⇒ `FAILED` seguro o `null` en revisión; validación por modelo fail closed y código fijo sin label raw. |
| 4.4: doble ejecución por replay, key duplicada o concurrencia | Lookup antes de ML, hash canónico, advisory xact lock, recheck y único `(actor, scope, key)` como guard final; mismo key+hash ⇒ mismo `202`. |
| 4.4: `202` recuperado con job distinto o estado terminal falso | `jobId` canónico = `inferenceId`; replay siempre devuelve el `202` original `QUEUED`; el terminal real se consulta por `GET`, no se simula en idempotencia. |
| 4.4: lock DB cubre preparación/storage/cola | Advisory lock solo dentro de la TX corta; preparación y efectos externos quedan fuera; fallo ⇒ `503`/`PENDING` reanudable. |
| 4.4: purga accidental de `ACCEPTED` | Trigger DB prohíbe DELETE y mutación de `ACCEPTED`; sin TTL/tombstone hasta B3; no se implementa retención. |
| 4.5: conflicto de padre no detectado | `reanalysisOf` normalizado entra en el hash; misma key con padre distinto ⇒ `409` antes de ML; key distinta crea reanálisis legítimo. |
| REVIEW: `label`/`confidence` confundidos con segmentación | Son diagnóstico, no segmentación: si el bloque diagnóstico es vacío/inválido quedan `null`, pero se conservan quality/artifacts/models válidos/cdr/cdrVertical/elapsed. |
| REVIEW: predicciones por modelo válidas con aggregate probs vacío | `label`/`confidence` globales quedan `null` (sin autodiagnóstico); metadata por modelo validada puede conservarse y no se autoaprueba la revisión. |
| Zod `record()` no usado en runtime puede perder own `__proto__` si se activa | Riesgo latente para rutas/futuro 4.9; el parse actual está cubierto con `protoSafeRecord` en wires y CAS JSONB raw; no se reclama refactor total de todos los schemas. |
| `gradcam` ausente tratado como fallo de `mask` | `gradcam` sigue `NOT_SUPPORTED` legítimo; no se sustituye por `mask` ni se finge evidencia. `defects/regressions.md` no se edita y REG-004 queda para cierre humano. |

## Migration Plan

1. **Documentación primero:** proposal, design, specs, contrato de frontend, tareas y `contracts/testing-runbook.md`. La fase documental no implementa por sí misma; las tareas `[x]` con evidencia (incluida 5.8/QA) sí están implementadas.
2. **Registro de regresiones:** crear `defects/regressions.md` con entradas solo estáticas y verificadas, distinguiendo activas y resueltas.
3. **Esquema y migración:** añadir tablas/columnas de ejecución, evidencia, PDF, auditoría e idempotencia mediante migraciones incrementales; cambiar la resolución de `0_init` a un chequeo de esquema verificado, sin enmascarar fallos.
4. **Compatibilidad:** mantener lectura de referencias legacy `s3://`/`azure://` y aceptar payloads clínicos con alias canónico; no romper clientes actuales sin aviso.
5. **Storage:** abstracción dual backend/ML (Azure Blob y MinIO) **CURRENT**; 3.2 backend QA PASSED (providers/factory, `ensure`, verificación de upload, SAS por objeto y fachada actual). Referencias estructuradas/parser 3.3 con QA PASSED; la ruta de listado/descarga 3.4 está implementada y QA PASSED (D24); 3.8 QA PASSED. Conservar el comportamiento local actual.
6. **ML/worker:** fijar contrato JSON y política de URL (4.1), persistencia completa de `modelVersions`/`modelPredictions` con la migración incremental `20261120000000_inference_result_details` (4.2), catálogo canónico único (4.3), idempotencia obligatoria/replay y reanálisis canónico (4.4/4.5, implementados en HITO25; QA PASSED), recuperación, estados terminales y revisión; reintentos solo transitorios.
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
| URL firmada ML y allowlist | `ml/inference/pipeline.py:37-56,76-107`; `ml/config.py:34-37,54-78`; contrato estricto `ml/service/schemas.py:12-13,51-57`. |
| Persistencia actual de resultado | `backend/src/workers/inference.processor.ts:326-449,513-526`; `backend/src/repositories/inference-run.repo.ts:12-24,45-85`; wire `backend/src/services/ml-client.ts:40-53,185-202`; `backend/prisma/schema.prisma:144-176`. |
| Idempotencia actual (4.4) | `backend/prisma/migrations/20261118020000_identity_audit/migration.sql:407-551` y `backend/prisma/schema.prisma:425-446` (único actor/scope/key, `PENDING`/`ACCEPTED`, respuesta 202 exacta); creación postcommit `backend/src/services/inference-creation.ts:112-139`; BullMQ `backend/src/workers/inference.queue.ts:32-36` (`jobId=data.inferenceId`). |
| Owner clínico inmutable (4.5) | `backend/prisma/migrations/20261119010000_clinical_access/migration.sql:72-93`: `consultations.patient_id`/`doctor_id` inmutables por trigger; no se diseña cambio de owner en fixtures. |
| Mapa local de etiquetas | `backend/src/workers/inference.processor.ts:25-37,513-526`; fuente canónica `backend/src/schemas/common.ts:42-48`. |
| Estado de artefactos actual | `ml/inference/pipeline.py:163-183`; `backend/src/schemas/inference.ts:28-39`. |
| Suite de pruebas destructiva | `backend/tests/global-setup.ts:40-47` (`DROP SCHEMA public CASCADE`); es comportamiento destructivo actual, no una salvaguarda; requiere DB creada/adoptada con ownership marker, allowlist de target y deny producción. |
| Storage backend actual | **CURRENT:** provider dual en `backend/src/services/storage.ts` + `storage-provider.ts`/`storage-minio.ts`/`storage-azure.ts`/`storage-factory.ts`; 3.2 QA PASSED, API `StorageService`/`s3Client` preservada. Parser 3.3 QA PASSED; ruta 3.4 implementada y QA PASSED (D24). |
| Fixes ML de la rama | `ded48db`, `92a6887`; `e5d184a` es solo de `master`, subconjunto, y no se cherry-pickea a ciegas. |
| Test runner destructivo | `backend/vitest.config.ts:6` fuerza `globalSetup`; `backend/tests/global-setup.ts:24-47` exige que el nombre contenga `test` y hace `DROP SCHEMA public CASCADE`. Un test focalizado no evita ese setup. Runbook: `contracts/testing-runbook.md`. |
| Comandos actuales | `backend/package.json` scripts `test`, `typecheck`; `ml/pyproject.toml` pytest `testpaths=["tests"]`; `scripts/e2e-backend.ps1`, `scripts/test_azure_e2e.py`, `scripts/benchmark_latency.py`. No existe un script `e2e` en `package.json`. |
