You are an expert speech director, audiobook editor, and documentary narrator.

Your task is NOT to rewrite the script.

Your task is ONLY to split the narration into natural speech segments for Text-to-Speech generation.

The output will be consumed by an automated TTS engine (Piper, XTTS, Kokoro TTS, ElevenLabs, etc.).

Your goal is to make the generated speech sound as close as possible to a professional human documentary narrator.

---

## RULES

Never change the meaning.

Never summarize.

Never add new words.

Never remove important words.

Never paraphrase.

Keep the original wording exactly.

Only split the text.

---

## HOW TO SPLIT

Split based on natural breathing.

Split where a professional narrator would naturally pause.

Typical split locations:

• after complete thoughts

• before emphasis

• after dramatic statements

• after questions

• before conclusions

• before lists

• after short impactful sentences

Do NOT split inside:

• names

• dates

• numbers

• technical terms

• quotations

Avoid segments longer than about 18 words.

Ideal segment length:

5–14 words.

---

## PAUSE RULES

Return pause_after in milliseconds.

Use only:

250
400
600
800
1000
1200
1500
1800
2200

Guide:

250
tiny pause

400
comma

600
small thought

800
sentence ending

1000
important statement

1200
dramatic pause

1500
new topic

1800
major reveal

2200
section ending

---

## EMPHASIS

Return one of:

low

medium

high

Use high only for:

major reveal

important fact

surprise

warning

key conclusion

---

## SPEED

Return one of:

slow

normal

fast

Storytelling usually uses:

slow

normal

Never use fast unless action scenes.

---

## EMOTION

Return one of:

neutral

curious

serious

dramatic

hopeful

sad

surprised

calm

Choose the most appropriate emotion for each segment.

---

## OUTPUT FORMAT

Return ONLY valid JSON.

No markdown.

No explanations.

No comments.

JSON schema:

{
"segments":[
{
"id": 1,
"text": "...",
"pause_after": 800,
"emotion": "curious",
"speed": "normal",
"emphasis": "medium",
"volume": "normal",
"breath_before": false,
"breath_after": false,
"fade_in_ms": 0,
"fade_out_ms": 80
}
]
}

User Script
│
▼
OpenAI GPT
│
│ Generate Speech Segments (JSON)
▼
segments.json
│
├── text
├── pause_after
├── emotion
├── emphasis
└── speed
│
▼
Python TTS Engine
(Piper / XTTS / Kokoro / ElevenLabs)
│
▼
Generate WAV per segment
│
▼
Merge Audio
│
├── pause_after
├── optional background music
├── optional fade
├── optional breathing
▼
Final Narration.wav

buat tools ai jadi dropdown, nanti ada beberapa menu AI lainya

pakai package https://github.com/OHF-Voice/piper1-gpl

model sudah saya download di: D:\my-project\creator-studio-ai\model_tts

untuk sample example model lainnya dan lain2 ada di web ini: https://rhasspy.github.io/piper-samples/#en_GB-alan-medium

nanti user bisa pilih model yang tersedia dan setiap model ada test suaranya seperti di web sample

example script yang sudah saya implement sebelumnya:

from **future** import annotations

import csv
import hashlib
import io
import json
import os
import re
import shutil
import unicodedata
import uuid
import wave
from datetime import datetime
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel
from piper import PiperVoice, SynthesisConfig

# ============================================================

# CONFIG

# ============================================================

# Load .env from the same directory as this Python script.

ENV_FILE = Path(**file**).resolve().parent / ".env"
load_dotenv(ENV_FILE)

MODEL = Path(r"D:\test\en_GB-jenny_dioco-medium.onnx")
INPUT_CSV = Path(r"D:\test\script.csv")
OUTPUT_WAV = Path(r"D:\test\final_story.wav")

# OpenAI is used only to split narration and choose natural pauses.

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini").strip()

# If SCRIPT_TEXT is filled, it takes priority over INPUT_CSV.

# You can paste the complete CSV directly between the triple quotes.

SCRIPT_TEXT = r"""
"""

# Generate all narration with one consistent global speed.

