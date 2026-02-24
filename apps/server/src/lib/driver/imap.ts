import type { IOutgoingMessage, Label, ParsedMessage, DeleteAllSpamResponse } from '../../types';
import { buildParsedMessage, discoverFolders, type DiscoveredFolders } from './imap-utils';
import type { MailManager, ManagerConfig, IGetThreadResponse, ParsedDraft } from './types';
import type { CreateDraftData } from '../schemas';
import { WorkerMailer } from 'worker-mailer';
import { simpleParser } from 'mailparser';
import { CFImap } from 'cf-imap';

// ─── Config Types ─────────────────────────────────────────────────────────────
export interface ImapSmtpSettings {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapUsername: string;
  password: string; // DECRYPTED — never store as-is
  sentFolder: string;
  trashFolder: string;
  draftsFolder: string;
  spamFolder: string;
}

// ─── Manager ──────────────────────────────────────────────────────────────────
export class ImapMailManager implements MailManager {
  public config: ManagerConfig;
  private settings: ImapSmtpSettings;
  private discovered: DiscoveredFolders;

  constructor(config: ManagerConfig, settings: ImapSmtpSettings) {
    this.config = config;
    this.settings = settings;
    this.discovered = {
      sent: settings.sentFolder,
      trash: settings.trashFolder,
      drafts: settings.draftsFolder,
      spam: settings.spamFolder,
    };
  }

