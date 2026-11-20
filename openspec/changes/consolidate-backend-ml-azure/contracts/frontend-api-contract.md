# Contrato de API para Frontend — consolidate-backend-ml-azure

> **Naturaleza:** fuente de verdad documental, no evidencia de implementación. El documento separa **CURRENT VERIFIED** (lo que el código actual devuelve, leído de schemas/rutas) de **TARGET vNext** (diseño propuesto, con estado `proposed`, `deferred`, `blocked` o `removed`). Nada de TARGET debe consumirse como si ya existiera. El frontend no debe usar el alta pública actual para crear administradores ni asumir IDs/estados que el servidor no haya entregado.

## 1. Convenciones

| Tema | Contrato |
|---|---|
| Base local | `http://localhost:8080` |
| Auth | `Authorization: Bearer <accessToken>` salvo salud, login/forgot/reset públicos controlados y refresh por cookie. Logout exige Bearer; la cookie no autoriza. |
| Origen público | Login/refresh exigen `Origin` exactamente igual a `AUTH_PUBLIC_ORIGIN` (URL `http(s)` normalizada, sin wildcard); logout valida ese guard solo si envía `Origin`; `forgot`/`reset` usan la misma validación opcional porque no hay cookie como credencial. |
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

> Esta sección describe el comportamiento actual aunque sea incompleto o inseguro. No es el contrato recomendado para nuevas integraciones. Login/refresh/logout reflejan la implementación 5.8 validada por QA; forgot/reset reflejan 5.9 (R2) validada por QA; el resto mantiene su estado actual.

