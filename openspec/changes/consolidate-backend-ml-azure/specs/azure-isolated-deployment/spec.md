# Azure Isolated Deployment — Delta Specification

## ADDED Requirements

### Requirement: Provisión aislada por ejecución con alcance confirmado

El sistema SHALL preparar el despliegue Azure como una ejecución aislada que crea recursos con prefijo único y tags de entorno. Antes de crear cualquier recurso, el operador MUST confirmar suscripción, alcance de recursos, presupuesto numérico y duración máxima. Si esos datos no están acordados, el despliegue MUST quedar bloqueado; el diseño y la documentación MUST seguir siendo válidos. La capa gratuita MUST NOT asumirse ni prometerse. El contexto CLI read-only verificado (default `Enabled`/`AzureCloud`, `group list` vacío) satisface solo el prerequisito de CLI y MUST NOT interpretarse como capa gratuita, cuota, RBAC de creación ni permiso de gasto. Sin presupuesto numérico, duración, scope y confirmación de contexto/permisos justo antes de crear, el deploy MUST seguir bloqueado.

#### Scenario: Contexto CLI verificado

- **WHEN** el operador confirma que existe un contexto CLI default activo y lecturas read-only devuelven una suscripción `Enabled` sin recursos del run
- **THEN** el sistema registra solo el prerequisito de CLI satisfecho
- **AND** no declara capa gratuita, cuotas, RBAC de creación, permiso de gasto ni deployment ready.

#### Scenario: Datos de alcance confirmados

- **WHEN** el operador confirma suscripción, alcance, presupuesto y duración conforme al procedimiento aprobado
- **THEN** el despliegue puede crear los recursos aislados del run
- **AND** registra los parámetros en el manifest del run sin exponer secretos.

#### Scenario: Presupuesto no acordado

- **WHEN** falta el presupuesto numérico o el alcance confirmado
- **THEN** el despliegue se bloquea antes de crear recursos
- **AND** el sistema no crea ni modifica infraestructura.

### Requirement: Prohibición de leer o exponer `.env.azure`

El sistema MUST NOT leer, imprimir, registrar ni usar `.env.azure` como evidencia de despliegue. Cualquier script futuro MUST consumir configuración solo mediante un procedimiento seguro aprobado y MUST NOT mostrar valores sensibles en logs, artifacts o consola.

#### Scenario: Script de despliegue

- **WHEN** un script de despliegue necesita configuración de Azure
- **THEN** la obtiene por el procedimiento seguro aprobado
- **AND** no lee `.env.azure` ni imprime sus valores.

#### Scenario: Logs de despliegue

- **WHEN** se revisan logs o artifacts de un run
- **THEN** no contienen secretos, claves ni valores de configuración sensibles
- **AND** solo contienen identificadores y resultados seguros.

### Requirement: Manifest de recursos y cleanup en `finally`

El script de despliegue SHALL escribir un manifest de los recursos creados durante el run. El cleanup MUST ejecutarse en `finally` y, si la sesión se interrumpe, MUST existir una ejecución de limpieza separada. El script MUST NOT borrar recursos existentes ajenos al run. El cleanup MUST ser idempotente y MUST registrar su resultado.

#### Scenario: Despliegue interrumpido

- **WHEN** la sesión de despliegue se interrumpe
- **THEN** el manifest permite identificar y limpiar los recursos creados por el run
- **AND** la limpieza puede ejecutarse fuera de la sesión original.

#### Scenario: Recurso preexistente ajeno

- **WHEN** el run encuentra un recurso con el mismo nombre pero sin las tags o el prefijo del run
- **THEN** no lo reutiliza ni lo borra
- **AND** falla o elige otro nombre de forma segura.

### Requirement: Verificación de borrado y recursos residuales

El sistema SHALL verificar el borrado de los recursos del run, considerando que la eliminación puede ser asíncrona. MUST revisar recursos residuales como discos, registros de contenedor, almacenamiento, bases de datos e IPs. Si el cleanup falla o queda pendiente, MUST reportar el estado `pending` con acciones concretas y MUST NOT declarar los recursos como destruidos sin verificación.

#### Scenario: Borrado asíncrono

- **WHEN** el comando de eliminación retorna antes de que el recurso desaparezca
- **THEN** el script verifica periódicamente hasta confirmar ausencia o agotar el límite
- **AND** reporta el estado real.

#### Scenario: Recurso residual

- **WHEN** queda un disco, storage o base de datos asociado al run
- **THEN** el script lo reporta como residual con su identificador seguro
- **AND** no declara el run completamente destruido.

### Requirement: Separación entre bloqueo de deploy y bloqueo de diseño

El sistema SHALL distinguir los vacíos que bloquean el despliegue de los que bloquean una tarea puntual. La falta de presupuesto, suscripción, alcance o duración MUST bloquear el deploy, pero MUST NOT impedir completar la documentación, los contratos, las pruebas con stub o el diseño de seguridad. La disponibilidad de CLI o de un contexto default MUST NOT eliminar ese bloqueo; solo un presupuesto/duración/scope confirmados y permisos/quota verificados justo antes de crear habilitan el despliegue.

#### Scenario: Diseño sin deploy

- **WHEN** el presupuesto de Azure no está aprobado
- **THEN** el equipo puede completar contratos, tareas y pruebas con stub
- **AND** no se declara el entorno Azure como desplegado o listo para ejecutar.

#### Scenario: Tarea dependiente de Azure

- **WHEN** una tarea requiere crear recursos reales
- **THEN** permanece bloqueada y sin marcar como completada
- **AND** no se sustituye por una simulación presentada como real.

### Requirement: Pruebas con recursos creados sin filtrar secretos

Las pruebas que creen recursos MUST usar datos y configuración autorizados, MUST limpiar los recursos creados y MUST NOT persistir secretos en artifacts, logs o commits. Los datos de prueba MUST ser sintéticos o provenir de un conjunto de uso autorizado; MUST NOT usarse PHI real sin base legal y procedimiento aprobados.

#### Scenario: Prueba con recurso creado

- **WHEN** una prueba crea un recurso en Azure
- **THEN** registra el recurso en el manifest de la prueba
- **AND** lo limpia al finalizar o reporta el pendiente sin ocultarlo.

#### Scenario: Datos de prueba

- **WHEN** se preparan datos para pruebas de integración
- **THEN** se usan datos sintéticos o un dataset de uso autorizado
- **AND** no se incluyen datos personales reales ni secretos.
