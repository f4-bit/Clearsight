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

El sistema SHALL persistir cada artefacto binario disponible (`mask`, `overlay`, `pdf`, `gradcam`, `shap`) mediante una referencia estructurada única `ArtifactRef` con los campos `artifactType`, `status`, `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes`, `checksumSha256`, `failureCode`, `retryable` y `updatedAt`. El catálogo lógico de tipos incluye `result` por separado para el `ExecutionResult` inline existente; `result` MUST NOT tener objeto de storage ni un `ArtifactRef` con ubicación. El identificador de almacenamiento lógico MUST resolver provider, cuenta y endpoints desde configuración confiable del backend. La key MUST conservarse exactamente como fue producida, sin normalización que cambie el objeto. La forma de referencia MUST ser la misma en el contrato de frontend y en el diseño; todos los campos MUST ser explícitos, los no aplicables `null` salvo `retryable`, que MUST ser booleano (`false` si no aplica). Solo `AVAILABLE` MUST tener `storageId`, `bucketOrContainer`, `key`, `contentType`, `sizeBytes` y `checksumSha256` válidos; `updatedAt` MUST ser ISO válido en todos los estados y `sizeBytes` MUST ser un entero seguro `>= 0` (un bigint mayor que `Number.MAX_SAFE_INTEGER` se rechaza, no se redondea), el checksum MUST ser hex de 64 caracteres y un PDF `AVAILABLE` MUST usar `application/pdf`. En estados no `AVAILABLE`, los campos de storage/key/contentType/size/checksum MUST ser `NULL`; `FAILED` MUST tener `failureCode` válido de hasta 64 caracteres y `retryable` booleano, mientras que cualquier otro estado MUST tener `failureCode=null` y `retryable=false`. El mapper canónico MUST emitir `false` (no `null`) para `retryable`, MUST NOT inventar hash/tamaño ni un `AVAILABLE` sin metadata, y una `ArtifactLocation` resuelta MUST distinguirse de un `ArtifactRef` completo: el parser no fabrica una referencia `AVAILABLE` legacy sin checksum ni tipo.

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

#### Scenario: Resultado inline no es artefacto de storage

- **WHEN** se representa el `result` de una ejecución
- **THEN** se usa el `ExecutionResult` inline existente y no se crea un `ArtifactRef` con `storageId`/`key`
- **AND** el catálogo de tipos sigue incluyendo `result` solo de forma lógica, sin objeto de storage.

### Requirement: Abstracción de almacenamiento dual y firma por provider

El sistema SHALL implementar una abstracción de almacenamiento tanto en backend como en ML para Azure Blob y MinIO/S3. El backend SHALL seleccionar el provider con `STORAGE_PROVIDER`: `minio` MUST ser el default retrocompatible y `azure` MUST ser explícito; cualquier otro valor MUST rechazarse fail closed con error seguro. `StorageService` MUST preservar sus firmas públicas y el export `s3Client` actuales, delegando en un `StorageProvider` interno (`ensure`, `upload`, `sign`, `read`, `exists`) resuelto por configuración confiable e inyección de dependencias. La construcción de la fachada MUST NOT abrir red ni exigir credenciales del proveedor; unit tests MUST poder construir el default MinIO sin configuración Azure.

Azure Blob MUST usar el SDK oficial `@azure/storage-blob` con `SharedKeyCredential`; MUST NOT implementar firma SAS casera ni criptografía propia. La configuración Azure MUST ser explícita con URL HTTPS de cuenta, nombre de cuenta y clave; si falta, es inválida, no es HTTPS o no es coherente con `AzureCloud`, el sistema MUST fallar de forma segura y MUST NOT caer a MinIO. Azure `ensure` MUST comprobar solo la existencia del contenedor y MUST NOT crearlo. Azure `upload` MUST validar un `contentType` no vacío y bien formado antes de I/O, y MUST verificar tras la subida la longitud y el `contentType` con `getProperties`; un mismatch post-upload MUST NOT borrar el objeto (la reconciliación es 3.5). Azure `sign` MUST verificar la existencia del objeto antes de firmar y MUST NOT interpretar un error de permisos o de red como objeto ausente. El SAS de Azure MUST ser por objeto, con permisos read-only (`p=r` como abreviatura; el SDK oficial emite `sp=r`), `sr=b`, `spr=https` y expiración acotada; MUST NOT conceder otros permisos ni emitirse a nivel de contenedor.

