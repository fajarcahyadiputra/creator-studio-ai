from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from time import monotonic
from typing import Any

import httpx
from temporalio import activity
from temporalio.exceptions import ApplicationError

from app.config import get_settings
from app.activities.warning_events import emit_retry_warning
from app.domain.contracts import ClipOutputResult, ClipRenderArtifactUpload, ClipRenderContext, TranscriptSegment
from app.domain.speech_cleanup import (
    build_speech_cleanup_plan,
    remap_transcript_segments,
)
from app.infrastructure.clip_output_client import ClipOutputClient
from app.media.face_detection import (
    FaceDetectionUnavailable,
    apply_active_speaker_tracking,
    build_active_face_tracking_samples,
    detect_faces_in_image,
    summarize_face_samples,
)
from app.media.ffmpeg import build_clip_render_command, build_timeline_cleanup_command
from app.activities.media_validation import run_ffprobe_json

SUPPORTED_SUBTITLE_FORMATS = {"srt", "ass", "vtt", "json"}
STANDARD_9X16_BOTTOM_SAFE_MARGIN_PERCENT = 20.0


@dataclass(frozen=True, slots=True)
class SubtitleCueWord:
    text: str
    duration_centiseconds: int
    line_break_before: bool = False
    start_offset_centiseconds: int | None = None


@dataclass(frozen=True, slots=True)
class SubtitleCue:
    start_seconds: float
    end_seconds: float
    text: str
    words: tuple[SubtitleCueWord, ...] = ()


@activity.defn
async def prepare_clip_output_render(payload: dict[str, Any]) -> dict[str, Any]:
    clip_output_id = payload.get("clip_output_id")
    if not isinstance(clip_output_id, str) or not clip_output_id:
        raise ApplicationError("clip_output_id is required", non_retryable=True, type="InvalidInput")

    try:
        context = await ClipOutputClient().fetch_render_context(clip_output_id)
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            raise ApplicationError(
                (
                    "Clip output render context is no longer available. "
                    "The clip output may have been replaced by a regenerate flow or deleted before rerender started."
                ),
                non_retryable=True,
                type="ClipOutputUnavailable",
            ) from error
        raise
    activity.heartbeat(
        {
            "clip_output_id": context.clip_output_id,
            "job_id": context.job_id,
            "candidate_id": context.candidate_id,
            "source_media_id": context.source_media.media_asset_id,
        }
    )
    return context.model_dump(mode="json")


@activity.defn
async def execute_clip_output_render(payload: dict[str, Any]) -> dict[str, Any]:
    context = ClipRenderContext.model_validate(payload)
    settings = get_settings()

    aspect_ratio = _resolve_aspect_ratio(context.render_settings)
    layout_template = _resolve_layout_template(context.render_settings, aspect_ratio)
    subtitle_format = _resolve_subtitle_format(context.render_settings)
    subtitle_language = _resolve_subtitle_language(context.render_settings)
    subtitle_burned_in = _resolve_subtitle_burned_in(context.render_settings)
    subtitle_max_lines = _resolve_subtitle_max_lines(context.render_settings)
    subtitle_word_highlight = _resolve_subtitle_word_highlight(context.render_settings)
    subtitle_text_case = _resolve_subtitle_text_case(context.render_settings)
    subtitle_position = _resolve_subtitle_position(context.render_settings)
    subtitle_safe_margin_percent = _resolve_subtitle_safe_margin_percent(context.render_settings)
    subtitle_safe_margin_percent = _resolve_effective_subtitle_safe_margin_percent(
        aspect_ratio=aspect_ratio,
        layout_template=layout_template,
        position=subtitle_position,
        safe_margin_percent=subtitle_safe_margin_percent,
    )
    width, height = _resolve_dimensions(aspect_ratio)
    fps = 30
    clip_start_seconds = int(context.candidate.start_ms) / 1000
    clip_duration_seconds = max(int(context.candidate.duration_ms) / 1000, 0.001)
    candidate_metadata = _resolve_render_metadata(context.render_settings)
    candidate_metadata = _build_publish_metadata(
        metadata=candidate_metadata,
        source_media_metadata=context.source_media.metadata,
        aspect_ratio=aspect_ratio,
        layout_template=layout_template,
    )
    crop_strategy = _resolve_crop_strategy(context.render_settings)
    speaker_count = _resolve_speaker_count(
        render_settings=context.render_settings,
        transcript_segments=context.transcript.segments if context.transcript else [],
    )

    working_directory = Path(settings.TEMP_WORKDIR) / "clip-output-renders" / context.clip_output_id
    working_directory.mkdir(parents=True, exist_ok=True)
    final_path = working_directory / "final.mp4"
    metadata_path = working_directory / "metadata.json"
    subtitle_srt_path = working_directory / "subtitle.srt"
    subtitle_ass_path = working_directory / "subtitle.ass"
    subtitle_burn_in_ass_path = working_directory / "subtitle-burn-in.ass"
    subtitle_vtt_path = working_directory / "subtitle.vtt"
    subtitle_json_path = working_directory / "subtitle.json"
    channel_name_path = working_directory / "channel-name.txt"
    channel_tagline_path = working_directory / "channel-tagline.txt"
    headline_path = working_directory / "headline.txt"
    quote_path = working_directory / "quote.txt"
    source_label_path = working_directory / "source-label.txt"
    cleaned_source_path = working_directory / "speech-cleaned-source.mp4"

    original_transcript_segments = context.transcript.segments if context.transcript else []
    speech_cleanup_plan = build_speech_cleanup_plan(
        transcript_segments=original_transcript_segments,
        clip_start_seconds=clip_start_seconds,
        clip_duration_seconds=clip_duration_seconds,
        enabled=_resolve_speech_cleanup_enabled(context.render_settings),
    )
    render_source = str(context.source_media.download_url)
    render_clip_start_seconds = clip_start_seconds
    render_clip_duration_seconds = clip_duration_seconds
    render_transcript_segments = original_transcript_segments
    speech_cleanup_command = None
    if speech_cleanup_plan.applied:
        speech_cleanup_command = build_timeline_cleanup_command(
            source=render_source,
            destination=cleaned_source_path,
            keep_intervals=[
                (span.source_start_seconds, span.source_end_seconds)
                for span in speech_cleanup_plan.timeline
            ],
        )
        await _run_command_with_heartbeat(
            speech_cleanup_command.as_exec_args(),
            timeout_seconds=settings.RENDER_OUTPUT_TIMEOUT_SECONDS,
            heartbeat_details={
                "clip_output_id": context.clip_output_id,
                "job_id": context.job_id,
                "candidate_id": context.candidate.candidate_id,
                "stage": "RENDERING_FINAL_CLIPS",
                "artifact": "speech_cleanup",
            },
        )
        if not cleaned_source_path.exists():
            raise RuntimeError("speech cleanup completed without creating its intermediate output")
        render_source = str(cleaned_source_path)
        render_clip_start_seconds = 0.0
        render_clip_duration_seconds = speech_cleanup_plan.output_duration_seconds
        render_transcript_segments = remap_transcript_segments(
            original_transcript_segments,
            speech_cleanup_plan,
        )

    subtitle_cues = _build_subtitle_cues(
        transcript_segments=render_transcript_segments,
        clip_start_seconds=render_clip_start_seconds,
        clip_duration_seconds=render_clip_duration_seconds,
        max_lines=subtitle_max_lines,
        layout_template=layout_template,
    )
    subtitle_cues = _apply_subtitle_text_case(subtitle_cues, subtitle_text_case)
    subtitle_path_for_upload: Path | None = None
    subtitle_path_for_burn_in: Path | None = None
    if subtitle_cues:
        subtitle_srt_path.write_text(_render_srt(subtitle_cues), encoding="utf-8")
        subtitle_ass_path.write_text(
            _render_ass(
                subtitle_cues,
                layout_template=layout_template,
                word_highlight=subtitle_word_highlight,
                position=subtitle_position,
                safe_margin_percent=subtitle_safe_margin_percent,
            ),
            encoding="utf-8",
        )
        subtitle_vtt_path.write_text(_render_vtt(subtitle_cues), encoding="utf-8")
        subtitle_json_path.write_text(_render_subtitle_json(subtitle_cues), encoding="utf-8")
        subtitle_path_for_upload = _resolve_subtitle_output_path(
            subtitle_format,
            srt_path=subtitle_srt_path,
            ass_path=subtitle_ass_path,
            vtt_path=subtitle_vtt_path,
            json_path=subtitle_json_path,
        )
        if subtitle_burned_in or layout_template == "PODCAST_SPOTLIGHT_9X16":
            subtitle_path_for_burn_in = subtitle_ass_path

    speech_activity_evidence = _build_speech_activity_evidence(
        render_transcript_segments,
        clip_start_seconds=render_clip_start_seconds,
        clip_duration_seconds=render_clip_duration_seconds,
    )
    face_layout_summary = await _detect_face_layout_summary(
        source=render_source,
        clip_start_seconds=render_clip_start_seconds,
        clip_duration_seconds=render_clip_duration_seconds,
        working_directory=working_directory,
        timeout_seconds=min(max(settings.MEDIA_PROBE_TIMEOUT_SECONDS, 20), 90),
        active_speaker_tracking=crop_strategy in {"ACTIVE_SPEAKER", "SMART_SPEAKER"},
        speech_activity_evidence=speech_activity_evidence,
    )

    layout_options = _build_layout_options(
        aspect_ratio=aspect_ratio,
        layout_template=layout_template,
        render_settings=context.render_settings,
        candidate=context.candidate,
        metadata=candidate_metadata,
        source_media_metadata=context.source_media.metadata,
        transcript_segments=render_transcript_segments,
        face_layout_summary=face_layout_summary,
        working_directory=working_directory,
        channel_name_path=channel_name_path,
        channel_tagline_path=channel_tagline_path,
        headline_path=headline_path,
        quote_path=quote_path,
        source_label_path=source_label_path,
        clip_start_seconds_override=render_clip_start_seconds,
        clip_duration_seconds_override=render_clip_duration_seconds,
    )
    if (
        subtitle_path_for_burn_in is not None
        and aspect_ratio == "9:16"
        and layout_options.get("standard_headline_enabled")
        and layout_template != "PODCAST_SPOTLIGHT_9X16"
    ):
        headline_duration = float(layout_options.get("standard_headline_duration_seconds") or 0.0)
        burn_in_cues = _suppress_subtitle_cues_before(subtitle_cues, headline_duration)
        if burn_in_cues:
            subtitle_burn_in_ass_path.write_text(
                _render_ass(
                    burn_in_cues,
                    layout_template=layout_template,
                    word_highlight=subtitle_word_highlight,
                    position=subtitle_position,
                    safe_margin_percent=subtitle_safe_margin_percent,
                ),
                encoding="utf-8",
            )
            subtitle_path_for_burn_in = subtitle_burn_in_ass_path
        else:
            subtitle_path_for_burn_in = None
    logo_fetch_warning: str | None = None
    try:
        logo_fetch_warning = await _materialize_optional_logo(
            layout_options=layout_options,
            working_directory=working_directory,
        )
    except Exception:
        # Branding assets are non-critical. Rendering should continue even if
        # a decorative logo cannot be fetched.
        logo_fetch_warning = "Channel logo could not be prepared for render. Continuing without logo."
        layout_options.pop("logo_source", None)

    render_command = build_clip_render_command(
        source=render_source,
        destination=final_path,
        start_seconds=render_clip_start_seconds,
        duration_seconds=render_clip_duration_seconds,
        source_width=context.source_media.width,
        source_height=context.source_media.height,
        width=width,
        height=height,
        fps=fps,
        video_preset="medium",
        subtitle_path=subtitle_path_for_burn_in,
        layout_template=layout_template,
        layout_options=layout_options,
        crop_strategy=crop_strategy,
    )
    try:
        await _run_command_with_heartbeat(
            render_command.as_exec_args(),
            timeout_seconds=settings.RENDER_OUTPUT_TIMEOUT_SECONDS,
            heartbeat_details={
                "clip_output_id": context.clip_output_id,
                "job_id": context.job_id,
                "candidate_id": context.candidate.candidate_id,
                "stage": "RENDERING_FINAL_CLIPS",
                "artifact": "final",
            },
        )
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="RENDERING_FINAL_CLIPS",
            stage_progress=15,
            error=error,
            user_message="Render video final gagal di worker dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "artifact": "final",
                "aspect_ratio": aspect_ratio,
            },
        )
        raise
    if not final_path.exists():
        missing_final_error = RuntimeError("ffmpeg completed without creating the final render output")
        await emit_retry_warning(
            job_id=context.job_id,
            stage="RENDERING_FINAL_CLIPS",
            stage_progress=20,
            error=missing_final_error,
            user_message="Render video final tidak menghasilkan file output dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "artifact": "final",
            },
        )
        raise missing_final_error

    try:
        final_probe_payload = await run_ffprobe_json(
            str(final_path),
            timeout_seconds=settings.MEDIA_PROBE_TIMEOUT_SECONDS,
        )
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="QUALITY_CHECK",
            stage_progress=80,
            error=error,
            user_message="Validasi output render gagal dibaca dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
            },
        )
        raise
    final_probe_summary = _summarize_render_probe(final_probe_payload)
    validation = _build_validation_summary(
        aspect_ratio=aspect_ratio,
        width=width,
        height=height,
        expected_duration_ms=int(round(render_clip_duration_seconds * 1000)),
        subtitle_format=subtitle_format if subtitle_path_for_upload else None,
        final_observed=final_probe_summary,
        thumbnail_generated=False,
        subtitle_generated=bool(subtitle_path_for_upload and subtitle_path_for_upload.exists()),
        subtitle_cue_count=len(subtitle_cues),
        preview_generated=False,
    )
    if logo_fetch_warning:
        validation["warnings"].append(logo_fetch_warning)
    validation["checks"]["speech_cleanup"] = True
    validation["observed"]["speech_cleanup"] = speech_cleanup_plan.to_metadata()
    if isinstance(face_layout_summary.get("warning"), str):
        validation["warnings"].append(face_layout_summary["warning"])
    tracking_quality = face_layout_summary.get("tracking_quality_gate")
    if isinstance(tracking_quality, dict):
        validation["checks"]["speaker_tracking_quality"] = tracking_quality.get("passed") is True
        validation["observed"]["speaker_tracking"] = tracking_quality
        if tracking_quality.get("passed") is not True:
            validation["warnings"].append(
                "Smart-speaker tracking quality gate used the last reliable speaker framing."
            )

    artifact_uploads = {upload.artifact: upload for upload in context.artifact_uploads}
    uploaded_artifacts: list[dict[str, Any]] = []
    try:
        final_object_key = await _upload_artifact(artifact_uploads.get("final"), final_path, uploaded_artifacts)
        subtitle_object_key = await _upload_artifact(
            artifact_uploads.get("subtitle"),
            subtitle_path_for_upload,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_srt"),
            subtitle_srt_path if subtitle_srt_path.exists() else None,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_ass"),
            subtitle_ass_path if subtitle_ass_path.exists() else None,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_vtt"),
            subtitle_vtt_path if subtitle_vtt_path.exists() else None,
            uploaded_artifacts,
        )
        await _upload_artifact(
            artifact_uploads.get("subtitle_json"),
            subtitle_json_path if subtitle_json_path.exists() else None,
            uploaded_artifacts,
        )
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="UPLOADING_OUTPUTS",
            stage_progress=90,
            error=error,
            user_message="Upload artifact render gagal dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "uploaded_artifact_count": len(uploaded_artifacts),
            },
        )
        raise

    metadata_document = {
        "manifest_version": "phase2-render-manifest-v2",
        "renderer": "ffmpeg-worker-v1",
        "clip_output_id": context.clip_output_id,
        "job_id": context.job_id,
        "candidate": {
            "candidate_id": context.candidate.candidate_id,
            "title": context.candidate.title,
            "summary": context.candidate.summary,
            "hook_text": context.candidate.hook_text,
            "start_ms": context.candidate.start_ms,
            "end_ms": context.candidate.end_ms,
            "duration_ms": context.candidate.duration_ms,
        },
        "source_media": {
            "media_asset_id": context.source_media.media_asset_id,
            "object_key": context.source_media.object_key,
            "duration_ms": context.source_media.duration_ms,
            "source_title": candidate_metadata.get("source_video_title"),
            "source_channel_name": candidate_metadata.get("source_channel_name"),
            "source_attribution": candidate_metadata.get("source_attribution"),
        },
        "render_settings": context.render_settings,
        "render_plan": {
            "command": render_command.as_exec_args(),
            "speech_cleanup_command": (
                speech_cleanup_command.as_exec_args()
                if speech_cleanup_command is not None
                else None
            ),
            "width": width,
            "height": height,
            "fps": fps,
            "subtitle_burned_in": subtitle_burned_in,
            "crop_mode": "split_frame" if layout_options.get("split_frame_enabled") else "single_frame",
            "crop_strategy": crop_strategy,
            "split_frame_enabled": bool(layout_options.get("split_frame_enabled")),
            "split_decision_reason": layout_options.get("split_decision_reason"),
            "split_frame_fallback_mode": layout_options.get("split_frame_fallback_mode"),
            "layout_template": layout_template,
            "speaker_count": speaker_count,
            "active_speaker_count": layout_options.get("active_speaker_count"),
            "adaptive_panel_count": layout_options.get("adaptive_panel_count"),
            "split_evidence_source": face_layout_summary.get("split_evidence_source"),
            "active_speaker_available": bool(
                int(layout_options.get("active_speaker_count") or 0) > 0
                or (
                    isinstance(layout_options.get("active_speaker_strategy"), dict)
                    and layout_options["active_speaker_strategy"].get("available")
                )
            ),
            "active_speaker_source": (
                layout_options["active_speaker_strategy"].get("source")
                if isinstance(layout_options.get("active_speaker_strategy"), dict)
                and layout_options["active_speaker_strategy"].get("available")
                else face_layout_summary.get("split_evidence_source")
            ),
            "active_speaker_switch_lead_seconds": (
                layout_options["active_speaker_strategy"].get("switch_lead_seconds")
                if isinstance(layout_options.get("active_speaker_strategy"), dict)
                else None
            ),
            "active_speaker_tracking_backend": face_layout_summary.get(
                "active_speaker_tracking_backend"
            ),
            "active_speaker_sample_interval_seconds": (
                0.33 if crop_strategy in {"ACTIVE_SPEAKER", "SMART_SPEAKER"} else None
            ),
        },
        "subtitle": {
            "format": subtitle_format if subtitle_path_for_upload else None,
            "language": subtitle_language if subtitle_path_for_upload else None,
            "burned_in": subtitle_burned_in,
            "text_case": subtitle_text_case,
            "cue_count": len(subtitle_cues),
            "sidecars": {
                "srt": subtitle_srt_path.name if subtitle_srt_path.exists() else None,
                "ass": subtitle_ass_path.name if subtitle_ass_path.exists() else None,
                "vtt": subtitle_vtt_path.name if subtitle_vtt_path.exists() else None,
                "json": subtitle_json_path.name if subtitle_json_path.exists() else None,
            },
        },
        "validation": validation,
        "speech_cleanup": speech_cleanup_plan.to_metadata(),
        "artifacts": uploaded_artifacts,
        "metadata": candidate_metadata,
        "branding": layout_options.get("branding"),
        "face_layout": face_layout_summary,
    }
    metadata_path.write_text(json.dumps(metadata_document, indent=2), encoding="utf-8")
    try:
        metadata_object_key = await _upload_artifact(artifact_uploads.get("metadata"), metadata_path, uploaded_artifacts)
    except Exception as error:
        await emit_retry_warning(
            job_id=context.job_id,
            stage="UPLOADING_OUTPUTS",
            stage_progress=95,
            error=error,
            user_message="Upload metadata render gagal dan akan dicoba ulang otomatis.",
            status=None,
            metadata={
                "clip_output_id": context.clip_output_id,
                "candidate_id": context.candidate.candidate_id,
                "artifact": "metadata",
            },
        )
        raise

    quality_status = _resolve_quality_status(validation["status"])
    result = ClipOutputResult(
        quality_status=quality_status,
        preview_object_key=None,
        final_object_key=final_object_key,
        metadata_object_key=metadata_object_key,
        subtitle_object_key=subtitle_object_key,
        subtitle_format=subtitle_format if subtitle_path_for_upload else None,
        subtitle_language=subtitle_language if subtitle_path_for_upload else None,
        subtitle_burned_in=subtitle_burned_in if subtitle_path_for_upload else None,
        quality_report={
            **metadata_document,
            "artifacts": uploaded_artifacts,
            "status": "completed",
        },
        duration_ms=str(final_probe_summary["duration_ms"]) if final_probe_summary["duration_ms"] is not None else None,
        width=final_probe_summary["width"] or width,
        height=final_probe_summary["height"] or height,
    )
    activity.heartbeat(
        {
            "clip_output_id": context.clip_output_id,
            "quality_status": result.quality_status,
            "width": result.width,
            "height": result.height,
        }
    )
    return result.model_dump(mode="json", exclude_none=True)


