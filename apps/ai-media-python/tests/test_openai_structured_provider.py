import json

import httpx
import pytest

from app.config import get_settings
from app.providers.base import ProviderRequestContext
from app.providers.openai_structured import OpenAIStructuredOutputProvider


@pytest.mark.asyncio
async def test_openai_provider_parses_output_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example-openai.test/v1")
    get_settings.cache_clear()

    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["authorization"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            headers={"x-request-id": "req_from_openai"},
            json={
                "output_text": json.dumps(
                    {
                        "analysis_version": "2.2",
                        "source_summary": "OpenAI source summary.",
                        "candidate_count": 1,
                        "candidates": [
                            {
                                "candidate_id": "candidate-01",
                                "start_seconds": 4.0,
                                "end_seconds": 24.0,
                                "duration_seconds": 20.0,
                                "title": "Structured candidate",
                                "hook_text": "Hook text",
                                "ending_text": "Ending text",
                                "summary": "Summary text",
                                "why_it_works": ["Reason"],
                                "content_category": "insight",
                                "context_complete": True,
                                "safety_notes": [],
                                "suggested_caption": "Caption",
                                "suggested_cta": "CTA",
                                "suggested_hashtags": ["#one"],
                                "thumbnail_text": "Thumb",
                                "speaker_ids": ["speaker-1"],
                                "scene_ids": ["scene-1"],
                                "scores": {
                                    "hook": 8.0,
                                    "conflict": 7.0,
                                    "emotion": 7.0,
                                    "novelty": 7.0,
                                    "comment_potential": 8.0,
                                    "base_viral_score": 8.2,
                                    "final_viral_score": 8.1,
                                    "penalties": {
                                        "context": 0,
                                        "weak_ending": 0,
                                        "slow_start": 0,
                                        "duplicate": 0,
                                        "unsafe_or_misleading": 0,
                                        "cut_quality": 0,
                                    },
                                },
                            }
                        ]
                    }
                ),
                "usage": {"input_tokens": 500, "output_tokens": 120, "total_tokens": 620},
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        provider = OpenAIStructuredOutputProvider(client=client)
        result = await provider.generate_structured(
            context=ProviderRequestContext(
                provider_code="openai",
                model_identifier="gpt-5.5",
                credential_reference="env:OPENAI_API_KEY",
                request_id="req-local-1",
            ),
            system_prompt="Return JSON only.",
            input_payload={"transcript_segments": [{"segment_id": "seg-1"}]},
            schema={"type": "object"},
        )

    assert captured["url"] == "https://example-openai.test/v1/responses"
    assert captured["authorization"] == "Bearer test-openai-key"
    assert isinstance(captured["body"], dict)
    assert captured["body"]["model"] == "gpt-5.5"
    assert captured["body"]["text"]["format"]["type"] == "json_schema"
    assert captured["body"]["text"]["format"]["name"] == "auto_clip_candidate_batch"
    assert captured["body"]["text"]["format"]["strict"] is True
    assert captured["body"]["input"][0]["role"] == "system"
    assert captured["body"]["input"][1]["role"] == "user"
    assert result["provider_request_id"] == "req_from_openai"
    assert result["usage"] == {"input_tokens": 500, "output_tokens": 120, "total_tokens": 620}
    assert result["output"]["candidates"][0]["candidate_id"] == "candidate-01"
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_openai_provider_parses_nested_output_content(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example-openai.test/v1")
    get_settings.cache_clear()

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"x-request-id": "req_nested"},
            json={
                "output": [
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": json.dumps(
                                    {
                                        "analysis_version": "2.2",
                                        "source_summary": "OpenAI source summary.",
                                        "candidate_count": 0,
                                        "candidates": [],
                                    }
                                ),
                            }
                        ],
                    }
                ],
                "usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12},
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        provider = OpenAIStructuredOutputProvider(client=client)
        result = await provider.generate_structured(
            context=ProviderRequestContext(
                provider_code="openai",
                model_identifier="gpt-5.5",
                credential_reference="env:OPENAI_API_KEY",
                request_id="req-local-2",
            ),
            system_prompt="Return JSON only.",
            input_payload={"transcript_segments": [{"segment_id": "seg-1"}]},
            schema={"type": "object"},
        )

    assert result["provider_request_id"] == "req_nested"
    assert result["output"] == {
        "analysis_version": "2.2",
        "source_summary": "OpenAI source summary.",
        "candidate_count": 0,
        "candidates": [],
    }
    get_settings.cache_clear()
