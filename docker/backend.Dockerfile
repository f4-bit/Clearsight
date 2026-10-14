# syntax=docker/dockerfile:1

# Clearsight FastAPI backend image (python slim + uvicorn entrypoint).
FROM python:3.11-slim AS backend

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --upgrade pip setuptools wheel \
    && python -m pip install \
        "fastapi==0.115.6" \
        "uvicorn[standard]==0.34.0" \
        "pydantic==2.10.4" \
        "sqlalchemy==2.0.36" \
        "psycopg2-binary==2.9.10" \
        "redis==5.2.1" \
        "python-jose[cryptography]==3.3.0" \
        "passlib[bcrypt]==1.7.4" \
        "python-multipart==0.0.20"

COPY backend /app/backend
COPY scripts /app/scripts

RUN useradd --create-home --uid 10001 clearsight \
    && chown -R clearsight:clearsight /app
USER clearsight

EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