| Método | Ruta | Auth actual | Request actual | Response actual | Limitaciones actuales |
|---|---|---|---|---|---|
| GET | `/health` | Público | — | `{ status: string, service: string, timestamp: ISO }` | Estable. |
| POST | `/auth/register` | Público | Cualquier JSON válido; sin validación de `role` (JSON malformado lo rechaza el parser HTTP con `400`) | `410 { error: "Gone", message: string, statusCode: 410 }` | **Retirado: no crea cuentas, no consulta la base y no emite token. El alta del primer admin es un CLI controlado (bootstrap), no un endpoint público.** |
| POST | `/auth/login` | Público + `Origin` exacto | `{ email: string(email), password: string }` | `200 { accessToken: string, tokenType: "bearer", expiresIn: string, user: { id: UUID, email: string, role } }` + `Set-Cookie: clearsight_refresh=…` | **Implementado 5.8:** JWT HS256 900 s con `sessionId`/`tokenVersion`; cookie `HttpOnly/Secure/SameSite=Lax`, host-only, `Path=/api/auth`, ≤ 7 d; `AUTH_PUBLIC_ORIGIN` obligatorio (`403` si falta/null/mismatch; `503` si la config falta); no setea cookie si falla sign/audit/commit; `401` uniforme; `429` con `Retry-After` (HU01 5/15 min y cuota IP 100/60). |
| POST | `/auth/refresh` | Cookie `clearsight_refresh` | Sin body ni Bearer recomendados | `200 { accessToken, tokenType: "bearer", expiresIn }` + nueva cookie rotada | **Implementado 5.8:** single-use; hash SHA-256 en DB; `401` genérico (incl. reuso), `403` por `Origin`, `503` fail closed; no devuelve refresh en JSON. “Sin body/Bearer” describe el mecanismo: si llegan, no se usan como credencial ni sustituyen la cookie. |
| POST | `/auth/logout` | Bearer + sesión válida | — | `204`; limpia `clearsight_refresh` | **Implementado 5.8:** revoca sesión y cadena con auditoría; la cookie sola no autoriza; si incluye `Origin`, pasa el mismo guard; `401/403/503`. |
| POST | `/auth/password/forgot` | Público, sin sesión/cookie; `Origin` opcional | `{ email: string(email canónico, trim/lowercase, <=255) }` estricto | `202 { accepted: true }` fijo; `Cache-Control: no-store` | **Implementado 5.9 QA PASSED:** cuotas `FORGOT_IP` 20/3600 y `FORGOT_EMAIL` 3/3600; `DISABLED` por defecto sin token; no enumera; `429` con `Retry-After`; `503` solo store de cuotas. |
| POST | `/auth/password/reset` | Público; token solo en body; sin cookie/Bearer; `Origin` opcional | `{ token: string, newPassword: string(>=12 code points, <=72 UTF-8 bytes) }` estricto | `204` vacío; sin sesión nueva; `Cache-Control: no-store` | **Implementado 5.9 QA PASSED:** cuota `RESET_IP` 20/900; `401` genérico para inválido/expirado/usado/revocado/inactivo; reset revoca sesiones/refresh/otros reset y conserva HU01. |
| GET | `/auth/me` | Bearer | - | `{ id: UUID, email: string, role }` | Valida firma, claims, sesion durable, usuario activo, rol/version vigentes y expiracion; `401` y `503`. Sin cambios por 5.8/5.9. |
| POST | `/admin/users` | Bearer, ADMIN | `{ email: string(canonico, trim/lower, <=255), password: string(>=12 code points, <=72 UTF-8 bytes), fullName: string(trim 1..255), role?: "OFTALMOLOGO"\|"INVESTIGADOR"\|"ADMIN" = "OFTALMOLOGO" }` | `201 { id: UUID, email: string, fullName: string, role, isActive: true, createdAt: ISO, updatedAt: ISO }` | **Alta controlada implementada (1.8):** actor/sesion frescos en la misma tx, `USER_CREATED` auditado, email literal case-insensitive, `400/401/403/409/503`; no emite JWT. `GET/PATCH` y ciclo de vida implementados en 5.4/5.6/9.1; DELETE no implementado. |
| GET | `/admin/users` | Bearer, ADMIN | `limit?: number(1..100)=20`, `offset?: number(>=0)=0`, `role?`, `isActive?: "true"\|"false"`, `q?: string(trim<=255)` | `200 { items: User[7 safe fields], total: number, limit, offset }`; orden `createdAt DESC id ASC`; `q` literal case-insensitive sobre email/fullName | `400/401/403/503`; lectura sin auditoría masiva ni datos clínicos. |
| GET | `/admin/users/:id` | Bearer, ADMIN | path UUID | `200 User` (7 safe fields; email/fullName string, sin imponer formato a legacy) | `400/401/403/404/503`. |
| PATCH | `/admin/users/:id` | Bearer, ADMIN | path UUID; body estricto `{ email?, fullName?, role?, isActive? }`, al menos 1 campo; sin password/hash/tokenVersion/contadores/actor/grants | `200 User` (7 safe fields; sin token nuevo) | `400/401/403/404/409/503`; email ocupado `409`; último admin `409 LAST_ACTIVE_ADMIN`; email/role/isActive revocan sesiones/refresh/reset y suben `tokenVersion`; fullName no revoca; DELETE no implementado. |
| POST | `/patients` | Bearer, OFTALMOLOGO | `{ externalCode?: string(<=64)\|null, age?: number(int 0..130)\|null, gender?: string(<=16)\|null, clinicalHistoryFlags?: object = {}, clinicalData?: object = {} }` estricto; campos owner/actor desconocidos rechazados | `201 { id: UUID, externalCode: string\|null, age: number\|null, gender: string\|null, clinicalHistoryFlags: object, clinicalData: object\|null, createdAt: ISO }` | Doctor-only: el owner se asigna server-side desde el JWT; ADMIN deja de crear clínica. |
| GET | `/patients` | Bearer, OFTALMOLOGO | `limit?: number(1..100)=20`, `offset?: number(>=0)=0` | `200 Patient[]` | Solo pacientes con `ownerDoctorId` del doctor autenticado; ADMIN/INVESTIGADOR `403`. |
| GET | `/patients/:id` | Bearer, OFTALMOLOGO dueño | - | `200 Patient` | `404` uniforme si es ajeno o si el perfil legacy tiene owner NULL; un grant no concede acceso a Patient. |
| POST | `/consultations` | Bearer, OFTALMOLOGO | `{ patientId: UUID, doctorId?: UUID, status?: JobStatus = "QUEUED", clinicalData?: object = {} }` estricto | `201 { id: UUID, patientId: UUID, doctorId: UUID, status: string, clinicalData: object, createdAt: ISO }` | `doctorId` solo se acepta si coincide con el JWT (`403` si difiere) y se persiste el del servidor; el paciente debe ser propio (`404`). ADMIN/INVESTIGADOR `403`. |
| POST | `/consultations/:id/images` | Bearer, OFTALMOLOGO dueño | `multipart/form-data`: `file`, `eyeSide: "OD"\|"OS"` obligatorio | `201 { id: UUID, consultationId: UUID, eyeSide: "OD"\|"OS", storagePath: string, hashMd5: string, createdAt: ISO }` | Ownership antes de buffer/storage; `eyeSide` explícito y único, sin default `OD`: ausente/inválido/duplicado `422`; sin bypass ADMIN. Límite API 50 MB; `hashMd5`, no SHA-256. |
| GET | `/consultations/:id` | Bearer, OFTALMOLOGO dueño | - | `200 { id, patientId, doctorId, status, clinicalData, createdAt, images: Image[] }` | Solo casos propios (`doctorId`); `404` ajeno; no incluye el objeto Patient; sin agregados `analysisState`/`reportState`. |
| POST | `/inferences` | Bearer, OFTALMOLOGO dueño de la imagen | `{ imageId: UUID, eyeSide: "OD"\|"OS", clinicalFeatures: 11 campos, modelVersion?: string\|null }` estricto; `imageUrl` e `inferenceId` del cliente se rechazan como campos desconocidos (`400`) | `202 { inferenceId: UUID, jobId: string, status: "QUEUED" }` | El servidor genera `inferenceId` y la URL de la imagen desde `imageId`; `eyeSide` debe coincidir con la imagen almacenada (`422`). Sin `Idempotency-Key` (D7 futuro, no implementado). |
| GET | `/inferences/:id` | Bearer; dueño o grant activo `read_result` | - | `200 { id, imageId, predictedClass, confidence, probabilities, gradcamPath, modelVersion, createdAt }` | `404` uniforme sin permiso; no-dueño con grant recibe `gradcamPath:null` salvo `read_artifacts`; nunca devuelve approvalReference/approvedBy. |
| GET | `/inferences/:id/gradcam` | Bearer; dueño o grant activo `read_artifacts` | - | `200 { url, expiresIn }` o `404` | URL firmada bajo demanda; `404` sin artefacto o sin capacidad. |
| POST | `/feedback` | Bearer, OFTALMOLOGO dueño | `{ consultation_id: UUID, inference_id: UUID, validated_class: 0\|1\|2\|null, doctor_notes?: string\|null, is_gold_standard?: boolean=false, doctor_id?: UUID, predicted_class?: 0\|1\|2\|null, confidence?: number\|null, agreement?: boolean\|null }` | `200 { id, consultation_id, inference_id, doctor_id, validated_class, predicted_class, confidence, agreement, doctor_notes, is_gold_standard, created_at, updated_at }` | El servidor deriva `predicted_class`, `confidence`, `agreement`; `validated_class:null` no puede ser gold; un grant nunca habilita escritura. |
| GET | `/export/gold-standard` | Bearer, INVESTIGADOR/ADMIN con grant activo `can_export_gold_standard` | `format?: "json"\|"csv" = "json"`, `since?: ISO`, `limit?: number(1..50000)=5000` | JSON `{ count, has_more, generated_at, items[] }` o CSV; headers `x-has-more`, `cache-control: no-store` | Sin ningún grant activo `403`; scope limitado a los pares `(inferenceId, consultationId)` aprobados antes de since/limit; lista vacía exporta cero. Grants se aprovisionan offline, sin endpoint HTTP. |

