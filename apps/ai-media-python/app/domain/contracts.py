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
    hook_second: float = Field(ge=0)
    main_point_second: float = Field(ge=0)
    punchline_second: float = Field(ge=0)
    retention_level: Literal["very_high", "high", "medium", "low"]
    requires_context: bool
    can_standalone: bool
    scores: dict[str, Any]

    @model_validator(mode="after")
    def validate_order(self) -> "CandidateAnalysis":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("candidate end_seconds must be greater than start_seconds")
        if self.main_point_second < self.hook_second:
            raise ValueError("main_point_second must be greater than or equal to hook_second")
        if self.punchline_second < self.main_point_second:
            raise ValueError("punchline_second must be greater than or equal to main_point_second")
        if self.punchline_second > self.duration_seconds:
            raise ValueError("punchline_second must not exceed duration_seconds")
        return self


ClipQualityStatus = Literal["PENDING", "PASSED", "NEEDS_REVIEW", "FAILED"]
MediaValidationStatus = Literal["READY", "FAILED"]
TtsSpeechEmotion = Literal["neutral", "curious", "serious", "dramatic", "hopeful", "sad", "surprised", "calm"]
TtsSpeechSpeed = Literal["slow", "normal", "fast"]
TtsSpeechEmphasis = Literal["low", "medium", "high"]
TtsSpeechVolume = Literal["low", "normal", "high"]


class ClipRenderCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_id: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(min_length=1, max_length=2000)
    hook_text: str = Field(min_length=1, max_length=500)
    start_ms: str = Field(pattern=r"^\d+$")
    end_ms: str = Field(pattern=r"^\d+$")
    duration_ms: str = Field(pattern=r"^\d+$")


class TtsRequestPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=36, max_length=64)
    script: str = Field(min_length=1, max_length=100_000)
    language: str = Field(min_length=2, max_length=20, default="id")
    local_model_key: str | None = Field(default=None, max_length=200)
    voice_identifier: str | None = Field(default=None, max_length=200)
    speaking_style: str | None = Field(default=None, max_length=80)
    emotion: str | None = Field(default=None, max_length=80)
    speaking_speed: float | None = Field(default=None, gt=0, le=3)
    pitch: float | None = Field(default=None, ge=-20, le=20)
    pause_intensity: float | None = Field(default=None, ge=0, le=3)
    target_duration_ms: int | None = Field(default=None, gt=0, le=14_400_000)
    pronunciation_dictionary: dict[str, str] = Field(default_factory=dict)
    output_config: dict[str, Any] = Field(default_factory=dict)


class TtsSpeechSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int = Field(ge=1, le=10_000)
    text: str = Field(min_length=1, max_length=2_000)
    pause_after: Literal[250, 400, 600, 800, 1000, 1200, 1500, 1800, 2200]
    emotion: TtsSpeechEmotion
    speed: TtsSpeechSpeed
    emphasis: TtsSpeechEmphasis
    volume: TtsSpeechVolume = "normal"
    breath_before: bool = False
    breath_after: bool = False
    fade_in_ms: int = Field(default=0, ge=0, le=5_000)
    fade_out_ms: int = Field(default=80, ge=0, le=5_000)


class TtsSpeechSegmentsDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    segments: list[TtsSpeechSegment] = Field(min_length=1, max_length=10_000)


class TtsOutputTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1, max_length=64)
    tts_request_id: str = Field(min_length=1, max_length=64)
    version: int = Field(ge=1)
    object_key: str = Field(min_length=1, max_length=1000)
    mime_type: str = Field(min_length=1, max_length=160)
    extension: str = Field(min_length=1, max_length=20)
    upload_url: HttpUrl


class TtsOutputTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preferred_format: Literal["wav", "mp3", "ogg"] = "wav"


class TtsOutputPersistenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["READY", "FAILED"]
    object_key: str | None = Field(default=None, min_length=1, max_length=1000)
    mime_type: str | None = Field(default=None, min_length=1, max_length=160)
    extension: str | None = Field(default=None, min_length=1, max_length=20)
    duration_ms: str | None = Field(default=None, pattern=r"^\d+$")
    size_bytes: str | None = Field(default=None, pattern=r"^\d+$")
    sample_rate: int | None = Field(default=None, ge=1)
    channels: int | None = Field(default=None, ge=1, le=8)
    provider_metadata: dict[str, Any] = Field(default_factory=dict)
    failure_reason: str | None = Field(default=None, max_length=2000)


