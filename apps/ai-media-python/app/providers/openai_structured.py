import json
from typing import Any

import httpx

from app.config import get_settings
from app.providers.base import ProviderRequestContext, StructuredOutputProvider


class OpenAIStructuredOutputProvider(StructuredOutputProvider):
    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def generate_structured(
        self,
        *,
        context: ProviderRequestContext,
        system_prompt: str,
        input_payload: dict[str, Any],
        schema: dict[str, Any],
    ) -> dict[str, Any]:
        settings = get_settings()
        if not settings.OPENAI_API_KEY:
            raise ValueError("OPENAI_API_KEY is required for OpenAI analyzer mode")

        request_body = {
            "model": context.model_identifier,
            "input": [
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "input_text",
                            "text": system_prompt,
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": json.dumps(input_payload, ensure_ascii=True),
                        }
                    ],
                },
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "auto_clip_candidate_batch",
                    "schema": schema,
                    "strict": True,
                }
            },
        }

        headers = {
            "authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "content-type": "application/json",
            "x-stainless-client-user-agent": "creator-studio-ai-media/openai-structured",
        }

        if self._client is not None:
            response = await self._client.post(
                f"{str(settings.OPENAI_BASE_URL).rstrip('/')}/responses",
                headers=headers,
                json=request_body,
            )
            response.raise_for_status()
            payload = response.json()
        else:
            async with httpx.AsyncClient(timeout=settings.OPENAI_TIMEOUT_SECONDS) as client:
                response = await client.post(
                    f"{str(settings.OPENAI_BASE_URL).rstrip('/')}/responses",
                    headers=headers,
                    json=request_body,
                )
                response.raise_for_status()
                payload = response.json()

        text_output = payload.get("output_text")
        if not isinstance(text_output, str) or not text_output.strip():
            text_output = _extract_output_text(payload)
        parsed = json.loads(text_output)
        usage = payload.get("usage")
        return {
            "output": parsed,
            "usage": usage if isinstance(usage, dict) else None,
            "provider_request_id": response.headers.get("x-request-id"),
        }


def _extract_output_text(payload: dict[str, Any]) -> str:
    output = payload.get("output")
    if not isinstance(output, list):
        raise ValueError("OpenAI response did not include output text")
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                return text
    raise ValueError("OpenAI response did not include output text")
