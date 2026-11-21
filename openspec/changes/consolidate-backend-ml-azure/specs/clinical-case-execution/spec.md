# Clinical Case Execution — Delta Specification

## ADDED Requirements

### Requirement: Una ejecución analiza una sola retinografía con lateralidad

El sistema SHALL modelar cada análisis como una ejecución independiente que referencia exactamente una imagen de fondo de ojo y una lateralidad `OD` u `OS` como metadato. La lateralidad MUST viajar como atributo de la ejecución y del snapshot, no como un segundo archivo ni como un campo inferido por el modelo. Una ejecución MUST pertenecer a un paciente y a una consulta.

#### Scenario: Ejecución de un solo ojo

- **WHEN** se solicita analizar una imagen con lateralidad `OD`
- **THEN** el sistema crea una única ejecución asociada a esa imagen, ese ojo y su consulta
- **AND** no crea ni exige una segunda imagen ni una segunda ejecución por bilateralidad.

#### Scenario: Lateralidad inválida rechazada

- **WHEN** la solicitud de análisis incluye una lateralidad distinta de `OD` o `OS`
- **THEN** el sistema rechaza la solicitud con un error de validación explícito
- **AND** no crea una ejecución parcial.

### Requirement: Snapshot clínico inmutable por ejecución

El sistema SHALL crear un snapshot clínico inmutable para cada ejecución. El snapshot MUST conservar el payload crudo, el payload normalizado, la versión del esquema de normalización y las revisiones de modelo aplicables. Una ejecución ya creada MUST NOT leer datos clínicos mutables de la consulta para reconstruir su resultado o su PDF.

#### Scenario: Cambio posterior de datos clínicos

- **WHEN** los datos clínicos de una consulta cambian después de crear una ejecución
- **THEN** la ejecución conserva el snapshot original
- **AND** el reanálisis, si se solicita, usa un snapshot nuevo y no modifica el anterior.

#### Scenario: Snapshot usado por PDF y evidencia

- **WHEN** se genera o regenera el PDF de una ejecución
- **THEN** el PDF usa el mismo snapshot inmutable y la misma versión de resultado
- **AND** no incorpora silenciosamente datos clínicos modificados después del análisis.

### Requirement: Reanálisis enlazado sin sobrescribir evidencia

El sistema SHALL permitir solicitar un reanálisis como una nueva ejecución enlazada a la anterior mediante un identificador de procedencia. La nueva ejecución MUST NOT sobrescribir resultado, artefactos, PDF, feedback ni auditoría de la ejecución previa. Ambas ejecuciones MUST permanecer consultables y auditables. Un reanálisis no seleccionado en `requiredExecutionIds` MAY existir en el historial con su propio PDF independiente, pero MUST NOT modificar la completitud de una consulta ya cerrada ni la selección de ejecuciones requeridas. La consulta cerrada MUST NOT reabrirse ni alterarse automáticamente y MUST NOT promoverse ni reemplazarse un `requiredExecutionId` tras el cierre (B2 resuelto como restricción aprobada); los reanálisis históricos independientes MUST NOT modificar el conjunto requerido congelado.

#### Scenario: Nuevo reanálisis

- **WHEN** se solicita un reanálisis de una ejecución existente
- **THEN** el sistema crea una ejecución nueva con un identificador nuevo y un enlace a la ejecución de origen
- **AND** la ejecución original conserva intactos su resultado, sus artefactos y su PDF.

#### Scenario: Reanálisis fuera de la selección cerrada

- **WHEN** se ejecuta un reanálisis que no forma parte de los `requiredExecutionIds` de una consulta cerrada
- **THEN** el reanálisis conserva su historial y su PDF independiente
- **AND** la completitud y la selección de la consulta cerrada no cambian.

#### Scenario: Intento de actualizar una ejecución cerrada

