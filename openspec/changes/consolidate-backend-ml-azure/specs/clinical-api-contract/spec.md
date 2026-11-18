# Clinical API Contract — Delta Specification

## ADDED Requirements

### Requirement: Contrato HTTP único y explícito para frontend

El sistema SHALL publicar un contrato HTTP que indique, por endpoint, método, ruta, estado de implementación (`implemented`, `proposed` o `deferred`), autenticación, rol, ownership, request, response, errores y compatibilidad. El contrato MUST bastar para que frontend implemente sin leer código fuente y MUST distinguir con claridad las APIs diseñadas pero no implementadas.

#### Scenario: Consulta del contrato por frontend

- **WHEN** frontend necesita integrar un endpoint
- **THEN** encuentra en el contrato su método, ruta, estado, autenticación, body, response, errores y ownership
- **AND** no necesita inferir el contrato desde el código.

#### Scenario: Endpoint propuesto

- **WHEN** un endpoint figura como `proposed`
- **THEN** el contrato lo identifica como no implementado todavía
- **AND** no se presenta como disponible ni se simula su respuesta.

### Requirement: Autenticación y autorización por endpoint y recurso

El contrato SHALL declarar autenticación Bearer obligatoria para los endpoints clínicos, salvo salud y autenticación pública controlada. Cada endpoint MUST declarar roles permitidos, grants explícitos de datos y la comprobación de ownership del recurso. El default MUST ser denegar. Las rutas de lectura clínica MUST aplicar ownership y MUST NOT devolver datos de casos ajenos. `ADMIN` e `INVESTIGADOR` MUST requerir grant explícito al conjunto para export/dataset; el rol por sí solo MUST NOT conceder lectura clínica global ni PHI innecesaria. `GET /patients` MUST NOT quedar como “Bearer only”: en el target se restringe a pacientes de consultas propias del oftalmólogo, y admin/investigador solo acceden por grant o dataset autorizado.

#### Scenario: Acceso a consulta ajena

- **WHEN** un oftalmólogo autenticado solicita una consulta de otro médico
- **THEN** el backend responde `403` o `404` sin revelar datos clínicos
- **AND** no devuelve imágenes, inferencias ni artefactos del caso ajeno.

#### Scenario: Rol no autorizado

- **WHEN** un usuario con rol distinto del permitido invoca un endpoint
- **THEN** el backend responde `403` con error seguro
- **AND** no ejecuta la acción.

#### Scenario: ADMIN o investigador sin grant

- **WHEN** un administrador o investigador solicita export o dataset sin grant explícito al conjunto
- **THEN** el backend deniega la lectura
- **AND** no aplica un permiso global por rol.

#### Scenario: Endpoint sin autenticación

- **WHEN** un cliente invoca un endpoint clínico sin token válido
- **THEN** el backend responde `401`
- **AND** no revela si el recurso existe.

### Requirement: Envelope de error estable

El sistema SHALL devolver errores con un envelope estable que incluya `error`, `message` y `statusCode`. Los errores de validación MUST ser `422` o el código que el contrato declare, y MUST indicar campos inválidos sin filtrar secretos. Los errores de autorización, recurso inexistente y conflicto MUST usar códigos consistentes.

#### Scenario: Body inválido

- **WHEN** el cliente envía un body que no cumple el contrato
- **THEN** el backend responde con un error de validación estructurado
- **AND** no persiste ni encola una ejecución parcial.

#### Scenario: Conflicto de idempotencia

- **WHEN** el cliente reutiliza una clave de idempotencia con otro payload
- **THEN** el backend responde `409` con un código seguro
- **AND** el mensaje no revela datos de otra ejecución.

### Requirement: Separación entre contrato actual verificado y target vnext

El contrato SHALL separar explícitamente los endpoints y payloads **actuales verificados** de los endpoints y payloads **target vnext**. El contrato actual MUST describir solo lo que el código verificado devuelve hoy, incluyendo `accessToken` en login, `GET /inferences/:id` sin estado/artefactos y `POST /auth/register` público con rol elegible. El target MUST marcar cada endpoint/campo como `proposed`, `deferred`, `blocked` o `removed`, y MUST NOT presentar seguridad o campos propuestos como si ya existieran. El alta pública actual MUST llevar una advertencia de alta seguridad y no debe usarse para crear administradores; el target MUST cerrar el alta pública o reemplazarla por un endpoint admin-only concreto sin rol público.

#### Scenario: Contrato actual de login

- **WHEN** frontend revisa el contrato actual de login
- **THEN** ve `accessToken` y el resto del payload verificado
- **AND** no se le presenta un payload target como si fuera actual.

#### Scenario: Alta pública actual

- **WHEN** frontend considera usar `POST /auth/register`
- **THEN** el contrato lo marca como actual inseguro y no apto para crear `ADMIN`
- **AND** el target exige alta admin-only o cierre del endpoint público.

#### Scenario: Endpoint target no implementado

- **WHEN** un endpoint solo existe en target vnext
- **THEN** el contrato lo marca `proposed`/`deferred`/`blocked`
- **AND** no se consume como implementado.

### Requirement: Nombres canónicos, mapeo y lateralidad

