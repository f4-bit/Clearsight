# Identity, Access and Audit — Delta Specification

## ADDED Requirements

### Requirement: Tres roles con mínimo privilegio y default deny

El sistema SHALL soportar los roles `ADMIN`, `OFTALMOLOGO` e `INVESTIGADOR`. `ADMIN` MUST gestionar usuarios y operación sin lectura clínica por defecto. `OFTALMOLOGO` MUST acceder solo a sus propios casos. `INVESTIGADOR` MUST acceder solo a conjuntos explícitamente autorizados para investigación. `ADMIN` e `INVESTIGADOR` MUST requerir un grant explícito al conjunto de datos para export, dataset de investigación o cualquier lectura clínica; no existe permiso global implícito por rol. El sistema MUST aplicar default deny por endpoint, acción, recurso y dato, incluyendo artefactos, PDF, feedback, export e historial, y MUST minimizar PHI en cada respuesta.

#### Scenario: ADMIN sin lectura clínica por defecto

- **WHEN** un administrador intenta abrir una consulta clínica que no le corresponde por una autorización explícita
- **THEN** el sistema deniega la lectura clínica
- **AND** permite solo las operaciones administrativas autorizadas.

#### Scenario: ADMIN solicita export sin grant

- **WHEN** un administrador solicita export gold-standard o un dataset de investigación sin grant explícito al conjunto
- **THEN** el sistema deniega la solicitud
- **AND** no aplica un permiso global por rol `ADMIN`.

#### Scenario: Investigador con grant limitado

- **WHEN** un investigador tiene grant solo para un conjunto concreto y solicita otro conjunto
- **THEN** el sistema deniega el acceso
- **AND** no revela la existencia de casos fuera de su alcance.

#### Scenario: Médico accede a caso ajeno

- **WHEN** un oftalmólogo solicita un caso de otro médico
- **THEN** el sistema deniega la operación
- **AND** no comparte casos entre médicos en el primer hito.

### Requirement: Bootstrap de administrador controlado

El sistema SHALL crear el primer administrador mediante un procedimiento controlado de despliegue o CLI. El sistema MUST NOT exponer un endpoint público que permita registrarse con rol `ADMIN` o elegir el rol en el alta pública. El alta de usuarios MUST realizarse por administrador o por invitación solo si esa funcionalidad se implementa en el hito; la invitación MUST NOT inventarse como requisito obligatorio. Al retirar el registro público, el sistema MUST ofrecer un alta administrativa prioritaria (`POST /admin/users`) sin frontend, con default clínico regular `OFTALMOLOGO`; `ADMIN` MUST asignarse solo por un admin autenticado y auditado. Toda cuenta nueva MUST auditar alta, grant y asignación de rol. La protección del último admin MUST aplicarse desde que existan rutas de cambio o desactivación, aunque la lectura/edición admin completa quede diferida.

#### Scenario: Registro público con rol ADMIN

- **WHEN** un cliente intenta registrarse enviando `role=ADMIN` por un endpoint público
- **THEN** el sistema rechaza la solicitud o ignora el rol sin crear un administrador
- **AND** no eleva privilegios por datos del cliente.

#### Scenario: Bootstrap controlado

- **WHEN** se ejecuta el procedimiento de bootstrap aprobado en un entorno autorizado
- **THEN** se crea el primer administrador de forma auditable
- **AND** el procedimiento no queda expuesto como endpoint público.

### Requirement: Autenticación con bloqueo HU01 y rate limit

El sistema SHALL bloquear una cuenta durante 15 minutos tras cinco intentos fallidos de login **consecutivos**. Un login exitoso intermedio MUST reiniciar el contador de fallos. Un login exitoso durante el bloqueo MUST NOT levantar el bloqueo ni conceder sesión hasta que expire. El bloqueo MUST complementarse con rate limit por IP y MUST devolver mensajes genéricos que no permitan enumerar usuarios o distinguir si el correo existe. Las contraseñas MUST almacenarse con un hash robusto y actualizado, nunca en claro.

#### Scenario: Cinco fallos consecutivos

- **WHEN** una cuenta acumula cinco intentos fallidos consecutivos
- **THEN** el sistema bloquea nuevos intentos de esa cuenta durante 15 minutos
- **AND** el mensaje no revela si la cuenta existe.

#### Scenario: Éxito intermedio reinicia el contador

