import wave

import av


def test_pyav_supports_faster_whisper_decode_api(tmp_path) -> None:
    audio_path = tmp_path / "silence.wav"
    with wave.open(str(audio_path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(bytes(320))

    with av.open(str(audio_path), mode="r", metadata_errors="ignore") as container:
        assert container.streams.audio
