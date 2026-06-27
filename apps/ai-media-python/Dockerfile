FROM python:3.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY apps/ai-media-python/pyproject.toml ./
COPY apps/ai-media-python/app ./app
COPY packages/contracts/json-schema ./packages/contracts/json-schema
RUN pip install .
RUN useradd --create-home --uid 10001 creator \
  && mkdir -p /tmp/creator-studio \
  && chown -R creator:creator /app /tmp/creator-studio
USER creator
CMD ["python", "-m", "app.worker"]