- **WHEN** una cuenta acumula fallos, luego inicia sesión correctamente y después vuelve a fallar
- **THEN** el contador de fallos consecutivos se reinicia con el éxito
- **AND** el nuevo bloqueo solo se activa al completar cinco fallos consecutivos posteriores.

#### Scenario: Carrera de intentos concurrentes

- **WHEN** dos intentos fallidos concurrentes cruzan el umbral de cinco para la misma cuenta
- **THEN** el almacén atómico registra el bloqueo una sola vez
- **AND** ninguna combinación de carreras permite superar el umbral sin bloquear.

#### Scenario: Éxito durante el bloqueo

- **WHEN** el bloqueo de 15 minutos sigue vigente y el cliente envía credenciales correctas
- **THEN** el sistema mantiene el bloqueo hasta que expire
- **AND** no concede sesión ni reinicia el bloqueo por ese intento.

#### Scenario: Rate limit complementario

- **WHEN** un cliente supera el límite de intentos permitido por IP
- **THEN** el sistema responde con limitación temporal
- **AND** no procesa el intento de autenticación.

### Requirement: Sesiones, refresh, logout y recuperación seguros

El sistema SHALL adoptar el siguiente diseño técnico propuesto por el arquitecto dentro de la delegación industry; no es una decisión exacta de producto. El contrato web 5.8 está implementado y validado por QA; el reset de contraseña está implementado en R2/HITO17 y 5.9 QA PASSED. El access token MUST ser un JWT breve con default 15 minutos, `sessionId` y `tokenVersion`. En cada request el servidor MUST consultar una sesión activa, la versión y el usuario activo/rol vigente en un store durable, y MUST aplicar fail closed si no puede verificar. El refresh token MUST ser opaco, generado con CSPRNG, almacenado como hash en reposo, rotado de forma atómica y de un solo uso; la reutilización MUST revocar la familia. Su expiración absoluta simple propuesta es 7 días, sin extensión por idle salvo configuración explícita. Logout MUST revocar la sesión de inmediato. Desactivar una cuenta MUST revocar todas las sesiones e incrementar la versión. Un cambio de rol MUST invalidar tokens y permisos de inmediato. El reset de contraseña MUST usar token de un solo uso, 30 minutos, hash, sin logs, y revocar todas las sesiones. `forgot` MUST responder `202` uniforme con rate limit y proveedor de envío configurable.

Para web (contrato 5.8), el login MUST conservar la respuesta JSON actual y entregar el refresh opaco CSPRNG solo en una cookie `clearsight_refresh` con `HttpOnly`, `Secure`, `SameSite=Lax`, host-only (sin `Domain`) y `Path=/api/auth`; la aplicación corre detrás de un proxy HTTPS que quita `/api` y expone internamente `/auth/*`; la expiración de la cookie MUST NOT superar la sesión absoluta (≤ 7 días). `POST /auth/refresh` MUST usar solo esa cookie (sin body y sin `Bearer`) y devolver únicamente `accessToken`, `tokenType` y `expiresIn`; la rotación MUST ser single-use; en DB MUST guardarse solo el hash SHA-256 lowercase y el token crudo MUST NOT aparecer en logs, auditoría ni JSON. La familia MUST ser la sesión y sus refresh: ante dos solicitudes concurrentes del mismo token, como máximo una MUST emitir y la otra MUST revocar esa sesión y todos sus refresh, sin afectar otras sesiones del usuario, sin ventana de gracia. Login y refresh MUST exigir `Origin` exactamente igual a `AUTH_PUBLIC_ORIGIN` (URL `http(s)` normalizada, sin wildcard) y MUST rechazar con `403` genérico antes de KDF/store si falta, es null o no coincide; `Sec-Fetch-Site: cross-site` MUST rechazarse si viene. El origen MUST NOT derivarse de `Host`/`X-Forwarded-*` no confiables ni de CORS wildcard. Si `AUTH_PUBLIC_ORIGIN` falta, los endpoints de cookie MUST fallar cerrado (`503`) sin romper `buildApp` lazy ni el `410` de `/auth/register` retirado. Logout MUST exigir `Bearer` de una sesión válida, revocar esa sesión y su cadena con auditoría, responder `204` y limpiar la cookie con los mismos atributos; la cookie sola MUST NOT autorizar y solo un `Origin` presente MUST pasar el mismo guard. Las pruebas locales MUST usar HTTPS/proxy documentado y MUST NOT deshabilitar `Secure` en producción ni como excepción silenciosa. Los errores MUST ser genéricos (`401/403/503`) y las respuestas de credenciales MUST llevar `Cache-Control: no-store`. Login MUST NOT setear cookie si falla sign/auditoría/commit; refresh MUST NOT consumir el padre si falla sign/auditoría; el reuso MUST confirmar revocación+auditoría y después devolver `401`, sin lanzar dentro de la transacción revirtiendo la revocación; auditoría caída MUST devolver `503` con rollback y MUST NOT declarar logout exitoso. `/auth/me` MUST NOT cambiar. La ausencia de body/`Bearer` en refresh describe el mecanismo de autenticación y no prohíbe la coexistencia de headers; si llegan, MUST NOT usarse como credencial ni sustituir la cookie, y su presencia sola no es error. La respuesta de refresh MUST NOT exponer el refresh token. El access bearer MUST NOT sugerirse en `localStorage`. El cliente backend no-browser queda fuera de alcance. **B8 queda como restricción de provisioning:** el usuario autoriza usar sus correos reales cuando se llegue, pero direcciones y proveedor aún no están fijados. Las pruebas MUST usar primero un adaptador con sink en memoria; el envío real solo se habilitará a destinatarios autorizados explícitos, para casos sin PHI y sin enlaces secretos no autorizados, sin versionar direcciones/datos personales/credenciales, con rate limiting y sin user enumeration. Los tokens MUST NOT registrarse en logs ni incluirse en URLs.

