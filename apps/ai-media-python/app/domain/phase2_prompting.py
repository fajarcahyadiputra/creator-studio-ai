from typing import Any

from app.domain.contracts import AnalysisInputs

AUTO_CLIP_ANALYZER_PROMPT_VERSION = "phase2-candidate-analyzer-v3"


def build_candidate_analyzer_system_prompt() -> str:
    return (
        "You are a structured short-form video clip analyst and senior viral short-video editor. "
        "Return only schema-valid JSON. "
        "Preserve factual grounding in the transcript. "
        "Do not invent speakers, scenes, or claims that are not supported by the input. "
        "Think like a professional TikTok, Reels, and YouTube Shorts clipping editor selecting the shortest complete high-retention clip, not like a summarizer chasing a target duration. "
        "Your primary goal is to find the moments with the highest viral potential, not merely the cleanest cuts. "
        "Prioritize retention spikes, scroll-stopping opening lines, conflict, reframing, sharp insight, emotional tension, story payoff, and endings that can trigger comments or shares. "
        "Maximum duration is a hard ceiling, never a target. "
        "End the clip as soon as the hook, minimum context, main value, and payoff or punchline are complete. "
        "Prefer self-contained clips that can stand alone without requiring long setup. "
        "Reject clips that depend on too much missing context, start with greetings or warm-up talk, or spend too long before the real point begins. "
        "Do not choose a moment only because it contains keywords. Choose it because it contains tension, emotion, novelty, practical value, a strong opinion, a sharp answer, or a compelling story beat. "
        "Strong clips usually open with a direct claim, challenge, contradiction, surprising fact, emotionally charged statement, or clear question within the first 1 to 2 seconds. "
        "The best ending lands on a conclusion, punchline, accusation, reframing, or question that makes the viewer want to react. "
        "Avoid music-only moments, empty transitions, applause, dead air, or segments where no clear spoken idea is delivered. "
        "Reject candidates that feel unfinished, rely on too much missing context, or drift into filler after the main idea is complete. "
        "Choose natural cut points near the end of a sentence, answer, story beat, or punchline. "
        "If a complete idea cannot fit under the duration ceiling without awkward cutting, do not select it. "
        "Keep safety notes concise and include them only when needed. "
        "Score candidates honestly. Do not inflate scores across the board. "
        "Reserve top scores only for clips with a clearly strong hook, strong standalone context, high shareability, and a compelling ending."
    )


