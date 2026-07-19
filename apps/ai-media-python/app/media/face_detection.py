from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2


class FaceDetectionUnavailable(RuntimeError):
    """Raised when the current OpenCV build cannot run face detection."""


def _build_face_result(
    *,
    x: int,
    y: int,
    width: int,
    height: int,
    image_width: int,
    image_height: int,
    detector: str,
    detector_pass: int = 1,
    confidence: float | None = None,
) -> dict[str, Any]:
    center_x = x + (width / 2)
    result: dict[str, Any] = {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "center_x": round(float(center_x), 2),
        "center_x_ratio": round(float(center_x / max(image_width, 1)), 4),
        "area": int(width * height),
        "image_width": image_width,
        "image_height": image_height,
        "detector_pass": detector_pass,
        "detector": detector,
    }
    if confidence is not None:
        result["confidence"] = round(float(confidence), 4)
    return result


def _detect_faces_with_yunet(
    image: Any,
    *,
    model_path: str | Path | None,
    score_threshold: float,
    min_face_size_px: int,
) -> list[dict[str, Any]]:
    if not model_path or not hasattr(cv2, "FaceDetectorYN"):
        return []

    resolved_model_path = Path(model_path)
    if not resolved_model_path.is_file():
        return []

    image_height, image_width = image.shape[:2]
    try:
        detector = cv2.FaceDetectorYN.create(
            str(resolved_model_path),
            "",
            (image_width, image_height),
            float(score_threshold),
            0.3,
            5000,
        )
        detector.setInputSize((image_width, image_height))
        _, rows = detector.detect(image)
    except cv2.error:
        # A missing, incompatible, or corrupt optional DNN model must never
        # disable the built-in Haar fallback for the whole render.
        return []
    if rows is None:
        return []

    faces: list[dict[str, Any]] = []
    minimum_size = max(20, int(round(min_face_size_px * 0.55)))
    for row in rows:
        x = max(0, int(round(float(row[0]))))
        y = max(0, int(round(float(row[1]))))
        face_width = min(int(round(float(row[2]))), image_width - x)
        face_height = min(int(round(float(row[3]))), image_height - y)
        confidence = float(row[-1])
        if face_width < minimum_size or face_height < minimum_size:
            continue
        faces.append(
            _build_face_result(
                x=x,
                y=y,
                width=face_width,
                height=face_height,
                image_width=image_width,
                image_height=image_height,
                detector="yunet",
                confidence=confidence,
            )
        )
    return faces


def _build_detection_variants(
    *,
    grayscale: Any,
    min_face_size_px: int,
    scale_factor: float,
    min_neighbors: int,
) -> list[tuple[Any, float, int, int]]:
    clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
    enhanced = clahe.apply(grayscale)
    softened = cv2.GaussianBlur(enhanced, (3, 3), 0)
    smaller_face_size = max(28, int(round(min_face_size_px * 0.72)))

    return [
        (grayscale, scale_factor, min_neighbors, min_face_size_px),
        (enhanced, scale_factor, max(3, min_neighbors - 1), smaller_face_size),
        (softened, min(scale_factor + 0.03, 1.18), max(2, min_neighbors - 2), smaller_face_size),
    ]


def _deduplicate_faces(
    faces: list[dict[str, Any]],
    *,
    overlap_threshold: float = 0.30,
) -> list[dict[str, Any]]:
    deduplicated: list[dict[str, Any]] = []

    for face in sorted(faces, key=lambda item: int(item["area"]), reverse=True):
        left = int(face["x"])
        top = int(face["y"])
        right = left + int(face["width"])
        bottom = top + int(face["height"])
        candidate_area = max(1, (right - left) * (bottom - top))

        should_skip = False
        for existing in deduplicated:
            existing_left = int(existing["x"])
            existing_top = int(existing["y"])
            existing_right = existing_left + int(existing["width"])
            existing_bottom = existing_top + int(existing["height"])
            intersection_left = max(left, existing_left)
            intersection_top = max(top, existing_top)
            intersection_right = min(right, existing_right)
            intersection_bottom = min(bottom, existing_bottom)

            if intersection_right <= intersection_left or intersection_bottom <= intersection_top:
                continue

            intersection_area = (intersection_right - intersection_left) * (intersection_bottom - intersection_top)
            reference_area = max(1, min(candidate_area, int(existing["area"])))
            overlap_ratio = intersection_area / reference_area
            if overlap_ratio >= overlap_threshold:
                should_skip = True
                break

        if not should_skip:
            deduplicated.append(face)

    return deduplicated


