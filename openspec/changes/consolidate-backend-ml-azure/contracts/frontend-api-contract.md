# Contrato de API para Frontend — consolidate-backend-ml-azure

> **Naturaleza:** fuente de verdad documental, no evidencia de implementación. El documento separa **CURRENT VERIFIED** (lo que el código actual devuelve, leído de schemas/rutas) de **TARGET vNext** (diseño propuesto, con estado `proposed`, `deferred`, `blocked` o `removed`). Nada de TARGET debe consumirse como si ya existiera. El frontend no debe usar el alta pública actual para crear administradores ni asumir IDs/estados que el servidor no haya entregado.

## 1. Convenciones

| Tema | Contrato |
|---|---|
| Base local | `http://localhost:8080` |
| Auth | `Authorization: Bearer <accessToken>` salvo salud y login público controlado. |
| Content-Type | JSON `application/json`; upload de imagen `multipart/form-data` solo en el endpoint de imagen. |
| Fechas | ISO-8601 con zona horaria y tipo `string(date-time)`. |
| IDs | UUID v4, tipo `string(uuid)`. |
| Errores | Envelope `{ error: string, message: string, statusCode: number, issues?: array }`. |
| Idempotencia | `Idempotency-Key` **obligatoria** en `POST /inferences` y en cualquier alias de reanálisis. |
| Polling | 2 s inicial, techo 10 s, `Retry-After` si existe. El polling ML para en `jobTerminal`; el polling clínico para en `deliveryTerminal=true`, `pollingStop` terminal, auth/error o deadline/timeout global. |
| URLs de artefactos | Se solicitan al backend, TTL corto, nunca se persisten ni se reconstruyen en frontend. |
| Privacidad | No registrar tokens, URLs firmadas, PHI innecesaria ni datos de otros casos. |
| Versiones | CURRENT = contrato actual verificado; TARGET = vNext propuesto. |

### 1.1 Mapeo de nombres

La API clínica TARGET usa `camelCase`; el contrato ML usa `snake_case`. No se mezclan estilos en una misma API pública.

| CURRENT (snake/mixed) | TARGET clínico | ML |
|---|---|---|
| `consultation_id` | `consultationId` | `consultation_id` |
| `inference_id` | `inferenceId` | `inference_id` |
| `validated_class` | `validatedClass` | `validated_class` |
| `doctor_notes` | `doctorNotes` | `doctor_notes` |
| `is_gold_standard` | `isGoldStandard` | `is_gold_standard` |
| `predicted_class` | `predictedClass` | `predicted_class` |
| `created_at` | `createdAt` | `created_at` |
| `updated_at` | `updatedAt` | `updated_at` |
| `Phakic_Pseudophakic` | `Phakic/Pseudophakic` | `Phakic_Pseudophakic` (alias) |

### 1.2 Unidades y categorías clínicas

Se documentan las 11 variables (`Age`, `Gender`, `dioptre_1`, `dioptre_2`, `astigmatism`, `Phakic/Pseudophakic`, `Pneumatic`, `Perkins`, `Pachymetry`, `Axial_Length`, `VF_DM`). Las unidades, categorías y codebooks solo se muestran si su mapeo está verificado. Un mapeo no demostrado MUST marcarse como **no interpretable** y bloquea la interpretación clínica de esa etiqueta, no la totalidad del contrato.

### 1.3 Códigos HTTP

| Código | Uso |
|---|---|
| `200` | Lectura/actualización exitosa. |
| `201` | Recurso creado. |
| `202` | Trabajo aceptado; no implica resultado. |
| `400` | Solicitud malformada o archivo ilegible. |
| `401` | Token ausente/inválido/expirado o sesión revocada. |
| `403` | Rol, grant u ownership insuficiente. |
| `404` | Recurso inexistente o no visible. |
| `409` | Conflicto de idempotencia o recurso duplicado. |
| `410` | Endpoint actual retirado en TARGET. |
| `413` | Archivo excede el límite. |
| `422` | Validación de contrato fallida (incluye lateralidad contradictoria). |
| `429` | Rate limit o bloqueo temporal. |
| `500` | Error interno sin detalles sensibles. |
| `503` | Dependencia no disponible, posiblemente reintentable. |

## 2. CURRENT VERIFIED — contrato actual (leído del código)

