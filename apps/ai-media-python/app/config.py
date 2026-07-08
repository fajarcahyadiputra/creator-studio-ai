from functools import lru_cache

from pydantic import Field, HttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=True)

    NODE_ENV: str = "development"
    PYTHON_API_PORT: int = Field(default=8000, ge=1, le=65535)
    TEMPORAL_ADDRESS: str = "temporal:7233"
    TEMPORAL_NAMESPACE: str = "default"
    TEMPORAL_AUTO_CLIP_TASK_QUEUE: str = "auto-clipping"
    WEB_INTERNAL_BASE_URL: HttpUrl = HttpUrl("http://web-node:3000")
    INTERNAL_SERVICE_TOKEN: str = Field(min_length=32)
    TEMP_WORKDIR: str = "/tmp/creator-studio"
    CALLBACK_TIMEOUT_SECONDS: float = Field(default=10.0, gt=0, le=60)
    MEDIA_PROBE_TIMEOUT_SECONDS: float = Field(default=30.0, gt=0, le=180)
    AUDIO_EXTRACTION_TIMEOUT_SECONDS: float = Field(default=120.0, gt=0, le=900)
    TRANSCRIPTION_TIMEOUT_SECONDS: float = Field(default=600.0, gt=0, le=14400)
    RENDER_OUTPUT_TIMEOUT_SECONDS: float = Field(default=900.0, gt=0, le=14400)
    FASTER_WHISPER_MODEL_SIZE: str = "small"
    FASTER_WHISPER_DEVICE: str = "cpu"
    FASTER_WHISPER_COMPUTE_TYPE: str = "int8"
    AUTO_CLIP_ANALYZER_MODE: str = "openai"
    AUTO_CLIP_ANALYZER_PROVIDER: str | None = "openai"
    AUTO_CLIP_ANALYZER_MODEL: str | None = "gpt-5.5"
    OPENAI_API_KEY: str | None = None
    OPENAI_BASE_URL: HttpUrl = HttpUrl("https://api.openai.com/v1")
    OPENAI_TIMEOUT_SECONDS: float = Field(default=45.0, gt=0, le=120)
    TTS_MODEL_DIR: str = "/models/tts"
    PIPER_COMMAND: str = "piper"
    TTS_SAMPLE_TEXT: str = "Halo, ini adalah sample suara untuk preview model TTS."


@lru_cache
def get_settings() -> Settings:
    return Settings()
