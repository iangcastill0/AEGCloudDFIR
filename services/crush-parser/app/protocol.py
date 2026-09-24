from __future__ import annotations

import tempfile
from pathlib import Path
from pathlib import PurePath


def clean_filename(raw: str) -> str:
    name = PurePath(raw.replace("\\", "/")).name
    cleaned = "".join(ch for ch in name if 0x20 <= ord(ch) != 0x7F).strip()
    return cleaned[:255] or "import.bin"


def parse_positive_header(value: str | None, name: str, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a positive integer") from exc
    if parsed <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return parsed


def configure_tempdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    previous = tempfile.tempdir
    tempfile.tempdir = str(path)
    try:
        with tempfile.TemporaryFile():
            pass
    except OSError as exc:
        tempfile.tempdir = previous
        raise RuntimeError(f"scratch directory is not writable: {path}") from exc