async def _materialize_optional_logo(
    *,
    layout_options: dict[str, Any],
    working_directory: Path,
) -> str | None:
    logo_source = layout_options.get("logo_source")
    if not isinstance(logo_source, str) or not logo_source.strip():
        return None

    normalized_source = logo_source.strip()
    if normalized_source.startswith(("http://", "https://")):
        local_path = working_directory / "branding-logo"
        downloaded = await _download_optional_asset(normalized_source, local_path)
        if downloaded is None:
            layout_options.pop("logo_source", None)
            return "Channel logo URL was unavailable during render, so the final clip was rendered without logo."
        layout_options["logo_source"] = str(downloaded)
    return None


async def _download_optional_asset(url: str, destination_stem: Path) -> Path | None:
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
    except Exception:
        return None

    suffix = _resolve_asset_suffix_from_url(url)
    destination = destination_stem.with_suffix(suffix)
    destination.write_bytes(response.content)
    return destination


def _resolve_asset_suffix_from_url(url: str) -> str:
    try:
        parsed = httpx.URL(url)
        suffix = Path(parsed.path).suffix.lower()
    except Exception:
        suffix = ""

    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".svg"}:
        return suffix
    return ".img"


@activity.defn
async def submit_clip_output_result(payload: dict[str, Any]) -> None:
    clip_output_id = payload.get("clip_output_id")
    result = payload.get("result")
    if not isinstance(clip_output_id, str) or not isinstance(result, dict):
        raise ApplicationError("clip output result payload is required", non_retryable=True, type="InvalidInput")
    parsed = ClipOutputResult.model_validate(result)
    await ClipOutputClient().submit_result(clip_output_id, parsed)


def _resolve_aspect_ratio(render_settings: dict[str, Any]) -> str:
    visual = render_settings.get("visual")
    if isinstance(visual, dict):
        value = visual.get("aspect_ratio")
        if isinstance(value, str) and value:
            return value
    return "9:16"


def _resolve_speech_cleanup_enabled(render_settings: dict[str, Any]) -> bool:
    strategy = render_settings.get("strategy")
    if not isinstance(strategy, dict):
        return False
    value = strategy.get("speech_cleanup_enabled")
    if isinstance(value, bool):
        return value
    # Old job snapshots can still opt in through both legacy controls.
    return (
        strategy.get("remove_long_silence") is True
        and strategy.get("remove_filler_words") is True
    )


def _resolve_layout_template(render_settings: dict[str, Any], aspect_ratio: str) -> str | None:
    if aspect_ratio != "9:16":
        return None
    visual = render_settings.get("visual")
    if isinstance(visual, dict):
        settings = visual.get("settings")
        if isinstance(settings, dict):
            value = settings.get("layout_template")
            if isinstance(value, str) and value == "PODCAST_SPOTLIGHT_9X16":
                return value
    return None


def _resolve_subtitle_burned_in(render_settings: dict[str, Any]) -> bool:
    subtitle = render_settings.get("subtitle")
    if isinstance(subtitle, dict):
        for key in ("burned_in", "burn_in"):
            value = subtitle.get(key)
            if isinstance(value, bool):
                return value
    return False


def _resolve_visual_settings(render_settings: dict[str, Any]) -> dict[str, Any]:
    visual = render_settings.get("visual")
    if not isinstance(visual, dict):
        return {}
    settings = visual.get("settings")
    if not isinstance(settings, dict):
        return {}
    return settings


def _resolve_crop_strategy(render_settings: dict[str, Any]) -> str:
    visual = render_settings.get("visual")
    if isinstance(visual, dict):
        value = visual.get("crop_strategy")
        if isinstance(value, str) and value.strip():
            return value.strip().upper()
        settings = visual.get("settings")
        if isinstance(settings, dict):
            nested_value = settings.get("crop_strategy")
            if isinstance(nested_value, str) and nested_value.strip():
                return nested_value.strip().upper()
    return "AUTO_REFRAME"


def _resolve_framing_detection_mode(render_settings: dict[str, Any]) -> str:
    visual_settings = _resolve_visual_settings(render_settings)
    value = visual_settings.get("framing_detection_mode")
    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized in {"COMBINED", "TRANSCRIPT_ONLY", "FACE_DETECTION_ONLY"}:
            return normalized
    return "COMBINED"


def _resolve_multi_face_split_enabled(render_settings: dict[str, Any]) -> bool:
    visual_settings = _resolve_visual_settings(render_settings)
    value = visual_settings.get("split_on_multi_face")
    if isinstance(value, bool):
        return value
    return True


def _resolve_split_min_face_count(render_settings: dict[str, Any]) -> int:
    visual_settings = _resolve_visual_settings(render_settings)
    value = visual_settings.get("split_min_face_count")
    if isinstance(value, int) and 1 <= value <= 6:
        return value
    if isinstance(value, float) and 1 <= value <= 6:
        return int(value)
    return 2


def _resolve_speaker_count(
    *,
    render_settings: dict[str, Any],
    transcript_segments: list[TranscriptSegment],
) -> int:
    content = render_settings.get("content")
    if isinstance(content, dict):
        value = content.get("speaker_count")
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, float) and value > 0:
            return int(value)

    candidate = render_settings.get("candidate")
    if isinstance(candidate, dict):
        speaker_ids = candidate.get("speaker_ids")
        if isinstance(speaker_ids, list):
            normalized = [value for value in speaker_ids if isinstance(value, str) and value.strip()]
            if normalized:
                return len(set(normalized))

    transcript_speakers = {
        segment.speaker_label.strip()
        for segment in transcript_segments
        if isinstance(segment.speaker_label, str) and segment.speaker_label.strip()
    }
    return max(1, len(transcript_speakers))


def _resolve_dimensions(aspect_ratio: str) -> tuple[int, int]:
    if aspect_ratio == "1:1":
        return (1080, 1080)
    if aspect_ratio == "4:5":
        return (1080, 1350)
    if aspect_ratio == "16:9":
        return (1920, 1080)
    return (1080, 1920)


def _resolve_target(existing: Any, fallback: str) -> str:
    return existing if isinstance(existing, str) and existing else fallback


def _resolve_subtitle_format(render_settings: dict[str, Any]) -> str:
    subtitle = render_settings.get("subtitle")
    if isinstance(subtitle, dict):
        value = subtitle.get("format")
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in SUPPORTED_SUBTITLE_FORMATS:
                return normalized
    return "srt"


def _resolve_subtitle_output_path(
    subtitle_format: str,
    *,
    srt_path: Path,
    ass_path: Path,
    vtt_path: Path,
    json_path: Path,
) -> Path:
    if subtitle_format == "ass":
        return ass_path
    if subtitle_format == "vtt":
        return vtt_path
    if subtitle_format == "json":
        return json_path
    return srt_path


def _resolve_subtitle_language(render_settings: dict[str, Any]) -> str:
    subtitle = render_settings.get("subtitle")
    if isinstance(subtitle, dict):
        value = subtitle.get("language")
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized:
                return normalized
    return "id"


def _resolve_subtitle_settings(render_settings: dict[str, Any]) -> dict[str, Any]:
    subtitle = render_settings.get("subtitle")
    if not isinstance(subtitle, dict):
        return {}
    settings = subtitle.get("settings")
    if not isinstance(settings, dict):
        return {}
    return settings


def _resolve_subtitle_max_lines(render_settings: dict[str, Any]) -> int:
    settings = _resolve_subtitle_settings(render_settings)
    value = settings.get("max_lines")
    try:
        resolved = int(value)
    except (TypeError, ValueError):
        return 2
    return max(1, min(resolved, 4))


def _resolve_subtitle_word_highlight(render_settings: dict[str, Any]) -> bool:
    settings = _resolve_subtitle_settings(render_settings)
    value = settings.get("word_highlight")
    return value is True


def _resolve_subtitle_text_case(render_settings: dict[str, Any]) -> str:
    settings = _resolve_subtitle_settings(render_settings)
    value = settings.get("text_case")
    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized in {"UPPERCASE", "LOWERCASE", "ORIGINAL"}:
            return normalized
    return "UPPERCASE"


def _resolve_subtitle_position(render_settings: dict[str, Any]) -> str:
    settings = _resolve_subtitle_settings(render_settings)
    value = settings.get("position")
    if isinstance(value, str) and value.strip().upper() in {"TOP", "CENTER", "BOTTOM"}:
        return value.strip().upper()
    return "BOTTOM"


def _resolve_subtitle_safe_margin_percent(render_settings: dict[str, Any]) -> float:
    settings = _resolve_subtitle_settings(render_settings)
    value = settings.get("safe_margin_percent")
    try:
        resolved = float(value)
    except (TypeError, ValueError):
        return 16.0
    return max(0.0, min(resolved, 30.0))


def _resolve_effective_subtitle_safe_margin_percent(
    *,
    aspect_ratio: str,
    layout_template: str | None,
    position: str,
    safe_margin_percent: float,
) -> float:
    resolved = max(0.0, min(float(safe_margin_percent), 30.0))
    if (
        aspect_ratio == "9:16"
        and layout_template is None
        and position.strip().upper() == "BOTTOM"
    ):
        # Keep burned-in captions above Reels/TikTok controls and descriptions.
        return max(resolved, STANDARD_9X16_BOTTOM_SAFE_MARGIN_PERCENT)
    return resolved


