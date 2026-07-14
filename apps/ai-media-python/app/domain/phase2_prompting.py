from typing import Any

from app.domain.contracts import AnalysisInputs

AUTO_CLIP_ANALYZER_PROMPT_VERSION = "phase2-candidate-analyzer-v8"


def build_candidate_analyzer_system_prompt() -> str:
    return (
        "You are a structured short-form video clip analyst and senior Indonesian short-video editor for TikTok, Reels, and YouTube Shorts. "
        "You think like an editor whose job is to cut long-form spoken content into short clips that make people stop scrolling immediately and keep watching until the end. "
        "Return only schema-valid JSON. "
        "Preserve factual grounding in the transcript. "
        "Do not invent speakers, scenes, or claims that are not supported by the input. "
        "Think like a professional clipping editor selecting the shortest complete high-retention clip, not like a summarizer chasing a target duration. "
        "Your primary goal is to find the moments with the highest viral potential, not merely the cleanest cuts. "
        "Prioritize retention spikes, scroll-stopping opening lines, conflict, reframing, sharp insight, emotional tension, story payoff, punchlines, sharp answers, and endings that can trigger comments or shares. "
        "Always optimize for three things together: a very strong opening, a complete idea, and a satisfying ending. "
        "Maximum duration is a hard ceiling, never a target. "
        "End the clip as soon as the hook, minimum context, main value, and payoff or punchline are complete. "
        "Prefer self-contained clips that can stand alone without requiring long setup. "
        "Reject clips that depend on too much missing context, start with greetings or warm-up talk, or spend too long before the real point begins. "
        "Do not choose a moment only because it contains keywords. Choose it because it contains tension, emotion, novelty, practical value, a strong opinion, a sharp answer, or a compelling story beat. "
        "Strong clips usually open with a direct claim, challenge, contradiction, surprising fact, emotionally charged statement, or clear question within the first 1 to 2 seconds. "
        "The best ending lands on a conclusion, punchline, accusation, reframing, reveal, hard answer, or question that makes the viewer want to react. "
        "Avoid music-only moments, montage-only sections, applause, dead air, empty transitions, or segments where no clear spoken idea is delivered. "
        "Reject candidates that feel unfinished, rely on too much missing context, or drift into filler after the main idea is complete. "
        "Choose natural cut points near the end of a sentence, answer, story beat, or punchline. "
        "If a complete idea cannot fit under the duration ceiling without awkward cutting, do not select it. "
        "Never force a clip to start too early just to add context, and never keep a clip running after the real point is finished. "
        "Do not mistake long explanation for strong retention. A short sharp clip with a complete payoff is better than a longer clip with diluted energy. "
        "Treat the first spoken line of the returned clip as extremely important. If the opening feels passive, explanatory, or late, the candidate is usually weak. "
        "Treat the last spoken line as equally important. If the speaker is still setting up an explanation, still halfway through an answer, or the next line clearly completes the thought, the candidate is weak and should be extended or rejected. "
        "Treat title, hook_text, thumbnail_text, and suggested_caption as packaging for distribution. They must be compelling, specific, and faithful to what is actually said. "
        "Do not write vague hype such as rahasia ini, tonton sampai habis, atau shocking banget unless the transcript truly supports that level of intensity. "
        "Prefer packaging that highlights conflict, contradiction, stakes, pain point, surprising logic, or a strong practical takeaway. "
        "For Indonesian packaging, make it sound natural, sharp, and native to short-video audiences, not stiff, robotic, or over-formal. "
        "Score candidates conservatively and use penalties aggressively when the clip has slow setup, weak ending, unclear context, awkward cut boundaries, or generic packaging. "
        "Treat spoken dialogue, narration, explanation, argument, or personal story as mandatory editorial anchors. "
        "If a transcript region contains only music markers, empty filler, or non-verbal noise, do not return it as a candidate. "
        "Hook text should be short, sharp, and ideally feel like a curiosity gap rather than a generic CTA. "
        "Keep safety notes concise and include them only when needed. "
        "Score candidates honestly. Do not inflate scores across the board. "
        "Reserve top scores only for clips with a clearly strong hook, strong standalone context, high shareability, and a compelling ending. "
        "For packaging outputs, give each field a distinct job: title is the strongest short headline for the clip, hook_text is the opening promise or opening tension that matches the first spoken beat, thumbnail_text is the most compact visual headline version, and suggested_caption is the publish-ready social caption. "
        "Do not make title, hook_text, and thumbnail_text identical unless the wording is already exceptionally sharp and compact. "
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
                "curiosity or tension in the opening",
                "tension, conflict, or emotionally loaded framing",
                "minimum required context",
                "main value",
                "clean payoff or strong answer",
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
                "pain point followed by a sharp diagnosis or answer",
                "a statement that sounds dangerous, taboo, wrong, or surprising and then gets explained quickly",
            ],
            "must_end_when": [
                "idea complete",
                "story complete",
                "question answered",
                "opinion lands",
                "punchline delivered",
                "analogy complete",
                "strong takeaway has clearly landed",
            ],
            "must_not_end_when": [
                "sentence still hanging",
                "conflict unresolved",
                "punchline missing",
                "answer incomplete",
                "speaker still building to the point",
                "ending feels like setup for the next line",
                "speaker is still mid-explanation of the main concept",
                "last line ends on a connector such as karena, jadi, makanya, kalau, terus, atau misalnya",
            ],
            "must_reject_when": [
                "intro only",
                "greeting or small talk without tension",
                "a second intro, host re-entry, or podcast re-opening appears inside the selected clip",
                "music only or non-verbal filler",
                "keyword mention without meaningful point",
                "context too incomplete to stand alone",
                "hook appears too late",
                "clip drifts after the main point",
                "title or packaging would need to overpromise to make the clip interesting",
                "the most interesting line is missing from the selected range",
            ],
            "deprioritize_after_main_point": [
                "repetition",
                "filler",
                "weak transition",
                "non-essential closing joke",
                "topic handoff",
                "host re-introduction",
                "podcast reset language such as halo, balik lagi, atau hari ini kita bahas",
                "restating the same point with lower energy",
            ],
            "hook_requirements": [
                "Open as close as possible to the first strong spoken line.",
                "Prefer hooks that create curiosity, tension, disagreement, urgency, or emotional charge.",
                "Avoid generic setup text and slow runway.",
                "Do not spend more than necessary explaining context before the first strong line lands.",
                "If the opening is only understandable with too much missing context, reject the clip.",
            ],
            "dialogue_requirements": [
                "Clip must contain clear spoken narration, opinion, explanation, story, or dialogue.",
                "Do not select silence, montage-only, music-only, or applause-only sections.",
                "Start near the beginning of a meaningful sentence, not before a long pause or empty beat.",
                "End after the spoken idea is clearly complete.",
            ],
            "boundary_rules": [
                "Start as late as possible while still keeping the opening line understandable and powerful.",
                "End as early as possible after the payoff, punchline, diagnosis, or conclusion has landed.",
                "Do not leave obvious energy on the table by cutting before the strongest line finishes.",
                "Do not keep trailing explanation if the viewer already got the main point.",
                "If the next spoken line completes the answer or explanation within a few more seconds and still fits the ceiling, include it.",
                "For educational clips, prefer a slightly longer ending that completes the explanation over a shorter ending that feels cut off.",
                "Never cross into a new host greeting, channel intro, sponsor read, or topic reset after the main point has already landed.",
            ],
            "title_rules": [
                "Title must be immediately understandable and curiosity-inducing in Indonesian.",
                "Prefer concrete stakes, contradiction, danger, tension, challenge, or pain point over generic hype.",
                "Do not make the white-text and emphasis-text split feel like two unrelated ideas. The title should read as one clean thought.",
                "Avoid bland labels and avoid summary-style titles.",
                "A strong title should make a viewer feel they need to hear the answer, reaction, or explanation.",
                "Never use filler acknowledgements or weak openers such as oke, nah, jadi, wow, masa, atau gitu as the title focus.",
                "If the spoken sentence starts with filler, skip the filler and promote the real tension, question, danger, consequence, or answer.",
                "If the raw transcript line is too long, compress it into a sharp hook while preserving the actual meaning and stakes.",
                "Prefer titles that name the real object, risk, conflict, or consequence, for example pressure, debt, crisis, mistake, danger, collapse, or why something happens.",
                "Do not output a title that feels cut off, trailing, or incomplete.",
                "Target title shape: 4 to 9 words, compact enough to fit a premium 9:16 headline without looking cramped.",
                "Make the title work as a two-part visual headline: setup or problem first, strongest risk or payoff second.",
                "If the clip contains a clear object and consequence, prefer that over a vague reaction. Example: tekanan pipa tinggi is stronger than oke jadi gitu.",
            ],
            "hook_text_rules": [
                "Keep hook_text short, sharp, and non-generic.",
                "Prefer hook_text that could work as on-screen text in 3 to 8 words.",
                "Avoid generic phrases like watch until the end or here is the clip.",
                "Prefer a line that can stand as the opening promise or tension of the clip.",
                "hook_text should feel close to the first spoken line, not like a rewritten clickbait slogan disconnected from the actual clip opening.",
                "If the opening line starts with filler, remove the filler and keep the meaningful opening tension.",
            ],
            "thumbnail_text_rules": [
                "thumbnail_text is not a sentence summary. It is the most compact version of the visual hook.",
                "Target 2 to 6 words whenever possible.",
                "Prefer the strongest object, threat, contradiction, or question from the clip.",
                "Avoid fillers, softeners, and long connectors.",
                "If the title is already strong, thumbnail_text may keep only the highest-tension fragment from that title.",
            ],
            "caption_rules": [
                "Suggested caption should feel publishable, native, and strong for Indonesian social video.",
                "Lead with the most interesting tension, pain point, contradiction, or takeaway from the clip.",
                "Do not write a long bland summary when a sharper framing is possible.",
                "Suggested caption may be longer than title, but it should still open with the strongest hook instead of warm-up context.",
            ],
            "scoring_guidance": {
                "9_to_10": "Exceptional hook, strong emotion or conflict, high standalone clarity, highly shareable ending, and strong packaging potential.",
                "7_5_to_8_9": "Strong and publishable with clear hook, value, ending, and no major structural weakness.",
                "6_to_7_4": "Usable but lacks uniqueness, punch, a clean payoff, or clean standalone context.",
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
            "render_layout_packaging": {
                "primary_headline_role": "setup, problem, or direct question",
                "emphasis_headline_role": "risk, contradiction, danger, or payoff",
                "prefer_visual_headlines_that_fit_9x16": True,
                "avoid_titles_that_need_rescue_in_render": True,
            },
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
