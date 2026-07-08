from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from app.activities.progress import emit_progress, validate_foundation_request
    from app.activities.tts_segmentation import execute_tts_segmentation, submit_tts_segmentation_result


ACTIVITY_RETRY = RetryPolicy(
    initial_interval=timedelta(seconds=1),
    backoff_coefficient=2.0,
    maximum_interval=timedelta(seconds=20),
    maximum_attempts=3,
    non_retryable_error_types=["InvalidInput"],
)


@workflow.defn(name="FoundationTextToSpeechWorkflow")
class FoundationTextToSpeechWorkflow:
    @workflow.run
    async def run(self, raw_input: dict[str, Any]) -> dict[str, Any]:
        job_id = str(raw_input["job_id"])
        try:
            await self._emit(
                job_id,
                "VALIDATING_SCRIPT",
                5,
                "job.started",
                "Validating the TTS request payload.",
                "Memvalidasi script dan pengaturan TTS.",
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
                "VALIDATING_SCRIPT",
                100,
                "job.progress",
                "TTS input passed schema validation.",
                "Script TTS valid.",
                "RUNNING",
                {"job_type": validated["job_type"]},
            )

            await self._emit(
                job_id,
                "GENERATING_SEGMENTS",
                15,
                "job.progress",
                "Generating natural speech segments for the narration script.",
                "Membagi script menjadi segmen narasi alami.",
                "RUNNING",
                {},
            )
            segmentation = await workflow.execute_activity(
                execute_tts_segmentation,
                {
                    "job_id": job_id,
                    "input_snapshot": validated["input_snapshot"],
                },
                start_to_close_timeout=timedelta(minutes=5),
                heartbeat_timeout=timedelta(seconds=15),
                retry_policy=ACTIVITY_RETRY,
            )
            document = segmentation["document"]
            metadata = segmentation.get("metadata", {})
            segment_count = len(document.get("segments", [])) if isinstance(document.get("segments"), list) else 0

            await self._emit(
                job_id,
                "GENERATING_SEGMENTS",
                100,
                "job.progress",
                "Narration segmentation completed successfully.",
                "Segmentasi narasi selesai.",
                "RUNNING",
                {"segment_count": segment_count},
            )

            await self._emit(
                job_id,
                "SAVING_OUTPUTS",
                50,
                "job.progress",
                "Saving TTS segmentation metadata back to the application.",
                "Menyimpan hasil segmentasi TTS.",
                "RUNNING",
                {"segment_count": segment_count},
            )
            await workflow.execute_activity(
                submit_tts_segmentation_result,
                {
                    "job_id": job_id,
                    "document": document,
                    "metadata": metadata,
                },
                start_to_close_timeout=timedelta(seconds=30),
                heartbeat_timeout=timedelta(seconds=10),
                retry_policy=ACTIVITY_RETRY,
            )

            await self._emit(
                job_id,
                "SAVING_OUTPUTS",
                100,
                "job.completed",
                "Stored TTS segmentation plan for this job.",
                "Job TTS selesai dan segment plan sudah tersimpan.",
                "COMPLETED",
                {"segment_count": segment_count},
            )
            return {
                "job_id": job_id,
                "status": "COMPLETED",
                "segment_count": segment_count,
            }
        except Exception as error:
            await self._emit(
                job_id,
                "SAVING_OUTPUTS",
                0,
                "job.failed",
                f"TTS workflow failed: {error}",
                "Workflow TTS gagal sebelum segment plan selesai dibuat.",
                "FAILED",
                {},
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
        overall_progress = self._compute_overall_progress(stage, stage_progress, status)
        await workflow.execute_activity(
            emit_progress,
            {
                "job_id": job_id,
                "event": {
                    "stage": stage,
                    "stage_progress": stage_progress,
                    "overall_progress": overall_progress,
                    "event_type": event_type,
                    "message": message,
                    "user_message": user_message,
                    "status": status,
                    "metadata": metadata,
                },
            },
            start_to_close_timeout=timedelta(seconds=15),
            heartbeat_timeout=timedelta(seconds=5),
            retry_policy=ACTIVITY_RETRY,
        )

    def _compute_overall_progress(self, stage: str, stage_progress: int, status: str) -> int:
        if status == "COMPLETED":
            return 100
        if status == "FAILED":
            return 0
        if stage == "VALIDATING_SCRIPT":
            return min(20, max(0, round(stage_progress * 0.2)))
        if stage == "GENERATING_SEGMENTS":
            return min(85, 20 + max(0, round(stage_progress * 0.65)))
        if stage == "SAVING_OUTPUTS":
            return min(99, 85 + max(0, round(stage_progress * 0.14)))
        return max(0, min(99, stage_progress))