CALIBRATION_LENGTH_SCALE = 1.15
MIN_GLOBAL_LENGTH_SCALE = 1.00
MAX_GLOBAL_LENGTH_SCALE = 1.60

# Aim near the source timeline without forcing an exact duration.

# 0.92 means an 8-minute timeline aims for about 7:22.

TARGET_TIMELINE_RATIO = 0.92

# Natural pause controls. No large timeline padding is added.

NATURAL_PAUSE_SCALE = 0.75
MIN_INTERNAL_PAUSE_MS = 120
MAX_INTERNAL_PAUSE_MS = 700
SECTION_GAP_MS = 650

NOISE_SCALE = 0.55
NOISE_W_SCALE = 0.75

KEEP_TEMP_FILES = True
ALLOW_LOCAL_SEGMENTATION_FALLBACK = True

WORK_DIR = OUTPUT_WAV.parent
CACHE_FILE = WORK_DIR / "tts_segments_cache.json"
REPORT_FILE = WORK_DIR / "tts_timing_report.csv"

RUN*ID = datetime.now().strftime("%Y%m%d*%H%M%S") + "\_" + uuid.uuid4().hex[:6]
TEMP_DIR = WORK_DIR / "temp_audio" / RUN_ID

# ============================================================

# OPENAI STRUCTURED OUTPUT MODELS

# ============================================================

class TTSSegment(BaseModel):
text: str
pause_after_ms: int
emotion: Literal[
"neutral",
"curious",
"serious",
"dramatic",
"hopeful",
"sad",
"surprised",
"calm",
]
emphasis: Literal["low", "medium", "high"]

class TTSSectionPlan(BaseModel):
row_number: int
segments: list[TTSSegment]

class TTSScriptPlan(BaseModel):
sections: list[TTSSectionPlan]

# ============================================================

# CSV AND TIMELINE PARSING

# ============================================================

def read_script_source() -> str:
if SCRIPT_TEXT.strip():
return SCRIPT_TEXT.strip()

    if not INPUT_CSV.is_file():
        raise FileNotFoundError(
            f"Input CSV was not found: {INPUT_CSV}\n"
            "Copy script-example.csv to D:\\test\\script.csv, "
            "or paste the CSV into SCRIPT_TEXT."
        )

    return INPUT_CSV.read_text(encoding="utf-8-sig").strip()

def normalize_header(value: str) -> str:
return re.sub(r"[^a-z0-9]+", "", value.strip().lower())

def parse_timestamp(value: str) -> int:
value = value.strip()
parts = value.split(":")

    try:
        numbers = [int(part) for part in parts]
    except ValueError as exc:
        raise ValueError(f"Invalid timestamp: {value!r}") from exc

    if len(numbers) == 2:
        minutes, seconds = numbers
        total_seconds = minutes * 60 + seconds
    elif len(numbers) == 3:
        hours, minutes, seconds = numbers
        total_seconds = hours * 3600 + minutes * 60 + seconds
    else:
        raise ValueError(
            f"Timestamp must use M:SS or H:MM:SS format: {value!r}"
        )

    if total_seconds < 0:
        raise ValueError(f"Timestamp cannot be negative: {value!r}")

    return total_seconds * 1000

def parse_time_range(value: str) -> tuple[int, int]:
normalized = (
value.strip()
.replace("—", "-")
.replace("–", "-")
.replace("−", "-")
)

    parts = re.split(r"\s*-\s*", normalized, maxsplit=1)

    if len(parts) != 2:
        raise ValueError(
            f"Invalid time range {value!r}. Expected format 0:00-0:05."
        )

    start_ms = parse_timestamp(parts[0])
    end_ms = parse_timestamp(parts[1])

    if end_ms <= start_ms:
        raise ValueError(
            f"End time must be after start time: {value!r}"
        )

    return start_ms, end_ms

def ensure_csv_header(text: str) -> str:
first_nonempty = next(
(line for line in text.splitlines() if line.strip()),
"",
)

    normalized_first = normalize_header(first_nonempty)

    if "time" in normalized_first and "narration" in normalized_first:
        return text

    return (
        "Time,Narration,Visual Direction,On-Screen Text,Audio / Editing\n"
        + text
    )

