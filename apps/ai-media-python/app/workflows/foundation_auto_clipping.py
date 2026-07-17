from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.config import get_settings
    from app.domain.auto_clip_stages import STAGE_WEIGHTS, TOTAL_STAGE_WEIGHT, compute_overall_progress
    from app.activities.audio_pipeline import execute_audio_extraction, prepare_audio_extraction
    from app.activities.external_source_materialization import materialize_external_source
    from app.activities.media_validation import prepare_media_asset_validation
    from app.activities.phase2_analysis import (
        analyze_phase2_candidates,
        enrich_analysis_inputs,
        prepare_analysis_inputs,
        prepare_analysis_inputs_from_transcript,
    )
    from app.activities.progress import emit_progress, validate_foundation_request
    from app.activities.transcription_pipeline import (
        execute_transcription,
        prepare_transcription,
        submit_transcription_result,
    )


ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=5,
    non_retryable_error_types=["InvalidInput", "RightsNotConfirmed"],
)


EXTERNAL_SOURCE_ACTIVITY_RETRY = RetryPolicy(
    maximum_attempts=1,
    non_retryable_error_types=[
        "InvalidInput",
        "ExternalSourceImportFailed",
    ],
)


TRANSCRIPTION_ACTIVITY_TIMEOUT = timedelta(
    seconds=max(60, int(get_settings().TRANSCRIPTION_TIMEOUT_SECONDS))
)
ANALYZER_ACTIVITY_TIMEOUT = timedelta(
    seconds=max(30, int(get_settings().ANALYZER_TIMEOUT_SECONDS))
)
ANALYZER_HEARTBEAT_TIMEOUT = timedelta(seconds=30)

EXTERNAL_SOURCE_ACTIVITY_TIMEOUT = timedelta(
    seconds=max(300, int(get_settings().EXTERNAL_SOURCE_MATERIALIZATION_TIMEOUT_SECONDS))
)


def _summarize_activity_failure(error: Exception) -> str:
    seen: set[int] = set()
    cursor: Exception | None = error
    messages: list[str] = []

    while cursor is not None and id(cursor) not in seen:
        seen.add(id(cursor))
        message = str(cursor).strip()
        if message and message not in {"Activity task failed", "CancelledError"}:
            messages.append(message)
        next_cursor = getattr(cursor, "cause", None)
        cursor = next_cursor if isinstance(next_cursor, Exception) else None

    if messages:
        return messages[-1]
    fallback = str(error).strip()
    return fallback or type(error).__name__


