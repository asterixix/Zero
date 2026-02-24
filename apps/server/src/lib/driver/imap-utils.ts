import type { ParsedMessage, Sender } from '../../types';
import type { ParsedMail } from 'mailparser';

// ─── Folder Discovery ────────────────────────────────────────────────────────
// RFC 6154 special-use flag mapping
// Docs: https://www.rfc-editor.org/rfc/rfc6154
export const SPECIAL_USE_FLAGS = {
  sent: '\\Sent',
  trash: '\\Trash',
  drafts: '\\Drafts',
  spam: '\\Junk',
  inbox: '\\Inbox',
} as const;

// Fallback regex patterns (covers Fastmail, Proton, Zoho, self-hosted etc.)
// Inspired by imapsync's folder mapping: https://imapsync.lamiral.info/FAQ.d/FAQ.Folders.txt
export const SENT_FOLDER_REGEX =
  /^(sent|gesendet|enviados|envoyés|inviati|verzonden|poslano|已发送)/i;
export const TRASH_FOLDER_REGEX =
  /^(trash|deleted|gelöscht|papelera|corbeille|cestino|prullenbak)/i;
export const DRAFTS_FOLDER_REGEX = /^(drafts|entwürfe|borradores|brouillons|bozze|concepten)/i;
export const SPAM_FOLDER_REGEX = /^(junk|spam|bulk|unerwünscht)/i;

export interface DiscoveredFolders {
  sent: string;
  trash: string;
  drafts: string;
  spam: string;
}

export interface ImapFolderEntry {
  path?: string;
  name?: string;
  specialUse?: string;
  flags?: string[];
  delimiter?: string;
}

export function discoverFolders(list: ImapFolderEntry[]): DiscoveredFolders {
  const findBySpecialUse = (flag: string): string | undefined =>
    list.find((f) => f.specialUse?.includes(flag))?.path;

  const findByRegex = (regex: RegExp): string | undefined =>
    list.find((f) => regex.test(f.name ?? f.path ?? ''))?.path;

  return {
    sent: findBySpecialUse(SPECIAL_USE_FLAGS.sent) ?? findByRegex(SENT_FOLDER_REGEX) ?? 'Sent',
    trash: findBySpecialUse(SPECIAL_USE_FLAGS.trash) ?? findByRegex(TRASH_FOLDER_REGEX) ?? 'Trash',
    drafts:
      findBySpecialUse(SPECIAL_USE_FLAGS.drafts) ?? findByRegex(DRAFTS_FOLDER_REGEX) ?? 'Drafts',
    spam: findBySpecialUse(SPECIAL_USE_FLAGS.spam) ?? findByRegex(SPAM_FOLDER_REGEX) ?? 'Junk',
  };
}

// ─── Folder → Zero Label Mapping ─────────────────────────────────────────────
// Zero system labels: INBOX, SENT, DRAFT, TRASH, SPAM, STARRED, UNREAD
export function folderToZeroLabel(folder: string, discovered: DiscoveredFolders): string {
  const lower = folder.toLowerCase();
  if (lower === 'inbox') return 'INBOX';
  if (folder === discovered.sent) return 'SENT';
  if (folder === discovered.drafts) return 'DRAFT';
  if (folder === discovered.trash) return 'TRASH';
  if (folder === discovered.spam) return 'SPAM';
  return folder; // user-created folder — pass through as-is
}

// ─── Thread ID Reconstruction ─────────────────────────────────────────────────
// RFC 5322: thread root = first element of References header
// Production pattern from: https://github.com/twentyhq/twenty
export function extractThreadId(parsed: ParsedMail): string {
  const refs = parsed.references;
  if (refs && refs.length > 0) {
    const root = (Array.isArray(refs) ? refs[0] : refs).trim();
    if (root) return root;
  }
  const irt = parsed.inReplyTo;
  if (irt) {
    const clean = (typeof irt === 'string' ? irt : String(irt)).trim();
    if (clean) return clean;
  }
  if (parsed.messageId) return parsed.messageId.trim();
  return `imap-thread-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─── Address Parsing ──────────────────────────────────────────────────────────
export function parseAddressObject(
  addr: ParsedMail['from'] | ParsedMail['to'] | ParsedMail['cc'] | ParsedMail['bcc'],
): Sender[] {
  if (!addr) return [];
  const values = Array.isArray(addr) ? addr : 'value' in addr ? addr.value : [addr];
  return (values as { name?: string; address?: string }[])
    .filter((a) => !!a.address)
    .map((a) => ({ name: a.name ?? undefined, email: a.address! }));
}

// ─── ParsedMessage Builder ────────────────────────────────────────────────────
// Must match ParsedMessageSchema in apps/server/src/types.ts exactly
export function buildParsedMessage(
  uid: number,
  folder: string,
  connectionId: string,
  parsed: ParsedMail,
  discovered: DiscoveredFolders,
): ParsedMessage {
  const threadId = extractThreadId(parsed);
  const label = folderToZeroLabel(folder, discovered);
  const from = parseAddressObject(parsed.from);

  return {
    id: `${folder}:${uid}`,
    connectionId,
    title: parsed.subject ?? '(no subject)',
    subject: parsed.subject ?? '',
    tags: [{ id: label, name: label, type: 'system' }],
    sender: from[0] ?? { email: '' },
    to: parseAddressObject(parsed.to),
    cc: parseAddressObject(parsed.cc),
    bcc: parseAddressObject(parsed.bcc),
    tls: false, // IMAP doesn't expose TLS per-message
    receivedOn: (parsed.date ?? new Date()).toISOString(),
    unread: true, // flags checked separately per-message
    body: parsed.html ?? parsed.text ?? '',
    processedHtml: parsed.html ?? '',
    blobUrl: '',
    decodedBody: parsed.text ?? '',
    references: Array.isArray(parsed.references)
      ? parsed.references.join(' ')
      : (parsed.references ?? ''),
    inReplyTo:
      typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : String(parsed.inReplyTo ?? ''),
    messageId: parsed.messageId ?? '',
    threadId,
    attachments: (parsed.attachments ?? []).map((a, idx) => ({
      attachmentId: `${uid}-${idx}`,
      filename: a.filename ?? 'attachment',
      mimeType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? 0,
      body: a.content?.toString('base64') ?? '',
      headers: [],
    })),
    isDraft: folder === discovered.drafts,
  };
}