- **WHEN** un proceso intenta persistir un resultado sobre una ejecución ya terminal
- **THEN** el sistema rechaza la sobrescritura o la registra como nueva versión explícita
- **AND** nunca reemplaza evidencia pasada de forma implícita.

### Requirement: Selección explícita de ejecuciones requeridas y cambio tras cierre

El sistema SHALL declarar por consulta una selección explícita de `requiredExecutionIds` y una `requiredSetVersion` (manifiesto) al iniciar el análisis. La selección puede cubrir uno (`OD` u `OS`) o ambos ojos; no se exige bilateralidad de forma universal. La completitud MUST evaluarse solo sobre esos IDs y MUST NOT usar “latest” automático. Un reanálisis no seleccionado MUST NOT cambiar la evidencia ni la completitud de una consulta cerrada. La promoción o reemplazo de un `requiredExecutionId` tras el cierre MUST NOT realizarse (B2 resuelto como restricción aprobada); la ejecución del reanálisis en sí no está bloqueada y conserva su PDF independiente. La consulta cerrada MUST NOT reabrirse ni ampliarse automáticamente y no se asume cierre retroactivo. Cualquier cambio futuro del conjunto requerido exigirá una nueva decisión de producto y una versión documentada antes de aplicarse. El freeze SHALL realizarse mediante una operación explícita `POST /consultations/:id/required-executions`: MUST verificar ownership, MUST recibir solo IDs existentes de la consulta y MUST escribir `requiredExecutionIds`, `requiredSetVersion` y `requiredSetFrozenAt` en una única transacción. MUST rechazar duplicados e IDs ajenos, MUST NOT modificar `consultation.status` y MUST NOT reabrir una consulta cerrada; tras el freeze, cualquier cambio MUST rechazarse (guard SQL existente).

#### Scenario: Consulta con un solo ojo requerido

- **WHEN** una consulta declara solo el ojo `OS` como requerido mediante `requiredExecutionIds`
- **THEN** la completitud se evalúa únicamente sobre esas ejecuciones requeridas
- **AND** la ausencia de `OD` no se considera un fallo de completitud.

#### Scenario: Conjunto requerido vacío

- **WHEN** una consulta no tiene `requiredExecutionIds`
- **THEN** su `analysisState` es `OPEN`
- **AND** no se considera completa por vacuidad.

#### Scenario: Reanálisis histórico excluido

- **WHEN** existe un reanálisis posterior no incluido en `requiredExecutionIds`
- **THEN** el sistema no lo usa como “latest” para reemplazar la evidencia de cierre
- **AND** la completitud se calcula solo con los IDs seleccionados.

#### Scenario: Cambio de conjunto sin regla aprobada

- **WHEN** se intenta modificar el conjunto requerido o promover un reemplazo después del cierre sin una regla versionada aprobada
- **THEN** el sistema rechaza la transición con un bloqueo explícito
- **AND** no marca retroactivamente la consulta como completa o incompleta.

#### Scenario: Freeze por operación explícita

- **WHEN** se invoca `POST /consultations/:id/required-executions` con IDs existentes de la consulta
- **THEN** se fijan `requiredExecutionIds`, `requiredSetVersion` y `requiredSetFrozenAt` en una TX
- **AND** no se modifica `consultation.status` ni se reabre una consulta cerrada.

#### Scenario: ID duplicado, ajeno o cambio tras freeze

- **WHEN** la operación recibe un ID duplicado o de otra consulta, o se intenta cambiar un conjunto ya congelado
- **THEN** el sistema rechaza la operación
- **AND** conserva el conjunto y la versión previamente congelados.

### Requirement: Separación entre estado de ejecución, etapa, artefacto y consulta