@workflow.defn(name="FoundationAutoClippingWorkflow")
class FoundationAutoClippingWorkflow:
    @workflow.run
    async def run(self, raw_input: dict[str, Any]) -> dict[str, Any]:
        job_id = str(raw_input["job_id"])
        current_stage = "VALIDATING_SOURCE"
        try:
            await self._emit(
                job_id,
                "VALIDATING_SOURCE",
                5,
                "job.started",
                "Validating the durable workflow input.",
                "Validating source and job settings.",
                "RUNNING",
                {"attempt_number": raw_input.get("attempt_number", 1)},
            )
            validated = await workflow.execute_activity(
                validate_foundation_request,
                raw_input,
                start_to_close_timeout=timedelta(seconds=30),
                heartbeat_timeout=timedelta(seconds=10),
                retry_policy=ACTIVITY_RETRY,
            )
            await self._emit(
                job_id,
                "VALIDATING_SOURCE",
                100,
                "job.progress",
                "Workflow input passed schema and rights validation.",
                "Source settings are valid.",
                "RUNNING",
                {"job_type": validated["job_type"]},
            )

            input_snapshot = validated["input_snapshot"]
            if not isinstance(input_snapshot, dict):
                current_stage = "PROBING_MEDIA"
                return await self._fail_and_finish(
                    job_id=job_id,
                    stage="PROBING_MEDIA",
                    message="Media extraction adapters are not available for this source yet.",
                    user_message="This job cannot continue because the source payload is incomplete for auto-clipping.",
                    metadata={
                        "phase": "FOUNDATION_PLUS",
                        "next_phase": "AUTO_CLIPPING_MVP",
                        "failure_reason": "missing_analysis_inputs_or_media_source",
                    },
                )

            if "analysis_inputs" in input_snapshot:
                current_stage = "PROBING_MEDIA"
                prepared_analysis_inputs = await workflow.execute_activity(
                    prepare_analysis_inputs,
                    {"input_snapshot": input_snapshot},
                    start_to_close_timeout=timedelta(seconds=30),
                    heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=ACTIVITY_RETRY,
                )
                await self._emit(
                    job_id,
                    "PROBING_MEDIA",
                    100,
                    "job.progress",
                    "Prepared structured analysis inputs for the auto-clipping pipeline.",
                    "Analysis inputs are ready.",
                    "RUNNING",
                    {"artifact": "analysis_inputs"},
                )
                current_stage = "EXTRACTING_AUDIO"
                await self._emit(
                    job_id,
                    "EXTRACTING_AUDIO",
                    100,
                    "job.progress",
                    "Audio extraction stage is satisfied by the prepared MVP analysis inputs.",
                    "Audio preparation is complete.",
                    "RUNNING",
                    {},
                )
                current_stage = "TRANSCRIBING"
                await self._emit(
                    job_id,
                    "TRANSCRIBING",
                    100,
                    "job.progress",
                    "Transcript data is available for candidate analysis.",
                    "Transcript is ready.",
                    "RUNNING",
                    {"segment_count": len(prepared_analysis_inputs["transcript"]["segments"])},
                )
            else:
                current_stage = "PROBING_MEDIA"
                media_asset_id = _extract_media_asset_id(input_snapshot)
                source_url = _extract_external_source_url(input_snapshot)
                if source_url is not None:
                    await self._emit(
                        job_id,
                        "PROBING_MEDIA",
                        15,
                        "job.progress",
                        "Downloading the external source into a workspace media asset.",
                        "Preparing the source video for analysis.",
                        "RUNNING",
                        {
                            "source_url": source_url,
                            "reimporting": media_asset_id is not None,
                            "existing_media_asset_id": media_asset_id,
                        },
                    )
                    try:
                        materialized = await workflow.execute_activity(
                            materialize_external_source,
                            {
                                "job_id": job_id,
                                "user_id": raw_input["user_id"],
                                "project_id": input_snapshot.get("project_id"),
                                "source_url": source_url,
                                "target_video_height": _extract_source_target_video_height(input_snapshot),
                            },
                            start_to_close_timeout=EXTERNAL_SOURCE_ACTIVITY_TIMEOUT,
                            heartbeat_timeout=timedelta(seconds=60),
                            retry_policy=EXTERNAL_SOURCE_ACTIVITY_RETRY,
                        )
                    except Exception as error:
                        failure_summary = _summarize_activity_failure(error)
                        return await self._fail_and_finish(
                            job_id=job_id,
                            stage="PROBING_MEDIA",
                            message=f"External source import failed: {failure_summary}",
                            user_message=(
                                "The source URL could not be imported into the workspace media library. "
                                f"Technical summary: {failure_summary}"
                            ),
                            metadata={
                                "phase": "AUTO_CLIPPING_MVP",
                                "missing": "source.media_asset_id",
                                "source_url": source_url,
                                "error_type": type(error).__name__,
                                "technical_message": str(error),
                            },
                        )

                    media_asset_id = str(materialized["media_asset_id"])
                    input_snapshot = _replace_source_with_media_asset(input_snapshot, media_asset_id)
                    await self._emit(
                        job_id,
                        "PROBING_MEDIA",
                        55,
                        "job.progress",
                        "External source import completed and the source media asset is now ready.",
                        "Source video has been imported successfully.",
                        "RUNNING",
                        {
                            "media_asset_id": media_asset_id,
                            "source_url": source_url,
                        },
                    )

                if media_asset_id is None:
                    return await self._fail_and_finish(
                        job_id=job_id,
                        stage="PROBING_MEDIA",
                        message="A source media asset is required when analysis inputs are not provided.",
                        user_message="This job needs a ready source media asset before auto clipping can continue.",
                        metadata={
                            "phase": "AUTO_CLIPPING_MVP",
                            "missing": "source.media_asset_id",
                            "failure_reason": "missing_source_media_asset",
                        },
                    )

                media_context = await workflow.execute_activity(
                    prepare_media_asset_validation,
                    {"media_asset_id": media_asset_id},
                    start_to_close_timeout=timedelta(seconds=30),
                    heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=ACTIVITY_RETRY,
                )
                await self._emit(
                    job_id,
                    "PROBING_MEDIA",
                    100,
                    "job.progress",
                    "Fetched the validated media asset context for pipeline execution.",
                    "Source media is ready.",
                    "RUNNING",
                    {"media_asset_id": media_asset_id},
                )

                current_stage = "EXTRACTING_AUDIO"
                audio_plan = await workflow.execute_activity(
                    prepare_audio_extraction,
                    {
                        **media_context,
                        "job_id": job_id,
                    },
                    start_to_close_timeout=timedelta(seconds=30),
                    heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=ACTIVITY_RETRY,
                )
                audio_result = await workflow.execute_activity(
                    execute_audio_extraction,
                    audio_plan,
                    start_to_close_timeout=timedelta(minutes=10),
                    heartbeat_timeout=timedelta(seconds=15),
                    retry_policy=ACTIVITY_RETRY,
                )
                await self._emit(
                    job_id,
                    "EXTRACTING_AUDIO",
                    100,
                    "job.progress",
                    "Extracted a mono WAV audio track for speech analysis.",
                    "Audio extraction is complete.",
                    "RUNNING",
                    {
                        "media_asset_id": media_asset_id,
                        "sample_rate": audio_result["sample_rate"],
                    },
                )

                current_stage = "TRANSCRIBING"
                transcription_plan = await workflow.execute_activity(
                    prepare_transcription,
                    {
                        **audio_result,
                        "job_id": job_id,
                        "input_snapshot": input_snapshot,
                    },
                    start_to_close_timeout=timedelta(seconds=30),
                    heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=ACTIVITY_RETRY,
                )
                await self._emit(
                    job_id,
                    "TRANSCRIBING",
                    10,
                    "job.progress",
                    "Starting transcript generation from the extracted audio track.",
                    "Transcription has started.",
                    "RUNNING",
                    {
                        "media_asset_id": media_asset_id,
                        "audio_path": transcription_plan["audio_path"],
                        "language_hint": transcription_plan.get("language_hint"),
                    },
                )
                transcription_result = await workflow.execute_activity(
                    execute_transcription,
                    transcription_plan,
                    start_to_close_timeout=TRANSCRIPTION_ACTIVITY_TIMEOUT,
                    heartbeat_timeout=timedelta(seconds=30),
                    retry_policy=ACTIVITY_RETRY,
                )
                await workflow.execute_activity(
                    submit_transcription_result,
                    transcription_result,
                    start_to_close_timeout=timedelta(seconds=30),
                    heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=ACTIVITY_RETRY,
                )
                prepared_analysis_inputs = await workflow.execute_activity(
                    prepare_analysis_inputs_from_transcript,
                    transcription_result,
                    start_to_close_timeout=timedelta(seconds=30),
                    heartbeat_timeout=timedelta(seconds=10),
                    retry_policy=ACTIVITY_RETRY,
                )
                await self._emit(
                    job_id,
                    "TRANSCRIBING",
                    100,
                    "job.progress",
                    "Generated transcript segments from the extracted audio track.",
                    "Transcript is ready.",
                    "RUNNING",
                    {
                        "segment_count": len(prepared_analysis_inputs["transcript"]["segments"]),
                        "language": prepared_analysis_inputs["transcript"]["language"],
                    },
                )

            current_stage = "DETECTING_SCENES"
            analysis_inputs = await workflow.execute_activity(
                enrich_analysis_inputs,
                {
                    "input_snapshot": input_snapshot,
                    "analysis_inputs": prepared_analysis_inputs,
                },
                start_to_close_timeout=timedelta(seconds=30),
                heartbeat_timeout=timedelta(seconds=10),
                retry_policy=ACTIVITY_RETRY,
            )
            await self._emit(
                job_id,
                "DETECTING_SCENES",
                100,
                "job.progress",
                "Scene and silence markers are ready for boundary-aware clipping.",
                "Scene and pause detection are ready.",
                "RUNNING",
                {
                    "scene_count": len(analysis_inputs.get("scenes", [])),
                    "silence_count": len(analysis_inputs.get("silences", [])),
                },
            )

            transcript = analysis_inputs.get("transcript", {})
            transcript_segments = transcript.get("segments", []) if isinstance(transcript, dict) else []
            current_stage = "ANALYZING_CLIP_CANDIDATES"
            await self._emit(
                job_id,
                "ANALYZING_CLIP_CANDIDATES",
                10,
                "job.progress",
                "Starting candidate analysis from transcript, scene, and silence inputs.",
                "Candidate analysis has started.",
                "RUNNING",
                {
                    "transcript_segment_count": len(transcript_segments) if isinstance(transcript_segments, list) else 0,
                    "scene_count": len(analysis_inputs.get("scenes", [])),
                    "silence_count": len(analysis_inputs.get("silences", [])),
                },
            )
            output_summary = await workflow.execute_activity(
                analyze_phase2_candidates,
                {
                    "job_id": job_id,
                    "input_snapshot": validated["input_snapshot"],
                    "analysis_inputs": analysis_inputs,
                },
                start_to_close_timeout=ANALYZER_ACTIVITY_TIMEOUT,
                heartbeat_timeout=ANALYZER_HEARTBEAT_TIMEOUT,
                retry_policy=ACTIVITY_RETRY,
            )
            candidate_count = int(output_summary["candidate_count"])

            await self._emit(
                job_id,
                "ANALYZING_CLIP_CANDIDATES",
                100,
                "job.progress",
                "Generated structured clip candidates from transcript, scene, and silence inputs.",
                "Clip candidates are ready.",
                "RUNNING",
                {"candidate_count": candidate_count},
            )
            current_stage = "RANKING_AND_DEDUPLICATING"
            await self._emit(
                job_id,
                "RANKING_AND_DEDUPLICATING",
                100,
                "job.progress",
                "Normalized candidate boundaries, ranked by viral score, and removed heavy overlaps.",
                "Candidates were refined and ranked.",
                "RUNNING",
                {"candidate_count": candidate_count},
            )
            current_stage = "GENERATING_PREVIEWS"
            await self._emit(
                job_id,
                "GENERATING_PREVIEWS",
                100,
                "job.progress",
                "Prepared review-ready candidate data, titles, captions, CTAs, hashtags, and score breakdowns.",
                "Candidate review data is ready.",
                "RUNNING",
                {"candidate_count": candidate_count},
            )
            current_stage = "UPLOADING_OUTPUTS"
            await self._emit(
                job_id,
                "UPLOADING_OUTPUTS",
                100,
                "job.progress",
                "Stored MVP output summary for the completed job.",
                "Results were attached to the job.",
                "RUNNING",
                {"output_summary": output_summary},
            )
            await self._emit(
                job_id,
                "UPLOADING_OUTPUTS",
                100,
                "job.completed",
                "Phase 2 MVP analysis completed successfully.",
                "Auto-clipping analysis is complete.",
                "COMPLETED",
                {"output_summary": output_summary},
            )
            return {
                "job_id": job_id,
                "status": "COMPLETED",
                "phase": "AUTO_CLIPPING_MVP",
                "candidate_count": candidate_count,
                "output_summary": output_summary,
            }
        except Exception as error:
            await self._emit(
                job_id,
                current_stage,
                100,
                "job.failed",
                f"Workflow failed during {current_stage}: {error}",
                f"The job failed during {current_stage}. Review the latest logs and retry the job.",
                "FAILED",
                {
                    "error_type": type(error).__name__,
                    "technical_message": str(error),
                },
            )
            raise

    async def _emit(
        self,
        job_id: str,
        stage: str,
        stage_progress: int,
        event_type: str,
        message: str,
        user_message: str,
        status: str,
        metadata: dict[str, Any],
    ) -> None:
        event = {
            "stage": stage,
            "stage_progress": stage_progress,
            "overall_progress": compute_overall_progress(stage, stage_progress),
            "event_type": event_type,
            "message": message,
            "user_message": user_message,
            "status": status,
            "metadata": {
                "stage_weight": STAGE_WEIGHTS[stage],
                "total_stage_weight": TOTAL_STAGE_WEIGHT,
                **metadata,
            },
        }
        await workflow.execute_activity(
            emit_progress,
            {"job_id": job_id, "event": event},
            start_to_close_timeout=timedelta(seconds=20),
            retry_policy=ACTIVITY_RETRY,
        )

    async def _fail_and_finish(
        self,
        *,
        job_id: str,
        stage: str,
        message: str,
        user_message: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        await self._emit(
            job_id,
            stage,
            100,
            "job.failed",
            message,
            user_message,
            "FAILED",
            metadata,
        )
        return {
            "job_id": job_id,
            "status": "FAILED",
            **metadata,
            "message": user_message,
        }


def _extract_media_asset_id(input_snapshot: dict[str, Any]) -> str | None:
    source = input_snapshot.get("source")
    if not isinstance(source, dict):
        return None
    media_asset_id = source.get("media_asset_id")
    if isinstance(media_asset_id, str) and media_asset_id:
        return media_asset_id
    return None


def _extract_external_source_url(input_snapshot: dict[str, Any]) -> str | None:
    source = input_snapshot.get("source")
    if not isinstance(source, dict):
        return None
    source_type = source.get("type")
    source_url = source.get("url")
    if source_type != "EXTERNAL_URL":
        return None
    if isinstance(source_url, str) and source_url:
        return source_url
    return None


def _extract_source_target_video_height(input_snapshot: dict[str, Any]) -> int:
    source = input_snapshot.get("source")
    if not isinstance(source, dict):
        return 1080
    quality = source.get("download_quality")
    if not isinstance(quality, dict):
        return 1080
    target_height = quality.get("target_height")
    if target_height in {360, 480, 720, 1080}:
        return int(target_height)
    return 1080


def _replace_source_with_media_asset(input_snapshot: dict[str, Any], media_asset_id: str) -> dict[str, Any]:
    source = input_snapshot.get("source")
    if not isinstance(source, dict):
        return input_snapshot
    preserved_url = source.get("url")
    return {
        **input_snapshot,
        "source": {
            **source,
            "type": "EXTERNAL_URL" if isinstance(preserved_url, str) and preserved_url else "MEDIA_ASSET",
            "url": preserved_url if isinstance(preserved_url, str) and preserved_url else None,
            "media_asset_id": media_asset_id,
        },
    }