> Esta sección describe el comportamiento actual aunque sea incompleto o inseguro. No es el contrato recomendado para nuevas integraciones.

| Método | Ruta | Auth actual | Request actual | Response actual | Limitaciones actuales |
|---|---|---|---|---|---|
| GET | `/health` | Público | — | `{ status: string, service: string, timestamp: ISO }` | Estable. |
| POST | `/auth/register` | Público | Cualquier JSON válido; sin validación de `role` (JSON malformado lo rechaza el parser HTTP con `400`) | `410 { error: "Gone", message: string, statusCode: 410 }` | **Retirado: no crea cuentas, no consulta la base y no emite token. El alta del primer admin es un CLI controlado (bootstrap), no un endpoint público.** |
| POST | `/auth/login` | Publico | `{ email: string(email), password: string }` | `200 { accessToken: string, tokenType: "bearer", expiresIn: string, user: { id: UUID, email: string, role } }` | Emite JWT HS256 de 900 s con `sessionId`/`tokenVersion`; persiste sesion durable de 7 d y auditoria. `401` uniforme y `503` si el store no esta disponible. |
| GET | `/auth/me` | Bearer | - | `{ id: UUID, email: string, role }` | Valida firma, claims, sesion durable, usuario activo, rol/version vigentes y expiracion; `401` y `503`. |
| POST | `/patients` | Bearer, rol OFTALMOLOGO/ADMIN | `{ externalCode?: string(<=64)\|null, age?: number(int 0..130)\|null, gender?: string(<=16)\|null, clinicalHistoryFlags?: object = {}, clinicalData?: object = {} }` | `201 { id: UUID, externalCode: string\|null, age: number\|null, gender: string\|null, clinicalHistoryFlags: object, clinicalData: object\|null, createdAt: ISO }` | Admin puede crear sin ownership clínico definido. |
| GET | `/patients` | Bearer (sin rol/ownership) | `limit?: number(1..100)=20`, `offset?: number(>=0)=0` | `200 Patient[]` | **No es un endpoint “Bearer only” seguro en TARGET; hoy lista sin ownership.** |
| GET | `/patients/:id` | Bearer | — | `200 Patient` | Sin ownership; hoy lectura clínica amplia. |
| POST | `/consultations` | Bearer, OFTALMOLOGO/ADMIN | `{ patientId: UUID, doctorId?: UUID, status?: JobStatus = "QUEUED", clinicalData?: object = {} }` | `201 { id: UUID, patientId: UUID, doctorId: UUID, status: string, clinicalData: object, createdAt: ISO }` | `doctorId` puede suplantarse; no hay `requiredExecutionIds`. |
| POST | `/consultations/:id/images` | Bearer, OFTALMOLOGO dueño/ADMIN | `multipart/form-data`: `file`, `eyeSide?: "OD"\|"OS" = "OD"` | `201 { id: UUID, consultationId: UUID, eyeSide: "OD"\|"OS", storagePath: string, hashMd5: string, createdAt: ISO }` | Límite actual API 50 MB y ML 25 MB; SRS pide JPEG/PNG >=512 px y <=20 MB. `hashMd5`, no SHA-256. |
| GET | `/consultations/:id` | Bearer | — | `200 { id, patientId, doctorId, status: string, clinicalData: object, createdAt: ISO, images: Image[] }` | Sin ownership y sin agregados `analysisState`/`reportState`; imagen con `hashMd5`. |
| POST | `/inferences` | Bearer, OFTALMOLOGO/ADMIN | `{ inferenceId?: UUID, imageId: UUID, imageUrl?: string(url), eyeSide: "OD"\|"OS", clinicalFeatures: 11 campos, modelVersion?: string\|null }` | `202 { inferenceId: UUID, jobId: string, status: "QUEUED" }` | **Sin `Idempotency-Key`, sin ownership de imagen, acepta `imageUrl` del cliente.** |
| GET | `/inferences/:id` | Bearer | — | `200 { id: UUID, imageId: UUID, predictedClass: number\|null, confidence: number\|null, probabilities: object, gradcamPath: string\|null, modelVersion: string\|null, createdAt: ISO }` | **No devuelve `status`, `stage`, artefactos ni estados de entrega.** |
| GET | `/inferences/:id/gradcam` | Bearer | — | `200 { url: string(url), expiresIn: number }` o `404` | Placeholder: depende de `gradcamPath`; el pipeline actual no publica Grad-CAM real. |
| POST | `/feedback` | Bearer, OFTALMOLOGO dueño | `{ consultation_id: UUID, inference_id: UUID, validated_class: 0\|1\|2\|null, doctor_notes?: string\|null, is_gold_standard?: boolean=false, doctor_id?: UUID, predicted_class?: 0\|1\|2\|null, confidence?: number\|null, agreement?: boolean\|null }` | `200 { id, consultation_id, inference_id, doctor_id, validated_class, predicted_class, confidence, agreement, doctor_notes, is_gold_standard, created_at, updated_at }` | El servidor deriva `predicted_class`, `confidence`, `agreement`; `validated_class:null` no puede ser gold. |
| GET | `/export/gold-standard` | Bearer, INVESTIGADOR/ADMIN | `format?: "json"\|"csv" = "json"`, `since?: ISO`, `limit?: number(1..50000)=5000` | JSON `{ count, has_more, generated_at, items[] }` o CSV; headers `x-has-more`, `cache-control: no-store` | **Sin grant explícito por conjunto; ADMIN tiene acceso clínico amplio actual.** |

