# Inference Orchestration — Delta Specification

## ADDED Requirements

### Requirement: Contrato público estricto del servicio ML

El servicio ML SHALL exponer `POST /v1/inferences` con cuerpo JSON estricto (`extra=forbid`) que contenga `inference_id`, `image_url` firmada, `eye_side`, `clinical_features` con las once variables finitas y `model_version` opcional. El endpoint MUST NOT aceptar multipart, un segundo archivo de imagen, un valor de CDR de entrada, `cdr_vertical` ni campos desconocidos. El servicio MUST validar estrictamente los campos y MUST responder `422` antes de encolar cuando el contrato o la `image_url` no sean válidos, y `202 Accepted` con identificadores de inferencia y job cuando acepte el trabajo. La política de URL MUST ser un helper puro y compartido, alimentado solo por configuración confiable, y MUST aplicarse tanto en la admisión como antes del `GET` de descarga. `ML_ALLOWED_SIGNED_URL_HOSTS` MUST ser no vacío para HTTP y HTTPS, sin “allow all”; HTTPS es el default de producción y HTTP solo se admite con `ML_ALLOW_HTTP_SIGNED_URLS=true` explícito más allowlist no vacía (compatibilidad de desarrollo MinIO `localhost`/`minio` con puerto). MUST rechazarse sin inferir: esquemas distintos de `http`/`https` (`file:`, `data:`, `ftp:` u otro), hostname ausente, credenciales/userinfo, fragmento raw, puerto inválido, host vacío o host fuera de la allowlist, con mensaje seguro que no incluya la URL. La allowlist MUST evaluarse por hostname/patrón, conservando solo el wildcard legacy acotado `*.blob.core.windows.net`; no se añade un framework global de DNS/private-IP ni se valida criptografía/SAS en el ML porque storage es la autoridad de firma. La descarga MUST NOT seguir redirecciones (`301`/`302`/`307` se bloquean sin reconstruir una URL), MUST conservar el timeout configurado existente y MUST acotar bytes por `Content-Length` y por lectura real en stream. La política de autenticación del servicio entrante se conserva sin tokens ni scopes nuevos de producción.

#### Scenario: Solicitud válida con URL firmada

- **WHEN** el backend envía un JSON estricto con `inference_id`, `image_url` válida y allowlisted, `eye_side` y las once variables clínicas finitas
- **THEN** el servicio ML responde `202 Accepted` con `inference_id`, `job_id` y estado `QUEUED`
- **AND** no requiere subir un archivo multipart.

#### Scenario: Intento de enviar CDR o campos desconocidos

- **WHEN** la solicitud incluye un campo de CDR, `cdr_vertical`, multipart o cualquier campo desconocido
- **THEN** el servicio ML responde `422` antes de encolar
- **AND** no inicia un análisis con datos no canónicos.

#### Scenario: URL con allowlist vacía o HTTP no habilitado

- **WHEN** `ML_ALLOWED_SIGNED_URL_HOSTS` está vacío o `image_url` usa HTTP sin `ML_ALLOW_HTTP_SIGNED_URLS=true`
- **THEN** el servicio ML responde `422` antes de encolar, sin inferir
- **AND** no existe un default “allow all” ni un fallback permisivo.

#### Scenario: URL con esquema, host o componentes inválidos

- **WHEN** `image_url` usa `file:`/`data:`/`ftp:` u otro esquema, no tiene hostname, incluye credenciales/userinfo, fragmento raw, puerto inválido o host no allowlisted
- **THEN** el servicio ML responde `422` con mensaje seguro sin URL
- **AND** no intenta descargar ni acceder a redes internas o metadatos del proveedor.

#### Scenario: Redirección en la descarga

- **WHEN** el `GET` de la imagen responde `301`/`302`/`307`
- **THEN** el pipeline bloquea la redirección y no sigue una URL nueva
- **AND** no descarga el cuerpo de un host no autorizado.

#### Scenario: Tamaño o timeout excedido

- **WHEN** `Content-Length` o los bytes leídos superan el máximo, o se agota el timeout configurado
- **THEN** la descarga falla con error seguro sin URL
- **AND** no se procesa una imagen parcial ni se pipelinea un resultado.

### Requirement: Estados de job y resultado completo

El servicio ML SHALL usar el vocabulario de estados `QUEUED`, `DOWNLOADING`, `LOCALIZING`, `SEGMENTING`, `CLASSIFYING`, `COMPLETED`, `REVIEW_REQUIRED` y `FAILED`. El resultado de una ejecución exitosa MUST incluir `inference_id`, `eye_side`, `label`, `confidence`, `probabilities`, predicciones por modelo, `cdr`, `cdr_vertical`, `quality`, `artifacts`, `model_versions` y `elapsed_seconds`. `REVIEW_REQUIRED` MUST poder devolver evidencia parcial sin presentarla como éxito completo. Una ejecución `REVIEW_REQUIRED` MUST NOT convertirse en `COMPLETED` por acción del médico ni por la existencia de un PDF; la resolución es un reanálisis como ejecución nueva vinculada, con PDF independiente y sin pisar la evidencia anterior (B1).

#### Scenario: Consulta de un job completado

- **WHEN** el cliente consulta un job con estado `COMPLETED`
- **THEN** recibe todos los campos del resultado, incluyendo CDR, calidad, artefactos y versiones de modelo
- **AND** ninguna clave requerida se omite silenciosamente.

#### Scenario: Consulta de un job en revisión

