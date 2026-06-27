import pytest
from temporalio.exceptions import ApplicationError

from app.application.foundation_validation import validate_foundation_input


def payload() -> dict[str, object]:
    return {
        "job_id": "a" * 36,
        "user_id": "b" * 36,
        "job_type": "AUTO_CLIPPING",
        "input_snapshot": {
            "source": {"type": "EXTERNAL_URL", "url": "https://example.com/video"},
            "content": {"rights_confirmed": True},
        },
        "callback_base_url": "http://web-node:3000",
        "attempt_number": 1,
    }


def test_foundation_input_accepts_rights_confirmation() -> None:
    result = validate_foundation_input(payload())
    assert result.job_type == "AUTO_CLIPPING"


def test_foundation_input_rejects_missing_rights() -> None:
    invalid = payload()
    invalid["input_snapshot"] = {"source": {}, "content": {"rights_confirmed": False}}
    with pytest.raises(ApplicationError):
        validate_foundation_input(invalid)


def test_foundation_input_accepts_phase2_analysis_inputs() -> None:
    valid = payload()
    valid["input_snapshot"] = {
        "source": {"type": "EXTERNAL_URL", "url": "https://example.com/video"},
        "content": {"rights_confirmed": True},
        "strategy": {
            "desired_clip_count": 2,
            "minimum_duration_seconds": 15,
            "maximum_duration_seconds": 45,
            "minimum_viral_score": 6.5,
        },
        "analysis_inputs": {
            "transcript": {
                "language": "id",
                "duration_seconds": 20,
                "segments": [
                    {
                        "segment_id": "seg-1",
                        "start_seconds": 0,
                        "end_seconds": 20,
                        "text": "Kebanyakan orang salah memahami pembuka video.",
                    }
                ],
            },
            "scenes": [],
            "silences": [],
        },
    }
    result = validate_foundation_input(valid)
    assert result.input_snapshot["analysis_inputs"]["transcript"]["language"] == "id"