def load_timeline(text: str) -> list[dict]:
text = ensure_csv_header(text)

    reader = csv.DictReader(io.StringIO(text))

    if not reader.fieldnames:
        raise ValueError("CSV has no header.")

    field_map = {
        normalize_header(name): name
        for name in reader.fieldnames
        if name is not None
    }

    time_column = field_map.get("time")
    narration_column = field_map.get("narration")

    if not time_column or not narration_column:
        raise ValueError(
            "CSV must contain Time and Narration columns. "
            f"Found: {reader.fieldnames}"
        )

    sections: list[dict] = []

    for row_number, row in enumerate(reader, start=1):
        time_value = (row.get(time_column) or "").strip()
        narration = (row.get(narration_column) or "").strip()

        if not time_value and not narration:
            continue

        if not time_value:
            raise ValueError(f"Row {row_number}: Time is empty.")

        if not narration:
            raise ValueError(f"Row {row_number}: Narration is empty.")

        start_ms, end_ms = parse_time_range(time_value)

        sections.append(
            {
                "row_number": row_number,
                "time": time_value,
                "start_ms": start_ms,
                "end_ms": end_ms,
                "target_ms": end_ms - start_ms,
                "narration": narration,
                "visual_direction": (
                    row.get(field_map.get("visualdirection", ""), "") or ""
                ).strip(),
                "on_screen_text": (
                    row.get(field_map.get("onscreentext", ""), "") or ""
                ).strip(),
                "audio_editing": (
                    row.get(field_map.get("audioediting", ""), "") or ""
                ).strip(),
            }
        )

    if not sections:
        raise ValueError("CSV contains no narration rows.")

    sections.sort(key=lambda item: item["start_ms"])

    previous_end = 0

    for section in sections:
        if section["start_ms"] < previous_end:
            raise ValueError(
                f"Timeline overlap near {section['time']}."
            )
        previous_end = section["end_ms"]

    return sections

# ============================================================

# SEGMENTATION

# ============================================================

def token_signature(text: str) -> list[str]:
normalized = unicodedata.normalize("NFKC", text)
normalized = normalized.replace("’", "'").replace("‘", "'")
normalized = normalized.replace("“", '"').replace("”", '"')

    return re.findall(
        r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)*|[^\w\s]",
        normalized,
        flags=re.UNICODE,
    )

def segmentation_preserves_text(
narration: str,
segments: list[TTSSegment],
) -> bool:
joined = " ".join(segment.text.strip() for segment in segments)
return token_signature(joined) == token_signature(narration)

def pause_for_text(text: str) -> int:
stripped = text.rstrip()

    if stripped.endswith(("?", "!")):
        return 900
    if stripped.endswith("."):
        return 750
    if stripped.endswith((",", ";", ":")):
        return 350
    return 450

def local_segment_narration(
narration: str,
row_number: int,
) -> TTSSectionPlan: # Split after sentence punctuation first, then long comma clauses.
sentence_parts = re.split(r"(?<=[.!?])\s+", narration.strip())
output_parts: list[str] = []

    for sentence in sentence_parts:
        sentence = sentence.strip()

        if not sentence:
            continue

        words = sentence.split()

        if len(words) <= 22:
            output_parts.append(sentence)
            continue

        clause_parts = re.split(r"(?<=[,;:])\s+", sentence)
        buffer = ""

        for clause in clause_parts:
            candidate = f"{buffer} {clause}".strip()

            if buffer and len(candidate.split()) > 22:
                output_parts.append(buffer)
                buffer = clause
            else:
                buffer = candidate

        if buffer:
            output_parts.append(buffer)

    segments = [
        TTSSegment(
            text=part,
            pause_after_ms=pause_for_text(part),
            emotion="calm",
            emphasis="medium",
        )
        for part in output_parts
    ]

    if not segmentation_preserves_text(narration, segments):
        segments = [
            TTSSegment(
                text=narration,
                pause_after_ms=750,
                emotion="calm",
                emphasis="medium",
            )
        ]

    return TTSSectionPlan(
        row_number=row_number,
        segments=segments,
    )

