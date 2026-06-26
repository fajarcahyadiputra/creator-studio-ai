from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

JobType = Literal["AUTO_CLIPPING", "TEXT_TO_SPEECH", "TRANSCRIPTION"]
JobStatus = Literal[
    "DRAFT",
    "UPLOADING",
    "QUEUED",
    "RUNNING",
    "PAUSE_REQUESTED",
    "PAUSED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "FAILED",
    "COMPLETED",
    "PARTIALLY_COMPLETED",
    "NEEDS_REVIEW",
]


class FoundationWorkflowInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=36, max_length=64)
    user_id: str = Field(min_length=36, max_length=64)
    job_type: JobType
    input_snapshot: dict[str, Any]
    callback_base_url: HttpUrl
    attempt_number: int = Field(ge=1)
    resume_from_stage: str | None = Field(default=None, max_length=100)


class ProgressEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage: str = Field(min_length=1, max_length=100)
    stage_progress: int = Field(ge=0, le=100)
    overall_progress: int = Field(ge=0, le=100)
    event_type: str = Field(default="job.progress", min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=2000)
    user_message: str | None = Field(default=None, max_length=2000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    status: JobStatus | None = None
    occurred_at: str | None = None


class ClipScoreComponents(BaseModel):
    hook: float = Field(ge=0, le=10)
    conflict: float = Field(ge=0, le=10)
    emotion: float = Field(ge=0, le=10)
    novelty: float = Field(ge=0, le=10)
    comment_potential: float = Field(ge=0, le=10)


class ClipPenalties(BaseModel):
    context: float = Field(default=0, ge=0, le=2)
    weak_ending: float = Field(default=0, ge=0, le=1)
    slow_start: float = Field(default=0, ge=0, le=1)
    duplicate: float = Field(default=0, ge=0, le=1.5)
    unsafe_or_misleading: float = Field(default=0, ge=0, le=3)
    cut_quality: float = Field(default=0, ge=0, le=1)


class MediaBoundary(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_order(self) -> "MediaBoundary":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("end_seconds must be greater than start_seconds")
        return self