## 3. TARGET vNext — endpoints propuestos

> Los estados `proposed`, `deferred`, `blocked` y `removed` no son implementación actual. El frontend debe tratar `removed` como no disponible y `blocked` como no implementable aún.

### 3.1 Autenticación y administración

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/auth/login` | implemented (5.8) | Público con rate limit/HU01 y `Origin` exacto | `{ email, password }` | `200 { accessToken, tokenType, expiresIn, user: { id, email, role } }` (JSON actual) + `Set-Cookie: clearsight_refresh=…` (HttpOnly/Secure/Lax, host-only, `Path=/api/auth`, ≤ 7 d) | `401`, `403` (`Origin`), `429` (`Retry-After`; mismo body, sin contador/email), `503` |
| POST | `/auth/register` | removed | — | — | `410 Gone` | `410` |
| POST | `/admin/users` | implemented (1.8) | ADMIN | `{ email: string(canonico, trim/lower, <=255), password: string(>=12 code points, <=72 UTF-8 bytes), fullName: string(trim 1..255), role? = "OFTALMOLOGO" }` | `201 { id, email, fullName, role, isActive, createdAt, updatedAt }`; auditoría de alta/rol | `400`, `401`, `403`, `409`, `503` |
| GET | `/auth/me` | unchanged (current) | Bearer + sesion vigente | - | `{ id, email, role }` (sin cambios por 5.8) | `401`, `503` |
| POST | `/auth/logout` | implemented (5.8) | Bearer + sesión; cookie nunca autoriza | — | `204`; revoca sesión y cadena auditada y limpia `clearsight_refresh` con los mismos atributos | `401`, `403` (si `Origin` presente no coincide), `503` |
| POST | `/auth/refresh` | implemented (5.8) | Cookie `clearsight_refresh`; sin body ni Bearer | — | `200 { accessToken, tokenType, expiresIn }`; rota single-use; **no** refresh token en JSON | `401` (incl. reuso), `403` (`Origin`), `503` |
| POST | `/auth/password/forgot` | implemented (5.9 QA PASSED) | Público, sin sesión/cookie; `Origin` opcional | `{ email: string(email canónico, trim/lowercase, <=255) }` estricto | `202 { accepted: true }` fijo; `Cache-Control: no-store` | `400`, `403` (`Origin` presente inválido), `429` (`Retry-After`), `503` (store de cuotas) |
| POST | `/auth/password/reset` | implemented (5.9 QA PASSED) | Público; token solo en body; sin cookie/Bearer; `Origin` opcional | `{ token: string, newPassword: string(>=12 code points, <=72 UTF-8 bytes) }` estricto | `204` vacío; sin sesión nueva; `Cache-Control: no-store` | `400`, `401`, `403` (`Origin` presente inválido), `429` (`Retry-After`), `503` |

#### 3.1.1 Cookie de refresh, origen público y proxy (implementado 5.8, QA PASSED)

- **Origen público único:** el frontend solo conoce `https://<origen-público>/api/...`. Un proxy HTTPS quita el prefijo `/api`; el backend expone internamente `/auth/login`, `/auth/refresh`, `/auth/logout` y `/auth/me`.
- **Cookie:** `clearsight_refresh` con `HttpOnly`, `Secure`, `SameSite=Lax`, host-only (sin `Domain`) y `Path=/api/auth`. Su expiración no supera la sesión absoluta (≤ 7 días). El refresh crudo nunca va en JSON, logs ni auditoría; en DB solo se guarda su hash SHA-256 lowercase.
- **Login:** conserva el JSON actual (`accessToken`, `tokenType`, `expiresIn`, `user`) y añade el `Set-Cookie`; no setea cookie si falla firma, auditoría o commit.
- **Refresh:** `POST /api/auth/refresh` usa solo la cookie y devuelve solo `accessToken`, `tokenType` y `expiresIn`; rota single-use. “Sin body ni Bearer” describe el mecanismo de autenticación, no prohíbe la coexistencia de headers: el request recomendado no los envía, pero si llegan nunca se usan como credencial ni sustituyen la cookie, y su presencia sola no es error.
- **Reuso:** la familia es la sesión y sus refresh. Dos solicitudes concurrentes del mismo token: como máximo una emite; la otra revoca esa sesión y todos sus refresh (no otras sesiones del usuario). Sin ventana de gracia: el cliente documenta single-flight. El reuso confirma revocación+auditoría y **después** responde `401`.
- **Origen (`AUTH_PUBLIC_ORIGIN`):** variable explícita con URL `http(s)` normalizada y sin wildcard; debe coincidir exactamente con `Origin`. Producción HTTPS; `localhost` HTTP solo en configuración no productiva explícita, con cookie siempre `Secure`. `Origin` ausente/null/mismatch ⇒ `403` antes de KDF/store; `Sec-Fetch-Site: cross-site` ⇒ rechazo si viene. No se deriva de `Host`/`X-Forwarded-*` no confiables ni de CORS wildcard. Si falta, los endpoints de cookie fallan cerrado (`503`) sin romper `buildApp` lazy ni el `410` de `/auth/register`.
- **Logout:** `POST /api/auth/logout` con `Bearer` de sesión válida ⇒ `204`, revoca sesión y cadena auditada y limpia la cookie con los mismos atributos. La cookie sola no autoriza; si el request incluye `Origin`, pasa el mismo guard.
- **Caché y errores:** `Cache-Control: no-store` en respuestas de credenciales; `401/403/503` genéricos.
- **Auditoría caída:** `503` con rollback; nunca un logout exitoso falso. Audit fallida en refresh no consume el padre; audit fallida en login no setea cookie.
- **Alcance:** `/auth/me` no cambia. No se editan `refresh_tokens`/`user_sessions` ni sus migraciones. Las pruebas locales usan el proxy HTTPS documentado; `Secure` no se deshabilita en producción.
- **H2 (hardening futuro):** reutilizar un token ya consumido puede escribir auditoría/locks en cada intento; D19 no exige rate-limit adicional. Límite conocido de amplificación; no se promete resuelto.
- **H3 (logging):** la redacción actual cubre `Cookie`, `Set-Cookie`, `Authorization` y campos de credenciales. Serializers custom futuros requieren revisión contra esa lista; no hay fuga actual.

