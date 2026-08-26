-- AlterEnum
-- 'imap' lets a collection reach any host that speaks IMAP — Yahoo, iCloud, a
-- client's own mail server. Microsoft Graph and Gmail can only see mailboxes
-- their own companies host, so a Microsoft account signed in with a Yahoo
-- address returns an empty Outlook mailbox rather than that person's mail.
--
-- 'imap_password' holds the app password. Yahoo, Gmail and iCloud all refuse an
-- account password for IMAP. It is envelope-encrypted like every other secret.
--
-- ALTER TYPE ... ADD VALUE cannot run in a transaction alongside statements that
-- use the new value, so this migration contains ONLY the enum additions.
ALTER TYPE "Provider" ADD VALUE IF NOT EXISTS 'imap';
ALTER TYPE "SecretKind" ADD VALUE IF NOT EXISTS 'imap_password';