## 3. TARGET vNext — endpoints propuestos

> Los estados `proposed`, `deferred`, `blocked` y `removed` no son implementación actual. El frontend debe tratar `removed` como no disponible y `blocked` como no implementable aún.

### 3.1 Autenticación y administración

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/auth/login` | proposed | Público con rate limit/HU01 | `{ email, password }` | `200 { accessToken, tokenType, expiresIn, user: { id, email, role } }`; cookie de refresh web si aplica | `401`, `429`, `503` |
| POST | `/auth/register` | removed | — | — | `410 Gone` | `410` |
| POST | `/admin/users` | proposed (priority) | ADMIN | `{ email, password, fullName?, role? = "OFTALMOLOGO" }` | `201 User`; auditoría de alta/grant/role | `400`, `403`, `409`, `422` |
| GET | `/auth/me` | proposed | Bearer + sesion vigente | - | `{ id, email, role, sessionId }` | `401`, `503` |
| POST | `/auth/logout` | proposed | Bearer + sesión | — | `204` | `401` |
| POST | `/auth/refresh` | proposed | Cookie web HttpOnly | Sin body JSON para web | `200 { accessToken, tokenType, expiresIn }`; **no** refresh token en JSON | `401` |
| POST | `/auth/password/forgot` | proposed | Público con rate limit | `{ email }` | `202` uniforme | `429` |
| POST | `/auth/password/reset` | proposed | Token de un solo uso | `{ token, newPassword }` | `204` | `400`, `401`, `429` |

**Sesiones:** decisión técnica propuesta por el arquitecto (industry), no implementada ni decisión exacta de producto. Access JWT 15 min default + `sessionId` + `tokenVersion`; verificación durable y fail closed por request; refresh opaco CSPRNG, hash en reposo, rotación atómica single-use, reutilización revoca familia, expiración absoluta 7 d; logout/deactivate/role change invalidan de inmediato; reset 30 min single-use, hash, sin logs, revoca todas. Web: refresh en cookie `HttpOnly; Secure; SameSite`; cross-site evalúa origen/CSRF; no refresh en JSON; no sugerir `localStorage` para access. Cliente backend no-browser fuera de alcance. El envío real de email requiere proveedor/remitente/credenciales no acordados: bloquea solo habilitar envío, no diseño/implementación.

### 3.2 Pacientes y consultas

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/patients` | proposed | OFTALMOLOGO | `{ externalCode?, age?, gender?, clinicalHistoryFlags?, clinicalData? }` | `201 Patient` | `400`, `401`, `403`, `422` |
| GET | `/patients` | proposed | OFTALMOLOGO dueño | `limit`, `offset` | `200 Patient[]` de consultas propias | `401`, `403` |
| GET | `/patients/:id` | proposed | Owner/grant | — | `200 Patient` | `401`, `403`, `404` |
| POST | `/consultations` | proposed | OFTALMOLOGO | `{ patientId, clinicalData?, requiredExecutionIds?: UUID[], requiredSetVersion: string }` | `201 Consultation` con agregados | `400`, `401`, `403`, `422` |
| GET | `/consultations/:id` | proposed | Owner/grant | — | `200 Consultation` con `analysisState`, `reportState`, `completionState`, `pollingStop` | `401`, `403`, `404` |
| POST | `/consultations/:id/images` | proposed | OFTALMOLOGO dueño | `multipart`: `file`, `eyeSide` | `201 Image` con `checksumSha256` (target) | `400`, `401`, `403`, `404`, `413`, `422` |
| GET | `/consultations` | deferred | — | filtros/paginación | — | — |

