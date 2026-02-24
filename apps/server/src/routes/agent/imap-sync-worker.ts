import { buildParsedMessage, type DiscoveredFolders } from '../../lib/driver/imap-utils';
import { connection, imapSmtpConfig } from '../../db/schema';
import { DurableObject } from 'cloudflare:workers';
import { simpleParser } from 'mailparser';
import type { ZeroEnv } from '../../env';
import { createDb } from '../../db';
import { eq } from 'drizzle-orm';
import { CFImap } from 'cf-imap';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_SIZE = 20; // match Twenty's production batch size
const FOLDERS_TO_SYNC = ['INBOX']; // expand as needed

export class ImapSyncWorker extends DurableObject<ZeroEnv> {
  constructor(state: DurableObjectState, env: ZeroEnv) {
    super(state, env);
  }

  // Called by CF Workers runtime on schedule
  async alarm() {
    const connectionId = await this.ctx.storage.get<string>('connectionId');
    if (!connectionId) return;

    try {
      await this.syncConnection(connectionId);
    } catch (err) {
      console.error(`[ImapSyncWorker] Sync failed for ${connectionId}:`, err);
    } finally {
      // Always reschedule, even on error
      await this.ctx.storage.setAlarm(Date.now() + SYNC_INTERVAL_MS);
    }
  }

  // Called when a connection is first created
  async startSync(connectionId: string): Promise<void> {
    await this.ctx.storage.put('connectionId', connectionId);
    await this.ctx.storage.setAlarm(Date.now() + 10_000); // first sync in 10s
  }

  async stopSync(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('connectionId');
  }

  private async syncConnection(connectionId: string): Promise<void> {
    const { db, conn } = createDb(this.env.HYPERDRIVE.connectionString);

    try {
      const [connRow] = await db
        .select()
        .from(connection)
        .where(eq(connection.id, connectionId))
        .limit(1);

      const [config] = await db
        .select()
        .from(imapSmtpConfig)
        .where(eq(imapSmtpConfig.connectionId, connectionId))
        .limit(1);

      if (!connRow || !config) return;

      const decryptedPassword = await this.decryptPassword(config.encryptedPassword);
      const discovered: DiscoveredFolders = {
        sent: config.sentFolder,
        trash: config.trashFolder,
        drafts: config.draftsFolder,
        spam: config.spamFolder,
      };

      for (const folder of FOLDERS_TO_SYNC) {
        await this.syncFolder(
          connectionId,
          folder,
          config,
          decryptedPassword,
          discovered,
          connRow.userId,
        );
      }
    } finally {
      await conn.end();
    }
  }

  private async syncFolder(
    connectionId: string,
    folder: string,
    config: typeof imapSmtpConfig.$inferSelect,
    password: string,
    discovered: DiscoveredFolders,
    _userId: string,
  ): Promise<void> {
    const cursor = config.syncCursor;

    const client = new CFImap({
      host: config.imapHost,
      port: config.imapPort,
      tls: config.imapSecure,
      auth: { username: config.imapUsername, password },
    });

    await client.connect();
    await client.select(folder);

    try {
      // Search for new UIDs since last sync
      const searchOpts = cursor?.highestUid ? { uid: `${cursor.highestUid + 1}:*` } : { all: true };

      const newUids: number[] = await client.search(searchOpts);
      if (!newUids.length) return;

      // Sort ascending, process oldest first (follows Twenty's pattern)
      newUids.sort((a, b) => a - b);

      // Process in batches of BATCH_SIZE (20) — same as Twenty CRM production
      for (let i = 0; i < newUids.length; i += BATCH_SIZE) {
        const batch = newUids.slice(i, i + BATCH_SIZE);
        await this.processBatch(batch, folder, client, connectionId, discovered);
      }

      // Update sync cursor
      const highestUid = Math.max(...newUids, cursor?.highestUid ?? 0);
      const { db: updateDb, conn: updateConn } = createDb(this.env.HYPERDRIVE.connectionString);
      try {
        await updateDb
          .update(imapSmtpConfig)
          .set({
            syncCursor: { highestUid, uidValidity: cursor?.uidValidity ?? 0 },
            lastSyncAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(imapSmtpConfig.connectionId, connectionId));
      } finally {
        await updateConn.end();
      }
    } finally {
      await client.logout().catch(() => void 0);
    }
  }

  private async processBatch(
    uids: number[],
    folder: string,
    client: CFImap,
    connectionId: string,
    discovered: DiscoveredFolders,
  ): Promise<void> {
    for (const uid of uids) {
      try {
        const raw = await client.fetch(uid);
        if (!raw) continue;

        const parsed = await simpleParser(raw, {
          skipTextToHtml: true,
          skipImageLinks: true,
          skipTextLinks: true,
          keepCidLinks: false,
        });

        const message = buildParsedMessage(uid, folder, connectionId, parsed, discovered);

        // Store in R2 — same as ThreadSyncWorker pattern
        await this.env.THREADS_BUCKET.put(
          `${connectionId}/${message.id}.json`,
          JSON.stringify({
            messages: [message],
            latest: message,
            hasUnread: message.unread,
            totalReplies: 1,
            labels: message.tags,
          }),
          { customMetadata: { threadId: message.id } },
        );
      } catch (err) {
        console.error(`[ImapSyncWorker] Failed to process UID ${uid} in ${folder}:`, err);
      }
    }
  }

  private async decryptPassword(encrypted: string): Promise<string> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.env.IMAP_ENCRYPTION_KEY),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const data = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = data.slice(0, 12);
    const ciphertext = data.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyMaterial, ciphertext);
    return new TextDecoder().decode(decrypted);
  }
}
