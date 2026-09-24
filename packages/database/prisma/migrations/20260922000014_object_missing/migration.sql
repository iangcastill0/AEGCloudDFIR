-- AlterEnum
-- Tell "the virus scanner was down" apart from "the evidence bytes are gone".
--
-- Both were recorded as MalwareStatus 'scan_failed' and logged with the words
-- "clamav unavailable". On 2026-09-22 a 130 GiB native export of 434,910 items
-- reported `32 item(s) failed verification`, every one of them because the
-- evidence_blobs row pointed at an object Wasabi answers NoSuchKey for. All 32
-- were 'scan_failed' — and so were 383 items that downloaded perfectly. The
-- reassuring word hid the alarming condition for twelve days.
--
-- 'object_missing' on MalwareStatus is the per-item fact, written only by
-- process.scan, and it needs no collection to exist.
-- 'object_missing' on ExceptionKind puts the same fact in the collection
-- exceptions ledger, where an operator and a disclosure report can see it.
--
-- ALTER TYPE ... ADD VALUE cannot run in a transaction alongside statements
-- that use the new value, so this migration contains ONLY enum additions.
ALTER TYPE "MalwareStatus" ADD VALUE IF NOT EXISTS 'object_missing';
ALTER TYPE "ExceptionKind" ADD VALUE IF NOT EXISTS 'object_missing';
