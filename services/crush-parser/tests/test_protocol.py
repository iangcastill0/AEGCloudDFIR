import tempfile
import unittest
from pathlib import Path

from app.protocol import clean_filename, configure_tempdir, parse_positive_header


class ProtocolTests(unittest.TestCase):
    def test_clean_filename_removes_paths_and_controls(self) -> None:
        self.assertEqual(clean_filename("../folder/ev\x00idence.json"), "evidence.json")

    def test_positive_header_rejects_zero_and_non_numbers(self) -> None:
        self.assertEqual(parse_positive_header("12", "X-Limit", 5), 12)
        with self.assertRaises(ValueError):
            parse_positive_header("0", "X-Limit", 5)
        with self.assertRaises(ValueError):
            parse_positive_header("many", "X-Limit", 5)

    def test_configure_tempdir_makes_scratch_the_python_temp_directory(self) -> None:
        previous = tempfile.tempdir
        try:
            with tempfile.TemporaryDirectory() as tmp:
                scratch = Path(tmp) / "scratch"
                configure_tempdir(scratch)
                self.assertEqual(tempfile.gettempdir(), str(scratch))
                with tempfile.NamedTemporaryFile() as created:
                    self.assertEqual(Path(created.name).parent, scratch)
        finally:
            tempfile.tempdir = previous


if __name__ == "__main__":
    unittest.main()