def detect_faces_in_image(
    image_path: str | Path,
    *,
    min_face_size_px: int = 48,
    scale_factor: float = 1.1,
    min_neighbors: int = 4,
    yunet_model_path: str | Path | None = None,
    yunet_score_threshold: float = 0.72,
) -> list[dict[str, Any]]:
    if not hasattr(cv2, "CascadeClassifier"):
        raise FaceDetectionUnavailable("OpenCV build does not expose CascadeClassifier")
    if not hasattr(cv2, "data") or not hasattr(cv2.data, "haarcascades"):
        raise FaceDetectionUnavailable("OpenCV Haar cascade data path is unavailable")

    cascade_root = Path(cv2.data.haarcascades)
    frontal_classifier = cv2.CascadeClassifier(str(cascade_root / "haarcascade_frontalface_default.xml"))
    if frontal_classifier.empty():
        raise FaceDetectionUnavailable("OpenCV Haar cascade classifier could not be loaded")
    profile_classifier = cv2.CascadeClassifier(str(cascade_root / "haarcascade_profileface.xml"))
    upper_body_classifier = cv2.CascadeClassifier(str(cascade_root / "haarcascade_upperbody.xml"))

    image = cv2.imread(str(image_path))
    if image is None:
        return []

    grayscale = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = grayscale.shape[:2]
    yunet_faces = _detect_faces_with_yunet(
        image,
        model_path=yunet_model_path,
        score_threshold=yunet_score_threshold,
        min_face_size_px=min_face_size_px,
    )
    if yunet_faces:
        # YuNet is the primary detector when its optional model is available.
        # Do not mix in noisier Haar boxes: a large profile false positive can
        # otherwise eclipse a high-confidence DNN face during deduplication and
        # incorrectly trigger split-screen mode.
        return _deduplicate_faces(yunet_faces)

    detections_with_scores: list[dict[str, Any]] = []

    for variant_index, (variant_image, variant_scale_factor, variant_min_neighbors, variant_min_face_size) in enumerate(
        _build_detection_variants(
            grayscale=grayscale,
            min_face_size_px=min_face_size_px,
            scale_factor=scale_factor,
            min_neighbors=min_neighbors,
        )
    ):
        detector_inputs: list[tuple[Any, Any, bool, str]] = [
            (frontal_classifier, variant_image, False, "frontal"),
        ]
        if not profile_classifier.empty():
            detector_inputs.extend(
                [
                    (profile_classifier, variant_image, False, "profile"),
                    (profile_classifier, cv2.flip(variant_image, 1), True, "profile_mirrored"),
                ]
            )

        for classifier, detector_image, mirrored, detector_name in detector_inputs:
            detections = classifier.detectMultiScale(
                detector_image,
                scaleFactor=variant_scale_factor,
                minNeighbors=variant_min_neighbors,
                minSize=(variant_min_face_size, variant_min_face_size),
            )

            for x, y, face_width, face_height in detections:
                resolved_x = width - int(x) - int(face_width) if mirrored else int(x)
                detections_with_scores.append(
                    _build_face_result(
                        x=resolved_x,
                        y=int(y),
                        width=int(face_width),
                        height=int(face_height),
                        image_width=width,
                        image_height=height,
                        detector_pass=variant_index + 1,
                        detector=detector_name,
                    )
                )

    detected_faces = _deduplicate_faces(detections_with_scores)
    if detected_faces or upper_body_classifier.empty():
        return detected_faces

    # Podcast cameras often keep a speaker close to the frame edge or in
    # profile, where Haar face cascades can miss them entirely. An inferred
    # head box from a stable upper-body detection is safer than falling back to
    # a blind center crop that can contain only the set wall or a speaker's arm.
    upper_bodies = upper_body_classifier.detectMultiScale(
        cv2.equalizeHist(grayscale),
        scaleFactor=1.06,
        minNeighbors=3,
        minSize=(max(54, int(width * 0.07)), max(54, int(height * 0.12))),
    )
    inferred_faces: list[dict[str, Any]] = []
    for body_x, body_y, body_width, body_height in upper_bodies:
        inferred_width = max(28, int(round(body_width * 0.46)))
        inferred_height = max(28, int(round(body_height * 0.34)))
        inferred_x = max(0, int(round(body_x + ((body_width - inferred_width) / 2))))
        inferred_y = max(0, int(round(body_y + (body_height * 0.02))))
        inferred_width = min(inferred_width, width - inferred_x)
        inferred_height = min(inferred_height, height - inferred_y)
        if inferred_width <= 0 or inferred_height <= 0:
            continue
        center_x = inferred_x + (inferred_width / 2)
        inferred_faces.append(
            {
                "x": inferred_x,
                "y": inferred_y,
                "width": inferred_width,
                "height": inferred_height,
                "center_x": round(float(center_x), 2),
                "center_x_ratio": round(float(center_x / max(width, 1)), 4),
                "area": int(inferred_width * inferred_height),
                "image_width": width,
                "image_height": height,
                "detector_pass": 1,
                "detector": "upperbody_inferred_head",
                "inferred": True,
            }
        )

    return _deduplicate_faces(inferred_faces)


