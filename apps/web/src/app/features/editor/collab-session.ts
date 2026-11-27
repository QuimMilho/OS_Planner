import { signal } from '@angular/core';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import {
  COLLAB_FIELD,
  COLLAB_PATH,
  type CollabClientMessage,
  type CollabRefusal,
  type CollabServerMessage,
} from '@os-planner/shared';

export type CollabStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Somebody else in the page. */
export interface Peer {
  name: string;
  color: string;
}

export interface CollabOptions {
  pageId: string;
  /** The signed-in person: the local copy of the document is kept per person, so two accounts on one device never share it. */
  userId: string;
  /** The API's origin and path prefix (empty: the website's own origin). */
  apiBase: string;
  /** A fresh access token (the connection outlives any single token). */
  token: () => Promise<string>;
  /** Called just before changes made while disconnected are merged with the server's version. */
  beforeMerge: (state: Uint8Array) => void;
}

const dirtyKey = (pageId: string): string => `os_planner.collab.dirty.${pageId}`;
/** The document as of the moment the page was left, kept synchronously (see backup()). */
const backupKey = (pageId: string): string => `os_planner.collab.backup.${pageId}`;
/** localStorage is about 5 MB for the whole site: a document whose state is bigger than this is left to IndexedDB alone. */
const BACKUP_MAX_CHARS = 1_500_000;
/** Local changes are taken to be in IndexedDB this long after they were made. */
const PERSIST_MS = 1_500;

const toBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;

/**
 * One page open for co-editing: a Yjs document that lives in IndexedDB on this device (so it opens and keeps working
 * offline) and is kept equal to the server's through Hocuspocus. The editor binds to `doc`; everything the screen shows about
 * the connection is a signal here.
 *
 *  - Changes made while disconnected stay in the local document and merge when the connection is back; the merge is a CRDT
 *    merge, so nobody's text is lost and no copy of the page is made. A snapshot of the local document is stored first.
 *  - The server decides what a person may do: `scope` tells `read-write` or `readonly`; a page the person may not open at
 *    all (or that does not exist on the server yet) is retried with a growing delay.
 */
export class CollabSession {
  readonly doc = new Y.Doc();
  readonly status = signal<CollabStatus>('connecting');
  /** The server's version has been merged into the document on this connection. */
  readonly synced = signal(false);
  /** The server's version has been merged at least once since the page was opened here. */
  readonly everSynced = signal(false);
  /** How many times the server's version has been merged on this page (one per connection): changes made before it are on the server now. */
  readonly syncedCount = signal(0);
  /** Local changes the server has not confirmed yet. */
  readonly unsynced = signal(0);
  readonly scope = signal<'read-write' | 'readonly' | null>(null);
  /** The server refused this person (no access, or no such page yet). */
  readonly denied = signal(false);
  /** The server could not store the page the last time it tried, and why. */
  readonly refusal = signal<CollabRefusal | null>(null);
  readonly peers = signal<Peer[]>([]);
  /** The local copy has been read from IndexedDB. */
  readonly localReady: Promise<void>;