### 3.3 Ejecuciones, artefactos y reportes

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/inferences` | proposed | OFTALMOLOGO dueño | `{ imageId, eyeSide, clinicalFeatures, modelVersion?, reanalysisOf? }` + **`Idempotency-Key` obligatoria** | `202 { inferenceId, jobId, status: "QUEUED" }`; replay idéntico devuelve el mismo `202` | `400`, `401`, `403`, `404`, `409`, `422` |
| GET | `/inferences/:id` | proposed | Owner/grant | — | `ExecutionStatus` completo | `401`, `403`, `404` |
| GET | `/inferences/:id/artifacts` | proposed | Owner/grant | — | `ArtifactRef[]` | `401`, `403`, `404` |
| GET | `/inferences/:id/artifacts/:type/url` | proposed | Owner/grant | — | `ArtifactUrl`; solo `AVAILABLE` devuelve URL | `401`, `403`, `404`, `409` |
| GET | `/inferences/:id/reports` | proposed | Owner/grant | — | `ReportVersion[]` inmutables, con `reportId` y `version` | `401`, `403`, `404` |
| GET | `/inferences/:id/reports/:version/url` | proposed | Owner/grant | — | `ArtifactUrl` con `reportVersion` | `401`, `403`, `404`, `409` |
| POST | `/inferences/:id/review` | deferred (B1 restricción) | — | No es target actual; no approve-review ejecutable ni auto-complete manual | — | — |
| GET | `/inferences/:id/gradcam` | deferred | — | — | `NOT_SUPPORTED` | — |

**No hay un endpoint independiente `/reanalysis` en TARGET.** El reanálisis canónico es `POST /inferences` con `reanalysisOf`. Si se expone un alias por compatibilidad, delega exactamente en el mismo caso de uso, la misma `Idempotency-Key` y el mismo `202`; no es una segunda implementación.

### 3.4 Feedback y export

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/feedback` | proposed | OFTALMOLOGO dueño | `{ consultationId, inferenceId, validatedClass, doctorNotes?, isGoldStandard?, doctorId?, predictedClass?, confidence?, agreement? }` | `200 Feedback` camelCase | `401`, `403`, `404`, `422` |
| GET | `/export/gold-standard` | proposed | Grant explícito (INVESTIGADOR/ADMIN) | `format`, `since`, `limit` | JSON/CSV pseudonimizado camelCase | `401`, `403`, `422` |

### 3.5 Administración, auditoría e historial

| Método | Ruta | Estado | Nota |
|---|---|---|---|
| GET/PATCH | `/admin/users` | deferred | Lectura/edición admin diferida; **POST alta es prioridad** en 3.1, no diferida. Desactivación/roles y último admin protegido desde que existan esas rutas. |
| DELETE | `/admin/users/:id` | not planned | **No hay hard delete en este hito**, ni siquiera para cuentas sin actividad. La acción soportada es desactivación + revocación de sesiones; la supresión legal queda pendiente solo para producción. |
| GET | `/admin/audit` | deferred | Auditoría operativa append-only, mínimo PHI. |
| GET | `/consultations` | deferred | Historial/filtros/paginación, sin frontend en este hito. |

> **Alta administrativa (H3):** al retirar `POST /auth/register` (`410`), `POST /admin/users` es **prioridad de alta controlada desde el primer release**, no un CRUD diferido. `GET/PATCH /admin/users` sí son diferidos, pero la protección del último admin se aplica desde que existan rutas de cambio/desactivación. Toda cuenta nueva MUST auditar alta, grant y asignación de rol; el default es clínico regular (`OFTALMOLOGO`) y `ADMIN` solo puede asignarse por un admin autenticado y auditado. No se deja registro público “por falta de UI”: el backend/API se entrega sin frontend.