def _resolve_render_metadata(render_settings: dict[str, Any]) -> dict[str, Any]:
    metadata = render_settings.get("metadata")
    if not isinstance(metadata, dict):
        return {}

    normalized_related_hashtags = _normalize_hashtags(metadata.get("related_hashtags"), max_items=7)
    normalized_viral_hashtags = _normalize_hashtags(metadata.get("viral_hashtags"), max_items=5)
    normalized_hashtags = _normalize_hashtags(metadata.get("suggested_hashtags"), max_items=10)
    if not normalized_hashtags:
        normalized_hashtags = _normalize_hashtags(
            [*normalized_related_hashtags, *normalized_viral_hashtags],
            max_items=10,
        )

    return {
        "suggested_caption": _resolve_string(metadata.get("suggested_caption")),
        "suggested_cta": _resolve_string(metadata.get("suggested_cta")),
        "related_hashtags": normalized_related_hashtags,
        "viral_hashtags": normalized_viral_hashtags,
        "suggested_hashtags": normalized_hashtags,
        "thumbnail_text": _resolve_string(metadata.get("thumbnail_text")),
        "hook_second": _resolve_number(metadata.get("hook_second")),
        "main_point_second": _resolve_number(metadata.get("main_point_second")),
        "punchline_second": _resolve_number(metadata.get("punchline_second")),
        "retention_level": _resolve_string(metadata.get("retention_level")),
        "requires_context": _resolve_boolean(metadata.get("requires_context")),
        "can_standalone": _resolve_boolean(metadata.get("can_standalone")),
    }


def _build_publish_metadata(
    *,
    metadata: dict[str, Any],
    source_media_metadata: dict[str, Any] | None,
    aspect_ratio: str,
    layout_template: str | None,
) -> dict[str, Any]:
    result = dict(metadata)
    if aspect_ratio != "9:16" or layout_template not in {None, "PODCAST_SPOTLIGHT_9X16"}:
        return result

    source = source_media_metadata if isinstance(source_media_metadata, dict) else {}
    source_title = _first_non_empty_string(source, "source_title", "title")
    source_channel = _first_non_empty_string(
        source,
        "source_channel_name",
        "channel",
        "source_uploader",
        "uploader",
        "creator",
    )
    source_attribution = _format_source_attribution(source_title, source_channel)
    base_caption = _resolve_string(result.get("suggested_caption")) or ""
    hashtags = _normalize_hashtags(
        [
            *_normalize_hashtags(result.get("related_hashtags"), max_items=7),
            *_normalize_hashtags(result.get("viral_hashtags"), max_items=5),
            *_normalize_hashtags(result.get("suggested_hashtags"), max_items=10),
        ],
        max_items=10,
    )

    caption_parts = [base_caption] if base_caption else []
    if source_attribution and source_attribution.casefold() not in base_caption.casefold():
        caption_parts.append(source_attribution)
    hashtag_line = " ".join(tag for tag in hashtags if tag.casefold() not in base_caption.casefold())
    if hashtag_line:
        caption_parts.append(hashtag_line)

    result.update(
        {
            "base_suggested_caption": base_caption or None,
            "suggested_caption": "\n\n".join(caption_parts),
            "suggested_hashtags": hashtags,
            "source_video_title": source_title,
            "source_channel_name": source_channel,
            "source_attribution": source_attribution,
        }
    )
    return result