#### 3.1.2 Recuperación de contraseña (implementado 5.9, QA PASSED)

> R2/5.9 implementa los endpoints internos y su contrato. El backend expone internamente `/auth/password/forgot` y `/auth/password/reset`; el path público previsto es `/api/auth/password/*` detrás de un proxy HTTPS que quita `/api`, pero **el proxy no se implementa en este hito**. La entrega real de email sigue deshabilitada y B8 queda pendiente de provisioning sin bloquear el cierre de 5.9.

- **Transporte:** ambos endpoints son públicos, no leen ni emiten cookies y no abren sesión. `reset` autoriza solo con `token` del body; `Authorization` no sustituye al token y los campos/claims desconocidos son `400`. `Origin` se valida solo si el header está presente, con la misma política exacta que logout (`403` mismatch/null; `503` si falta configuración); ausente se permite porque no hay cookie como credencial.
- **`forgot` request:** `{ email: string(email canónico, trim/lowercase, <=255) }` estricto. Respuesta uniforme para conocida, desconocida e inactiva: `202 { accepted: true }`, `Cache-Control: no-store`. No incluye token, usuario, rol ni estado de entrega. Es un acuse de recepción: no prueba emisión ni entrega y la UI no debe inferir si la cuenta existe.
- **Cuotas de `forgot`:** 3 intentos por email canónico/3600 s y 20 por IP de socket/3600 s, ventana fija durable desde el primer intento, independientes de login/HU01. Con body válido se consume primero IP y después email, aunque el email ya esté agotado; `429` con `Retry-After` entero `>= 1`. Un fallo del store de cuotas antes del lookup es `503` genérico para cualquier cuenta.
- **Cuota de `reset`:** 20 intentos por IP de socket/900 s antes del lookup del token y de bcrypt; un token inválido/expirado/usado/revocado o un usuario inactivo también consume la cuota. `429` con `Retry-After >= 1`. La IP es la del socket: no se lee `X-Forwarded-For` ni se habilita `trustProxy` global.
- **`reset` request/response:** `{ token: string, newPassword: string(>=12 code points Unicode, <=72 UTF-8 bytes) }` estricto. `204` vacío, sin `Set-Cookie`, sin access token y sin sesión nueva. `400` para DTO inválido; `401` genérico idéntico para token inválido/expirado/usado/revocado o usuario inactivo; `503` si falla store/auditoría/hash (rollback sin consumo).
- **Efecto de `reset` exitoso:** bcrypt cost 12, `tokenVersion + 1` una sola vez (access previos inválidos), consume el token usado y revoca los demás reset tokens, todas las sesiones y todos los refresh del usuario en una transacción auditada. **No** reinicia `failedLoginCount`/`lockedUntil` ni las cuotas de login: el lockout vigente se conserva y el usuario debe volver a autenticarse.
- **Entrega:** puerto inyectable con modo `DISABLED` por defecto. Sin sink explícito de pruebas, `forgot` responde `202` sin generar token ni invalidar anteriores. Con sink habilitado, token+revocación+auditoría commitean antes de la entrega; fallo de auditoría revierte y no entrega; fallo de entrega devuelve `202` sin prometer entrega y solo revoca condicionalmente el token exacto. El sink en memoria es solo de pruebas y no se expone por HTTP. No hay outbox ni proveedor real; B8 sigue pendiente y `202` no garantiza entrega.
- **Secretos:** token crudo de 32 bytes CSPRNG/base64url (43 caracteres), en DB solo SHA-256 lowercase, expiración 30 min. Nunca en logs, JSON, cabeceras ni enlaces con URL/query/fragmento. `Cache-Control: no-store` en todas las respuestas, incluidas las de error.

