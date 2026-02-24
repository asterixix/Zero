import type { IOutgoingMessage, Label, DeleteAllSpamResponse } from '../../types';
import { buildParsedMessage, type DiscoveredFolders } from './imap-utils';
import type { MailManager, ManagerConfig, IGetThreadResponse, ParsedDraft } from './types';
import { simpleParser } from 'mailparser';
import { buildParsedMessage as buildMessage } from './imap-utils';
import { CFImap } from 'cf-imap';

export interface ImapSmtpSettings {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpRequireTls: boolean;
  imapUsername: string;
  password: string;
  sentFolder: string;
  trashFolder: string;
  draftsFolder: string;
  spamFolder: string;
}

export class ImapMailManager implements MailManager {
  public config: ManagerConfig;
  private settings: ImapSmtpSettings;

  constructor(config: ManagerConfig, settings: ImapSmtpSettings) {
    this.config = config;
    this.settings = settings;
  }

  private async withImap<T>(folder: string, fn: (client: CFImap) => Promise<T>): Promise<T> {
    const client = new CFImap({
      host: this.settings.imapHost,
      port: this.settings.imapPort,
      tls: this.settings.imapSecure,
      auth: { username: this.settings.imapUsername, password: this.settings.password },
    });

    await client.connect();
    await client.select(folder);

    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => void 0);
    }
  }

  private async sendViaSMTP(data: IOutgoingMessage): Promise<void> {
    const mailer = await WorkerMailer.connect({
      host: this.settings.smtpHost,
      port: this.settings.smtpPort,
      secure: this.settings.smtpSecure,
      credentials: { username: this.settings.imapUsername, password: this.settings.password },
    });

    try {
      await mailer.send({
        from: this.config.auth.email,
        to: data.to,
        subject: data.subject,
        html: data.text,
      });
    } finally {
      await mailer.close();
    }
  }

  public async getUserInfo(_tokens?: ManagerConfig['auth']) {
    return {
      address: this.config.auth.email,
      name: this.config.auth.email.split('@')[0],
      photo: '',
    };
  }

  public async list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }): Promise<{
    threads: { id: string; historyId: string | null; $raw?: unknown }[];
    nextPageToken: string | null;
  }> {
    return this.withImap(params.folder, async (client) => {
      const searchOpts = params.query ? { subject: params.query } : { all: true };
      const uids = await client.search(searchOpts);
      const sliced = uids.slice(0, params.maxResults || 50);
      return {
        threads: sliced.map((uid) => ({
          id: String(uid),
          historyId: null,
          $raw: null,
        })),
        nextPageToken: null,
      };
    });
  }

  public async get(id: string): Promise<IGetThreadResponse> {
    const folder = 'INBOX';
    return this.withImap(folder, async (client) => {
      const uid = parseInt(id, 10);
      const raw = await client.fetch(uid);
      if (!raw) throw new Error('Message not found');

      const parsed = await simpleParser(raw, {
        skipTextToHtml: true,
        skipImageLinks: true,
        skipTextLinks: true,
        keepCidLinks: false,
      });

      const discovered: DiscoveredFolders = {
        sent: this.settings.sentFolder,
        trash: this.settings.trashFolder,
        drafts: this.settings.draftsFolder,
        spam: this.settings.spamFolder,
      };

      const message = buildMessage(uid, folder, this.config.auth.email, parsed, discovered);

      return {
        messages: [message],
        latest: message,
        hasUnread: message.unread,
        totalReplies: 1,
        labels: message.tags,
      };
    });
  }

  public async create(data: IOutgoingMessage): Promise<{ id?: string | null }> {
    await this.sendViaSMTP(data);
    return { id: crypto.randomUUID() };
  }

  public async markAsRead(threadIds: string[]): Promise<void> {
    const folder = 'INBOX';
    await this.withImap(folder, async (client) => {
      for (const id of threadIds) {
        const uid = parseInt(id, 10);
        await client.flag(uid, '\\Seen');
      }
    });
  }

  public async markAsUnread(threadIds: string[]): Promise<void> {
    const folder = 'INBOX';
    await this.withImap(folder, async (client) => {
      for (const id of threadIds) {
        const uid = parseInt(id, 10);
        await client.unflag(uid, '\\Seen');
      }
    });
  }

  private async flagOperation(ids: string[], op: 'add' | 'remove', flag: string): Promise<void> {
    const folder = 'INBOX';
    await this.withImap(folder, async (client) => {
      for (const id of ids) {
        const uid = parseInt(id, 10);
        if (op === 'add') {
          await client.flag(uid, flag);
        } else {
          await client.unflag(uid, flag);
        }
      }
    });
  }

  public async delete(id: string): Promise<void> {
    const folder = this.settings.trashFolder;
    await this.withImap(folder, async (client) => {
      const uid = parseInt(id, 10);
      await client.delete(uid);
    });
  }

  public async modifyLabels(
    id: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<void> {
    const folder = 'INBOX';
    await this.withImap(folder, async (client) => {
      for (const uidStr of id) {
        const uid = parseInt(uidStr, 10);
        for (const label of options.addLabels) {
          await client.flag(uid, `\\${label}`);
        }
        for (const label of options.removeLabels) {
          await client.unflag(uid, `\\${label}`);
        }
      }
    });
  }

  public async count(): Promise<{ count?: number; label?: string }[]> {
    const folder = 'INBOX';
    return this.withImap(folder, async (client) => {
      const count = await client.count();
      return [{ count, label: 'INBOX' }];
    });
  }

  public async getUserLabels(): Promise<Label[]> {
    return [];
  }

  public async createDraft(_data: CreateDraftData) {
    return { id: crypto.randomUUID(), success: true };
  }

  public async getDraft(id: string): Promise<ParsedDraft> {
    return { id, to: [], subject: '', content: '' };
  }

  public async listDrafts(params: { q?: string; maxResults?: number; pageToken?: string }) {
    return { threads: [], nextPageToken: null };
  }

  public async deleteDraft(id: string): Promise<void> {}

  public async sendDraft(id: string, data: IOutgoingMessage): Promise<void> {
    await this.sendViaSMTP(data);
  }

  public async getAttachment(messageId: string, attachmentId: string): Promise<string | undefined> {
    const folder = 'INBOX';
    return this.withImap(folder, async (client) => {
      const uid = parseInt(messageId, 10);
      const raw = await client.fetch(uid);
      if (!raw) return undefined;

      const parsed = await simpleParser(raw);
      const attachment = parsed.attachments.find((a) => a.contentId === attachmentId);
      return attachment ? attachment.content.toString() : undefined;
    });
  }

  public async getMessageAttachments(id: string) {
    const folder = 'INBOX';
    return this.withImap(folder, async (client) => {
      const uid = parseInt(id, 10);
      const raw = await client.fetch(uid);
      if (!raw) return [];

      const parsed = await simpleParser(raw);
      return parsed.attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.contentType,
        size: a.size,
        attachmentId: a.contentId || '',
        headers: Object.entries(a.headers || {}).map(([k, v]) => ({ name: k, value: String(v) })),
        body: a.content.toString(),
      }));
    });
  }

  public async getLabel(id: string): Promise<Label> {
    throw new Error('Not implemented');
  }

  public async createLabel(_label: { name: string }): Promise<void> {}

  public async updateLabel(_id: string, _label: { name: string }): Promise<void> {}

  public async deleteLabel(_id: string): Promise<void> {}

  public async listHistory<T>(_historyId: string): Promise<{ history: T[]; historyId: string }> {
    return { history: [], historyId: '' };
  }

  public async getEmailAliases() {
    return [{ email: this.config.auth.email, name: this.config.auth.email.split('@')[0] }];
  }

  public async getTokens(_code: string) {
    return { tokens: {} };
  }

  public async revokeToken(_token: string): Promise<boolean> {
    return true;
  }

  public async deleteAllSpam(): Promise<DeleteAllSpamResponse> {
    return { success: true };
  }

  public async getRawEmail(id: string): Promise<string> {
    const folder = 'INBOX';
    return this.withImap(folder, async (client) => {
      const uid = parseInt(id, 10);
      const raw = await client.fetch(uid);
      return raw || '';
    });
  }

  public getScope(): string {
    return 'imap';
  }
}
