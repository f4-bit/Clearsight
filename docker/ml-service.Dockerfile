FROM python:3.11-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TF_CPP_MIN_LOG_LEVEL=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY ml /app/ml

RUN python -m pip install --no-cache-dir torch==2.7.0 torchvision==0.22.0 --index-url https://download.pytorch.org/whl/cpu
RUN python -m pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -e "/app/ml"

COPY models_cache /models

RUN useradd --create-home --uid 10001 clearsight \
    && mkdir -p /models \
    && chown -R clearsight:clearsight /app /models
USER clearsight

EXPOSE 8000
CMD ["uvicorn", "ml.service.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
