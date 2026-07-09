import asyncio
import logging

from temporalio.client import Client
from temporalio.worker import Worker

from app.activities.audio_pipeline import execute_audio_extraction, prepare_audio_extraction
from app.activities.external_source_materialization import materialize_external_source
from app.activities.media_validation import (
    prepare_media_asset_validation,
    probe_media_asset_validation,
    submit_media_asset_validation_result,
)
from app.activities.phase2_analysis import (
    analyze_phase2_candidates,
    enrich_analysis_inputs,
    prepare_analysis_inputs,
    prepare_analysis_inputs_from_transcript,
)
from app.activities.progress import emit_progress, validate_foundation_request
from app.activities.render_outputs import (
    execute_clip_output_render,
    prepare_clip_output_render,
    submit_clip_output_result,
)
from app.activities.tts_segmentation import execute_tts_segmentation, submit_tts_segmentation_result
from app.activities.tts_synthesis import execute_tts_audio_synthesis
from app.activities.transcription_pipeline import (
    execute_transcription,
    prepare_transcription,
    submit_transcription_result,
)
from app.config import get_settings
from app.observability.logging import configure_logging
from app.workflows.foundation_auto_clipping import FoundationAutoClippingWorkflow
from app.workflows.foundation_text_to_speech import FoundationTextToSpeechWorkflow
from app.workflows.clip_output_render import ClipOutputRenderWorkflow
from app.workflows.media_asset_validation import MediaAssetValidationWorkflow


async def main() -> None:
    configure_logging()
    settings = get_settings()
    if settings.AUTO_CLIP_ANALYZER_MODE.lower() == "openai" and not settings.OPENAI_API_KEY:
        logging.getLogger(__name__).warning(
            "OpenAI analyzer mode is enabled without OPENAI_API_KEY; heuristic fallback will be used"
        )
    client = await Client.connect(settings.TEMPORAL_ADDRESS, namespace=settings.TEMPORAL_NAMESPACE)
    worker = Worker(
        client,
        task_queue=settings.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflows=[FoundationAutoClippingWorkflow, FoundationTextToSpeechWorkflow, MediaAssetValidationWorkflow, ClipOutputRenderWorkflow],
        activities=[
            validate_foundation_request,
            emit_progress,
            prepare_analysis_inputs,
            prepare_analysis_inputs_from_transcript,
            enrich_analysis_inputs,
            analyze_phase2_candidates,
            prepare_media_asset_validation,
            probe_media_asset_validation,
            submit_media_asset_validation_result,
            materialize_external_source,
            prepare_audio_extraction,
            execute_audio_extraction,
            prepare_transcription,
            execute_transcription,
            submit_transcription_result,
            prepare_clip_output_render,
            execute_clip_output_render,
            submit_clip_output_result,
            execute_tts_segmentation,
            submit_tts_segmentation_result,
            execute_tts_audio_synthesis,
        ],
        max_concurrent_activities=20,
    )
    logging.getLogger(__name__).info(
        "Temporal worker started", extra={"task_queue": settings.TEMPORAL_AUTO_CLIP_TASK_QUEUE}
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
