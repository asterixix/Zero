# Zero: Full Migration to Vercel - Implementation Plan

> **Status**: Implementation Plan
> **Created**: 2026-02-23
> **Estimated Effort**: 4-8 weeks

---

## Executive Summary

This document provides a detailed implementation plan for migrating Zero from Cloudflare Workers to Vercel, addressing the three critical blockers:

| Blocker                         | Solution                                                          | Complexity |
| ------------------------------- | ----------------------------------------------------------------- | ---------- |
| **Durable Objects** (8 classes) | **Rivet Actors** - Open-source DO alternative that runs on Vercel | High       |
| **Cloudflare Workflows** (2)    | **Inngest** - Durable functions for serverless                    | Medium     |
| **Cloudflare Queues** (3)       | **Inngest + QStash** - Event-driven + message queue               | Medium     |

---

## Part 1: Durable Objects Migration

### Solution: Rivet Actors

**Rivet Actors** is an open-source library that provides the same programming model as Cloudflare Durable Objects, but runs on Vercel Functions, Node.js, Bun, or Cloudflare Workers.

**Key Features:**

- ✅ Stateful, long-lived compute
- ✅ Durable state persistence
- ✅ Built-in WebSocket/realtime
- ✅ Actor-to-actor communication
- ✅ Scheduling (like DO alarms)
- ✅ Infinite scaling
- ✅ Works on Vercel Functions

**Repository:** https://github.com/rivet-dev/rivetkit (1,241 stars)

### Zero's DO Inventory

| DO Class           | File                         | Purpose             | State Type         | Migration Approach                     |
| ------------------ | ---------------------------- | ------------------- | ------------------ | -------------------------------------- |
| `ZeroDB`           | `main.ts:205`                | Per-user DB ops     | PostgreSQL         | Already uses Postgres, minimal changes |
| `ZeroAgent`        | `agent/index.ts:1700`        | AI chat, WebSocket  | SQLite + in-memory | Rivet Actor with WebSocket             |
| `ZeroDriver`       | `agent/index.ts:322`         | Email driver        | SQLite             | Rivet Actor with external SQL          |
| `ZeroMCP`          | `agent/mcp.ts`               | MCP server          | In-memory          | Rivet Actor with state                 |
| `ThinkingMCP`      | `lib/sequential-thinking.ts` | Sequential thinking | SQLite             | Rivet Actor                            |
| `WorkflowRunner`   | `pipelines.ts:132`           | Pipeline execution  | In-memory          | Convert to Inngest                     |
| `ThreadSyncWorker` | `agent/sync-worker.ts`       | Background sync     | None               | Convert to Inngest function            |
| `ShardRegistry`    | `agent/index.ts:310`         | Distributed state   | SQLite             | Rivet Actor with external SQL          |

### Migration Mapping

```
Cloudflare Durable Objects          →    Rivet Actors
─────────────────────────────────────────────────────────
class MyDO extends DurableObject    →    const myActor = actor({ ... })
ctx.storage                         →    c.state (auto-persisted)
ctx.storage.sql                     →    External SQL or c.state
this.env.OTHER_DO                   →    c.client<typeof registry>().otherActor
WebSocket hibernation               →    Built-in WebSocket support
alarms                              →    c.schedule.after() / c.schedule.at()
DurableObjectStub                   →    Actor handle from client
```

### Implementation: Step-by-Step

#### Step 1: Install Rivet Dependencies

```bash
cd apps/server
pnpm add rivetkit
```

#### Step 2: Create Rivet Actor Registry

Create `apps/server/src/actors/registry.ts`:

```typescript
import { createShardRegistry } from './shard-registry';
import { createThinkingMCP } from './thinking-mcp';
import { createZeroDriver } from './zero-driver';
import { createZeroAgent } from './zero-agent';
import { createZeroMCP } from './zero-mcp';
import { createZeroDB } from './zero-db';
import { actor, setup } from 'rivetkit';

// Export all actors
export const zeroAgent = createZeroAgent();
export const zeroDriver = createZeroDriver();
export const zeroMCP = createZeroMCP();
export const thinkingMCP = createThinkingMCP();
export const shardRegistry = createShardRegistry();
export const zeroDB = createZeroDB();

// Create registry
export const registry = setup({
  use: {
    zeroAgent,
    zeroDriver,
    zeroMCP,
    thinkingMCP,
    shardRegistry,
    zeroDB,
  },
});
```

#### Step 3: Migrate ZeroAgent

