"""Conservative paper/hand/focus gates; never reconstruct document content."""

import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 55_000_000


def decode_image(data: bytes) -> tuple[np.ndarray, str]:
    with Image.open(io.BytesIO(data)) as source:
        if source.format not in {"JPEG", "PNG", "WEBP"}:
            raise ValueError("Unsupported camera format. Use JPEG, PNG or WebP.")
        if source.width * source.height > 55_000_000 or min(source.size) < 100:
            raise ValueError("Image dimensions are outside the supported range.")
        extension = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}[source.format]
        image = np.asarray(ImageOps.exif_transpose(source).convert("RGB"))
        return cv2.cvtColor(image, cv2.COLOR_RGB2BGR), extension


def ordered_quad(points: np.ndarray) -> np.ndarray:
    points = points.reshape(4, 2).astype(np.float32)
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    points = points[np.argsort(angles)]
    return np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)


def crop_document(image: np.ndarray, quad: list[list[float]]) -> np.ndarray:
    height, width = image.shape[:2]
    points = ordered_quad(np.array(quad) * [width, height])
    # Expand outward around the centre to retain the entire paper boundary.
    points = points.mean(axis=0) + (points - points.mean(axis=0)) * 1.025
    top, right, bottom, left = [np.linalg.norm(points[(i + 1) % 4] - points[i]) for i in range(4)]
    output_width, output_height = round(max(top, bottom)), round(max(left, right))
    target = np.float32(
        [
            [0, 0],
            [output_width - 1, 0],
            [output_width - 1, output_height - 1],
            [0, output_height - 1],
        ]
    )
    matrix = cv2.getPerspectiveTransform(points.astype(np.float32), target)
    return cv2.warpPerspective(
        image,
        matrix,
        (output_width, output_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


class Detector:
    def __init__(self, model_path: Path, *, hands=None):
        if hands is not None:
            self.hands = hands
        else:
            import mediapipe as mp

            self.mp = mp
            self.hands = mp.tasks.vision.HandLandmarker.create_from_options(
                mp.tasks.vision.HandLandmarkerOptions(
                    base_options=mp.tasks.BaseOptions(
                        model_asset_path=str(model_path),
                        delegate=mp.tasks.BaseOptions.Delegate.CPU,
                    ),
                    running_mode=mp.tasks.vision.RunningMode.IMAGE,
                    num_hands=2,
                    min_hand_detection_confidence=0.35,
                    min_hand_presence_confidence=0.35,
                )
            )
        self.previous: np.ndarray | None = None

    def close(self) -> None:
        self.hands.close()

    def hand_polygons(self, image: np.ndarray) -> list[np.ndarray]:
        if hasattr(self.hands, "polygons"):
            return self.hands.polygons(image)
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        result = self.hands.detect(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb))
        height, width = image.shape[:2]
        return [
            cv2.convexHull(np.float32([[p.x * width, p.y * height] for p in hand]))
            for hand in result.hand_landmarks
        ]

    def analyze(self, image: np.ndarray, *, full_resolution: bool = False) -> dict:
        height, width = image.shape[:2]
        scale = min(1.0, 800 / max(height, width))
        small = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        sh, sw = small.shape[:2]
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        smoothed = cv2.GaussianBlur(gray, (5, 5), 0)
        motion_image = cv2.resize(smoothed, (160, 120))
        motion = 0.0
        if not full_resolution:
            if self.previous is not None:
                motion = float(cv2.absdiff(self.previous, motion_image).mean())
            self.previous = motion_image

        hands = self.hand_polygons(small)
        base = {
            "ok": False,
            "empty": False,
            "quad": None,
            "hands": [(p.reshape(-1, 2) / [sw, sh]).tolist() for p in hands],
            "motion": round(motion, 2),
            "reason": "Place one receipt on a dark, matte background.",
        }
        # Thresholding assumes light paper against a darker desk/mat, stated in the UI.
        threshold, _ = cv2.threshold(smoothed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        _, mask = cv2.threshold(smoothed, max(100, threshold), 255, cv2.THRESH_BINARY)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = []
        large_shapes = False
        for contour in contours:
            area = cv2.contourArea(contour) / (sw * sh)
            if area < 0.025:
                continue
            large_shapes = True
            perimeter = cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, 0.025 * perimeter, True)
            if len(approx) != 4 or not cv2.isContourConvex(approx):
                continue
            candidates.append((area, ordered_quad(approx)))
        if not candidates:
            base["empty"] = not hands and not large_shapes and motion < 2.0
            if hands:
                base["reason"] = "Move your hands away from the receipt."
            elif large_shapes:
                base["reason"] = "Cannot see all four paper edges. Flatten it on a dark background."
            return base
        candidates.sort(key=lambda item: item[0], reverse=True)
        area, points = candidates[0]
        base["quad"] = (points / [sw, sh]).tolist()
        if len(candidates) > 1 and candidates[1][0] > 0.05:
            base["reason"] = "More than one paper region detected. Keep one receipt in view."
            return base
        if area > 0.90 or any(
            p[0] < 5 or p[1] < 5 or p[0] > sw - 6 or p[1] > sh - 6 for p in points
        ):
            base["reason"] = "Paper is too close to the frame edge. Leave a visible margin."
            return base
        for hand in hands:
            center = hand.mean(axis=0)
            expanded = center + (hand - center) * 1.25
            overlap, _ = cv2.intersectConvexConvex(points, expanded.astype(np.float32))
            if overlap > 0:
                base["reason"] = "Hand or fingers overlap the receipt. Move them clear."
                return base
        cropped = crop_document(small, base["quad"])
        cg = cv2.cvtColor(cropped, cv2.COLOR_BGR2GRAY)
        inset = max(3, round(min(cg.shape) * 0.05))
        interior = cg[inset:-inset, inset:-inset]
        if interior.size == 0:
            base["reason"] = "Receipt is too small in the frame."
            return base
        focus = float(cv2.Laplacian(interior, cv2.CV_64F).var())
        contrast = float(np.percentile(interior, 90) - np.percentile(interior, 5))
        ink = float((interior < np.percentile(interior, 90) - 45).mean())
        base.update(focus=round(focus, 1), contrast=round(contrast, 1))
        if ink < 0.004:
            base["reason"] = "No clear print detected. Check the printed side and lighting."
            return base
        if focus < 65:
            base["reason"] = "Print looks blurred. Wait for focus or adjust the phone height."
            return base
        if float(np.percentile(interior, 80)) < 90:
            base["reason"] = "Receipt is too dark. Add even lighting."
            return base
        if full_resolution:
            native = crop_document(image, base["quad"])
            base["receiptPixels"] = [int(native.shape[1]), int(native.shape[0])]
            if min(native.shape[:2]) < 900:
                base["reason"] = (
                    "Saved receipt is under 900 pixels wide. "
                    "Move closer or raise capture resolution."
                )
                return base
        if motion > 3.5 and not full_resolution:
            base["reason"] = "Movement detected. Let the receipt and camera settle."
            return base
        base["ok"], base["reason"] = True, "Receipt is clear and unobstructed."
        return base
