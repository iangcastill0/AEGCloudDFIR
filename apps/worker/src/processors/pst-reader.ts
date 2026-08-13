import { PSTFile, PSTFolder, PSTMessage } from 'pst-extractor';

/**
 * Thin adapter over pst-extractor — the ONLY module that imports it. The
 * processor depends on the PstReader/PstArchive interfaces so unit tests can
 * inject a fake archive without a real PST fixture (live-PST verification is
 * a documented manual step).
 */

/** Per-attachment safety cap: larger attachments are omitted and reported. */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

const ATTACHMENT_READ_CHUNK = 8176;

export interface PstAttachmentData {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface PstRecipientData {
  kind: 'to' | 'cc' | 'bcc';
  name: string;
  address: string;
}

export interface PstMessageData {
  /** Stable node id within the container; part of the providerItemId. */
  descriptorNodeId: string;
  subject: string;
  senderName: string;
  senderEmailAddress: string;
  /** Raw transport headers when the PST retained them, else ''. */
  transportMessageHeaders: string;
  internetMessageId: string;
  displayTo: string;
  displayCc: string;
  displayBcc: string;
  recipients: PstRecipientData[];
  bodyPlain: string;
  bodyHtml: string;
  clientSubmitTime: Date | null;
  messageDeliveryTime: Date | null;
  attachments: PstAttachmentData[];
  /** Attachment filenames omitted because they exceeded MAX_ATTACHMENT_BYTES. */
  oversizedAttachments: string[];
}

export interface PstArchive {
  messageStoreDisplayName: string;
  /**
   * Depth-first walk over every message in the container. `folderPath` is a
   * '/'-joined path below the root folder (e.g. 'Inbox/Subfolder'). The
   * callback may throw to abort the walk; the error propagates.
   */
  walk(cb: (msg: PstMessageData, folderPath: string) => Promise<void>): Promise<{ count: number }>;
  close(): void;
}

export interface PstReader {
  /** Open a PST/OST file from a local path. Throws on encrypted/corrupt files. */
  open(path: string): PstArchive;
}

/** MAPI recipient types (PidTagRecipientType). */
const RECIPIENT_KINDS: Record<number, PstRecipientData['kind']> = {
  1: 'to',
  2: 'cc',
  3: 'bcc',
};

function readAttachmentContent(message: PSTMessage, index: number): PstAttachmentData | string {
  const attachment = message.getAttachment(index);
  const filename =
    attachment.longFilename !== '' ? attachment.longFilename : attachment.filename || 'attachment';
  const stream = attachment.fileInputStream;
  if (stream === null) return filename;
  const chunks: Buffer[] = [];
  let total = 0;
  const buffer = Buffer.alloc(ATTACHMENT_READ_CHUNK);
  let bytesRead = stream.read(buffer);
  while (bytesRead > 0) {
    total += bytesRead;
    if (total > MAX_ATTACHMENT_BYTES) return filename;
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    if (bytesRead < ATTACHMENT_READ_CHUNK) break;
    bytesRead = stream.read(buffer);
  }
  return {
    filename,
    mimeType: attachment.mimeTag !== '' ? attachment.mimeTag : 'application/octet-stream',
    content: Buffer.concat(chunks),
  };
}

function readRecipients(message: PSTMessage): PstRecipientData[] {
  const recipients: PstRecipientData[] = [];
  let count: number;
  try {
    count = message.numberOfRecipients;
  } catch {
    return recipients;
  }
  for (let i = 0; i < count; i += 1) {
    try {
      const recipient = message.getRecipient(i);
      if (recipient === null) continue;
      const kind = RECIPIENT_KINDS[recipient.recipientType];
      if (kind === undefined) continue;
      const address = recipient.smtpAddress !== '' ? recipient.smtpAddress : recipient.emailAddress;
      recipients.push({ kind, name: recipient.displayName, address });
    } catch {
      continue; // a malformed recipient row must not sink the message
    }
  }
  return recipients;
}

function toMessageData(message: PSTMessage): PstMessageData {
  const attachments: PstAttachmentData[] = [];
  const oversized: string[] = [];
  for (let i = 0; i < message.numberOfAttachments; i += 1) {
    try {
      const result = readAttachmentContent(message, i);
      if (typeof result === 'string') oversized.push(result);
      else attachments.push(result);
    } catch {
      oversized.push(`attachment-${i}`);
    }
  }
  return {
    descriptorNodeId: message.descriptorNodeId.toString(),
    subject: message.subject,
    senderName: message.senderName,
    senderEmailAddress: message.senderEmailAddress,
    transportMessageHeaders: message.transportMessageHeaders,
    internetMessageId: message.internetMessageId,
    displayTo: message.displayTo,
    displayCc: message.displayCC,
    displayBcc: message.displayBCC,
    recipients: readRecipients(message),
    bodyPlain: message.body,
    bodyHtml: message.bodyHTML,
    clientSubmitTime: message.clientSubmitTime,
    messageDeliveryTime: message.messageDeliveryTime,
    attachments,
    oversizedAttachments: oversized,
  };
}

class RealPstArchive implements PstArchive {
  readonly messageStoreDisplayName: string;

  constructor(private readonly pstFile: PSTFile) {
    this.messageStoreDisplayName = pstFile.getMessageStore().displayName;
  }

  async walk(
    cb: (msg: PstMessageData, folderPath: string) => Promise<void>,
  ): Promise<{ count: number }> {
    const counter = { count: 0 };
    await this.walkFolder(this.pstFile.getRootFolder(), '', cb, counter);
    return counter;
  }

  private async walkFolder(
    folder: PSTFolder,
    path: string,
    cb: (msg: PstMessageData, folderPath: string) => Promise<void>,
    counter: { count: number },
  ): Promise<void> {
    if (folder.contentCount > 0) {
      let child: unknown = folder.getNextChild();
      while (child !== null && child !== undefined) {
        if (child instanceof PSTMessage) {
          counter.count += 1;
          await cb(toMessageData(child), path);
        }
        child = folder.getNextChild();
      }
    }
    if (folder.hasSubfolders) {
      for (const sub of folder.getSubFolders()) {
        const subPath = path === '' ? sub.displayName : `${path}/${sub.displayName}`;
        await this.walkFolder(sub, subPath, cb, counter);
      }
    }
  }

  close(): void {
    this.pstFile.close();
  }
}

export const realPstReader: PstReader = {
  open(path: string): PstArchive {
    return new RealPstArchive(new PSTFile(path));
  },
};

/** True when a pst-extractor open/read failure indicates encryption. */
export function isPstEncryptionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /encrypt/i.test(message);
}
