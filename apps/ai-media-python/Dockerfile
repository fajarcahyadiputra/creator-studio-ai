FROM python:3.12-slim-bookworm
COPY --from=denoland/deno:debian-2.6.9 /usr/bin/deno /usr/local/bin/deno
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
  && python -c "import cv2; assert hasattr(cv2, 'FaceDetectorYN'); assert hasattr(cv2, 'CascadeClassifier'); assert hasattr(cv2, 'data'); frontal=cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'); profile=cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml'); assert not frontal.empty() and not profile.empty()" \
  && python -c "import av, os, tempfile, wave; audio=tempfile.NamedTemporaryFile(suffix='.wav', delete=False); audio.close(); output=wave.open(audio.name, 'wb'); output.setnchannels(1); output.setsampwidth(2); output.setframerate(16000); output.writeframes(bytes(320)); output.close(); container=av.open(audio.name, mode='r', metadata_errors='ignore'); container.close(); os.unlink(audio.name)" \
  && python -c "import importlib.metadata, importlib.util; assert importlib.util.find_spec('yt_dlp_ejs'); importlib.metadata.version('bgutil-ytdlp-pot-provider')" \
  && deno --version
RUN useradd --create-home --uid 10001 creator \
  && mkdir -p /tmp/creator-studio \
  && chown -R creator:creator /app /tmp/creator-studio
USER creator
CMD ["python", "-m", "app.worker"]