- **WHEN** el cliente consulta un job con estado `REVIEW_REQUIRED`
- **THEN** recibe el estado terminal de revisión y la evidencia parcial disponible
- **AND** no recibe un estado `COMPLETED` ni una aprobación implícita.

#### Scenario: Consulta antes de que exista resultado

- **WHEN** el cliente consulta un job recién aceptado
- **THEN** recibe su estado y etapa actuales sin error
- **AND** no se le obliga a reenviar el trabajo para conocer el estado.

### Requirement: Persistencia completa de versiones y predicciones

El backend SHALL persistir el resultado real del ML en la ejecución, no solo un subconjunto. La persistencia MUST añadir `model_versions` y `model_predictions` como objetos JSON completos (claves tal como las devuelve el wire ML validado) mediante una migración incremental idempotente, con `DEFAULT '{}' NOT NULL` y CHECK de objeto; `0_init` y el baseline MUST quedar intactos. Las filas históricas MUST leer `{}` como resultado desconocido y MUST NOT copiar el string legacy `modelVersion` como `modelVersions` ni rellenar un objeto inventado. `snapshot.modelVersions` MUST seguir siendo el input inmutable de la preparación clínica, no el resultado efectivo. `COMPLETED` MUST guardar el resultado completo; `REVIEW_REQUIRED` MUST guardar la evidencia parcial válida disponible; `FAILED` MUST guardar `{}` sin clases ni predicciones ficticias. Los campos `cdr`, `cdr_vertical`, `quality`, `artifacts` y `elapsed_seconds` ya implementados MUST conservarse. El `modelVersion` primario MUST seguir siendo compatibilidad resuelta sin `"v1"` fabricado. `saveResult` deprecated MAY aceptar los campos nuevos opcionales por compatibilidad, pero MUST NOT tener caller de producción ni adelantar el CAS de 4.9. `GET /inferences/:id` MUST NOT cambiar por esta persistencia ni exponer los nuevos campos como lectura pública, y `readResult` MUST NOT filtrar artefactos. `modelVersions`/`modelPredictions` MUST conservar el mapeo existente `snake_case` ML → `camelCase` y los labels string reales, sin transformación ni clasificación adivinada.

#### Scenario: Resultado completo persistido

- **WHEN** el ML devuelve `COMPLETED` con versiones y predicciones por modelo
- **THEN** el CAS persiste `modelVersions` y `modelPredictions` completos junto con los campos existentes
- **AND** no se pierde ninguna clave válida del wire.

#### Scenario: Revisión con evidencia parcial

- **WHEN** el ML devuelve `REVIEW_REQUIRED` con evidencia parcial válida
- **THEN** se persisten las versiones/predicciones disponibles sin inventar una clase ni declarar completitud
- **AND** la revisión no se autoaprueba.

#### Scenario: Fallo y fila legacy

- **WHEN** la ejecución termina `FAILED` o se lee una fila histórica
- **THEN** `modelVersions`/`modelPredictions` quedan `{}` como desconocidos
- **AND** no se copia `modelVersion` ni se fabrica `"v1"`.

#### Scenario: GET público sin cambios

- **WHEN** el cliente consulta `GET /inferences/:id`
- **THEN** el contrato público se mantiene y no se exponen los nuevos campos persistidos
- **AND** `readResult` no recibe artefactos por esta vía.

### Requirement: Polling, Retry-After y entrega posterior a COMPLETED

El cliente SHALL poder consultar el estado de una ejecución con un intervalo/backoff propuesto configurable: 2 s inicial, techo de 10 s, `Retry-After` cuando el servidor lo indique. El polling HTTP al ML MUST parar en `jobTerminal` (`COMPLETED`, `REVIEW_REQUIRED`, `FAILED`). El polling de la API clínica MUST NOT parar solo por `jobTerminal`: MUST continuar si quedan artefactos o PDF `PENDING` y MUST parar en `deliveryTerminal=true` (todas las publicaciones solicitadas `AVAILABLE` o fallo terminal explícito, ninguna `PENDING`), `pollingStop` terminal (`COMPLETE`/`ACTION_REQUIRED`/`FAILED`), auth/error acotado o deadline/timeout global con acción de nueva consulta. `delivery.complete` MUST NOT ser true si el ML está en `REVIEW_REQUIRED` o `FAILED`. Un reporte de revisión con generación pendiente MUST NOT declararse completo ni cortar el polling antes de una entrega terminal conocida. Un timeout global configurable MUST disparar aviso y MUST NOT marcar la inferencia como `FAILED` por sí solo. El backend MUST NOT exigir un ID que nunca entregó.

#### Scenario: Polling con backoff

- **WHEN** el cliente consulta un trabajo con `jobTerminal=false`
- **THEN** usa intervalo inicial de 2 s con techo de 10 s y respeta `Retry-After`
- **AND** detiene el polling HTTP al recibir `jobTerminal=true`.

#### Scenario: ML COMPLETED con PDF pendiente

- **WHEN** el ML responde `COMPLETED` pero el PDF o artefactos siguen `PENDING`
- **THEN** `jobTerminal=true` y `deliveryTerminal=false`
- **AND** el polling clínico continúa y no declara entrega completa.

#### Scenario: Revisión con evidencia publicándose

- **WHEN** el ML está en `REVIEW_REQUIRED` y la evidencia/PDF sigue publicándose
- **THEN** el sistema no autoaprueba ni pone `delivery.complete=true`
- **AND** para cuando la entrega conocida queda sin `PENDING` o requiere acción humana, sin presentar completitud.