El sistema SHALL separar estos conceptos: ejecución ML, etapa de pipeline, estado de artefacto, entrega de PDF y estado agregado de consulta. El estado de ejecución MUST usar el vocabulario `QUEUED`, `DOWNLOADING`, `LOCALIZING`, `SEGMENTING`, `CLASSIFYING`, `COMPLETED`, `REVIEW_REQUIRED`, `FAILED`. El sistema MUST NOT introducir un estado `PROCESSING` en el enum de base de datos sin migración. `COMPLETED` de ejecución MUST NOT equivaler a consulta completada ni a entrega completa; el estado de entrega y el agregado de consulta MUST ser campos separados.

#### Scenario: ML completa una ejecución

- **WHEN** una ejecución termina con resultado válido
- **THEN** su estado puede ser `COMPLETED`
- **AND** la consulta solo se completa si todos sus `requiredExecutionIds` tienen resultado válido, evidencia obligatoria y PDF disponible.

#### Scenario: Falta PDF en una ejecución requerida

- **WHEN** el resultado ML es válido pero el PDF obligatorio no se generó
- **THEN** la ejecución requerida no cuenta como completa
- **AND** la consulta permanece incompleta con un `reportState` explícito.

### Requirement: Estado agregado de consulta con precedencia determinista

El sistema SHALL calcular `analysisState`, `reportState`, `completionState` y `pollingStop` de la consulta como campos derivados y MUST NOT persistirlos como un enum nuevo de base de datos. `analysisState` MUST usar `OPEN`, `IN_PROGRESS`, `REVIEW_REQUIRED`, `FAILED`, `PARTIAL` o `COMPLETED`; `reportState` MUST usar `NOT_REQUESTED`, `REPORT_PENDING`, `AVAILABLE` o `FAILED`; `completionState` MUST ser `INCOMPLETE` o `COMPLETE`; `pollingStop` MUST usar `CONTINUE`, `COMPLETE`, `ACTION_REQUIRED` o `FAILED`. La precedencia de `analysisState` MUST ser: conjunto vacío ⇒ `OPEN`; todo requerido satisfecho ⇒ `COMPLETED`; cualquier `FAILED` sin recuperación pendiente ⇒ `FAILED`; cualquier `REVIEW_REQUIRED` ⇒ `REVIEW_REQUIRED`; cualquier ejecución con `jobTerminal=false` o artefacto obligatorio `PENDING` ⇒ `IN_PROGRESS`; alguna ejecución requerida con resultado/evidencia pero no todas ⇒ `PARTIAL`; en otro caso ⇒ `OPEN`. `reportState` MUST ser `NOT_REQUESTED` si `requiredExecutionIds` está vacío; `AVAILABLE` solo si el conjunto no está vacío y **todos** los `pdfStatus` están `AVAILABLE`; `REPORT_PENDING` si alguno está en generación/publicación y ninguno es fallo terminal; `FAILED` si alguno es fallo terminal. La precedencia de `reportState` MUST ser `FAILED > REPORT_PENDING > AVAILABLE`; nunca `AVAILABLE` por vacuidad. `completionState = COMPLETE` MUST requerir conjunto no vacío, todas las ejecuciones requeridas con resultado, artefactos obligatorios y PDF disponible; no basta “algún reporte” ni un reporte histórico. Cada delivery de ejecución registra su propia completitud y la agregación MUST NOT sobrescribir histórico. `pollingStop` MUST ser `COMPLETE` solo con `completionState=COMPLETE`, `ACTION_REQUIRED` si hay revisión/bloqueo que exige acción humana o nueva consulta, `FAILED` en fallo terminal y `CONTINUE` si queda `REPORT_PENDING` o `jobTerminal=false`. La agregación MUST leer en batch los estados reales de `ArtifactRecord`/`PdfReport` (depende de 3.5) y MUST NOT introducir un enum persistido. `GET /consultations/:id` SHALL exponer los agregados calculados en lectura, sin persistirlos.

#### Scenario: Mezcla de fallo, revisión y ejecución en curso

