# Clearsight
Clinical ophthalmology platform for glaucoma detection from bilateral retinographies (see PROJECT.md).
- frontend/: Next.js clinical UI
- backend/: FastAPI service, DB models, Celery workers
- ml/: model architectures, ONNX inference, Grad-CAM, MLOps
- docker/: image build stubs
- scripts/: developer and MLOps helper stubs

----

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