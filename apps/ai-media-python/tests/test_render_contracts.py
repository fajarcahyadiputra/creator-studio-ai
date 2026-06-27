from app.domain.contracts import ClipOutputResult, ClipRenderContext


def test_clip_render_context_accepts_internal_payload() -> None:
    context = ClipRenderContext.model_validate(
        {
            "clip_output_id": "output-1",
            "job_id": "job-1",
            "candidate_id": "candidate-row-1",
            "version": 1,
            "quality_status": "PENDING",
            "render_settings": {"visual": {"aspect_ratio": "9:16"}},
            "candidate": {
                "candidate_id": "candidate-01",
                "title": "Candidate title",
                "summary": "Candidate summary",
                "hook_text": "Hook text",
                "start_ms": "12000",
                "end_ms": "30000",
                "duration_ms": "18000",
            },
            "output_targets": {
                "preview_object_key": None,
                "final_object_key": None,
                "metadata_object_key": None,
                "thumbnail_object_key": None,
            },
        }
    )

    assert context.clip_output_id == "output-1"
    assert context.candidate.duration_ms == "18000"


def test_clip_output_result_accepts_worker_result_payload() -> None:
    result = ClipOutputResult.model_validate(
        {
            "quality_status": "PASSED",
            "preview_object_key": "users/u/jobs/j/previews/c1.mp4",
            "quality_report": {"score": 9.1},
            "duration_ms": "18000",
            "width": 1080,
            "height": 1920,
        }
    )

    assert result.quality_status == "PASSED"
    assert result.duration_ms == "18000"