#### Scenario: Verificación por request

- **WHEN** llega una request autenticada
- **THEN** el servidor verifica sesión activa, `tokenVersion`, usuario activo y rol vigente
- **AND** si el store no es verificable, deniega con fail closed.

#### Scenario: Rotación y reutilización de refresh

- **WHEN** se usa un refresh token válido y luego se reutiliza el anterior
- **THEN** la rotación es atómica y de un solo uso
- **AND** la reutilización revoca la familia de sesiones.

#### Scenario: Logout y desactivación

- **WHEN** el usuario hace logout o un administrador desactiva la cuenta
- **THEN** la sesión se revoca de inmediato
- **AND** la desactivación revoca todas las sesiones e incrementa la versión.

#### Scenario: Cambio de rol

- **WHEN** cambia el rol de un usuario con sesiones activas
- **THEN** los tokens y permisos anteriores dejan de ser válidos de inmediato
- **AND** la siguiente request usa el rol vigente.

#### Scenario: Recuperación de contraseña

- **WHEN** se solicita forgot o reset
- **THEN** forgot responde `202` uniforme con rate limit
- **AND** reset usa token de un solo uso de 30 minutos, hash, sin logs, y revoca todas las sesiones.

#### Scenario: Login entrega refresh solo en cookie

- **WHEN** un cliente web completa el login correctamente con un `Origin` permitido
- **THEN** recibe la respuesta JSON actual y el refresh opaco solo en la cookie `clearsight_refresh`
- **AND** la cookie es `HttpOnly; Secure; SameSite=Lax`, host-only, `Path=/api/auth` y expira dentro de la sesión absoluta (≤ 7 días).

#### Scenario: Refresh por cookie sin body

- **WHEN** el cliente web llama a `POST /auth/refresh` con la cookie y sin body
- **THEN** el sistema rota el refresh una sola vez y responde solo `accessToken`, `tokenType` y `expiresIn`
- **AND** no acepta `Bearer` ni devuelve el refresh en JSON.

#### Scenario: Reuso concurrente del mismo refresh

- **WHEN** dos solicitudes concurrentes presentan el mismo refresh
- **THEN** como máximo una emite el sucesor
- **AND** la otra revoca esa sesión y todos sus refresh, sin afectar otras sesiones del usuario, y se trata como `401` sin ventana de gracia.

#### Scenario: Origen público requerido en login y refresh

- **WHEN** `Origin` está ausente, es `null` o no coincide exactamente con `AUTH_PUBLIC_ORIGIN`
- **THEN** el sistema rechaza con `403` genérico antes de KDF/store
- **AND** rechaza `Sec-Fetch-Site: cross-site` si viene y no deriva el origen de `Host`/`X-Forwarded-*` ni de CORS wildcard.

#### Scenario: Configuración de origen ausente