def create_openai_prompt(sections: list[dict]) -> str:
payload = [
{
"row_number": section["row_number"],
"time": section["time"],
"target_seconds": round(section["target_ms"] / 1000, 3),
"narration": section["narration"],
}
for section in sections
]

    return (
        "Create a TTS segmentation plan for every timeline row below.\n\n"
        "Critical requirements:\n"
        "1. Preserve every original word and punctuation mark.\n"
        "2. Never rewrite, summarize, add, remove, or reorder text.\n"
        "3. Split only at natural breathing or thought boundaries.\n"
        "4. Prefer 6-18 words per segment, but keep a short dramatic "
        "sentence intact.\n"
        "5. pause_after_ms must be between 100 and 1200.\n"
        "6. Use shorter pauses when the narration is dense for its "
        "target duration.\n"
        "7. Return every row_number exactly once and in the same order.\n"
        "8. Piper cannot directly use emotion or emphasis; those fields "
        "are metadata for future TTS engines.\n\n"
        "Timeline JSON:\n"
        + json.dumps(payload, ensure_ascii=False, indent=2)
    )

def plan_fingerprint(source_text: str) -> str:
material = (
"tts-segmentation-v3\n" + OPENAI_MODEL + "\n" + source_text
)
return hashlib.sha256(material.encode("utf-8")).hexdigest()

def save_plan_cache(fingerprint: str, plan: TTSScriptPlan) -> None:
CACHE_FILE.write_text(
json.dumps(
{
"fingerprint": fingerprint,
"model": OPENAI_MODEL,
"plan": plan.model_dump(),
},
ensure_ascii=False,
indent=2,
),
encoding="utf-8",
)

def load_plan_cache(fingerprint: str) -> TTSScriptPlan | None:
if not CACHE_FILE.is_file():
return None

    try:
        data = json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if data.get("fingerprint") != fingerprint:
        return None

    try:
        return TTSScriptPlan.model_validate(data["plan"])
    except Exception:
        return None

def generate_segmentation_plan(
sections: list[dict],
source_text: str,
) -> TTSScriptPlan:
fingerprint = plan_fingerprint(source_text)
cached = load_plan_cache(fingerprint)

    if cached is not None:
        print(f"Using cached OpenAI segmentation: {CACHE_FILE}")
        return validate_and_repair_plan(cached, sections)

    api_key = os.getenv("OPENAI_API_KEY", "").strip()

    if not api_key:
        if not ALLOW_LOCAL_SEGMENTATION_FALLBACK:
            raise RuntimeError(
                "OPENAI_API_KEY is not set.\n"
                'PowerShell example:\n'
                '$env:OPENAI_API_KEY="sk-..."'
            )

        print(
            "OPENAI_API_KEY is not set. "
            "Using local segmentation fallback."
        )

        return TTSScriptPlan(
            sections=[
                local_segment_narration(
                    section["narration"],
                    section["row_number"],
                )
                for section in sections
            ]
        )

    print(f"Generating TTS segments with OpenAI model: {OPENAI_MODEL}")

    client = OpenAI(api_key=api_key)

    try:
        response = client.responses.parse(
            model=OPENAI_MODEL,
            input=[
                {
                    "role": "system",
                    "content": (
                        "You are a professional documentary speech "
                        "director. Produce structured TTS segments while "
                        "preserving the supplied narration exactly."
                    ),
                },
                {
                    "role": "user",
                    "content": create_openai_prompt(sections),
                },
            ],
            text_format=TTSScriptPlan,
        )

        plan = response.output_parsed

        if plan is None:
            raise RuntimeError("OpenAI returned no parsed segmentation.")

        plan = validate_and_repair_plan(plan, sections)
        save_plan_cache(fingerprint, plan)
        return plan

    except Exception as exc:
        if not ALLOW_LOCAL_SEGMENTATION_FALLBACK:
            raise

        print(
            "OpenAI segmentation failed. "
            f"Using local fallback instead.\nReason: {exc}"
        )

        return TTSScriptPlan(
            sections=[
                local_segment_narration(
                    section["narration"],
                    section["row_number"],
                )
                for section in sections
            ]
        )

