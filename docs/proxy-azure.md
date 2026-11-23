# Conectar el frontend de ClearSight al backend de Azure

El navegador llama a `/api/…` en el mismo origen que sirve la web. El servidor de Next.js recibe esa petición y la reenvía por HTTPS al backend de ClearSight. Por ejemplo, un inicio de sesión en `/api/auth/login` llega a `/auth/login` en Fastify. El proxy conserva el origen enviado por el navegador y transmite la cookie de sesión. El backend y el worker se comunican con el servicio ML.

| Componente | Variable | Valor para integración |
| --- | --- | --- |
| Servidor Next.js | `API_INTERNAL_URL` | Origen HTTPS del backend de ClearSight, sin ruta, credenciales ni parámetros. |
| Backend de pruebas | `AUTH_PUBLIC_ORIGIN` | Origen HTTPS exacto que abre el navegador. Para el frontend local preparado en este proyecto, `https://localhost:8443`. Para el frontend desplegado, su dominio HTTPS. |

El backend admite un único origen web por instancia. Usa una instancia de pruebas si otra web ya utiliza el backend con un origen distinto. `localhost` identifica el navegador de desarrollo a efectos de autenticación. Azure no inicia conexiones al portátil.

## Datos que debe compartir el equipo de Azure

- La URL base HTTPS del **backend de pruebas** de ClearSight y el tipo de acceso de su Container App.
- El origen web que tenga configurado en `AUTH_PUBLIC_ORIGIN`.
- Si el ingreso de la aplicación está limitado a su entorno de Container Apps, el frontend que ejecute el proxy debe estar en ese entorno o utilizar una ruta ya autorizada por el equipo. Una URL privada por sí sola no da acceso al portátil. [Red y acceso en Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/connect-apps)

## Prueba con el frontend local

Desde la raíz del repositorio, en PowerShell y con las dependencias del frontend instaladas, reemplaza el destino de ejemplo por la URL recibida.

```powershell
$env:API_INTERNAL_URL = "https://backend-de-pruebas.example"
npm.cmd --prefix frontend run dev:https
```

Abre `https://localhost:8443` cuando Next.js anuncie ese origen HTTPS. En el primer arranque, Next.js puede solicitar permiso para confiar en un certificado local de desarrollo. Si informa de que ha vuelto a HTTP, resuelve la instalación del certificado antes de iniciar sesión.

Para comprobar el trayecto desde una segunda terminal, con el certificado de desarrollo de confianza, ejecuta:

```powershell
curl.exe -i https://localhost:8443/api/auth/me
```

Con el backend de ClearSight accesible, la respuesta esperada sin sesión es `401`. Tras iniciar sesión con una cuenta de pruebas, recarga la página para verificar la renovación de la sesión. Ante un `403` en el inicio de sesión, compara el origen del navegador con `AUTH_PUBLIC_ORIGIN`. Ante un `503`, comprueba también la conectividad del proxy y la configuración del backend. Una descarga de evidencias o PDF requiere que el navegador pueda alcanzar la URL temporal de almacenamiento que autoriza el backend.

## Frontend desplegado en Azure

El script de despliegue del repositorio configura `API_INTERNAL_URL` en el frontend y `AUTH_PUBLIC_ORIGIN` en el backend con los dominios HTTPS asignados por Azure. Para aplicaciones ya desplegadas por otro medio, configura esas mismas variables en sus Container Apps. Si el navegador abre un dominio personalizado, usa ese origen exacto en el backend. Para ejecutar el ensayo directo `scripts/e2e_azure_pipeline.ps1` sobre ese entorno, pasa el mismo origen web en `-AuthOrigin`.

### Actualizar un entorno existente

