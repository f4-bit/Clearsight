# Artifact Evidence — Delta Specification

## ADDED Requirements

### Requirement: Catálogo de artefactos y obligatoriedad por ruta

El sistema SHALL distinguir los artefactos `result`, `mask`, `overlay`, `pdf`, `gradcam` y `shap`. Para una ruta exitosa normal en la que el pipeline produce segmentación, los artefactos `mask`, `overlay`, `result` y PDF básico MUST considerarse obligatorios. La ausencia de un artefacto obligatorio MUST impedir la completitud normal de la ejecución requerida. `gradcam` y `shap` MUST ser entregables diferidos y MUST NOT bloquear la completitud inicial.

#### Scenario: Ruta exitosa con artefactos obligatorios

- **WHEN** el pipeline produce segmentación, clasificación y resultado
- **THEN** la ejecución publica `mask`, `overlay` y `result`
- **AND** el PDF básico se genera antes de declarar la ejecución requerida como completa.

#### Scenario: Fallo de artefacto obligatorio

- **WHEN** la publicación de `mask`, `overlay`, `result` o PDF falla en una ruta exitosa normal
- **THEN** la ejecución no alcanza completitud normal
- **AND** registra el estado `FAILED` del artefacto con causa segura y si es reintentable.

### Requirement: Estado explícito por artefacto

El sistema SHALL exponer, para cada artefacto, uno de estos estados: `NOT_SUPPORTED`, `NOT_REQUESTED`, `PENDING`, `AVAILABLE` o `FAILED`. Todo estado distinto de `AVAILABLE` MUST explicar la ausencia. `FAILED` MUST incluir una causa segura, un indicador de reintentabilidad y MUST NOT devolver enlaces ficticios. `NOT_SUPPORTED` MUST usarse cuando la capacidad no existe todavía, no cuando existe pero falló.

#### Scenario: Artefacto no soportado

- **WHEN** el cliente consulta Grad-CAM antes de su entrega diferida
- **THEN** el sistema responde que el artefacto está `NOT_SUPPORTED`
- **AND** no devuelve una URL ni un estado `AVAILABLE` simulado.

#### Scenario: Artefacto fallido reintentable

- **WHEN** falla temporalmente la publicación de `overlay`
- **THEN** el estado del artefacto es `FAILED` con `retryable = true`
- **AND** el cliente no recibe una URL hasta que exista el objeto.

#### Scenario: Artefacto no solicitado

- **WHEN** una ejecución no solicita un artefacto opcional
- **THEN** su estado es `NOT_REQUESTED`
- **AND** la ausencia se informa de forma explícita sin tratarla como fallo.

### Requirement: Referencia de artefacto estructurada y estable

El sistema SHALL persistir cada artefacto disponible mediante una referencia estructurada única con los campos `artifactType`, `status`, `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes`, `checksumSha256`, `failureCode` y `retryable`. El identificador de almacenamiento lógico MUST resolver provider, cuenta y endpoints desde configuración confiable del backend. La key MUST conservarse exactamente como fue producida, sin normalización que cambie el objeto. La forma de referencia MUST ser la misma en el contrato de frontend y en el diseño; los campos no aplicables MUST ser `null` explícitos y solo `AVAILABLE` MUST tener `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes` y checksum.

#### Scenario: Artefacto disponible con referencia completa

- **WHEN** el ML publica `mask` en un almacenamiento configurado
- **THEN** el sistema persiste `artifactType`, `status`, storage lógico, container, key exacta, `contentType`, tamaño y checksum
- **AND** no persiste una URL firmada como identidad del artefacto.

#### Scenario: Artefacto no disponible

- **WHEN** un artefacto está `PENDING`, `FAILED`, `NOT_SUPPORTED` o `NOT_REQUESTED`
- **THEN** los campos de storage, key, contentType, tamaño y checksum son `null`
- **AND** `failureCode`/`retryable` explican la ausencia cuando aplique.

#### Scenario: Key con caracteres especiales

- **WHEN** la key contiene barras, espacios o caracteres codificados
- **THEN** el sistema conserva la key exacta y la usa de forma segura al firmar o recuperar el objeto
- **AND** no la divide de forma ingenua ni la reescribe.

### Requirement: Abstracción de almacenamiento dual y firma por provider

El sistema SHALL implementar una abstracción de almacenamiento tanto en backend como en ML para Azure Blob y MinIO/S3. Azure Blob MUST usar SAS read-only sobre el objeto, HTTPS, TTL corto configurable, verificación de existencia y verificación de upload. MinIO MUST usar presign equivalente y `ensure` de buckets. El sistema MUST NOT tratar un provider como caso especial del otro ni asumir que `ensure_buckets` de MinIO aplica a Azure.

#### Scenario: Provider Azure

- **WHEN** el storage configurado es Azure Blob
- **THEN** backend y ML usan la abstracción Azure, verifican existencia/upload y firman SAS read-only HTTPS
- **AND** no invocan `ensure_buckets` de MinIO.

#### Scenario: Provider MinIO

- **WHEN** el storage configurado es MinIO
- **THEN** backend y ML usan presign y `ensure` de buckets
- **AND** conservan el comportamiento local actual.

#### Scenario: Provider desconocido

- **WHEN** la configuración de storage no corresponde a un provider soportado
- **THEN** el sistema rechaza la operación con un error seguro
- **AND** no intenta firmar ni descargar con supuestos implícitos.

### Requirement: Prohibición de persistir credenciales temporales y URLs arbitrarias

