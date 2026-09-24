#!/usr/bin/env python3
"""Independent check on a PST this repo produced, using libpff (pypff).

The writer does not get to mark its own homework. libpff is a different
codebase, by different people, reading the bytes cold.

What it answers, and nothing more:

  * does every file open at all (the named-property trap is fatal and silent);
  * does each part open ON ITS OWN, so the parts really are complete PSTs and
    not byte-range volumes;
  * are the attachments byte-identical to the ones that went in;
  * does libpff report ANY parse error, including the no-attachment one.

Usage:
    verify.py <manifest.json> <part.pst> [<part-002.pst> ...]

The manifest is the one `pst-export.ts` writes into the export. Exit 0 only if
every check passed.

Needs libpff's Python binding: `pip install libpff-python`.
"""

from __future__ import annotations

import hashlib
import json
import sys
import unicodedata

try:
    import pypff
except ImportError:  # pragma: no cover - operator tooling
    sys.exit("pypff not installed: pip install libpff-python")


def norm(s: object) -> str:
    """Fold Unicode and whitespace so NFC/NFD and CRLF differences do not
    masquerade as corruption."""
    if s is None:
        return ""
    if isinstance(s, bytes):
        s = s.decode("utf-8", "replace")
    s = unicodedata.normalize("NFC", str(s))
    return " ".join(s.replace("\r\n", "\n").split()).strip()


def attachment_digests(message: object, errors: list[str]) -> list[str]:
    """SHA-256 of every attachment libpff can read off this message."""
    out: list[str] = []
    try:
        count = message.get_number_of_attachments()
    except Exception as exc:  # noqa: BLE001
        # This is the wart the vendored patch exists to remove. If it comes
        # back, it comes back loudly.
        errors.append(f"attachment count failed on {message.get_subject()!r}: {exc}")
        return out
    for i in range(count):
        att = message.get_attachment(i)
        try:
            size = att.get_size()
            data = att.read_buffer(size) if size else b""
        except Exception as exc:  # noqa: BLE001
            errors.append(f"attachment read failed: {exc}")
            continue
        out.append(hashlib.sha256(data).hexdigest())
    return out


def walk(folder: object, subjects: dict[str, list[str]], errors: list[str]) -> int:
    seen = 0
    for i in range(folder.get_number_of_sub_messages()):
        message = folder.get_sub_message(i)
        seen += 1
        subjects.setdefault(norm(message.get_subject()), []).extend(
            attachment_digests(message, errors)
        )
    for i in range(folder.get_number_of_sub_folders()):
        seen += walk(folder.get_sub_folder(i), subjects, errors)
    return seen


def main() -> int:
    if len(sys.argv) < 3:
        return int(bool(sys.stderr.write(__doc__ or "")))

    manifest = json.load(open(sys.argv[1]))
    parts = sys.argv[2:]

    subjects: dict[str, list[str]] = {}
    errors: list[str] = []
    total = 0

    for path in parts:
        # Opened on its own, with no reference to the other parts. That IS the
        # test for "independently openable".
        try:
            handle = pypff.file()
            handle.open(path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{path}: WILL NOT OPEN: {type(exc).__name__}: {exc}")
            continue
        count = walk(handle.get_root_folder(), subjects, errors)
        handle.close()
        print(f"{path}: opened, {count} message(s)")
        total += count

    expected = manifest.get("items", [])
    missing = [
        item["subject"]
        for item in expected
        if item.get("subject") and norm(item["subject"]) not in subjects
    ]

    bad_attachments = []
    for item in expected:
        want = [a["sha256"] for a in item.get("attachments", [])]
        if not want:
            continue
        got = subjects.get(norm(item.get("subject", "")), [])
        for digest in want:
            if digest not in got:
                bad_attachments.append((item.get("subject"), digest))

    print(f"messages read: {total}  expected: {len(expected)}")
    print(f"missing subjects: {len(missing)}")
    print(f"attachments not byte-identical: {len(bad_attachments)}")
    print(f"libpff parse errors: {len(errors)}")
    for line in errors[:10]:
        print(f"  ! {line}")
    for subject, digest in bad_attachments[:10]:
        print(f"  ! {subject!r} missing attachment {digest[:12]}")

    ok = not errors and not missing and not bad_attachments and total >= len(expected)
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