**Before (Cloudflare Durable Object):**

```typescript
// apps/server/src/routes/agent/index.ts
export class ZeroAgent extends AIChatAgent<ZeroEnv> {
  async onMessage(connection: Connection, message: WSMessage) {
    // Handle WebSocket messages
  }

  broadcastChatMessage(message: OutgoingMessage) {
    this.broadcast(JSON.stringify(message));
  }
}
```

**After (Rivet Actor):**

```typescript
// apps/server/src/actors/zero-agent.ts
import type { OutgoingMessage, IncomingMessage } from '../types';
import { actor } from 'rivetkit';

interface ZeroAgentState {
  messages: any[];
  name: string;
}

interface ConnState {
  userId: string;
}

export function createZeroAgent() {
  return actor({
    state: { messages: [], name: 'general' } as ZeroAgentState,

    createConnState: (c, params: { userId: string }): ConnState => ({
      userId: params.userId,
    }),

    onCreate: (c) => {
      console.log(`ZeroAgent created: ${c.key}`);
    },

    onConnect: (c, conn) => {
      // Send initial state
      conn.send(
        JSON.stringify({
          type: 'mail_list',
          folder: 'inbox',
        }),
      );
    },

    actions: {
      // Chat message handling
      sendChatMessage: async (c, message: IncomingMessage) => {
        c.state.messages.push(message);
        c.broadcast('chatMessage', message);
      },

      // Broadcast to all connections
      broadcastChatMessage: (c, message: OutgoingMessage, exclude?: string[]) => {
        c.broadcast('chatMessage', message);
      },

      // Get cached DO state
      getCachedDoState: async (c) => {
        return c.state;
      },

      // Clear chat
      clearChat: (c) => {
        c.state.messages = [];
        c.broadcast('chatClear', {});
      },
    },
  });
}
```

#### Step 4: Migrate ZeroDriver

**Before (Cloudflare Durable Object with SQLite):**

```typescript
// apps/server/src/routes/agent/index.ts
@Queryable()
export class ZeroDriver extends DurableObject<ZeroEnv> {
  sql: SqlStorage;
  private db: DB;

  constructor(ctx: DurableObjectState, env: ZeroEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.db = drizzle(ctx.storage, { schema });
  }

  async getThread(threadId: string) {
    return await this.getThreadFromDB(threadId);
  }
}
```

**After (Rivet Actor with External SQL):**

```typescript
// apps/server/src/actors/zero-driver.ts
import * as schema from '../routes/agent/db/schema';
import { drizzle } from 'drizzle-orm/postgres-js';
import { actor } from 'rivetkit';
import postgres from 'postgres';

interface ZeroDriverState {
  connectionId: string;
  // Cache for recent operations
  recipientCache: { contacts: any[]; hash: string } | null;
}

export function createZeroDriver() {
  return actor({
    state: {
      connectionId: '',
      recipientCache: null,
    } as ZeroDriverState,

    // Use external PostgreSQL instead of DO's SQLite
    createVars: () => ({
      db: null as any, // Will be initialized lazily
    }),

    actions: {
      setName: async (c, name: string) => {
        c.state.connectionId = name;
        c.vars.db = drizzle(postgres(process.env.DATABASE_URL!), { schema });
      },

      getThread: async (c, threadId: string) => {
        const { get } = await import('../routes/agent/db');
        return await get(c.vars.db, { id: threadId });
      },

      getThreadsFromDB: async (c, params: any) => {
        const { list, findThreadsByFolder } = await import('../routes/agent/db');
        // Use the database connection from vars
        return await findThreadsByFolder(c.vars.db, params.folder?.toUpperCase());
      },

      syncThread: async (c, { threadId }: { threadId: string }) => {
        // Trigger Inngest workflow instead of using DO
        const { inngest } = await import('../inngest/client');
        await inngest.send({
          name: 'thread/sync',
          data: {
            connectionId: c.state.connectionId,
            threadId,
          },
        });
      },

      modifyLabels: async (c, threadIds: string[], addLabels: string[], removeLabels: string[]) => {
        const { modifyThreadLabels } = await import('../routes/agent/db');
        await modifyThreadLabels(c.vars.db, threadIds[0], addLabels, removeLabels);

        // Broadcast update to connected clients
        c.broadcast('mailUpdated', { threadId: threadIds[0] });
      },

      suggestRecipients: async (c, query: string, limit: number = 10) => {
        // Cache logic similar to original
        const threads = await c.vars.db.select().from(schema.threads).limit(100);

        // Process and return suggestions
        return threads.slice(0, limit);
      },
    },
  });
}
```