def build_candidate_analyzer_payload(
    analysis_inputs: AnalysisInputs,
    input_snapshot: dict[str, Any],
) -> dict[str, Any]:
    strategy = input_snapshot.get("strategy")
    strategy_payload = strategy if isinstance(strategy, dict) else {}
    content = input_snapshot.get("content")
    content_payload = content if isinstance(content, dict) else {}
    transcript = analysis_inputs.transcript
    return {
        "language": transcript.language,
        "duration_seconds": transcript.duration_seconds,
        "content": {
            "title": content_payload.get("title"),
            "topic": content_payload.get("topic"),
            "niche": content_payload.get("niche"),
            "target_audience": content_payload.get("target_audience"),
            "context": content_payload.get("context"),
            "source_language": content_payload.get("source_language"),
            "speaker_count": content_payload.get("speaker_count"),
            "custom_vocabulary": content_payload.get("custom_vocabulary"),
        },
        "strategy": {
            "target_platform": strategy_payload.get("target_platform"),
            "objective": strategy_payload.get("objective"),
            "tones": strategy_payload.get("tones"),
            "desired_clip_count": strategy_payload.get("desired_clip_count"),
            "minimum_duration_seconds": strategy_payload.get("minimum_duration_seconds"),
            "maximum_duration_seconds": strategy_payload.get("maximum_duration_seconds"),
            "minimum_viral_score": strategy_payload.get("minimum_viral_score"),
            "preferred_topics": strategy_payload.get("preferred_topics"),
            "topics_to_avoid": strategy_payload.get("topics_to_avoid"),
            "sensitive_topics": strategy_payload.get("sensitive_topics"),
            "hook_style": strategy_payload.get("hook_style"),
            "cta_preference": strategy_payload.get("cta_preference"),
            "profanity_handling": strategy_payload.get("profanity_handling"),
            "remove_long_silence": strategy_payload.get("remove_long_silence"),
            "remove_filler_words": strategy_payload.get("remove_filler_words"),
        },
        "editorial_rules": {
            "maximum_duration_is_only_a_ceiling": True,
            "primary_goal": "Find the highest viral-potential spoken moments from long-form source material.",
            "selection_priority": [
                "strong hook",
                "scroll-stopping first 1 to 2 seconds",
                "tension, conflict, or emotionally loaded framing",
                "minimum required context",
                "main value",
                "clean payoff",
                "natural ending",
                "shortest complete version",
            ],
            "viral_moment_patterns": [
                "strong opinion or sharp criticism",
                "surprising contradiction or irony",
                "personal story with clear payoff",
                "practical insight or reframing",
                "debate, disagreement, or rebuttal",
                "relatable pain point",
                "short answer that lands hard",
                "comment-triggering ending",
            ],
            "must_end_when": [
                "idea complete",
                "story complete",
                "question answered",
                "opinion lands",
                "punchline delivered",
                "analogy complete",
            ],
            "must_not_end_when": [
                "sentence still hanging",
                "conflict unresolved",
                "punchline missing",
                "answer incomplete",
                "speaker still building to the point",
            ],
            "must_reject_when": [
                "intro only",
                "greeting or small talk without tension",
                "music only or non-verbal filler",
                "keyword mention without meaningful point",
                "context too incomplete to stand alone",
                "hook appears too late",
                "clip drifts after the main point",
            ],
            "deprioritize_after_main_point": [
                "repetition",
                "filler",
                "weak transition",
                "non-essential closing joke",
                "topic handoff",
            ],
            "hook_requirements": [
                "Open as close as possible to the first strong spoken line.",
                "Prefer hooks that create curiosity, tension, disagreement, urgency, or emotional charge.",
                "Avoid generic setup text and slow runway.",
            ],
            "dialogue_requirements": [
                "Clip must contain clear spoken narration, opinion, explanation, story, or dialogue.",
                "Do not select silence, montage-only, music-only, or applause-only sections.",
                "Start near the beginning of a meaningful sentence, not before a long pause or empty beat.",
                "End after the spoken idea is clearly complete.",
            ],
            "scoring_guidance": {
                "9_to_10": "Exceptional hook, strong emotion or conflict, high standalone clarity, highly shareable ending.",
                "7_5_to_8_9": "Strong and publishable with clear hook, value, and ending.",
                "6_to_7_4": "Usable but lacks uniqueness, punch, or clean standalone context.",
                "below_6": "Weak or incomplete. Avoid unless there are no better options.",
            },
            "standalone_requirement": (
                "The viewer should understand who is speaking, what the issue is, and what the conclusion is without needing long upstream context."
            ),
        },
        "subtitle_preferences": (
            input_snapshot.get("subtitle")
            if isinstance(input_snapshot.get("subtitle"), dict)
            else {}
        ),
        "visual_preferences": (
            input_snapshot.get("visual")
            if isinstance(input_snapshot.get("visual"), dict)
            else {}
        ),
        "transcript_segments": [
            {
                "segment_id": segment.segment_id,
                "start_seconds": segment.start_seconds,
                "end_seconds": segment.end_seconds,
                "speaker_label": segment.speaker_label,
                "text": segment.text,
            }
            for segment in transcript.segments
        ],
        "scenes": [
            {
                "scene_id": scene.scene_id,
                "start_seconds": scene.start_seconds,
                "end_seconds": scene.end_seconds,
            }
            for scene in analysis_inputs.scenes
        ],
        "silences": [
            {
                "silence_id": silence.silence_id,
                "start_seconds": silence.start_seconds,
                "end_seconds": silence.end_seconds,
            }
            for silence in analysis_inputs.silences
        ],
    }
