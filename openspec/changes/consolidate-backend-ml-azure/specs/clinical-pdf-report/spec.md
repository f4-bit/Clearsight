# Clinical PDF Report — Delta Specification

## ADDED Requirements

### Requirement: PDF básico obligatorio para completitud

El sistema SHALL generar un PDF básico para cada ejecución requerida antes de declarar completitud. El PDF MUST incluir identificación pseudónima de caso, consulta y ojo; `inference_id`; versión del snapshot clínico; versiones de modelo; información clínica con unidades solo cuando el mapeo esté verificado; probabilidades por clase; calidad; CDR; **imagen original sanitizada almacenada, `mask` y `overlay` embebidas** para una ruta exitosa normal; fecha de análisis; fecha de generación; warnings y aviso de que es apoyo a investigación y no sustituye el criterio médico. La “imagen original” MUST ser la fotografía sanitizada almacenada, sin conservar el EXIF del upload original. En una ruta exitosa normal MUST NOT usarse una referencia o enlace como reemplazo visual de las imágenes embebidas. La ausencia del PDF o de una imagen obligatoria MUST impedir la completitud de la ejecución requerida. El renderer SHALL ser puro (sin escrituras a DB/storage) y recibir un input acotado con el resultado de la inferencia, el snapshot, `Image.storagePath`, los buffers/imágenes y `reportId`/`version`; la imagen original MUST recodificarse de forma defensiva sin EXIF y `mask`/`overlay` MUST resolverse desde `Inference.artifacts` (URI `s3://`/`azure://` o key) y MUST NOT usar `gradcamPath`. La falta de un artefacto obligatorio en una ruta normal MUST producir un error tipado y MUST NOT generar un PDF “completo” ni sustituir la imagen por enlaces.

#### Scenario: Ejecución completa con PDF

- **WHEN** una ejecución requerida tiene resultado válido, evidencia obligatoria e imagen original sanitizada
- **THEN** el sistema genera el PDF básico con original, `mask` y `overlay` embebidas
- **AND** solo entonces cuenta la ejecución como completa.

#### Scenario: Falta imagen original o artefacto en éxito normal

- **WHEN** falta la imagen original sanitizada, `mask` u `overlay` en una ruta exitosa normal
- **THEN** la ejecución no alcanza completitud
- **AND** el PDF no sustituye la imagen por una referencia o enlace
- **AND** el renderer devuelve un error tipado en lugar de un PDF parcial presentado como completo.

#### Scenario: PDF ausente

- **WHEN** una ejecución requerida no tiene PDF generado
- **THEN** la ejecución no alcanza completitud
- **AND** el estado del PDF se informa de forma explícita.

### Requirement: Contenido clínico y trazabilidad del PDF

El PDF SHALL mostrar las probabilidades de las clases canónicas, la clase predicha con su índice, el CDR con su tipo, la calidad y las advertencias aplicables. MUST indicar `snapshot.schemaVersion`, `snapshot.modelVersions`, `result.modelVersions`/`modelPredictions`, `reportId`/`version` y la fecha del análisis. MUST diferenciar `cdr` de `cdrVertical` y etiquetar cada valor por su tipo. Las 11 features de `snapshot.rawPayload` MUST mostrarse marcadas como “no interpretables” mientras no exista codebook backend verificado. MUST diferenciar CDR calculado por el sistema de cualquier valor clínico externo. Las unidades, categorías y codebooks clínicos MUST mostrarse solo cuando su mapeo esté verificado; si no, el PDF MUST marcar el campo como no interpretable y MUST NOT inventar una codificación médica legacy.

#### Scenario: Reporte con CDR y probabilidades

- **WHEN** se genera el PDF de una ejecución completada
- **THEN** muestra CDR, calidad, clase predicha y probabilidades con unidades y etiquetas claras
- **AND** identifica la versión de snapshot y modelos usados.

#### Scenario: Calidad baja

- **WHEN** la calidad de segmentación es baja pero la ejecución no está en revisión
- **THEN** el PDF incluye un warning visible
- **AND** no oculta la limitación en notas menores.

#### Scenario: Features sin codebook

- **WHEN** el snapshot contiene features clínicas sin codebook backend verificado
- **THEN** el PDF las muestra como “no interpretables”
- **AND** no inventa unidades, categorías ni rangos clínicos.

### Requirement: Prohibición de secretos, URLs temporales y diagnóstico validado

El PDF MUST NOT incluir secretos, tokens, SAS, presigned URLs, credenciales ni enlaces temporales, keys de storage ni rutas locales. El PDF MUST usar IDs pseudónimos de consulta/inferencia y MUST NOT incluir PHI identificatoria como `Patient.externalCode`. `PdfReport.renderingInputs` MUST NOT contener esquemas URI (`://`) ni parámetros de firma; solo IDs, versión y tipos. El PDF MUST NOT afirmar que existe un diagnóstico médico validado cuando solo contiene una inferencia del modelo. Las imágenes embebidas MUST estar autorizadas y MUST corresponder a artefactos de la ejecución.

#### Scenario: PDF sin URLs firmadas

- **WHEN** se inspecciona el PDF generado
- **THEN** no contiene URLs firmadas, tokens ni credenciales
- **AND** las imágenes embebidas provienen de artefactos autorizados.

