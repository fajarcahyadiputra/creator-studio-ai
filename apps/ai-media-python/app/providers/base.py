from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class ProviderRequestContext:
    provider_code: str
    model_identifier: str
    credential_reference: str
    request_id: str


class StructuredOutputProvider(ABC):
    @abstractmethod
    async def generate_structured(
        self,
        *,
        context: ProviderRequestContext,
        system_prompt: str,
        input_payload: dict[str, Any],
        schema: dict[str, Any],
        schema_name: str | None = None,
    ) -> dict[str, Any]:
        """Return provider output validated against the supplied schema."""