MinIO MUST conservar el endpoint interno y el endpoint distinto de `ML_PUBLIC_HOST` con sus puertos. MinIO `ensure` MUST crear el bucket solo ante `404`/not found, MUST aceptar `AlreadyOwnedByYou` en creación concurrente y MUST NOT absorber un `BucketAlreadyExists` de un bucket ajeno; otros errores de permisos o red MUST propagarse de forma segura. MinIO `upload` MUST validar `contentType` antes de I/O y verificar longitud y tipo con `HeadObject`; un mismatch post-upload MUST NOT borrar el objeto. MinIO `read` MUST devolver un `Readable`. `MINIO_SECURE` MUST aceptar solo booleanos reales o los strings exactos `true`/`false`; otros valores MUST fallar cerrado sin coerción silenciosa. Ningún provider MUST registrar signed URLs, credenciales, claves ni parámetros de firma.

Las keys de objeto MUST conservarse exactamente, incluyendo espacios, `%`, Unicode y barras, sin normalización de filesystem ni `decodeURI`. Si una key no puede enviarse exactamente por el SDK (por ejemplo, segmentos completos `.` o `..`), el sistema MUST rechazarla explícitamente en vez de normalizarla en silencio. Bucket, contenedor, host y endpoint MUST provenir solo de configuración interna confiable, nunca de input HTTP. La allowlist obligatoria de referencias no forma parte de esta tarea; llega con 3.3.

El TTL de firma MUST ser configurable como entero en 1..3600 s con default 3600 s; el valor configurado es default, no cap, y un override explícito del caller MUST poder llegar hasta 3600 aunque el default sea menor. Los callers legacy MUST conservar 3600 s. La adopción de 300 s queda para 3.4/4.8 y MUST NOT prometerse en 3.2. `storageId` MUST resolverse por configuración local (`minio-local` para MinIO y `azure-blob-default` para Azure) sin cambio de esquema de DB. Azure y MinIO MUST NOT tratarse como casos especiales del otro ni asumir que `ensure_buckets` de MinIO aplica a Azure. Managed Identity queda fuera de 3.2 y anotada para 8.x.

#### Scenario: Provider MinIO por defecto

- **WHEN** no se configura `STORAGE_PROVIDER` o vale `minio`
- **THEN** el backend usa MinIO/S3, conserva las firmas públicas y `s3Client`, y mantiene el comportamiento local actual
- **AND** `ensure` solo crea el bucket ante `404`/not found y propaga otros errores de forma segura.

#### Scenario: Provider Azure explícito

- **WHEN** el storage configurado es Azure Blob con URL HTTPS, nombre y clave coherentes
- **THEN** el backend usa la abstracción Azure con el SDK oficial y verifica existencia/upload, mientras ML conserva su abstracción Azure existente (3.1)
- **AND** firman un SAS por objeto read-only (`sp=r` en el wire oficial; `p=r` abreviatura de D22), `sr=b`, `spr=https` y expiración acotada
- **AND** `ensure` no crea contenedores y `sign` comprueba que el objeto existe.

#### Scenario: Provider desconocido o Azure inválido

- **WHEN** `STORAGE_PROVIDER` no es `minio`/`azure` o la configuración Azure es inválida
- **THEN** el sistema falla de forma segura y no intenta firmar, leer ni descargar
- **AND** no cae a MinIO ni abre una conexión de red para decidir el provider.

#### Scenario: Upload Azure con objeto o metadatos inconsistentes

- **WHEN** Azure sube un objeto y `getProperties` no coincide en longitud o `contentType`, o el objeto no existe
- **THEN** la operación falla de forma segura
- **AND** no se devuelve una URL ficticia ni se declara el artefacto disponible
- **AND** no se borra el objeto; la reconciliación/limpieza posterior pertenece a 3.5.

#### Scenario: Firma sobre objeto ausente o sin permisos

- **WHEN** se intenta firmar una key cuyo objeto no existe
- **THEN** el sistema reporta el objeto ausente sin inventar una URL
- **AND** un error de permisos o de red se propaga como error seguro, no como `404` falso.

#### Scenario: Key exacta o rechazo explícito

- **WHEN** la key contiene espacios, `%`, Unicode, barras o una representación no soportada por el SDK
- **THEN** el sistema conserva la key exacta o la rechaza explícitamente si no puede enviarla sin normalizar
- **AND** no la convierte a ruta de filesystem, no la decodifica y no la normaliza en silencio.

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

