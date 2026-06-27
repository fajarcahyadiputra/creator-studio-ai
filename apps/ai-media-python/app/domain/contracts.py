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


class TranscriptWord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=120)
    confidence: float | None = Field(default=None, ge=0, le=1)

    @model_validator(mode="after")
    def validate_order(self) -> "TranscriptWord":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("word end_seconds must be greater than start_seconds")
        return self


class TranscriptSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    segment_id: str = Field(min_length=1, max_length=100)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=5000)
    speaker_label: str | None = Field(default=None, max_length=80)
    confidence: float | None = Field(default=None, ge=0, le=1)
    words: list[TranscriptWord] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_order(self) -> "TranscriptSegment":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("segment end_seconds must be greater than start_seconds")
        return self


class TranscriptDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str = Field(min_length=2, max_length=20)
    duration_seconds: float = Field(gt=0)
    segments: list[TranscriptSegment] = Field(min_length=1, max_length=5000)


class SceneBoundary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scene_id: str = Field(min_length=1, max_length=100)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_order(self) -> "SceneBoundary":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("scene end_seconds must be greater than start_seconds")
        return self


class SilenceBoundary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    silence_id: str = Field(min_length=1, max_length=100)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_order(self) -> "SilenceBoundary":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("silence end_seconds must be greater than start_seconds")
        return self


class AnalysisInputs(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transcript: TranscriptDocument
    scenes: list[SceneBoundary] = Field(default_factory=list, max_length=5000)
    silences: list[SilenceBoundary] = Field(default_factory=list, max_length=5000)


class CandidateAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_id: str = Field(min_length=1, max_length=100)
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    duration_seconds: float = Field(gt=0)
    title: str = Field(min_length=1, max_length=255)
    hook_text: str = Field(min_length=1, max_length=500)
    ending_text: str = Field(min_length=1, max_length=500)
    summary: str = Field(min_length=1, max_length=2000)
    why_it_works: list[str] = Field(min_length=1, max_length=10)
    content_category: Literal["debate", "insight", "story", "reaction", "humor", "other"]
    context_complete: bool
    safety_notes: list[str] = Field(default_factory=list, max_length=10)
    suggested_caption: str = Field(min_length=1, max_length=1000)
    suggested_cta: str = Field(min_length=1, max_length=255)
    suggested_hashtags: list[str] = Field(default_factory=list, max_length=10)
    thumbnail_text: str = Field(min_length=1, max_length=120)
    speaker_ids: list[str] = Field(default_factory=list, max_length=10)
    scene_ids: list[str] = Field(default_factory=list, max_length=20)
    scores: dict[str, Any]

    @model_validator(mode="after")
    def validate_order(self) -> "CandidateAnalysis":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("candidate end_seconds must be greater than start_seconds")
        return self


ClipQualityStatus = Literal["PENDING", "PASSED", "NEEDS_REVIEW", "FAILED"]


class ClipRenderCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_id: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(min_length=1, max_length=2000)
    hook_text: str = Field(min_length=1, max_length=500)
    start_ms: str = Field(pattern=r"^\d+$")
    end_ms: str = Field(pattern=r"^\d+$")
    duration_ms: str = Field(pattern=r"^\d+$")


class ClipOutputTargets(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_object_key: str | None = None
    final_object_key: str | None = None
    metadata_object_key: str | None = None
    thumbnail_object_key: str | None = None


class ClipRenderContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clip_output_id: str = Field(min_length=1, max_length=64)
    job_id: str = Field(min_length=1, max_length=64)
    candidate_id: str = Field(min_length=1, max_length=64)
    version: int = Field(ge=1)
    quality_status: ClipQualityStatus
    render_settings: dict[str, Any] = Field(default_factory=dict)
    candidate: ClipRenderCandidate
    output_targets: ClipOutputTargets


class ClipOutputResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quality_status: ClipQualityStatus
    preview_object_key: str | None = Field(default=None, max_length=1000)
    final_object_key: str | None = Field(default=None, max_length=1000)
    metadata_object_key: str | None = Field(default=None, max_length=1000)
    thumbnail_object_key: str | None = Field(default=None, max_length=1000)
    quality_report: dict[str, Any] = Field(default_factory=dict)
    duration_ms: str | None = Field(default=None, pattern=r"^\d+$")
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