def summarize_face_samples(samples: list[list[dict[str, Any]]]) -> dict[str, Any]:
    if not samples:
        return {
            "status": "no_samples",
            "sample_count": 0,
            "max_face_count": 0,
            "average_face_count": 0.0,
            "multi_face_sample_count": 0,
            "single_face_sample_count": 0,
            "valid_face_sample_count": 0,
            "single_face_anchor": "center",
            "single_face_anchor_ratio": 0.5,
            "supports_split_frame": False,
            "adaptive_panel_count": 1,
            "subject_anchor_ratios": [0.5],
            "split_layout_mode": "VERTICAL_STACK",
            "left_anchor_ratio": 0.28,
            "right_anchor_ratio": 0.72,
            "stable_multi_face_sample_count": 0,
            "split_confidence": 0.0,
            "split_decision_reason": "no_face_samples",
            "tracking_samples": [],
        }

    qualified_samples = [_qualify_face_candidates(sample) for sample in samples]
    face_counts = [len(sample) for sample in qualified_samples]
    max_face_count = max(face_counts, default=0)
    average_face_count = round(sum(face_counts) / len(face_counts), 2) if face_counts else 0.0
    multi_face_sample_count = sum(1 for count in face_counts if count >= 2)
    single_face_sample_count = sum(1 for count in face_counts if count == 1)
    valid_face_sample_count = sum(1 for count in face_counts if count > 0)

    dominant_face_centers = [
        float(sample[0]["center_x_ratio"])
        for sample in qualified_samples
        if sample and isinstance(sample[0].get("center_x_ratio"), (float, int))
    ]
    average_center = (
        round(sum(dominant_face_centers) / len(dominant_face_centers), 4) if dominant_face_centers else 0.5
    )

    if average_center <= 0.38:
        single_face_anchor = "left"
    elif average_center >= 0.62:
        single_face_anchor = "right"
    else:
        single_face_anchor = "center"

    left_right_split_samples = 0
    left_anchor_samples: list[float] = []
    right_anchor_samples: list[float] = []
    sample_anchor_pairs: list[dict[str, Any]] = []
    tracking_samples: list[dict[str, Any]] = []
    for sample_index, sample in enumerate(qualified_samples):
        dominant_face = sample[0] if sample else None
        dominant_anchor = (
            round(float(dominant_face["center_x_ratio"]), 4)
            if isinstance(dominant_face, dict)
            and isinstance(dominant_face.get("center_x_ratio"), (float, int))
            else None
        )
        tracking_samples.append(
            {
                "sample_index": sample_index,
                "anchor_ratio": dominant_anchor,
                "face_count": len(sample),
                "face_left_ratio": _face_edge_ratio(dominant_face, edge="left"),
                "face_right_ratio": _face_edge_ratio(dominant_face, edge="right"),
                "detection_source": dominant_face.get("detector") if isinstance(dominant_face, dict) else None,
            }
        )
        ordered_faces = sorted(
            (
                face
                for face in sample
                if isinstance(face.get("center_x_ratio"), (float, int))
            ),
            key=lambda face: float(face["center_x_ratio"]),
        )
        distinct_faces: list[dict[str, Any]] = []
        for face in ordered_faces:
            ratio = float(face["center_x_ratio"])
            if not distinct_faces or ratio - float(distinct_faces[-1]["center_x_ratio"]) >= 0.12:
                distinct_faces.append(face)
        distinct_faces = distinct_faces[:4]
        distinct_ratios = [float(face["center_x_ratio"]) for face in distinct_faces]
        sample_anchor_pairs.append(
            {
                "sample_index": sample_index,
                "face_count": len(distinct_ratios),
                "raw_face_count": len(distinct_ratios),
                "primary_anchor_ratio": round(distinct_ratios[0], 4) if distinct_ratios else None,
                "secondary_anchor_ratio": round(distinct_ratios[-1], 4) if distinct_ratios else None,
                "subject_anchor_ratios": [round(value, 4) for value in distinct_ratios],
                "subject_bounds_ratios": [
                    {
                        "left": _face_edge_ratio(face, edge="left"),
                        "right": _face_edge_ratio(face, edge="right"),
                    }
                    for face in distinct_faces
                ],
            }
        )

        if len(sample) < 2:
            continue
        ratios = distinct_ratios
        if len(ratios) < 2:
            continue
        # Two detections must be spatially distinct. This prevents multiple
        # detector passes over the same person from enabling split screen.
        if ratios[-1] - ratios[0] >= 0.20:
            left_right_split_samples += 1
            left_anchor_samples.append(ratios[0])
            right_anchor_samples.append(ratios[-1])

    left_anchor_ratio = round(sum(left_anchor_samples) / len(left_anchor_samples), 4) if left_anchor_samples else 0.28
    right_anchor_ratio = (
        round(sum(right_anchor_samples) / len(right_anchor_samples), 4) if right_anchor_samples else 0.72
    )

    sample_anchor_pairs = _confirm_temporal_split_samples(sample_anchor_pairs)
    left_right_split_samples = sum(
        1 for sample in sample_anchor_pairs if int(sample.get("face_count") or 0) >= 2
    )

    # Temporal confirmation already rejects isolated false positives. Requiring
    # a percentage of the whole clip would incorrectly suppress a short but
    # legitimate two-person exchange inside an otherwise single-speaker clip.
    required_multi_face_samples = 2
    supports_split_frame = left_right_split_samples >= required_multi_face_samples
    split_confidence = round(left_right_split_samples / max(len(samples), 1), 3)
    stable_panel_counts = {
        panel_count: sum(
            1
            for sample in sample_anchor_pairs
            if int(sample.get("face_count") or 0) >= panel_count
        )
        for panel_count in range(2, 5)
    }
    adaptive_panel_count = 1
    for panel_count in range(2, 5):
        if stable_panel_counts[panel_count] >= required_multi_face_samples:
            adaptive_panel_count = panel_count

    anchor_buckets: list[list[float]] = [[] for _ in range(adaptive_panel_count)]
    for sample in sample_anchor_pairs:
        anchors = sample.get("subject_anchor_ratios")
        if not isinstance(anchors, list) or len(anchors) < adaptive_panel_count:
            continue
        selected = _select_evenly_spaced_anchors(anchors, adaptive_panel_count)
        for index, anchor in enumerate(selected):
            anchor_buckets[index].append(float(anchor))
    subject_anchor_ratios = [
        round(sum(bucket) / len(bucket), 4)
        if bucket
        else round((index + 1) / (adaptive_panel_count + 1), 4)
        for index, bucket in enumerate(anchor_buckets)
    ]

    return {
        "status": "ready",
        "sample_count": len(samples),
        "max_face_count": max_face_count,
        "average_face_count": average_face_count,
        "multi_face_sample_count": multi_face_sample_count,
        "single_face_sample_count": single_face_sample_count,
        "valid_face_sample_count": valid_face_sample_count,
        "left_right_split_samples": left_right_split_samples,
        "single_face_anchor": single_face_anchor,
        "single_face_anchor_ratio": average_center,
        "supports_split_frame": supports_split_frame,
        "adaptive_panel_count": adaptive_panel_count,
        "stable_panel_counts": stable_panel_counts,
        "subject_anchor_ratios": subject_anchor_ratios,
        "stable_multi_face_sample_count": left_right_split_samples,
        "required_multi_face_sample_count": required_multi_face_samples,
        "split_confidence": split_confidence,
        "split_decision_reason": (
            "two_faces_stable"
            if supports_split_frame
            else "two_faces_transient"
            if left_right_split_samples > 0
            else "single_face_only"
        ),
        "split_layout_mode": "VERTICAL_STACK",
        "left_anchor_ratio": left_anchor_ratio,
        "right_anchor_ratio": right_anchor_ratio,
        "sample_anchor_pairs": sample_anchor_pairs,
        "tracking_samples": tracking_samples,
    }


