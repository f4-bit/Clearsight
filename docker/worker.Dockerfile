# syntax=docker/dockerfile:1

# Clearsight Celery inference worker image (ONNX Runtime, CPU/CUDA provider).
FROM python:3.11-slim AS worker

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libgl1 \
        libglib2.0-0 \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install \
        "celery[redis]==5.4.0" \
        "redis==5.2.1" \
        "sqlalchemy==2.0.36" \
        "psycopg2-binary==2.9.10" \
        "onnxruntime==1.20.1" \
        "numpy==1.26.4" \
        "opencv-python-headless==4.10.0.84" \
        "prometheus-client==0.21.1"

COPY backend /app/backend
COPY ml /app/ml
COPY scripts /app/scripts

RUN useradd --create-home --uid 10001 clearsight \
    && chown -R clearsight:clearsight /app
USER clearsight

CMD ["celery", "-A", "backend.app.workers.celery_app", "worker", "--loglevel=info"]
