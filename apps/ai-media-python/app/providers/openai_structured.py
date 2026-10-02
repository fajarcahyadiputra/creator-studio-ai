import asyncio
import json
import logging
from copy import deepcopy
from time import monotonic
from typing import Any

import httpx

from app.config import get_settings
from app.providers.base import ProviderRequestContext, StructuredOutputProvider

logger = logging.getLogger(__name__)

OPENAI_CONNECT_TIMEOUT_SECONDS = 15.0
OPENAI_WRITE_TIMEOUT_SECONDS = 30.0
OPENAI_POOL_TIMEOUT_SECONDS = 15.0
ANALYZER_COMPLETION_RESERVE_SECONDS = 30.0
OPENAI_BACKGROUND_POLL_INTERVAL_SECONDS = 2.0
OPENAI_BACKGROUND_TERMINAL_STATUSES = {"cancelled", "failed", "incomplete"}


class OpenAIStructuredOutputProvider(StructuredOutputProvider):
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        poll_interval_seconds: float = OPENAI_BACKGROUND_POLL_INTERVAL_SECONDS,
    ) -> None:
        self._client = client
        self._poll_interval_seconds = max(0.0, poll_interval_seconds)

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
            "background": settings.OPENAI_BACKGROUND_MODE,
        }
        request_body_text = json.dumps(request_body, ensure_ascii=True)
        request_body_size_bytes = len(request_body_text.encode("utf-8"))

        headers = {
            "authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "content-type": "application/json",
            "x-stainless-client-user-agent": "creator-studio-ai-media/openai-structured",
        }

        if self._client is not None:
            payload, provider_request_id = await self._generate_background_response(
                client=self._client,
                base_url=str(settings.OPENAI_BASE_URL).rstrip("/"),
                headers=headers,
                request_body_text=request_body_text,
                context=context,
                request_body_size_bytes=request_body_size_bytes,
                timeout_seconds=_effective_openai_completion_timeout(
                    openai_timeout_seconds=settings.OPENAI_TIMEOUT_SECONDS,
                    analyzer_timeout_seconds=settings.ANALYZER_TIMEOUT_SECONDS,
                ),
            )
        else:
            timeout = _build_openai_http_timeout(
                openai_timeout_seconds=settings.OPENAI_TIMEOUT_SECONDS,
                analyzer_timeout_seconds=settings.ANALYZER_TIMEOUT_SECONDS,
            )
            async with httpx.AsyncClient(timeout=timeout) as client:
                payload, provider_request_id = await self._generate_background_response(
                    client=client,
                    base_url=str(settings.OPENAI_BASE_URL).rstrip("/"),
                    headers=headers,
                    request_body_text=request_body_text,
                    context=context,
                    request_body_size_bytes=request_body_size_bytes,
                    timeout_seconds=_effective_openai_completion_timeout(
                        openai_timeout_seconds=settings.OPENAI_TIMEOUT_SECONDS,
                        analyzer_timeout_seconds=settings.ANALYZER_TIMEOUT_SECONDS,
                    ),
                )

        text_output = payload.get("output_text")
        if not isinstance(text_output, str) or not text_output.strip():
            text_output = _extract_output_text(payload)
        parsed = json.loads(text_output)
        usage = payload.get("usage")
        return {
            "output": parsed,
            "usage": usage if isinstance(usage, dict) else None,
            "provider_request_id": provider_request_id,
        }

    async def _generate_background_response(
        self,
        *,
        client: httpx.AsyncClient,
        base_url: str,
        headers: dict[str, str],
        request_body_text: str,
        context: ProviderRequestContext,
        request_body_size_bytes: int,
        timeout_seconds: float,
    ) -> tuple[dict[str, Any], str | None]:
        started = monotonic()
        response_id: str | None = None
        try:
            response = await asyncio.wait_for(
                client.post(
                    f"{base_url}/responses",
                    headers=headers,
                    content=request_body_text,
                ),
                timeout=timeout_seconds,
            )
            payload = _raise_for_status_with_context(
                response,
                context=context,
                request_body_size_bytes=request_body_size_bytes,
            )
            provider_request_id = response.headers.get("x-request-id")
            response_id = payload.get("id")
            status = payload.get("status")

            # Compatible gateways may return completed output immediately even when
            # background mode was requested.
            if status not in {"queued", "in_progress"}:
                _raise_for_terminal_background_failure(payload)
                return payload, provider_request_id
            if not isinstance(response_id, str) or not response_id:
                raise ValueError("OpenAI background response did not include an id")

            while status in {"queued", "in_progress"}:
                remaining_seconds = timeout_seconds - (monotonic() - started)
                if remaining_seconds <= 0:
                    raise TimeoutError(
                        f"OpenAI background response exceeded {int(timeout_seconds)} seconds"
                    )
                await asyncio.sleep(min(self._poll_interval_seconds, remaining_seconds))
                remaining_seconds = timeout_seconds - (monotonic() - started)
                response = await asyncio.wait_for(
                    client.get(
                        f"{base_url}/responses/{response_id}",
                        headers=headers,
                    ),
                    timeout=max(0.001, remaining_seconds),
                )
                payload = _raise_for_status_with_context(
                    response,
                    context=context,
                    request_body_size_bytes=request_body_size_bytes,
                )
                status = payload.get("status")
        except (asyncio.CancelledError, TimeoutError):
            if response_id is not None:
                await _cancel_background_response(
                    client=client,
                    base_url=base_url,
                    response_id=response_id,
                    headers=headers,
                )
            raise

        _raise_for_terminal_background_failure(payload)
        if status != "completed":
            raise ValueError(f"OpenAI background response returned unknown status: {status!r}")
        return payload, provider_request_id or response.headers.get("x-request-id")


