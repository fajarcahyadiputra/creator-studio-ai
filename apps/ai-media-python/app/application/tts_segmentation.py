import logging
import re
from time import perf_counter
from uuid import uuid4

from app.config import get_settings
from app.domain.contracts import TtsRequestPayload, TtsSpeechSegment, TtsSpeechSegmentsDocument
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

    provider_code = _resolve_segmentation_provider_code(request, settings.AUTO_CLIP_ANALYZER_PROVIDER or "openai")
    model_identifier = settings.AUTO_CLIP_ANALYZER_MODEL or "gpt-5.5"

    if provider_code == "local_heuristic":
        document = _generate_local_segments(request=request, user_preferences=user_preferences)
        latency_ms = round((perf_counter() - started) * 1000, 2)
        logger.info(
            "tts segmentation completed",
            extra={
                "request_id": request_id,
                "provider": provider_code,
                "model": "local-heuristic-v1",
                "provider_request_id": None,
                "latency_ms": latency_ms,
                "segment_count": len(document.segments),
                "token_usage": None,
                "prompt_version": TTS_SEGMENTATION_PROMPT_VERSION,
            },
        )
        return {
            "document": document.model_dump(mode="json"),
            "metadata": {
                "request_id": request_id,
                "provider": provider_code,
                "model": "local-heuristic-v1",
                "provider_request_id": None,
                "latency_ms": latency_ms,
                "token_usage": None,
                "prompt_version": TTS_SEGMENTATION_PROMPT_VERSION,
            },
        }

    try:
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
                "fallback_reason": None,
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
                "fallback_reason": None,
            },
        }
    except Exception as error:
        document = _generate_local_segments(request=request, user_preferences=user_preferences)
        latency_ms = round((perf_counter() - started) * 1000, 2)
        fallback_reason = f"{type(error).__name__}: {str(error).strip() or 'provider failure'}"
        logger.warning(
            "tts segmentation provider failed; falling back to local heuristic",
            extra={
                "request_id": request_id,
                "provider": provider_code,
                "model": model_identifier,
                "latency_ms": latency_ms,
                "segment_count": len(document.segments),
                "prompt_version": TTS_SEGMENTATION_PROMPT_VERSION,
                "fallback_reason": fallback_reason,
            },
        )
        return {
            "document": document.model_dump(mode="json"),
            "metadata": {
                "request_id": request_id,
                "provider": "local_heuristic",
                "model": "local-heuristic-v1",
                "provider_request_id": None,
                "latency_ms": latency_ms,
                "token_usage": None,
                "prompt_version": TTS_SEGMENTATION_PROMPT_VERSION,
                "fallback_reason": fallback_reason,
                "upstream_provider": provider_code,
                "upstream_model": model_identifier,
            },
        }


def _resolve_provider(provider_code: str) -> StructuredOutputProvider:
    if provider_code == "openai":
        return OpenAIStructuredOutputProvider()
    if provider_code == "local_heuristic":
        raise ValueError("local_heuristic provider is resolved internally and should not instantiate a remote provider")
    raise ValueError(f"Unsupported TTS segmentation provider: {provider_code}")


def _resolve_segmentation_provider_code(request: TtsRequestPayload, default_provider: str) -> str:
    output_config = request.output_config if isinstance(request.output_config, dict) else {}
    segmentation_mode = str(output_config.get("segmentation_mode") or "").strip().upper()
    if segmentation_mode == "LOCAL_HEURISTIC":
        return "local_heuristic"
    return default_provider


