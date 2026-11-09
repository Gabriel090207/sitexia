"""Pure tests: no Firebase, provider, credentials or financial mutations."""
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.face_swap_pricing import (
    InvalidFaceSwapMetadata,
    calculate_face_swap_price,
)


class FaceSwapPricingTests(unittest.TestCase):
    def test_image_price_exactly_matches_existing_float(self):
        for duration in (None, 0, 0.0):
            price = calculate_face_swap_price({"materialType": "IMAGE", "duration": duration})
            self.assertIsInstance(price, float)
            self.assertEqual(price, 0.1)
        self.assertEqual(calculate_face_swap_price({"materialType": "IMAGE"}), 0.1)

    def test_video_tiers_preserve_prices(self):
        for duration, expected in ((1, 1), (15, 1), (16, 2), (30, 2), (31, 3), (45, 3)):
            with self.subTest(duration=duration):
                price = calculate_face_swap_price({"materialType": "VIDEO", "duration": duration})
                self.assertIsInstance(price, int)
                self.assertEqual(price, expected)

    def test_fractional_seconds_without_truncation(self):
        for duration, expected in ((0.1, 1), (14.9, 1), (15.01, 2), (30.01, 3),
                                   (math.nextafter(15.0, math.inf), 2), (5e-324, 1)):
            self.assertEqual(calculate_face_swap_price({"materialType": "VIDEO", "duration": duration}), expected)

    def test_invalid_video_durations(self):
        for duration in (None, 0, -1, -0.1, "15", "invalid", True, False,
                         math.inf, -math.inf, math.nan, [], {}):
            with self.subTest(duration=duration), self.assertRaises(InvalidFaceSwapMetadata):
                calculate_face_swap_price({"materialType": "VIDEO", "duration": duration})
        with self.assertRaises(InvalidFaceSwapMetadata):
            calculate_face_swap_price({"materialType": "VIDEO"})

    def test_unknown_types_including_gif_are_not_classified(self):
        for material_type in (None, "GIF", "image", "video", "OTHER", True, []):
            with self.subTest(material_type=material_type), self.assertRaises(InvalidFaceSwapMetadata):
                calculate_face_swap_price({"materialType": material_type, "duration": 15})

    def test_inconsistent_image_metadata(self):
        for duration in (1, -1, True, False, "0", math.nan, math.inf):
            with self.subTest(duration=duration), self.assertRaises(InvalidFaceSwapMetadata):
                calculate_face_swap_price({"materialType": "IMAGE", "duration": duration})

    def test_invalid_material_response(self):
        for material in (None, [], "IMAGE", {}, 1):
            with self.assertRaises(InvalidFaceSwapMetadata):
                calculate_face_swap_price(material)

    def test_client_classification_and_duration_are_ignored(self):
        material = {"materialType": "VIDEO", "duration": 31,
                    "media_type": "image", "video_duration": 1}
        original = dict(material)
        self.assertEqual(calculate_face_swap_price(material), 3)
        self.assertEqual(material, original)


if __name__ == "__main__":
    unittest.main()
