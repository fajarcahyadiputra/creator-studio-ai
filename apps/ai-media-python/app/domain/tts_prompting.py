from typing import Any

from app.domain.contracts import TtsRequestPayload

TTS_SEGMENTATION_PROMPT_VERSION = "tts-segmentation-v2"


def build_tts_segmentation_system_prompt() -> str:
    return (
        "You are an expert speech director, audiobook editor, and documentary narrator. "
        "Your task is not to rewrite the script. "
        "Your task is only to split the narration into natural speech segments for text-to-speech generation. "
        "Return only schema-valid JSON with no markdown, no explanations, and no comments. "
        "Never change meaning, summarize, add words, remove important words, or paraphrase. "
        "Keep the original wording exactly and only split the text into natural speech segments. "
        "Split based on natural breathing and where a professional narrator would pause. "
        "Typical split locations include after complete thoughts, before emphasis, after dramatic statements, after questions, before conclusions, before lists, and after short impactful sentences. "
        "Do not split inside names, dates, numbers, technical terms, or quotations. "
        "Avoid segments longer than about 18 words. Prefer 5 to 14 words when possible without damaging the sentence. "
        "pause_after must be one of 250, 400, 600, 800, 1000, 1200, 1500, 1800, or 2200 milliseconds. "
        "Use 250 for tiny pauses, 400 for comma pauses, 600 for small thought breaks, 800 for sentence endings, 1000 for important statements, 1200 for dramatic pauses, 1500 for a new topic, 1800 for a major reveal, and 2200 for section endings. "
        "emotion must be one of neutral, curious, serious, dramatic, hopeful, sad, surprised, or calm. "
        "speed must be one of slow, normal, or fast. Use fast only for action-heavy narration. "
        "emphasis must be one of low, medium, or high. Use high only for major reveals, important facts, surprise, warnings, or key conclusions. "
        "volume must be one of low, normal, or high. Keep volume normal unless a segment clearly benefits from softer or stronger delivery. "
        "Every segment object must include all schema fields, including volume, breath_before, breath_after, fade_in_ms, and fade_out_ms. "
        "fade_in_ms and fade_out_ms should stay subtle and small. "
        "Ensure every segment text is copied exactly from the source script with no wording changes."
    )


def build_tts_segmentation_payload(
    request: TtsRequestPayload,
    *,
    user_preferences: dict[str, Any] | None = None,
) -> dict[str, Any]:
    preferences = user_preferences if isinstance(user_preferences, dict) else {}
    return {
        "job_id": request.job_id,
        "language": request.language,
        "local_model_key": request.local_model_key,
        "script": request.script,
        "script_character_count": len(request.script),
        "voice": {
            "voice_identifier": request.voice_identifier,
            "speaking_style": request.speaking_style,
            "emotion": request.emotion,
            "speaking_speed": request.speaking_speed,
            "pitch": request.pitch,
            "pause_intensity": request.pause_intensity,
            "target_duration_ms": request.target_duration_ms,
        },
        "pronunciation_dictionary": request.pronunciation_dictionary,
        "output_config": request.output_config,
        "user_preferences": {
            "tone_notes": preferences.get("tone_notes"),
            "delivery_goal": preferences.get("delivery_goal"),
            "segment_length_preference": preferences.get("segment_length_preference"),
            "breathing_style": preferences.get("breathing_style"),
        },
        "rules": {
            "preserve_exact_wording": True,
            "no_paraphrase": True,
            "no_summary": True,
            "ideal_segment_word_range": [5, 14],
            "soft_max_segment_words": 18,
            "allowed_pause_after_ms": [250, 400, 600, 800, 1000, 1200, 1500, 1800, 2200],
            "allowed_emotions": ["neutral", "curious", "serious", "dramatic", "hopeful", "sad", "surprised", "calm"],
            "allowed_speed": ["slow", "normal", "fast"],
            "allowed_emphasis": ["low", "medium", "high"],
            "allowed_volume": ["low", "normal", "high"],
        },
    }