def _build_openai_http_timeout(
    *,
    openai_timeout_seconds: float,
    analyzer_timeout_seconds: float,
) -> httpx.Timeout:
    # Keep time for response parsing, validation, and a heuristic fallback before
    # Temporal's analyzer activity deadline expires.
    maximum_read_seconds = max(
        1.0,
        analyzer_timeout_seconds - ANALYZER_COMPLETION_RESERVE_SECONDS,
    )
    read_timeout_seconds = min(openai_timeout_seconds, maximum_read_seconds)
    if read_timeout_seconds < openai_timeout_seconds:
        logger.warning(
            "OpenAI read timeout capped by analyzer activity budget",
            extra={
                "configured_openai_timeout_seconds": openai_timeout_seconds,
                "analyzer_timeout_seconds": analyzer_timeout_seconds,
                "effective_openai_read_timeout_seconds": read_timeout_seconds,
            },
        )
    return httpx.Timeout(
        connect=OPENAI_CONNECT_TIMEOUT_SECONDS,
        read=read_timeout_seconds,
        write=OPENAI_WRITE_TIMEOUT_SECONDS,
        pool=OPENAI_POOL_TIMEOUT_SECONDS,
    )


def _effective_openai_completion_timeout(
    *,
    openai_timeout_seconds: float,
    analyzer_timeout_seconds: float,
) -> float:
    return min(
        openai_timeout_seconds,
        max(1.0, analyzer_timeout_seconds - ANALYZER_COMPLETION_RESERVE_SECONDS),
    )


def _raise_for_terminal_background_failure(payload: dict[str, Any]) -> None:
    status = payload.get("status")
    if status not in OPENAI_BACKGROUND_TERMINAL_STATUSES:
        return
    error = payload.get("error")
    detail = json.dumps(error, ensure_ascii=True)[:2000] if error is not None else "no error detail"
    raise RuntimeError(f"OpenAI background response {status}: {detail}")


async def _cancel_background_response(
    *,
    client: httpx.AsyncClient,
    base_url: str,
    response_id: str,
    headers: dict[str, str],
) -> None:
    try:
        await client.post(f"{base_url}/responses/{response_id}/cancel", headers=headers)
    except httpx.HTTPError:
        logger.warning(
            "OpenAI background response cancellation failed",
            extra={"provider_response_id": response_id},
        )


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