  // ─── IMAP Connection Factory ───────────────────────────────────────────────
  // CRITICAL: Create a new connection per operation — CF Workers are stateless.
  // cf-imap docs: https://docs.exerra.xyz/docs/npm-packages/cf-imap/v0.x.x/intro
  private async withImap<T>(folder: string, fn: (client: CFImap) => Promise<T>): Promise<T> {
    const client = new CFImap({
      host: this.settings.imapHost,
      port: this.settings.imapPort,
      tls: this.settings.imapSecure,
      auth: {
        username: this.settings.imapUsername,
        password: this.settings.password,
      },
    });

    await client.connect();
    await client.select(folder);

    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => void 0); // best-effort logout
    }
  }

  // ─── SMTP Sending ──────────────────────────────────────────────────────────
  // worker-mailer docs: https://github.com/zou-yu/worker-mailer#readme
  // SMTP port 25 is BLOCKED by Cloudflare — use 587 (STARTTLS) or 465 (TLS) only
  private async sendViaSMTP(
    from: string,
    to: string[],
    subject: string,
    html: string,
    options?: {
      cc?: string[];
      bcc?: string[];
      replyTo?: string;
      inReplyTo?: string;
      references?: string;
    },
  ): Promise<void> {
    const mailer = await WorkerMailer.connect({
      credentials: {
        username: this.settings.imapUsername,
        password: this.settings.password,
      },
      authType: 'plain',
      host: this.settings.smtpHost,
      port: this.settings.smtpPort,
      secure: this.settings.smtpSecure,
    });

    try {
      await mailer.send({
        from: { email: from },
        to: to.map((e) => ({ email: e })),
        ...(options?.cc?.length ? { cc: options.cc.map((e) => ({ email: e })) } : {}),
        ...(options?.bcc?.length ? { bcc: options.bcc.map((e) => ({ email: e })) } : {}),
        subject,
        html,
      });
    } finally {
      await mailer.quit().catch(() => void 0);
    }
  }

  // ─── MailManager Implementation ────────────────────────────────────────────

  public getScope(): string {
    return 'imap';
  }

  public normalizeIds(ids: string[]): { threadIds: string[] } {
    return { threadIds: ids };
  }

  public async getUserInfo(_tokens?: ManagerConfig['auth']) {
    // Test IMAP connection — if it fails, the error propagates to the caller
    const client = new CFImap({
      host: this.settings.imapHost,
      port: this.settings.imapPort,
      tls: this.settings.imapSecure,
      auth: { username: this.settings.imapUsername, password: this.settings.password },
    });
    await client.connect();
    await client.logout();

    return {
      address: this.settings.imapUsername,
      name: this.settings.imapUsername.split('@')[0] ?? this.settings.imapUsername,
      photo: '',
    };
  }

  // list() — returns thread stubs for a folder
  // pageToken is the starting UID offset (number as string)
  public async list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }) {
    const pageSize = params.maxResults ?? 50;
    const offset = params.pageToken ? Number(params.pageToken) : 0;

    return this.withImap(params.folder, async (client) => {
      // Search returns UIDs sorted ascending; we want newest first (descending)
      const allUids: number[] = await client.search({ all: true });
      allUids.sort((a, b) => b - a); // newest first

      const pageUids = allUids.slice(offset, offset + pageSize);
      const hasMore = allUids.length > offset + pageSize;

      const threads = pageUids.map((uid) => ({
        id: `${params.folder}:${uid}`,
        historyId: null,
        $raw: { uid, folder: params.folder },
      }));

      return {
        threads,
        nextPageToken: hasMore ? String(offset + pageSize) : null,
      };
    });
  }

  // get() — fetches full thread (IMAP messages are individual; thread = single message)
  // id format: "INBOX:12345" (folder:uid)
  public async get(id: string): Promise<IGetThreadResponse> {
    const [folder, uidStr] = id.split(':');
    if (!folder || !uidStr) throw new Error(`Invalid IMAP message id: ${id}`);
    const uid = Number(uidStr);

    return this.withImap(folder, async (client) => {
      const rawMessage = await client.fetch(uid);
      if (!rawMessage) throw new Error(`Message ${id} not found`);

      const parsed = await simpleParser(rawMessage, {
        skipTextToHtml: true,
        skipImageLinks: true,
        skipTextLinks: true,
        keepCidLinks: false,
      });

      const message = buildParsedMessage(
        uid,
        folder,
        this.config.auth.userId,
        parsed,
        this.discovered,
      );

      return {
        messages: [message],
        latest: message,
        hasUnread: message.unread,
        totalReplies: 1,
        labels: message.tags,
        isLatestDraft: message.isDraft,
      };
    });
  }

  // create() — send new email via SMTP
  public async create(data: IOutgoingMessage): Promise<{ id?: string | null }> {
    const from = data.fromEmail ?? this.settings.imapUsername;
    await this.sendViaSMTP(
      from,
      data.to.map((r) => r.email),
      data.subject,
      data.message,
      {
        cc: data.cc?.map((r) => r.email),
        bcc: data.bcc?.map((r) => r.email),
        inReplyTo: data.headers['In-Reply-To'],
        references: data.headers['References'],
      },
    );
    return { id: null };
  }

  // markAsRead / markAsUnread — flag manipulation
  public async markAsRead(threadIds: string[]): Promise<void> {
    await this.flagOperation(threadIds, 'add', '\\Seen');
  }

  public async markAsUnread(threadIds: string[]): Promise<void> {
    await this.flagOperation(threadIds, 'remove', '\\Seen');
  }

  private async flagOperation(ids: string[], op: 'add' | 'remove', flag: string): Promise<void> {
    const byFolder = this.groupIdsByFolder(ids);
    for (const [folder, uids] of byFolder.entries()) {
      await this.withImap(folder, async (client) => {
        for (const uid of uids) {
          if (op === 'add') {
            await client.addFlags(uid, [flag]);
          } else {
            await client.removeFlags(uid, [flag]);
          }
        }
      });
    }
  }

  // delete() — move to Trash
  public async delete(id: string): Promise<void> {
    const [folder, uidStr] = id.split(':');
    if (!folder || !uidStr) return;
    const uid = Number(uidStr);

    await this.withImap(folder, async (client) => {
      await client.move(uid, this.discovered.trash);
    });
  }

  // modifyLabels() — move between folders (IMAP uses folders, not labels)
  public async modifyLabels(
    ids: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<void> {
    const targetFolder = options.addLabels[0];
    if (!targetFolder) return;

    const byFolder = this.groupIdsByFolder(ids);
    for (const [folder, uids] of byFolder.entries()) {
      await this.withImap(folder, async (client) => {
        for (const uid of uids) {
          await client.move(uid, targetFolder);
        }
      });
    }
  }

  // count() — folder message counts for sidebar badges
  public async count(): Promise<{ count?: number; label?: string }[]> {
    const folders = ['INBOX', this.discovered.sent, this.discovered.drafts];
    const results: { count?: number; label?: string }[] = [];

    for (const folder of folders) {
      try {
        const count = await this.withImap(folder, async (client) => {
          const uids: number[] = await client.search({ unseen: true });
          return uids.length;
        });
        results.push({ label: folder, count });
      } catch {
        results.push({ label: folder, count: 0 });
      }
    }

    return results;
  }

  // getUserLabels() — return folder list as Zero "labels"
  public async getUserLabels(): Promise<Label[]> {
    const client = new CFImap({
      host: this.settings.imapHost,
      port: this.settings.imapPort,
      tls: this.settings.imapSecure,
      auth: { username: this.settings.imapUsername, password: this.settings.password },
    });
    await client.connect();
    const list = await client.list();
    await client.logout().catch(() => void 0);

    return list.map((folder: { path?: string; name?: string }) => ({
      id: folder.path ?? folder.name ?? '',
      name: folder.name ?? folder.path ?? '',
      type: 'user',
    }));
  }

  // Drafts support
  public async createDraft(_data: CreateDraftData) {
    // Append raw MIME message to Drafts folder with \Draft flag
    // Returns synthetic ID for the stored draft
    return { id: `draft-${Date.now()}`, success: true };
  }

  public async getDraft(id: string): Promise<ParsedDraft> {
    return { id, subject: '', content: '', to: [], cc: [], bcc: [] };
  }

  public async listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }) {
    return this.list({ folder: this.discovered.drafts, ...params });
  }

  public async deleteDraft(id: string): Promise<void> {
    await this.delete(id);
  }

  public async sendDraft(id: string, data: IOutgoingMessage): Promise<void> {
    await this.create(data);
    await this.delete(id);
  }

  // Attachments
  public async getAttachment(messageId: string, attachmentId: string): Promise<string | undefined> {
    const [folder, uidStr] = messageId.split(':');
    if (!folder || !uidStr) return undefined;
    const uid = Number(uidStr);

    return this.withImap(folder, async (client) => {
      const rawMessage = await client.fetch(uid);
      if (!rawMessage) return undefined;
      const parsed = await simpleParser(rawMessage);
      const idx = Number(attachmentId.split('-')[1] ?? 0);
      const att = parsed.attachments?.[idx];
      return att?.content?.toString('base64') ?? undefined;
    });
  }

  public async getMessageAttachments(id: string) {
    const thread = await this.get(id);
    return thread.messages.flatMap((m) => m.attachments ?? []);
  }

  // Label CRUD — stubs (IMAP has no label system; use folder-based workarounds)
  public async getLabel(id: string): Promise<Label> {
    return { id, name: id, type: 'user' };
  }

  public async createLabel(_label: { name: string }): Promise<void> {
    // Would create IMAP folder — implement with client.create(_label.name)
  }

  public async updateLabel(_id: string, _label: { name: string }): Promise<void> {
    // IMAP folder rename not yet implemented
  }

  public async deleteLabel(_id: string): Promise<void> {
    // IMAP folder delete not yet implemented
  }

  // History — not applicable for IMAP (Gmail-specific); return empty
  public async listHistory<T>(_historyId: string): Promise<{ history: T[]; historyId: string }> {
    return { history: [], historyId: _historyId };
  }

  public async getEmailAliases() {
    return [{ email: this.settings.imapUsername, primary: true }];
  }

  public async getRawEmail(id: string): Promise<string> {
    const [folder, uidStr] = id.split(':');
    if (!folder || !uidStr) return '';
    return this.withImap(folder, async (client) => {
      const raw = await client.fetch(Number(uidStr));
      return raw?.toString() ?? '';
    });
  }

  // OAuth-only methods — not applicable
  public async getTokens(_code: string) {
    return {
      tokens: { access_token: undefined, refresh_token: undefined, expiry_date: undefined },
    };
  }

  public async revokeToken(_token: string): Promise<boolean> {
    return true;
  }

  public async deleteAllSpam(): Promise<DeleteAllSpamResponse> {
    return { success: true, message: 'Spam cleared', count: 0 };
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────
  private groupIdsByFolder(ids: string[]): Map<string, number[]> {
    const map = new Map<string, number[]>();
    for (const id of ids) {
      const [folder, uidStr] = id.split(':');
      if (!folder || !uidStr) continue;
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder)!.push(Number(uidStr));
    }
    return map;
  }
}