class ClipOutputTargets(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_object_key: str | None = None
    final_object_key: str | None = None
    metadata_object_key: str | None = None
    thumbnail_object_key: str | None = None
    subtitle_object_key: str | None = None


class ClipRenderSourceMedia(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    object_key: str = Field(min_length=1, max_length=1000)
    download_url: HttpUrl
    mime_type: str | None = Field(default=None, max_length=160)
    duration_ms: str | None = Field(default=None, pattern=r"^\d+$")
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ClipRenderSubtitleWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: str = Field(min_length=2, max_length=20)
    segments: list[TranscriptSegment] = Field(default_factory=list, max_length=5000)


class ClipRenderArtifactUpload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    artifact: Literal[
        "preview",
        "final",
        "metadata",
        "thumbnail",
        "subtitle",
        "subtitle_srt",
        "subtitle_ass",
        "subtitle_vtt",
        "subtitle_json",
    ]
    object_key: str = Field(min_length=1, max_length=1000)
    content_type: str = Field(min_length=1, max_length=160)
    upload_url: HttpUrl


class ClipRenderContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clip_output_id: str = Field(min_length=1, max_length=64)
    job_id: str = Field(min_length=1, max_length=64)
    candidate_id: str = Field(min_length=1, max_length=64)
    version: int = Field(ge=1)
    quality_status: ClipQualityStatus
    render_settings: dict[str, Any] = Field(default_factory=dict)
    candidate: ClipRenderCandidate
    source_media: ClipRenderSourceMedia
    transcript: ClipRenderSubtitleWindow | None = None
    output_targets: ClipOutputTargets
    artifact_uploads: list[ClipRenderArtifactUpload] = Field(default_factory=list, max_length=10)


class ClipOutputResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quality_status: ClipQualityStatus
    preview_object_key: str | None = Field(default=None, max_length=1000)
    final_object_key: str | None = Field(default=None, max_length=1000)
    metadata_object_key: str | None = Field(default=None, max_length=1000)
    thumbnail_object_key: str | None = Field(default=None, max_length=1000)
    subtitle_object_key: str | None = Field(default=None, max_length=1000)
    subtitle_format: str | None = Field(default=None, min_length=1, max_length=20)
    subtitle_language: str | None = Field(default=None, min_length=2, max_length=20)
    subtitle_burned_in: bool | None = None
    quality_report: dict[str, Any] = Field(default_factory=dict)
    duration_ms: str | None = Field(default=None, pattern=r"^\d+$")
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)


class MediaAssetValidationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: MediaValidationStatus
    duration_ms: str | None = Field(default=None, pattern=r"^\d+$")
    width: int | None = Field(default=None, ge=1)
    height: int | None = Field(default=None, ge=1)
    frame_rate: float | None = Field(default=None, gt=0)
    audio_sample_rate: int | None = Field(default=None, ge=1)
    codec_name: str | None = Field(default=None, max_length=80)
    audio_codec_name: str | None = Field(default=None, max_length=80)
    rotation: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    failure_reason: str | None = Field(default=None, max_length=2000)


class MediaAssetValidationContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    user_id: str = Field(min_length=1, max_length=64)
    project_id: str | None = Field(default=None, max_length=64)
    type: str = Field(min_length=1, max_length=40)
    status: str = Field(min_length=1, max_length=40)
    object_key: str = Field(min_length=1, max_length=1000)
    display_name: str = Field(min_length=1, max_length=255)
    original_file_name: str | None = Field(default=None, max_length=255)
    mime_type: str | None = Field(default=None, max_length=160)
    extension: str | None = Field(default=None, max_length=20)
    size_bytes: str | None = Field(default=None, pattern=r"^\d+$")
    checksum_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    download_url: HttpUrl
    metadata: dict[str, Any] = Field(default_factory=dict)


class ExternalSourceImportContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    job_id: str = Field(min_length=1, max_length=64)
    user_id: str = Field(min_length=1, max_length=64)
    project_id: str | None = Field(default=None, max_length=64)
    source_url: HttpUrl
    object_key: str = Field(min_length=1, max_length=1000)
    upload_url: HttpUrl
    read_url: HttpUrl
    display_name: str = Field(min_length=1, max_length=255)
    original_file_name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=160)
    extension: str = Field(min_length=1, max_length=20)


class AudioExtractionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    job_id: str | None = Field(default=None, min_length=1, max_length=64)
    user_id: str = Field(min_length=1, max_length=64)
    object_key: str = Field(min_length=1, max_length=1000)
    source_url: HttpUrl
    working_directory: str = Field(min_length=1, max_length=1000)
    output_audio_path: str = Field(min_length=1, max_length=1000)
    sample_rate: int = Field(ge=1)
    command: list[str] = Field(min_length=1)


class AudioExtractionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    output_audio_path: str = Field(min_length=1, max_length=1000)
    sample_rate: int = Field(ge=1)
    command: list[str] = Field(min_length=1)


class TranscriptionPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    job_id: str | None = Field(default=None, min_length=1, max_length=64)
    user_id: str = Field(min_length=1, max_length=64)
    audio_path: str = Field(min_length=1, max_length=1000)
    output_transcript_path: str = Field(min_length=1, max_length=1000)
    language_hint: str | None = Field(default=None, max_length=20)
    custom_vocabulary: list[str] = Field(default_factory=list, max_length=200)


class TranscriptionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    job_id: str | None = Field(default=None, min_length=1, max_length=64)
    output_transcript_path: str = Field(min_length=1, max_length=1000)
    transcript: TranscriptDocument


class TranscriptionPersistenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_asset_id: str = Field(min_length=1, max_length=64)
    job_id: str | None = Field(default=None, min_length=1, max_length=64)
    output_transcript_path: str = Field(min_length=1, max_length=1000)
    model_identifier: str | None = Field(default=None, max_length=200)
    word_timestamps: bool = True
    transcript: TranscriptDocument
