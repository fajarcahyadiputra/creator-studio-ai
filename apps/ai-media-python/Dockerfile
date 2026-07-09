FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=180 \
    PIP_RETRIES=10 \
    PIP_PROGRESS_BAR=off
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY apps/ai-media-python/pyproject.toml ./
COPY apps/ai-media-python/app ./app
COPY packages/contracts/json-schema ./packages/contracts/json-schema
RUN --mount=type=cache,target=/root/.cache/pip \
  python -m pip install --upgrade pip setuptools wheel \
  && pip install --prefer-binary --retries "${PIP_RETRIES}" --timeout "${PIP_DEFAULT_TIMEOUT}" ".[media]"
RUN useradd --create-home --uid 10001 creator \
  && mkdir -p /tmp/creator-studio \
  && chown -R creator:creator /app /tmp/creator-studio
USER creator
CMD ["python", "-m", "app.worker"]