#### Scenario: Timeout global

- **WHEN** se alcanza el timeout global de polling
- **THEN** el sistema muestra aviso y ofrece una nueva consulta
- **AND** no marca la inferencia como `FAILED` de forma automática.

#### Scenario: Consulta con acción requerida

- **WHEN** la consulta tiene revisión o bloqueo que requiere acción humana
- **THEN** `pollingStop=ACTION_REQUIRED`
- **AND** el cliente para con reporte terminal sin `PENDING`.

### Requirement: Idempotencia persistida del backend

El backend SHALL implementar idempotencia persistida y resistente a concurrencia, con alcance autenticado durable por usuario y recurso, sobre `idempotency_records` (migración C) y sin migración nueva. `Idempotency-Key` MUST ser obligatoria en `POST /inferences` y en cualquier alias de reanálisis, y MUST aceptarse como un único valor ASCII que cumpla `^[A-Za-z0-9._:-]{1,128}$`. Cuando el header falta, está vacío, es solo whitespace, llega como array, viene duplicado unido por comas o no cumple el patrón, el backend MUST responder `400` seguro antes de cualquier llamada ML, acceso a red de modelos o creación de fila. El servidor MUST NOT generar ni completar la clave por el cliente. La autenticación y `requireRole("OFTALMOLOGO")` MUST ejecutarse en `preHandler` antes de la validación del header, de modo que un actor inválido reciba `401`, un rol incorrecto `403` y solo un actor autorizado con header inválido reciba `400`; el body MUST seguir siendo el schema estricto actual. El `scope` MUST ser fijo `inferences:create:v1` (versión del algoritmo de hash) y la identidad MUST ser la tupla `(actor, scope, key)`. El lookup de `PENDING`/`ACCEPTED` MUST ocurrir antes de `prepare` y de toda la red de modelos. Cada replay MUST revalidar sesión/`tokenVersion`/rol y ownership actual; MUST NOT consultar ni revelar el registro de otro usuario (`404` uniforme para recurso ajeno). Las respuestas, logs y errores de header/hash MUST NOT ecoar credenciales, tokens, URLs firmadas ni payload crudo. El hash MUST ser SHA-256 hexadecimal lowercase sobre un payload plano y cerrado, serializado en este orden exacto: `imageId` (UUID lowercase), `eyeSide`, `clinicalFeatures` (las once claves en el orden canónico, números finitos ya validados), `modelVersion` (`null` si se omite) y `reanalysisOf` (`null` si se omite; UUID lowercase); URLs firmadas, timestamps, IDs de servidor (`inferenceId`/`jobId`) y defaults resueltos MUST quedar fuera. Misma key + mismo hash MUST reproducir exactamente el mismo `202` con el mismo `inferenceId`/`jobId` y `status:"QUEUED"`. Misma key + hash distinto MUST responder `409` seguro antes de ML y MUST NOT mutar el registro previo. Un `202` perdido MUST poder recuperarse con la misma key sin exigir un ID que nunca se recibió. El primer request válido MUST guardar snapshot clínico + modelos resueltos + pin (`expectedContext`) inmutables; replay/resume MUST reconstruir desde DB (snapshot/modelos/pin), MUST NOT volver a llamar a `prepare`, MUST NOT generar un UUID nuevo ni cambiar defaults de versión. Un request sin registro existente MUST conservar el orden actual de 2.2: ownership de imagen, padre y lateralidad antes de `prepare`. La concurrencia MUST resolverse sin caché local ni lock sobre la preparación externa: dos requests pueden preparar antes de la TX (sin efecto de modelo); la TX MUST tomar un advisory lock `xact` determinista por `(purpose=hash, schema, actor, scope, key)`, locks de principal fresco, recheck de la key y, o bien leer el registro existente, o crear snapshot + inferencia + registro `PENDING` de forma atómica; el índice único `(actor_user_id, scope, key)` MUST ser el guard final y MUST NOT mantener locks DB durante preparación/storage/BullMQ. Tras el commit, un registro nuevo o `PENDING` MUST reconstruir el job desde DB (snapshot/modelos/pin, imagen fresca y `storagePath` de DB, nunca datos HTTP), firmar una URL nueva (excluida del hash) y encolar con el mismo `jobId` BullMQ = `inferenceId` (UUID); el `jobId` público MUST ser el `inferenceId` canónico e ignorar IDs arbitrarios del ML o de mocks, y el `jobId` string del ML MUST NOT persistirse en `Inference.jobId`. El estado `ACCEPTED` MUST marcarse solo después del ack de la cola mediante un `UPDATE` condicional `state='PENDING'`; si afecta 0 filas, MUST releer el registro inmutable `ACCEPTED` y devolver su respuesta exacta. `created_at` MUST usar time de sentencia DB y `accepted_at` MUST usar `GREATEST(created_at, statement_timestamp())` o un reloj confiable consistente, de modo que `accepted_at >= created_at`. Cualquier error SQL o fallo al marcar `ACCEPTED` MUST devolver `503` seguro y dejar `PENDING` con la misma ejecución reanudable, sin crear otra; fallo de storage/cola MUST devolver `503` y dejar `PENDING` sin cambios. El replay de `ACCEPTED` MUST ser read-only aunque ML/storage estén caídos, sin firmar ni encolar. Un `PENDING` con snapshot ausente/corrupto, modelos no fijados o contexto/payload inconsistente MUST devolver `503` sin fallback ni re-`prepare`. Si el `PENDING` ya tiene ejecución terminal validada y el snapshot coincide, MUST marcar `ACCEPTED` con el `202` original sin reenviar ni firmar, y MUST NOT prometer outbox/reconciliación de 4.6. La retención de registros `ACCEPTED`, tombstones y vínculos de inferencia MUST NOT purgarse mientras B3 no esté aprobado; el replay MUST NOT simular estado terminal y MUST devolver siempre el `202` original con `status:"QUEUED"` aunque el worker haya terminado. No se promete persistencia durable del job ML, outbox/auto-recuperación (4.6), agotamiento de reintentos (4.7), firma just-in-time antes del worker (4.8) ni de-duplicación eterna; BullMQ conserva `removeOnComplete: 1000`, un retry `PENDING` puede apoyarse en su deduplicación mientras el job exista y el CAS del worker protege la evidencia ya terminal.