- **WHEN** `AUTH_PUBLIC_ORIGIN` no está configurado
- **THEN** los endpoints de cookie fallan cerrado
- **AND** `buildApp` sigue construyendo lazy y `/auth/register` sigue retirado sin depender de ese valor.

#### Scenario: Logout revoca la sesión y limpia la cookie

- **WHEN** el cliente llama a `POST /auth/logout` con `Bearer` de una sesión válida
- **THEN** el sistema revoca esa sesión y su cadena con auditoría y responde `204`
- **AND** limpia `clearsight_refresh` con los mismos atributos y no acepta cookie sola como autorización.

#### Scenario: Fallos transaccionales no emiten ni consumen

- **WHEN** falla la firma, la auditoría o el commit en login o refresh
- **THEN** login no setea cookie y refresh no consume el padre
- **AND** el reuso confirma revocación+auditoría antes de devolver `401`; si la auditoría cae, responde `503` con rollback.

#### Scenario: Envío real de email no configurado

- **WHEN** no están fijados direcciones, proveedor y autorización de destinatarios
- **THEN** el flujo de forgot/reset se prueba con un adaptador de sink en memoria
- **AND** el envío real permanece deshabilitado.

#### Scenario: Envío real autorizado

- **WHEN** el usuario autoriza destinatarios explícitos
- **THEN** el envío real solo usa esos destinatarios, sin PHI ni enlaces secretos no autorizados, sin versionar direcciones/datos personales/credenciales, con rate limit y sin user enumeration.

### Requirement: Recuperación de contraseña con cuotas independientes y entrega configurable

El sistema SHALL exponer `POST /auth/password/forgot` y `POST /auth/password/reset` como endpoints públicos sin sesión ni cookie. `forgot` MUST aceptar un email canónico y responder `202` con un body fijo y genérico para cuenta conocida, desconocida o inactiva, sin token, usuario ni estado de entrega; ese `202` MUST ser solo un acuse de recepción y MUST NOT interpretarse como prueba de emisión o entrega. `reset` MUST aceptar `{ token, newPassword }`, MUST autorizar únicamente con el token del body y MUST responder `204` sin crear sesión ni emitir cookie/access token. `Authorization` MUST NOT sustituir al token ni usarse como credencial; un body con campos o claims desconocidos MUST rechazarse con `400`.

Las cuotas de recuperación MUST ser durables, de ventana fija desde el primer intento y **independientes** de login/HU01 y de `auth_login_buckets`: `forgot` MUST permitir 3 intentos por email canónico y 3600 s y 20 por IP de socket y 3600 s; `reset` MUST permitir 20 por IP de socket y 900 s. Cada request con esquema válido de `forgot` MUST consumir primero la cuota IP y después la de email, aunque el email ya esté agotado; `reset` MUST consumir la cuota IP antes del lookup del token y de cualquier KDF bcrypt. Un `429` MUST usar body genérico y `Retry-After` entero `>= 1`; un fallo del store de cuotas antes del lookup MUST responder `503` genérico para cualquier cuenta. La IP MUST provenir del socket; el sistema MUST NOT habilitar `trustProxy` global ni confiar en `X-Forwarded-For`/`Forwarded` del cliente.

El token de recuperación MUST ser de un solo uso, 32 bytes de CSPRNG en base64url (43 caracteres), expirar a los 30 minutos y almacenarse solo como hash SHA-256 lowercase. El boundary `expiresAt <= now`, un token inválido, consumido, revocado o de usuario inactivo MUST responder `401` genérico; un usuario inactivo MUST NOT reactivarse. `reset` exitoso MUST ejecutarse en una transacción auditada con bcrypt cost 12, incrementar `tokenVersion` exactamente una vez (invalidando los access tokens previos), consumir el token usado, revocar los demás `PasswordResetToken`, todas las `UserSession` y todos los `RefreshToken` del usuario, y responder `204`; MUST NOT modificar `failedLoginCount`, `lockedUntil` ni `auth_login_buckets`, por lo que el lockout de login vigente se conserva. Un fallo de store, auditoría o hash MUST responder `503` con rollback sin cambio ni consumo.