- **WHEN** una consulta tiene una ejecución requerida `FAILED` sin recuperación, otra `REVIEW_REQUIRED` y otra en curso
- **THEN** `analysisState` es `FAILED` por precedencia conservadora
- **AND** el sistema no declara completitud ni oculta los otros estados.

#### Scenario: Resultado completo pero reporte pendiente

- **WHEN** todas las ejecuciones requeridas tienen resultado y evidencia, pero el PDF no está disponible
- **THEN** `analysisState` es `COMPLETED` y `reportState` es `REPORT_PENDING`
- **AND** `completionState` es `INCOMPLETE` y `pollingStop` es `CONTINUE`.

#### Scenario: Un PDF no completa toda la consulta

- **WHEN** solo una parte de las ejecuciones requeridas tiene PDF `AVAILABLE`
- **THEN** `reportState` no es `AVAILABLE`
- **AND** `completionState` no es `COMPLETE`.

#### Scenario: Conjunto vacío no completa

- **WHEN** la consulta no tiene ejecuciones requeridas
- **THEN** `analysisState` es `OPEN` y `reportState` es `NOT_REQUESTED`
- **AND** `completionState` nunca es `COMPLETE` por vacuidad.

#### Scenario: Lectura expone agregados sin persistir

- **WHEN** se lee una consulta con ejecuciones, artefactos y PDF reales en distintos estados
- **THEN** `GET /consultations/:id` devuelve los agregados calculados en esa lectura
- **AND** no escribe un enum agregado ni altera las filas de ejecución/PDF.

### Requirement: Revisión humana terminal sin cierre automático

El sistema SHALL tratar `REVIEW_REQUIRED` como un estado terminal para la espera automática. Un timeout MUST NOT convertir la ejecución en `COMPLETED`, y la existencia de un PDF MUST NOT aprobar automáticamente la revisión. **B1 queda resuelto como restricción aprobada:** el médico MUST NOT convertir una ejecución sin resultado válido en `COMPLETED`; `REVIEW_REQUIRED` MUST preservarse. La resolución SHALL ser un reanálisis como ejecución nueva, con imagen/snapshot nuevos si procede, PDF independiente y vínculo a la ejecución anterior, sin sobrescribir la evidencia previa. No existe endpoint ejecutable de aprobación de revisión ni auto-completado manual alternativo en este hito. El cierre/entrega de una revisión MUST usar el agregado de consulta y el PDF de revisión de 6.3; el worker terminal por sí solo no completa ni entrega la consulta.

#### Scenario: Revisión requerida por calidad

- **WHEN** el pipeline determina que la calidad o la segmentación requieren revisión
- **THEN** la ejecución termina en `REVIEW_REQUIRED`
- **AND** el sistema detiene la espera automática y muestra la limitación sin declarar completitud.

#### Scenario: Intento de autoaprobar por PDF

- **WHEN** existe un PDF generado para una ejecución en `REVIEW_REQUIRED`
- **THEN** el sistema no cambia la ejecución a `COMPLETED`
- **AND** exige una resolución humana que, conforme a B1, consiste en un reanálisis con PDF independiente y no en una conversión manual.

#### Scenario: Médico intenta convertir sin resultado válido

- **WHEN** un médico intenta marcar `COMPLETED` una ejecución `REVIEW_REQUIRED` o sin resultado válido
- **THEN** el sistema rechaza la conversión
- **AND** preserva `REVIEW_REQUIRED` y ofrece un reanálisis como ejecución nueva vinculada, sin pisar la evidencia anterior.

### Requirement: Snapshot clínico preparado por el runtime ML