El contrato clínico SHALL usar `camelCase` en la API del backend y el contrato ML SHALL usar `snake_case`; el mapeo entre ambos MUST documentarse y no mezclarse en una misma API pública. El target MUST incluir una tabla de equivalencias para feedback, export, ejecución y artefactos. `imageId` MUST corresponder a la lateralidad almacenada y un `eyeSide` contradictorio MUST rechazarse con `422`. El hash actual `hashMd5` MUST distinguirse del target `checksumSha256`; no se presentan como equivalentes.

#### Scenario: Cliente envía camelCase

- **WHEN** el cliente usa el contrato clínico target
- **THEN** envía `consultationId`, `inferenceId`, `validatedClass`, `doctorNotes`, `isGoldStandard`, `createdAt`
- **AND** el backend mapea esos nombres al contrato ML/DB sin ambigüedad.

#### Scenario: Lateralidad contradictoria

- **WHEN** `eyeSide` no coincide con la lateralidad almacenada de `imageId`
- **THEN** el backend responde `422`
- **AND** no crea una ejecución con datos contradictorios.

#### Scenario: Hash actual vs target

- **WHEN** el contrato muestra `hashMd5` actual y `checksumSha256` target
- **THEN** los distingue por endpoint y campo
- **AND** no afirma que el hash MD5 actual sea el checksum SHA-256 futuro.

### Requirement: Endpoints prioritarios de la consolidación

El contrato SHALL incluir al menos: salud, autenticación, pacientes, consultas, upload de imagen, ejecución/inferencia, estado de ejecución, URL de artefacto, feedback, export gold-standard y PDF. Los endpoints de historial/filtros/paginación, administración/auditoría operativa y APIs/documentación adicionales MUST figurar como diferidos si no se implementan en el primer hito.

#### Scenario: Flujo mínimo de análisis

- **WHEN** frontend implementa el flujo mínimo
- **THEN** puede autenticarse, crear o consultar paciente y consulta, subir una imagen sanitizada, solicitar una ejecución, consultar su estado, obtener URLs de artefactos y descargar el PDF
- **AND** cada paso tiene contrato y errores definidos.

#### Scenario: Funcionalidad diferida

- **WHEN** frontend busca historial, filtros, paginación o administración operativa
- **THEN** el contrato las marca como diferidas
- **AND** no se compromete un contrato definitivo que aún no existe.

### Requirement: Compatibilidad y evolución del contrato

El sistema SHALL conservar compatibilidad con los clientes actuales durante la migración. Los cambios incompatibles MUST documentarse y versionarse; MUST NOT romper campos que el frontend actual consume sin una estrategia de transición. Los alias clínicos legacy (`Phakic_Pseudophakic` y `Phakic/Pseudophakic`) MUST resolverse de forma canónica y documentada. La creación de ejecución y el reanálisis MUST usar `Idempotency-Key` obligatoria y un único endpoint canónico (`POST /inferences` con `reanalysisOf`); si se expone un alias, MUST delegar en el mismo contrato. El cliente MUST poder reintentar con la misma key si perdió el `202` sin necesitar un ID que nunca recibió.

#### Scenario: Cliente actual envía alias legacy

- **WHEN** un cliente envía `Phakic_Pseudophakic`
- **THEN** el backend lo normaliza al campo canónico `Phakic/Pseudophakic`
- **AND** el contrato documenta la equivalencia.

#### Scenario: Campo adicional no permitido

- **WHEN** el cliente envía un campo clínico no declarado
- **THEN** el backend rechaza el body por contrato estricto
- **AND** no ignora silenciosamente datos clínicos.

#### Scenario: Pérdida del `202`

- **WHEN** el cliente perdió la respuesta de creación
- **THEN** reintenta con la misma `Idempotency-Key` y payload
- **AND** recibe el mismo trabajo sin necesitar un ID previo.

#### Scenario: Reanálisis canónico

- **WHEN** frontend implementa reanálisis
- **THEN** usa `POST /inferences` con `reanalysisOf`
- **AND** no usa un segundo endpoint con semántica independiente.

### Requirement: URLs de artefactos y PDF en el contrato

El contrato SHALL documentar cómo solicitar URLs de artefactos y reportes/PDF, que el TTL es corto y que el cliente debe pedir una URL nueva si expira. Las respuestas MUST incluir estado del artefacto y MUST NOT incluir URLs persistidas como identidad. Los reportes MUST exponerse con `reportId` y `version` explícitos e inmutables; el cliente MUST NOT asumir que “el PDF” es un archivo único sobrescribible. El contrato MUST indicar que un PDF de revisión no declara completitud. El contrato MUST NOT ofrecer un endpoint ejecutable de aprobación de revisión ni un auto-completado manual; el endpoint de revisión queda `deferred` y no es target del producto actual. La resolución es un reanálisis con PDF independiente.

#### Scenario: Descarga de reporte

- **WHEN** frontend solicita una versión de reporte autorizada
- **THEN** recibe `reportId`, `version` inmutable, estado y URL firmada nueva
- **AND** si la versión no existe, recibe un estado explícito y no un enlace ficticio.

#### Scenario: PDF de revisión

- **WHEN** frontend consulta un reporte de una ejecución `REVIEW_REQUIRED`
- **THEN** el contrato y la respuesta indican la limitación
- **AND** el cliente no presenta el caso como completado.
