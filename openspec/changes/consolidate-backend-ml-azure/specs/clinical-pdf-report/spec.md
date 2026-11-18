# Clinical PDF Report — Delta Specification

## ADDED Requirements

### Requirement: PDF básico obligatorio para completitud

El sistema SHALL generar un PDF básico para cada ejecución requerida antes de declarar completitud. El PDF MUST incluir identificación pseudónima de caso, consulta y ojo; `inference_id`; versión del snapshot clínico; versiones de modelo; información clínica con unidades solo cuando el mapeo esté verificado; probabilidades por clase; calidad; CDR; **imagen original sanitizada almacenada, `mask` y `overlay` embebidas** para una ruta exitosa normal; fecha de análisis; fecha de generación; warnings y aviso de que es apoyo a investigación y no sustituye el criterio médico. La “imagen original” MUST ser la fotografía sanitizada almacenada, sin conservar el EXIF del upload original. En una ruta exitosa normal MUST NOT usarse una referencia o enlace como reemplazo visual de las imágenes embebidas. La ausencia del PDF o de una imagen obligatoria MUST impedir la completitud de la ejecución requerida.

#### Scenario: Ejecución completa con PDF

- **WHEN** una ejecución requerida tiene resultado válido, evidencia obligatoria e imagen original sanitizada
- **THEN** el sistema genera el PDF básico con original, `mask` y `overlay` embebidas
- **AND** solo entonces cuenta la ejecución como completa.

#### Scenario: Falta imagen original o artefacto en éxito normal

- **WHEN** falta la imagen original sanitizada, `mask` u `overlay` en una ruta exitosa normal
- **THEN** la ejecución no alcanza completitud
- **AND** el PDF no sustituye la imagen por una referencia o enlace.

#### Scenario: PDF ausente

- **WHEN** una ejecución requerida no tiene PDF generado
- **THEN** la ejecución no alcanza completitud
- **AND** el estado del PDF se informa de forma explícita.

### Requirement: Contenido clínico y trazabilidad del PDF

El PDF SHALL mostrar las probabilidades de las clases canónicas, la clase predicha con su índice, el CDR con su tipo, la calidad y las advertencias aplicables. MUST indicar la versión del snapshot, las revisiones de modelo y la fecha del análisis. MUST diferenciar CDR calculado por el sistema de cualquier valor clínico externo. Las unidades, categorías y codebooks clínicos MUST mostrarse solo cuando su mapeo esté verificado; si no, el PDF MUST marcar el campo como no interpretable y MUST NOT inventar una codificación médica legacy.

#### Scenario: Reporte con CDR y probabilidades

- **WHEN** se genera el PDF de una ejecución completada
- **THEN** muestra CDR, calidad, clase predicha y probabilidades con unidades y etiquetas claras
- **AND** identifica la versión de snapshot y modelos usados.

#### Scenario: Calidad baja

- **WHEN** la calidad de segmentación es baja pero la ejecución no está en revisión
- **THEN** el PDF incluye un warning visible
- **AND** no oculta la limitación en notas menores.

### Requirement: Prohibición de secretos, URLs temporales y diagnóstico validado

El PDF MUST NOT incluir secretos, tokens, SAS, presigned URLs, credenciales ni enlaces temporales. El PDF MUST NOT afirmar que existe un diagnóstico médico validado cuando solo contiene una inferencia del modelo. Las imágenes embebidas MUST estar autorizadas y MUST corresponder a artefactos de la ejecución.

#### Scenario: PDF sin URLs firmadas

- **WHEN** se inspecciona el PDF generado
- **THEN** no contiene URLs firmadas, tokens ni credenciales
- **AND** las imágenes embebidas provienen de artefactos autorizados.

#### Scenario: Lenguaje de resultado

- **WHEN** el PDF presenta el resultado del modelo
- **THEN** lo identifica como inferencia de apoyo
- **AND** no lo presenta como diagnóstico médico validado.

### Requirement: Idempotencia y versionado del reporte

El sistema SHALL generar el PDF de forma idempotente usando el mismo `inference_id`, snapshot inmutable y versión de datos. Reintentar la generación MUST NOT reinferir ni alterar el resultado. Un feedback posterior, una explicación nueva o un cambio aprobado de contenido MUST generar una nueva versión del reporte sin pisar la anterior ni recalcular silenciosamente.

#### Scenario: Reintento de PDF

- **WHEN** se reintenta generar el PDF de una ejecución sin cambios de datos
- **THEN** el sistema produce el mismo reporte o reutiliza el existente de forma idempotente
- **AND** no vuelve a ejecutar la inferencia.

#### Scenario: Feedback posterior

- **WHEN** se registra feedback clínico después de generar el PDF
- **THEN** el sistema puede generar una nueva versión del reporte
- **AND** conserva la versión anterior y su trazabilidad.

### Requirement: Reporte de revisión con limitación explícita

El PDF de una ejecución en `REVIEW_REQUIRED` SHALL mostrar la limitación y el estado de revisión. MUST NOT declarar la ejecución o la consulta como completada. MUST indicar qué evidencia es parcial y qué imagen o artefacto falta, incluyendo la ausencia de original sanitizada, `mask` u `overlay` cuando aplique. El reporte de revisión MAY ser parcial y documentar la falta; MUST NOT presentarse como completitud normal.

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
