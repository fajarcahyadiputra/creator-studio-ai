from typing import Any

from app.domain.contracts import AnalysisInputs

AUTO_CLIP_ANALYZER_PROMPT_VERSION = "phase2-candidate-analyzer-v5"


def build_candidate_analyzer_system_prompt() -> str:
    return (
        "You are a structured short-form video clip analyst and senior Indonesian short-video editor for TikTok, Reels, and YouTube Shorts. "
        "Return only schema-valid JSON. "
        "Preserve factual grounding in the transcript. "
        "Do not invent speakers, scenes, or claims that are not supported by the input. "
        "Think like a professional clipping editor selecting the shortest complete high-retention clip, not like a summarizer chasing a target duration. "
        "Your primary goal is to find the moments with the highest viral potential, not merely the cleanest cuts. "
        "Prioritize retention spikes, scroll-stopping opening lines, conflict, reframing, sharp insight, emotional tension, story payoff, punchlines, sharp answers, and endings that can trigger comments or shares. "
        "Maximum duration is a hard ceiling, never a target. "
        "End the clip as soon as the hook, minimum context, main value, and payoff or punchline are complete. "
        "Prefer self-contained clips that can stand alone without requiring long setup. "
        "Reject clips that depend on too much missing context, start with greetings or warm-up talk, or spend too long before the real point begins. "
        "Do not choose a moment only because it contains keywords. Choose it because it contains tension, emotion, novelty, practical value, a strong opinion, a sharp answer, or a compelling story beat. "
        "Strong clips usually open with a direct claim, challenge, contradiction, surprising fact, emotionally charged statement, or clear question within the first 1 to 2 seconds. "
        "The best ending lands on a conclusion, punchline, accusation, reframing, or question that makes the viewer want to react. "
        "Avoid music-only moments, montage-only sections, applause, dead air, empty transitions, or segments where no clear spoken idea is delivered. "
        "Reject candidates that feel unfinished, rely on too much missing context, or drift into filler after the main idea is complete. "
        "Choose natural cut points near the end of a sentence, answer, story beat, or punchline. "
        "If a complete idea cannot fit under the duration ceiling without awkward cutting, do not select it. "
        "Treat spoken dialogue, narration, explanation, argument, or personal story as mandatory editorial anchors. "
        "If a transcript region contains only music markers, empty filler, or non-verbal noise, do not return it as a candidate. "
        "Hook text should be short, sharp, and ideally feel like a curiosity gap rather than a generic CTA. "
        "Keep safety notes concise and include them only when needed. "
        "Score candidates honestly. Do not inflate scores across the board. "
        "Reserve top scores only for clips with a clearly strong hook, strong standalone context, high shareability, and a compelling ending. "
        "If user_editor_briefs are provided, treat them as high-priority editorial direction as long as they do not conflict with factual grounding or safety."
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
    condensed_transcript_segments = _condense_transcript_segments(
        transcript.segments,
        max_segments=180,
        max_chars_per_segment=260,
        max_window_seconds=12.0,
    )
    condensed_scenes = _limit_boundaries(analysis_inputs.scenes, id_key="scene_id", limit=250)
    condensed_silences = _limit_boundaries(analysis_inputs.silences, id_key="silence_id", limit=250)
    return {
        "language": transcript.language,
        "duration_seconds": transcript.duration_seconds,
        "source_transcript_stats": {
            "original_segment_count": len(transcript.segments),
            "condensed_segment_count": len(condensed_transcript_segments),
            "scene_count": len(analysis_inputs.scenes),
            "condensed_scene_count": len(condensed_scenes),
            "silence_count": len(analysis_inputs.silences),
            "condensed_silence_count": len(condensed_silences),
        },
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
            "candidate_pool_count": strategy_payload.get("candidate_pool_count"),
            "minimum_duration_seconds": strategy_payload.get("minimum_duration_seconds"),
            "maximum_duration_seconds": strategy_payload.get("maximum_duration_seconds"),
            "minimum_viral_score": strategy_payload.get("minimum_viral_score"),
            "preferred_topics": strategy_payload.get("preferred_topics"),
            "topics_to_avoid": strategy_payload.get("topics_to_avoid"),
            "sensitive_topics": strategy_payload.get("sensitive_topics"),
            "clip_style_tags": strategy_payload.get("clip_style_tags"),
            "virality_priorities": strategy_payload.get("virality_priorities"),
            "selection_brief": strategy_payload.get("selection_brief"),
            "avoidance_brief": strategy_payload.get("avoidance_brief"),
            "packaging_brief": strategy_payload.get("packaging_brief"),
            "hook_style": strategy_payload.get("hook_style"),
            "cta_preference": strategy_payload.get("cta_preference"),
            "standalone_priority": strategy_payload.get("standalone_priority"),
            "require_spoken_audio": strategy_payload.get("require_spoken_audio"),
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
                "comment-triggering accusation or challenge",
                "storytelling beat with clear escalation",
                "cinematic emotional contrast backed by clear spoken narration",
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
            "hook_text_rules": [
                "Keep hook_text short, sharp, and non-generic.",
                "Prefer hook_text that could work as on-screen text in 3 to 8 words.",
                "Avoid generic phrases like watch until the end or here is the clip.",
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
        "editorial_profile": {
            "clip_style_tags": strategy_payload.get("clip_style_tags") or [],
            "virality_priorities": strategy_payload.get("virality_priorities") or [],
            "standalone_priority": strategy_payload.get("standalone_priority") or "PREFERRED",
            "require_spoken_audio": strategy_payload.get("require_spoken_audio", True),
            "target_candidate_count": strategy_payload.get("candidate_pool_count") or strategy_payload.get("desired_clip_count"),
            "final_render_selection_count": strategy_payload.get("desired_clip_count"),
            "allowed_output_categories": {
                "debate": "opini keras, bantahan, kontra, perdebatan",
                "insight": "edukasi, reframing, insight praktis, jawaban tajam",
                "story": "pengalaman pribadi, storytelling, narasi dengan payoff",
                "reaction": "reaksi emosional atau respons spontan yang tetap jelas konteksnya",
                "humor": "momen lucu yang tetap punya konteks",
                "other": "momen kuat lain yang tidak pas dengan kategori di atas",
            },
        },
        "user_editor_briefs": {
            "content_context": content_payload.get("context"),
            "selection_brief": strategy_payload.get("selection_brief"),
            "avoidance_brief": strategy_payload.get("avoidance_brief"),
            "packaging_brief": strategy_payload.get("packaging_brief"),
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
        "transcript_segments": condensed_transcript_segments,
        "scenes": condensed_scenes,
        "silences": condensed_silences,
    }


def _condense_transcript_segments(
    segments: list[Any],
    *,
    max_segments: int,
    max_chars_per_segment: int,
    max_window_seconds: float,
) -> list[dict[str, Any]]:
    condensed: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for segment in segments:
        text = str(getattr(segment, "text", "") or "").strip()
        if not text:
            continue

        speaker_label = getattr(segment, "speaker_label", None)
        start_seconds = float(getattr(segment, "start_seconds"))
        end_seconds = float(getattr(segment, "end_seconds"))

        if current is None:
            current = {
                "segment_id": str(getattr(segment, "segment_id", f"segment-{len(condensed) + 1}")),
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "speaker_label": speaker_label,
                "text": text,
            }
            continue

        merged_text = f"{current['text']} {text}".strip()
        same_speaker = current.get("speaker_label") == speaker_label
        within_window = (end_seconds - float(current["start_seconds"])) <= max_window_seconds
        within_chars = len(merged_text) <= max_chars_per_segment

        if same_speaker and within_window and within_chars:
            current["end_seconds"] = end_seconds
            current["text"] = merged_text
            continue

        condensed.append(current)
        current = {
            "segment_id": str(getattr(segment, "segment_id", f"segment-{len(condensed) + 1}")),
            "start_seconds": start_seconds,
            "end_seconds": end_seconds,
            "speaker_label": speaker_label,
            "text": text,
        }

    if current is not None:
        condensed.append(current)

    if len(condensed) <= max_segments:
        return condensed

    step = max(1, len(condensed) // max_segments)
    sampled = [condensed[index] for index in range(0, len(condensed), step)]
    return sampled[:max_segments]


def _limit_boundaries(boundaries: list[Any], *, id_key: str, limit: int) -> list[dict[str, Any]]:
    limited = boundaries[:limit]
    result: list[dict[str, Any]] = []
    for index, boundary in enumerate(limited, start=1):
        result.append(
            {
                id_key: getattr(boundary, id_key, None) or f"{id_key}-{index}",
                "start_seconds": float(getattr(boundary, "start_seconds")),
                "end_seconds": float(getattr(boundary, "end_seconds")),
            }
        )
    return result