#### Scenario: Header ausente o inválido

- **WHEN** `POST /inferences` llega sin `Idempotency-Key`, con valor vacío/whitespace, como array, duplicado por comas o fuera del patrón ASCII
- **THEN** el backend responde `400` seguro antes de preparar, firmar, encolar o escribir una fila
- **AND** no genera una clave por el cliente ni continúa con la creación.

#### Scenario: Orden de rol y header

- **WHEN** un actor no autenticado o con rol distinto de `OFTALMOLOGO` envía un header de idempotencia inválido
- **THEN** el `preHandler` responde `401` o `403` antes del `400` del header
- **AND** no se consulta la tabla de idempotencia.

#### Scenario: Reintento idéntico

- **WHEN** el cliente reenvía la misma solicitud con la misma clave de idempotencia y el mismo payload canónico
- **THEN** el backend reproduce exactamente el mismo `202` con el mismo `inferenceId` y `jobId`
- **AND** no crea una segunda ejecución ni vuelve a llamar a `prepare`.

#### Scenario: Pérdida del `202`

- **WHEN** el cliente no recibió el `202` y reintenta con la misma clave y payload
- **THEN** el backend recupera y devuelve el trabajo ya creado
- **AND** el cliente no necesita un ID que nunca recibió.

#### Scenario: Misma clave con payload distinto

- **WHEN** el cliente reenvía la misma clave con un body distinto o con otro `reanalysisOf`
- **THEN** el backend responde `409 Conflict` con un código seguro antes de ML
- **AND** no reutiliza la ejecución anterior, no muta el registro previo ni crea una nueva silenciosamente.

#### Scenario: Dos solicitudes concurrentes con la misma clave

- **WHEN** dos solicitudes válidas con la misma clave y payload llegan simultáneamente
- **THEN** ambas pueden preparar antes de la transacción, pero una sola ejecución y un solo registro `PENDING` quedan persistidos
- **AND** ambas respuestas apuntan al mismo trabajo y el único `(actor, scope, key)` es el guard final.

#### Scenario: Modelo fijado y URL dinámica

- **WHEN** un reintento cambia la URL firmada o un default de modelo
- **THEN** el trabajo, el snapshot, los modelos resueltos y el pin no cambian por ese reintento
- **AND** la URL firmada dinámica no altera el hash canónico.

#### Scenario: Replay después de que el worker terminó

- **WHEN** el registro ya es `ACCEPTED` y la ejecución real está `COMPLETED`, `REVIEW_REQUIRED` o `FAILED`
- **THEN** el replay devuelve el `202` original con `status:"QUEUED"` sin simular el estado terminal
- **AND** no firma ni encola de nuevo.

#### Scenario: Fallo postcommit de storage o cola

- **WHEN** la ejecución quedó persistida pero falla la firma o el encolado
- **THEN** se responde `503` y el registro queda `PENDING` sin cambiar la ejecución
- **AND** un replay con la misma clave puede reanudar el mismo `inferenceId` sin crear otra.

#### Scenario: Snapshot `PENDING` corrupto o inconsistente

- **WHEN** un registro `PENDING` no tiene snapshot, modelos fijados o contexto verificable
- **THEN** el backend responde `503` seguro sin fallback ni un nuevo `prepare`
- **AND** no inventa una respuesta `202` ni un job nuevo.

#### Scenario: Replay `ACCEPTED` con dependencias caídas

- **WHEN** el registro es `ACCEPTED` y ML o storage no están disponibles
- **THEN** el replay sigue siendo read-only y devuelve la respuesta exacta guardada
- **AND** no intenta firmar, encolar ni consultar el modelo.

#### Scenario: Auth u ownership cambian antes del replay

- **WHEN** la sesión fue revocada, el rol ya no es `OFTALMOLOGO` o el recurso pertenece a otro usuario
- **THEN** el backend responde `401`/`403`/`404` según corresponda antes de revelar el registro
- **AND** no existe lookup cross-user ni mutación de un registro inmutable.

#### Scenario: `PENDING` con ejecución ya terminal

- **WHEN** el registro está `PENDING`, la ejecución ya es terminal y el snapshot validado coincide
- **THEN** el backend marca `ACCEPTED` con el `202` original sin reenviar ni firmar
- **AND** no depende de que BullMQ conserve el job antiguo.

### Requirement: Creación y reanálisis canónicos sin endpoints alternativos