**Sesiones:** diseño técnico propuesto por el arquitecto (industry), no una decisión exacta de producto. El acceso durable y el contrato web 5.8 están implementados y validados por QA; reset de contraseña está implementado en R2/HITO17 con 5.9 QA PASSED y su contrato verificable está en 3.1.2/D20. Access JWT 15 min default + `sessionId` + `tokenVersion`; verificación durable y fail closed por request; refresh opaco CSPRNG, hash en reposo, rotación atómica single-use, reutilización revoca familia, expiración absoluta 7 d; logout/deactivate/role change invalidan de inmediato; reset 30 min single-use, hash, sin logs, revoca todas y conserva el lockout de login. Web (5.8): refresh solo en cookie `clearsight_refresh` (`HttpOnly; Secure; SameSite=Lax`, host-only, `Path=/api/auth`) y guard de `Origin` exacto; no refresh en JSON; no sugerir `localStorage` para access (ver 3.1.1). Cliente backend no-browser fuera de alcance. El envío real de email requiere proveedor/remitente/credenciales no acordados: bloquea solo habilitar envío, no diseño/implementación; 5.9 usa un sink de pruebas y `DISABLED` por defecto.

### 3.2 Pacientes y consultas

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/patients` | proposed | OFTALMOLOGO | `{ externalCode?, age?, gender?, clinicalHistoryFlags?, clinicalData? }` | `201 Patient` | `400`, `401`, `403`, `422` |
| GET | `/patients` | proposed | OFTALMOLOGO dueño | `limit`, `offset` | `200 Patient[]` de consultas propias | `401`, `403` |
| GET | `/patients/:id` | proposed | Owner doctor only (un grant NO concede Patient) | - | `200 Patient` | `401`, `403`, `404` |
| POST | `/consultations` | proposed | OFTALMOLOGO | `{ patientId, clinicalData?, requiredExecutionIds?: UUID[], requiredSetVersion: string }` | `201 Consultation` con agregados | `400`, `401`, `403`, `422` |
| GET | `/consultations/:id` | proposed | Owner doctor only (un grant NO concede Consultation) | - | `200 Consultation` con `analysisState`, `reportState`, `completionState`, `pollingStop` | `401`, `403`, `404` |
| POST | `/consultations/:id/images` | proposed | OFTALMOLOGO dueño | `multipart`: `file`, `eyeSide` | `201 Image` con `checksumSha256` (target) | `400`, `401`, `403`, `404`, `413`, `422` |
| GET | `/consultations` | deferred | — | filtros/paginación | — | — |

### 3.3 Ejecuciones, artefactos y reportes

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/inferences` | implemented (2.2 QA PASSED; CURRENT creation) | OFTALMOLOGO dueño | `{ imageId, eyeSide, clinicalFeatures, modelVersion?, reanalysisOf? }` + **`Idempotency-Key` obligatoria (D7/4.4 futuro; NO implementada en 2.2)** | `202 { inferenceId, jobId, status: "QUEUED" }`; cuerpo/estado sin cambios | `400`, `401`, `403`, `404`, `422`, `503` (`409` reservado a 4.4; 2.2 no lo emite) |
| GET | `/inferences/:id` | proposed | Owner/grant | — | `ExecutionStatus` completo | `401`, `403`, `404` |
| GET | `/inferences/:id/artifacts` | proposed | Owner/grant | — | `ArtifactRef[]` | `401`, `403`, `404` |
| GET | `/inferences/:id/artifacts/:type/url` | proposed | Owner/grant | — | `ArtifactUrl`; solo `AVAILABLE` devuelve URL | `401`, `403`, `404`, `409` |
| GET | `/inferences/:id/reports` | proposed | Owner/grant | — | `ReportVersion[]` inmutables, con `reportId` y `version` | `401`, `403`, `404` |
| GET | `/inferences/:id/reports/:version/url` | proposed | Owner/grant | — | `ArtifactUrl` con `reportVersion` | `401`, `403`, `404`, `409` |
| POST | `/inferences/:id/review` | deferred (B1 restricción) | — | No es target actual; no approve-review ejecutable ni auto-complete manual | — | — |
| GET | `/inferences/:id/gradcam` | deferred | — | — | `NOT_SUPPORTED` | — |