El sistema SHALL construir el snapshot clínico de una ejecución a partir de la `clinicalFeatures` validada de la request, la imagen/consulta/ojo autoritativos de la base de datos y la preparación realizada por el runtime ML. El `rawPayload` MUST contener el ojo autoritativo y las once variables exactamente enviadas, y MUST NOT construirse desde `consultation.clinicalData`. El `normalizedPayload` MUST contener el vector real producido por el helper de normalización ML con `float32` y epsilon `1e-8`, con orden de features y `dtype` explícitos, además del descriptor efectivo completo, su `canonicalJson` exacto y `contextFingerprintSha256`; el backend MUST NOT recalcular el z-score en JavaScript ni canonicalizar de nuevo para la huella. La `schemaVersion` MUST ser la constante local del algoritmo `ml-zscore-f32-v1`, que describe la normalización y MUST NOT inventar unidades clínicas. `modelVersions` MUST ser un objeto no vacío con las revisiones reales verificadas y el backend efectivo `pytorch`/`onnx`; MUST NOT persistir `{}`, `"v1"` ni una versión fabricada. Un snapshot no verificable MUST fallar de forma segura antes de escribir en la base de datos.

#### Scenario: Snapshot desde la request autoritativa

- **WHEN** se crea una ejecución con `eyeSide=OD` y once variables clínicas válidas
- **THEN** el `rawPayload` persistido contiene `{ eyeSide: "OD", clinicalFeatures: <once valores exactos> }`
- **AND** el `normalizedPayload` contiene el ojo, el orden canónico, `dtype="float32"`, once valores normalizados reales, el descriptor efectivo, `canonicalJson` y la huella exacta
- **AND** no se usa `consultation.clinicalData` para completar ni corregir el snapshot.

#### Scenario: Vector normalizado todo cero

- **WHEN** las once variables enviadas coinciden exactamente con la media efectiva del modelo
- **THEN** el vector normalizado contiene once valores finitos cercanos a cero
- **AND** el sistema lo acepta como snapshot válido, sin confundir “vector cero” con “payload vacío”.

#### Scenario: Runtime ML no verificable

- **WHEN** el runtime no puede resolver manifiesto, revisión, checksum o parámetros efectivos
- **THEN** la preparación responde `503` seguro antes de escribir snapshot o ejecución
- **AND** no se persiste un snapshot parcial ni se inventa una versión de modelo.

### Requirement: Pin de contexto y rechazo de snapshot mentiroso

El sistema SHALL fijar en cada job nuevo la huella de contexto preparada (`schema_version` + `fingerprint_sha256`) y el servicio ML MUST compararla con su contexto efectivo antes de descargar la imagen y segmentar. Si el contexto difiere, el job MUST fallar con un código seguro y MUST NOT ejecutarse con el contexto nuevo de forma silenciosa, ni descartar el pin para reintentar. Las solicitudes legacy sin pin MUST seguir siendo compatibles y ejecutarse con el runtime actual; el orden de despliegue MUST ser ML primero, después backend y después worker. Un `requested_model_version` no nulo distinto de la versión efectiva del manifiesto MUST rechazarse con `422` en la preparación. El backend MUST rechazar con `503` una preparación ausente/no soportada, inválida en forma/contexto o no verificable, sin escribir DB y sin fallback sin pin; la versión solicitada inexistente es el caso `422` ya descrito.

#### Scenario: Redeploy entre preparación y ejecución

- **WHEN** el backend prepara un snapshot con una huella y el runtime ML cambia de modelo, parámetros o backend antes de ejecutar el job
- **THEN** el ML detecta el mismatch antes de descargar/segmentar y termina el job como fallo seguro
- **AND** no produce un resultado con el contexto nuevo que contradiga el snapshot persistido.

#### Scenario: Versión solicitada inexistente

- **WHEN** la request pide un `modelVersion` no nulo distinto de la versión efectiva del manifiesto
- **THEN** la preparación responde `422` seguro antes de cargar modelos o escribir DB
- **AND** el backend no crea snapshot ni ejecución.

#### Scenario: ML antiguo sin endpoint de preparación

- **WHEN** el backend llama a preparar y el ML responde `404` o no soporta el contrato
- **THEN** el backend responde `503` seguro
- **AND** no crea snapshot/ejecución y no degrada a un job sin pin.

