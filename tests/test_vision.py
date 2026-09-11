import cv2
import numpy as np

from server.vision import Detector, crop_document, decode_image
from tests.conftest import NoHands


def test_clear_receipt_and_lossless_original_decode(receipt_image, receipt_bytes, tmp_path):
    detector = Detector(tmp_path, hands=NoHands())
    result = detector.analyze(receipt_image, full_resolution=True)
    assert result["ok"], result
    crop = crop_document(receipt_image, result["quad"])
    assert min(crop.shape[:2]) > 1200
    decoded, extension = decode_image(receipt_bytes)
    assert extension == "jpg" and decoded.shape == receipt_image.shape


def test_empty_dark_desk_is_removal(tmp_path):
    detector = Detector(tmp_path, hands=NoHands())
    result = detector.analyze(np.full((600, 800, 3), 25, np.uint8))
    assert result["empty"] and not result["ok"]


def test_clipping_is_rejected(receipt_image, tmp_path):
    detector = Detector(tmp_path, hands=NoHands())
    result = detector.analyze(receipt_image[180:2220, 380:1620])
    assert not result["ok"]
    assert "frame edge" in result["reason"]


def test_blur_and_small_stills_rejected(receipt_image, tmp_path):
    detector = Detector(tmp_path, hands=NoHands())
    blurred = cv2.GaussianBlur(receipt_image, (101, 101), 30)
    assert not detector.analyze(blurred, full_resolution=True)["ok"]
    small = cv2.resize(receipt_image, (800, 960))
    result = detector.analyze(small, full_resolution=True)
    assert not result["ok"] and "900 pixels" in result["reason"]


def test_hand_overlap_rejected_but_off_paper_hand_allowed(receipt_image, tmp_path):
    class Hands(NoHands):
        def polygons(self, image):
            h, w = image.shape[:2]
            return [
                np.float32(
                    [
                        [[w * 0.3, h * 0.3]],
                        [[w * 0.6, h * 0.3]],
                        [[w * 0.6, h * 0.6]],
                        [[w * 0.3, h * 0.6]],
                    ]
                )
            ]

    detector = Detector(tmp_path, hands=Hands())
    result = detector.analyze(receipt_image)
    assert not result["ok"] and "fingers" in result["reason"]

    class OffPaper(NoHands):
        def polygons(self, image):
            h, w = image.shape[:2]
            return [np.float32([[[0, 0]], [[w * 0.1, 0]], [[w * 0.1, h * 0.1]], [[0, h * 0.1]]])]

    detector = Detector(tmp_path, hands=OffPaper())
    assert detector.analyze(receipt_image)["ok"]
