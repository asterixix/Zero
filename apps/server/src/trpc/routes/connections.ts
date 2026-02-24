import { createRateLimiterMiddleware, privateProcedure, publicProcedure, router } from '../trpc';
import { getActiveConnection, getZeroDB, encryptPassword } from '../../lib/server-utils';
import { connection, imapSmtpConfig } from '../../db/schema';
import { discoverFolders } from '../../lib/driver/imap-utils';
import { Ratelimit } from '@upstash/ratelimit';
import { TRPCError } from '@trpc/server';
import { WorkerMailer } from 'worker-mailer';
import { createDb } from '../../db';
import { CFImap } from 'cf-imap';
import { env } from '../../env';
import { z } from 'zod';

export const connectionsRouter = router({
  list: privateProcedure
    .use(
      createRateLimiterMiddleware({
        limiter: Ratelimit.slidingWindow(120, '1m'),
        generatePrefix: ({ sessionUser }) => `ratelimit:get-connections-${sessionUser?.id}`,
      }),
    )
    .query(async ({ ctx }) => {
      const { sessionUser } = ctx;
      const db = await getZeroDB(sessionUser.id);
      const connections = await db.findManyConnections();

      const disconnectedIds = connections
        .filter((c) => c.providerId !== 'imap' && (!c.accessToken || !c.refreshToken))
        .map((c) => c.id);

      return {
        connections: connections.map((connection) => {
          return {
            id: connection.id,
            email: connection.email,
            name: connection.name,
            picture: connection.picture,
            createdAt: connection.createdAt,
            providerId: connection.providerId,
          };
        }),
        disconnectedIds,
      };
    }),
  setDefault: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { connectionId } = input;
      const user = ctx.sessionUser;
      const db = await getZeroDB(user.id);
      const foundConnection = await db.findUserConnection(connectionId);
      if (!foundConnection) throw new TRPCError({ code: 'NOT_FOUND' });
      await db.updateUser({ defaultConnectionId: connectionId });
    }),
  delete: privateProcedure
    .input(z.object({ connectionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { connectionId } = input;
      const user = ctx.sessionUser;
      const db = await getZeroDB(user.id);
      await db.deleteConnection(connectionId);

      const activeConnection = await getActiveConnection();
      if (connectionId === activeConnection.id) await db.updateUser({ defaultConnectionId: null });
    }),
  getDefault: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.sessionUser) return null;
    const connection = await getActiveConnection();
    return {
      id: connection.id,
      email: connection.email,
      name: connection.name,
      picture: connection.picture,
      createdAt: connection.createdAt,
      providerId: connection.providerId,
    };
  }),

  testImapConnection: privateProcedure
    .input(
      z.object({
        imapHost: z.string().min(1),
        imapPort: z.number().int().min(1).max(65535),
        imapSecure: z.boolean(),
        smtpHost: z.string().min(1),
        smtpPort: z.number().int().min(1).max(65535),
        smtpSecure: z.boolean(),
        username: z.string().min(1),
        password: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      // Test IMAP connectivity + discover folders
      const imapClient = new CFImap({
        host: input.imapHost,
        port: input.imapPort,
        tls: input.imapSecure,
        auth: { username: input.username, password: input.password },
      });

      try {
        await imapClient.connect();
        const rawList = await imapClient.list();
        const folders = discoverFolders(rawList);
        await imapClient.logout().catch(() => void 0);

        // Test SMTP connectivity
        const mailer = await WorkerMailer.connect({
          host: input.smtpHost,
          port: input.smtpPort,
          secure: input.smtpSecure,
          credentials: { username: input.username, password: input.password },
        });
        await mailer.close();

        return { success: true as const, folders };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Connection failed';
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `IMAP/SMTP connection test failed: ${message}`,
        });
      }
    }),

  createImapConnection: privateProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string().optional(),
        imapHost: z.string().min(1),
        imapPort: z.number().int().min(1).max(65535),
        imapSecure: z.boolean(),
        smtpHost: z.string().min(1),
        smtpPort: z.number().int().min(1).max(65535),
        smtpSecure: z.boolean(),
        username: z.string().min(1),
        password: z.string().min(1),
        sentFolder: z.string().default('Sent'),
        trashFolder: z.string().default('Trash'),
        draftsFolder: z.string().default('Drafts'),
        spamFolder: z.string().default('Junk'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { sessionUser } = ctx;
      const { db, conn } = createDb(env.HYPERDRIVE.connectionString);

      try {
        const connectionId = crypto.randomUUID();
        const configId = crypto.randomUUID();
        const now = new Date();
        const encrypted = await encryptPassword(input.password, env.IMAP_ENCRYPTION_KEY);

        // Create connection record
        await db.insert(connection).values({
          id: connectionId,
          userId: sessionUser.id,
          email: input.email,
          name: input.name ?? input.email,
          picture: null,
          accessToken: null,
          refreshToken: null,
          scope: 'imap',
          providerId: 'imap',
          expiresAt: new Date('2099-12-31T23:59:59Z'), // IMAP doesn't expire via OAuth
          createdAt: now,
          updatedAt: now,
        });

        // Create IMAP/SMTP config record
        await db.insert(imapSmtpConfig).values({
          id: configId,
          connectionId,
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapSecure: input.imapSecure,
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpSecure: input.smtpSecure,
          smtpRequireTls: !input.smtpSecure, // If not implicit TLS, require STARTTLS
          imapUsername: input.username,
          encryptedPassword: encrypted,
          sentFolder: input.sentFolder,
          trashFolder: input.trashFolder,
          draftsFolder: input.draftsFolder,
          spamFolder: input.spamFolder,
        });

        // Start IMAP sync worker
        const syncWorkerId = env.IMAP_SYNC_WORKER.idFromName(connectionId);
        const syncWorker = env.IMAP_SYNC_WORKER.get(syncWorkerId);
        await syncWorker.startSync(connectionId);

        return { connectionId };
      } finally {
        await conn.end();
      }
    }),
});
