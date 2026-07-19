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
) -> list[dict[str, Any]]:
    """Select the visually active face using lower-face motion.

    This is the local fallback when transcription has no diarization labels.
    Comparing mouth motion against upper-face motion reduces false switches
    caused by camera movement, while a short hysteresis prevents crop flicker.
    """
    previous_grayscale: Any | None = None
    raw_samples: list[dict[str, Any]] = []

    for sample_index, frame_path in enumerate(frame_paths):
        faces = _qualify_face_candidates(samples[sample_index]) if sample_index < len(samples) else []
        image = cv2.imread(str(frame_path)) if Path(frame_path).exists() else None
        grayscale = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image is not None else None
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
                    }
                )

        candidates.sort(key=lambda item: item["motion_score"], reverse=True)
        strongest = candidates[0] if candidates else None
        runner_up_score = candidates[1]["motion_score"] if len(candidates) > 1 else 0.0
        strongest_score = strongest["motion_score"] if strongest else 0.0
        confidence = (
            min(1.0, max(0.0, (strongest_score - runner_up_score) / max(strongest_score, 1.0)))
            if strongest
            else 0.0
        )
        active_subjects: list[dict[str, float]] = []
        if strongest is not None:
            # A visible face is enough for a single-speaker crop, but never
            # enough to create extra panels. Additional panels require
            # independent, meaningful lower-face motion.
            active_subjects.append(strongest)
            if strongest_score >= 1.5:
                for candidate in candidates[1:4]:
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
                "anchor_ratio": strongest["anchor_ratio"] if strongest else None,
                "face_left_ratio": strongest["face_left_ratio"] if strongest else None,
                "face_right_ratio": strongest["face_right_ratio"] if strongest else None,
                "face_count": len(faces),
                "motion_score": round(strongest_score, 3),
                "motion_confidence": round(confidence, 3),
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
            }
        )
        if grayscale is not None:
            previous_grayscale = grayscale

    return _stabilize_active_face_samples(raw_samples)


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
        normalized_bounds = bounds[: len(normalized_anchors)] if isinstance(bounds, list) else []
        active_pairs.append(
            {
                "sample_index": index,
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

    stable_counts = {
        count: sum(1 for pair in active_pairs if int(pair.get("active_speaker_count") or 0) >= count)
        for count in range(2, 5)
    }
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
            "supports_split_frame": stable_split_samples >= 2,
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
            "split_evidence_source": "active_speaker_motion",
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
    pending_count = 0
    stabilized: list[dict[str, Any]] = []

    for sample in raw_samples:
        candidate = sample.get("anchor_ratio")
        face_count = int(sample.get("face_count") or 0)
        score = float(sample.get("motion_score") or 0.0)
        confidence = float(sample.get("motion_confidence") or 0.0)
        source = "hold"
        accepted_candidate = False

        if isinstance(candidate, (int, float)):
            candidate = min(1.0, max(0.0, float(candidate)))
            if current_anchor is None:
                current_anchor = candidate
                source = "initial_face"
                accepted_candidate = True
            elif face_count == 1:
                current_anchor = candidate
                pending_anchor = None
                pending_count = 0
                source = "single_visible_face"
                accepted_candidate = True
            elif abs(candidate - current_anchor) <= 0.12:
                current_anchor = candidate
                pending_anchor = None
                pending_count = 0
                source = "same_active_face"
                accepted_candidate = True
            else:
                strong_switch = score >= 2.2 and confidence >= 0.16
                if strong_switch:
                    current_anchor = candidate
                    pending_anchor = None
                    pending_count = 0
                    source = "strong_mouth_motion"
                    accepted_candidate = True
                else:
                    if pending_anchor is not None and abs(candidate - pending_anchor) <= 0.12:
                        pending_count += 1
                    else:
                        pending_anchor = candidate
                        pending_count = 1
                    if pending_count >= 2:
                        current_anchor = candidate
                        pending_anchor = None
                        pending_count = 0
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