def _generate_local_segments(
    *,
    request: TtsRequestPayload,
    user_preferences: dict[str, object] | None = None,
) -> TtsSpeechSegmentsDocument:
    preferences = user_preferences if isinstance(user_preferences, dict) else {}
    segment_length_preference = str(preferences.get("segment_length_preference") or "BALANCED").strip().upper()
    breathing_style = str(preferences.get("breathing_style") or "NATURAL").strip().upper()
    base_emotion = str(request.emotion or "calm").strip().lower()
    if base_emotion not in {"neutral", "curious", "serious", "dramatic", "hopeful", "sad", "surprised", "calm"}:
        base_emotion = "calm"

    preferred_words = {"SHORT": 8, "BALANCED": 12, "LONG": 16}.get(segment_length_preference, 12)
    soft_max_words = {"SHORT": 12, "BALANCED": 18, "LONG": 24}.get(segment_length_preference, 18)
    speed = _resolve_speed(request.speaking_speed)

    raw_segments: list[str] = []
    for paragraph in _split_paragraphs(request.script):
        for sentence in _split_sentences(paragraph):
            raw_segments.extend(_split_long_sentence(sentence, preferred_words=preferred_words, soft_max_words=soft_max_words))

    segments = [
        TtsSpeechSegment(
            id=index + 1,
            text=text,
            pause_after=_resolve_pause_after(text=text, is_last=index == len(raw_segments) - 1, breathing_style=breathing_style),
            emotion=_resolve_emotion(text=text, base_emotion=base_emotion),
            speed=speed,
            emphasis=_resolve_emphasis(text),
            volume="normal",
            breath_before=False,
            breath_after=_resolve_breath_after(text, breathing_style),
            fade_in_ms=0,
            fade_out_ms=80,
        )
        for index, text in enumerate(raw_segments)
        if text.strip()
    ]

    if not segments:
        segments = [
            TtsSpeechSegment(
                id=1,
                text=request.script.strip(),
                pause_after=2200,
                emotion=base_emotion,
                speed=speed,
                emphasis="medium",
                volume="normal",
                breath_before=False,
                breath_after=False,
                fade_in_ms=0,
                fade_out_ms=80,
            )
        ]

    return TtsSpeechSegmentsDocument(segments=segments)


def _split_paragraphs(script: str) -> list[str]:
    return [part.strip() for part in re.split(r"\n\s*\n+", script.strip()) if part.strip()]


def _split_sentences(paragraph: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", paragraph.strip())
    return [part.strip() for part in parts if part.strip()]


def _split_long_sentence(sentence: str, *, preferred_words: int, soft_max_words: int) -> list[str]:
    normalized = sentence.strip()
    words = normalized.split()
    if len(words) <= soft_max_words:
        return [normalized]

    clause_parts = [part.strip() for part in re.split(r"(?<=[,;:])\s+", normalized) if part.strip()]
    if len(clause_parts) > 1:
        merged: list[str] = []
        for clause in clause_parts:
            if not merged:
                merged.append(clause)
                continue
            candidate = f"{merged[-1]} {clause}".strip()
            if len(candidate.split()) <= soft_max_words:
                merged[-1] = candidate
            else:
                merged.append(clause)
        if all(len(part.split()) <= soft_max_words for part in merged):
            return merged

    chunks: list[str] = []
    cursor = 0
    while cursor < len(words):
        remaining = len(words) - cursor
        chunk_size = preferred_words if remaining > preferred_words else remaining
        if remaining > soft_max_words:
            chunk_size = min(soft_max_words, max(preferred_words, remaining // 2))
        chunks.append(" ".join(words[cursor : cursor + chunk_size]).strip())
        cursor += chunk_size
    return chunks


def _resolve_pause_after(*, text: str, is_last: bool, breathing_style: str) -> int:
    stripped = text.rstrip()
    if is_last:
        return 2200
    if stripped.endswith(("?", "!")):
        return 1200 if breathing_style == "DRAMATIC" else 1000
    if stripped.endswith("."):
        return 1000 if breathing_style == "DRAMATIC" else 800
    if stripped.endswith((":", ";")):
        return 800
    if stripped.endswith(","):
        return 600 if breathing_style == "MINIMAL" else 400
    return 600


def _resolve_speed(speaking_speed: float | None) -> str:
    if speaking_speed is None:
        return "normal"
    if speaking_speed >= 1.15:
        return "fast"
    if speaking_speed <= 0.9:
        return "slow"
    return "normal"


def _resolve_emphasis(text: str) -> str:
    lowered = text.lower()
    if any(marker in lowered for marker in ("peringatan", "bahaya", "krisis", "ternyata", "faktanya")):
        return "high"
    if text.rstrip().endswith(("?", "!")):
        return "medium"
    return "medium"


def _resolve_emotion(*, text: str, base_emotion: str) -> str:
    lowered = text.lower()
    if any(marker in lowered for marker in ("mengapa", "kenapa", "bagaimana")):
        return "curious"
    if any(marker in lowered for marker in ("krisis", "bahaya", "risiko", "ancaman")):
        return "serious"
    if text.rstrip().endswith("!"):
        return "dramatic"
    return base_emotion


def _resolve_breath_after(text: str, breathing_style: str) -> bool:
    if breathing_style == "MINIMAL":
        return False
    stripped = text.rstrip()
    if breathing_style == "DRAMATIC":
        return stripped.endswith((".", "?", "!", ":", ";"))
    return stripped.endswith((".", "?", "!"))