- Usa el mismo SHA de `master` para construir las cuatro imágenes del despliegue: backend, worker, servicio ML y frontend. Actualiza las Container Apps existentes con los nombres completos del registro y ese SHA. Conserva PostgreSQL, Blob Storage y las referencias a sus secretos.
- Antes de construir ML, ejecuta `python -m scripts.prepare_azure_models` desde la raíz con las dependencias de ML instaladas. El script prepara `models_cache/` con los tres checkpoints del manifiesto y verifica sus SHA-256. El entorno Express usa `ML_INFERENCE_BACKEND=pytorch`, `ML_DEVICE=cpu` y `ML_MODEL_CACHE_DIR=/models`.
- Deja que el backend aplique la migración al arrancar y confirma que la revisión esté saludable. El worker usa la misma base, el mismo servicio ML y el mismo almacenamiento que el backend. Mantén al menos una réplica del worker para consumir la cola PostgreSQL.
- Usa el origen del frontend desplegado en `AUTH_PUBLIC_ORIGIN` cuando se abra ese frontend. Para la prueba desde el equipo de desarrollo, usa `https://localhost:8443` en una instancia que pueda dedicarse a ese origen.
- Comprueba una sesión de oftalmólogo, una inferencia con el ML desplegado, la reapertura del estudio y la descarga de PNG y PDF. Comprueba los permisos de investigación con una cuenta de prueba que tenga los grants correspondientes. Verifica la recuperación solo cuando esté configurado el relay SMTP.

Los pasos de operación del entorno Express y el procedimiento de migración están descritos en el [runbook del despliegue Azure](hito30-azure-e2e-express-runbook.md).

## Verificar un estudio del backend desplegado

Con Next.js conectado al backend, `npm.cmd --prefix frontend run test:connected` abre Chromium, inicia sesión y vuelve a abrir un estudio desde el historial del paciente. Comprueba la renovación de sesión al recargar, las variables clínicas y el cierre de sesión. Utiliza un paciente y un estudio de prueba del oftalmólogo. El recorrido es de lectura.

El proceso recibe `SMOKE_WEB_ORIGIN` (origen del **frontend**), `SMOKE_DOCTOR_EMAIL`, `SMOKE_DOCTOR_PASSWORD`, `SMOKE_PATIENT_ID` y `SMOKE_CONSULTATION_ID` mediante variables de entorno. La contraseña pertenece a la cuenta de pruebas del oftalmólogo.

Para crear un estudio de prueba y comprobar la inferencia, el almacenamiento y el PDF en Azure, ejecuta `scripts/e2e_azure_pipeline.ps1` con `-ExistingDoctor`, `-BackendBaseUrl`, `-AuthOrigin` y las credenciales de un oftalmólogo dedicado a pruebas. Esta modalidad omite la creación de usuarios y la escritura de dictámenes. Puedes incluir una retinografía autorizada para pruebas con `-ImagePath`. El resumen identifica el estudio de prueba para volver a abrirlo en el frontend.

## Servicios que intervienen en las nuevas vistas

- **Recuperación de acceso.** El backend entrega el código por correo cuando recibe `RESET_SMTP_HOST`, `RESET_SMTP_PORT` y `RESET_SMTP_FROM`. Si el relay requiere autenticación, configura `RESET_SMTP_USER` y `RESET_SMTP_PASSWORD` como secretos del backend. En producción el puerto 465 usa TLS implícito y los demás puertos requieren STARTTLS.
- **Evidencia clínica.** El servicio ML publica los contornos con CLAHE en el almacenamiento de la ejecución. Para los dos clasificadores del ensamble, PyTorch puede producir el mapa Grad-CAM de la clase seleccionada. En ONNX ambos archivos necesitan la salida `class_activation_maps` del exportador actualizado. Los modelos anteriores de una salida conservan su predicción. Una ejecución con revisión por calidad solo presenta la evidencia anatómica disponible.
- **Comprobación local.** Con el frontend compilado, `CLEARSIGHT_BROWSER_E2E=1` activa Chromium en la suite `e2e-clinical.integration.test.ts` del backend. El recorrido atraviesa Next.js, Fastify y PostgreSQL efímero. La suite sustituye ML y el almacenamiento. En Docker Desktop para Windows, `CLEARSIGHT_TEST_LOOPBACK=1` permite vincular el puerto del PostgreSQL de prueba explícitamente a loopback.
