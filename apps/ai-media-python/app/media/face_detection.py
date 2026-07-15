from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2


class FaceDetectionUnavailable(RuntimeError):
    """Raised when the current OpenCV build cannot run face detection."""


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
    overlap_threshold: float = 0.45,
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
) -> list[dict[str, Any]]:
    if not hasattr(cv2, "CascadeClassifier"):
        raise FaceDetectionUnavailable("OpenCV build does not expose CascadeClassifier")
    if not hasattr(cv2, "data") or not hasattr(cv2.data, "haarcascades"):
        raise FaceDetectionUnavailable("OpenCV Haar cascade data path is unavailable")

    classifier = cv2.CascadeClassifier(str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"))
    if classifier.empty():
        raise FaceDetectionUnavailable("OpenCV Haar cascade classifier could not be loaded")

    image = cv2.imread(str(image_path))
    if image is None:
        return []

    grayscale = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    height, width = grayscale.shape[:2]
    detections_with_scores: list[dict[str, Any]] = []

    for variant_index, (variant_image, variant_scale_factor, variant_min_neighbors, variant_min_face_size) in enumerate(
        _build_detection_variants(
            grayscale=grayscale,
            min_face_size_px=min_face_size_px,
            scale_factor=scale_factor,
            min_neighbors=min_neighbors,
        )
    ):
        detections = classifier.detectMultiScale(
            variant_image,
            scaleFactor=variant_scale_factor,
            minNeighbors=variant_min_neighbors,
            minSize=(variant_min_face_size, variant_min_face_size),
        )

        for x, y, face_width, face_height in detections:
            center_x = x + (face_width / 2)
            detections_with_scores.append(
                {
                    "x": int(x),
                    "y": int(y),
                    "width": int(face_width),
                    "height": int(face_height),
                    "center_x": round(float(center_x), 2),
                    "center_x_ratio": round(float(center_x / max(width, 1)), 4),
                    "area": int(face_width * face_height),
                    "detector_pass": variant_index + 1,
                }
            )

    return _deduplicate_faces(detections_with_scores)


def summarize_face_samples(samples: list[list[dict[str, Any]]]) -> dict[str, Any]:
    if not samples:
        return {
            "status": "no_samples",
            "sample_count": 0,
            "max_face_count": 0,
            "average_face_count": 0.0,
            "multi_face_sample_count": 0,
            "single_face_sample_count": 0,
            "single_face_anchor": "center",
            "supports_split_frame": False,
            "left_anchor_ratio": 0.28,
            "right_anchor_ratio": 0.72,
        }

    face_counts = [len(sample) for sample in samples]
    max_face_count = max(face_counts, default=0)
    average_face_count = round(sum(face_counts) / len(face_counts), 2) if face_counts else 0.0
    multi_face_sample_count = sum(1 for count in face_counts if count >= 2)
    single_face_sample_count = sum(1 for count in face_counts if count == 1)

    dominant_face_centers = [
        float(sample[0]["center_x_ratio"])
        for sample in samples
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
    for sample in samples:
        if len(sample) < 2:
            continue
        ratios = sorted(
            float(face.get("center_x_ratio", 0.5))
            for face in sample[:3]
            if isinstance(face.get("center_x_ratio"), (float, int))
        )
        if len(ratios) < 2:
            continue
        left_present = any(ratio <= 0.42 for ratio in ratios)
        right_present = any(ratio >= 0.58 for ratio in ratios)
        if left_present and right_present:
            left_right_split_samples += 1
            left_anchor_samples.append(ratios[0])
            right_anchor_samples.append(ratios[-1])

    left_anchor_ratio = round(sum(left_anchor_samples) / len(left_anchor_samples), 4) if left_anchor_samples else 0.28
    right_anchor_ratio = (
        round(sum(right_anchor_samples) / len(right_anchor_samples), 4) if right_anchor_samples else 0.72
    )

    return {
        "status": "ready",
        "sample_count": len(samples),
        "max_face_count": max_face_count,
        "average_face_count": average_face_count,
        "multi_face_sample_count": multi_face_sample_count,
        "single_face_sample_count": single_face_sample_count,
        "left_right_split_samples": left_right_split_samples,
        "single_face_anchor": single_face_anchor,
        "supports_split_frame": left_right_split_samples >= max(1, len(samples) // 3) and multi_face_sample_count >= 2,
        "left_anchor_ratio": left_anchor_ratio,
        "right_anchor_ratio": right_anchor_ratio,
    }
