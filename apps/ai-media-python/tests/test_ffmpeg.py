from pathlib import Path

import pytest

from app.media.ffmpeg import build_audio_extraction


def test_audio_command_uses_exec_arguments_not_shell_string() -> None:
    command = build_audio_extraction(Path("/tmp/source file.mp4"), Path("/tmp/audio.wav"))
    args = command.as_exec_args()
    assert args[0] == "ffmpeg"
    assert "/tmp/source file.mp4" in args
    assert args[-1] == "/tmp/audio.wav"


def test_audio_command_rejects_unknown_sample_rate() -> None:
    with pytest.raises(ValueError):
        build_audio_extraction(Path("a"), Path("b"), sample_rate=12345)
