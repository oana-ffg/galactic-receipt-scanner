import cv2
import numpy as np
import pytest


class NoHands:
    def polygons(self, _image):
        return []

    def close(self):
        pass


@pytest.fixture
def receipt_image():
    image = np.full((2400, 2000, 3), 25, np.uint8)
    cv2.rectangle(image, (380, 180), (1620, 2220), (244, 244, 244), -1)
    lines = [
        "SYNTHETIC TEST RECEIPT",
        "2026-09-11",
        "Food         125.50",
        "Litter        74.50",
        "TOTAL        200.00",
        "TEST DATA ONLY",
    ]
    for i, line in enumerate(lines):
        cv2.putText(
            image,
            line,
            (445, 410 + i * 235),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.8,
            (20, 20, 20),
            4,
            cv2.LINE_AA,
        )
    return image


@pytest.fixture
def receipt_bytes(receipt_image):
    return cv2.imencode(".jpg", receipt_image, [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
