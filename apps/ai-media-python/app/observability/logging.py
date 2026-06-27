import logging
import sys

from pythonjsonlogger.json import JsonFormatter


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        for attribute in ("msg", "message"):
            value = getattr(record, attribute, None)
            if isinstance(value, str) and "Bearer " in value:
                setattr(record, attribute, value.replace("Bearer ", "Bearer [REDACTED]"))

        if hasattr(record, "__dict__"):
            for key, value in list(record.__dict__.items()):
                if not isinstance(value, str):
                    continue
                lowered = key.lower()
                if "api_key" in lowered or "authorization" in lowered or "token" in lowered:
                    record.__dict__[key] = "[REDACTED]"
        return True


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)