El sistema SHALL exponer un único contrato canónico para crear una ejecución: `POST /inferences` con `reanalysisOf` opcional para reanálisis. El sistema MUST NOT ofrecer `POST /inferences/:id/reanalysis` como un endpoint independiente con semántica distinta ni añadir un alias `/reanalysis`; si en el futuro se conservara uno por compatibilidad, MUST delegar exactamente en el mismo caso de uso, la misma idempotencia obligatoria y el mismo `202`, y el frontend MUST usar solo el canónico. El hash de idempotencia MUST incluir `reanalysisOf` normalizado (UUID lowercase) además del resto del payload. Misma key + mismo payload, incluido el padre, MUST reproducir el `202` existente; misma key + padre distinto MUST responder `409` antes de ML y MUST NOT crear una segunda ejecución; una key distinta MUST crear un reanálisis legítimo como ejecución nueva, con PDF independiente en el futuro (6.x), sin reabrir ni alterar la consulta. El `imageId` MUST corresponder a la lateralidad almacenada y un `eyeSide` contradictorio MUST rechazarse con `422` sin confiar en el valor del cliente. Un reanálisis MUST NOT reabrir ni alterar automáticamente una consulta completada ni promover `requiredExecutionIds` tras el cierre; `requiredSetVersion`, el frozen set y `consultation.status` MUST permanecer intactos (B2).

#### Scenario: Reanálisis canónico

- **WHEN** un usuario autorizado solicita un reanálisis
- **THEN** usa `POST /inferences` con `reanalysisOf`
- **AND** recibe el mismo contrato de idempotencia y `202` que una creación inicial.

#### Scenario: Alias no independiente

- **WHEN** se expone un alias `/reanalysis` por compatibilidad
- **THEN** delega en el caso de uso canónico y exige la misma `Idempotency-Key`
- **AND** no mantiene una segunda implementación divergente.

#### Scenario: Misma key con padre distinto

- **WHEN** el cliente reutiliza la misma `Idempotency-Key` con otro `reanalysisOf` o con otro body
- **THEN** el backend responde `409` antes de ML
- **AND** no crea un segundo reanálisis ni muta el registro original.

#### Scenario: Key distinta crea reanálisis legítimo

- **WHEN** el cliente envía una key nueva con un `reanalysisOf` válido y el mismo contexto
- **THEN** se crea una ejecución nueva enlazada al padre
- **AND** el fingerprint coincidente no bloquea la operación ni el frozen set cambia.

#### Scenario: Frozen set intacto

- **WHEN** se crea un reanálisis sobre una consulta ya cerrada
- **THEN** `requiredExecutionIds`, `requiredSetVersion` y `consultation.status` no cambian
- **AND** el reanálisis histórico no altera la completitud de la consulta.

#### Scenario: Lateralidad contradictoria

- **WHEN** `eyeSide` no coincide con la lateralidad almacenada para `imageId`
- **THEN** el backend responde `422`
- **AND** no crea ni encola una ejecución con datos contradictorios.

### Requirement: Fingerprint y hash sin bloquear reanálisis legítimo

El backend SHALL calcular SHA-256 sobre los bytes sanitizados para verificar el contenido exacto de la imagen. El fingerprint técnico MUST combinar imagen, lateralidad, snapshot clínico normalizado y versión/configuración de modelos. El hash de idempotencia de 4.4 es distinto del fingerprint técnico: MUST calcularse sobre el payload plano canónico de la request (incluido `reanalysisOf`) y MUST NOT incluir URLs firmadas, timestamps, IDs de servidor ni defaults resueltos. La URL firmada dinámica MUST NOT formar parte de ninguno de los dos. El sistema MUST NOT usar el hash ni el fingerprint para negar un reanálisis legítimo ni para revelar a un usuario la existencia de una imagen o caso de otro usuario.

#### Scenario: Misma imagen enviada por otro usuario

- **WHEN** dos usuarios autorizados envían la misma imagen en contextos clínicos distintos
- **THEN** el sistema procesa cada solicitud según su propio alcance
- **AND** no informa a un usuario que la imagen ya existía en el caso del otro.

#### Scenario: Reanálisis solicitado explícitamente

- **WHEN** un usuario autorizado solicita un reanálisis de su propio caso
- **THEN** el sistema crea una nueva ejecución enlazada
- **AND** el fingerprint coincidente no bloquea la operación.

### Requirement: Entrega at-least-once y recuperación del worker

El worker SHALL asumir entrega al menos una vez y MUST aplicar efectos idempotentes. El sistema MUST persistir la intención de encolado de forma consistente con la creación de la ejecución, mediante outbox o reconciliación equivalente, y MUST usar un identificador de inferencia estable. Si se pierde la respuesta de aceptación del ML, el worker MUST consultar el job existente antes de reenviar. Tras un reinicio, el worker MUST recuperar o consultar el job ML existente y MUST NOT inventar un trabajo nuevo para la misma ejecución.

#### Scenario: Respuesta de aceptación perdida

- **WHEN** el ML aceptó el trabajo pero el worker no recibió la respuesta
- **THEN** el worker consulta por el identificador estable antes de reenviar
- **AND** no crea un segundo job para la misma ejecución.

#### Scenario: Reinicio del worker

- **WHEN** el worker se reinicia mientras un job está en curso
- **THEN** recupera el estado del job ML existente
- **AND** continúa la persistencia sin reinferir ni dejar el job huérfano.

#### Scenario: Persistencia duplicada del resultado