El sistema MUST NOT persistir SAS, presigned URLs, tokens de acceso, claves personales ni URLs externas arbitrarias en base de datos, logs, PDF, respuestas de historial o artefactos. Las URLs firmadas MUST generarse bajo demanda y MUST NOT almacenarse como parte de la referencia del artefacto.

#### Scenario: Intento de guardar una URL firmada

- **WHEN** un componente intenta persistir una URL con parámetros de firma como referencia de artefacto
- **THEN** el sistema rechaza la persistencia
- **AND** registra el intento de forma segura sin incluir la URL ni sus parámetros.

#### Scenario: Logs de descarga

- **WHEN** se registra una solicitud de descarga de artefacto
- **THEN** el log no incluye tokens, query de firma ni URL completa
- **AND** conserva solo identificadores y resultado de autorización.

### Requirement: Autorización y firma de descargas bajo demanda

El sistema SHALL autorizar cada descarga de artefacto contra la política de acceso vigente y firmar una URL nueva solo después de autorizar. El backend MUST ser el único emisor de URLs de descarga para el frontend. Si una URL expira, el frontend MUST solicitar una nueva; MUST NOT inferirla ni reconstruirla. La pérdida de permisos MUST impedir nuevas firmas, aun cuando una URL anterior siga vigente por su TTL.

#### Scenario: URL expirada

- **WHEN** el frontend usa una URL de artefacto cuyo TTL expiró
- **THEN** solicita una URL nueva al backend
- **AND** el backend vuelve a autorizar antes de firmar.

#### Scenario: Permisos perdidos

- **WHEN** un usuario perdió acceso al caso y solicita una nueva URL de artefacto
- **THEN** el backend deniega la nueva firma
- **AND** documenta que una URL anterior aún podría ser válida hasta su expiración.

#### Scenario: Objeto ausente

- **WHEN** la referencia existe en base de datos pero el objeto no está en el almacenamiento
- **THEN** el sistema marca una inconsistencia y un incidente
- **AND** no devuelve una URL ficticia ni un éxito vacío.

### Requirement: Compatibilidad de referencias legacy

El sistema SHALL disponer de un parser central para referencias legacy `s3://bucket/key` y `azure://container/key`. El parser MUST validar el esquema, separar el primer segmento como bucket o container y conservar la key completa. El sistema MUST aceptar solo ubicaciones allowlisted y MUST NOT interpretar una referencia como URL externa arbitraria. La compatibilidad y migración de datos antiguos MUST preservar la legibilidad de los clientes actuales.

#### Scenario: Referencia legacy de Azure

- **WHEN** el sistema lee `azure://mask-bucket/inference-id/mask.png`
- **THEN** el parser resuelve container `mask-bucket` y key `inference-id/mask.png`
- **AND** valida que la ubicación esté allowlisted antes de firmar.

#### Scenario: Esquema desconocido

- **WHEN** el sistema recibe una referencia con esquema distinto de los soportados
- **THEN** la rechaza con un error seguro
- **AND** no intenta descargarla como URL libre.

### Requirement: Reintento de publicación sin reinferir y consistencia con almacenamiento

El sistema SHALL permitir reintentar la publicación de artefactos o la generación de PDF sin reinferir cuando el resultado sea recuperable e inmutable. El sistema MUST reconciliar el estado entre almacenamiento y base de datos: si el upload tiene éxito y falla la persistencia, MUST registrar o limpiar el huérfano de forma controlada; si la base de datos referencia un objeto ausente, MUST marcarlo como inconsistencia. Las órdenes de borrado MUST afectar solo objetos creados por la propia ejecución y MUST NOT borrar objetos ajenos o compartidos. Si el almacenamiento no está disponible, el sistema MUST reintentar de forma acotada y MUST terminar en un estado explícito de fallo o pendiente, sin éxito silencioso.

#### Scenario: Upload correcto y fallo de persistencia

- **WHEN** el objeto se sube correctamente y falla la escritura en base de datos
- **THEN** el sistema registra un huérfano y ejecuta la reconciliación o limpieza controlada
- **AND** no declara el artefacto como disponible en base de datos.

#### Scenario: Almacenamiento no disponible

- **WHEN** el almacenamiento rechaza o no responde durante la publicación
- **THEN** el sistema reintenta de forma acotada
- **AND** si persiste el fallo, deja el artefacto en `FAILED` o pendiente con causa segura, sin declararlo disponible.

#### Scenario: Reintento de PDF sin reinferir

- **WHEN** la generación del PDF falla después de un resultado válido
- **THEN** el reintento usa el mismo resultado y snapshot
- **AND** no vuelve a ejecutar la inferencia.

#### Scenario: Orden de borrado acotada

- **WHEN** se limpia un artefacto huérfano de una ejecución
- **THEN** el sistema borra solo la key registrada para esa ejecución
- **AND** no borra prefijos, buckets completos ni objetos de otras ejecuciones.

### Requirement: Explicabilidad diferida explícita

El sistema SHALL tratar Grad-CAM y SHAP como requisitos SRS diferidos y entregables separados posteriores. Hasta su entrega, `gradcam` y `shap` MUST reportarse como `NOT_SUPPORTED` o `NOT_REQUESTED` según el caso, MUST NOT incluirse como disponibles en el PDF básico y MUST NOT simularse con imágenes o datos ficticios.

#### Scenario: PDF básico sin explicabilidad

- **WHEN** se genera el PDF básico antes de la entrega de Grad-CAM/SHAP
- **THEN** el PDF indica explícitamente que esas visualizaciones no están incluidas
- **AND** no incorpora mapas de calor ni atribuciones simuladas.
