-- AlterEnum
-- Slack chat collection. Three enums, all additive.
--
-- `chat` is a source of its own rather than a flavour of `email`. Calling a
-- Slack message an email would carry that word into the UI, the manifest AND
-- the production load file, and a false field in a manifest is a defect rather
-- than a shortcut. It is named generically so Microsoft Teams and Google Chat
-- reuse it. See docs/adr/ADR-011.
--
-- chat_conversation exists because membership at collection time is evidence
-- and Slack keeps no history of it: who was in a channel when a message was
-- sent cannot be reconstructed later.
--
-- ALTER TYPE ... ADD VALUE cannot run in a transaction alongside statements that
-- use the new value, so this migration contains ONLY enum additions.
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'slack';
ALTER TYPE "CollectionSource" ADD VALUE IF NOT EXISTS 'chat';
ALTER TYPE "EvidenceKind" ADD VALUE IF NOT EXISTS 'chat_message';
ALTER TYPE "EvidenceKind" ADD VALUE IF NOT EXISTS 'chat_conversation';