- **WHEN** el mismo resultado se entrega o persiste dos veces
- **THEN** la segunda persistencia es idempotente
- **AND** no duplica artefactos, feedback ni transiciones de estado.

### Requirement: Etiquetas canónicas y rechazo de etiquetas desconocidas

El sistema SHALL usar una única fuente canónica en `backend/src/schemas/common.ts`, derivada exactamente de `CLASS_LABELS` con `0 Glaucoma`, `1 Non_Glaucoma` y `2 Suspicious_Glaucoma`. El mapa tipado y el helper `canonicalClassIndex` MUST exportarse y ser usados por el processor; MUST NOT existir un segundo mapa local divergente. Solo MUST preservarse los aliases/casing legacy ya aceptados por el processor (`glaucoma`, `non_glaucoma`, `suspicious_glaucoma`); el matching legacy MUST aplicar `toLowerCase()` únicamente para esos tres nombres y MUST NOT hacer trim, substring ni otras variantes. El helper MUST ser seguro para valores no string y para claves de prototipo como `__proto__`, `constructor` y `toString`, devolviendo `null` sin lanzar. Si el servicio ML devuelve una etiqueta desconocida, el worker MUST rechazarla o registrarla como error seguro; MUST NOT mapearla a una clase inventada ni persistir un índice arbitrario. En `COMPLETED`, una etiqueta desconocida MUST terminar en `FAILED` con código fijo y seguro, sin label raw en logs de producción y con `modelVersions`/`modelPredictions` `{}`. En `REVIEW_REQUIRED`, una etiqueta desconocida MUST dejar `predictedClass=null` y conservar el resto de evidencia parcial válida, sin autoaprobar ni fabricar `0`/`1`. Cada `modelPredictions` MUST exigir las tres claves canónicas con valores finitos `[0,1]`, `confidence` finita `[0,1]` y `predictedClass` canónico o alias legacy acotado, preservando el string raw válido sin castear un índice. Bajo `COMPLETED`, una predicción desconocida o malformada MUST terminar en `FAILED`; bajo `REVIEW_REQUIRED`, MUST descartarse (`{}`) dejando `predictedClass=null` y conservando los demás parciales válidos, sin guardar ni loguear el label raw inválido.

#### Scenario: Etiqueta desconocida en COMPLETED

- **WHEN** un resultado `COMPLETED` contiene una etiqueta fuera del catálogo canónico
- **THEN** el sistema termina `FAILED` con un código de error fijo y seguro
- **AND** no persiste una clase adivinada ni escribe el label raw en logs de producción.

#### Scenario: Etiqueta desconocida en REVIEW_REQUIRED

- **WHEN** un resultado `REVIEW_REQUIRED` contiene una etiqueta fuera del catálogo canónico
- **THEN** `predictedClass` queda `null` y se conserva la demás evidencia parcial válida
- **AND** no se convierte la revisión en `COMPLETED` ni se fabrica `0`/`1`.

#### Scenario: Clase canónica y casing legacy

- **WHEN** el resultado contiene `Glaucoma`, `Non_Glaucoma`, `Suspicious_Glaucoma` o el casing legacy `glaucoma`/`non_glaucoma`/`suspicious_glaucoma`
- **THEN** el sistema persiste `0`/`1`/`2` según la fuente única
- **AND** conserva la etiqueta y las probabilidades originales para trazabilidad.

#### Scenario: Clave de prototipo y valor nulo

- **WHEN** la etiqueta es `null`, `undefined`, `__proto__`, `constructor` o `toString`
- **THEN** `canonicalClassIndex` devuelve `null` sin lanzar
- **AND** no se persiste una clase por accidente de prototipo.

#### Scenario: Predicción por modelo desconocida o malformada

- **WHEN** `modelPredictions` contiene un label desconocido, claves de probabilidad no canónicas, valores fuera de `[0,1]` o una estructura malformada
- **THEN** en `COMPLETED` la validación falla de forma cerrada y la ejecución termina `FAILED`
- **AND** en `REVIEW_REQUIRED` se descartan esas predicciones (`{}`), `predictedClass` queda `null` y se conservan los demás parciales válidos sin guardar ni loguear el label raw.

### Requirement: Reintentos acotados y semántica de timeout/cancelación

El sistema SHALL reintentar solo errores transitorios, con backoff acotado y un límite explícito. Timeout y cancelación MUST tener semántica explícita y MUST NOT permitir un job huérfano silencioso. Un fallo permanente MUST terminar en `FAILED` con causa segura, sin reintentos infinitos.

#### Scenario: Error transitorio de red

- **WHEN** la descarga o el envío falla por un error transitorio dentro del límite
- **THEN** el sistema reintenta con backoff
- **AND** conserva el mismo identificador de ejecución.

#### Scenario: Límite de reintentos agotado

- **WHEN** se agota el límite de reintentos
- **THEN** la ejecución termina en `FAILED` con causa segura y no reintentable
- **AND** no queda un job en ejecución sin dueño.

#### Scenario: Cancelación solicitada

- **WHEN** una ejecución se cancela de forma autorizada
- **THEN** el sistema registra el estado y la causa de cancelación
- **AND** no la presenta como completada.

### Requirement: URL firmada just-in-time y protección SSRF

El backend SHALL generar la URL firmada para el ML justo antes de entregarla al worker o de enviarla al servicio ML, a partir de una referencia de almacenamiento confiable. El sistema MUST NOT persistir una URL firmada de larga vida en BullMQ ni en base de datos. La descarga ML MUST validar host allowlisted, esquema HTTPS, no seguir redirecciones y respetar límites de tamaño.