**No hay un endpoint independiente `/reanalysis` en TARGET.** El reanálisis canónico es `POST /inferences` con `reanalysisOf`. Si se expone un alias por compatibilidad, delega exactamente en el mismo caso de uso, la misma `Idempotency-Key` y el mismo `202`; no es una segunda implementación.

**2.2 (HITO19, QA PASSED; CURRENT creation) — contexto preparado:** `clinicalFeatures` de la request es la fuente autoritativa. El backend llama internamente a `POST /v1/clinical-snapshots/prepare` del servicio ML y persiste snapshot + ejecución `QUEUED` en una sola transacción. El frontend **no** llama a `prepare`, **no** envía `expected_context`, **no** envía `eyeSide` de ML, `consultationId` ni `clinicalData`, y su contrato de éxito (`202` + `jobId` + `status`) no cambia. `reanalysisOf` es UUID opcional; un padre ajeno/inexistente devuelve `404` uniforme y un contexto de padre que contradice consulta/ojo devuelve `422` antes de preparar o escribir. Un `503` significa que no se creó snapshot/ejecución (fallo antes de DB) o que la ejecución quedó persistida con la cola pendiente post-commit (4.6); no se reintenta a ciegas sin la idempotencia 4.4. 2.2 **no** implementa `requiredExecutionIds`/freeze (2.5), agregación (2.3), idempotencia (4.4), outbox (4.6), publicación de artefactos ni PDF. **CURRENT:** creación, reanálisis/snapshot, pin de contexto y manejo de estados `QUEUED`/`COMPLETED`/`REVIEW_REQUIRED`/`FAILED` implementados y verificados; 2.4/4.2/4.3 siguen parciales independientes.

### 3.4 Feedback y export

| Método | Ruta | Estado | Auth/rol | Request | Response | Errores |
|---|---|---|---|---|---|---|
| POST | `/feedback` | proposed | OFTALMOLOGO dueño | `{ consultationId, inferenceId, validatedClass, doctorNotes?, isGoldStandard?, doctorId?, predictedClass?, confidence?, agreement? }` | `200 Feedback` camelCase | `401`, `403`, `404`, `422` |
| GET | `/export/gold-standard` | proposed | Grant explícito (INVESTIGADOR/ADMIN) | `format`, `since`, `limit` | JSON/CSV pseudonimizado camelCase | `401`, `403`, `422` |

### 3.5 Administración, auditoría e historial

| Método | Ruta | Estado | Nota |
|---|---|---|---|
| GET | `/admin/users` | implemented (5.4/5.6/9.1) | Paginado `limit=20/100`, `offset>=0`, `role`, `isActive` literal, `q` literal email/fullName; `{items,total,limit,offset}`. |
| GET | `/admin/users/:id` | implemented (5.4/5.6/9.1) | Detalle seguro; `404` si no existe; `503` fail closed. |
| PATCH | `/admin/users/:id` | implemented (5.4/5.6/9.1) | Body estricto email/fullName/role/isActive; sin credenciales/actor; revocación y último admin; DELETE no implementado. |
| DELETE | `/admin/users/:id` | not planned | **No hay hard delete en este hito**, ni siquiera para cuentas sin actividad. La acción soportada es desactivación + revocación de sesiones; la supresión legal queda pendiente solo para producción. |
| GET | `/admin/audit` | deferred | Auditoría operativa append-only, mínimo PHI. |
| GET | `/consultations` | deferred | Historial/filtros/paginación, sin frontend en este hito. |

> **Alta administrativa (H3):** al retirar `POST /auth/register` (`410`), `POST /admin/users` está **implementado (1.8)** como alta controlada desde el primer release. GET listado/detalle y PATCH están implementados en 5.4/5.6/9.1; DELETE no está implementado (404/405, sin hard delete). La protección del último admin se aplica desde la ruta de cambio/desactivación. Toda cuenta nueva MUST auditar alta, grant y asignación de rol; el default es clínico regular (`OFTALMOLOGO`) y `ADMIN` solo puede asignarse por un admin autenticado y auditado. No se deja registro público "por falta de UI": el backend/API se entrega sin frontend.

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

### 4.6 ClinicalSnapshotContext (interno backend ↔ ML; NO público)

`POST /v1/clinical-snapshots/prepare` es un endpoint interno autenticado con el token de servicio ML. No lo consume el frontend y no se publica a través del proxy clínico. Forma estricta:

| Campo | Tipo | Regla |
|---|---|---|
| `clinical_features` | objeto | Exactamente las 11 variables canónicas, números finitos; `extra=forbid`. |
| `requested_model_version` | string\|null | Opcional. Si no es null, debe coincidir con la versión efectiva del manifiesto o `422`. Null resuelve el runtime actual; nunca `"v1"`. |
| `rawCanonical` | objeto | Respuesta: `{ clinicalFeatures: {...11} }`, sin `eyeSide` ni claves extra. |
| `normalizedPayload` | objeto | Respuesta: `{ orderedFeatureNames: [...11], dtype: "float32", values: [...11], descriptor, canonicalJson, contextFingerprintSha256 }`, sin `eyeSide`; valores reales del helper ML. |
| `normalizedPayload.descriptor` | objeto | Descriptor efectivo completo: `schema_version`, `model` (manifest/backend/class_names/ensemble/artifacts/binaries), `normalization` (mean/std con source, epsilon, orden, dtype) y `preprocessing`. Sin paths locales ni secretos. |
| `normalizedPayload.canonicalJson` | string | Bytes canónicos exactos usados para calcular la huella; el backend verifica `sha256(canonicalJson) === contextFingerprintSha256` sin recomputar el descriptor en JS. |
| `normalizedPayload.contextFingerprintSha256` | string | Debe coincidir con `contextFingerprintSha256` de nivel superior. |
| `schemaVersion` | string | Respuesta: `"ml-zscore-f32-v1"`. |
| `modelVersions` | objeto | Respuesta: no vacío; `manifest`, `backend` (`pytorch`\|`onnx` efectivo) y revisiones `repository@revision` verificadas. |
| `contextFingerprintSha256` | string | Respuesta: 64 hex lowercase; SHA-256 canónico del descriptor sin el campo huella. |

El backend añade el `eyeSide` autoritativo al persistir y valida la respuesta antes de cualquier escritura. Errores internos seguros: `401` token inválido, `404` no soportado ⇒ backend `503`, `422` versión/modelo inexistente, `503` runtime/contexto/artefacto no verificable. Sin URL, PHI, tokens ni trazas en body/log.

El job interno lleva `expectedContext: { schemaVersion, fingerprintSha256 }` y `MlClient` lo traduce a `expected_context: { schema_version, fingerprint_sha256 }`. El frontend no lo ve ni lo envía.

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
| `Idempotency-Key` | string | Sí (4.4) | Alcance durable autenticado + recurso. Misma key+payload ⇒ mismo `202` con mismo `inferenceId`/`jobId`. Misma key+payload distinto ⇒ `409`. **No implementada en 2.2**: no se emite `409` por idempotencia todavía. |
| `imageId` | UUID | Sí | Imagen autorizada; su lateralidad almacenada debe coincidir con `eyeSide` o `422`. Es la autoridad del ojo. |
| `eyeSide` | `"OD"\|"OS"` | Sí | Metadato; nunca se confía en un valor contradictorio ni se toma de la respuesta ML. |
| `clinicalFeatures` | objeto | Sí | 11 campos estrictos y finitos; única fuente del payload crudo. Nunca se completa desde `consultation.clinicalData`. |
| `modelVersion` | string\|null | No | En 2.2 se pasa a `requested_model_version`: si no es null y no coincide con la versión efectiva del manifiesto ⇒ `422`; null resuelve el runtime actual, nunca `"v1"`. |
| `reanalysisOf` | UUID | No | Crea ejecución nueva enlazada; no sobrescribe. Padre ajeno/inexistente ⇒ `404` uniforme; contexto de padre contradictorio ⇒ `422`. Padre legacy con consulta/ojo NULL usa la imagen autoritativa. |
| `expected_context` | — | Prohibido | Lo genera el backend desde `prepare`; el frontend no lo envía ni lo recibe. |
| `imageUrl` | — | Prohibido | No lo envía el frontend; el backend firma desde referencia confiable. |

**Reglas de 2.2 para la creación:** el orden es auth/rol → ownership de imagen → ownership del padre (si existe) → validar ojo → validar contexto del padre → `prepare` ML (timeout 15 s, sin reintentos infinitos) → validar respuesta estricta → TX (`ClinicalSnapshot` + `Inference QUEUED`) → commit → firmar URL/encolar. Una preparación `404`/no soportada, timeout, 5xx, JSON inválido, features alteradas, `eyeSide` en la respuesta o huella/versión inválida devuelve `503` sin DB y sin fallback sin pin. Si falla el SQL, no queda snapshot huérfano. Si falla storage/cola después del commit, la ejecución queda pendiente explícita para 4.6 y se responde `503`, no `202`. La creación **no** actualiza `consultation.status`; `COMPLETED` de ML no completa la consulta.

**Respuesta `202`:** `{ inferenceId: UUID, jobId: string, status: "QUEUED" }`. En el target 4.4, si se pierde el `202`, se reintenta con la misma key; no se exige consultar un ID nunca recibido. **En 2.2 (sin 4.4) no hay replay idempotente**: un `202` perdido no se reintenta a ciegas porque podría duplicar la ejecución; la key obligatoria y el replay siguen pendientes de 4.4. El modelo queda fijado; la URL firmada dinámica no forma parte del payload/fingerprint. **Mientras B3 no esté aprobado, no se purgan** registros de idempotencia, tombstones ni vínculos de inferencia necesarios para replay. Cuando B3 se apruebe, la retención podrá acotarse sin romper el horizonte de replay definido; no se promete replay eterno arbitrario, pero la política vigente es no purgar. **B2:** una consulta completada no se reabre ni altera automáticamente; `requiredExecutionIds` no se promueve ni reemplaza tras cierre y los reanálisis históricos no modifican el frozen set.

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
| Envío real de email forgot/reset | pendiente solo provisioning (B8), no bloquea 5.9 | 5.9 cerrada con `DISABLED` por defecto y sink en memoria solo para pruebas; no hay proveedor real, outbox ni garantía de entrega. Envío real futuro solo a destinatarios autorizados, sin PHI/enlaces secretos, sin versionar direcciones/credenciales. |
| `DatabaseFeedbackSource` | fuera de alcance (B9) | No añade SQLAlchemy ni bloquea el change. |
| Contexto clínico preparado (2.2) | implemented / QA PASSED (HITO19) | CURRENT: creación, reanálisis/snapshot, pin `expected_context` y manejo de estados implementados; H1 PASSED. No cierra 2.4/4.2/4.3 ni REG-002/003/004. |
| `requiredExecutionIds`/freeze (2.5) | deferred (B2) | 2.2 no lee ni modifica el conjunto requerido; no hay promoción ni reapertura tras cierre. |
| Agregación de consulta (2.3) y PDF (6.x) | deferred | La consulta no se autocompleta; `pollingStop`/`completionState` y PDF quedan para sus tareas. |
| Idempotencia `Idempotency-Key` (4.4) | deferred | 2.2 no implementa replay, no emite `409` por idempotencia y no exige la key. |
| Outbox/reconciliación (4.6) | deferred | Un fallo post-commit de storage/cola queda pendiente explícito; no se promete atomicidad Redis/outbox. |

