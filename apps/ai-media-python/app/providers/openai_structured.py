import json
import logging
from copy import deepcopy
from typing import Any

import httpx

from app.config import get_settings
from app.providers.base import ProviderRequestContext, StructuredOutputProvider

logger = logging.getLogger(__name__)


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
        schema_name: str | None = None,
    ) -> dict[str, Any]:
        settings = get_settings()
        if not settings.OPENAI_API_KEY:
            raise ValueError("OPENAI_API_KEY is required for OpenAI analyzer mode")

        resolved_schema_name = schema_name or str(schema.get("title") or "structured_output")
        normalized_schema = _normalize_openai_strict_schema(schema)

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
                    "name": resolved_schema_name,
                    "schema": normalized_schema,
                    "strict": True,
                }
            },
        }
        request_body_text = json.dumps(request_body, ensure_ascii=True)
        request_body_size_bytes = len(request_body_text.encode("utf-8"))

        headers = {
            "authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "content-type": "application/json",
            "x-stainless-client-user-agent": "creator-studio-ai-media/openai-structured",
        }

        if self._client is not None:
            response = await self._client.post(
                f"{str(settings.OPENAI_BASE_URL).rstrip('/')}/responses",
                headers=headers,
                content=request_body_text,
            )
            payload = _raise_for_status_with_context(
                response,
                context=context,
                request_body_size_bytes=request_body_size_bytes,
            )
        else:
            async with httpx.AsyncClient(timeout=settings.OPENAI_TIMEOUT_SECONDS) as client:
                response = await client.post(
                    f"{str(settings.OPENAI_BASE_URL).rstrip('/')}/responses",
                    headers=headers,
                    content=request_body_text,
                )
                payload = _raise_for_status_with_context(
                    response,
                    context=context,
                    request_body_size_bytes=request_body_size_bytes,
                )

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


def _raise_for_status_with_context(
    response: httpx.Response,
    *,
    context: ProviderRequestContext,
    request_body_size_bytes: int,
) -> dict[str, Any]:
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        response_text = response.text
        logger.warning(
            "OpenAI structured output request failed",
            extra={
                "provider": context.provider_code,
                "model": context.model_identifier,
                "request_id": context.request_id,
                "provider_request_id": response.headers.get("x-request-id"),
                "status_code": response.status_code,
                "request_body_size_bytes": request_body_size_bytes,
                "response_text": response_text[:4000],
            },
        )
        raise error
    return response.json()


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


def _normalize_openai_strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    normalized = deepcopy(schema)
    _normalize_openai_strict_schema_node(normalized)
    return normalized


def _normalize_openai_strict_schema_node(node: Any) -> None:
    if isinstance(node, dict):
        definitions = node.get("$defs")
        if isinstance(definitions, dict):
            for child in definitions.values():
                _normalize_openai_strict_schema_node(child)

        legacy_definitions = node.get("definitions")
        if isinstance(legacy_definitions, dict):
            for child in legacy_definitions.values():
                _normalize_openai_strict_schema_node(child)

        properties = node.get("properties")
        if isinstance(properties, dict):
            for child in properties.values():
                _normalize_openai_strict_schema_node(child)
            node["required"] = list(properties.keys())
            node.setdefault("additionalProperties", False)

        items = node.get("items")
        if items is not None:
            _normalize_openai_strict_schema_node(items)

        for key in ("anyOf", "allOf", "oneOf", "prefixItems"):
            variants = node.get(key)
            if isinstance(variants, list):
                for variant in variants:
                    _normalize_openai_strict_schema_node(variant)
    elif isinstance(node, list):
        for item in node:
            _normalize_openai_strict_schema_node(item)