#### Step 5: Integrate with Hono

```typescript
// apps/server/api/index.ts
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { registry } from "../src/actors/registry";

const app = new Hono();

// Mount Rivet actor API
app.all("/api/rivet/*", (c) => registry.handler(c.req.raw));

// Mount tRPC
app.use("/api/trpc/*", trpcServer({ ... }));

// Mount other routes
app.route("/api", apiRouter);

export default handle(app);
```

---

## Part 2: Workflows Migration

### Solution: Inngest

**Inngest** provides durable execution for serverless functions with automatic retries, state management, and step functions.

**Key Features:**

- ✅ Durable step functions
- ✅ Automatic retries
- ✅ Wait for events
- ✅ Scheduling/delays
- ✅ Vercel native
- ✅ TypeScript-first

### Zero's Workflows Inventory

| Workflow                         | Purpose                   | Migration        |
| -------------------------------- | ------------------------- | ---------------- |
| `SyncThreadsWorkflow`            | Sync email threads        | Inngest function |
| `SyncThreadsCoordinatorWorkflow` | Coordinate multiple syncs | Inngest function |

### Implementation: Step-by-Step

#### Step 1: Install Inngest

```bash
cd apps/server
pnpm add inngest
```

#### Step 2: Create Inngest Client

```typescript
// apps/server/src/inngest/client.ts
import { Inngest } from 'inngest';

export const inngest = new Inngest({
  id: 'zero-email',
  eventKey: process.env.INNGEST_EVENT_KEY!,
});
```

#### Step 3: Create Workflow Functions

```typescript
// apps/server/src/inngest/functions/thread-sync.ts
import { inngest } from '../client';

export const syncThreadsWorkflow = inngest.createFunction(
  { id: 'sync-threads-workflow' },
  { event: 'thread/sync.request' },
  async ({ event, step }) => {
    const { connectionId, folder, historyId } = event.data;

    // Step 1: Get connection details
    const connection = await step.run('get-connection', async () => {
      const { db } = await import('../../db');
      return await db.query.connection.findFirst({
        where: (c, { eq }) => eq(c.id, connectionId),
      });
    });

    if (!connection) {
      return { success: false, reason: 'Connection not found' };
    }

    // Step 2: Get driver and fetch threads
    const threads = await step.run('fetch-threads', async () => {
      const { connectionToDriver } = await import('../../lib/server-utils');
      const driver = connectionToDriver(connection);
      return await driver.list({ folder, maxResults: 60 });
    });

    // Step 3: Store threads in database
    await step.run('store-threads', async () => {
      const { create } = await import('../../routes/agent/db');
      const { db } = await import('../../db');

      for (const thread of threads.threads) {
        await create(
          db,
          {
            id: thread.id,
            threadId: thread.id,
            providerId: connection.providerId,
            // ... other fields
          },
          [],
        );
      }
    });

    // Step 4: Update vector index (parallel)
    await step.run('update-vectors', async () => {
      const { Index } = await import('@upstash/vector');
      const index = new Index({
        url: process.env.UPSTASH_VECTOR_URL!,
        token: process.env.UPSTASH_VECTOR_TOKEN!,
      });

      // Upsert thread embeddings
      // ...
    });

    return { success: true, synced: threads.threads.length };
  },
);

export const syncThreadsCoordinator = inngest.createFunction(
  { id: 'sync-threads-coordinator' },
  { event: 'thread/sync.coordinator' },
  async ({ event, step }) => {
    const { connectionId, folder } = event.data;

    // Run multiple pages of sync in parallel
    const pages = await step.run('sync-pages', async () => {
      const results = [];
      let pageToken: string | undefined;

      for (let i = 0; i < 10; i++) {
        // Max 10 pages
        const result = await inngest.send({
          name: 'thread/sync.request',
          data: { connectionId, folder, pageToken },
        });
        results.push(result);

        if (!pageToken) break;
      }

      return results;
    });

    return { pages: pages.length };
  },
);
```

#### Step 4: Create Inngest Serve Handler

```typescript
// apps/server/api/inngest.ts
import { syncThreadsWorkflow, syncThreadsCoordinator } from '../src/inngest/functions/thread-sync';
import { inngest } from '../src/inngest/client';
import { serve } from 'inngest/next';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    syncThreadsWorkflow,
    syncThreadsCoordinator,
    // Add more functions here
  ],
});
```

