from app.workflows.foundation_auto_clipping import (
    MAX_FAILURE_SUMMARY_LENGTH,
    MAX_PROGRESS_TEXT_LENGTH,
    _external_source_user_message,
    _summarize_activity_failure,
    _truncate_progress_text,
)


def test_progress_text_is_bounded_for_contract_validation() -> None:
    result = _truncate_progress_text("x" * 3000)

    assert len(result) == MAX_PROGRESS_TEXT_LENGTH
    assert result.endswith("... [truncated]")


def test_activity_failure_summary_bounds_deep_provider_error() -> None:
    outer = RuntimeError("Activity task failed")
    provider = RuntimeError("provider failure: " + "x" * 3000)
    outer.cause = provider

    result = _summarize_activity_failure(outer)

    assert len(result) == MAX_FAILURE_SUMMARY_LENGTH
    assert result.startswith("provider failure:")
    assert result.endswith("... [truncated]")


def test_activity_failure_prefers_application_summary_over_repeated_provider_details() -> None:
    outer = RuntimeError("Activity task failed")
    application = RuntimeError(
        "ExternalSourceImportFailed: extract-info: YoutubeAuthenticationRequired"
    )
    provider = RuntimeError("provider failure: " + "x" * 3000)
    outer.cause = application
    application.cause = provider

    result = _summarize_activity_failure(outer)

    assert result == "ExternalSourceImportFailed: extract-info: YoutubeAuthenticationRequired"


def test_youtube_authentication_message_does_not_recommend_blind_retry() -> None:
    result = _external_source_user_message(
        "ExternalSourceImportFailed: extract-info: YoutubeAuthenticationRequired"
    )

    assert "Upload file video secara langsung" in result
    assert "Percobaan ulang" in result