#### Scenario: Lenguaje de resultado

- **WHEN** el PDF presenta el resultado del modelo
- **THEN** lo identifica como inferencia de apoyo
- **AND** no lo presenta como diagnóstico médico validado.

### Requirement: Idempotencia y versionado del reporte

El sistema SHALL generar el PDF de forma idempotente usando el mismo `inference_id`, snapshot inmutable y versión de datos. `PdfReport.sourceSnapshotId` MUST ser el snapshot de la inferencia y MUST ser obligatorio para publicar `AVAILABLE`; un snapshot legacy `null` MUST NOT publicar `AVAILABLE`. El PDF y su `ArtifactRecord` MUST compartir inferencia y versión, con `reportId`/`version` explícitos y `status` `PENDING`→`AVAILABLE`. Reintentar la generación MUST NOT reinferir ni alterar el resultado y SHALL reutilizar la misma fila/versión; un feedback posterior, una explicación nueva o un cambio aprobado de contenido MUST generar una nueva versión del reporte sin pisar la anterior ni recalcular silenciosamente. La descarga MUST reutilizar la URL versionada de artefactos de 3.4, sin duplicar la firma. Un fallo transitorio antes de renderizar SHALL registrarse `FAILED` con un `dataVersion` de contenido pendiente (no un hash final) y ser visible en `/reports` mediante el `ArtifactRecord` PDF vinculado. Un reintento reparado SHALL reutilizar la misma fila/versión, sustituir el marcador por el hash real y refrescar `renderingInputs` con los checksums/tamaños reales y sin `failureCode` mientras el reporte sigue `PENDING`, y finalizar `AVAILABLE`; MUST NOT crear `version+1` por un fallo transitorio. Un fallo no retryable o un feedback nuevo SHALL crear una versión nueva. Un reanálisis SHALL generar su propio PDF independiente y vinculado a la ejecución anterior; MUST NOT sobrescribir el PDF de la ejecución previa.

#### Scenario: Reintento de PDF

- **WHEN** se reintenta generar el PDF de una ejecución sin cambios de datos
- **THEN** el sistema produce el mismo reporte o reutiliza el existente de forma idempotente
- **AND** no vuelve a ejecutar la inferencia.

#### Scenario: Reintento tras fallo transitorio pre-render

- **WHEN** la publicación falla de forma retryable antes de renderizar (p. ej. falta temporal de mask/overlay en storage)
- **THEN** el reporte queda `FAILED` visible en `/reports` con su artifact PDF vinculado y un `dataVersion` de contenido pendiente
- **AND** al repararse y reintentar, se reutiliza el mismo `reportId`/`version`, se fija el hash real de contenido y el reporte queda `AVAILABLE`
- **AND** no se crea una versión nueva por el reintento transitorio.

#### Scenario: Feedback posterior

- **WHEN** se registra feedback clínico después de generar el PDF
- **THEN** el sistema puede generar una nueva versión del reporte
- **AND** conserva la versión anterior y su trazabilidad.

#### Scenario: Reanálisis con PDF independiente

- **WHEN** se ejecuta un reanálisis de una ejecución existente
- **THEN** el sistema genera un PDF independiente para la nueva ejecución
- **AND** no sobrescribe ni reinterpreta el PDF de la ejecución anterior.

### Requirement: Reporte de revisión con limitación explícita

El PDF de una ejecución en `REVIEW_REQUIRED` SHALL mostrar la limitación y el estado de revisión. MUST NOT declarar la ejecución o la consulta como completada. MUST indicar qué evidencia es parcial y qué imagen o artefacto falta, incluyendo la ausencia de original sanitizada, `mask` u `overlay` cuando aplique. El reporte de revisión MAY ser parcial y documentar la falta; MUST NOT presentarse como completitud normal. La resolución B1 es un reanálisis con PDF independiente; el PDF de revisión MUST NOT convertirse en completitud por acción del médico ni por la existencia del PDF.

#### Scenario: PDF de ejecución en revisión

- **WHEN** se genera un PDF para una ejecución `REVIEW_REQUIRED`
- **THEN** el PDF indica revisión pendiente y evidencia parcial
- **AND** no presenta el caso como completo ni aprobado.

#### Scenario: Explicabilidad ausente

- **WHEN** el PDF básico se genera antes de la entrega de Grad-CAM/SHAP
- **THEN** indica que esas visualizaciones no están incluidas
- **AND** no incluye imágenes de explicabilidad simuladas.

### Requirement: Criterio medible de generación institucional (HU08)

El sistema SHALL exponer una medición reproducible del tiempo de generación del PDF institucional, con encabezado, numeración y plantilla, para verificar el criterio SRS de hasta 15 segundos. El sistema MUST NOT afirmar cumplimiento de ese criterio sin una medición registrada en el entorno y con el volumen declarados.

#### Scenario: Medición de generación

- **WHEN** se ejecuta la prueba de medición del PDF institucional
- **THEN** el PDF generado incluye encabezado y numeración institucional
- **AND** se registra el tiempo observado, el entorno y el volumen
- **AND** el resultado se compara con el criterio de 15 segundos sin declarar cumplimiento anticipado.
