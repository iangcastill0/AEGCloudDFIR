from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import plistlib
import sqlite3
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterator
from xml.etree import ElementTree

CONTRACT_VERSION = 1
CRUSH_COMMIT = "9cec6246a3b12a21dd45a3fa2190aedcd2512d4e"
STRUCTURED_PARSE_CAP = 64 * 1024 * 1024


class LimitExceeded(ValueError):
    pass


@dataclass(frozen=True)
class AnalysisLimits:
    max_entries: int = 25_000
    max_total_bytes: int = 2 * 1024**3
    max_expansion_ratio: int = 100
    max_depth: int = 3
    max_preview_rows: int = 200
    max_preview_bytes: int = 512 * 1024
    max_text_chars: int = 100_000


@dataclass(frozen=True)
class Member:
    path: str
    size: int
    source: BinaryIO


def _safe_member_path(raw: str) -> str | None:
    normalized = raw.replace("\\", "/").lstrip("/")
    path = PurePosixPath(normalized)
    if normalized == "" or any(part in ("", ".", "..") for part in path.parts):
        return None
    return str(path)


def _json_safe(value: Any, *, depth: int = 0) -> Any:
    if depth > 12:
        return "[depth limit]"
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes):
        return {"type": "bytes", "size": len(value), "hex": value[:64].hex()}
    if isinstance(value, dict):
        return {
            str(key): _json_safe(item, depth=depth + 1)
            for key, item in list(value.items())[:2_000]
            if not str(key).startswith("__")
        }
    if isinstance(value, (list, tuple)):
        return [_json_safe(item, depth=depth + 1) for item in value[:2_000]]
    return str(value)


def _bound_preview(value: Any, max_bytes: int) -> Any:
    safe = _json_safe(value)
    encoded = json.dumps(safe, ensure_ascii=False, default=str).encode()
    if len(encoded) <= max_bytes:
        return safe
    return {
        "truncated": True,
        "text": encoded[: max(0, max_bytes - 100)].decode("utf-8", errors="replace"),
    }


def _sqlite_preview(path: Path, limits: AnalysisLimits) -> tuple[dict[str, Any], str]:
    preview: dict[str, Any] = {}
    text: list[str] = []
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        tables = [
            str(row[0])
            for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
        ]
        for table in tables[:1_000]:
            escaped = table.replace('"', '""')
            cursor = db.execute(
                f'SELECT * FROM "{escaped}" LIMIT ?', (limits.max_preview_rows + 1,)
            )
            rows = cursor.fetchall()
            columns = [column[0] for column in cursor.description or ()]
            shown = rows[: limits.max_preview_rows]
            preview[table] = {
                "columns": columns,
                "rows": [_json_safe(list(row)) for row in shown],
                "truncated": len(rows) > limits.max_preview_rows,
            }
            for row in shown:
                for value in row:
                    if isinstance(value, str):
                        text.append(value)
    return preview, " ".join(text)[: limits.max_text_chars]


def _fallback_parse(path: Path, limits: AnalysisLimits) -> dict[str, Any]:
    suffix = path.suffix.lower()
    size = path.stat().st_size
    with path.open("rb") as source:
        raw_head = source.read(32)
    metadata: dict[str, Any] = {"File size": f"{size:,} B"}
    viewer = "hex"
    preview: Any = {"hex": raw_head.hex(), "truncated": size > len(raw_head)}
    text_index = ""

    if raw_head.startswith(b"SQLite format 3\x00"):
        viewer = "table"
        preview, text_index = _sqlite_preview(path, limits)
        metadata["Format"] = "SQLite"
    elif suffix in (".json", ".geojson"):
        if size <= STRUCTURED_PARSE_CAP:
            viewer = "tree_text"
            value = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            preview = value
            text_index = json.dumps(value, ensure_ascii=False)[: limits.max_text_chars]
        else:
            viewer = "text"
            with path.open("r", encoding="utf-8", errors="replace") as source:
                text_index = source.read(limits.max_text_chars)
            preview = {"text": text_index, "truncated": True}
        metadata["Format"] = "JSON"
    elif suffix in (".plist", ".sfl", ".archive"):
        if size <= STRUCTURED_PARSE_CAP:
            viewer = "tree_text"
            value = plistlib.loads(path.read_bytes())
            preview = value
            text_index = json.dumps(_json_safe(value), ensure_ascii=False)[
                : limits.max_text_chars
            ]
            metadata["Format"] = "plist"
        else:
            metadata["Format"] = "plist (too large for bounded preview)"
    elif suffix == ".xml":
        if size <= STRUCTURED_PARSE_CAP:
            viewer = "tree_text"
            root = ElementTree.parse(path).getroot()

            def xml_node(node: ElementTree.Element) -> dict[str, Any]:
                return {
                    "tag": node.tag,
                    "attributes": node.attrib,
                    "text": (node.text or "").strip(),
                    "children": [xml_node(child) for child in list(node)[:2_000]],
                }

            preview = xml_node(root)
            text_index = " ".join(root.itertext())[: limits.max_text_chars]
            metadata["Format"] = "XML"
        else:
            metadata["Format"] = "XML (too large for bounded preview)"
    elif suffix in (".txt", ".log", ".csv", ".md"):
        viewer = "text"
        with path.open("r", encoding="utf-8", errors="replace") as source:
            text_index = source.read(limits.max_text_chars)
        preview = {"text": text_index, "truncated": size > len(text_index.encode())}
        metadata["Format"] = "text"
    elif suffix == ".pdf":
        viewer = "pdf"
        preview = {"nativePreview": True}
        metadata["Format"] = "PDF"
    elif suffix in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"):
        viewer = "image"
        preview = {"nativePreview": True}
        metadata["Format"] = "image"

    return {
        "viewerType": viewer,
        "preview": _bound_preview(preview, limits.max_preview_bytes),
        "metadata": metadata,
        "textIndex": text_index,
        "parser": "bounded-fallback",
    }


