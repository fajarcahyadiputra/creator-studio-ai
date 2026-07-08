import logging
from time import perf_counter
from uuid import uuid4

from app.config import get_settings
from app.domain.contracts import TtsRequestPayload, TtsSpeechSegmentsDocument
from app.domain.tts_prompting import (
    TTS_SEGMENTATION_PROMPT_VERSION,
    build_tts_segmentation_payload,
    build_tts_segmentation_system_prompt,
)
from app.providers.base import ProviderRequestContext, StructuredOutputProvider
from app.providers.openai_structured import OpenAIStructuredOutputProvider

logger = logging.getLogger(__name__)


async def generate_tts_segments(
    *,
    request: TtsRequestPayload,
    user_preferences: dict[str, object] | None = None,
    provider: StructuredOutputProvider | None = None,
) -> dict[str, object]:
    settings = get_settings()
    request_id = str(uuid4())
    started = perf_counter()

    provider_code = settings.AUTO_CLIP_ANALYZER_PROVIDER or "openai"
    model_identifier = settings.AUTO_CLIP_ANALYZER_MODEL or "gpt-5.5"
    selected_provider = provider or _resolve_provider(provider_code)

    provider_result = await selected_provider.generate_structured(
        context=ProviderRequestContext(
            provider_code=provider_code,
            model_identifier=model_identifier,
            credential_reference="env:OPENAI_API_KEY",
            request_id=request_id,
        ),
        system_prompt=build_tts_segmentation_system_prompt(),
        input_payload=build_tts_segmentation_payload(request, user_preferences=user_preferences),
        schema=TtsSpeechSegmentsDocument.model_json_schema(),
        schema_name="tts_speech_segments",
    )
    document = TtsSpeechSegmentsDocument.model_validate(provider_result["output"])
    usage = provider_result.get("usage")
    provider_request_id = provider_result.get("provider_request_id")
    latency_ms = round((perf_counter() - started) * 1000, 2)

    logger.info(
        "tts segmentation completed",
        extra={
            "request_id": request_id,
            "provider": provider_code,
            "model": model_identifier,
            "provider_request_id": provider_request_id,
            "latency_ms": latency_ms,
            "segment_count": len(document.segments),
            "token_usage": usage if isinstance(usage, dict) else None,
            "prompt_version": TTS_SEGMENTATION_PROMPT_VERSION,
        },
    )
    return {
        "document": document.model_dump(mode="json"),
        "metadata": {
            "request_id": request_id,
            "provider": provider_code,
            "model": model_identifier,
            "provider_request_id": str(provider_request_id) if provider_request_id is not None else None,
            "latency_ms": latency_ms,
            "token_usage": usage if isinstance(usage, dict) else None,
            "prompt_version": TTS_SEGMENTATION_PROMPT_VERSION,
        },
    }


def _resolve_provider(provider_code: str) -> StructuredOutputProvider:
    if provider_code == "openai":
        return OpenAIStructuredOutputProvider()
    raise ValueError(f"Unsupported TTS segmentation provider: {provider_code}")