---

## Part 3: Queues Migration

### Solution: Inngest (Primary) + QStash (Fallback)

**Inngest** handles event-driven workflows. **QStash** provides reliable message delivery for external webhooks.

### Zero's Queues Inventory

| Queue              | Purpose                       | Migration          |
| ------------------ | ----------------------------- | ------------------ |
| `thread_queue`     | Gmail notification processing | Inngest event      |
| `subscribe_queue`  | Subscription renewal          | Inngest scheduled  |
| `send_email_queue` | Scheduled email sending       | Inngest with delay |

### Implementation: Step-by-Step

#### Step 1: Replace Queue.send() with Inngest Events

**Before:**

```typescript
// main.ts
await env.thread_queue.send({
  providerId,
  historyId: body.historyId,
  subscriptionName: subHeader,
});
```

**After:**

```typescript
// api/webhooks.ts
import { inngest } from '../src/inngest/client';

await inngest.send({
  name: 'gmail/notification',
  data: {
    providerId,
    historyId: body.historyId,
    subscriptionName: subHeader,
  },
});
```

#### Step 2: Create Queue Handler Functions

```typescript
// apps/server/src/inngest/functions/queue-handlers.ts
import { inngest } from '../client';

// Thread queue handler
export const processThreadQueue = inngest.createFunction(
  { id: 'process-thread-queue' },
  { event: 'gmail/notification' },
  async ({ event, step }) => {
    const { providerId, historyId, subscriptionName } = event.data;

    // Process the notification
    await step.run('process-notification', async () => {
      // Call driver to process history
      // ...
    });

    return { success: true };
  },
);

// Subscribe queue handler
export const processSubscribeQueue = inngest.createFunction(
  { id: 'process-subscribe-queue' },
  { event: 'subscription/renew' },
  async ({ event, step }) => {
    const { connectionId, providerId } = event.data;

    await step.run('renew-subscription', async () => {
      const { enableBrainFunction } = await import('../../lib/brain');
      await enableBrainFunction({ id: connectionId, providerId });
    });

    return { success: true };
  },
);

// Send email queue handler with delay
export const processSendEmailQueue = inngest.createFunction(
  { id: 'process-send-email-queue' },
  { event: 'email/send-scheduled' },
  async ({ event, step }) => {
    const { messageId, connectionId, sendAt } = event.data;

    // Wait until send time
    const delayMs = Math.max(0, sendAt - Date.now());
    if (delayMs > 0) {
      await step.sleep(`wait-until-${messageId}`, delayMs);
    }

    // Check if cancelled
    const status = await step.run('check-status', async () => {
      const { kv } = await import('@vercel/kv');
      return await kv.get(`email:status:${messageId}`);
    });

    if (status === 'cancelled') {
      return { success: false, reason: 'cancelled' };
    }

    // Send the email
    await step.run('send-email', async () => {
      // Get driver and send
      // ...
    });

    return { success: true };
  },
);
```

#### Step 3: Scheduled Functions (Cron Replacement)

```typescript
// apps/server/src/inngest/functions/scheduled.ts
import { inngest } from '../client';

// Hourly cron: Process scheduled emails
export const hourlyScheduledEmails = inngest.createFunction(
  { id: 'hourly-scheduled-emails' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const { kv } = await import('@vercel/kv');

    // Get all scheduled emails ready to send
    const keys = await step.run('get-scheduled', async () => {
      const now = Date.now();
      const twelveHoursFromNow = now + 12 * 60 * 60 * 1000;

      const emails: any[] = [];
      let cursor: string | undefined;

      do {
        const result = await kv.scan(cursor, {
          match: 'email:scheduled:*',
          count: 100,
        });
        cursor = result[0];
        // Process keys...
      } while (cursor);

      return emails;
    });

    // Queue each email
    for (const email of keys) {
      await inngest.send({
        name: 'email/send-scheduled',
        data: email,
      });
    }

    return { queued: keys.length };
  },
);

// Hourly cron: Renew expired subscriptions
export const hourlySubscriptionRenewal = inngest.createFunction(
  { id: 'hourly-subscription-renewal' },
  { cron: '0 * * * *' },
  async ({ step }) => {
    const { db } = await import('../../db');

    // Find expired subscriptions
    const expired = await step.run('find-expired', async () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      // Query database...
      return [];
    });

    // Queue renewal for each
    for (const sub of expired) {
      await inngest.send({
        name: 'subscription/renew',
        data: { connectionId: sub.id, providerId: sub.providerId },
      });
    }

    return { renewed: expired.length };
  },
);
```

