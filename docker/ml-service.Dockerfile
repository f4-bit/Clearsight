FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV TF_CPP_MIN_LOG_LEVEL=2
ENV TF_FORCE_GPU_ALLOW_GROWTH=true
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libgl1 \
        libglib2.0-0 \
        python3 \
        python3-dev \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel

WORKDIR /app
COPY ml /app/ml

RUN python3 -m pip install --no-cache-dir \
        torch==2.7.0 \
        torchvision==0.22.0 \
        --index-url https://download.pytorch.org/whl/cu126
RUN python3 -m pip install --no-cache-dir -e "/app/ml"

RUN useradd --create-home --uid 10001 clearsight
RUN mkdir -p /models \
    && chown -R clearsight:clearsight /app /models
USER clearsight

EXPOSE 8000
CMD ["uvicorn", "ml.service.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
