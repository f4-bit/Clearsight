# Inference Orchestration — Delta Specification

## ADDED Requirements

### Requirement: Contrato público estricto del servicio ML

El servicio ML SHALL exponer `POST /v1/inferences` con cuerpo JSON que contenga `inference_id`, `image_url` firmada, `eye_side`, `clinical_features` y `model_version` opcional. El endpoint MUST NOT aceptar multipart, un segundo archivo de imagen ni un valor de CDR como entrada. El servicio MUST validar estrictamente los campos y MUST responder `202 Accepted` con identificadores de inferencia y job cuando acepte el trabajo.

#### Scenario: Solicitud válida con URL firmada

- **WHEN** el backend envía un JSON estricto con `inference_id`, `image_url`, `eye_side` y las once variables clínicas
- **THEN** el servicio ML responde `202 Accepted` con `inference_id`, `job_id` y estado `QUEUED`
- **AND** no requiere subir un archivo multipart.

#### Scenario: Intento de enviar CDR de entrada

- **WHEN** la solicitud incluye un campo de CDR o un archivo adjunto no previsto
- **THEN** el servicio ML rechaza la solicitud por contrato estricto
- **AND** no inicia un análisis con datos no canónicos.

#### Scenario: URL de imagen no firmada o inválida

- **WHEN** `image_url` no es HTTPS válido o su host no está allowlisted
- **THEN** el servicio ML rechaza la descarga con un error seguro
- **AND** no sigue redirecciones ni hosts no autorizados.

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

El backend SHALL implementar idempotencia persistida y resistente a concurrencia, con alcance autenticado durable por usuario o servicio y recurso. `Idempotency-Key` MUST ser obligatoria en `POST /inferences` y en cualquier alias de reanálisis; MUST NOT ser solo recomendada. La misma clave con el mismo payload MUST reproducir el mismo `202` con el mismo `inferenceId` y `jobId` de servidor. Si se pierde el `202`, el cliente MUST poder reintentar con la misma clave sin necesitar un ID que nunca recibió. La misma clave con un payload distinto MUST responder conflicto. El modelo resuelto en la primera solicitud MUST fijarse y MUST NOT cambiar por defaults de reintentos. La URL firmada dinámica MUST NOT formar parte del payload ni del fingerprint. La retención de registros de idempotencia, tombstones y vínculos de inferencia MUST NOT purgarse mientras B3 no esté aprobado; cuando se apruebe, podrá acotarse sin romper el horizonte de replay definido. No se promete replay eterno arbitrario, pero la política vigente es no purgar. El backend MUST NOT confiar en que el frontend deshabilite un botón para evitar duplicados.

#### Scenario: Reintento idéntico

- **WHEN** el cliente reenvía la misma solicitud con la misma clave de idempotencia y el mismo payload
- **THEN** el backend reproduce el mismo `202` con el mismo `inferenceId` y `jobId`
- **AND** no crea una segunda ejecución.

#### Scenario: Pérdida del `202`

- **WHEN** el cliente no recibió el `202` y reintenta con la misma clave y payload
- **THEN** el backend recupera y devuelve el trabajo ya creado
- **AND** el cliente no necesita un ID que nunca recibió.

#### Scenario: Misma clave con payload distinto

- **WHEN** el cliente reenvía la misma clave con un payload diferente
- **THEN** el backend responde `409 Conflict` con un código seguro
- **AND** no reutiliza la ejecución anterior ni crea una nueva silenciosamente.

#### Scenario: Dos solicitudes concurrentes con la misma clave

- **WHEN** dos solicitudes válidas con la misma clave y payload llegan simultáneamente
- **THEN** una sola ejecución queda persistida
- **AND** ambas respuestas apuntan al mismo trabajo.

#### Scenario: Modelo fijado y URL dinámica

- **WHEN** un reintento cambia la URL firmada o un default de modelo
- **THEN** el trabajo y el modelo resuelto no cambian por ese reintento
- **AND** la URL firmada dinámica no altera la identidad del payload.

### Requirement: Creación y reanálisis canónicos sin endpoints alternativos

El sistema SHALL exponer un único contrato canónico para crear una ejecución: `POST /inferences` con `reanalysisOf` opcional para reanálisis. El sistema MUST NOT ofrecer `POST /inferences/:id/reanalysis` como un endpoint independiente con semántica distinta. Si se conserva como alias de compatibilidad, MUST delegar exactamente en el mismo caso de uso, la misma idempotencia obligatoria y el mismo `202`; el frontend MUST usar solo el canónico. El `imageId` MUST corresponder a la lateralidad almacenada y un `eyeSide` contradictorio MUST rechazarse con `422` sin confiar en el valor del cliente. Un reanálisis MUST NOT reabrir ni alterar automáticamente una consulta completada ni promover `requiredExecutionIds` tras el cierre; los reanálisis históricos no modifican el frozen set (B2).

#### Scenario: Reanálisis canónico

- **WHEN** un usuario autorizado solicita un reanálisis
- **THEN** usa `POST /inferences` con `reanalysisOf`
- **AND** recibe el mismo contrato de idempotencia y `202` que una creación inicial.

#### Scenario: Alias no independiente

- **WHEN** se expone un alias `/reanalysis` por compatibilidad
- **THEN** delega en el caso de uso canónico y exige la misma `Idempotency-Key`
- **AND** no mantiene una segunda implementación divergente.

#### Scenario: Lateralidad contradictoria

- **WHEN** `eyeSide` no coincide con la lateralidad almacenada para `imageId`
- **THEN** el backend responde `422`
- **AND** no crea ni encola una ejecución con datos contradictorios.

### Requirement: Fingerprint y hash sin bloquear reanálisis legítimo

El backend SHALL calcular SHA-256 sobre los bytes sanitizados para verificar el contenido exacto de la imagen. El fingerprint técnico MUST combinar imagen, lateralidad, snapshot clínico normalizado y versión/configuración de modelos. La URL firmada dinámica MUST NOT formar parte del fingerprint. El sistema MUST NOT usar el hash ni el fingerprint para negar un reanálisis legítimo ni para revelar a un usuario la existencia de una imagen o caso de otro usuario.

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

El sistema SHALL usar las clases canónicas `0 Glaucoma`, `1 Non_Glaucoma` y `2 Suspicious_Glaucoma`. Si el servicio ML devuelve una etiqueta desconocida, el worker MUST rechazarla o registrarla como error seguro; MUST NOT mapearla a una clase inventada ni persistir un índice arbitrario.

#### Scenario: Etiqueta desconocida

- **WHEN** el resultado ML contiene una etiqueta que no pertenece al catálogo canónico
- **THEN** el sistema registra un error seguro y no persiste una clase adivinada
- **AND** la ejecución no se marca como completada con datos inválidos.

#### Scenario: Clase canónica correcta

- **WHEN** el resultado contiene `Glaucoma`
- **THEN** el sistema persiste la clase `0`
- **AND** conserva la etiqueta y las probabilidades originales para trazabilidad.

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