def _normalize_hashtags(value: Any, *, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        normalized = re.sub(r"\s+", "", item.strip())
        if not normalized:
            continue
        if not normalized.startswith("#"):
            normalized = f"#{normalized}"
        key = normalized.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
        if len(result) >= max_items:
            break
    return result


def _first_non_empty_string(source: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = _resolve_string(source.get(key))
        if value:
            return re.sub(r"\s+", " ", value).strip()
    return None


def _format_source_attribution(source_title: str | None, source_channel: str | None) -> str | None:
    if source_title and source_channel and source_title.casefold() != source_channel.casefold():
        return f"Sumber video: {source_title} - {source_channel}"
    if source_title or source_channel:
        return f"Sumber video: {source_title or source_channel}"
    return None


async def _detect_face_layout_summary(
    *,
    source: str,
    clip_start_seconds: float,
    clip_duration_seconds: float,
    working_directory: Path,
    timeout_seconds: float,
    active_speaker_tracking: bool = False,
    speech_activity_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if clip_duration_seconds <= 0.5:
        return {"status": "skipped", "reason": "clip_too_short"}

    # Local Faster Whisper does not provide diarization labels yet. Sample
    # densely enough for visual close-up changes to remain a useful fallback.
    # A tighter cadence makes speaker changes visible quickly while still
    # keeping the detector workload bounded for long clips.
    sample_interval_seconds = 0.33 if active_speaker_tracking else 1.25
    sample_limit = 180 if active_speaker_tracking else 48
    sample_count = max(4, min(sample_limit, int(clip_duration_seconds / sample_interval_seconds) + 2))
    sample_offsets = _build_face_sample_offsets(clip_duration_seconds=clip_duration_seconds, sample_count=sample_count)
    samples: list[list[dict[str, Any]]] = []
    frame_paths: list[Path] = []
    resolved_sample_offsets: list[float] = []
    runtime_settings = get_settings()
    yunet_model_path = runtime_settings.FACE_DETECTION_YUNET_MODEL_PATH
    try:
        yunet_model_available = bool(
            yunet_model_path
            and Path(yunet_model_path).is_file()
            and Path(yunet_model_path).stat().st_size > 1024
        )
    except OSError:
        yunet_model_available = False

    try:
        for stale_frame in working_directory.glob("face-sample-*.jpg"):
            stale_frame.unlink(missing_ok=True)
        sample_span_seconds = max(sample_offsets[-1] - sample_offsets[0], 0.2)
        frame_rate = max(0.1, (len(sample_offsets) - 1) / sample_span_seconds)
        output_pattern = working_directory / "face-sample-%03d.jpg"
        extraction_command = [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-y",
            "-ss",
            f"{clip_start_seconds + sample_offsets[0]:.3f}",
            "-i",
            source,
            "-t",
            f"{sample_span_seconds + 0.05:.3f}",
            "-vf",
            f"fps={frame_rate:.6f},scale=960:-2",
            "-frames:v",
            str(len(sample_offsets)),
            "-q:v",
            "4",
            str(output_pattern),
        ]
        await _run_command_with_heartbeat(
            extraction_command,
            timeout_seconds=min(max(timeout_seconds, clip_duration_seconds * 2 + 20), 180),
            heartbeat_interval_seconds=8,
            heartbeat_details={
                "stage": "FACE_TRACKING",
                "operation": "extract_tracking_frames",
                "sample_count": len(sample_offsets),
            },
        )

        # FFmpeg's fps filter can legitimately emit one frame fewer because of
        # timestamp rounding. Process the files that were actually finalized
        # instead of assuming every requested sequence number exists.
        frame_paths = sorted(working_directory.glob("face-sample-*.jpg"))[: len(sample_offsets)]
        for index, frame_path in enumerate(frame_paths, start=1):
            offset_seconds = sample_offsets[min(index - 1, len(sample_offsets) - 1)]
            resolved_sample_offsets.append(offset_seconds)
            _heartbeat_face_sampling(
                sample_index=index,
                sample_count=len(frame_paths),
                offset_seconds=offset_seconds,
            )
            # OpenCV cascade detection is CPU-bound and must not block the
            # Temporal worker event loop while other workflows heartbeat.
            detected_faces = await asyncio.to_thread(
                detect_faces_in_image,
                frame_path,
                yunet_model_path=yunet_model_path,
                yunet_score_threshold=runtime_settings.FACE_DETECTION_YUNET_SCORE_THRESHOLD,
            )
            samples.append(detected_faces)
            _heartbeat_face_sampling(
                sample_index=index,
                sample_count=len(frame_paths),
                offset_seconds=offset_seconds,
                detected_face_count=len(detected_faces),
            )
    except FaceDetectionUnavailable as error:
        return {
            "status": "unavailable",
            "reason": "opencv_face_detector_unavailable",
            "detection_backend": "none",
            "sample_count": 0,
            "max_face_count": 0,
            "average_face_count": 0.0,
            "multi_face_sample_count": 0,
            "single_face_sample_count": 0,
            "valid_face_sample_count": 0,
            "left_right_split_samples": 0,
            "single_face_anchor": "center",
            "single_face_anchor_ratio": 0.5,
            "supports_split_frame": False,
            "split_layout_mode": "VERTICAL_STACK",
            "left_anchor_ratio": 0.28,
            "right_anchor_ratio": 0.72,
            "technical_detail": str(error),
            "tracking_fallback_mode": "center_cover_no_face_evidence",
        }
    except Exception as error:
        return {
            "status": "unavailable",
            "warning": f"Face detection skipped because frame sampling failed: {error}",
            "reason": "frame_sampling_failed",
            "detection_backend": "ffmpeg+opencv",
            "valid_face_sample_count": 0,
            "single_face_anchor_ratio": 0.5,
            "split_layout_mode": "VERTICAL_STACK",
            "left_anchor_ratio": 0.28,
            "right_anchor_ratio": 0.72,
            "tracking_fallback_mode": "center_cover_no_face_evidence",
        }

    summary = summarize_face_samples(samples)
    if active_speaker_tracking:
        try:
            evidence = speech_activity_evidence or {}
            active_tracking_samples = await asyncio.to_thread(
                build_active_face_tracking_samples,
                frame_paths,
                samples,
                sample_offsets_seconds=resolved_sample_offsets,
                speech_windows=evidence.get("speech_windows", []),
                overlap_windows=evidence.get("overlap_windows", []),
                conversation_windows=evidence.get("conversation_windows", []),
            )
            has_face_anchor = any(
                isinstance(sample.get("anchor_ratio"), (int, float))
                for sample in active_tracking_samples
                if isinstance(sample, dict)
            )
            summary["active_speaker_tracking_backend"] = (
                "transcript_vad+opencv_lower_face_motion"
                if has_face_anchor
                else "center_cover_no_face_evidence"
            )
            summary = apply_active_speaker_tracking(summary, active_tracking_samples)
            summary["speech_activity_source"] = evidence.get("source", "none")
            summary["diarized_speaker_count"] = evidence.get("speaker_count", 0)
            summary["voice_overlap_window_count"] = len(evidence.get("overlap_windows", []))
            summary["conversation_window_count"] = len(evidence.get("conversation_windows", []))
            content_candidate_count = sum(
                1
                for sample in active_tracking_samples
                if isinstance(sample, dict) and sample.get("content_frame_candidate") is True
            )
            content_sample_threshold = max(2, round(len(active_tracking_samples) * 0.30))
            summary["content_frame_candidate_count"] = content_candidate_count
            summary["content_aware_layout"] = content_candidate_count >= content_sample_threshold
            quality = next(
                (
                    sample.get("tracking_quality")
                    for sample in reversed(active_tracking_samples)
                    if isinstance(sample, dict) and isinstance(sample.get("tracking_quality"), dict)
                ),
                {},
            )
            summary["tracking_quality_gate"] = quality
        except Exception as error:
            summary["active_speaker_tracking_backend"] = "opencv_face_position_fallback"
            summary["active_speaker_tracking_warning"] = (
                f"Mouth-motion tracking was unavailable; face-position tracking was used instead: {error}"
            )
    summary["sample_offsets_seconds"] = [round(value, 3) for value in resolved_sample_offsets]
    detection_sources = sorted(
        {
            str(face.get("detector"))
            for sample in samples
            for face in sample
            if isinstance(face, dict) and face.get("detector")
        }
    )
    summary["detection_sources"] = detection_sources
    summary["detection_backend"] = (
        "opencv_yunet+haar"
        if "yunet" in detection_sources and len(detection_sources) > 1
        else "opencv_yunet"
        if "yunet" in detection_sources
        else "opencv_haar"
    )
    summary["yunet_model_available"] = yunet_model_available
    summary["yunet_score_threshold"] = runtime_settings.FACE_DETECTION_YUNET_SCORE_THRESHOLD
    if int(summary.get("valid_face_sample_count") or 0) == 0:
        summary["tracking_fallback_mode"] = "center_cover_no_face_evidence"
        summary["warning"] = (
            "No reliable face was detected in the sampled frames. The renderer used a stable centered "
            "portrait crop and intentionally ignored hand, object, and background motion."
        )
    else:
        inferred_count = sum(
            1
            for sample in summary.get("tracking_samples", [])
            if isinstance(sample, dict) and sample.get("detection_source") == "upperbody_inferred_head"
        )
        summary["tracking_fallback_mode"] = (
            "upperbody_inferred_head" if inferred_count else "bbox_temporal_tracking"
        )
    return summary


def _heartbeat_face_sampling(
    *,
    sample_index: int,
    sample_count: int,
    offset_seconds: float,
    detected_face_count: int | None = None,
) -> None:
    details: dict[str, Any] = {
        "stage": "FACE_TRACKING",
        "sample_index": sample_index,
        "sample_count": sample_count,
        "offset_seconds": round(offset_seconds, 3),
    }
    if detected_face_count is not None:
        details["detected_face_count"] = detected_face_count
    try:
        activity.heartbeat(details)
    except RuntimeError:
        # Keep this helper directly testable outside a Temporal activity.
        pass


def _build_face_sample_offsets(*, clip_duration_seconds: float, sample_count: int) -> list[float]:
    if sample_count <= 1:
        midpoint = min(max(clip_duration_seconds / 2, 0.1), max(clip_duration_seconds - 0.1, 0.1))
        return [midpoint]

    # Include the actual first frame so tracking metadata and crop expressions
    # are valid from local clip time zero rather than appearing late.
    start_offset = 0.0
    end_offset = max(clip_duration_seconds - 0.05, start_offset + 0.2)
    if end_offset <= start_offset:
        return [round(max(clip_duration_seconds / 2, 0.1), 3)]

    interval = (end_offset - start_offset) / max(sample_count - 1, 1)
    return [round(start_offset + (interval * index), 3) for index in range(sample_count)]


def _build_layout_options(
    *,
    aspect_ratio: str,
    layout_template: str | None,
    render_settings: dict[str, Any],
    candidate: Any,
    metadata: dict[str, Any],
    transcript_segments: list[TranscriptSegment],
    face_layout_summary: dict[str, Any],
    working_directory: Path,
    channel_name_path: Path,
    channel_tagline_path: Path,
    headline_path: Path,
    quote_path: Path,
    source_label_path: Path,
    source_media_metadata: dict[str, Any] | None = None,
    clip_start_seconds_override: float | None = None,
    clip_duration_seconds_override: float | None = None,
) -> dict[str, Any]:
    visual = render_settings.get("visual")
    visual_settings = visual.get("settings") if isinstance(visual, dict) else None
    visual_data = visual_settings if isinstance(visual_settings, dict) else {}
    branding = visual_settings.get("branding") if isinstance(visual_settings, dict) else None
    branding_data = branding if isinstance(branding, dict) else {}
    crop_strategy = _resolve_crop_strategy(render_settings)
    framing_detection_mode = _resolve_framing_detection_mode(render_settings)
    split_on_multi_face = _resolve_multi_face_split_enabled(render_settings)
    split_min_face_count = _resolve_split_min_face_count(render_settings)
    speaker_count = _resolve_speaker_count(render_settings=render_settings, transcript_segments=transcript_segments)
    raw_detected_face_count = face_layout_summary.get("max_face_count")
    detected_face_count = int(raw_detected_face_count) if isinstance(raw_detected_face_count, (int, float)) else 0
    raw_active_speaker_count = face_layout_summary.get("max_active_speaker_count")
    active_speaker_count = (
        int(raw_active_speaker_count)
        if isinstance(raw_active_speaker_count, (int, float))
        else 0
    )
    clip_start_seconds = (
        max(0.0, float(clip_start_seconds_override))
        if clip_start_seconds_override is not None
        else float(candidate.start_ms) / 1000.0
    )
    clip_duration_seconds = (
        max(0.0, float(clip_duration_seconds_override))
        if clip_duration_seconds_override is not None
        else max(0.0, float(candidate.duration_ms) / 1000.0)
    )
    active_speaker_strategy = _build_active_speaker_strategy(
        transcript_segments,
        clip_start_seconds=clip_start_seconds,
        clip_duration_seconds=clip_duration_seconds,
    )
    _attach_speaker_anchor_map(active_speaker_strategy, face_layout_summary)
    face_detection_unavailable = face_layout_summary.get("status") == "unavailable"
    explicit_split_strategy = crop_strategy in {"SPLIT_SCREEN", "SPEAKER_AND_SCREEN", "SMART_SPEAKER"}
    split_frame_supported = bool(face_layout_summary.get("supports_split_frame"))
    split_frame_requested = explicit_split_strategy or (
        crop_strategy == "AUTO_REFRAME" and split_on_multi_face
    )
    content_aware_layout = bool(face_layout_summary.get("content_aware_layout"))
    required_active_speaker_count = 2
    should_split_frame = (
        split_frame_requested
        and not content_aware_layout
        and active_speaker_count >= required_active_speaker_count
        and split_frame_supported
    )
    adaptive_panel_count = min(4, max(1, int(face_layout_summary.get("adaptive_panel_count") or 1)))
    if should_split_frame:
        split_decision_reason = f"{adaptive_panel_count}_active_speakers_stable"
    elif content_aware_layout:
        split_decision_reason = "content_frame_preserved"
    elif face_detection_unavailable:
        split_decision_reason = "face_detection_unavailable"
    elif active_speaker_count < 2:
        split_decision_reason = "single_active_speaker"
    else:
        split_decision_reason = "active_speakers_not_stable"
    channel_name = _resolve_string(branding_data.get("channel_name")) or "Creator Studio"
    channel_tagline = _resolve_string(branding_data.get("channel_tagline"))
    base_options = {
        "crop_strategy": crop_strategy,
        "framing_detection_mode": framing_detection_mode,
        "speaker_count": speaker_count,
        "detected_face_count": detected_face_count,
        "active_speaker_count": active_speaker_count,
        "split_frame_enabled": should_split_frame,
        "content_aware_layout": content_aware_layout,
        "adaptive_panel_count": adaptive_panel_count if should_split_frame else 1,
        "split_decision_reason": split_decision_reason,
        "split_on_multi_face": split_on_multi_face,
        "split_min_face_count": split_min_face_count,
        "split_layout_mode": (
            str(face_layout_summary.get("split_layout_mode")).strip().upper()
            if isinstance(face_layout_summary.get("split_layout_mode"), str)
            else "VERTICAL_STACK"
        ),
        "split_frame_fallback_mode": "single_face_tracking" if not should_split_frame else "detected",
        "clip_duration_seconds": clip_duration_seconds,
        "active_speaker_strategy": active_speaker_strategy,
        "face_layout_summary": face_layout_summary,
        "branding": {
            "channel_name": channel_name,
            "channel_tagline": channel_tagline,
            "brand_kit_name": _resolve_string(branding_data.get("brand_kit_name")),
            "logo_object_key": _resolve_string(branding_data.get("logo_object_key")),
        },
    }

    if layout_template != "PODCAST_SPOTLIGHT_9X16":
        if aspect_ratio != "9:16":
            return base_options
        # Standard portrait clips show the opening headline by default. Older
        # job snapshots may not contain this setting, so only an explicit false
        # disables it.
        headline_enabled = visual_data.get("headline_overlay_enabled") is not False
        headline_position = (
            "TOP" if str(visual_data.get("headline_overlay_position") or "").strip().upper() == "TOP" else "BOTTOM"
        )
        if headline_enabled:
            headline = _select_full_display_title(candidate=candidate, metadata=metadata)
            wrapped_headline = _wrap_full_overlay_text(headline, max_chars=22, max_lines=4)
            headline_files: list[str] = []
            for index, line in enumerate(wrapped_headline.splitlines(), start=1):
                normalized_line = line.strip()
                if not normalized_line:
                    continue
                path = working_directory / f"standard-headline-{index}.txt"
                path.write_text(normalized_line, encoding="utf-8")
                headline_files.append(str(path))
            base_options.update(
                {
                    "standard_headline_enabled": bool(headline_files),
                    "standard_headline_position": headline_position,
                    "standard_headline_files": headline_files,
                    "standard_headline_duration_seconds": round(
                        min(
                            5.0,
                            max(
                                2.8,
                                clip_duration_seconds * 0.10,
                                2.2
                                + (0.32 * len(headline_files))
                                + (0.055 * len(headline.split())),
                            ),
                        ),
                        2,
                    ),
                }
            )
        return base_options

    source_metadata = source_media_metadata if isinstance(source_media_metadata, dict) else {}
    source_channel_name = (
        _resolve_string(source_metadata.get("source_channel_name"))
        or _resolve_string(source_metadata.get("channel"))
        or _resolve_string(source_metadata.get("uploader"))
        or channel_name
    )
    show_source_label = visual_data.get("podcast_source_enabled") is not False
    spotlight_style = (
        "VIDEO_FIRST"
        if str(visual_data.get("podcast_spotlight_style") or "").strip().upper() == "VIDEO_FIRST"
        else "EDITORIAL_GOLD"
    )
    source_label = f"Source: {source_channel_name}" if show_source_label else ""
    headline = _select_display_headline(candidate=candidate, metadata=metadata)
    headline_primary, headline_emphasis = _split_podcast_spotlight_headline_layers(headline)
    has_emphasis = bool(headline_emphasis.strip())
    wrapped_primary = _wrap_overlay_text(
        headline_primary or headline,
        max_chars=18 if has_emphasis else 19,
        max_lines=2 if has_emphasis else 3,
    )
    wrapped_emphasis = _wrap_overlay_text(headline_emphasis, max_chars=16, max_lines=2)
    primary_line_count = _count_text_lines(wrapped_primary)
    emphasis_line_count = _count_text_lines(wrapped_emphasis)
    primary_y = 214
    emphasis_y = 214 + (primary_line_count * 78) + 14
    divider_y = emphasis_y + (emphasis_line_count * 84) + 34 if has_emphasis else 214 + (primary_line_count * 76) + 34
    options = {
        **base_options,
        "headline_primary_size": _resolve_dynamic_font_size(headline_primary or headline, 76, 66, 58),
        "headline_emphasis_size": _resolve_dynamic_font_size(headline_emphasis or headline, 80, 72, 64),
        "headline_primary_y": primary_y,
        "headline_emphasis_y": emphasis_y,
        "headline_divider_y": divider_y,
        "channel_name_size": 28,
        "channel_tagline_size": 20,
        "source_label_size": 22,
        "show_source_label": show_source_label,
        "podcast_spotlight_style": spotlight_style,
        "logo_source": _resolve_string(branding_data.get("logo_internal_url"))
        or _resolve_string(branding_data.get("logo_url")),
    }

    text_targets = [
        (channel_name_path, channel_name),
        (channel_tagline_path, channel_tagline),
        (
            headline_path,
            wrapped_primary,
        ),
        (quote_path, wrapped_emphasis),
        (source_label_path, source_label),
    ]
    key_map = {
        channel_name_path: "channel_name_file",
        channel_tagline_path: "channel_tagline_file",
        headline_path: "headline_primary_file",
        quote_path: "headline_emphasis_file",
        source_label_path: "source_label_file",
    }
    for path, text in text_targets:
        if not text:
            continue
        path.write_text(str(text), encoding="utf-8")
        options[key_map[path]] = str(path)

    return options


def _resolve_multi_subject_count(
    *,
    framing_detection_mode: str,
    speaker_count: int,
    detected_face_count: int,
) -> int:
    if framing_detection_mode == "TRANSCRIPT_ONLY":
        return speaker_count
    if framing_detection_mode == "FACE_DETECTION_ONLY":
        return detected_face_count
    return max(speaker_count, detected_face_count)


def _build_speech_activity_evidence(
    transcript_segments: list[TranscriptSegment],
    *,
    clip_start_seconds: float,
    clip_duration_seconds: float,
) -> dict[str, Any]:
    """Build transcript VAD and trustworthy multi-speaker windows.

    Word/segment timing gates visual mouth motion. Simultaneous speech and
    sustained fast turn-taking are kept separate so the renderer can use a
    two-person layout without treating every visible listener as a speaker.
    """
    clip_end_seconds = clip_start_seconds + clip_duration_seconds
    speech_windows: list[dict[str, Any]] = []
    labelled_windows: list[dict[str, Any]] = []
    labels: set[str] = set()
    for segment in transcript_segments:
        if segment.end_seconds <= clip_start_seconds or segment.start_seconds >= clip_end_seconds:
            continue
        spoken_start, spoken_end = _resolve_spoken_segment_bounds(segment)
        start = max(0.0, spoken_start - clip_start_seconds)
        end = min(clip_duration_seconds, spoken_end - clip_start_seconds)
        if end <= start:
            continue
        speech_windows.append({"start_seconds": start, "end_seconds": end})
        label = segment.speaker_label.strip() if isinstance(segment.speaker_label, str) else ""
        if label:
            labels.add(label)
            labelled_windows.append(
                {"speaker_label": label, "start_seconds": start, "end_seconds": end}
            )

    speech_windows = _merge_activity_windows(speech_windows, maximum_gap_seconds=0.22)
    overlap_windows: list[dict[str, Any]] = []
    boundaries = sorted(
        {
            float(window[key])
            for window in labelled_windows
            for key in ("start_seconds", "end_seconds")
        }
    )
    for start, end in zip(boundaries, boundaries[1:], strict=False):
        midpoint = (start + end) / 2
        active_labels = sorted(
            {
                str(window["speaker_label"])
                for window in labelled_windows
                if float(window["start_seconds"]) <= midpoint < float(window["end_seconds"])
            }
        )
        if len(active_labels) >= 2:
            overlap_windows.append(
                {
                    "start_seconds": start,
                    "end_seconds": end,
                    "speaker_count": min(4, len(active_labels)),
                    "speaker_labels": active_labels[:4],
                }
            )

    overlap_windows = [
        window
        for window in _merge_overlap_windows(overlap_windows)
        if float(window["end_seconds"]) - float(window["start_seconds"]) >= 0.7
    ]
    merged_labelled_windows = _merge_adjacent_speaker_windows(labelled_windows)
    conversation_windows: list[dict[str, Any]] = []
    for current, following in zip(
        merged_labelled_windows,
        merged_labelled_windows[1:],
        strict=False,
    ):
        if current.get("speaker_label") == following.get("speaker_label"):
            continue
        current_duration = float(current["end_seconds"]) - float(current["start_seconds"])
        following_duration = float(following["end_seconds"]) - float(following["start_seconds"])
        turn_gap = float(following["start_seconds"]) - float(current["end_seconds"])
        if current_duration < 0.7 or following_duration < 0.7 or turn_gap > 1.0:
            continue
        conversation_windows.append(
            {
                "start_seconds": max(0.0, float(current["start_seconds"])),
                "end_seconds": min(clip_duration_seconds, float(following["end_seconds"])),
                "speaker_count": 2,
                "speaker_labels": [
                    str(current["speaker_label"]),
                    str(following["speaker_label"]),
                ],
            }
        )
    conversation_windows = _merge_activity_windows(
        conversation_windows,
        maximum_gap_seconds=1.0,
    )
    return {
        "source": "transcript_word_vad" if speech_windows else "none",
        "speech_windows": speech_windows,
        "overlap_windows": overlap_windows,
        "conversation_windows": conversation_windows,
        "speaker_count": len(labels),
    }


def _merge_activity_windows(
    windows: list[dict[str, Any]],
    *,
    maximum_gap_seconds: float,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for source in sorted(windows, key=lambda item: float(item["start_seconds"])):
        window = dict(source)
        if merged and float(window["start_seconds"]) - float(merged[-1]["end_seconds"]) <= maximum_gap_seconds:
            merged[-1]["end_seconds"] = max(float(merged[-1]["end_seconds"]), float(window["end_seconds"]))
        else:
            merged.append(window)
    return merged


def _merge_overlap_windows(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for source in windows:
        window = dict(source)
        if (
            merged
            and merged[-1].get("speaker_labels") == window.get("speaker_labels")
            and float(window["start_seconds"]) - float(merged[-1]["end_seconds"]) <= 0.08
        ):
            merged[-1]["end_seconds"] = float(window["end_seconds"])
        else:
            merged.append(window)
    return merged


def _build_active_speaker_strategy(
    transcript_segments: list[TranscriptSegment],
    *,
    clip_start_seconds: float,
    clip_duration_seconds: float,
) -> dict[str, Any]:
    speaker_order: list[str] = []
    speaker_windows: list[dict[str, Any]] = []
    clip_end_seconds = clip_start_seconds + clip_duration_seconds

    for segment in transcript_segments:
        label = segment.speaker_label.strip() if isinstance(segment.speaker_label, str) else ""
        if not label or segment.end_seconds <= clip_start_seconds or segment.start_seconds >= clip_end_seconds:
            continue
        if label not in speaker_order:
            speaker_order.append(label)
        segment_start, segment_end = _resolve_spoken_segment_bounds(segment)
        relative_start = max(0.0, segment_start - clip_start_seconds)
        relative_end = min(clip_duration_seconds, segment_end - clip_start_seconds)
        if relative_end <= relative_start:
            continue
        if (
            speaker_windows
            and speaker_windows[-1]["speaker_label"] == label
            and relative_start - float(speaker_windows[-1]["end_seconds"]) <= 0.35
        ):
            speaker_windows[-1]["end_seconds"] = relative_end
            continue
        speaker_windows.append(
            {
                "speaker_label": label,
                "start_seconds": relative_start,
                "end_seconds": relative_end,
            }
        )

    speaker_windows = _collapse_micro_speaker_turns(speaker_windows)
    speaker_windows = _merge_adjacent_speaker_windows(speaker_windows)

    # Start moving shortly before the first syllable and finish just before it.
    # A short smooth transition feels responsive without producing a hard jump.
    switch_lead_seconds = 0.20
    transition_seconds = 0.16
    if speaker_windows:
        speaker_windows[0]["start_seconds"] = 0.0
    for index in range(1, len(speaker_windows)):
        previous = speaker_windows[index - 1]
        current = speaker_windows[index]
        if previous["speaker_label"] == current["speaker_label"]:
            continue
        speech_start = float(current["start_seconds"])
        switch_at = max(float(previous["start_seconds"]), speech_start - switch_lead_seconds)
        previous["end_seconds"] = switch_at
        current["start_seconds"] = switch_at
        current["speech_start_seconds"] = speech_start

    if speaker_windows:
        speaker_windows[-1]["end_seconds"] = clip_duration_seconds

    speaker_windows = [
        window
        for window in speaker_windows
        if float(window["end_seconds"]) - float(window["start_seconds"]) >= 0.08
    ]
    active_speakers = speaker_order[:2]

    return {
        "available": len(active_speakers) >= 2 and bool(speaker_windows),
        "source": "transcript_diarization" if len(active_speakers) >= 2 else "face_tracking_fallback",
        "switch_lead_seconds": switch_lead_seconds,
        "transition_seconds": transition_seconds,
        "speaker_order": active_speakers,
        "windows": speaker_windows,
    }


def _resolve_spoken_segment_bounds(segment: TranscriptSegment) -> tuple[float, float]:
    valid_words = [
        word
        for word in segment.words
        if word.end_seconds > word.start_seconds
        and word.end_seconds > segment.start_seconds - 0.5
        and word.start_seconds < segment.end_seconds + 0.5
    ]
    if not valid_words:
        return float(segment.start_seconds), float(segment.end_seconds)
    return float(valid_words[0].start_seconds), float(valid_words[-1].end_seconds)


def _collapse_micro_speaker_turns(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(windows) < 3:
        return windows
    collapsed = [dict(window) for window in windows]
    for index in range(1, len(collapsed) - 1):
        previous = collapsed[index - 1]
        current = collapsed[index]
        following = collapsed[index + 1]
        duration = float(current["end_seconds"]) - float(current["start_seconds"])
        if (
            duration < 0.28
            and previous["speaker_label"] == following["speaker_label"]
            and current["speaker_label"] != previous["speaker_label"]
        ):
            current["speaker_label"] = previous["speaker_label"]
    return collapsed


def _merge_adjacent_speaker_windows(windows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for source_window in windows:
        window = dict(source_window)
        if (
            merged
            and merged[-1]["speaker_label"] == window["speaker_label"]
            and float(window["start_seconds"]) - float(merged[-1]["end_seconds"]) <= 0.45
        ):
            merged[-1]["end_seconds"] = max(
                float(merged[-1]["end_seconds"]),
                float(window["end_seconds"]),
            )
            continue
        merged.append(window)
    return merged


def _attach_speaker_anchor_map(
    strategy: dict[str, Any],
    face_layout_summary: dict[str, Any],
) -> None:
    speaker_order = strategy.get("speaker_order")
    windows = strategy.get("windows")
    offsets = face_layout_summary.get("sample_offsets_seconds")
    pairs = face_layout_summary.get("sample_anchor_pairs")
    if not isinstance(speaker_order, list) or len(speaker_order) < 2 or not isinstance(windows, list):
        return

    left_anchor = float(face_layout_summary.get("left_anchor_ratio") or 0.28)
    right_anchor = float(face_layout_summary.get("right_anchor_ratio") or 0.72)
    fallback_map = {
        str(speaker_order[0]): left_anchor,
        str(speaker_order[1]): right_anchor,
    }
    evidence: dict[str, list[float]] = {str(label): [] for label in speaker_order[:2]}
    if isinstance(offsets, list) and isinstance(pairs, list):
        for index, offset in enumerate(offsets):
            if index >= len(pairs) or not isinstance(offset, (int, float)) or not isinstance(pairs[index], dict):
                continue
            sample = pairs[index]
            if sample.get("face_count") != 1:
                continue
            anchor = sample.get("primary_anchor_ratio")
            if not isinstance(anchor, (int, float)):
                continue
            active_window = next(
                (
                    window
                    for window in windows
                    if float(window["start_seconds"]) <= float(offset) <= float(window["end_seconds"])
                ),
                None,
            )
            if active_window is None:
                continue
            label = str(active_window["speaker_label"])
            if label in evidence:
                evidence[label].append(float(anchor))

    resolved = {
        label: round(float(median(values)), 4)
        for label, values in evidence.items()
        if values
    }
    if len(resolved) == 1:
        known_label, known_anchor = next(iter(resolved.items()))
        other_label = next(label for label in fallback_map if label != known_label)
        resolved[other_label] = right_anchor if known_anchor < 0.5 else left_anchor

    resolved_values = list(resolved.values())
    if len(resolved) < 2 or abs(resolved_values[0] - resolved_values[1]) < 0.15:
        strategy["speaker_anchor_ratios"] = fallback_map
        strategy["speaker_anchor_source"] = "left_right_fallback"
        return

    strategy["speaker_anchor_ratios"] = resolved
    strategy["speaker_anchor_source"] = "single_face_visual_evidence"


def _resolve_dynamic_font_size(text: str, short_size: int, medium_size: int, long_size: int) -> int:
    normalized_length = len(" ".join(text.split()))
    if normalized_length <= 28:
        return short_size
    if normalized_length <= 60:
        return medium_size
    return long_size


def _normalize_render_text(text: str) -> str:
    normalized = str(text or "")
    normalized = normalized.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\\r", "\n")
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = re.sub(r"[ \t\f\v]+", " ", normalized)
    normalized = re.sub(r"\n+", "\n", normalized)
    return normalized.strip()


def _normalize_headline_text(text: str) -> str:
    normalized = " ".join(_normalize_render_text(text).split()).strip()
    if not normalized:
        return "HIGHLIGHT CLIP"
    return normalized.upper()


def _select_display_headline(candidate: Any, metadata: dict[str, Any]) -> str:
    raw_candidates = [
        _resolve_string(metadata.get("thumbnail_text")),
        _resolve_string(getattr(candidate, "hook_text", None)),
        _resolve_string(getattr(candidate, "title", None)),
        _resolve_string(getattr(candidate, "summary", None)),
    ]
    normalized_options: list[str] = []
    for option in raw_candidates:
        if not isinstance(option, str) or not option.strip():
            continue
        normalized_options.extend(_headline_variants(option))

    normalized_options = list(dict.fromkeys(item for item in normalized_options if item.strip()))
    if not normalized_options:
        return "HIGHLIGHT CLIP"

    selected = max(normalized_options, key=_score_headline_candidate)
    return _normalize_headline_text(selected)


def _select_full_display_title(candidate: Any, metadata: dict[str, Any]) -> str:
    """Return the complete title for the standard opening headline."""
    raw_candidates = [
        _resolve_string(getattr(candidate, "title", None)),
        _resolve_string(metadata.get("thumbnail_text")),
        _resolve_string(getattr(candidate, "hook_text", None)),
        _resolve_string(getattr(candidate, "summary", None)),
    ]
    for option in raw_candidates:
        if option:
            return _normalize_headline_text(option)
    return "HIGHLIGHT CLIP"


def _normalize_headline_candidate(text: str) -> str:
    normalized = " ".join(_normalize_render_text(text).split()).strip()
    if not normalized:
        return "Highlight clip"

    clause_candidates = [
        part.strip(" -,:;.!?\"'()[]{}")
        for part in normalized.replace("...", ".").replace("?", ".").replace("!", ".").split(".")
        if part.strip(" -,:;.!?\"'()[]{}")
    ]
    if clause_candidates:
        normalized = max(clause_candidates, key=_score_headline_candidate)

    normalized = _strip_weak_headline_prefix(normalized)
    normalized = _trim_dangling_headline_tail(normalized)

    words = normalized.split()
    if len(words) > 9:
        normalized = " ".join(words[:9]).strip(" -,:;")
    return normalized


def _headline_variants(text: str) -> list[str]:
    normalized = " ".join(_normalize_render_text(text).split()).strip()
    if not normalized:
        return []

    variants: list[str] = []

    def add_variant(value: str) -> None:
        candidate = _normalize_headline_candidate(value)
        if candidate:
            variants.append(candidate)

    add_variant(normalized)

    sentence_like_parts = [
        part.strip()
        for part in normalized.replace("...", ".").replace("?", ".").replace("!", ".").split(".")
        if part.strip()
    ]
    for part in sentence_like_parts:
        add_variant(part)

    comma_parts = [
        part.strip(" -,:;.!?\"'()[]{}")
        for part in normalized.replace("?", ",").replace("!", ",").split(",")
        if part.strip(" -,:;.!?\"'()[]{}")
    ]
    for part in comma_parts:
        add_variant(part)

    question_focus = _extract_question_focus(normalized)
    if question_focus:
        add_variant(question_focus)

    consequence_focus = _extract_consequence_focus(normalized)
    if consequence_focus:
        add_variant(consequence_focus)

    keyword_window = _extract_keyword_window(normalized)
    if keyword_window:
        add_variant(keyword_window)

    return variants


def _score_headline_candidate(text: str) -> float:
    normalized = " ".join(str(text).split()).strip()
    if not normalized:
        return -100.0

    words = normalized.split()
    word_count = len(words)
    char_count = len(normalized)
    score = 0.0

    if word_count <= 1:
        score -= 12.0
    elif word_count == 2:
        score -= 5.0

    if 3 <= word_count <= 8:
        score += 6.0
    elif word_count <= 10:
        score += 3.0
    else:
        score -= (word_count - 10) * 1.25

    if char_count <= 52:
        score += 3.0
    else:
        score -= (char_count - 52) * 0.12

    if normalized.endswith("..."):
        score -= 4.0

    curiosity_terms = (
        "KENAPA",
        "GIMANA",
        "BISA",
        "JANGAN",
        "TERNYATA",
        "BAHAYA",
        "SALAH",
        "KRISIS",
        "WOW",
        "KOK",
    )
    uppercase = normalized.upper()
    if any(term in uppercase for term in curiosity_terms):
        score += 2.0

    filler_terms = {"OH", "WOW", "OKE", "OKE-OKE", "NAH", "GITU", "MASA"}
    filler_hits = sum(1 for word in words if word.strip(".,!?").upper() in filler_terms)
    score -= filler_hits * 4.0

    weak_prefix_penalty_terms = {
        "OH",
        "WOW",
        "OKE",
        "OKE-OKE",
        "NAH",
        "JADI",
        "GITU",
        "MASA",
        "TAPI",
    }
    if words:
        leading_tokens = [word.strip(".,!?").upper() for word in words[:2]]
        if all(token in weak_prefix_penalty_terms for token in leading_tokens if token):
            score -= 6.0
        elif leading_tokens[0] in weak_prefix_penalty_terms:
            score -= 3.5

    strong_signal_terms = (
        "TEKANAN",
        "PECAH",
        "KREKING",
        "KRISIS",
        "BAHAYA",
        "BISA",
        "KENAPA",
        "GIMANA",
        "KALAU",
        "NAIK",
        "SALAH",
        "JEBOL",
        "MELEDAK",
        "RISIKO",
        "PIPA",
    )
    signal_hits = sum(1 for term in strong_signal_terms if term in uppercase)
    score += min(5.0, signal_hits * 1.15)

    if "?" in normalized:
        score += 1.4

    if any(char.isdigit() for char in normalized):
        score += 0.8

    if _ends_with_dangling_word(normalized):
        score -= 5.0

    if _starts_with_meaningful_pattern(uppercase):
        score += 2.2

    return score


def _strip_weak_headline_prefix(text: str) -> str:
    normalized = " ".join(str(text).split()).strip(" -,:;.!?\"'()[]{}")
    if not normalized:
        return "Highlight clip"

    weak_prefixes = (
        "oh wow",
        "wow",
        "oke oke",
        "oke-oke",
        "oke",
        "nah",
        "jadi",
        "gitu",
        "masa",
        "tapi",
    )

    lowered = normalized.lower()
    changed = True
    while changed:
        changed = False
        for prefix in weak_prefixes:
            if lowered == prefix:
                continue
            if lowered.startswith(f"{prefix} "):
                normalized = normalized[len(prefix):].strip(" -,:;.!?\"'()[]{}")
                lowered = normalized.lower()
                changed = True
                break

    return normalized or text


def _trim_dangling_headline_tail(text: str) -> str:
    words = [word for word in str(text).split() if word]
    if not words:
        return text

    dangling_terms = {
        "aja",
        "aja.",
        "dong",
        "kan",
        "kayak",
        "kaya",
        "mas",
        "mbak",
        "bro",
        "nih",
        "sih",
        "itu",
        "ini",
        "gini",
        "gitu",
        "ya",
        "ya...",
        "deh",
    }

    while len(words) > 3:
        tail = words[-1].strip(" -,:;.!?\"'()[]{}").lower()
        if tail not in dangling_terms:
            break
        words.pop()

    return " ".join(words).strip()


def _ends_with_dangling_word(text: str) -> bool:
    words = [word for word in str(text).split() if word]
    if not words:
        return False
    tail = words[-1].strip(" -,:;.!?\"'()[]{}").lower()
    return tail in {"dan", "atau", "yang", "kalau", "karena", "jadi", "tapi", "buat", "biar"}


def _starts_with_meaningful_pattern(text: str) -> bool:
    strong_prefixes = (
        "KENAPA ",
        "GIMANA ",
        "KALAU ",
        "PIPA ",
        "TEKANAN ",
        "RISIKO ",
        "BAHAYA ",
        "BISA ",
        "JANGAN ",
    )
    return text.startswith(strong_prefixes)


def _extract_question_focus(text: str) -> str | None:
    lowered = text.lower()
    if "kalau" in lowered and "gimana" in lowered:
        start = lowered.find("kalau")
        end = lowered.find("gimana")
        if start >= 0 and end > start:
            return text[start : end + len("gimana")].strip(" -,:;.!?\"'()[]{}") + "?"

    if "kenapa" in lowered:
        start = lowered.find("kenapa")
        return text[start:].strip(" -,:;.!?\"'()[]{}")

    return None


def _extract_consequence_focus(text: str) -> str | None:
    lowered = text.lower()
    patterns = (
        ("kalau", "jadi"),
        ("kalau", "bisa"),
        ("tekanan", "tinggi"),
        ("pipa", "tekanan"),
    )
    words = text.split()
    lowered_words = [word.strip(" -,:;.!?\"'()[]{}").lower() for word in words]

    for left, right in patterns:
        for index, word in enumerate(lowered_words):
            if word != left:
                continue
            window = words[index : min(len(words), index + 8)]
            candidate = " ".join(window).strip(" -,:;.!?\"'()[]{}")
            if right in candidate.lower():
                return candidate
    return None


def _extract_keyword_window(text: str) -> str | None:
    keywords = (
        "tekanan",
        "tinggi",
        "pipa",
        "krisis",
        "bahaya",
        "risiko",
        "kreking",
        "pecah",
        "jebol",
        "meledak",
    )
    words = text.split()
    lowered_words = [word.strip(" -,:;.!?\"'()[]{}").lower() for word in words]

    for index, lowered_word in enumerate(lowered_words):
        if lowered_word not in keywords:
            continue
        start = max(0, index - 2)
        end = min(len(words), index + 5)
        candidate = " ".join(words[start:end]).strip(" -,:;.!?\"'()[]{}")
        if len(candidate.split()) >= 3:
            return candidate

    return None


def _split_headline_layers(text: str) -> tuple[str, str]:
    normalized = _normalize_headline_text(text)
    words = normalized.split()
    if len(words) < 5:
        return normalized, ""

    strong_emphasis_terms = {
        "BAHAYA",
        "KRISIS",
        "SALAH",
        "RISIKO",
        "GIMANA",
        "KENAPA",
        "BISA",
        "KALAU",
        "JANGAN",
        "TEKANAN",
        "TINGGI",
        "NAIK",
        "PECAH",
        "KREKING",
        "JEBOL",
        "MELEDAK",
        "PIPA",
    }

    best_pair: tuple[str, str] | None = None
    best_score = float("-inf")

    for pivot in range(2, len(words) - 1):
        primary_words = words[:pivot]
        emphasis_words = words[pivot:]
        primary = " ".join(primary_words).strip()
        emphasis = " ".join(emphasis_words).strip()
        if not primary or not emphasis:
            continue
        if len(primary_words) > 6 or len(emphasis_words) > 5:
            continue

        score = 0.0
        score -= abs(len(primary_words) - len(emphasis_words)) * 0.8
        score -= abs(len(primary) - len(emphasis)) * 0.08
        score += sum(1 for word in emphasis_words if word.strip(".,!?").upper() in strong_emphasis_terms) * 1.6

        if primary_words[-1].strip(".,!?").upper() in {"KALAU", "KARENA", "TAPI", "DAN", "ATAU"}:
            score -= 4.0
        if emphasis_words[0].strip(".,!?").upper() in {"DAN", "ATAU", "YANG"}:
            score -= 2.5
        if 2 <= len(primary_words) <= 4:
            score += 1.0
        if 2 <= len(emphasis_words) <= 4:
            score += 1.0

        if score > best_score:
            best_score = score
            best_pair = (primary, emphasis)

    if best_pair is not None:
        return best_pair

    return normalized, ""


def _split_podcast_spotlight_headline_layers(text: str) -> tuple[str, str]:
    normalized = _normalize_headline_text(text)
    words = normalized.split()
    if len(words) < 4:
        return normalized, ""

    editorial_split = _find_editorial_headline_split(words)
    if editorial_split is not None:
        return editorial_split

    return _split_headline_layers(normalized)


def _find_editorial_headline_split(words: list[str]) -> tuple[str, str] | None:
    strong_emphasis_terms = {
        "BAHAYA",
        "KRISIS",
        "SALAH",
        "RISIKO",
        "GIMANA",
        "KENAPA",
        "BISA",
        "JANGAN",
        "TEKANAN",
        "TINGGI",
        "NAIK",
        "PECAH",
        "KREKING",
        "JEBOL",
        "MELEDAK",
        "PIPA",
        "RUNTUH",
        "HANCUR",
    }
    weak_edge_terms = {"DAN", "ATAU", "YANG", "KARENA", "KALAU", "TAPI", "JADI", "DI", "KE", "DARI"}

    best_pair: tuple[str, str] | None = None
    best_score = float("-inf")

    for pivot in range(2, len(words) - 1):
        primary_words = words[:pivot]
        emphasis_words = words[pivot:]
        primary = " ".join(primary_words).strip()
        emphasis = " ".join(emphasis_words).strip()
        if not primary or not emphasis:
            continue
        if len(primary_words) > 5 or len(emphasis_words) > 5:
            continue

        score = 0.0
        score += sum(1 for word in emphasis_words if word.strip(".,!?").upper() in strong_emphasis_terms) * 2.0
        score -= sum(1 for word in emphasis_words if word.strip(".,!?").upper() in weak_edge_terms) * 1.8
        score -= sum(1 for word in primary_words if word.strip(".,!?").upper() in weak_edge_terms) * 0.6
        score -= abs(len(primary_words) - len(emphasis_words)) * 0.75
        score -= abs(len(primary) - len(emphasis)) * 0.06

        if primary_words[-1].strip(".,!?").upper() in weak_edge_terms:
            score -= 4.5
        if emphasis_words[0].strip(".,!?").upper() in weak_edge_terms:
            score -= 3.0
        if len(primary_words) in {2, 3, 4}:
            score += 0.9
        if len(emphasis_words) in {2, 3, 4}:
            score += 1.1
        if emphasis.endswith("?"):
            score += 1.6
        if len(emphasis_words) >= len(primary_words):
            score += 0.7

        if score > best_score:
            best_score = score
            best_pair = (primary, emphasis)

    return best_pair


def _count_text_lines(text: str) -> int:
    if not text:
        return 0
    return max(1, len([line for line in str(text).splitlines() if line.strip()]))


def _wrap_overlay_text(text: str, *, max_chars: int, max_lines: int = 4) -> str:
    words = [word for word in str(text).split() if word]
    if not words:
        return ""
    lines: list[str] = []
    current: list[str] = []
    current_length = 0
    for word in words:
        projected = current_length + len(word) + (1 if current else 0)
        if current and projected > max_chars:
            lines.append(" ".join(current))
            current = [word]
            current_length = len(word)
        else:
            current.append(word)
            current_length = projected
    if current:
        lines.append(" ".join(current))
    limited = lines[:max_lines]
    if len(lines) > max_lines and limited:
        limited[-1] = limited[-1].rstrip(" .,") + "..."
    return "\n".join(limited)


def _wrap_full_overlay_text(text: str, *, max_chars: int, max_lines: int = 4) -> str:
    """Wrap an overlay without dropping words or adding an ellipsis."""
    words = [word for word in str(text).split() if word]
    if not words:
        return ""

    effective_max_chars = max(1, max_chars)
    while True:
        lines: list[str] = []
        current: list[str] = []
        current_length = 0
        for word in words:
            projected = current_length + len(word) + (1 if current else 0)
            if current and projected > effective_max_chars:
                lines.append(" ".join(current))
                current = [word]
                current_length = len(word)
            else:
                current.append(word)
                current_length = projected
        if current:
            lines.append(" ".join(current))
        if len(lines) <= max_lines:
            return "\n".join(lines)
        effective_max_chars += 1


def _suppress_subtitle_cues_before(
    cues: list[SubtitleCue],
    minimum_start_seconds: float,
) -> list[SubtitleCue]:
    """Keep the standard opening headline free from burned-in subtitles."""
    threshold = max(0.0, float(minimum_start_seconds))
    if threshold <= 0.0:
        return cues

    adjusted: list[SubtitleCue] = []
    for cue in cues:
        if cue.end_seconds <= threshold:
            continue
        if cue.start_seconds >= threshold:
            adjusted.append(cue)
            continue

        remaining_words: list[SubtitleCueWord] = []
        cursor = cue.start_seconds
        for word in cue.words:
            duration_seconds = max(0.01, word.duration_centiseconds / 100.0)
            word_start = (
                cue.start_seconds + (word.start_offset_centiseconds / 100.0)
                if word.start_offset_centiseconds is not None
                else cursor
            )
            word_end = word_start + duration_seconds
            if word_end > threshold:
                visible_start = max(word_start, threshold)
                visible_duration = word_end - visible_start
                remaining_words.append(
                    SubtitleCueWord(
                        text=word.text,
                        duration_centiseconds=max(1, round(visible_duration * 100)),
                        line_break_before=(word.line_break_before and bool(remaining_words)),
                        start_offset_centiseconds=max(0, round((visible_start - threshold) * 100)),
                    )
                )
            cursor = max(cursor, word_end)

        if remaining_words:
            lines: list[list[str]] = [[]]
            for word in remaining_words:
                if word.line_break_before and lines[-1]:
                    lines.append([])
                lines[-1].append(word.text)
            visible_text = "\n".join(" ".join(line) for line in lines if line)
            adjusted.append(
                SubtitleCue(
                    start_seconds=threshold,
                    end_seconds=cue.end_seconds,
                    text=visible_text,
                    words=tuple(remaining_words),
                )
            )
            continue

        # Cues without word timing still remain complete, but begin only after
        # the opening headline has disappeared.
        adjusted.append(
            SubtitleCue(
                start_seconds=threshold,
                end_seconds=cue.end_seconds,
                text=cue.text,
                words=cue.words,
            )
        )
    return adjusted


def _resolve_string(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    return None


def _resolve_number(value: Any) -> float | int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    return None


def _resolve_boolean(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def _build_validation_summary(
    *,
    aspect_ratio: str,
    width: int,
    height: int,
    expected_duration_ms: int,
    subtitle_format: str | None,
    final_observed: dict[str, Any],
    thumbnail_generated: bool,
    subtitle_generated: bool,
    subtitle_cue_count: int,
    preview_generated: bool,
) -> dict[str, Any]:
    observed_duration_ms = final_observed.get("duration_ms")
    observed_width = final_observed.get("width")
    observed_height = final_observed.get("height")
    observed_audio_codec = final_observed.get("audio_codec_name")
    observed_video_codec = final_observed.get("codec_name")
    observed_has_audio = bool(final_observed.get("has_audio"))
    duration_delta_ms = (
        abs(int(observed_duration_ms) - expected_duration_ms)
        if isinstance(observed_duration_ms, int)
        else None
    )
    checks = {
        "playable": isinstance(observed_duration_ms, int) and observed_duration_ms > 0,
        "resolution_matches_target": observed_width == width and observed_height == height,
        "audio_present": observed_has_audio,
        "video_codec_matches_target": str(observed_video_codec or "").lower() in {"h264", "avc1"},
        "audio_codec_matches_target": str(observed_audio_codec or "").lower() == "aac",
        "subtitle_export_ready": bool(subtitle_format),
        "duration_within_tolerance": duration_delta_ms is not None and duration_delta_ms <= 750,
        "preview_playable": True,
        "thumbnail_generated": thumbnail_generated,
        "subtitle_sidecar_generated": subtitle_generated,
        "subtitle_cues_present": subtitle_cue_count > 0 if subtitle_format else True,
    }
    critical_checks = (
        checks["playable"],
        checks["resolution_matches_target"],
        checks["audio_present"],
        checks["video_codec_matches_target"],
        checks["audio_codec_matches_target"],
        checks["duration_within_tolerance"],
    )
    warnings: list[str] = []
    if not checks["audio_present"]:
        warnings.append("Rendered clip does not expose an audio stream.")
    if not checks["resolution_matches_target"]:
        warnings.append("Rendered clip resolution does not match the requested aspect ratio target.")
    if not checks["duration_within_tolerance"]:
        warnings.append("Rendered clip duration differs from the candidate window beyond tolerance.")
    if subtitle_format and not checks["subtitle_sidecar_generated"]:
        warnings.append("Subtitle sidecar artifact was not generated.")
    return {
        "status": "passed" if all(critical_checks) else "needs_review",
        "checks": checks,
        "expected": {
            "aspect_ratio": aspect_ratio,
            "video_codec": "h264",
            "audio_codec": "aac",
            "pixel_format": "yuv420p",
            "container": "mp4",
            "fps": 30,
            "width": width,
            "height": height,
        },
        "observed": {
            "final": {
                **final_observed,
                "subtitle_format": subtitle_format,
            },
            "preview": None,
            "preview_generated": preview_generated,
            "thumbnail_generated": thumbnail_generated,
            "subtitle_generated": subtitle_generated,
            "subtitle_cue_count": subtitle_cue_count,
        },
        "warnings": warnings,
    }


def _resolve_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(str(value))
    except ValueError:
        return None


def _build_subtitle_cues(
    *,
    transcript_segments: list[TranscriptSegment],
    clip_start_seconds: float,
    clip_duration_seconds: float,
    max_lines: int = 2,
    layout_template: str | None = None,
) -> list[SubtitleCue]:
    clip_end_seconds = clip_start_seconds + clip_duration_seconds
    max_words_per_line, max_chars_per_line = _resolve_subtitle_layout_limits(
        max_lines=max_lines,
        layout_template=layout_template,
    )
    words: list[tuple[float, float, str]] = []
    for segment in transcript_segments:
        if segment.end_seconds <= clip_start_seconds or segment.start_seconds >= clip_end_seconds:
            continue

        if segment.words and _segment_word_alignment_is_usable(segment):
            for word in segment.words:
                if word.end_seconds <= clip_start_seconds or word.start_seconds >= clip_end_seconds:
                    continue
                words.append(
                    (
                        max(word.start_seconds, clip_start_seconds),
                        min(word.end_seconds, clip_end_seconds),
                        _normalize_render_text(word.text),
                    )
                )
            continue

        words.extend(
            _build_fallback_segment_word_entries(
                segment=segment,
                clip_start_seconds=clip_start_seconds,
                clip_end_seconds=clip_end_seconds,
            )
        )

    words = [entry for entry in words if entry[2]]
    if not words:
        return []

    cues: list[SubtitleCue] = []
    current_start: float | None = None
    current_end: float | None = None
    current_words: list[str] = []
    current_entries: list[tuple[float, float, str]] = []
    for index, (start, end, text) in enumerate(words):
        if current_start is None:
            current_start = start
            current_end = end
            current_words = [text]
            current_entries = [(start, end, text)]
            continue

        current_end = max(current_end or end, end)
        current_words.append(text)
        current_entries.append((start, end, text))
        if _subtitle_exceeds_layout(
            current_words,
            max_lines=max_lines,
            max_words_per_line=max_words_per_line,
            max_chars_per_line=max_chars_per_line,
        ):
            finalized_words, overflow_words = _split_subtitle_words_for_layout(
                current_words,
                max_lines=max_lines,
                max_words_per_line=max_words_per_line,
                max_chars_per_line=max_chars_per_line,
            )
            if current_start is not None and finalized_words:
                finalized_entries = current_entries[: len(finalized_words)]
                overflow_entries = current_entries[len(finalized_words) :]
                finalized_start = finalized_entries[0][0]
                finalized_end = finalized_entries[-1][1]
                cues.append(
                    SubtitleCue(
                        start_seconds=max(0.0, finalized_start - clip_start_seconds),
                        end_seconds=max(0.1, finalized_end - clip_start_seconds),
                        text=_format_subtitle_text(
                            finalized_words,
                            max_lines=max_lines,
                            max_words_per_line=max_words_per_line,
                            max_chars_per_line=max_chars_per_line,
                        ),
                        words=_build_subtitle_cue_words(
                            finalized_words,
                            finalized_start,
                            finalized_end,
                            word_timings=finalized_entries,
                            max_lines=max_lines,
                            max_words_per_line=max_words_per_line,
                            max_chars_per_line=max_chars_per_line,
                        ),
                    )
                )
            current_start = overflow_entries[0][0] if overflow_entries else None
            current_end = overflow_entries[-1][1] if overflow_entries else None
            current_words = overflow_words
            current_entries = overflow_entries
            continue

        has_terminal_punctuation = text.endswith((".", "!", "?"))
        has_soft_boundary = text.endswith((",", ";", ":"))
        has_next_gap = False
        if index + 1 < len(words):
            next_start = words[index + 1][0]
            has_next_gap = (next_start - current_end) >= 0.45
        has_strong_next_gap = False
        if index + 1 < len(words):
            next_start = words[index + 1][0]
            has_strong_next_gap = (next_start - current_end) >= 0.8
        cue_duration = current_end - current_start
        word_count = len(current_words)
        reached_soft_limit = word_count >= 14 or cue_duration >= 6.0
        reached_hard_limit = word_count >= 20 or cue_duration >= 8.0
        dangling_tail = _subtitle_has_dangling_tail(current_words)
        if (
            reached_hard_limit
            or (
                has_strong_next_gap
                and word_count >= 5
                and not dangling_tail
            )
            or (
                reached_soft_limit
                and (
                    (has_terminal_punctuation and word_count >= 5)
                    or (has_soft_boundary and word_count >= 7 and not dangling_tail)
                    or (has_next_gap and word_count >= 8 and not dangling_tail)
                )
            )
        ):
            cues.append(
                SubtitleCue(
                    start_seconds=max(0.0, current_start - clip_start_seconds),
                    end_seconds=max(0.1, current_end - clip_start_seconds),
                    text=_format_subtitle_text(
                        current_words,
                        max_lines=max_lines,
                        max_words_per_line=max_words_per_line,
                        max_chars_per_line=max_chars_per_line,
                    ),
                    words=_build_subtitle_cue_words(
                        current_words,
                        current_start,
                        current_end,
                        word_timings=current_entries,
                        max_lines=max_lines,
                        max_words_per_line=max_words_per_line,
                        max_chars_per_line=max_chars_per_line,
                    ),
                )
            )
            current_start = None
            current_end = None
            current_words = []
            current_entries = []

    if current_start is not None and current_end is not None and current_words:
        cues.append(
            SubtitleCue(
                start_seconds=max(0.0, current_start - clip_start_seconds),
                end_seconds=max(0.1, current_end - clip_start_seconds),
                text=_format_subtitle_text(
                    current_words,
                    max_lines=max_lines,
                    max_words_per_line=max_words_per_line,
                    max_chars_per_line=max_chars_per_line,
                ),
                words=_build_subtitle_cue_words(
                    current_words,
                    current_start,
                    current_end,
                    word_timings=current_entries,
                    max_lines=max_lines,
                    max_words_per_line=max_words_per_line,
                    max_chars_per_line=max_chars_per_line,
                ),
            )
        )
    return cues


def _resolve_subtitle_layout_limits(
    *,
    max_lines: int,
    layout_template: str | None,
) -> tuple[int, int]:
    normalized_max_lines = max(1, min(max_lines, 4))
    if layout_template == "PODCAST_SPOTLIGHT_9X16":
        if normalized_max_lines <= 2:
            return (3, 16)
        if normalized_max_lines == 3:
            return (4, 20)
        return (5, 24)
    if normalized_max_lines <= 2:
        return (4, 18)
    if normalized_max_lines == 3:
        return (5, 24)
    return (8, 48)


def _format_subtitle_text(
    words: list[str],
    *,
    max_lines: int = 2,
    max_words_per_line: int,
    max_chars_per_line: int,
) -> str:
    if not words:
        return ""

    normalized_words = _normalize_subtitle_words(words)
    if not normalized_words:
        return ""

    if len(normalized_words) <= max_words_per_line and max_lines <= 1:
        return " ".join(normalized_words)
    wrapped_lines = _wrap_subtitle_lines(
        normalized_words,
        max_words_per_line=max_words_per_line,
        max_chars_per_line=max_chars_per_line,
        max_lines=max_lines,
    )
    return "\n".join(wrapped_lines)


def _find_balanced_subtitle_split_index(
    words: list[str],
    *,
    max_words_per_line: int,
    max_chars_per_line: int,
) -> int:
    if len(words) < 2:
        return len(words)

    best_index = 0
    best_score = float("-inf")
    total = len(words)

    for index in range(2, total):
        first_words = words[:index]
        second_words = words[index:]
        if len(first_words) > max_words_per_line + 1 or len(second_words) > max_words_per_line + 2:
            continue

        first_line = " ".join(first_words).strip()
        second_line = " ".join(second_words).strip()
        if len(first_line) > max_chars_per_line + 6 or len(second_line) > max_chars_per_line + 8:
            continue

        score = 0.0
        score -= abs(len(first_line) - len(second_line)) * 0.18
        score -= abs(len(first_words) - len(second_words)) * 0.6

        prev_word = _normalize_subtitle_boundary_word(first_words[-1])
        next_word = _normalize_subtitle_boundary_word(second_words[0])
        raw_prev_word = first_words[-1]

        if raw_prev_word.endswith((",", ";", ":")):
            score += 2.0
        if raw_prev_word.endswith((".", "!", "?")):
            score += 2.4
        if prev_word in _subtitle_trailing_weak_terms():
            score -= 4.0
        if next_word in _subtitle_leading_weak_terms():
            score -= 2.2
        if 3 <= len(first_words) <= 7:
            score += 1.2
        if 3 <= len(second_words) <= 8:
            score += 1.2

        if score > best_score:
            best_score = score
            best_index = index

    return best_index


def _wrap_subtitle_lines(
    words: list[str],
    *,
    max_words_per_line: int,
    max_chars_per_line: int,
    max_lines: int,
) -> list[str]:
    normalized_max_lines = max(1, min(max_lines, 4))
    if not words:
        return []
    if normalized_max_lines == 1:
        return [" ".join(words)]
    if normalized_max_lines == 2:
        split_index = _find_balanced_subtitle_split_index(
            words,
            max_words_per_line=max_words_per_line,
            max_chars_per_line=max_chars_per_line,
        )
        if 0 < split_index < len(words):
            first_line = " ".join(words[:split_index]).strip()
            second_line = " ".join(words[split_index:]).strip()
            if first_line and second_line:
                return [first_line, second_line]

    return _wrap_subtitle_fallback(
        words,
        max_words_per_line=max_words_per_line,
        max_chars_per_line=max_chars_per_line,
        max_lines=normalized_max_lines,
    )


def _subtitle_exceeds_layout(
    words: list[str],
    *,
    max_lines: int,
    max_words_per_line: int,
    max_chars_per_line: int,
) -> bool:
    normalized_words = [word.strip() for word in words if word.strip()]
    if not normalized_words:
        return False
    return _count_required_subtitle_lines(
        normalized_words,
        max_words_per_line=max_words_per_line,
        max_chars_per_line=max_chars_per_line,
    ) > max(1, min(max_lines, 4))


def _split_subtitle_words_for_layout(
    words: list[str],
    *,
    max_lines: int,
    max_words_per_line: int,
    max_chars_per_line: int,
) -> tuple[list[str], list[str]]:
    normalized_words = [word.strip() for word in words if word.strip()]
    if len(normalized_words) <= 1:
        return normalized_words, []

    best_index = len(normalized_words) - 1
    best_score = float("-inf")

    for index in range(1, len(normalized_words)):
        leading = normalized_words[:index]
        trailing = normalized_words[index:]
        if not leading or not trailing:
            continue
        if _subtitle_exceeds_layout(
            leading,
            max_lines=max_lines,
            max_words_per_line=max_words_per_line,
            max_chars_per_line=max_chars_per_line,
        ):
            continue

        score = float(index)
        leading_tail = _normalize_subtitle_boundary_word(leading[-1])
        trailing_head = _normalize_subtitle_boundary_word(trailing[0])

        if leading_tail in _subtitle_trailing_weak_terms():
            score -= 8.0
        if trailing_head in _subtitle_leading_weak_terms():
            score -= 6.0
        if len(leading) < 3:
            score -= 3.0
        if len(trailing) < 2:
            score -= 2.0

        if score > best_score:
            best_score = score
            best_index = index

    return normalized_words[:best_index], normalized_words[best_index:]


def _normalize_subtitle_boundary_word(word: str) -> str:
    return word.strip(" -,:;.!?\"'()[]{}").lower()


def _subtitle_trailing_weak_terms() -> set[str]:
    return {
        "dan",
        "atau",
        "yang",
        "di",
        "ke",
        "dari",
        "karena",
        "kalau",
        "tapi",
        "jadi",
        "supaya",
        "agar",
        "buat",
        "biar",
        "lalu",
        "terus",
    }


def _subtitle_leading_weak_terms() -> set[str]:
    return {
        "dan",
        "atau",
        "yang",
        "di",
        "ke",
        "dari",
        "lalu",
        "terus",
    }


def _count_required_subtitle_lines(
    words: list[str],
    *,
    max_words_per_line: int,
    max_chars_per_line: int,
) -> int:
    if not words:
        return 0

    line_count = 1
    current_line_words = 0
    current_line_length = 0

    for word in words:
        projected_length = current_line_length + len(word) + (1 if current_line_words else 0)
        if current_line_words and (
            current_line_words >= max_words_per_line
            or projected_length > max_chars_per_line
        ):
            line_count += 1
            current_line_words = 1
            current_line_length = len(word)
            continue

        current_line_words += 1
        current_line_length = projected_length

    return line_count


def _wrap_subtitle_fallback(
    words: list[str],
    *,
    max_words_per_line: int,
    max_chars_per_line: int,
    max_lines: int,
) -> list[str]:
    lines: list[str] = []
    current_line: list[str] = []
    current_length = 0

    for normalized in words:
        projected_length = current_length + len(normalized) + (1 if current_line else 0)
        should_wrap = current_line and (
            len(current_line) >= max_words_per_line
            or projected_length > max_chars_per_line
        )

        if should_wrap and len(lines) < max(0, max_lines - 1):
            lines.append(" ".join(current_line))
            current_line = [normalized]
            current_length = len(normalized)
            continue

        current_line.append(normalized)
        current_length = projected_length

    if current_line:
        lines.append(" ".join(current_line))

    if len(lines) <= max_lines:
        return lines

    if max_lines <= 1:
        return [" ".join(words)]

    return [*lines[: max_lines - 1], " ".join(lines[max_lines - 1 :])]


def _build_subtitle_cue_words(
    words: list[str],
    cue_start_seconds: float,
    cue_end_seconds: float,
    *,
    word_timings: list[tuple[float, float, str]] | None = None,
    max_lines: int,
    max_words_per_line: int,
    max_chars_per_line: int,
) -> tuple[SubtitleCueWord, ...]:
    normalized_words = _normalize_subtitle_words(words)
    if not normalized_words:
        return ()

    lines = _wrap_subtitle_lines(
        normalized_words,
        max_words_per_line=max_words_per_line,
        max_chars_per_line=max_chars_per_line,
        max_lines=max_lines,
    )
    line_word_counts = [len(line.split()) for line in lines if line.strip()]
    timed_words = _normalize_timed_subtitle_words(word_timings or [])
    timing_is_usable = (
        len(timed_words) == len(normalized_words)
        and [entry[2] for entry in timed_words] == normalized_words
    )
    total_duration_centiseconds = max(1, int(round((cue_end_seconds - cue_start_seconds) * 100)))
    base_duration = total_duration_centiseconds // max(len(normalized_words), 1)
    remainder = total_duration_centiseconds % max(len(normalized_words), 1)

    cue_words: list[SubtitleCueWord] = []
    line_start_indexes: set[int] = set()
    offset = 0
    for count in line_word_counts:
        line_start_indexes.add(offset)
        offset += count

    for index, word in enumerate(normalized_words):
        if timing_is_usable:
            word_start, word_end, _ = timed_words[index]
            start_offset_centiseconds = max(0, round((word_start - cue_start_seconds) * 100))
            duration_centiseconds = max(1, round((word_end - word_start) * 100))
        else:
            start_offset_centiseconds = sum(
                max(1, base_duration + (1 if prior_index < remainder else 0))
                for prior_index in range(index)
            )
            duration_centiseconds = max(1, base_duration + (1 if index < remainder else 0))
        cue_words.append(
            SubtitleCueWord(
                text=word,
                duration_centiseconds=duration_centiseconds,
                line_break_before=index in line_start_indexes and index != 0,
                start_offset_centiseconds=start_offset_centiseconds,
            )
        )

    return tuple(cue_words)


def _normalize_timed_subtitle_words(
    entries: list[tuple[float, float, str]],
) -> list[tuple[float, float, str]]:
    normalized: list[tuple[float, float, str]] = []
    for start_seconds, end_seconds, raw_text in entries:
        tokens = _normalize_subtitle_words([raw_text])
        if not tokens or end_seconds <= start_seconds:
            continue
        token_duration = (end_seconds - start_seconds) / len(tokens)
        for index, token in enumerate(tokens):
            token_start = start_seconds + (token_duration * index)
            token_end = start_seconds + (token_duration * (index + 1))
            normalized.append((token_start, token_end, token))
    return normalized


def _normalize_subtitle_words(words: list[str]) -> list[str]:
    normalized_words: list[str] = []
    for raw_word in words:
        compact = " ".join(str(raw_word).split()).strip()
        if not compact:
            continue
        normalized_words.extend(part for part in compact.split(" ") if part)
    return normalized_words


def _subtitle_has_dangling_tail(words: list[str]) -> bool:
    if not words:
        return False

    dangling_terms = {
        "dan",
        "atau",
        "yang",
        "kalau",
        "karena",
        "jadi",
        "tapi",
        "buat",
        "biar",
        "supaya",
        "agar",
        "sampai",
        "dengan",
        "di",
        "ke",
        "dari",
    }
    tail = words[-1].strip(" -,:;.!?\"'()[]{}").lower()
    return tail in dangling_terms


def _segment_word_alignment_is_usable(segment: TranscriptSegment) -> bool:
    raw_words = [word.text.strip() for word in segment.words if word.text.strip()]
    if len(raw_words) < 2:
        return False

    segment_tokens = _normalize_subtitle_tokens(segment.text)
    word_tokens = _normalize_subtitle_tokens(" ".join(raw_words))
    if not segment_tokens or not word_tokens:
        return False
    if segment_tokens == word_tokens:
        return True

    overlap = sum(1 for left, right in zip(segment_tokens, word_tokens) if left == right)
    token_ratio = len(word_tokens) / max(len(segment_tokens), 1)
    overlap_ratio = overlap / max(min(len(segment_tokens), len(word_tokens)), 1)

    if token_ratio < 0.75:
        return False
    if overlap_ratio < 0.65:
        return False

    return True


def _build_fallback_segment_word_entries(
    *,
    segment: TranscriptSegment,
    clip_start_seconds: float,
    clip_end_seconds: float,
) -> list[tuple[float, float, str]]:
    normalized_segment_text = _normalize_render_text(segment.text)
    normalized_words = [part for part in re.split(r"\s+", normalized_segment_text) if part]
    if not normalized_words:
        return []

    segment_duration = max(segment.end_seconds - segment.start_seconds, 0.001)
    step = segment_duration / max(len(normalized_words), 1)
    entries: list[tuple[float, float, str]] = []

    for index, word in enumerate(normalized_words):
        word_start = segment.start_seconds + (step * index)
        word_end = segment.start_seconds + (step * (index + 1))
        if word_end <= clip_start_seconds or word_start >= clip_end_seconds:
            continue
        entries.append(
            (
                max(word_start, clip_start_seconds),
                min(word_end, clip_end_seconds),
                word.strip(),
            )
        )

    return entries


def _normalize_subtitle_tokens(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", _normalize_render_text(text).lower())
    if not normalized:
        return []
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)?", normalized)


def _apply_subtitle_text_case(cues: list[SubtitleCue], text_case: str) -> list[SubtitleCue]:
    normalized_case = str(text_case or "UPPERCASE").strip().upper()
    if normalized_case == "ORIGINAL":
        return cues

    transform = str.lower if normalized_case == "LOWERCASE" else str.upper
    return [
        SubtitleCue(
            start_seconds=cue.start_seconds,
            end_seconds=cue.end_seconds,
            text=transform(cue.text),
            words=tuple(
                SubtitleCueWord(
                    text=transform(word.text),
                    duration_centiseconds=word.duration_centiseconds,
                    line_break_before=word.line_break_before,
                    start_offset_centiseconds=word.start_offset_centiseconds,
                )
                for word in cue.words
            ),
        )
        for cue in cues
    ]


def _render_srt(cues: list[SubtitleCue]) -> str:
    lines: list[str] = []
    for index, cue in enumerate(cues, start=1):
        lines.extend(
            [
                str(index),
                f"{_format_srt_timestamp(cue.start_seconds)} --> {_format_srt_timestamp(cue.end_seconds)}",
                cue.text,
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def _render_ass(
    cues: list[SubtitleCue],
    *,
    layout_template: str | None = None,
    word_highlight: bool = False,
    position: str = "BOTTOM",
    safe_margin_percent: float = 12.0,
) -> str:
    normalized_position = position.strip().upper()
    alignment = 8 if normalized_position == "TOP" else 5 if normalized_position == "CENTER" else 2
    margin_v = 0 if alignment == 5 else max(120, int(round(1920 * safe_margin_percent / 100)))
    style_lines = [(
        "Style: Default,Arial,56,&H00FFFFFF,&H0000FFFF,&H00111111,&H66000000,"
        f"1,0,0,0,100,100,0,0,1,3,0,{alignment},64,64,{margin_v},1"
    )]
    word_font_size = 62
    if layout_template == "PODCAST_SPOTLIGHT_9X16":
        alignment = 2
        margin_v = 410
        word_font_size = 48
        style_lines = [(
            "Style: Default,Arial,48,&H00FFFFFF,&H006FF7C9,&H00131823,&H00000000,"
            "1,0,0,0,100,100,0,0,1,2.6,0,2,170,170,410,1"
        )]
        if word_highlight:
            style_lines.append(
                (
                    f"Style: Highlight,Arial,{word_font_size},&H00FFFFFF,&H00FFFFFF,&H00111111,&H00000000,"
                    "1,0,0,0,100,100,0,0,1,4,1,5,0,0,0,1"
                )
            )
    elif word_highlight:
        # Reference palette: blue #4B8FF7 and mint #7DE7C4. ASS stores
        # colours as AABBGGRR, so the byte order below is intentionally BGR.
        style_lines = [
            (
                f"Style: Default,Arial,{word_font_size},&H00FFFFFF,&H00FFFFFF,&H00111111,&H88000000,"
                f"1,0,0,0,100,100,0,0,1,4,1,{alignment},64,64,{margin_v},1"
            ),
            (
                f"Style: Highlight,Arial,{word_font_size},&H00FFFFFF,&H00FFFFFF,&H00111111,&H00000000,"
                "1,0,0,0,100,100,0,0,1,4,1,5,0,0,0,1"
            ),
        ]

    header = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1080",
        "PlayResY: 1920",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *style_lines,
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    events: list[str] = []
    for cue in cues:
        if word_highlight and cue.words:
            events.extend(
                _render_ass_word_highlight_events(
                    cue,
                    alignment=alignment,
                    margin_v=margin_v,
                    font_size=word_font_size,
                )
            )
            continue
        events.append(
            f"Dialogue: 0,{_format_ass_timestamp(cue.start_seconds)},{_format_ass_timestamp(cue.end_seconds)},Default,,0,0,0,,{_render_ass_cue_text(cue, word_highlight=word_highlight)}"
        )
    return "\n".join([*header, *events]) + "\n"


def _render_vtt(cues: list[SubtitleCue]) -> str:
    lines = ["WEBVTT", ""]
    for cue in cues:
        lines.extend(
            [
                f"{_format_vtt_timestamp(cue.start_seconds)} --> {_format_vtt_timestamp(cue.end_seconds)}",
                cue.text,
                "",
            ]
        )
    return "\n".join(lines).strip() + "\n"


def _render_subtitle_json(cues: list[SubtitleCue]) -> str:
    payload = {
        "format": "json-timing-v1",
        "cue_count": len(cues),
        "cues": [
            {
                "start_seconds": round(cue.start_seconds, 3),
                "end_seconds": round(cue.end_seconds, 3),
                "text": cue.text,
            }
            for cue in cues
        ],
    }
    return json.dumps(payload, indent=2, ensure_ascii=True)


def _render_ass_cue_text(cue: SubtitleCue, *, word_highlight: bool) -> str:
    if not word_highlight or not cue.words:
        return _escape_ass_text(cue.text)

    parts: list[str] = []
    for word in cue.words:
        if word.line_break_before and parts:
            parts.append(r"\N")
        escaped_text = _escape_ass_text(word.text)
        parts.append(rf"{{\kf{max(1, word.duration_centiseconds)}}}{escaped_text}")
        parts.append(" ")

    return "".join(parts).strip()


def _render_ass_word_highlight_events(
    cue: SubtitleCue,
    *,
    alignment: int,
    margin_v: int,
    font_size: int,
) -> list[str]:
    lines: list[list[SubtitleCueWord]] = [[]]
    for word in cue.words:
        if word.line_break_before and lines[-1]:
            lines.append([])
        lines[-1].append(word)
    lines = [line for line in lines if line]
    if not lines:
        return []

    line_height = max(58.0, font_size * 1.34)
    block_height = line_height * len(lines)
    if alignment == 8:
        block_center_y = margin_v + (block_height / 2)
    elif alignment == 5:
        block_center_y = 960.0
    else:
        block_center_y = 1920.0 - margin_v - (block_height / 2)
    first_line_y = block_center_y - ((len(lines) - 1) * line_height / 2)

    positions: list[tuple[SubtitleCueWord, int, int, float]] = []
    for line_index, line in enumerate(lines):
        widths = [_estimate_ass_word_width(word.text, font_size) for word in line]
        spacing = _resolve_ass_word_spacing(line, font_size)
        line_width = sum(widths) + (spacing * max(0, len(line) - 1))
        cursor_x = 540.0 - (line_width / 2)
        line_y = int(round(first_line_y + (line_index * line_height)))
        for word, word_width in zip(line, widths, strict=True):
            positions.append((word, int(round(cursor_x + (word_width / 2))), line_y, word_width))
            cursor_x += word_width + spacing

    events: list[str] = []
    cue_start = _format_ass_timestamp(cue.start_seconds)
    cue_end = _format_ass_timestamp(cue.end_seconds)
    elapsed_seconds = 0.0
    for word, x_position, y_position, word_width in positions:
        positioned_text = rf"{{\an5\pos({x_position},{y_position})}}{_escape_ass_text(word.text)}"
        events.append(f"Dialogue: 0,{cue_start},{cue_end},Default,,0,0,0,,{positioned_text}")

        word_offset_seconds = (
            word.start_offset_centiseconds / 100.0
            if word.start_offset_centiseconds is not None
            else elapsed_seconds
        )
        word_duration_seconds = max(1, word.duration_centiseconds) / 100.0
        highlight_start = min(cue.end_seconds, cue.start_seconds + word_offset_seconds)
        highlight_end = min(cue.end_seconds, highlight_start + word_duration_seconds)
        elapsed_seconds = max(elapsed_seconds, word_offset_seconds + word_duration_seconds)
        if highlight_end <= highlight_start:
            continue
        events.extend(
            _render_ass_highlight_backplate_events(
                start_seconds=highlight_start,
                end_seconds=highlight_end,
                x_position=x_position,
                y_position=y_position,
                word_width=word_width,
                font_size=font_size,
            )
        )
        events.append(
            "Dialogue: 2,"
            f"{_format_ass_timestamp(highlight_start)},{_format_ass_timestamp(highlight_end)},"
            f"Highlight,,0,0,0,,{positioned_text}"
        )
    return events


def _render_ass_highlight_backplate_events(
    *,
    start_seconds: float,
    end_seconds: float,
    x_position: int,
    y_position: int,
    word_width: float,
    font_size: int,
) -> list[str]:
    padding_x = max(10, int(round(font_size * 0.18)))
    plate_width = max(24, int(round(word_width)) + (padding_x * 2))
    plate_height = max(36, int(round(font_size * 1.18)))
    left = int(round(x_position - (plate_width / 2)))
    top = int(round(y_position - (plate_height / 2)))
    palette = (
        "&H00F78F4B&",
        "&H00F2A150&",
        "&H00EDB355&",
        "&H00E5C45B&",
        "&H00DCD162&",
        "&H00D4DC69&",
        "&H00CCE272&",
        "&H00C4E77D&",
    )
    start_timestamp = _format_ass_timestamp(start_seconds)
    end_timestamp = _format_ass_timestamp(end_seconds)
    events: list[str] = []
    for index, color in enumerate(palette):
        slice_left = int(round(index * plate_width / len(palette)))
        slice_right = int(round((index + 1) * plate_width / len(palette)))
        drawing = (
            rf"{{\an7\pos({left},{top})\p1\bord0\shad0\1c{color}}}"
            f"m {slice_left} 0 l {slice_right} 0 l {slice_right} {plate_height} "
            f"l {slice_left} {plate_height}"
        )
        events.append(
            f"Dialogue: 1,{start_timestamp},{end_timestamp},Default,,0,0,0,,{drawing}"
        )
    return events


def _estimate_ass_word_width(text: str, font_size: int) -> float:
    width_units = 0.0
    for character in text:
        if character in ".,'`!|:;":
            width_units += 0.30
        elif character in "iljtfrI":
            width_units += 0.34
        elif character in "MW@#%&":
            width_units += 0.94
        elif character.isupper():
            # Arial Bold capitals are wider than lowercase glyphs. Each word
            # is positioned independently, so underestimating uppercase text
            # makes adjacent words overlap despite a space in the source cue.
            width_units += 0.68
        elif character in "mw":
            width_units += 0.86
        elif character.isspace():
            width_units += 0.32
        else:
            width_units += 0.58
    return max(font_size * 0.55, width_units * font_size)


def _resolve_ass_word_spacing(words: list[SubtitleCueWord], font_size: int) -> float:
    visible_characters = "".join(word.text for word in words if word.text)
    uppercase_letters = sum(character.isupper() for character in visible_characters)
    letters = sum(character.isalpha() for character in visible_characters)
    uppercase_ratio = uppercase_letters / letters if letters else 0.0

    # Highlight words use a thick outline and separate backplates. Uppercase
    # needs additional optical separation so those layers never touch.
    spacing_scale = 0.46 if uppercase_ratio >= 0.75 else 0.32
    return max(12.0, font_size * spacing_scale)


def _format_srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours = milliseconds // 3_600_000
    minutes = (milliseconds % 3_600_000) // 60_000
    secs = (milliseconds % 60_000) // 1000
    ms = milliseconds % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def _format_ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, int(round(seconds * 100)))
    hours = centiseconds // 360_000
    minutes = (centiseconds % 360_000) // 6_000
    secs = (centiseconds % 6_000) // 100
    cs = centiseconds % 100
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _format_vtt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours = milliseconds // 3_600_000
    minutes = (milliseconds % 3_600_000) // 60_000
    secs = (milliseconds % 60_000) // 1000
    ms = milliseconds % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def _escape_ass_text(text: str) -> str:
    normalized = _normalize_render_text(text)
    escaped = normalized.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")
    return escaped.replace("\n", r"\N")


async def _run_command(command: list[str], *, timeout_seconds: float) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    communication_task = asyncio.create_task(process.communicate())
    try:
        _stdout, stderr = await asyncio.wait_for(asyncio.shield(communication_task), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        await _stop_subprocess(process, communication_task)
        raise TimeoutError(f"command timed out: {command[0]}")
    except asyncio.CancelledError:
        await _stop_subprocess(process, communication_task)
        raise
    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "command exited with a non-zero status"
        raise RuntimeError(message)


async def _run_command_with_heartbeat(
    command: list[str],
    *,
    timeout_seconds: float,
    heartbeat_details: dict[str, Any],
    heartbeat_interval_seconds: float = 10,
) -> None:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    started_at = monotonic()
    communication_task = asyncio.create_task(process.communicate())

    try:
        while True:
            done, _pending = await asyncio.wait(
                {communication_task},
                timeout=heartbeat_interval_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if communication_task in done:
                _stdout, stderr = communication_task.result()
                break
            elapsed_seconds = monotonic() - started_at
            if elapsed_seconds >= timeout_seconds:
                await _stop_subprocess(process, communication_task)
                raise TimeoutError(f"command timed out: {command[0]}")
            activity.heartbeat(
                {
                    **heartbeat_details,
                    "elapsed_seconds": int(elapsed_seconds),
                }
            )
    except asyncio.CancelledError:
        await _stop_subprocess(process, communication_task)
        raise

    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip() or "command exited with a non-zero status"
        raise RuntimeError(message)


async def _stop_subprocess(
    process: asyncio.subprocess.Process,
    communication_task: asyncio.Task[tuple[bytes, bytes]],
) -> None:
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()

    if not communication_task.done():
        communication_task.cancel()
    await asyncio.gather(communication_task, return_exceptions=True)


async def _generate_thumbnail(
    *,
    source: Path,
    destination: Path,
    timeout_seconds: float,
    heartbeat_details: dict[str, Any] | None = None,
) -> None:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostdin",
        "-y",
        "-ss",
        "0.500",
        "-i",
        str(source),
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(destination),
    ]
    if heartbeat_details:
        await _run_command_with_heartbeat(
            command,
            timeout_seconds=timeout_seconds,
            heartbeat_details=heartbeat_details,
        )
    else:
        await _run_command(command, timeout_seconds=timeout_seconds)
    if not destination.exists():
        raise RuntimeError("ffmpeg completed without creating the thumbnail output")


def _summarize_render_probe(payload: dict[str, Any]) -> dict[str, Any]:
    from app.media.ffmpeg import summarize_ffprobe_payload

    summary = summarize_ffprobe_payload(payload)
    return {
        "duration_ms": summary.duration_ms,
        "width": summary.width,
        "height": summary.height,
        "frame_rate": summary.frame_rate,
        "audio_sample_rate": summary.audio_sample_rate,
        "codec_name": summary.codec_name,
        "audio_codec_name": summary.audio_codec_name,
        "rotation": summary.rotation,
        "has_audio": summary.has_audio,
    }


async def _upload_artifact(
    upload: ClipRenderArtifactUpload | None,
    path: Path | None,
    uploaded_artifacts: list[dict[str, Any]],
) -> str | None:
    if upload is None or path is None or not path.exists():
        return None
    await _upload_file(upload.upload_url, path, content_type=upload.content_type)
    uploaded_artifacts.append(
        {
            "artifact": upload.artifact,
            "object_key": upload.object_key,
            "content_type": upload.content_type,
            "size_bytes": path.stat().st_size,
        }
    )
    return upload.object_key


async def _upload_file(upload_url: str, path: Path, *, content_type: str) -> None:
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.put(
            str(upload_url),
            content=path.read_bytes(),
            headers={"content-type": content_type},
        )
        response.raise_for_status()


def _resolve_quality_status(status: str) -> str:
    if status == "passed":
        return "PASSED"
    if status == "failed":
        return "FAILED"
    return "NEEDS_REVIEW"
