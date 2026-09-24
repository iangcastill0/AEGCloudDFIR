# PST writer

Turns collected `.eml` files into Outlook PST files, so a recipient who only has
Outlook can open an export.

**A PST export is a reconstruction, not the evidence.** The bytes inside it are
not the bytes that were collected, and nobody ever recorded their hashes. Read
`TRUTHFULNESS_NOTICES.pstExport` in `packages/contracts` before changing
anything here.

## Layout

| Path        | What it is                                                                |
| ----------- | ------------------------------------------------------------------------- |
| `vendor/`   | Somebody else's library, copied in. See `UPSTREAM.md`.                    |
| `patches/`  | Our one change to it, already applied to `vendor/`.                       |
| `cli/`      | Our program. Reads a job file, writes PSTs, prints one JSON line.         |
| `verify.py` | Checks a produced PST with libpff — a different codebase reading it cold. |

## How to check a PST by hand

The writer must never be the only thing that says its output is good. libpff is
an independent reader; `pffexport` is its command-line tool.

```
[MAC] pip install libpff-python
[MAC] python3 services/pst-builder/verify.py <manifest.json> <part1.pst> <part2.pst> ...
```

`manifest.json` is the one the export produced. `verify.py` opens each part **on
its own** — that is how it proves the parts are complete PSTs and not byte-range
volumes — then compares every attachment's SHA-256 against the manifest.

## Things that are silent and fatal

Both have tests (`apps/worker/src/processors/pst-vendor.test.ts`), because
neither shows up as a build failure or a wrong number. The export succeeds and
then nothing can read the file.

1. **No named properties anywhere means libpff will not open the file at all.**
   `cli/Program.cs` attaches one marker property per message for exactly this
   reason. It is a derived property and is declared as such in the export.
2. **Upstream skips the attachment table on messages with no attachment**, and
   libpff then errors on every such message. Most real mail has no attachment.
   `patches/0001-...` fixes it.

## Known limits

- **A part cannot exceed about 3.19 GiB.** The writer's own ceiling. Ask for a
  bigger part size and it is silently clamped, so `pstPartMb` in the contract is
  capped at 3 GiB to stop that surprise. A 47.4 GiB mail set is therefore about
  15 parts, not 5.
- **The largest PST anyone here has opened and checked is 2.77 GiB.** Above that
  is untested.
- **The writer is not deterministic.** Exporting the same messages twice produces
  files with different SHA-256. Do not treat a changed PST hash as tampering.
- **Nobody has opened one of these in real Outlook.** libpff accepting the bytes
  is not the same as Outlook opening them without a repair prompt.
- **The `linux-x64` binary has never run on native x86-64.** It has only been run
  under QEMU emulation on an arm64 Mac, where it writes correct PSTs but reports
  corrupted 32-bit numbers. Confirm on staging, which is native x86-64.
- **Non-email items cannot go in a PST.** A mailbox file has nowhere to put a
  loose PDF. They are skipped and listed in `exceptions.csv`.