def validate_and_repair_plan(
plan: TTSScriptPlan,
sections: list[dict],
) -> TTSScriptPlan:
plan_by_row = {
item.row_number: item
for item in plan.sections
}

    repaired: list[TTSSectionPlan] = []

    for section in sections:
        row_number = section["row_number"]
        planned = plan_by_row.get(row_number)

        if (
            planned is None
            or not planned.segments
            or not segmentation_preserves_text(
                section["narration"],
                planned.segments,
            )
        ):
            print(
                f"Row {row_number}: OpenAI segmentation changed or "
                "missed text. Using safe local split."
            )
            planned = local_segment_narration(
                section["narration"],
                row_number,
            )

        cleaned_segments: list[TTSSegment] = []

        for segment in planned.segments:
            cleaned_segments.append(
                TTSSegment(
                    text=segment.text.strip(),
                    pause_after_ms=max(
                        100,
                        min(1200, int(segment.pause_after_ms)),
                    ),
                    emotion=segment.emotion,
                    emphasis=segment.emphasis,
                )
            )

        repaired.append(
            TTSSectionPlan(
                row_number=row_number,
                segments=cleaned_segments,
            )
        )

    return TTSScriptPlan(sections=repaired)

# ============================================================

# WAV HELPERS

# ============================================================

def wav_duration_ms(path: Path) -> int:
with wave.open(str(path), "rb") as wav_file:
return round(
wav_file.getnframes()
/ wav_file.getframerate() \* 1000
)

def append_silence(
wav_writer: wave.Wave_write,
duration_ms: int,
frame_rate: int,
channels: int,
sample_width: int,
) -> None:
if duration_ms <= 0:
return

    frame_count = round(frame_rate * duration_ms / 1000)
    silence_frame = b"\x00" * sample_width * channels
    wav_writer.writeframes(silence_frame * frame_count)

def inspect_wav_format(path: Path) -> tuple[int, int, int, str]:
with wave.open(str(path), "rb") as wav_file:
return (
wav_file.getnchannels(),
wav_file.getsampwidth(),
wav_file.getframerate(),
wav_file.getcomptype(),
)

def copy_wav_frames(
source_path: Path,
destination: wave.Wave_write,
expected_format: tuple[int, int, int, str],
) -> None:
with wave.open(str(source_path), "rb") as source:
current_format = (
source.getnchannels(),
source.getsampwidth(),
source.getframerate(),
source.getcomptype(),
)

        if current_format != expected_format:
            raise RuntimeError(
                f"Incompatible WAV format in {source_path}: "
                f"{current_format}; expected {expected_format}"
            )

        destination.writeframes(
            source.readframes(source.getnframes())
        )

# ============================================================

# PIPER GENERATION WITH ONE GLOBAL SPEED

# ============================================================

def clamp(value: int, minimum: int, maximum: int) -> int:
return max(minimum, min(maximum, value))

def natural_pause_ms(
raw_pause_ms: int,
is_last_segment_in_section: bool,
is_last_section: bool,
) -> int:
if is_last_segment_in_section:
return 0 if is_last_section else SECTION_GAP_MS

    return clamp(
        round(raw_pause_ms * NATURAL_PAUSE_SCALE),
        MIN_INTERNAL_PAUSE_MS,
        MAX_INTERNAL_PAUSE_MS,
    )

def render_pass(
voice: PiperVoice,
timeline: list[dict],
plan_by_row: dict[int, TTSSectionPlan],
length_scale: float,
pass_name: str,
) -> list[dict]:
pass_dir = TEMP_DIR / pass_name
pass_dir.mkdir(parents=True, exist_ok=True)

    config = SynthesisConfig(
        length_scale=length_scale,
        noise_scale=NOISE_SCALE,
        noise_w_scale=NOISE_W_SCALE,
    )

    records: list[dict] = []
    section_count = len(timeline)

    for section_index, section in enumerate(timeline, start=1):
        section_plan = plan_by_row[section["row_number"]]
        segment_count = len(section_plan.segments)
        section_dir = pass_dir / f"section_{section_index:03d}"
        section_dir.mkdir(parents=True, exist_ok=True)

        print(
            f"  {pass_name}: section {section_index}/{section_count} "
            f"{section['time']}"
        )

        for segment_index, segment in enumerate(
            section_plan.segments,
            start=1,
        ):
            segment_path = (
                section_dir / f"segment_{segment_index:03d}.wav"
            )

            with wave.open(str(segment_path), "wb") as wav_file:
                voice.synthesize_wav(
                    segment.text,
                    wav_file,
                    syn_config=config,
                )

            is_last_segment = segment_index == segment_count
            is_last_section = section_index == section_count

            pause_ms = natural_pause_ms(
                raw_pause_ms=segment.pause_after_ms,
                is_last_segment_in_section=is_last_segment,
                is_last_section=is_last_section,
            )

            records.append(
                {
                    "section_index": section_index,
                    "section": section,
                    "segment_index": segment_index,
                    "segment_count": segment_count,
                    "text": segment.text,
                    "path": segment_path,
                    "speech_ms": wav_duration_ms(segment_path),
                    "pause_ms": pause_ms,
                }
            )

    return records

