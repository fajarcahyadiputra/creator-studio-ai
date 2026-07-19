FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
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
# SceneDetect installs opencv-python while media extras install the headless
# distribution. Both own cv2, so restore one complete headless backend.
RUN --mount=type=cache,target=/root/.cache/pip \
  python -m pip install --upgrade pip setuptools wheel \
  && pip install --prefer-binary --retries "${PIP_RETRIES}" --timeout "${PIP_DEFAULT_TIMEOUT}" ".[media]" \
  && pip uninstall --yes opencv-python \
  && pip install --prefer-binary --force-reinstall --no-deps \
    --retries "${PIP_RETRIES}" --timeout "${PIP_DEFAULT_TIMEOUT}" \
    "opencv-python-headless>=4.12,<5" \
  && python -c "import cv2; assert hasattr(cv2, 'FaceDetectorYN'); assert hasattr(cv2, 'CascadeClassifier'); assert hasattr(cv2, 'data'); frontal=cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'); profile=cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml'); assert not frontal.empty() and not profile.empty()"
RUN useradd --create-home --uid 10001 creator \
  && mkdir -p /tmp/creator-studio \
  && chown -R creator:creator /app /tmp/creator-studio
USER creator
CMD ["python", "-m", "app.worker"]