def _qualify_face_candidates(sample: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reject tiny, malformed, and edge-clipped detections before framing."""
    qualified: list[dict[str, Any]] = []
    for face in sample:
        anchor = face.get("center_x_ratio")
        if not isinstance(anchor, (int, float)):
            continue
        anchor_ratio = float(anchor)
        if not 0.055 <= anchor_ratio <= 0.945:
            continue

        image_width = face.get("image_width")
        image_height = face.get("image_height")
        width = face.get("width")
        height = face.get("height")
        if all(isinstance(value, (int, float)) for value in (image_width, image_height, width, height)):
            image_area = max(1.0, float(image_width) * float(image_height))
            face_area_ratio = (float(width) * float(height)) / image_area
            aspect_ratio = float(width) / max(float(height), 1.0)
            if face_area_ratio < 0.003 or not 0.50 <= aspect_ratio <= 1.75:
                continue
            y = face.get("y")
            if isinstance(y, (int, float)):
                center_y_ratio = (float(y) + (float(height) / 2)) / max(float(image_height), 1.0)
                # Talking-head faces belong above the lower-third/subtitle zone.
                # Haar profile cascades otherwise classify captions and player
                # graphics near the bottom as an additional speaker.
                if not 0.055 <= center_y_ratio <= 0.70:
                    continue
        qualified.append(face)
    return qualified


def _confirm_temporal_split_samples(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Enable split only when neighbouring samples confirm the same subjects."""
    confirmed: list[dict[str, Any]] = []
    for index, source_sample in enumerate(samples):
        sample = dict(source_sample)
        anchors = sample.get("subject_anchor_ratios")
        raw_count = len(anchors) if isinstance(anchors, list) else 0
        split_count = 0
        if raw_count >= 2:
            neighbours = [
                samples[neighbour_index]
                for neighbour_index in (index - 1, index + 1)
                if 0 <= neighbour_index < len(samples)
            ]
            split_count = max(
                (
                    _matching_anchor_count(anchors, neighbour.get("subject_anchor_ratios"))
                    for neighbour in neighbours
                ),
                default=0,
            )
        sample["face_count"] = split_count if split_count >= 2 else min(1, raw_count)
        sample["split_qualified"] = split_count >= 2
        confirmed.append(sample)
    return confirmed


def _matching_anchor_count(current: list[Any], candidate: Any) -> int:
    if not isinstance(candidate, list) or len(current) < 2 or len(candidate) < 2:
        return 0
    count = min(4, len(current), len(candidate))
    current_selected = _select_evenly_spaced_anchors([float(value) for value in current], count)
    candidate_selected = _select_evenly_spaced_anchors([float(value) for value in candidate], count)
    return (
        count
        if all(abs(left - right) <= 0.14 for left, right in zip(current_selected, candidate_selected, strict=True))
        else 0
    )


def _select_evenly_spaced_anchors(anchors: list[float], count: int) -> list[float]:
    if count <= 1:
        return [anchors[len(anchors) // 2]] if anchors else [0.5]
    if len(anchors) <= count:
        return anchors[:count]
    last_index = len(anchors) - 1
    indexes = [round(index * last_index / (count - 1)) for index in range(count)]
    return [anchors[index] for index in indexes]


def build_active_face_tracking_samples(
    frame_paths: list[str | Path],
    samples: list[list[dict[str, Any]]],
    *,
    sample_offsets_seconds: list[float] | None = None,
    speech_windows: list[dict[str, Any]] | None = None,
    overlap_windows: list[dict[str, Any]] | None = None,
    conversation_windows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Select the visually active face using lower-face motion.

    This is the local fallback when transcription has no diarization labels.
    Comparing mouth motion against upper-face motion reduces false switches
    caused by camera movement, while a short hysteresis prevents crop flicker.
    """
    previous_grayscale: Any | None = None
    raw_samples: list[dict[str, Any]] = []
    resolved_offsets = sample_offsets_seconds or []
    resolved_speech_windows = speech_windows or []
    resolved_overlap_windows = overlap_windows or []
    resolved_conversation_windows = conversation_windows or []
    scoring_anchor: float | None = None
    scoring_anchor_since = 0.0

    for sample_index, frame_path in enumerate(frame_paths):
        offset_seconds = (
            float(resolved_offsets[sample_index])
            if sample_index < len(resolved_offsets)
            else sample_index * 0.33
        )
        speech_active = (
            _window_is_active(resolved_speech_windows, offset_seconds)
            if resolved_speech_windows
            else True
        )
        overlapping_speakers = _active_overlap_speaker_count(
            resolved_overlap_windows,
            offset_seconds,
        )
        conversation_active = _window_is_active(resolved_conversation_windows, offset_seconds)
        faces = _qualify_face_candidates(samples[sample_index]) if sample_index < len(samples) else []
        image = cv2.imread(str(frame_path)) if Path(frame_path).exists() else None
        grayscale = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image is not None else None
        content_density_score = _content_density_score(grayscale) if grayscale is not None else 0.0
        candidates: list[dict[str, float]] = []

        if grayscale is not None:
            for face in faces:
                anchor = face.get("center_x_ratio")
                if not isinstance(anchor, (int, float)):
                    continue
                candidates.append(
                    {
                        "anchor_ratio": min(1.0, max(0.0, float(anchor))),
                        "face_left_ratio": min(
                            1.0,
                            max(0.0, float(face.get("x", 0)) / max(grayscale.shape[1], 1)),
                        ),
                        "face_right_ratio": min(
                            1.0,
                            max(
                                0.0,
                                float(face.get("x", 0) + face.get("width", 0)) / max(grayscale.shape[1], 1),
                            ),
                        ),
                        "motion_score": _lower_face_motion_score(
                            previous_grayscale=previous_grayscale,
                            current_grayscale=grayscale,
                            face=face,
                        ),
                        "visibility_score": _face_visibility_score(
                            face=face,
                            image_width=grayscale.shape[1],
                            image_height=grayscale.shape[0],
                        ),
                    }
                )

        for candidate in candidates:
            same_scoring_subject = (
                scoring_anchor is not None
                and abs(candidate["anchor_ratio"] - scoring_anchor) <= 0.14
            )
            speaking_duration = (
                max(0.0, offset_seconds - scoring_anchor_since)
                if same_scoring_subject
                else 0.0
            )
            rapid_switch_penalty = (
                1.2
                if scoring_anchor is not None
                and not same_scoring_subject
                and offset_seconds - scoring_anchor_since < 0.9
                else 0.0
            )
            candidate["voice_activity_score"] = 2.0 if speech_active else 0.0
            candidate["lip_movement_score"] = min(4.0, candidate["motion_score"] * 0.7)
            candidate["speaking_duration_score"] = min(1.0, speaking_duration / 1.0)
            candidate["conversation_context_score"] = 0.4 if conversation_active else 0.0
            candidate["rapid_switch_penalty"] = rapid_switch_penalty
            candidate["speaker_score"] = (
                candidate["voice_activity_score"]
                + candidate["lip_movement_score"]
                + candidate["visibility_score"]
                + candidate["speaking_duration_score"]
                + candidate["conversation_context_score"]
                - candidate["rapid_switch_penalty"]
            )
        candidates.sort(key=lambda item: item["speaker_score"], reverse=True)
        strongest = candidates[0] if candidates else None
        if strongest is not None:
            strongest_anchor = float(strongest["anchor_ratio"])
            if scoring_anchor is None:
                scoring_anchor = strongest_anchor
                scoring_anchor_since = offset_seconds
            elif abs(strongest_anchor - scoring_anchor) > 0.14:
                runner_up_speaker_score = candidates[1]["speaker_score"] if len(candidates) > 1 else 0.0
                if strongest["speaker_score"] - runner_up_speaker_score >= 0.4:
                    scoring_anchor = strongest_anchor
                    scoring_anchor_since = offset_seconds
        runner_up_score = candidates[1]["motion_score"] if len(candidates) > 1 else 0.0
        strongest_score = strongest["motion_score"] if strongest else 0.0
        confidence = (
            min(1.0, max(0.0, (strongest_score - runner_up_score) / max(strongest_score, 1.0)))
            if strongest
            else 0.0
        )
        active_subjects: list[dict[str, float]] = []
        if strongest is not None and (speech_active or not resolved_speech_windows):
            # Mouth motion associates an active voice with a visible face. It
            # must never invent additional voices from reactions or gestures.
            active_subjects.append(strongest)
            if overlapping_speakers >= 2 and strongest_score >= 1.5:
                for candidate in candidates[1 : min(4, overlapping_speakers)]:
                    if candidate["motion_score"] < 1.5:
                        continue
                    if candidate["motion_score"] < strongest_score * 0.55:
                        continue
                    if any(
                        abs(candidate["anchor_ratio"] - selected["anchor_ratio"]) < 0.14
                        for selected in active_subjects
                    ):
                        continue
                    active_subjects.append(candidate)
        active_subjects.sort(key=lambda item: item["anchor_ratio"])
        raw_samples.append(
            {
                "sample_index": sample_index,
                "offset_seconds": round(offset_seconds, 3),
                "anchor_ratio": strongest["anchor_ratio"] if strongest else None,
                "face_left_ratio": strongest["face_left_ratio"] if strongest else None,
                "face_right_ratio": strongest["face_right_ratio"] if strongest else None,
                "face_count": len(faces),
                "motion_score": round(strongest_score, 3),
                "motion_confidence": round(confidence, 3),
                "speaker_score": round(float(strongest.get("speaker_score") or 0.0), 3) if strongest else 0.0,
                "speaker_score_components": (
                    {
                        "voice_activity": round(float(strongest["voice_activity_score"]), 3),
                        "lip_movement": round(float(strongest["lip_movement_score"]), 3),
                        "face_visibility": round(float(strongest["visibility_score"]), 3),
                        "speaking_duration": round(float(strongest["speaking_duration_score"]), 3),
                        "conversation_context": round(float(strongest["conversation_context_score"]), 3),
                        "rapid_switch_penalty": round(float(strongest["rapid_switch_penalty"]), 3),
                    }
                    if strongest
                    else {}
                ),
                "speech_active": speech_active,
                "voice_overlap_count": overlapping_speakers,
                "active_speaker_count": len(active_subjects),
                "active_subject_anchor_ratios": [
                    round(subject["anchor_ratio"], 4) for subject in active_subjects
                ],
                "active_subject_bounds_ratios": [
                    {
                        "left": round(subject["face_left_ratio"], 4),
                        "right": round(subject["face_right_ratio"], 4),
                    }
                    for subject in active_subjects
                ],
                "visible_subject_anchor_ratios": [
                    round(subject["anchor_ratio"], 4)
                    for subject in sorted(candidates, key=lambda item: item["anchor_ratio"])
                ],
                "visible_subject_bounds_ratios": [
                    {
                        "left": round(subject["face_left_ratio"], 4),
                        "right": round(subject["face_right_ratio"], 4),
                    }
                    for subject in sorted(candidates, key=lambda item: item["anchor_ratio"])
                ],
                "visible_subject_motion_scores": [
                    round(subject["motion_score"], 3)
                    for subject in sorted(candidates, key=lambda item: item["anchor_ratio"])
                ],
                "content_density_score": round(content_density_score, 4),
                "content_frame_candidate": len(faces) == 0 and content_density_score >= 0.08,
            }
        )
        if grayscale is not None:
            previous_grayscale = grayscale

    stabilized = _stabilize_active_face_samples(raw_samples)
    stabilized = _annotate_conversation_layout_samples(
        stabilized,
        conversation_windows=resolved_conversation_windows,
    )
    return _apply_active_tracking_quality_gate(stabilized)


def _face_visibility_score(
    *,
    face: dict[str, Any],
    image_width: int,
    image_height: int,
) -> float:
    width = max(0.0, float(face.get("width") or 0.0))
    height = max(0.0, float(face.get("height") or 0.0))
    area_ratio = (width * height) / max(float(image_width * image_height), 1.0)
    left = float(face.get("x") or 0.0) / max(float(image_width), 1.0)
    right = (float(face.get("x") or 0.0) + width) / max(float(image_width), 1.0)
    edge_penalty = 1.0 if left <= 0.01 or right >= 0.99 else 0.0
    detector_confidence = min(1.0, max(0.0, float(face.get("confidence") or 0.5)))
    return max(0.0, min(2.0, (area_ratio * 8.0) + detector_confidence - edge_penalty))


def _content_density_score(grayscale: Any) -> float:
    """Estimate whether a face-free frame contains text or shared content.

    Dense horizontal edge bands are common in slides, screen shares, and
    document footage. This signal is deliberately ignored whenever a reliable
    face is present so normal studio backgrounds cannot steal the crop.
    """
    if grayscale is None or getattr(grayscale, "size", 0) == 0:
        return 0.0
    edges = cv2.Canny(grayscale, 70, 160)
    edge_ratio = float(cv2.countNonZero(edges)) / max(float(edges.size), 1.0)
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 2))
    horizontal_bands = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, horizontal_kernel)
    band_ratio = float(cv2.countNonZero(horizontal_bands)) / max(float(horizontal_bands.size), 1.0)
    return min(1.0, (edge_ratio * 2.4) + (band_ratio * 1.2))


def _annotate_conversation_layout_samples(
    samples: list[dict[str, Any]],
    *,
    conversation_windows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Mark short, trustworthy multi-speaker layout windows.

    A second visible face never enables split screen by itself. Split becomes
    eligible only after diarization reports a fast exchange or visual mouth
    tracking confirms a stable speaker change. A strong listener reaction may
    briefly use the two-person layout, but is capped at 1.2 seconds.
    """
    if not samples:
        return samples

    visual_windows: list[tuple[float, float]] = []
    previous_anchor: float | None = None
    previous_switch_seconds = 0.0
    for sample in samples:
        anchor = sample.get("anchor_ratio")
        offset = float(sample.get("offset_seconds") or 0.0)
        source = str(sample.get("selection_source") or "")
        if not isinstance(anchor, (int, float)):
            continue
        normalized_anchor = float(anchor)
        if previous_anchor is None:
            previous_anchor = normalized_anchor
            previous_switch_seconds = offset
            continue
        if abs(normalized_anchor - previous_anchor) < 0.18:
            continue
        previous_turn_duration = offset - previous_switch_seconds
        if source in {"strong_mouth_motion", "confirmed_mouth_motion"} and previous_turn_duration >= 0.7:
            visual_windows.append((max(0.0, offset - 0.9), offset + 1.5))
            previous_switch_seconds = offset
            previous_anchor = normalized_anchor

    reaction_until = -1.0
    for sample in samples:
        offset = float(sample.get("offset_seconds") or 0.0)
        visible_anchors = sample.get("visible_subject_anchor_ratios")
        visible_bounds = sample.get("visible_subject_bounds_ratios")
        motion_scores = sample.get("visible_subject_motion_scores")
        current_anchor = sample.get("anchor_ratio")
        if not isinstance(visible_anchors, list) or len(visible_anchors) < 2:
            continue

        explicit_conversation = _window_is_active(conversation_windows, offset)
        visual_conversation = any(start <= offset <= end for start, end in visual_windows)
        reaction_active = offset <= reaction_until
        if (
            not explicit_conversation
            and not visual_conversation
            and isinstance(motion_scores, list)
            and isinstance(current_anchor, (int, float))
        ):
            alternate_motion = max(
                (
                    float(score)
                    for anchor, score in zip(visible_anchors, motion_scores, strict=False)
                    if isinstance(anchor, (int, float))
                    and isinstance(score, (int, float))
                    and abs(float(anchor) - float(current_anchor)) >= 0.18
                ),
                default=0.0,
            )
            if alternate_motion >= 4.0:
                reaction_until = offset + 1.2
                reaction_active = True

        if not (explicit_conversation or visual_conversation or reaction_active):
            continue

        selected_anchors = _select_evenly_spaced_anchors(
            [float(value) for value in visible_anchors if isinstance(value, (int, float))],
            min(2, len(visible_anchors)),
        )
        if len(selected_anchors) < 2:
            continue
        sample["active_subject_anchor_ratios"] = [round(value, 4) for value in selected_anchors]
        sample["active_subject_bounds_ratios"] = (
            visible_bounds[: len(selected_anchors)] if isinstance(visible_bounds, list) else []
        )
        sample["active_speaker_count"] = len(selected_anchors)
        sample["conversation_layout"] = explicit_conversation or visual_conversation
        sample["reaction_layout"] = reaction_active and not (explicit_conversation or visual_conversation)

    return samples


def _window_is_active(windows: list[dict[str, Any]], offset_seconds: float) -> bool:
    return any(
        isinstance(window, dict)
        and isinstance(window.get("start_seconds"), (int, float))
        and isinstance(window.get("end_seconds"), (int, float))
        and float(window["start_seconds"]) <= offset_seconds <= float(window["end_seconds"])
        for window in windows
    )


def _active_overlap_speaker_count(windows: list[dict[str, Any]], offset_seconds: float) -> int:
    for window in windows:
        if not isinstance(window, dict):
            continue
        start = window.get("start_seconds")
        end = window.get("end_seconds")
        count = window.get("speaker_count")
        if (
            isinstance(start, (int, float))
            and isinstance(end, (int, float))
            and isinstance(count, int)
            and float(start) <= offset_seconds <= float(end)
        ):
            return min(4, max(0, count))
    return 0


def apply_active_speaker_tracking(
    summary: dict[str, Any],
    tracking_samples: list[dict[str, Any]],
) -> dict[str, Any]:
    """Project visual speech evidence onto the adaptive layout contract.

    Face count remains diagnostic only. Split-screen state is derived solely
    from stable active-speaker evidence, preventing a single visible speaker
    from being duplicated into multiple panels.
    """
    projected = dict(summary)
    active_pairs: list[dict[str, Any]] = []
    for index, sample in enumerate(tracking_samples):
        anchors = sample.get("active_subject_anchor_ratios")
        bounds = sample.get("active_subject_bounds_ratios")
        if not isinstance(anchors, list):
            anchor = sample.get("anchor_ratio")
            anchors = [float(anchor)] if isinstance(anchor, (int, float)) else []
        normalized_anchors = [
            round(min(1.0, max(0.0, float(anchor))), 4)
            for anchor in anchors[:4]
            if isinstance(anchor, (int, float))
        ]
        voice_overlap_count = int(sample.get("voice_overlap_count") or 0)
        multi_speaker_layout = bool(sample.get("conversation_layout") or sample.get("reaction_layout"))
        if voice_overlap_count < 2 and not multi_speaker_layout and len(normalized_anchors) > 1:
            normalized_anchors = normalized_anchors[:1]
        normalized_bounds = bounds[: len(normalized_anchors)] if isinstance(bounds, list) else []
        active_pairs.append(
            {
                "sample_index": index,
                "offset_seconds": sample.get("offset_seconds"),
                "voice_overlap_count": voice_overlap_count,
                "conversation_layout": bool(sample.get("conversation_layout")),
                "reaction_layout": bool(sample.get("reaction_layout")),
                "face_count": len(normalized_anchors),
                "raw_face_count": len(normalized_anchors),
                "active_speaker_count": len(normalized_anchors),
                "raw_active_speaker_count": len(normalized_anchors),
                "primary_anchor_ratio": normalized_anchors[0] if normalized_anchors else None,
                "secondary_anchor_ratio": normalized_anchors[-1] if normalized_anchors else None,
                "subject_anchor_ratios": normalized_anchors,
                "subject_bounds_ratios": normalized_bounds,
            }
        )

    active_pairs = _confirm_temporal_split_samples(active_pairs)
    for pair in active_pairs:
        confirmed_count = int(pair.get("face_count") or 0)
        pair["active_speaker_count"] = confirmed_count

    tracking_quality = next(
        (
            sample.get("tracking_quality")
            for sample in reversed(tracking_samples)
            if isinstance(sample.get("tracking_quality"), dict)
        ),
        {},
    )
    quality_allows_split = tracking_quality.get("passed") is not False
    stable_counts = {
        count: sum(1 for pair in active_pairs if int(pair.get("active_speaker_count") or 0) >= count)
        for count in range(2, 5)
    }
    if not quality_allows_split:
        stable_counts = {count: 0 for count in range(2, 5)}
    adaptive_panel_count = 1
    for count in range(2, 5):
        if stable_counts[count] >= 2:
            adaptive_panel_count = count

    anchor_buckets: list[list[float]] = [[] for _ in range(adaptive_panel_count)]
    for pair in active_pairs:
        anchors = pair.get("subject_anchor_ratios")
        if not isinstance(anchors, list) or len(anchors) < adaptive_panel_count:
            continue
        for bucket, anchor in zip(
            anchor_buckets,
            _select_evenly_spaced_anchors([float(value) for value in anchors], adaptive_panel_count),
            strict=True,
        ):
            bucket.append(anchor)

    stable_split_samples = sum(
        1 for pair in active_pairs if int(pair.get("active_speaker_count") or 0) >= 2
    )
    projected.update(
        {
            "active_face_tracking_samples": tracking_samples,
            "sample_anchor_pairs": active_pairs,
            "supports_split_frame": quality_allows_split and stable_split_samples >= 2,
            "adaptive_panel_count": adaptive_panel_count,
            "stable_panel_counts": stable_counts,
            "subject_anchor_ratios": [
                round(sum(bucket) / len(bucket), 4)
                if bucket
                else round((index + 1) / (adaptive_panel_count + 1), 4)
                for index, bucket in enumerate(anchor_buckets)
            ],
            "max_active_speaker_count": max(
                (int(pair.get("active_speaker_count") or 0) for pair in active_pairs),
                default=0,
            ),
            "active_speaker_sample_count": sum(
                1 for pair in active_pairs if int(pair.get("active_speaker_count") or 0) >= 1
            ),
            "simultaneous_active_speaker_sample_count": stable_split_samples,
            "split_confidence": round(stable_split_samples / max(len(active_pairs), 1), 3),
            "split_decision_reason": (
                "multiple_active_speakers_stable"
                if stable_split_samples >= 2
                else "single_active_speaker"
                if any(int(pair.get("active_speaker_count") or 0) == 1 for pair in active_pairs)
                else "no_active_speaker_evidence"
            ),
            "split_evidence_source": (
                "diarized_voice_overlap"
                if any(int(pair.get("voice_overlap_count") or 0) >= 2 for pair in active_pairs)
                else "speaker_turn_taking"
                if any(pair.get("conversation_layout") is True for pair in active_pairs)
                else "strong_reaction"
                if any(pair.get("reaction_layout") is True for pair in active_pairs)
                else "transcript_vad_face_association"
            ),
        }
    )
    return projected


def _face_edge_ratio(face: dict[str, Any] | None, *, edge: str) -> float | None:
    if not isinstance(face, dict):
        return None
    x = face.get("x")
    width = face.get("width")
    center_x = face.get("center_x")
    center_ratio = face.get("center_x_ratio")
    image_width_value = face.get("image_width")
    if not all(isinstance(value, (int, float)) for value in (x, width, center_x, center_ratio)):
        return None
    image_width = (
        float(image_width_value)
        if isinstance(image_width_value, (int, float)) and float(image_width_value) > 0
        else float(center_x) / max(float(center_ratio), 0.0001)
    )
    edge_x = float(x) if edge == "left" else float(x) + float(width)
    return round(min(1.0, max(0.0, edge_x / max(image_width, 1.0))), 4)


def _lower_face_motion_score(
    *,
    previous_grayscale: Any | None,
    current_grayscale: Any,
    face: dict[str, Any],
) -> float:
    if previous_grayscale is None or previous_grayscale.shape != current_grayscale.shape:
        return 0.0

    image_height, image_width = current_grayscale.shape[:2]
    x = max(0, int(face.get("x", 0)))
    y = max(0, int(face.get("y", 0)))
    width = max(1, int(face.get("width", 1)))
    height = max(1, int(face.get("height", 1)))
    left = min(image_width, x + int(width * 0.12))
    right = min(image_width, x + int(width * 0.88))
    mouth_top = min(image_height, y + int(height * 0.52))
    mouth_bottom = min(image_height, y + int(height * 1.02))
    upper_top = min(image_height, y + int(height * 0.12))
    upper_bottom = min(image_height, y + int(height * 0.48))
    if right <= left or mouth_bottom <= mouth_top or upper_bottom <= upper_top:
        return 0.0

    mouth_current = current_grayscale[mouth_top:mouth_bottom, left:right]
    mouth_previous = previous_grayscale[mouth_top:mouth_bottom, left:right]
    upper_current = current_grayscale[upper_top:upper_bottom, left:right]
    upper_previous = previous_grayscale[upper_top:upper_bottom, left:right]
    mouth_motion = float(cv2.mean(cv2.absdiff(mouth_current, mouth_previous))[0])
    upper_motion = float(cv2.mean(cv2.absdiff(upper_current, upper_previous))[0])
    return max(0.0, mouth_motion - (upper_motion * 0.62))


def _stabilize_active_face_samples(raw_samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    current_anchor: float | None = None
    current_left_ratio: float | None = None
    current_right_ratio: float | None = None
    pending_anchor: float | None = None
    pending_since: float | None = None
    last_switch_seconds = -10.0
    stabilized: list[dict[str, Any]] = []

    for sample in raw_samples:
        candidate = sample.get("anchor_ratio")
        face_count = int(sample.get("face_count") or 0)
        score = float(sample.get("motion_score") or 0.0)
        confidence = float(sample.get("motion_confidence") or 0.0)
        offset_seconds = float(sample.get("offset_seconds") or (len(stabilized) * 0.33))
        speech_active = sample.get("speech_active") is not False
        source = "hold"
        accepted_candidate = False

        if isinstance(candidate, (int, float)):
            candidate = min(1.0, max(0.0, float(candidate)))
            if current_anchor is None:
                initial_face_is_reliable = face_count == 1 or (
                    score >= 1.2 and confidence >= 0.08
                )
                if not speech_active or not initial_face_is_reliable:
                    stabilized.append(
                        {
                            **sample,
                            "anchor_ratio": None,
                            "face_left_ratio": None,
                            "face_right_ratio": None,
                            "active_subject_anchor_ratios": [],
                            "active_subject_bounds_ratios": [],
                            "active_speaker_count": 0,
                            "selection_source": (
                                "vad_silence"
                                if not speech_active
                                else "waiting_for_voice_face_association"
                            ),
                        }
                    )
                    continue
                current_anchor = candidate
                last_switch_seconds = offset_seconds
                source = "initial_face"
                accepted_candidate = True
            elif abs(candidate - current_anchor) <= 0.12:
                # Follow small head movement without treating it as a switch.
                current_anchor = (current_anchor * 0.72) + (candidate * 0.28)
                pending_anchor = None
                pending_since = None
                source = "same_active_face"
                accepted_candidate = True
            elif speech_active:
                hold_elapsed = offset_seconds - last_switch_seconds
                strong_switch = score >= 2.6 and confidence >= 0.28
                if strong_switch and hold_elapsed >= 0.9:
                    current_anchor = candidate
                    last_switch_seconds = offset_seconds
                    pending_anchor = None
                    pending_since = None
                    source = "strong_mouth_motion"
                    accepted_candidate = True
                else:
                    if pending_anchor is not None and abs(candidate - pending_anchor) <= 0.12:
                        pending_since = pending_since if pending_since is not None else offset_seconds
                    else:
                        pending_anchor = candidate
                        pending_since = offset_seconds
                    pending_elapsed = offset_seconds - float(pending_since)
                    if confidence >= 0.14 and hold_elapsed >= 0.9 and pending_elapsed >= 0.70:
                        current_anchor = candidate
                        last_switch_seconds = offset_seconds
                        pending_anchor = None
                        pending_since = None
                        source = "confirmed_mouth_motion"
                        accepted_candidate = True

        if accepted_candidate:
            candidate_left = sample.get("face_left_ratio")
            candidate_right = sample.get("face_right_ratio")
            if isinstance(candidate_left, (int, float)) and isinstance(candidate_right, (int, float)):
                current_left_ratio = min(1.0, max(0.0, float(candidate_left)))
                current_right_ratio = min(1.0, max(0.0, float(candidate_right)))

        stabilized.append(
            {
                **sample,
                "anchor_ratio": round(current_anchor, 4) if current_anchor is not None else None,
                "face_left_ratio": round(current_left_ratio, 4) if current_left_ratio is not None else None,
                "face_right_ratio": round(current_right_ratio, 4) if current_right_ratio is not None else None,
                "selection_source": source,
            }
        )

    # Face detection may miss the opening frames because of a cut, blur, or
    # profile pose. Backfill only from the first confirmed face so the crop is
    # stable from t=0 without ever using hand or full-frame motion as an anchor.
    first_face_sample = next(
        (
            sample
            for sample in stabilized
            if isinstance(sample.get("anchor_ratio"), (int, float))
        ),
        None,
    )
    if first_face_sample is not None:
        first_anchor = first_face_sample.get("anchor_ratio")
        first_left = first_face_sample.get("face_left_ratio")
        first_right = first_face_sample.get("face_right_ratio")
        for sample in stabilized:
            if isinstance(sample.get("anchor_ratio"), (int, float)):
                break
            sample["anchor_ratio"] = first_anchor
            sample["face_left_ratio"] = first_left
            sample["face_right_ratio"] = first_right
            sample["selection_source"] = "leading_face_backfill"

    return stabilized


def _apply_active_tracking_quality_gate(samples: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Annotate and suppress unsafe tracking states before FFmpeg rendering."""
    previous_anchor: float | None = None
    switch_count = 0
    edge_clipped_count = 0
    empty_count = 0
    for sample in samples:
        anchor = sample.get("anchor_ratio")
        left = sample.get("face_left_ratio")
        right = sample.get("face_right_ratio")
        if not isinstance(anchor, (int, float)):
            empty_count += 1
            continue
        if previous_anchor is not None and abs(float(anchor) - previous_anchor) >= 0.18:
            switch_count += 1
        previous_anchor = float(anchor)
        if (
            isinstance(left, (int, float))
            and isinstance(right, (int, float))
            and (float(left) <= 0.015 or float(right) >= 0.985)
        ):
            edge_clipped_count += 1

    duration_seconds = max(
        (float(sample.get("offset_seconds") or 0.0) for sample in samples),
        default=0.0,
    )
    maximum_switches = max(2, int(duration_seconds / 4.0) + 1)
    quality_passed = switch_count <= maximum_switches and edge_clipped_count == 0 and empty_count < len(samples)
    fallback_applied = False
    unsafe_tracking = (
        switch_count > maximum_switches
        or edge_clipped_count > 0
        or empty_count == len(samples)
    )
    if samples and unsafe_tracking:
        # Reject noisy, edge-clipped, or empty tracking rather than rendering
        # camera jumps or a partially visible subject. Prefer anchors whose
        # detected face bounds are safely inside the frame, then fall back to
        # all detected anchors or the center of the source.
        safe_anchors = [
            float(sample["anchor_ratio"])
            for sample in samples
            if isinstance(sample.get("anchor_ratio"), (int, float))
            and isinstance(sample.get("face_left_ratio"), (int, float))
            and isinstance(sample.get("face_right_ratio"), (int, float))
            and float(sample["face_left_ratio"]) > 0.015
            and float(sample["face_right_ratio"]) < 0.985
        ]
        anchors = safe_anchors or [
            float(sample["anchor_ratio"])
            for sample in samples
            if isinstance(sample.get("anchor_ratio"), (int, float))
        ]
        if anchors:
            buckets: dict[int, list[float]] = {}
            for anchor in anchors:
                buckets.setdefault(int(round(anchor / 0.12)), []).append(anchor)
            stable_bucket = max(buckets.values(), key=len)
            stable_anchor = sum(stable_bucket) / len(stable_bucket)
        else:
            stable_anchor = 0.5
        for sample in samples:
            sample["anchor_ratio"] = round(stable_anchor, 4)
            sample["face_left_ratio"] = None
            sample["face_right_ratio"] = None
            sample["active_subject_anchor_ratios"] = [round(stable_anchor, 4)]
            sample["active_subject_bounds_ratios"] = []
            sample["active_speaker_count"] = min(1, int(sample.get("active_speaker_count") or 0))
            sample["selection_source"] = "quality_gate_stable_anchor"
        fallback_applied = True
    for sample in samples:
        sample["tracking_quality"] = {
            "passed": quality_passed,
            "switch_count": switch_count,
            "maximum_switches": maximum_switches,
            "edge_clipped_sample_count": edge_clipped_count,
            "empty_sample_count": empty_count,
            "zoom_change_count": 0,
            "fallback_applied": fallback_applied,
        }
    return samples