def _crush_parse(path: Path, limits: AnalysisLimits) -> dict[str, Any]:
    if path.stat().st_size > STRUCTURED_PARSE_CAP:
        return _fallback_parse(path, limits)
    try:
        import crush.parsers  # noqa: F401
        from crush.core.registry import ParserRegistry
        from crush.core.vfs import FileVFS
    except ImportError:
        return _fallback_parse(path, limits)

    vfs = FileVFS(path)
    node = vfs.root()
    parser = ParserRegistry.best(node, vfs)
    if parser is None:
        return _fallback_parse(path, limits)
    try:
        result = parser.parse(node, vfs)
        preview = result.data
        if result.viewer_type == "table":
            preview, _ = _sqlite_preview(path, limits)
        return {
            "viewerType": result.viewer_type,
            "preview": _bound_preview(preview, limits.max_preview_bytes),
            "metadata": _json_safe(result.metadata),
            "textIndex": str(result.text_index)[: limits.max_text_chars],
            "parser": parser.__class__.__name__,
        }
    except Exception as exc:
        fallback = _fallback_parse(path, limits)
        fallback["metadata"]["Crush parse error"] = str(exc)[:500]
        return fallback
    finally:
        vfs.close()


def _archive_members(path: Path) -> Iterator[Member]:
    name = path.name.lower()
    suffix = path.suffix.lower()
    if suffix == ".zip":
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                source = archive.open(info)
                try:
                    yield Member(info.filename, info.file_size, source)
                finally:
                    source.close()
        return
    if suffix == ".7z":
        try:
            from crush.core.vfs import SevenZipVFS
        except ImportError as exc:
            raise ValueError("7z support requires the pinned Crush package") from exc
        vfs = SevenZipVFS(path)
        try:
            stack = list(reversed(vfs.root().children))
            while stack:
                node = stack.pop()
                if node.is_dir:
                    stack.extend(reversed(node.children))
                    continue
                source = vfs.open(node)
                try:
                    yield Member(node.path.lstrip("/"), node.size, source)
                finally:
                    source.close()
        finally:
            vfs.close()
        return
    if suffix in (".tar", ".tgz", ".tbz2", ".txz") or ".tar." in name:
        with tarfile.open(path) as archive:
            for info in archive:
                if not info.isfile():
                    continue
                source = archive.extractfile(info)
                if source is not None:
                    yield Member(info.name, info.size, source)
        return
    if suffix == ".gz":
        raw_name = path.stem or "decompressed"
        with gzip.open(path, "rb") as source:
            yield Member(raw_name, 0, source)


def _is_archive(path: Path) -> bool:
    lower = path.name.lower()
    return path.suffix.lower() in (".zip", ".7z", ".tar", ".tgz", ".tbz2", ".txz", ".gz") or any(
        lower.endswith(suffix) for suffix in (".tar.gz", ".tar.bz2", ".tar.xz")
    )


