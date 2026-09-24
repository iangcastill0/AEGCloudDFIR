import unittest

from app.protocol import clean_filename, parse_positive_header


class ProtocolTests(unittest.TestCase):
    def test_clean_filename_removes_paths_and_controls(self) -> None:
        self.assertEqual(clean_filename("../folder/ev\x00idence.json"), "evidence.json")

    def test_positive_header_rejects_zero_and_non_numbers(self) -> None:
        self.assertEqual(parse_positive_header("12", "X-Limit", 5), 12)
        with self.assertRaises(ValueError):
            parse_positive_header("0", "X-Limit", 5)
        with self.assertRaises(ValueError):
            parse_positive_header("many", "X-Limit", 5)


if __name__ == "__main__":
    unittest.main()