## 11. Reglas de consumo para frontend

1. `POST /auth/register` está retirado (`410`); no usarlo para crear cuentas ni administradores. El primer admin se crea con el bootstrap controlado; el alta administrativa `POST /admin/users` está implementada (1.8) y GET/PATCH están implementados (5.4/5.6/9.1), sin frontend en este hito.
2. No guardar access tokens en `localStorage`; el refresh web va solo en la cookie `clearsight_refresh` (`HttpOnly/Secure/SameSite=Lax`, host-only, `Path=/api/auth`; ver 3.1.1).
3. En `429` de login, respetar `Retry-After`; no mostrar ni derivar contadores, emails ni estado de cuenta (mismo body generico para conocido y desconocido).
4. No enviar `imageUrl`; no construir URLs de storage; pedir URL nueva al backend si expira.
5. No asumir que `GET /inferences/:id` actual devuelve estado/artefactos; en TARGET sí, pero marcado `proposed`.
6. No usar un endpoint `/reanalysis` independiente; usar `POST /inferences` con `reanalysisOf`.
7. (Target 4.4) No reintentar sin `Idempotency-Key`; si se perdió el `202`, repetir la misma key. 2.2 no implementa la key: no reintentar a ciegas (ver regla 23).
8. No presentar `gradcam`/`shap` como disponibles; son `NOT_SUPPORTED`.
9. No presentar un PDF de revisión como caso completo.
10. No confundir `hashMd5` actual con `checksumSha256` target.
11. No mostrar unidades/categorías clínicas no verificadas como validadas.
12. No esperar un endpoint de aprobación de revisión ni un auto-complete manual; la resolución es un reanálisis con PDF independiente.
13. No ofrecer hard delete de usuarios: `DELETE /admin/users/:id` no está implementado (404/405); la acción soportada es desactivación + revocación de sesiones, sin borrado ni reasignación clínica.
14. No enviar login/refresh sin `Origin`: el origen debe coincidir exactamente con `AUTH_PUBLIC_ORIGIN` (sin wildcard); un mismatch es `403`.
15. No llamar a refresh en paralelo sin single-flight: dos refresh concurrentes del mismo token pueden revocar la sesión y su familia.
16. No leer la cookie `clearsight_refresh` desde JavaScript (`HttpOnly`), no esperar el refresh en el JSON y no usar la cookie sola como autorización de logout.
17. No interpretar `202` de `/auth/password/forgot` como prueba de que la cuenta existe, de que se emitió un token o de que el correo se entregó; es solo un acuse uniforme.
18. No enviar el token de reset en URL/query/fragmento ni en cabeceras, logs o JSON de terceros; `reset` usa solo `{ token, newPassword }` en el body y `Authorization` no lo sustituye.
19. No reintentar `forgot`/`reset` ignorando `Retry-After`: las cuotas son independientes del login y un `429` no debe traducirse en un bucle de reintentos.
20. Tras un `reset` `204`, no asumir sesión iniciada: no hay cookie/access nuevo y todas las sesiones previas quedan revocadas; volver al login. El lockout de login, si estaba vigente, no se limpia con el reset.
21. En 2.2, enviar las 11 `clinicalFeatures` como fuente autoritativa; no enviar `consultationId`, `clinicalData` ni confiar en que el backend las complete desde la consulta.
22. No llamar a `/v1/clinical-snapshots/prepare` desde el frontend ni enviar/recibir `expected_context`; es un contrato interno backend↔ML.
23. Si `POST /inferences` devuelve `503`, no asumir que se creó un trabajo ni reintentar a ciegas: 2.2 no implementa idempotencia 4.4 y el fallo puede ser previo a DB o post-commit pendiente de 4.6.
24. No asumir que un job `COMPLETED` completa la consulta: 2.2 elimina el autocompletado y 2.3/6.x siguen pendientes.
25. No presentar una ejecución `REVIEW_REQUIRED` como fallo reintentable ni como completa: se preserva el estado y el resultado parcial; la resolución sigue siendo un reanálisis.