## 4. Shapes concretos TARGET

### 4.1 ExecutionStatus

| Campo | Tipo | Nulabilidad |
|---|---|---|
| `inferenceId` | UUID | no |
| `consultationId` | UUID | sí |
| `imageId` | UUID | no |
| `eyeSide` | `"OD"\|"OS"` | no |
| `status` | `JobStatus` | no |
| `stage` | string | no |
| `jobTerminal` | boolean | no |
| `deliveryTerminal` | boolean | no |
| `message` | string | sí |
| `result` | `ExecutionResult` | sí |
| `artifacts` | `ArtifactRef[]` | no (puede ser vacío) |
| `delivery` | `DeliveryState` | no |
| `createdAt` | ISO string | no |
| `updatedAt` | ISO string | no |

**ExecutionResult:** `predictedClass: 0|1|2|null`, `label: string|null`, `confidence: number|null`, `probabilities: Record<string, number>`, `modelPredictions: Record<string, { probabilities: Record<string, number>, predictedClass: string, confidence: number }>`, `cdr: number|null`, `cdrVertical: number|null`, `quality: object`, `modelVersions: Record<string,string>`, `elapsedSeconds: number|null`.

**DeliveryState:** `resultStatus`, `evidenceStatus`, `pdfStatus` con `ArtifactStatus`; `complete: boolean`, `reviewRequired: boolean`, `failed: boolean`, `deliveryTerminal: boolean`. `jobTerminal` es true solo si `status` ∈ `COMPLETED`, `REVIEW_REQUIRED`, `FAILED`. `deliveryTerminal` es true solo cuando todas las publicaciones solicitadas terminaron `AVAILABLE` o en fallo terminal explícito y **ninguna** queda `PENDING`. `delivery.complete` nunca es true si `status` es `REVIEW_REQUIRED` o `FAILED`. El polling clínico no se detiene solo por `jobTerminal` si `deliveryTerminal` es false. No se usa un booleano `terminal` indefinido.

**JobStatus:** `QUEUED`, `DOWNLOADING`, `LOCALIZING`, `SEGMENTING`, `CLASSIFYING`, `COMPLETED`, `REVIEW_REQUIRED`, `FAILED`. No se añade `PROCESSING`.

### 4.2 ArtifactRef (forma única, camelCase)

| Campo | Tipo | Nulabilidad |
|---|---|---|
| `artifactType` | `"result"\|"mask"\|"overlay"\|"pdf"\|"gradcam"\|"shap"` | no |
| `status` | `ArtifactStatus` | no |
| `storageId` | string | sí (solo `AVAILABLE`) |
| `bucketOrContainer` | string | sí (solo `AVAILABLE`) |
| `key` | string | sí (solo `AVAILABLE`) |
| `contentType` | string | sí (solo `AVAILABLE`) |
| `sizeBytes` | number | sí (solo `AVAILABLE`) |
| `checksumSha256` | string | sí (solo `AVAILABLE`; target; no confundir con `hashMd5` actual) |
| `failureCode` | string | sí |
| `retryable` | boolean | sí |
| `updatedAt` | ISO string | no |

**ArtifactStatus:** `NOT_SUPPORTED`, `NOT_REQUESTED`, `PENDING`, `AVAILABLE`, `FAILED`.

### 4.3 ArtifactUrl

`{ artifactType: ArtifactType, status: ArtifactStatus, url: string|null, expiresInSeconds: number|null, contentType: string|null, reportVersion: number|null }`. Solo `AVAILABLE` devuelve `url` y `expiresInSeconds`; el resto los devuelve `null`.

### 4.4 ReportVersion

| Campo | Tipo | Nulabilidad |
|---|---|---|
| `reportId` | UUID | no |
| `inferenceId` | UUID | no |
| `version` | number | no |
| `status` | `"PENDING"\|"AVAILABLE"\|"FAILED"` | no |
| `immutable` | `true` | no |
| `createdAt` | ISO string | no |
| `availableAt` | ISO string | sí |
| `failureCode` | string | sí |

### 4.5 Consultation agregada