  readonly provider: HocuspocusProvider;
  private readonly persistence: IndexeddbPersistence;
  private everConnected = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters: (() => void)[] = [];
  private readonly offListeners: (() => void)[] = [];
  private destroyed = false;
  /** Changes were made here a moment ago and may not be in IndexedDB yet. */
  private pendingPersist = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: CollabOptions) {
    this.persistence = new IndexeddbPersistence(
      `os_planner.collab.${opts.userId}.${opts.pageId}`,
      this.doc,
    );
    // What was typed just before the page was left may not have reached IndexedDB (its writes are asynchronous and can be cut off as a
    // page unloads): the backup written then is merged back in, which is safe because a Yjs update can be applied any number of times.
    this.localReady = this.persistence.whenSynced.then(() => this.restoreBackup());

    const base = new URL(opts.apiBase || location.origin, location.href);
    const url = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}${base.pathname.replace(/\/+$/, '')}${COLLAB_PATH}`;
    this.provider = new HocuspocusProvider({
      url,
      name: opts.pageId,
      document: this.doc,
      token: opts.token,
      onStatus: () => this.refresh(),
      onConnect: () => this.refresh(),
      onDisconnect: () => {
        this.synced.set(false);
        this.refresh();
      },
      onAuthenticated: ({ scope }) => {
        this.scope.set(scope);
        this.denied.set(false);
        this.retries = 0;
        // Changes made while disconnected are about to meet the server's: keep the page as it is on this device first.
        if (this.hasOfflineChanges()) {
          try {
            opts.beforeMerge(Y.encodeStateAsUpdate(this.doc));
          } catch {
            /* the snapshot is a safety net, never a reason to stop the merge */
          }
        }
        this.refresh();
      },
      onAuthenticationFailed: () => {
        this.denied.set(true);
        this.scope.set(null);
        this.scheduleRetry();
        this.refresh();
      },
      onSynced: ({ state }) => {
        this.synced.set(state);
        if (state) {
          this.everSynced.set(true);
          this.syncedCount.update((n) => n + 1);
          if (this.provider.unsyncedChanges === 0) this.setOfflineChanges(false);
        }
        this.refresh();
      },
      onUnsyncedChanges: ({ number }) => {
        this.unsynced.set(number);
        if (number === 0 && this.synced()) this.setOfflineChanges(false);
      },
      onStateless: ({ payload }) => this.onStateless(payload),
    });
    this.provider.awareness?.on('change', () => this.updatePeers());

    // A change made here while not connected is the one a later merge has to be safe for.
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === this.provider || origin === this.persistence) return;
      if (this.status() !== 'live') this.setOfflineChanges(true);
      this.pendingPersist = true;
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => (this.pendingPersist = false), PERSIST_MS);
    };
    this.doc.on('update', onUpdate);
    this.offListeners.push(() => this.doc.off('update', onUpdate));

    // A browser that knows it has no network can leave the socket looking open; let it go and start over when the network is back.
    let wasOnline = navigator.onLine;
    const onOffline = () => {
      if (!wasOnline) return;
      wasOnline = false;
      this.dropSocket();
      this.synced.set(false);
      this.refresh();
    };
    const onOnline = () => {
      if (wasOnline) return;
      wasOnline = true;
      this.retryNow();
    };
    addEventListener('offline', onOffline);
    addEventListener('online', onOnline);
    this.offListeners.push(() => {
      removeEventListener('offline', onOffline);
      removeEventListener('online', onOnline);
    });
    // The browser does not always say that the network went or came back: look every couple of seconds, and while the
    // connection is down try again every few seconds.
    let tick = 0;
    const watchdog = setInterval(() => {
      if (this.destroyed) return;
      if (navigator.onLine !== wasOnline) return void (navigator.onLine ? onOnline() : onOffline());
      if (navigator.onLine && !this.denied() && this.status() !== 'live' && ++tick % 3 === 0)
        void this.reconnect();
    }, 2_000);
    this.offListeners.push(() => clearInterval(watchdog));
    this.refresh();
  }

  // ------------------------------------------------------------------ what the screen reads

  get fragment(): Y.XmlFragment {
    return this.doc.getXmlFragment(COLLAB_FIELD);
  }

  /** Nothing has been typed into this page on any device (or it was never opened here). */
  get isEmpty(): boolean {
    return this.fragment.length === 0;
  }

  setUser(name: string, color: string): void {
    this.provider.awareness?.setLocalStateField('user', { name, color });
  }

  /**
   * Waits until what was typed has reached the server and the server has written it to the database (so a search, an export
   * or another device sees it). Resolves false when that is not possible right now (offline) or takes too long.
   */
  async flushToServer(timeoutMs = 4000): Promise<boolean> {
    if (this.status() !== 'live' || this.scope() !== 'read-write') return false;
    const start = Date.now();
    while (this.provider.unsyncedChanges > 0) {
      if (Date.now() - start > timeoutMs || this.status() !== 'live') return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        Math.max(500, timeoutMs - (Date.now() - start)),
      );
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
      this.provider.sendStateless(JSON.stringify({ t: 'flush' } satisfies CollabClientMessage));
    });
  }

  /**
   * Called as the page is hidden or unloaded: if something was typed in the last moments, the whole document is also written
   * to localStorage, which (unlike IndexedDB) is synchronous. It is merged back the next time the page is opened here.
   */
  backup(): void {
    if (!this.pendingPersist) return;
    try {
      const text = toBase64(Y.encodeStateAsUpdate(this.doc));
      if (text.length <= BACKUP_MAX_CHARS) localStorage.setItem(backupKey(this.opts.pageId), text);
    } catch {
      /* storage full or unavailable: IndexedDB alone then */
    }
  }

  private restoreBackup(): void {
    const key = backupKey(this.opts.pageId);
    try {
      const text = localStorage.getItem(key);
      if (!text) return;
      localStorage.removeItem(key);
      Y.applyUpdate(this.doc, fromBase64(text));
    } catch {
      /* unreadable: nothing to merge */
    }
  }

  /** Connects again right now (after the network came back, or to try a page the server did not have yet). */
  retryNow(): void {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    void this.reconnect();
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.persistTimer);
    for (const off of this.offListeners.splice(0)) off();
    for (const done of this.waiters.splice(0)) done();
    this.provider.destroy();
    void this.persistence.destroy();
    this.doc.destroy();
  }

  // ------------------------------------------------------------------ internals

  /**
   * Lets the current socket go and treats it as closed. Without a network a socket cannot finish its closing handshake, so the
   * browser keeps calling it open for a long time and the library keeps thinking it is connected (and ignores `connect()`):
   * the library's own "the socket closed" path is run by hand instead.
   */
  private dropSocket(): void {
    const ws = this.provider.configuration.websocketProvider;
    try {
      ws.disconnect(); // also: do not try again by yourself
      (ws as unknown as { emit(name: string, payload: unknown): void }).emit('close', {
        event: { code: 4000, reason: 'dropped' },
      });
    } catch {
      /* nothing to drop */
    }
  }

  private async reconnect(): Promise<void> {
    if (this.destroyed) return;
    try {
      this.dropSocket();
      await this.provider.connect();
    } catch {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.retries++);
    this.retryTimer = setTimeout(() => void this.reconnect(), delay);
  }

  private refresh(): void {
    // The library announces its first status while the provider is still being built (and an exception thrown here would make it
    // retry the connection): nothing to read yet.
    if (!this.provider) return;
    const ws = this.provider.configuration.websocketProvider;
    const connected = String(ws.status) === 'connected';
    // A browser without a network can keep calling a socket open: what it says about itself comes first.
    if (!navigator.onLine) this.status.set('offline');
    else if (connected && this.provider.isAuthenticated) {
      this.everConnected = true;
      this.status.set('live');
    } else if (this.everConnected || this.denied()) this.status.set('reconnecting');
    else this.status.set('connecting');
  }

  private updatePeers(): void {
    const awareness = this.provider.awareness;
    if (!awareness) return;
    const seen = new Set<string>();
    const peers: Peer[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
      if (!user || typeof user.name !== 'string' || typeof user.color !== 'string') continue;
      const key = `${user.name}\u0000${user.color}`; // the same person in two tabs counts once
      if (seen.has(key)) continue;
      seen.add(key);
      peers.push({ name: user.name, color: user.color });
    }
    this.peers.set(peers);
  }

  private onStateless(payload: string): void {
    let message: CollabServerMessage;
    try {
      message = JSON.parse(payload) as CollabServerMessage;
    } catch {
      return;
    }
    if (message.t === 'refused') this.refusal.set(message.reason);
    else if (message.t === 'stored') {
      this.refusal.set(null);
      for (const done of this.waiters.splice(0)) done();
    }
  }

  private hasOfflineChanges(): boolean {
    try {
      return localStorage.getItem(dirtyKey(this.opts.pageId)) === '1';
    } catch {
      return false;
    }
  }

  private setOfflineChanges(on: boolean): void {
    try {
      if (on) localStorage.setItem(dirtyKey(this.opts.pageId), '1');
      else localStorage.removeItem(dirtyKey(this.opts.pageId));
    } catch {
      /* private mode: the snapshot is only a safety net */
    }
  }
}
