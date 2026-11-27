import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { JSONContent } from '@tiptap/core';
import type { Extension } from '@hocuspocus/server';
import {
  collectMediaIds,
  CURRENT_SCHEMA_VERSION,
  EMPTY_DOC,
  extractText,
  hasPermission,
  idSchema,
  LIMITS,
  Permission,
  validateDoc,
  type CollabRefusal,
  type CollabServerMessage,
  type CollabStatsDto,
  type SnapshotReason,
} from '@os-planner/shared';
import { COLLAB_LIMITS, collabColor, jsonToYDoc, yDocToJSON } from '@os-planner/shared/collab';
import * as Y from 'yjs';
import { TokenService } from '../auth/token.service.js';
import { newId } from '../common/crypto.js';
import { jsonEquals } from '../common/stable-json.js';
import { ENV, type Env } from '../config/env.js';
import { EventBus } from '../events/event-bus.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ChangeSeqService } from '../prisma/change-seq.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { PermissionService } from '../spaces/permission.service.js';
import { docBytes } from '../tree/pages.service.js';
import { CollabRegistry, type CollabContext } from './collab.registry.js';

const FORBIDDEN = 'forbidden';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Session-end and hourly snapshots: the newest 50 are kept, then one per day for 30 days. */
export const SNAPSHOTS_KEPT = 50;
export const SNAPSHOT_DAYS = 30;
/** A document whose state grows past this many times the document limit is cut off (a client is flooding it). */
const STATE_CAP = 4;
/** How often a store that left a picture or video out of the page's file list tries again (the file was not uploaded yet). */
const RELINK_MS = 10_000;
const RELINK_TRIES = 12;

/** The reasons a connection is closed on purpose (the provider reconnects after the first and stops after the second). */
export const RESET = { code: 4205, reason: 'Reset Connection' };
export const CLOSE_FORBIDDEN = { code: 4403, reason: 'Forbidden' };

const bytes = (u: Uint8Array): Buffer<ArrayBuffer> =>
  Buffer.from(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer);

/**
 * What the co-editing server does at each step of a page's life: who may connect (the same access function as REST), loading
 * the Yjs document (building it from the page's JSON the first time), storing it (deriving the JSON, text, size and version
 * the rest of the application reads), snapshots, and the limits that keep one connection from hurting the others.
 */