| Campo | Tipo | Nulabilidad |
|---|---|---|
| `id` | UUID | no |
| `patientId` | UUID | no |
| `doctorId` | UUID | no |
| `requiredExecutionIds` | UUID[] | no (puede ser vacío) |
| `requiredSetVersion` | string | no |
| `requiredSetFrozenAt` | ISO string | sí |
| `analysisState` | `"OPEN"\|"IN_PROGRESS"\|"REVIEW_REQUIRED"\|"FAILED"\|"PARTIAL"\|"COMPLETED"` | no |
| `reportState` | `"NOT_REQUESTED"\|"REPORT_PENDING"\|"AVAILABLE"\|"FAILED"` | no |
| `completionState` | `"INCOMPLETE"\|"COMPLETE"` | no |
| `pollingStop` | `"CONTINUE"\|"COMPLETE"\|"ACTION_REQUIRED"\|"FAILED"` | no |
| `updatedAt` | ISO string | no |

Estos campos son derivados; **no** se añaden como enum DB nuevo.

## 5. Matriz de autorización TARGET

| Recurso/acción | Público | OFTALMOLOGO | INVESTIGADOR | ADMIN | Regla |
|---|---|---|---|---|---|
| Salud | Sí | — | — | — | Ninguna. |
| Login | Sí con rate limit | — | — | — | Sin registro público de rol. |
| Pacientes/consultas | No | Dueño | Solo grant/dataset | No lectura clínica por defecto | Default deny; mínimo PHI. |
| Ejecuciones/artefactos/PDF | No | Dueño | Solo grant | No por defecto | Misma regla que ejecución. |
| Feedback | No | Dueño | No | No | Solo consulta propia. |
| Export/dataset | No | No | Grant explícito | Grant explícito | Sin blanket admin; mínimo PHI. |
| Administración usuarios | No | No | No | Sí | Último admin protegido. |
| Auditoría operativa | No | No | No | Sí (deferred) | Sin PHI innecesaria. |
| Historial/filtros | No | Deferred | Deferred | Deferred | Hito posterior. |

## 6. Creación de ejecución y reanálisis

| Campo header/body | Tipo | Obligatorio | Regla |
|---|---|---|---|
| `Idempotency-Key` | string | Sí | Alcance durable autenticado + recurso. Misma key+payload ⇒ mismo `202` con mismo `inferenceId`/`jobId`. Misma key+payload distinto ⇒ `409`. |
| `imageId` | UUID | Sí | Imagen autorizada; su lateralidad almacenada debe coincidir con `eyeSide` o `422`. |
| `eyeSide` | `"OD"\|"OS"` | Sí | Metadato; nunca se confía en un valor contradictorio. |
| `clinicalFeatures` | objeto | Sí | 11 campos estrictos. |
| `modelVersion` | string\|null | No | El modelo resuelto se fija en la primera solicitud y no cambia por defaults de reintento. |
| `reanalysisOf` | UUID | No | Crea ejecución nueva enlazada; no sobrescribe. |
| `imageUrl` | — | Prohibido | No lo envía el frontend; el backend firma desde referencia confiable. |

**Respuesta `202`:** `{ inferenceId: UUID, jobId: string, status: "QUEUED" }`. Si se pierde el `202`, se reintenta con la misma key; no se exige consultar un ID nunca recibido. El modelo queda fijado; la URL firmada dinámica no forma parte del payload/fingerprint. **Mientras B3 no esté aprobado, no se purgan** registros de idempotencia, tombstones ni vínculos de inferencia necesarios para replay. Cuando B3 se apruebe, la retención podrá acotarse sin romper el horizonte de replay definido; no se promete replay eterno arbitrario, pero la política vigente es no purgar. **B2:** una consulta completada no se reabre ni altera automáticamente; `requiredExecutionIds` no se promueve ni reemplaza tras cierre y los reanálisis históricos no modifican el frozen set.

## 7. Artefactos, polling y entrega

