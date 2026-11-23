# Clearsight
Clinical ophthalmology platform for glaucoma detection from bilateral retinographies (see PROJECT.md).
- frontend/: Next.js clinical UI
- backend/: Fastify API, Prisma data layer, BullMQ workers
- ml/: model architectures, ONNX inference, Grad-CAM, MLOps
- docker/: image build stubs
- scripts/: developer and MLOps helper stubs

----

## Frontend local

La interfaz se abre en `http://localhost:3000` con Docker Compose. El proxy de Next.js expone la API clínica en `/api`, con destino interno `http://backend:8000`. Para ejecutar Next.js directamente en el equipo, el destino predeterminado es `http://localhost:8080`. Se puede ajustar con `API_INTERNAL_URL`.

Configura `AUTH_PUBLIC_ORIGIN` con el origen exacto que abre el navegador. Para MinIO, configura `MINIO_BROWSER_ORIGIN` con su origen accesible desde ese navegador. Compose usa `http://localhost:9000` por defecto. Usa HTTPS para un origen de producción.

Para trabajar con un backend de pruebas alojado en Azure, consulta la [guía de conexión del proxy HTTPS](docs/proxy-azure.md).

Con el backend y el servicio ML listos, crea la primera cuenta ADMIN con `npm run admin:bootstrap` en el backend y usa **Usuarios** para crear la cuenta OFTALMOLOGO. Las instrucciones de migración, configuración y bootstrap están en [backend/README.md](backend/README.md).

### Prueba de humo del frontend

Desde la raíz del repositorio, ejecuta el bloque en PowerShell con Node.js 22 o posterior. Si tienes el servidor de desarrollo de Next.js abierto, detenlo antes de compilar la prueba.

```powershell
Set-Location frontend
npm.cmd ci
npx.cmd playwright install chromium
npm.cmd run test:smoke
```

La instalación de Chromium se necesita por cada versión de Playwright. En Linux, si faltan bibliotecas del sistema, usa `npx playwright install --with-deps chromium`. La prueba compila Next.js y comprueba sesión y recuperación de acceso, captura unilateral y bilateral, reintento sin duplicados, reanálisis por calidad, historial, evidencia, PDF y dictamen mediante una API de prueba local y una imagen generada. Funciona con puertos asignados automáticamente y sin credenciales de Azure.

Para revisar el recorrido a tu ritmo, ejecuta `npm.cmd run test:smoke -- --visual`. Chromium se abre maximizado y espera en cada pantalla. Pulsa Enter en PowerShell para recorrer inicio de sesión, estación clínica, captura, análisis, caso, variables, informe y dictamen. Después podrás revisar investigación, la consulta de ejecución y la administración de usuarios. Si cierras sesión durante la revisión del caso, la demo vuelve a abrirlo cuando pulses Enter. La última pantalla queda abierta hasta que pulses Enter o cierres Chromium.

El recorrido usa cuentas y resultados de demostración. Las retinografías y la evidencia del visor están marcadas como imágenes de demostración. En administración se pueden crear y editar cuentas locales de ejemplo. El recorrido automático también comprueba los permisos independientes de imágenes, resultados, PDF y exportación. Para verificar un estudio persistido en el backend, consulta la [guía del proxy y la prueba conectada](docs/proxy-azure.md).

# ML
The CNN segmentation model is here: [CNN model](https://huggingface.co/F4-bit/Clearsight-CD-Segmentation-CNN-Base-model)

## Notes:
Regarding the cropping step:
- The whole image is not used, which is why there's a cropping stage before the CNN
- The pipeline for cropping is in ml-raw/cropping_step.py

Regarding de CNN model (Segmentation step):
- The CNN used in the segmentation step uses postprocessing aside of the model itself. This is later useful for the CDR value
- The model is the result of the v3 section on ml-raw/experimento_proyecto.ipynb

Regarding the second phase (post cropping and segmentation):
There are three models used:
1. fold 4 efficientnet [Fold 4 efficientnet model](https://huggingface.co/F4-bit/fold_4_efficientnet_b3)
2. fold 4 resnet50 [Fold 4 resnet50 model](https://huggingface.co/F4-bit/fold_4_resnet_50)
3. fold 4 swin tiny [Fold 4 resnet50 model](https://huggingface.co/F4-bit/fold_4_swin_tiny) [MISSING --> retrain to load or recalcule ensamble's weights in order to use 1 and 2]
