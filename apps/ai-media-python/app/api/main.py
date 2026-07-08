import secrets

from fastapi import FastAPI, Header, HTTPException, Query, Response, status

from app.application.local_tts_preview import (
    LocalTtsPreviewRequest,
    default_preview_text,
    synthesize_local_tts_preview,
)
from app.config import get_settings
from app.domain.tts_models import get_local_tts_model
from app.observability.logging import configure_logging

configure_logging()
app = FastAPI(title="Creator Studio AI Media API", version="0.1.0", docs_url=None, redoc_url=None)


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
async def ready() -> dict[str, str]:
    return {"status": "ready"}


def require_internal_service(authorization: str | None) -> None:
    expected = get_settings().INTERNAL_SERVICE_TOKEN
    candidate = authorization.removeprefix("Bearer ").strip() if isinstance(authorization, str) else ""
    if not candidate or not secrets.compare_digest(candidate, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@app.get("/internal/v1/tts/models/{model_key}/preview")
async def preview_local_tts_model(
    model_key: str,
    text: str | None = Query(default=None, max_length=500),
    authorization: str | None = Header(default=None),
) -> Response:
    require_internal_service(authorization)

    model = get_local_tts_model(model_key)
    if model is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Model not found")

    request = LocalTtsPreviewRequest(
        model_key=model.key,
        text=text.strip() if isinstance(text, str) and text.strip() else default_preview_text(model),
    )
    audio = synthesize_local_tts_preview(request)
    return Response(content=audio, media_type="audio/wav")