#### Scenario: Legacy sin pin

- **WHEN** llega un request ML legacy sin `expected_context`
- **THEN** el ML lo acepta y lo ejecuta con el runtime actual
- **AND** no inventa un pin ni exige al cliente un contexto que nunca recibió.

### Requirement: Creación transaccional de ejecución contextualizada

El sistema SHALL crear el snapshot clínico y la ejecución `QUEUED` en una única transacción de base de datos, con identificador de ejecución generado por el servidor, consulta y ojo autoritativos, snapshot enlazado, `reanalysisOf` opcional y estado `QUEUED`. La creación MUST releer imagen y padre bajo locks deterministas antes de insertar, siguiendo los triggers de integridad, para no confiar en una lectura de ownership previa (sin TOCTOU). Un fallo SQL MUST dejar rollback completo, sin snapshot huérfano. La creación MUST NOT modificar `consultation.status` ni reabrir/alterar una consulta cerrada. Un fallo posterior al commit al firmar URL o encolar MUST quedar como pendiente explícito de reconciliación (4.6), sin presentar el trabajo como aceptado ni prometer atomicidad Redis/outbox.

#### Scenario: Creación válida en una TX

- **WHEN** la imagen pertenece al médico, el ojo coincide y la preparación ML es válida
- **THEN** el snapshot y la ejecución `QUEUED` se confirman en la misma transacción
- **AND** la respuesta conserva el `202 { inferenceId, jobId, status: "QUEUED" }` del contrato actual.

#### Scenario: Fallo del insert

- **WHEN** falla la creación de la ejecución después de preparar el snapshot
- **THEN** la transacción revierte y no queda ningún snapshot huérfano
- **AND** no se encola ni se responde `202`.

#### Scenario: Consulta cerrada o congelada

- **WHEN** se crea una ejecución o un reanálisis sobre una consulta cerrada/congelada
- **THEN** la creación no modifica `consultation.status`, `requiredExecutionIds` ni `requiredSetVersion`
- **AND** la nueva ejecución queda fuera de la selección congelada; 2.2 no la promueve ni reabre la consulta.

#### Scenario: Fallo post-commit de storage o cola

- **WHEN** el snapshot/ejecución ya se confirmaron pero falla la firma de URL o el encolado
- **THEN** el sistema responde `503` seguro y deja el estado pendiente explícito para 4.6
- **AND** no responde un `202` falso ni promete atomicidad Redis/outbox.

### Requirement: Sin mutación ni autocompletado del estado de consulta

El sistema SHALL tratar el estado de ejecución como independiente del estado agregado de consulta. Ni la creación ni el worker MUST actualizar `consultation.status` a `COMPLETED` ni a ningún otro valor por el hecho de que un job termine. La consulta MUST NOT autocompletarse para ningún job, incluido legacy, hasta que exista el agregador de 2.3 y la evidencia/PDF obligatoria de 6.x. `REVIEW_REQUIRED` MUST conservarse como terminal de espera y MUST NOT convertirse en `COMPLETED`. La corrección MUST eliminar el autocompletado actual, no conservar un shim legacy que perpetúe la regresión.

#### Scenario: Job individual completa

- **WHEN** un job ML termina con `COMPLETED`
- **THEN** la ejecución persiste su estado/resultado
- **AND** la consulta no cambia a `COMPLETED` por ese job.

#### Scenario: Revisión requerida

- **WHEN** un job termina con `REVIEW_REQUIRED`
- **THEN** la ejecución conserva `REVIEW_REQUIRED` y su resultado parcial disponible
- **AND** la consulta no se marca completa ni se autoaprueba.

#### Scenario: Job legacy

- **WHEN** un job sin contexto/pin termina
- **THEN** tampoco actualiza el estado agregado de la consulta
- **AND** el sistema no reintroduce el comportamiento de autocompletado como compatibilidad.
