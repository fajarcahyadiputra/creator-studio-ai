import subprocess
import tempfile
from pathlib import Path

from app.domain.contracts import TranscriptSegment, TranscriptWord
from app.domain.speech_cleanup import (
    MAX_REMOVED_RATIO,
    build_speech_cleanup_plan,
    remap_transcript_segments,
)
from app.media.ffmpeg import build_timeline_cleanup_command


def _segment(*words: tuple[float, float, str, float]) -> TranscriptSegment:
    transcript_words = [
        TranscriptWord(
            start_seconds=start,
            end_seconds=end,
            text=text,
            confidence=confidence,
        )
        for start, end, text, confidence in words
    ]
    return TranscriptSegment(
        segment_id="segment-1",
        start_seconds=transcript_words[0].start_seconds,
        end_seconds=transcript_words[-1].end_seconds,
        text=" ".join(word.text for word in transcript_words),
        confidence=0.95,
        words=transcript_words,
    )


def test_cleanup_is_noop_when_disabled() -> None:
    segment = _segment((0.2, 0.5, "Halo", 0.98), (2.0, 2.4, "semua", 0.98))

    plan = build_speech_cleanup_plan(
        transcript_segments=[segment],
        clip_start_seconds=0,
        clip_duration_seconds=3,
        enabled=False,
    )

    assert plan.enabled is False
    assert plan.applied is False
    assert plan.output_duration_seconds == 3
    assert plan.removals == ()


def test_cleanup_removes_only_safe_filler_and_long_silence() -> None:
    segment = _segment(
        (0.2, 0.5, "Kita", 0.98),
        (0.7, 0.95, "eee", 0.97),
        (1.2, 1.6, "mulai", 0.98),
        (3.2, 3.6, "sekarang", 0.98),
    )

    plan = build_speech_cleanup_plan(
        transcript_segments=[segment],
        clip_start_seconds=0,
        clip_duration_seconds=4,
        enabled=True,
    )

    reasons = {removal.reason for removal in plan.removals}
    assert plan.applied is True
    assert "filler_word" in reasons
    assert "long_silence" in reasons
    assert plan.output_duration_seconds < 4


def test_cleanup_keeps_low_confidence_filler() -> None:
    segment = _segment(
        (0.2, 0.5, "Kita", 0.98),
        (0.7, 0.95, "eee", 0.6),
        (1.2, 1.6, "mulai", 0.98),
    )

    plan = build_speech_cleanup_plan(
        transcript_segments=[segment],
        clip_start_seconds=0,
        clip_duration_seconds=2,
        enabled=True,
    )

    assert all(removal.reason != "filler_word" for removal in plan.removals)


def test_cleanup_caps_total_removed_duration() -> None:
    segment = _segment(
        (0.1, 0.2, "aaa", 0.99),
        (0.4, 0.5, "eee", 0.99),
        (0.7, 0.8, "hmm", 0.99),
        (1.0, 1.1, "anu", 0.99),
        (1.3, 1.6, "selesai", 0.99),
    )

    plan = build_speech_cleanup_plan(
        transcript_segments=[segment],
        clip_start_seconds=0,
        clip_duration_seconds=2,
        enabled=True,
    )

    removed = plan.source_duration_seconds - plan.output_duration_seconds
    assert removed <= plan.source_duration_seconds * MAX_REMOVED_RATIO


def test_cleanup_remaps_transcript_to_final_timeline() -> None:
    segment = _segment(
        (0.2, 0.5, "Halo", 0.98),
        (0.7, 0.9, "eee", 0.98),
        (1.2, 1.6, "semua", 0.98),
    )
    plan = build_speech_cleanup_plan(
        transcript_segments=[segment],
        clip_start_seconds=0,
        clip_duration_seconds=2,
        enabled=True,
    )

    remapped = remap_transcript_segments([segment], plan)

    assert len(remapped) == 1
    assert [word.text for word in remapped[0].words] == ["Halo", "semua"]
    assert remapped[0].words[1].start_seconds < 1.2


def test_cleanup_render_command_concatenates_final_timeline() -> None:
    command = build_timeline_cleanup_command(
        source="/tmp/source.mp4",
        destination="/tmp/cleaned.mp4",
        keep_intervals=[(2.0, 5.0), (6.0, 8.5)],
    )
    filter_graph = command.arguments[command.arguments.index("-filter_complex") + 1]

    assert "trim=start=2.000000:end=5.000000" in filter_graph
    assert "atrim=start=6.000000:end=8.500000" in filter_graph
    assert "concat=n=2:v=1:a=1[vout][aout]" in filter_graph
    assert command.arguments[-1] == "/tmp/cleaned.mp4"


def test_cleanup_render_command_executes_on_synthetic_media() -> None:
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "source.mp4"
        destination = Path(directory) / "cleaned.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=25:duration=3",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=3",
                "-shortest",
                "-pix_fmt",
                "yuv420p",
                str(source),
            ],
            check=True,
        )
        command = build_timeline_cleanup_command(
            source=source,
            destination=destination,
            keep_intervals=[(0.0, 1.0), (1.5, 2.5)],
        )

        subprocess.run(command.as_exec_args(), check=True, capture_output=True)

        assert destination.is_file()
        assert destination.stat().st_size > 0


if __name__ == "__main__":
    test_cleanup_is_noop_when_disabled()
    test_cleanup_removes_only_safe_filler_and_long_silence()
    test_cleanup_keeps_low_confidence_filler()
    test_cleanup_caps_total_removed_duration()
    test_cleanup_remaps_transcript_to_final_timeline()
    test_cleanup_render_command_concatenates_final_timeline()
    test_cleanup_render_command_executes_on_synthetic_media()
    print("speech cleanup assertions: passed")