- Catálogo: `result`, `mask`, `overlay`, `pdf`, `gradcam`, `shap`.
- La **imagen original sanitizada** no es un artefacto opcional: es la fotografía almacenada sin EXIF del upload original y es obligatoria para el PDF de una ruta exitosa normal.
- Obligatorios en ruta exitosa normal: `mask`, `overlay`, `result` y PDF básico; el PDF embebe **original sanitizada + mask + overlay**.
- `gradcam`/`shap`: `NOT_SUPPORTED` hasta entrega diferida; nunca URL simulada.
- Si un obligatorio falla, la ejecución no completa; se puede reintentar publicación sin reinferir.
- `jobTerminal` de ML no equivale a entrega terminada. Tras `COMPLETED` de ML se sigue publicando artefactos/PDF; el polling clínico continúa si quedan artefactos o PDF `PENDING`. No se detiene hasta `deliveryTerminal=true`, `pollingStop` terminal, error/auth o deadline/timeout global con acción de nueva consulta.
- `REVIEW_REQUIRED` no aprueba automáticamente ni permite `delivery.complete=true`; si la evidencia/PDF se sigue generando, el cliente continúa el polling hasta que la publicación conocida no tenga `PENDING`, sin convertir la revisión en éxito.
- Polling: 2 s inicial, techo 10 s, `Retry-After`. Un timeout global configurable dispara aviso y no marca la inferencia como `FAILED` por sí solo.
- Reportes: `reportId` + `version` inmutables; feedback/explicaciones nuevas crean nueva versión sin pisar la anterior.
- Backend y ML deben abstraer **Azure Blob y MinIO/S3**. Azure usa SAS read-only sobre objeto, HTTPS y TTL; MinIO usa presign. El backend actual es solo S3/MinIO (`backend/src/services/storage.ts:1-98`); Azure no está implementado todavía y se marca como TARGET. Los tests de provider usan Azure fake/Azurite sin Azure real; el E2E real Azure queda condicionado a B6 (parcial, no deployment ready).

## 8. Estados agregados y precedencia

`analysisState` (derivado, no enum DB): `OPEN`, `IN_PROGRESS`, `REVIEW_REQUIRED`, `FAILED`, `PARTIAL`, `COMPLETED`.

| Condición | `analysisState` |
|---|---|
| `requiredExecutionIds` vacío | `OPEN`; nunca `COMPLETED` por vacuidad |
| Todas requeridas con resultado + evidencia obligatoria | `COMPLETED` |
| Alguna requerida `FAILED` sin recuperación pendiente | `FAILED` (precedencia conservadora) |
| Alguna requerida `REVIEW_REQUIRED` | `REVIEW_REQUIRED` |
| Alguna con `jobTerminal=false` o artefacto obligatorio `PENDING` | `IN_PROGRESS` |
| Alguna con resultado/evidencia pero no todas | `PARTIAL` |
| En otro caso | `OPEN` |

`reportState` separado y formal: `NOT_REQUESTED` si `requiredExecutionIds` está vacío; `AVAILABLE` solo si el conjunto requerido **no está vacío y todos** los `pdfStatus` están `AVAILABLE`; `REPORT_PENDING` si alguno está en generación/publicación y ninguno es fallo terminal; `FAILED` si alguno es fallo terminal. Precedencia: `FAILED > REPORT_PENDING > AVAILABLE`; nunca `AVAILABLE` por vacuidad. `completionState = COMPLETE` solo si `requiredExecutionIds` no está vacío y **todas** esas ejecuciones tienen resultado, artefactos obligatorios y PDF disponible; no basta “algún reporte” ni un reporte histórico. Cada delivery de ejecución registra su propia completitud y la agregación no sobrescribe histórico. **B2:** no hay reapertura ni promoción de `requiredExecutionIds` tras cierre; el frozen set manda. `analysisState` evalúa resultado/ML y no mete PDF en el enum ML; la completitud se decide por el agregado.

`pollingStop` de consulta: `CONTINUE`, `COMPLETE`, `ACTION_REQUIRED` o `FAILED`. `COMPLETE` solo con `completionState=COMPLETE`; `ACTION_REQUIRED` cuando hay revisión/bloqueo que exige acción humana o nueva consulta; `FAILED` en fallo terminal; `CONTINUE` si queda `REPORT_PENDING`, `PENDING` o `jobTerminal=false`. El cliente para en `COMPLETE`, `ACTION_REQUIRED` o `FAILED` con reporte terminal sin `PENDING`. Un PDF de `REVIEW_REQUIRED` no declara completitud. `COMPLETED` de ML no es estado de consulta.

## 9. PDF básico