La entrega de email MUST ser un puerto inyectable con modo deshabilitado por defecto; sin un sink explícito de pruebas, `forgot` MUST responder `202` sin generar token y sin invalidar tokens anteriores. Con sink habilitado, el token, la revocación de anteriores y la auditoría MUST confirmarse antes de la entrega; un fallo de auditoría MUST revertir la creación y no entregar, y un fallo de entrega MUST devolver `202` sin prometer entrega y registrar el fallo operativo sin email ni token crudos. Dos `forgot` exitosos del mismo usuario MUST serializarse por usuario y solo el token de la última transacción comprometida MUST permanecer válido. El sink en memoria MUST ser exclusivo de pruebas, recibir `recipient` y token crudo sin persistirlos en logs/JSON/URLs, no exponerse por HTTP y no contener enlaces con el token. 5.9 quedó cerrada con esta entrega `DISABLED`/memory sink; no hay outbox ni proveedor real. B8 sigue pendiente de provisioning sin bloquear el cierre y `202` no garantiza entrega.

#### Scenario: Forgot uniforme sin enumeración

- **WHEN** se solicita `forgot` para una cuenta conocida activa, una cuenta inactiva o un email inexistente
- **THEN** las tres respuestas son `202` con el mismo body fijo, sin token, usuario ni estado de entrega
- **AND** no se genera token para cuenta inexistente o inactiva.

#### Scenario: Cuotas de forgot independientes y ordenadas

- **WHEN** se superan 3 intentos válidos en 3600 s para el mismo email canónico
- **THEN** el siguiente intento responde `429` con `Retry-After >= 1`
- **AND** ese intento ya consumió primero la cuota IP y no consultó la cuenta;
- **AND** las cuotas y contadores de login/HU01 no cambian.

#### Scenario: Cuota de reset antes del token y del KDF

- **WHEN** se superan 20 intentos válidos en 900 s desde la misma IP de socket
- **THEN** `reset` responde `429` con `Retry-After >= 1` antes del lookup del token y de bcrypt
- **AND** un token inválido, expirado, usado, revocado o de usuario inactivo también consumió la cuota IP.

#### Scenario: Fallo del store de cuotas

- **WHEN** el store durable de cuotas no está disponible antes del lookup
- **THEN** `forgot` o `reset` responde `503` genérico para cualquier cuenta
- **AND** no se revela si el email o la cuenta existen.

#### Scenario: Entrega deshabilitada por defecto

- **WHEN** `forgot` se ejecuta sin sink de pruebas explícito
- **THEN** responde `202` sin generar token, sin invalidar tokens anteriores y sin envío real
- **AND** no se emite una credencial irrecuperable.

#### Scenario: Sink habilitado con auditoría antes de entrega

- **WHEN** `forgot` se ejecuta con sink de pruebas y la cuenta está activa
- **THEN** el token de 32 bytes/43 caracteres, el hash SHA-256 en DB, la revocación de tokens anteriores y la auditoría se confirman antes de la entrega
- **AND** si falla la auditoría, la creación se revierte y no se entrega;
- **AND** si falla la entrega, se responde `202`, se registra el fallo sin email/token y solo se revoca condicionalmente ese token exacto, sin afectar a otros ni a uno posterior.

#### Scenario: Dos forgot concurrentes

- **WHEN** dos `forgot` exitosos del mismo usuario compiten por emitir token
- **THEN** se serializan por usuario y la transacción que confirma en último lugar revoca el token anterior
- **AND** solo el último token comprometido es válido, aunque los correos lleguen en otro orden.

#### Scenario: Reset exitoso revoca credenciales y conserva lockout

- **WHEN** `reset` recibe un token vigente y un `newPassword` válido
- **THEN** responde `204` sin sesión/cookie nueva, con bcrypt cost 12 y un solo incremento de `tokenVersion`
- **AND** consume el token usado y revoca los demás reset tokens, todas las sesiones y todos los refresh del usuario en la misma transacción auditada;
- **AND** conserva `failedLoginCount`, `lockedUntil` y las cuotas de login, por lo que un lockout vigente sigue vigente.

#### Scenario: Reset inválido o inactivo

- **WHEN** `reset` recibe un token inválido, expirado, ya usado, revocado o de usuario inactivo
- **THEN** responde `401` genérico idéntico
- **AND** no cambia la contraseña, no consume otro token, no revoca sesiones y no reactiva la cuenta.

#### Scenario: Fallo transaccional de reset

- **WHEN** falla el store, la auditoría o el hash durante `reset`
- **THEN** responde `503` con rollback
- **AND** no cambia la contraseña, no consume el token ni revoca sesiones o refresh.

