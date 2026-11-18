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

El sistema SHALL adoptar el siguiente diseño técnico propuesto por el arquitecto dentro de la delegación industry; no es una decisión exacta de producto ni una funcionalidad ya implementada. El access token MUST ser un JWT breve con default 15 minutos, `sessionId` y `tokenVersion`. En cada request el servidor MUST consultar una sesión activa, la versión y el usuario activo/rol vigente en un store durable, y MUST aplicar fail closed si no puede verificar. El refresh token MUST ser opaco, generado con CSPRNG, almacenado como hash en reposo, rotado de forma atómica y de un solo uso; la reutilización MUST revocar la familia. Su expiración absoluta simple propuesta es 7 días, sin extensión por idle salvo configuración explícita. Logout MUST revocar la sesión de inmediato. Desactivar una cuenta MUST revocar todas las sesiones e incrementar la versión. Un cambio de rol MUST invalidar tokens y permisos de inmediato. El reset de contraseña MUST usar token de un solo uso, 30 minutos, hash, sin logs, y revocar todas las sesiones. `forgot` MUST responder `202` uniforme con rate limit y proveedor de envío configurable. Para web, el refresh MUST viajar en cookie `HttpOnly; Secure; SameSite` y no en JSON; si es cross-site, MUST evaluarse origen/CSRF. La respuesta de refresh MUST NOT exponer el refresh token. El access bearer MUST NOT sugerirse en `localStorage`. El cliente backend no-browser queda fuera de alcance. El envío real de email depende de datos de proveedor no acordados: eso bloquea solo la habilitación real del envío, no el diseño ni la implementación del flujo. Los tokens MUST NOT registrarse en logs ni incluirse en URLs.

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

#### Scenario: Refresh web

- **WHEN** el cliente web renueva la sesión
- **THEN** el refresh viaja en cookie HttpOnly/Secure/SameSite y la respuesta no expone el refresh token
- **AND** si es cross-site se evalúa origen/CSRF.

#### Scenario: Envío real de email no configurado

- **WHEN** no están aprobados proveedor, remitente y credenciales de email
- **THEN** el flujo de forgot/reset puede diseñarse e implementarse
- **AND** el envío real permanece deshabilitado hasta aprobación.

### Requirement: Desactivación y preservación de autoría

El sistema SHALL desactivar usuarios sin borrar su autoría ni su historial. Un usuario desactivado MUST NOT iniciar sesión ni usar sesiones previamente emitidas. Sus consultas, feedback y auditoría MUST permanecer íntegros y atribuidos.

#### Scenario: Usuario desactivado

- **WHEN** un administrador desactiva una cuenta
- **THEN** el usuario no puede autenticarse y sus sesiones dejan de ser válidas
- **AND** sus registros históricos conservan la autoría original.

#### Scenario: Intento de borrado con actividad

- **WHEN** se intenta borrar físicamente una cuenta con actividad clínica
- **THEN** el sistema lo deniega conforme a la política
- **AND** ofrece desactivación como alternativa.

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

El sistema SHALL limitar el borrado físico a cuentas sin actividad, conforme a la política aplicable, sin cascadas ni reasignación de historial. La desactivación MUST ser distinta de la supresión de identidad o legal. Mientras la política de supresión no esté aprobada, el sistema MUST NOT eliminar ni anonimizar automáticamente datos clínicos o de identidad.

#### Scenario: Cuenta sin actividad

- **WHEN** se solicita borrado físico de una cuenta sin actividad y la política lo permite
- **THEN** el sistema ejecuta el borrado conforme al procedimiento aprobado
- **AND** no afecta registros clínicos de terceros.

#### Scenario: Supresión sin política aprobada

- **WHEN** se solicita supresión de identidad de un paciente sin política aprobada
- **THEN** el sistema no elimina ni transforma automáticamente los datos
- **AND** registra la solicitud como pendiente de decisión.