@Injectable()
export class CollabService {
  private readonly log = new Logger(CollabService.name);
  /** When each loaded page was last snapshotted (or loaded): drives the hourly snapshot. */
  private readonly lastSnapshot = new Map<string, number>();
  /** Bytes of updates received per loaded page since the size was last measured. */
  private readonly received = new Map<string, number>();
  /** Pages changed since their last snapshot, and who changed them last. */
  private readonly touched = new Map<string, string | null>();
  private readonly relink = new Map<string, number>();
  readonly stats_ = {
    stores: 0,
    /** Time spent storing pages (deriving the JSON and writing it), for /api/metrics. */
    storeSeconds: 0,
    refused: { too_large: 0, quota: 0, invalid: 0 } as Record<CollabRefusal, number>,
    rejectedConnections: 0,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly perms: PermissionService,
    private readonly seq: ChangeSeqService,
    private readonly quota: QuotaService,
    private readonly bus: EventBus,
    private readonly registry: CollabRegistry,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ------------------------------------------------------------------ access

  /**
   * What a person may do on a page right now: `edit`, `read`, or null (no such page, or not theirs to see: the same answer).
   * The same decision as REST (`PermissionService.notebookAccess`), plus: nothing can be edited in the trash.
   */
  async accessTo(
    userId: string,
    pageId: string,
  ): Promise<{ canEdit: boolean; spaceId: string; notebookId: string } | null> {
    if (!idSchema.safeParse(pageId).success) return null;
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { spaceId: true, notebookId: true, deletedAt: true },
    });
    if (!page) return null;
    const access = await this.perms.notebookAccess(userId, page.notebookId);
    if (!access || !hasPermission(access.perms, Permission.VIEW_NOTEBOOKS)) return null;
    const notebookTrashed = access.notebook.deletedAt !== null;
    return {
      canEdit:
        hasPermission(access.perms, Permission.EDIT_PAGES) &&
        page.deletedAt === null &&
        !notebookTrashed,
      spaceId: page.spaceId,
      notebookId: page.notebookId,
    };
  }

  /** Is this login still alive? (A signed-out session's access token stays valid until it expires on its own.) */
  async sessionAlive(userId: string, sessionId: string): Promise<boolean> {
    const live = await this.prisma.refreshToken.findFirst({
      where: { userId, familyId: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return live !== null;
  }

  // ------------------------------------------------------------------ the extension

  /** The hooks Hocuspocus calls. */
  extension(): Extension<CollabContext> {
    return {
      extensionName: 'os-planner',
      priority: 1000,

      onAuthenticate: async (p) => {
        const refuse = (): never => {
          this.stats_.rejectedConnections++;
          throw new Error(FORBIDDEN); // one answer for every reason: a page that is not yours looks like one that does not exist
        };
        const user =
          typeof p.token === 'string' && p.token.length < 4000
            ? await this.tokens.verifyAccess(p.token)
            : null;
        if (!user || !(await this.sessionAlive(user.id, user.sessionId))) return refuse();
        const access = await this.accessTo(user.id, p.documentName);
        if (!access) return refuse();

        const open = this.registry.contexts(p.documentName);
        if (open.length >= COLLAB_LIMITS.connectionsPerPage) return refuse();
        if (
          open.filter((c) => c.userId === user.id).length >= COLLAB_LIMITS.connectionsPerUserPerPage
        )
          return refuse();

        const account = await this.prisma.user.findUnique({
          where: { id: user.id },
          select: { displayName: true },
        });
        if (!account) return refuse();
        if (!access.canEdit) p.connectionConfig.readOnly = true;
        const now = Date.now();
        return {
          userId: user.id,
          sessionId: user.sessionId,
          name: account.displayName.slice(0, COLLAB_LIMITS.nameMax),
          pageId: p.documentName,
          spaceId: access.spaceId,
          notebookId: access.notebookId,
          canEdit: access.canEdit,
          connectedAt: now,
          tokens: COLLAB_LIMITS.updatesPerSecond * 2,
          tokensAt: now,
        } satisfies CollabContext;
      },

      connected: async (p) => {
        const c = p.context as CollabContext;
        // Several can authenticate at the same moment: the ones that came first stay, the rest are let go.
        const mine = this.registry.contexts(p.documentName).filter((x) => x.userId === c.userId);
        if (mine.indexOf(c) >= COLLAB_LIMITS.connectionsPerUserPerPage)
          (
            p.connection as unknown as { webSocket: { close(code: number, reason: string): void } }
          ).webSocket.close(CLOSE_FORBIDDEN.code, CLOSE_FORBIDDEN.reason);
      },

      onLoadDocument: async (p) => {
        await this.load(p.documentName, p.document);
      },

      // A connection may send so many messages per second; more than that closes it (the editor never gets near it).
      beforeHandleMessage: async (p) => {
        const c = p.context as CollabContext | undefined;
        if (!c || !('tokens' in c)) return;
        const now = Date.now();
        const burst = COLLAB_LIMITS.updatesPerSecond * 2;
        c.tokens = Math.min(
          burst,
          c.tokens + ((now - c.tokensAt) / 1000) * COLLAB_LIMITS.updatesPerSecond,
        );
        c.tokensAt = now;
        if (c.tokens < 1) throw new Error('rate limited'); // the message is dropped and Hocuspocus closes the connection
        c.tokens -= 1;
        // A flood of large updates must not grow a document without bound before it is ever stored.
        const total = (this.received.get(p.documentName) ?? 0) + p.update.byteLength;
        if (total > LIMITS.docMaxBytes) {
          this.received.set(p.documentName, 0);
          if (Y.encodeStateAsUpdate(p.document).byteLength > LIMITS.docMaxBytes * STATE_CAP) {
            this.stats_.refused.too_large++;
            throw new Error('document too large');
          }
        } else this.received.set(p.documentName, total);
      },

      // What a person shows the others is a name, a colour and a cursor. The name comes from the account, not from the client.
      beforeHandleAwareness: async (p) => {
        const c = p.context;
        if (!c || !('userId' in c)) return;
        for (const [clientId, state] of p.states) {
          const cursor = state['cursor'] as { anchor?: unknown; head?: unknown } | null | undefined;
          for (const key of Object.keys(state)) delete state[key];
          state['user'] = { name: c.name, color: collabColor(c.userId) };
          if (cursor && typeof cursor === 'object' && 'anchor' in cursor && 'head' in cursor)
            state['cursor'] = { anchor: cursor.anchor, head: cursor.head };
          void clientId;
        }
      },

      // "Store now" from a client that is about to export or leave: answered once the page is in the database.
      onStateless: async (p) => {
        let message: unknown;
        try {
          message = JSON.parse(p.payload);
        } catch {
          return;
        }
        if ((message as { t?: unknown } | null)?.t !== 'flush') return;
        const hp = this.registry.hocuspocus;
        if (!hp) return;
        const id = `onStoreDocument-${p.documentName}`;
        if (hp.debouncer.isDebounced(id)) await hp.debouncer.executeNow(id);
        else if (hp.debouncer.isCurrentlyExecuting(id)) await p.document.saveMutex.waitForUnlock();
        const page = await this.prisma.page.findUnique({
          where: { id: p.documentName },
          select: { version: true },
        });
        if (page)
          p.connection.sendStateless(
            JSON.stringify({ t: 'stored', version: page.version } satisfies CollabServerMessage),
          );
      },

      onChange: async (p) => {
        const c = p.context as Partial<CollabContext> | undefined;
        this.touched.set(p.documentName, c?.userId ?? this.touched.get(p.documentName) ?? null);
      },

      onStoreDocument: async (p) => {
        const c = p.lastContext as Partial<CollabContext> | undefined;
        await this.store(p.documentName, p.document, { lastUserId: c?.userId ?? null });
      },

      // The last person left and the page is written: what the session produced is kept as one version.
      beforeUnloadDocument: async (p) => {
        if (!this.touched.has(p.documentName)) return;
        const by = this.touched.get(p.documentName) ?? null;
        this.touched.delete(p.documentName);
        await this.snapshot(p.documentName, Y.encodeStateAsUpdate(p.document), 'session_end', by);
      },

      afterUnloadDocument: async (p) => {
        this.touched.delete(p.documentName);
        this.lastSnapshot.delete(p.documentName);
        this.received.delete(p.documentName);
        this.relink.delete(p.documentName);
      },
    };
  }

  // ------------------------------------------------------------------ loading

  /** Puts the page's Yjs state into `doc`; the first time, the state is built from the page's JSON and kept. */
  async load(pageId: string, doc: Y.Doc): Promise<void> {
    const row = await this.prisma.pageYDoc.findUnique({ where: { pageId } });
    this.lastSnapshot.set(pageId, Date.now());
    if (row) {
      Y.applyUpdate(doc, row.state);
      return;
    }
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: { content: true },
    });
    if (!page) throw new Error('page not found');
    const seed = jsonToYDoc(page.content as unknown as JSONContent);
    const state = Y.encodeStateAsUpdate(seed);
    // A second instance (or the batch job) may be doing the same: the build is deterministic, so whoever wins stores the same bytes.
    await this.prisma.pageYDoc.createMany({
      data: [{ pageId, state: bytes(state), stateVector: bytes(Y.encodeStateVector(seed)) }],
      skipDuplicates: true,
    });
    Y.applyUpdate(doc, state);
  }

  /** Builds the Yjs state of up to `limit` pages that have none yet (the batch migration). Returns how many were built. */
  async migrateBatch(limit = 200): Promise<number> {
    const pages = await this.prisma.page.findMany({
      where: { yDoc: null },
      select: { id: true, content: true },
      take: limit,
      orderBy: { id: 'asc' },
    });
    let built = 0;
    for (const page of pages) {
      try {
        const seed = jsonToYDoc(page.content as unknown as JSONContent);
        await this.prisma.pageYDoc.createMany({
          data: [
            {
              pageId: page.id,
              state: bytes(Y.encodeStateAsUpdate(seed)),
              stateVector: bytes(Y.encodeStateVector(seed)),
            },
          ],
          skipDuplicates: true,
        });
        built++;
      } catch (e) {
        this.log.warn(
          `page ${page.id} could not be converted: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    return built;
  }

  // ------------------------------------------------------------------ storing

  /**
   * Derives what the rest of the application reads (JSON, text, size, version, file list) from the document and writes it with
   * the Yjs state, in one transaction. A document that is invalid, over the size limit or would not fit the quota is refused as a whole: the
   * previous good state stays, the people in the page are told, and what they typed stays in their browsers.
   */
  async store(pageId: string, doc: Y.Doc, opts: { lastUserId: string | null }): Promise<void> {
    const started = performance.now();
    const hp = this.registry.hocuspocus;
    const tell = (message: CollabServerMessage) =>
      hp?.documents.get(pageId)?.broadcastStateless(JSON.stringify(message));
    const refuse = (reason: CollabRefusal, detail?: string) => {
      this.stats_.refused[reason]++;
      this.log.warn(`page ${pageId}: not stored (${reason}${detail ? `: ${detail}` : ''})`);
      tell({ t: 'refused', reason });
    };

    const state = Y.encodeStateAsUpdate(doc);
    let json: JSONContent;
    try {
      json = yDocToJSON(doc);
    } catch (e) {
      return refuse('invalid', e instanceof Error ? e.message : String(e));
    }
    if (!json.content?.length) json = EMPTY_DOC;
    const size = docBytes(json);
    if (size > LIMITS.docMaxBytes) return refuse('too_large');
    const checked = validateDoc(json);
    if (!checked.ok) return refuse('invalid', checked.error);
    const valid = checked.doc;
    const mediaIds = collectMediaIds(valid);
    const contentText = extractText(valid);
    const sizeBytes = docBytes(valid);

    let missingMedia = 0;
    let stored: { version: number; spaceId: string; changed: boolean } | null;
    try {
      stored = await this.prisma.$transaction(async (tx) => {
        const page = await tx.page.findUnique({
          where: { id: pageId },
          select: { spaceId: true, sizeBytes: true, content: true, version: true },
        });
        if (!page) return null; // purged while it was open
        const saveState = () =>
          tx.pageYDoc.upsert({
            where: { pageId },
            create: { pageId, state: bytes(state), stateVector: bytes(Y.encodeStateVector(doc)) },
            update: { state: bytes(state), stateVector: bytes(Y.encodeStateVector(doc)) },
          });

        if (jsonEquals(page.content, valid)) {
          await saveState();
          return { version: page.version, spaceId: page.spaceId, changed: false };
        }

        const seq = await this.seq.next(tx, page.spaceId);
        // Text counts toward the quota: growth is refused as a whole (413), shrinkage is refunded.
        await this.quota.chargeSpace(tx, page.spaceId, sizeBytes - page.sizeBytes);
        const owned = mediaIds.length
          ? await tx.media.findMany({
              where: { id: { in: mediaIds }, spaceId: page.spaceId },
              select: { id: true },
            })
          : [];
        const known = owned.map((m) => m.id);
        missingMedia = mediaIds.length - known.length;
        const row = await tx.page.update({
          where: { id: pageId },
          data: {
            content: valid as Prisma.InputJsonValue,
            contentText,
            sizeBytes,
            schemaVersion: CURRENT_SCHEMA_VERSION,
            version: { increment: 1 },
            seq,
          },
          select: { version: true },
        });
        // A file that has not reached the server yet is linked when it has (see scheduleRelink): the page keeps its reference.
        await tx.pageMedia.deleteMany({ where: { pageId, mediaId: { notIn: known } } });
        if (known.length)
          await tx.pageMedia.createMany({
            data: known.map((mediaId) => ({ pageId, mediaId })),
            skipDuplicates: true,
          });
        await saveState();
        return { version: row.version, spaceId: page.spaceId, changed: true };
      });
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 413) return refuse('quota');
      throw e; // a database problem: Hocuspocus keeps the document in memory and the next change tries again
    }
    if (!stored) return;
    this.stats_.stores++;
    this.stats_.storeSeconds += (performance.now() - started) / 1000;
    if (stored.changed)
      await this.bus.publish('page.updated', {
        pageId,
        spaceId: stored.spaceId,
        version: stored.version,
      });
    if (missingMedia > 0) this.scheduleRelink(pageId);
    else this.relink.delete(pageId);
    await this.snapshotIfDue(pageId, state, opts);
  }

  /** A picture or video the page uses was not on the server when the page was stored: store again soon, so the link is made once it is. */
  private scheduleRelink(pageId: string): void {
    const tries = (this.relink.get(pageId) ?? 0) + 1;
    this.relink.set(pageId, tries);
    if (tries > RELINK_TRIES) return;
    const timer = setTimeout(() => {
      const hp = this.registry.hocuspocus;
      const doc = hp?.documents.get(pageId);
      if (!hp || !doc || !this.relink.has(pageId)) return;
      void hp.storeDocumentHooks(
        doc,
        {
          instance: hp,
          clientsCount: doc.getConnectionsCount(),
          document: doc,
          lastContext: {},
          lastTransactionOrigin: { source: 'local' },
          documentName: pageId,
        },
        true,
      );
    }, RELINK_MS);
    timer.unref();
  }

  /** For the administrator: this instance's open pages and the weight of the live documents and snapshots. */
  async stats(open: {
    documents: number;
    connections: number;
    redis: boolean;
  }): Promise<CollabStatsDto> {
    const [docs, snaps] = await Promise.all([
      this.prisma.$queryRaw<
        { n: bigint; bytes: bigint | null }[]
      >`SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(state)) AS bytes FROM PageYDoc`,
      this.prisma.$queryRaw<
        { n: bigint; bytes: bigint | null }[]
      >`SELECT COUNT(*) AS n, SUM(OCTET_LENGTH(state)) AS bytes FROM PageYSnapshot`,
    ]);
    return {
      ...open,
      stores: this.stats_.stores,
      refused: { ...this.stats_.refused },
      yDocPages: Number(docs[0]?.n ?? 0),
      yDocBytes: Number(docs[0]?.bytes ?? 0),
      snapshots: Number(snaps[0]?.n ?? 0),
      snapshotBytes: Number(snaps[0]?.bytes ?? 0),
    };
  }

  // ------------------------------------------------------------------ snapshots

  private async snapshotIfDue(
    pageId: string,
    state: Uint8Array,
    opts: { lastUserId: string | null },
  ): Promise<void> {
    const last = this.lastSnapshot.get(pageId) ?? 0;
    if (Date.now() - last < HOUR) return;
    this.lastSnapshot.set(pageId, Date.now());
    this.touched.delete(pageId);
    await this.snapshot(pageId, state, 'hourly', opts.lastUserId);
  }

  /** Saves a version of the page's document, then drops the ones that are no longer kept. */
  async snapshot(
    pageId: string,
    state: Uint8Array,
    reason: SnapshotReason,
    byUserId: string | null,
  ): Promise<string> {
    const id = newId();
    await this.prisma.pageYSnapshot.create({
      data: { id, pageId, state: bytes(state), reason, byUserId },
    });
    await this.prune(pageId);
    return id;
  }

  /** Keeps the newest {@link SNAPSHOTS_KEPT} snapshots, and of the older ones the newest of each of the last {@link SNAPSHOT_DAYS} days. */
  async prune(pageId: string, now = Date.now()): Promise<void> {
    const all = await this.prisma.pageYSnapshot.findMany({
      where: { pageId },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (all.length <= SNAPSHOTS_KEPT) return;
    const keep = new Set(all.slice(0, SNAPSHOTS_KEPT).map((s) => s.id));
    const days = new Set<number>();
    for (const s of all.slice(SNAPSHOTS_KEPT)) {
      const age = now - s.createdAt.getTime();
      const day = Math.floor(s.createdAt.getTime() / DAY);
      if (age <= SNAPSHOT_DAYS * DAY && !days.has(day)) {
        days.add(day);
        keep.add(s.id);
      }
    }
    const drop = all.filter((s) => !keep.has(s.id)).map((s) => s.id);
    if (drop.length) await this.prisma.pageYSnapshot.deleteMany({ where: { id: { in: drop } } });
  }
}