def _copy_and_hash(
    source: BinaryIO, destination: BinaryIO, max_bytes: int | None = None
) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(1024 * 1024):
        size += len(chunk)
        if max_bytes is not None and size > max_bytes:
            raise LimitExceeded("archive exceeds expanded byte limit")
        destination.write(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def analyze_to_bundle(
    source_path: Path,
    output_path: Path,
    limits: AnalysisLimits = AnalysisLimits(),
) -> dict[str, Any]:
    source_path = source_path.resolve()
    source_size = source_path.stat().st_size
    artifacts: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    payloads: list[tuple[Path, str]] = []
    total_bytes = 0

    with tempfile.TemporaryDirectory(prefix="cdfir-crush-analysis-") as scratch:
        scratch_path = Path(scratch)
        if _is_archive(source_path):
            entry_count = 0

            def walk_archive(archive_path: Path, prefix: str, depth: int) -> None:
                nonlocal entry_count, total_bytes
                for member in _archive_members(archive_path):
                    entry_count += 1
                    if entry_count > limits.max_entries:
                        raise LimitExceeded(
                            f"archive has more than {limits.max_entries} entries"
                        )
                    member_path = _safe_member_path(member.path)
                    if member_path is None:
                        warnings.append({"code": "unsafe_path", "path": member.path[:500]})
                        member.source.close()
                        continue
                    safe_path = f"{prefix}/{member_path}" if prefix else member_path
                    if total_bytes + member.size > limits.max_total_bytes:
                        raise LimitExceeded("archive exceeds total uncompressed byte limit")
                    ratio_limit = source_size * limits.max_expansion_ratio
                    if source_size > 0 and total_bytes + member.size > ratio_limit:
                        raise LimitExceeded("archive exceeds expansion ratio limit")
                    suffix = "".join(PurePosixPath(safe_path).suffixes)[-32:]
                    temp_path = scratch_path / f"{entry_count:08d}{suffix}"
                    remaining = limits.max_total_bytes - total_bytes
                    if source_size > 0:
                        remaining = min(remaining, ratio_limit - total_bytes)
                    with temp_path.open("wb") as output:
                        actual_size, member_sha256 = _copy_and_hash(
                            member.source, output, remaining
                        )
                    member.source.close()
                    total_bytes += actual_size
                    payload_name = f"payloads/{entry_count:08d}"
                    parsed = _crush_parse(temp_path, limits)
                    artifacts.append(
                        {
                            "id": f"{entry_count:08d}",
                            "path": safe_path,
                            "name": PurePosixPath(safe_path).name,
                            "size": actual_size,
                            "sha256": member_sha256,
                            "payloadPath": payload_name,
                            **parsed,
                        }
                    )
                    payloads.append((temp_path, payload_name))
                    if _is_archive(temp_path):
                        if depth < limits.max_depth:
                            walk_archive(temp_path, safe_path, depth + 1)
                        else:
                            warnings.append(
                                {"code": "depth_limit", "path": safe_path[:500]}
                            )

            walk_archive(source_path, "", 1)
        else:
            parsed = _crush_parse(source_path, limits)
            artifacts.append(
                {
                    "id": "root",
                    "path": source_path.name,
                    "name": source_path.name,
                    "size": source_size,
                    "sha256": _sha256_file(source_path),
                    "payloadPath": None,
                    **parsed,
                }
            )

        manifest = {
            "contractVersion": CONTRACT_VERSION,
            "crushCommit": CRUSH_COMMIT,
            "sourceName": source_path.name,
            "sourceSize": source_size,
            "artifacts": artifacts,
            "warnings": warnings,
            "limits": {
                "maxEntries": limits.max_entries,
                "maxTotalBytes": limits.max_total_bytes,
                "maxExpansionRatio": limits.max_expansion_ratio,
                "maxDepth": limits.max_depth,
                "maxPreviewRows": limits.max_preview_rows,
                "maxPreviewBytes": limits.max_preview_bytes,
            },
        }
        manifest_bytes = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
        with tarfile.open(output_path, "w") as bundle:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(manifest_bytes)
            info.mode = 0o400
            bundle.addfile(info, io.BytesIO(manifest_bytes))
            for payload_path, payload_name in payloads:
                info = tarfile.TarInfo(payload_name)
                info.size = payload_path.stat().st_size
                info.mode = 0o400
                with payload_path.open("rb") as payload:
                    bundle.addfile(info, payload)
        return manifest


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def limits_from_env() -> AnalysisLimits:
    return AnalysisLimits(
        max_entries=int(os.environ.get("CRUSH_MAX_ENTRIES", "25000")),
        max_total_bytes=int(os.environ.get("CRUSH_MAX_TOTAL_BYTES", str(2 * 1024**3))),
        max_expansion_ratio=int(os.environ.get("CRUSH_MAX_EXPANSION_RATIO", "100")),
        max_depth=int(os.environ.get("CRUSH_MAX_DEPTH", "3")),
        max_preview_rows=int(os.environ.get("CRUSH_MAX_PREVIEW_ROWS", "200")),
        max_preview_bytes=int(os.environ.get("CRUSH_MAX_PREVIEW_BYTES", str(512 * 1024))),
        max_text_chars=int(os.environ.get("CRUSH_MAX_TEXT_CHARS", "100000")),
    )