El sistema SHALL disponer de un parser central puro (`backend/src/services/artifact-reference.ts`) para ubicaciones de artefacto. El parser MUST aceptar un `string` legacy o una ubicación estructurada `{ storageId, bucketOrContainer, key }`, junto con un contexto confiable `{ provider, storageId, allowedBuckets, defaultBucket }`. El parser MUST NOT usar SDK, red, filesystem ni variables de entorno globales. El `storageId` estructurado MUST coincidir con el `storageId` y provider activos; un provider, `storageId` o contenedor desconocido MUST rechazarse fail closed antes de firmar. En producción MUST usarse solo el provider activo, sin registry cross-provider ni fallback de red; una referencia cross-provider legacy MUST rechazarse hasta una migración explícita de operador.

El parser MUST validar exactamente los esquemas `s3://bucket/key` y `azure://container/key`; el esquema es case-insensitive solo para `s3`/`azure`. El primer `/` tras `://` MUST separar bucket/container del resto, que es la key exacta. MUST NOT usar `new URL()`, `path.normalize`, `trim` de la key ni `decodeURI`/percent-decoding. Esquemas/URLs externos (`file://`, `http://`, `https://`, `blob:` u otro desconocido), credenciales, autoridad, host/puerto y query SAS MUST rechazarse. La key MUST conservar literalmente espacios, Unicode, `%`, `?`, `#` y `&`, y MUST rechazar blank/whitespace-only, NUL/controles, segmentos completos `.`/`..` que el SDK no pueda representar, un comienzo de URI genérica `^[A-Za-z][A-Za-z0-9+.-]*:` (incluidos `blob:`/`file:`/`data:` sin `//`) y el patrón de firma `(^|[?&])(sig|x-amz-signature|x-amz-credential|x-amz-security-token)=` case-insensitive. El `://` no inicial MUST preservarse como texto de key (`folder/http://literal.bin`). El parser y el DTO MUST compartir esta política pura (`backend/src/lib/artifact-key.ts`). Una referencia rechazada MUST NOT ecoarse completa en errores ni logs.

Una cadena sin esquema MUST interpretarse de forma determinista sin consultar la red: si el primer segmento es un bucket/contenedor allowlisted, se usa como bucket/container y el resto como key exacta; en caso contrario, la cadena entera es key y MUST requerir un `defaultBucket` trusted y allowlisted. La precedencia `bucket/key` MUST ser fija, por lo que un caller con una key que empiece por un nombre de bucket MUST usar la ubicación estructurada con la key entera; no se promete reconstrucción universal de bare legacy.

`STORAGE_ALLOWED_BUCKETS` MUST ser un CSV opcional del provider activo, leído solo de configuración confiable. Ausente ⇒ defaults `MINIO_BUCKET_RAW` y `MINIO_BUCKET_GRADCAM`. Explícito no vacío ⇒ validado y deduplicado, con el default incluido cuando ese contexto se use. Explícito vacío o lista vacía ⇒ fail closed; MUST NOT existir “allow all”. No se añaden buckets/contenedores ajenos automáticamente. Los defaults de imagen y Grad-CAM son `MINIO_BUCKET_RAW` y `MINIO_BUCKET_GRADCAM`, también en Azure como contenedores lógicos legacy de la configuración actual.

#### Scenario: Referencia legacy de Azure

- **WHEN** el sistema lee `azure://mask-bucket/inference-id/mask.png`
- **THEN** el parser resuelve container `mask-bucket` y key `inference-id/mask.png`
- **AND** valida que la ubicación esté allowlisted antes de firmar.

#### Scenario: Referencia bare legacy con default

- **WHEN** el sistema recibe una bare string cuyo primer segmento no es un bucket allowlisted
- **THEN** interpreta la cadena entera como key y exige un `defaultBucket` trusted allowlisted
- **AND** no consulta la red ni recorta la key.

#### Scenario: Esquema desconocido

- **WHEN** el sistema recibe una referencia con esquema distinto de los soportados, con autoridad/credenciales o con query SAS
- **THEN** la rechaza con un error seguro
- **AND** no intenta descargarla como URL libre ni llama al SDK o a la red.

#### Scenario: Allowlist vacía o contenedor no permitido

- **WHEN** `STORAGE_ALLOWED_BUCKETS` está explícitamente vacío o el bucket/contenedor no pertenece a la allowlist
- **THEN** el parser falla cerrado sin “allow all”
- **AND** no firma, no lee y no usa un default fuera de la lista.

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