---

## Part 4: Service Mappings

### KV Namespaces → Vercel KV

```typescript
// Before (Cloudflare)
const value = await env.gmail_history_id.get(key);

// After (Vercel KV)
import { kv } from '@vercel/kv';
const value = await kv.get(key);
```

### R2 Buckets → Vercel Blob

```typescript
// Before (Cloudflare)
await env.THREADS_BUCKET.put(key, data);
const object = await env.THREADS_BUCKET.get(key);

// After (Vercel Blob)
import { put, list, del } from '@vercel/blob';

await put(key, data, { access: 'public' });
const blob = await list({ prefix: key });
```

### Vectorize → Upstash Vector

```typescript
// Before (Cloudflare)
await env.VECTORIZE.insert(vectors);
const results = await env.VECTORIZE.query(vector, { topK: 10 });

// After (Upstash)
import { Index } from '@upstash/vector';

const index = new Index({
  url: process.env.UPSTASH_VECTOR_URL!,
  token: process.env.UPSTASH_VECTOR_TOKEN!,
});

await index.upsert(vectors);
const results = await index.query(vector, { topK: 10 });
```

### Hyperdrive → Vercel Postgres / Neon

```typescript
// Before (Cloudflare)
const db = drizzle(env.HYPERDRIVE.connectionString);

// After (Vercel Postgres)
import { drizzle } from 'drizzle-orm/vercel-postgres';
import { sql } from '@vercel/postgres';

const db = drizzle(sql);
```

---

## Part 5: Migration Timeline

### Week 1-2: Foundation

- [ ] Set up Vercel project
- [ ] Install dependencies (Rivet, Inngest, Upstash)
- [ ] Create Rivet actor registry
- [ ] Set up Inngest client and serve handler
- [ ] Configure environment variables

### Week 3-4: Durable Objects Migration

- [ ] Migrate `ZeroDB` (simplest - already uses Postgres)
- [ ] Migrate `ShardRegistry`
- [ ] Migrate `ZeroMCP` and `ThinkingMCP`
- [ ] Migrate `ZeroDriver` (complex - SQLite to Postgres)
- [ ] Migrate `ZeroAgent` (complex - WebSocket)

### Week 5-6: Workflows & Queues

- [ ] Create Inngest functions for thread sync
- [ ] Create Inngest functions for queue handlers
- [ ] Set up scheduled functions (cron)
- [ ] Replace all `queue.send()` calls

### Week 7-8: Storage & Testing

- [ ] Migrate KV to Vercel KV
- [ ] Migrate R2 to Vercel Blob
- [ ] Migrate Vectorize to Upstash Vector
- [ ] Replace Hyperdrive with Vercel Postgres
- [ ] Integration testing
- [ ] Load testing
- [ ] Production deployment

---

## Part 6: Cost Comparison

### Current (Cloudflare)

| Service         | Monthly Cost     |
| --------------- | ---------------- |
| Workers Paid    | $5               |
| Durable Objects | ~$10-50          |
| KV              | $0.50/GB         |
| R2              | $0.015/GB        |
| Vectorize       | $0.20/1M vectors |
| **Total**       | ~$20-70/month    |

### After Migration (Vercel)

| Service                | Monthly Cost   |
| ---------------------- | -------------- |
| Vercel Pro             | $20            |
| Inngest                | $0-20          |
| Upstash Redis          | $0-10          |
| Upstash Vector         | $10-30         |
| Vercel Blob            | $0.15/GB       |
| Rivet Cloud (optional) | $0-50          |
| **Total**              | ~$30-130/month |

---

## Part 7: Rollback Plan

1. **Keep Cloudflare infrastructure running for 30 days**
2. **Database migration is reversible** (Postgres stays the same)
3. **KV data can be synced back** to Cloudflare KV
4. **Rivet Actors can be deployed to Cloudflare** if needed

---

## References

- [Rivet Actors Documentation](https://rivet.gg/docs/actors)
- [Rivet GitHub](https://github.com/rivet-dev/rivetkit)
- [Inngest Documentation](https://www.inngest.com/docs)
- [Upstash QStash](https://upstash.com/docs/qstash)
- [Vercel KV](https://vercel.com/docs/storage/vercel-kv)
- [Vercel Blob](https://vercel.com/docs/storage/vercel-blob)
