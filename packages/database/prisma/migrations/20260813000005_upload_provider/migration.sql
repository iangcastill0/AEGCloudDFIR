-- AlterEnum
-- 'upload' is the synthetic provider for user-uploaded container files
-- (PST/OST mailboxes). ALTER TYPE ... ADD VALUE cannot run inside a
-- transaction block alongside statements that use the new value, so this
-- migration contains ONLY the enum addition.
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'upload';
