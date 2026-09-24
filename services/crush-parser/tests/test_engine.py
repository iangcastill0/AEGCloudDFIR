import io
import json
import sqlite3
import tarfile
import tempfile
import unittest
import zipfile
import gzip
import plistlib
from pathlib import Path

from app.engine import AnalysisLimits, LimitExceeded, analyze_to_bundle


class AnalyzeBundleTests(unittest.TestCase):
    def test_common_direct_file_viewers_are_bounded_and_typed(self) -> None:
        samples = {
            "sample.xml": (b"<root><event>login</event></root>", "tree_text"),
            "sample.plist": (plistlib.dumps({"event": "login"}), "tree_text"),
            "sample.pdf": (b"%PDF-1.7\n", "pdf"),
            "sample.png": (b"\x89PNG\r\n\x1a\n", "image"),
            "sample.log": (b"user login\n", "text"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            for filename, (content, viewer_type) in samples.items():
                with self.subTest(filename=filename):
                    source = Path(tmp) / filename
                    source.write_bytes(content)
                    output = Path(tmp) / f"{filename}.tar"
                    analyze_to_bundle(source, output)
                    with tarfile.open(output) as bundle:
                        manifest = json.load(bundle.extractfile("manifest.json"))
                    self.assertEqual(manifest["artifacts"][0]["viewerType"], viewer_type)

    def test_json_bundle_has_versioned_manifest_and_bounded_preview(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sample.json"
            source.write_text(json.dumps({"name": "alpha", "items": list(range(20))}))
            output = Path(tmp) / "result.tar"

            analyze_to_bundle(
                source,
                output,
                AnalysisLimits(max_preview_rows=5, max_preview_bytes=4096),
            )

            with tarfile.open(output) as bundle:
                manifest = json.load(bundle.extractfile("manifest.json"))

            self.assertEqual(manifest["contractVersion"], 1)
            self.assertEqual(manifest["sourceName"], "sample.json")
            self.assertEqual(manifest["artifacts"][0]["viewerType"], "tree_text")
            self.assertLessEqual(len(json.dumps(manifest["artifacts"][0]["preview"])), 4096)

    def test_sqlite_preview_caps_rows_per_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sample.db"
            with sqlite3.connect(source) as db:
                db.execute("CREATE TABLE events (id INTEGER, value TEXT)")
                db.executemany(
                    "INSERT INTO events VALUES (?, ?)",
                    [(i, f"value-{i}") for i in range(10)],
                )
            output = Path(tmp) / "result.tar"

            analyze_to_bundle(source, output, AnalysisLimits(max_preview_rows=3))

            with tarfile.open(output) as bundle:
                manifest = json.load(bundle.extractfile("manifest.json"))
            table = manifest["artifacts"][0]["preview"]["events"]
            self.assertEqual(len(table["rows"]), 3)
            self.assertTrue(table["truncated"])

    def test_archive_members_are_streamed_as_payloads_without_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sample.zip"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("folder/ok.txt", "safe")
                archive.writestr("../escape.txt", "blocked")
            output = Path(tmp) / "result.tar"

            analyze_to_bundle(source, output, AnalysisLimits(max_entries=10))

            with tarfile.open(output) as bundle:
                names = bundle.getnames()
                manifest = json.load(bundle.extractfile("manifest.json"))
            self.assertIn("payloads/00000001", names)
            self.assertNotIn("../escape.txt", names)
            self.assertEqual([a["path"] for a in manifest["artifacts"]], ["folder/ok.txt"])
            self.assertEqual(manifest["artifacts"][0]["viewerType"], "text")
            self.assertEqual(manifest["warnings"][0]["code"], "unsafe_path")

    def test_archive_expansion_limit_stops_analysis(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "sample.zip"
            with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("large.txt", "A" * 10_000)
            output = Path(tmp) / "result.tar"

            with self.assertRaises(LimitExceeded):
                analyze_to_bundle(
                    source,
                    output,
                    AnalysisLimits(max_total_bytes=100, max_expansion_ratio=2),
                )

    def test_nested_archive_is_opened_only_within_depth_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            inner_bytes = io.BytesIO()
            with zipfile.ZipFile(inner_bytes, "w") as inner:
                inner.writestr("event.json", '{"event":"login"}')
            source = Path(tmp) / "outer.zip"
            with zipfile.ZipFile(source, "w") as outer:
                outer.writestr("nested.zip", inner_bytes.getvalue())
            output = Path(tmp) / "result.tar"

            analyze_to_bundle(source, output, AnalysisLimits(max_depth=2))

            with tarfile.open(output) as bundle:
                manifest = json.load(bundle.extractfile("manifest.json"))
            self.assertEqual(
                [artifact["path"] for artifact in manifest["artifacts"]],
                ["nested.zip", "nested.zip/event.json"],
            )

    def test_tar_and_gzip_sources_stream_members(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tar_source = Path(tmp) / "sample.tar"
            payload = b'{"event":"login"}'
            with tarfile.open(tar_source, "w") as archive:
                info = tarfile.TarInfo("event.json")
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            gzip_source = Path(tmp) / "sample.log.gz"
            with gzip.open(gzip_source, "wb") as compressed:
                compressed.write(b"user login\n")

            for source, expected in (
                (tar_source, "event.json"),
                (gzip_source, "sample.log"),
            ):
                output = Path(tmp) / f"{source.name}.bundle.tar"
                analyze_to_bundle(source, output)
                with tarfile.open(output) as bundle:
                    manifest = json.load(bundle.extractfile("manifest.json"))
                self.assertEqual(manifest["artifacts"][0]["path"], expected)


if __name__ == "__main__":
    unittest.main()
