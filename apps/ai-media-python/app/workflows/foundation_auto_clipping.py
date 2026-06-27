from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.domain.auto_clip_stages import STAGE_WEIGHTS, TOTAL_STAGE_WEIGHT, compute_overall_progress
    from app.activities.phase2_analysis import analyze_phase2_candidates, prepare_analysis_inputs
    from app.activities.progress import emit_progress, validate_foundation_request


ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=5,
    non_retryable_error_types=["InvalidInput", "RightsNotConfirmed"],
)


@workflow.defn(name="FoundationAutoClippingWorkflow")
class FoundationAutoClippingWorkflow:
    @workflow.run
    async def run(self, raw_input: dict[str, Any]) -> dict[str, Any]:
        job_id = str(raw_input["job_id"])
        await self._emit(job_id, "VALIDATING_SOURCE", 5, "job.started", "Validating the durable workflow input.", "Validating source and job settings.", "RUNNING", {"attempt_number": raw_input.get("attempt_number", 1)})
        validated = await workflow.execute_activity(
            validate_foundation_request,
            raw_input,
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )
        await self._emit(job_id, "VALIDATING_SOURCE", 100, "job.progress", "Workflow input passed schema and rights validation.", "Source settings are valid.", "RUNNING", {"job_type": validated["job_type"]})

        input_snapshot = validated["input_snapshot"]
        if not isinstance(input_snapshot, dict) or "analysis_inputs" not in input_snapshot:
            await self._emit(
                job_id,
                "PROBING_MEDIA",
                0,
                "job.needs_review",
                "Media extraction adapters are not available for this source yet.",
                "This job still needs the media-processing adapters or analysis inputs to continue.",
                "NEEDS_REVIEW",
                {"phase": "FOUNDATION_PLUS", "next_phase": "AUTO_CLIPPING_MVP"},
            )
            return {
                "job_id": job_id,
                "status": "NEEDS_REVIEW",
                "phase": "FOUNDATION_PLUS",
                "message": "Analysis inputs or media-processing adapters were not available.",
            }

        analysis_inputs = await workflow.execute_activity(
            prepare_analysis_inputs,
            {"input_snapshot": input_snapshot},
            start_to_close_timeout=timedelta(seconds=30),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )
        await self._emit(job_id, "PROBING_MEDIA", 100, "job.progress", "Prepared structured analysis inputs for the auto-clipping pipeline.", "Analysis inputs are ready.", "RUNNING", {"artifact": "analysis_inputs"})
        await self._emit(job_id, "EXTRACTING_AUDIO", 100, "job.progress", "Audio extraction stage is satisfied by the prepared MVP analysis inputs.", "Audio preparation is complete.", "RUNNING", {})
        await self._emit(job_id, "TRANSCRIBING", 100, "job.progress", "Transcript data is available for candidate analysis.", "Transcript is ready.", "RUNNING", {"segment_count": len(analysis_inputs["transcript"]["segments"])})
        await self._emit(job_id, "DETECTING_SCENES", 100, "job.progress", "Scene markers are ready for boundary-aware clipping.", "Scene detection is ready.", "RUNNING", {"scene_count": len(analysis_inputs.get("scenes", []))})
        await self._emit(job_id, "DETECTING_SILENCE", 100, "job.progress", "Silence markers are ready for natural boundary adjustments.", "Silence detection is ready.", "RUNNING", {"silence_count": len(analysis_inputs.get("silences", []))})

        output_summary = await workflow.execute_activity(
            analyze_phase2_candidates,
            {"input_snapshot": validated["input_snapshot"], "analysis_inputs": analysis_inputs},
            start_to_close_timeout=timedelta(seconds=45),
            heartbeat_timeout=timedelta(seconds=10),
            retry_policy=ACTIVITY_RETRY,
        )
        candidate_count = int(output_summary["candidate_count"])

        await self._emit(job_id, "ANALYZING_CLIP_CANDIDATES", 100, "job.progress", "Generated structured clip candidates from transcript, scene, and silence inputs.", "Clip candidates are ready.", "RUNNING", {"candidate_count": candidate_count})
        await self._emit(job_id, "NORMALIZING_BOUNDARIES", 100, "job.progress", "Adjusted candidate boundaries toward natural pauses and nearby scene edges.", "Clip boundaries were normalized.", "RUNNING", {"candidate_count": candidate_count})
        await self._emit(job_id, "RANKING_AND_DEDUPLICATING", 100, "job.progress", "Ranked candidates by viral score and removed heavy overlaps.", "Candidates were ranked.", "RUNNING", {"candidate_count": candidate_count})
        await self._emit(job_id, "GENERATING_PREVIEWS", 100, "job.progress", "Prepared preview-ready candidate metadata for the review surface.", "Preview metadata is ready.", "RUNNING", {"candidate_count": candidate_count})
        await self._emit(job_id, "GENERATING_METADATA", 100, "job.progress", "Generated titles, captions, CTAs, hashtags, and score breakdowns.", "Clip metadata is ready.", "RUNNING", {"candidate_count": candidate_count})
        await self._emit(job_id, "UPLOADING_OUTPUTS", 100, "job.progress", "Stored MVP output summary for the completed job.", "Results were attached to the job.", "RUNNING", {"output_summary": output_summary})
        await self._emit(job_id, "UPLOADING_OUTPUTS", 100, "job.completed", "Phase 2 MVP analysis completed successfully.", "Auto-clipping analysis is complete.", "COMPLETED", {"output_summary": output_summary})
        return {
            "job_id": job_id,
            "status": "COMPLETED",
            "phase": "AUTO_CLIPPING_MVP",
            "candidate_count": candidate_count,
            "output_summary": output_summary,
        }

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