#### Scenario: Espera en cola mayor que el TTL

- **WHEN** un job espera en cola más tiempo que el TTL de la URL firmada
- **THEN** el worker obtiene una URL nueva justo antes de enviarla
- **AND** el ML no recibe una URL expirada.

#### Scenario: Host no permitido

- **WHEN** una referencia resuelve a un host fuera de la allowlist
- **THEN** el sistema rechaza la descarga antes de realizarla
- **AND** no intenta acceder a redes internas ni metadatos del proveedor.

### Requirement: Publicación de artefactos sin reinferir y credenciales internas

El sistema SHALL permitir publicar o reintentar artefactos derivados de un resultado recuperable sin reinferir. El token interno del ML, las credenciales de storage y los SAS MUST ser de mínimo privilegio y MUST NOT exponerse al frontend ni a logs. La publicación de artefactos MUST usar referencias estructuradas y respetar la propiedad de la ejecución.

#### Scenario: Reintento de publicación

- **WHEN** falla la subida de un artefacto pero el resultado es recuperable
- **THEN** el sistema reintenta la publicación con el mismo resultado
- **AND** no vuelve a ejecutar el modelo.

#### Scenario: Credenciales no expuestas

- **WHEN** el frontend solicita el estado de una ejecución
- **THEN** la respuesta no incluye tokens internos, credenciales de storage ni SAS de larga vida
- **AND** solo incluye estados y referencias autorizadas.

### Requirement: Preparación de contexto clínico en el servicio ML

El servicio ML SHALL exponer `POST /v1/clinical-snapshots/prepare`, autenticado con el mismo `require_service_token` que `/v1/inferences` y con el mismo fallo `503` cuando el runtime no está disponible. El request MUST ser estricto y contener `clinical_features` y `requested_model_version` opcional; MUST NOT aceptar `eye_side`, `consultation_id`, `clinical_data` libre, URLs, archivos ni campos desconocidos. La respuesta MUST contener `rawCanonical`, `normalizedPayload`, `schemaVersion`, `modelVersions` y `contextFingerprintSha256`. `rawCanonical` MUST contener exactamente las once `clinical_features` validadas y MUST NOT contener el ojo ni claves extra. `normalizedPayload` MUST contener el orden canónico, `dtype="float32"`, once valores producidos por el helper real de normalización, el descriptor efectivo completo, `canonicalJson` exacto y `contextFingerprintSha256`. `schemaVersion` MUST ser `ml-zscore-f32-v1`. `modelVersions` MUST ser no vacío y real. La huella MUST ser SHA-256 lowercase de 64 hex sobre el descriptor canónico sin el propio campo. El endpoint MUST NOT escribir en base de datos, descargar pesos ni cargar modelos nuevos para una preparación; si no puede verificar el contexto, MUST responder `503` seguro sin secretos, URL ni PHI.

#### Scenario: Preparación válida

- **WHEN** el backend envía once features válidas y `requested_model_version=null`
- **THEN** el ML responde con el snapshot crudo canónico, el vector normalizado float32, `schemaVersion="ml-zscore-f32-v1"`, versiones reales y huella hex
- **AND** no descarga pesos ni escribe en DB.

#### Scenario: Request con campos de contexto ojo/consulta

- **WHEN** la preparación incluye `eye_side`, `consultation_id` o campos desconocidos
- **THEN** el servicio responde `400`/`422` por contrato estricto
- **AND** no prepara un snapshot con datos que no le corresponden.

#### Scenario: Runtime no disponible

- **WHEN** el runtime no está inicializado o su descriptor no es verificable
- **THEN** la preparación responde `503` seguro antes de cualquier trabajo
- **AND** no devuelve una huella inventada ni un snapshot parcial.

### Requirement: Resolución efectiva de parámetros y modelo

El servicio ML SHALL usar como fuente del snapshot el runner realmente cargado, no un duplicado en JavaScript ni un valor de entorno leído después del arranque. Los parámetros efectivos de normalización MUST corresponder a la misma resolución que usa `predict`: once nombres ordenados, `mean`/`std` con su fuente (`env` o `manifest`), `epsilon=1e-8` y `dtype=float32`. El descriptor de contexto MUST incluir la versión del manifiesto, el backend efectivo `pytorch`/`onnx`, las revisiones y checksums verificados de los artefactos y, si ONNX está habilitado, el SHA-256 real de los archivos ONNX fijados calculado una vez al arrancar. MUST incluir los settings no secretos de preprocessing/segmentation que afectan el resultado y MUST excluir secretos, endpoints, buckets, DSNs, rutas locales, device y timeouts. Cambiar cualquiera de los elementos que afectan el resultado MUST cambiar la huella; cambiar un secreto o una ruta de caché MUST NOT cambiarla.

#### Scenario: Cambio de media/desviación

- **WHEN** el runtime carga `mean`/`std` desde env en lugar del manifiesto, o viceversa
- **THEN** el descriptor registra la fuente efectiva y la huella cambia
- **AND** la preparación y `predict` usan exactamente el mismo vector.

#### Scenario: Backend ONNX con archivos fijados

- **WHEN** el backend efectivo es ONNX
- **THEN** el descriptor incluye el SHA-256 real de los ONNX fijados, calculado una vez al runtime
- **AND** no se recalcula por request ni se inventa un checksum.