| Sección | Contenido mínimo |
|---|---|
| Identificación | Caso/consulta/ojo pseudónimos, `inferenceId`. |
| Versionado | Snapshot, revisiones de modelo, `reportId`/`version`. |
| Clínica | 11 variables; unidades solo verificadas; probabilidades; clase. |
| Medidas | Calidad, CDR y tipo de CDR. |
| Evidencia | Original sanitizada + `mask` + `overlay` embebidas en éxito normal. |
| Fechas | Análisis y generación del PDF. |
| Avisos | Warnings, revisión, apoyo a investigación, no sustituto médico. |
| HU08 | Encabezado, numeración y plantilla institucional medibles. |
| Explicabilidad | Grad-CAM/SHAP declarados no incluidos hasta entrega. |

**Prohibido:** secretos, tokens, SAS, presigned URLs, credenciales, enlaces temporales, EXIF del upload original y diagnóstico médico validado cuando solo hay inferencia. En revisión, el PDF parcial documenta la falta y no completa.

## 10. Diferidos y bloqueos

| Funcionalidad | Estado | Motivo |
|---|---|---|
| Historial/filtros/paginación | deferred | Hito funcional posterior sin frontend. |
| Administración/auditoría operativa | deferred | Hito posterior. |
| PDF enriquecido | deferred | Posterior al PDF básico. |
| Grad-CAM / SHAP | deferred | Requisitos SRS diferidos; reporte independiente digital/PDF. |
| Resolución `REVIEW_REQUIRED` | deferred (ex B1) | B1 resuelto como restricción: el médico no convierte una ejecución sin resultado válido; la resolución es un reanálisis con PDF independiente; no hay endpoint approve-review ejecutable ni auto-complete manual. |
| Cambio/promoción de `requiredExecutionIds` | restricción aprobada (B2) | No reapertura ni promoción tras cierre; frozen set; reanálisis históricos independientes. |
| Borrado/hard delete de usuarios | fuera de alcance (B5) | Desactivación + revocación de sesiones; no hard delete en este hito; supresión/retención solo producción. |
| Retención numérica | pendiente solo producción (B3) | No fija plazos ni declara cumplimiento legal; no bloquea desarrollo/test sintético/PAPILA. |
| Consentimiento/privacidad | pendiente solo producción (B4) | No afirma anonimización por HMAC ni cumplimiento; fail closed con datos reales sin governance. |
| Supresión de identidad/legal | pendiente solo producción (B5) | Sin automatización ni plazos; excepción futura con política. |
| Deploy Azure real | parcialmente satisfecho CLI / no deployment ready (B6) | Contexto CLI read-only sin crear recursos; faltan presupuesto/duración/scope y confirmación/permisos. |
| RF07 unimodal / RF15 comparación | deferred (B7) | No se implementan ni simulan; no bloquean. |
| Envío real de email forgot/reset | pendiente solo provisioning (B8) | Sink en memoria primero; envío real solo a destinatarios autorizados, sin PHI/enlaces secretos, sin versionar direcciones/credenciales. |
| `DatabaseFeedbackSource` | fuera de alcance (B9) | No añade SQLAlchemy ni bloquea el change. |

## 11. Reglas de consumo para frontend

1. `POST /auth/register` está retirado (`410`); no usarlo para crear cuentas ni administradores. El primer admin se crea con el bootstrap controlado; el alta administrativa `POST /admin/users` sigue pendiente (1.8).
2. No guardar access tokens en `localStorage`; el refresh web va en cookie HttpOnly/Secure/SameSite.
3. No enviar `imageUrl`; no construir URLs de storage; pedir URL nueva al backend si expira.
4. No asumir que `GET /inferences/:id` actual devuelve estado/artefactos; en TARGET sí, pero marcado `proposed`.
5. No usar un endpoint `/reanalysis` independiente; usar `POST /inferences` con `reanalysisOf`.
6. No reintentar sin `Idempotency-Key`; si se perdió el `202`, repetir la misma key.
7. No presentar `gradcam`/`shap` como disponibles; son `NOT_SUPPORTED`.
8. No presentar un PDF de revisión como caso completo.
9. No confundir `hashMd5` actual con `checksumSha256` target.
10. No mostrar unidades/categorías clínicas no verificadas como validadas.
11. No esperar un endpoint de aprobación de revisión ni un auto-complete manual; la resolución es un reanálisis con PDF independiente.
12. No ofrecer hard delete de usuarios en este hito; la acción soportada es desactivación + revocación de sesiones.
