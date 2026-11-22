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