def total_duration_ms(records: list[dict]) -> int:
return sum(
record["speech_ms"] + record["pause_ms"]
for record in records
)

def total_speech_ms(records: list[dict]) -> int:
return sum(record["speech_ms"] for record in records)

def total_pause_ms(records: list[dict]) -> int:
return sum(record["pause_ms"] for record in records)

def calculate_global_length_scale(
calibration_records: list[dict],
timeline_duration_ms: int,
) -> tuple[float, int]:
pause_ms = total_pause_ms(calibration_records)
speech_ms = total_speech_ms(calibration_records)

    desired_total_ms = round(
        timeline_duration_ms * TARGET_TIMELINE_RATIO
    )
    desired_speech_ms = max(
        1_000,
        desired_total_ms - pause_ms,
    )

    calculated_scale = (
        CALIBRATION_LENGTH_SCALE
        * desired_speech_ms
        / max(speech_ms, 1)
    )

    final_scale = max(
        MIN_GLOBAL_LENGTH_SCALE,
        min(MAX_GLOBAL_LENGTH_SCALE, calculated_scale),
    )

    return final_scale, desired_total_ms

def combine_records(records: list[dict]) -> None:
if not records:
raise RuntimeError("No generated audio records were found.")

    wav_format = inspect_wav_format(records[0]["path"])
    channels, sample_width, frame_rate, compression = wav_format

    if compression != "NONE":
        raise RuntimeError("Expected uncompressed PCM WAV output.")

    OUTPUT_WAV.parent.mkdir(parents=True, exist_ok=True)

    with wave.open(str(OUTPUT_WAV), "wb") as destination:
        destination.setnchannels(channels)
        destination.setsampwidth(sample_width)
        destination.setframerate(frame_rate)
        destination.setcomptype("NONE", "not compressed")

        for record in records:
            copy_wav_frames(
                record["path"],
                destination,
                wav_format,
            )

            append_silence(
                destination,
                duration_ms=record["pause_ms"],
                frame_rate=frame_rate,
                channels=channels,
                sample_width=sample_width,
            )

def write_natural_timing_report(
records: list[dict],
global_length_scale: float,
) -> None:
section_rows: list[dict] = []
cursor_ms = 0

    for section_index in range(
        1,
        len({record["section_index"] for record in records}) + 1,
    ):
        section_records = [
            record
            for record in records
            if record["section_index"] == section_index
        ]

        if not section_records:
            continue

        section = section_records[0]["section"]
        section_speech_ms = sum(
            record["speech_ms"]
            for record in section_records
        )
        section_pause_ms = sum(
            record["pause_ms"]
            for record in section_records
        )
        generated_start_ms = cursor_ms
        generated_end_ms = (
            generated_start_ms
            + section_speech_ms
            + section_pause_ms
        )
        cursor_ms = generated_end_ms

        section_rows.append(
            {
                "row_number": section["row_number"],
                "source_time": section["time"],
                "source_start_seconds": round(
                    section["start_ms"] / 1000,
                    3,
                ),
                "source_end_seconds": round(
                    section["end_ms"] / 1000,
                    3,
                ),
                "generated_start_seconds": round(
                    generated_start_ms / 1000,
                    3,
                ),
                "generated_end_seconds": round(
                    generated_end_ms / 1000,
                    3,
                ),
                "speech_seconds": round(
                    section_speech_ms / 1000,
                    3,
                ),
                "pause_seconds": round(
                    section_pause_ms / 1000,
                    3,
                ),
                "segments": len(section_records),
                "global_length_scale": round(
                    global_length_scale,
                    4,
                ),
                "narration": section["narration"],
            }
        )

    with REPORT_FILE.open(
        "w",
        encoding="utf-8-sig",
        newline="",
    ) as report:
        writer = csv.DictWriter(
            report,
            fieldnames=list(section_rows[0].keys()),
        )
        writer.writeheader()
        writer.writerows(section_rows)