#### Scenario: Transporte sin sesión ni secreto en URL

- **WHEN** se invocan `forgot` o `reset`
- **THEN** no se leen ni emiten cookies, `Authorization` no sustituye al token y una `Origin` presente pasa la misma política exacta que logout (ausente se permite)
- **AND** todas las respuestas llevan `Cache-Control: no-store`, incluso los errores;
- **AND** el token no aparece en logs, JSON, cabeceras ni enlaces con URL/query/fragmento.

### Requirement: Desactivación y preservación de autoría

El sistema SHALL desactivar usuarios sin borrar su autoría ni su historial. La desactivación MUST revocar todas las sesiones emitidas e incrementar la versión; un usuario desactivado MUST NOT iniciar sesión ni usar sesiones previamente emitidas. Sus consultas, feedback y auditoría MUST permanecer íntegros y atribuidos. La desactivación MUST NOT hacer cascade delete ni reasignar historial.

#### Scenario: Usuario desactivado

- **WHEN** un administrador desactiva una cuenta
- **THEN** el usuario no puede autenticarse y sus sesiones dejan de ser válidas
- **AND** sus registros históricos conservan la autoría original.

#### Scenario: Intento de borrado con actividad

- **WHEN** se solicita borrado físico de una cuenta, con o sin actividad clínica
- **THEN** el sistema lo rechaza o no lo ofrece en este hito
- **AND** ofrece desactivación + revocación de sesiones como alternativa.

### Requirement: Protección del último administrador activo

El sistema MUST impedir que el último administrador activo sea desactivado o pierda el rol `ADMIN`. La comprobación MUST ser transaccional y resistente a carreras, de modo que dos operaciones concurrentes no puedan dejar el sistema sin administradores activos.

#### Scenario: Desactivación del último admin

- **WHEN** se intenta desactivar al único administrador activo
- **THEN** el sistema rechaza la operación
- **AND** no modifica el rol ni el estado de la cuenta.

#### Scenario: Carrera de dos administradores

- **WHEN** dos administradores intentan quitarse el rol simultáneamente
- **THEN** la transacción impide que ambos cambios dejen cero administradores activos
- **AND** al menos una operación falla de forma segura.

### Requirement: Auditoría append-only de acciones sensibles

El sistema SHALL registrar auditoría append-only de acciones sensibles con actor, target, acción, resultado y timestamp. La auditoría MUST NOT contener secretos, tokens, URLs firmadas ni PHI innecesaria. Si la auditoría de una operación sensible falla, la operación MUST NOT considerarse exitosa. Los registros MUST NOT actualizarse ni eliminarse desde la aplicación.

#### Scenario: Acción sensible auditada

- **WHEN** un administrador desactiva una cuenta
- **THEN** se registra actor, target, acción, resultado y timestamp
- **AND** el registro no incluye contraseñas, tokens ni datos clínicos innecesarios.

#### Scenario: Fallo de auditoría

- **WHEN** falla la escritura de auditoría durante una operación sensible
- **THEN** la operación no se reporta como exitosa
- **AND** el sistema aplica rollback o compensación explícita.

#### Scenario: Intento de alterar auditoría

- **WHEN** un proceso intenta actualizar o borrar un registro de auditoría
- **THEN** el sistema lo impide
- **AND** conserva el registro original.

### Requirement: Borrado físico excepcional y supresión de identidad

El sistema SHALL tratar la desactivación como la acción soportada para usuarios y MUST NOT implementar hard delete en este hito, ni siquiera para cuentas sin actividad. La desactivación MUST revocar sesiones y conservar autoría/historial, sin cascadas ni reasignación. La supresión de identidad/legal es distinta de la desactivación; mientras su política no esté aprobada, el sistema MUST NOT eliminar ni anonimizar automáticamente datos clínicos o de identidad. Cualquier excepción futura de hard delete requerirá política aprobada y no forma parte de este hito.

#### Scenario: Cuenta sin actividad

- **WHEN** se solicita hard delete de una cuenta sin actividad
- **THEN** el sistema lo rechaza o no lo ofrece en este hito
- **AND** ofrece desactivación + revocación de sesiones.

#### Scenario: Supresión sin política aprobada

- **WHEN** se solicita supresión de identidad de un paciente sin política aprobada
- **THEN** el sistema no elimina ni transforma automáticamente los datos
- **AND** registra la solicitud como pendiente de decisión.
