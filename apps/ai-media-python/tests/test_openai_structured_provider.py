import json

import httpx
import pytest

from app.config import get_settings
from app.providers.base import ProviderRequestContext
from app.providers.openai_structured import (
    OpenAIStructuredOutputProvider,
    _build_openai_http_timeout,
)


def test_openai_timeout_leaves_analyzer_completion_reserve() -> None:
    timeout = _build_openai_http_timeout(
        openai_timeout_seconds=540.0,
        analyzer_timeout_seconds=600.0,
    )

    assert timeout.connect == 15.0
    assert timeout.read == 540.0
    assert timeout.write == 30.0
    assert timeout.pool == 15.0


def test_openai_timeout_is_capped_below_analyzer_deadline() -> None:
    timeout = _build_openai_http_timeout(
        openai_timeout_seconds=240.0,
        analyzer_timeout_seconds=180.0,
    )

    assert timeout.read == 150.0


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
                        "analysis_version": "2.3",
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
                                "hook_second": 0.0,
                                "main_point_second": 6.0,
                                "punchline_second": 20.0,
                                "retention_level": "high",
                                "requires_context": False,
                                "can_standalone": True,
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
    assert captured["body"]["background"] is True
    assert captured["body"]["input"][0]["role"] == "system"
    assert captured["body"]["input"][1]["role"] == "user"
    assert result["provider_request_id"] == "req_from_openai"
    assert result["usage"] == {"input_tokens": 500, "output_tokens": 120, "total_tokens": 620}
    assert result["output"]["candidates"][0]["candidate_id"] == "candidate-01"
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_openai_provider_polls_background_response_until_completed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://example-openai.test/v1")
    get_settings.cache_clear()
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, str(request.url)))
        if request.method == "POST":
            return httpx.Response(
                200,
                headers={"x-request-id": "req_background"},
                json={"id": "resp_background", "status": "queued"},
            )
        if len(requests) == 2:
            return httpx.Response(200, json={"id": "resp_background", "status": "in_progress"})
        return httpx.Response(
            200,
            json={
                "id": "resp_background",
                "status": "completed",
                "output_text": json.dumps(
                    {
                        "analysis_version": "2.3",
                        "source_summary": "Background analysis complete.",
                        "candidate_count": 0,
                        "candidates": [],
                    }
                ),
                "usage": {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25},
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        provider = OpenAIStructuredOutputProvider(client=client, poll_interval_seconds=0)
        result = await provider.generate_structured(
            context=ProviderRequestContext(
                provider_code="openai",
                model_identifier="gpt-5.5",
                credential_reference="env:OPENAI_API_KEY",
                request_id="req-local-background",
            ),
            system_prompt="Return JSON only.",
            input_payload={"transcript_segments": [{"segment_id": "seg-1"}]},
            schema={"type": "object"},
        )

    assert requests == [
        ("POST", "https://example-openai.test/v1/responses"),
        ("GET", "https://example-openai.test/v1/responses/resp_background"),
        ("GET", "https://example-openai.test/v1/responses/resp_background"),
    ]
    assert result["provider_request_id"] == "req_background"
    assert result["output"]["source_summary"] == "Background analysis complete."
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_openai_provider_cancels_background_response_at_total_deadline() -> None:
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, str(request.url)))
        if request.url.path.endswith("/cancel"):
            return httpx.Response(200, json={"id": "resp_timeout", "status": "cancelled"})
        return httpx.Response(200, json={"id": "resp_timeout", "status": "in_progress"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        provider = OpenAIStructuredOutputProvider(client=client, poll_interval_seconds=0.02)
        with pytest.raises(TimeoutError):
            await provider._generate_background_response(
                client=client,
                base_url="https://example-openai.test/v1",
                headers={"Authorization": "Bearer test"},
                request_body_text="{}",
                context=ProviderRequestContext(
                    provider_code="openai",
                    model_identifier="gpt-5.5",
                    credential_reference="env:OPENAI_API_KEY",
                    request_id="req-local-timeout",
                ),
                request_body_size_bytes=2,
                timeout_seconds=0.01,
            )

    assert requests[-1] == (
        "POST",
        "https://example-openai.test/v1/responses/resp_timeout/cancel",
    )


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
                                        "analysis_version": "2.3",
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
        "analysis_version": "2.3",
        "source_summary": "OpenAI source summary.",
        "candidate_count": 0,
        "candidates": [],
    }
    get_settings.cache_clear()