#### Scenario: Fallback de ONNX a PyTorch

- **WHEN** se solicita ONNX pero faltan los archivos y el runtime usa PyTorch
- **THEN** `modelVersions.backend` refleja `pytorch`, no el valor solicitado
- **AND** la huella corresponde al runner realmente cargado.

### Requirement: Pin `expected_context` en solicitudes ML

El contrato `InferenceRequest` SHALL aceptar `expected_context` opcional con `{ schema_version: string, fingerprint_sha256: string }` estricto. Los jobs nuevos del backend MUST enviarlo siempre. El servicio ML MUST compararlo con su contexto efectivo al aceptar el job si puede hacerlo y MUST revalidarlo antes de descargar la imagen y segmentar. Un mismatch MUST producir un error seguro y no retryable, sin URL, PHI, tokens ni trazas; MUST NOT hacer fallback silencioso al contexto nuevo ni descartar el pin. Las solicitudes legacy sin pin MUST seguir aceptándose y ejecutándose con el runtime actual. El rollout MUST desplegar primero el ML que entiende el campo opcional, después el backend que prepara/envía el pin y después el worker que lo transmite/valida. Un `model_version` legado no nulo distinto de la versión efectiva MUST dejar de ignorarse en el camino nuevo de preparación y responder `422`.

#### Scenario: Pin coincidente

- **WHEN** el job incluye `expected_context` y coincide con el descriptor del runtime
- **THEN** el ML acepta el job y continúa con la descarga/segmentación normal
- **AND** el pin permanece asociado al trabajo.

#### Scenario: Pin divergente al aceptar

- **WHEN** el pin no coincide con el contexto del runtime al aceptar el job
- **THEN** el ML responde un error seguro no retryable (por ejemplo `409 context_mismatch`)
- **AND** no encola trabajo ni descarga la imagen.

#### Scenario: Contexto cambia durante la ejecución

- **WHEN** el contexto cambia después de aceptar el job pero antes de descargar/segmentar
- **THEN** `run` revalida el pin y termina el job como `FAILED` con mensaje seguro `context_mismatch`
- **AND** no produce un resultado con el contexto nuevo.

#### Scenario: Request legacy sin pin

- **WHEN** un cliente legacy envía `/v1/inferences` sin `expected_context`
- **THEN** el ML lo acepta con el runtime actual
- **AND** no lo rechaza por ausencia de pin ni inventa uno.

### Requirement: Compatibilidad del worker con terminales y revisión

El worker SHALL conservar `startInferenceWorker()` como bootstrap y MUST permitir probar el procesamiento con dependencias inyectadas sin importar Redis ni abrir conexiones al importar el módulo. El worker MUST transmitir el pin del job al servicio ML. Si el ML rechaza el pin al aceptar (por ejemplo `409 context_mismatch`), el worker MUST persistir `FAILED` seguro y MUST NOT reintentar sin pin ni con el contexto nuevo. MUST tratar `COMPLETED`, `REVIEW_REQUIRED` y `FAILED` como terminales. `REVIEW_REQUIRED` MUST persistir el resultado parcial disponible y MUST NOT lanzarse como fallo ni reintentarse. El polling MUST estar acotado (máximo 60 intentos de 2 s) y un timeout MUST terminar de forma segura, sin bucle infinito. Antes de persistir MUST validar que `result.inference_id` y `result.eye_side` coinciden con el job. Una etiqueta desconocida en un resultado `COMPLETED` MUST rechazarse de forma segura sin adivinar una clase. La persistencia terminal MUST ser condicional: una entrega duplicada no puede sobrescribir una ejecución ya terminal. El worker MUST NOT perder `cdrVertical`, `quality`, `artifacts`, `elapsedSeconds` ni `modelVersions` ya disponibles y MUST NOT inventar `"v1"`. La persistencia completa/exposición sigue siendo 4.2; el rechazo formal de etiquetas sigue siendo 4.3. El worker MUST NOT actualizar `consultation.status` ni autocompletar la consulta para ningún job, incluido legacy.

#### Scenario: Resultado en revisión

- **WHEN** el ML devuelve `REVIEW_REQUIRED` con evidencia parcial
- **THEN** el worker persiste el estado y los campos parciales disponibles
- **AND** no lanza el job como fallo genérico ni lo reintenta.

#### Scenario: Resultado completo con etiqueta desconocida

- **WHEN** un resultado `COMPLETED` trae una etiqueta fuera del catálogo canónico
- **THEN** el worker falla de forma segura y no persiste una clase adivinada
- **AND** no marca la ejecución como completada con datos inválidos.

#### Scenario: IDs u ojo contradictorios

- **WHEN** el resultado ML devuelve un `inference_id` o `eye_side` distintos del job
- **THEN** el worker falla de forma segura sin persistir el resultado ajeno
- **AND** no actualiza la consulta.

#### Scenario: Entrega duplicada de un job terminal

- **WHEN** el mismo resultado se entrega dos veces y la ejecución ya está `COMPLETED`/`REVIEW_REQUIRED`/`FAILED`
- **THEN** la segunda persistencia es no-op idempotente
- **AND** no se reemplaza un estado terminal ni se duplican artefactos.

#### Scenario: Polling agotado

- **WHEN** el job no alcanza un estado terminal en 60 intentos de 2 s
- **THEN** el worker lo cierra de forma segura como fallo acotado
- **AND** no queda un bucle infinito ni una consulta autocompletada.