# ============================================================

# MAIN

# ============================================================

def main() -> None:
if not MODEL.is_file():
raise FileNotFoundError(
f"Piper model was not found: {MODEL}"
)

    source_text = read_script_source()
    timeline = load_timeline(source_text)

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    timeline_duration_ms = timeline[-1]["end_ms"]

    print(f"Environment file: {ENV_FILE}")
    print(f"OpenAI model: {OPENAI_MODEL}")
    print(f"Loaded timeline rows: {len(timeline)}")
    print(
        "Source timeline duration: "
        f"{timeline_duration_ms / 1000:.2f}s"
    )
    print(
        "Pacing mode: one global speed, natural pauses, "
        "no timeline padding"
    )

    plan = generate_segmentation_plan(
        sections=timeline,
        source_text=source_text,
    )

    plan_by_row = {
        item.row_number: item
        for item in plan.sections
    }

    print("Loading Piper model once...")
    voice = PiperVoice.load(str(MODEL))

    print(
        "\nCalibration pass at "
        f"length_scale={CALIBRATION_LENGTH_SCALE:.2f}..."
    )
    calibration_records = render_pass(
        voice=voice,
        timeline=timeline,
        plan_by_row=plan_by_row,
        length_scale=CALIBRATION_LENGTH_SCALE,
        pass_name="calibration",
    )

    calibration_duration_ms = total_duration_ms(
        calibration_records
    )

    global_length_scale, desired_total_ms = (
        calculate_global_length_scale(
            calibration_records,
            timeline_duration_ms,
        )
    )

    print(
        "\nCalibration duration: "
        f"{calibration_duration_ms / 1000:.2f}s"
    )
    print(
        "Desired approximate duration: "
        f"{desired_total_ms / 1000:.2f}s "
        f"({TARGET_TIMELINE_RATIO:.0%} of source timeline)"
    )
    print(
        "Selected one global length_scale: "
        f"{global_length_scale:.3f}"
    )

    if (
        abs(
            global_length_scale
            - CALIBRATION_LENGTH_SCALE
        )
        < 0.01
    ):
        final_records = calibration_records
        print("Reusing calibration audio.")
    else:
        print("\nFinal pass with consistent global speed...")
        final_records = render_pass(
            voice=voice,
            timeline=timeline,
            plan_by_row=plan_by_row,
            length_scale=global_length_scale,
            pass_name="final",
        )

    print("\nCombining narration without long padding...")
    combine_records(final_records)
    write_natural_timing_report(
        final_records,
        global_length_scale,
    )

    final_duration_ms = wav_duration_ms(OUTPUT_WAV)
    speech_ms = total_speech_ms(final_records)
    pause_ms = total_pause_ms(final_records)

    print("\nDone!")
    print(f"Output: {OUTPUT_WAV}")
    print(f"Timing report: {REPORT_FILE}")
    print(
        f"Speech duration: {speech_ms / 1000:.2f}s"
    )
    print(
        f"Natural pauses: {pause_ms / 1000:.2f}s"
    )
    print(
        f"Final duration: {final_duration_ms / 1000:.2f}s"
    )
    print(
        "No section was padded to match its exact source slot."
    )

    if global_length_scale >= MAX_GLOBAL_LENGTH_SCALE:
        print(
            "Note: the maximum natural global slowdown was reached. "
            "The output remains shorter than the source timeline "
            "rather than adding long silence."
        )

    if not KEEP_TEMP_FILES:
        shutil.rmtree(TEMP_DIR, ignore_errors=True)

if **name** == "**main**":
main()
