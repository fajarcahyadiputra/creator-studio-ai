from fastapi import FastAPI

from app.observability.logging import configure_logging

configure_logging()
app = FastAPI(title="Creator Studio AI Media API", version="0.1.0", docs_url=None, redoc_url=None)


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
async def ready() -> dict[str, str]:
    return {"status": "ready"}
