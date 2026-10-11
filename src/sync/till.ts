import { localDelta, type Op, type ProductState, type StoreState, type SyncRequest, type SyncResponse } from '../../shared/protocol';
import type { TillSnapshot, TillStorage } from './storage';
import { applyAcknowledgement, emptySnapshot } from './storage';

/** How the till talks to the server. Throws `NetworkError` when the server cannot be reached. */
export interface Transport {
  getStore(storeId: string): Promise<StoreState>;
  sync(storeId: string, req: SyncRequest): Promise<SyncResponse>;
}

export class NetworkError extends Error {}
export class StoreGone extends Error {}
export class BadRequest extends Error {}

export type Connection =
  /** Network switch on, nothing waiting. */
  | 'synced'
  | 'syncing'
  /** Network switch off: working from local data, queueing changes. */
  | 'offline'
  /** Switch on but the server cannot be reached; retrying with backoff. */
  | 'unreachable'
  /** The demo store has been deleted on the server. */
  | 'expired'
  /** The server refused the request as malformed. Nothing is dropped; needs a developer. */
  | 'error';

export interface TillView {
  deviceId: string;
  label: string;
  ready: boolean;
  connection: Connection;
  online: boolean;
  /** Products as this till sees them: last known server stock plus its own unsynced changes. */
  products: (ProductState & { pending: number })[];
  snapshot: TillSnapshot;
  lastSyncedAt: string | null;
  nextRetryAt: number | null;
  lastError: string | null;
}

export interface TillOptions {
  deviceId: string;
  label: string;
  storage: TillStorage;
  transport: Transport;
  /** Injected for tests. */
  now?: () => Date;
  uuid?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  random?: () => number;
}

const MAX_BATCH = 200;
const BASE_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

/**
 * One point-of-sale device. Records sales, deliveries and counts locally first
 * (so the till never waits on the network), queues them in an outbox, and
 * syncs them in order whenever it can.
 *
 * Framework-free: React subscribes through `subscribe`/`getView`.
 */
export class Till {
  readonly deviceId: string;
  private readonly o: Required<TillOptions>;
  private snap: TillSnapshot = emptySnapshot();
  private ready = false;
  private online = true;
  private connection: Connection = 'synced';
  private inFlight: Promise<void> | null = null;
  private again = false;
  private failures = 0;
  private retryTimer: unknown = null;
  private nextRetryAt: number | null = null;
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private listeners = new Set<() => void>();
  private view: TillView;
  /** Serialises local writes so outbox order matches the order things happened. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(opts: TillOptions) {
    this.o = {
      now: () => new Date(),
      uuid: () => crypto.randomUUID(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      random: Math.random,
      ...opts,
    };
    this.deviceId = opts.deviceId;
    this.view = this.computeView();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Load local data; if this till has never seen `storeId`, fetch it from the server. */
  async open(storeId: string, online = true): Promise<void> {
    this.online = online;
    this.snap = await this.o.storage.load();
    if (this.snap.storeId !== storeId) {
      if (this.snap.outbox.length) throw new Error('This till still has unsynced changes for another store.');
      const state = await this.o.transport.getStore(storeId);
      await this.o.storage.reset(state);
      this.snap = await this.o.storage.load();
    }
    this.ready = true;
    this.connection = this.online ? 'synced' : 'offline';
    this.emit();
    if (this.online) await this.sync();
  }

  close() {
    if (this.retryTimer) this.o.clearTimer(this.retryTimer);
    this.listeners.clear();
  }

  // ── recording ───────────────────────────────────────────────────────────

  sell(productId: string, qty = 1) {
    return this.record({ kind: 'sale', productId, qty });
  }

  receive(productId: string, qty: number) {
    return this.record({ kind: 'receive', productId, qty });
  }

  /** "I counted N on the shelf." Carries the server seq this till's view is based on. */
  count(productId: string, counted: number) {
    return this.record({ kind: 'count', productId, counted, baseSeq: this.snap.seq });
  }

  private record(partial: { kind: 'sale' | 'receive'; productId: string; qty: number } | { kind: 'count'; productId: string; counted: number; baseSeq: number }): Promise<Op> {
    const op = { ...partial, id: this.o.uuid(), at: this.o.now().toISOString() } as Op;
    const queued = { op, queuedAt: op.at };
    // Show it immediately; persist in order; then try to send.
    this.snap = { ...this.snap, outbox: [...this.snap.outbox, queued] };
    this.emit();
    const done = (this.writes = this.writes.then(() => this.o.storage.enqueue(queued)));
    return done.then(() => {
      if (this.online) void this.sync();
      return op;
    });
  }

  // ── network ─────────────────────────────────────────────────────────────

  /** The demo's network switch. Off means the till does not try to reach the server at all. */
  setOnline(on: boolean) {
    this.online = on;
    if (!on) {
      this.cancelRetry();
      this.connection = 'offline';
      this.emit();
    } else {
      this.failures = 0;
      void this.sync();
    }
  }

  /**
   * Send the outbox (in order, in batches) and pull changes. Only one sync runs
   * at a time; calls made meanwhile are folded into one more round afterwards,
   * so ops recorded during a sync are sent by the next one.
   */
  sync(): Promise<void> {
    if (!this.ready || !this.online || this.connection === 'expired') return Promise.resolve();
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.cancelRetry();
    this.inFlight = this.loop().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async loop() {
    do {
      this.again = false;
      await this.writes; // everything recorded so far is on disk before we send it
      const storeId = this.snap.storeId!;
      const batch = this.snap.outbox.slice(0, MAX_BATCH);
      this.connection = 'syncing';
      this.emit();
      let res: SyncResponse;
      try {
        res = await this.o.transport.sync(storeId, { deviceId: this.deviceId, since: this.snap.seq, ops: batch.map((q) => q.op) });
      } catch (e) {
        return this.handleFailure(e);
      }
      // The switch may have been turned off while the request was out; the answer is still valid.
      const ack = { sentIds: batch.map((q) => q.op.id), results: res.results, products: res.products, discrepancies: res.discrepancies, seq: res.seq, syncedAt: this.o.now().toISOString() };
      await this.o.storage.acknowledge(ack);
      // Apply the same acknowledgement in memory rather than reloading, so ops recorded
      // while the request was out (already in memory, maybe not yet on disk) are kept.
      this.snap = applyAcknowledgement(this.snap, ack);
      this.failures = 0;
      this.lastError = null;
      this.lastSyncedAt = ack.syncedAt;
      const sent = new Set(ack.sentIds);
      if (this.snap.outbox.some((q) => !sent.has(q.op.id))) this.again = true;
    } while (this.again && this.online);
    this.connection = this.online ? 'synced' : 'offline';
    this.emit();
  }

  private handleFailure(e: unknown) {
    if (e instanceof StoreGone) {
      this.connection = 'expired';
      this.lastError = e.message;
    } else if (e instanceof BadRequest) {
      this.connection = 'error';
      this.lastError = e.message;
    } else {
      // Network or server trouble: keep everything, try again later with exponential backoff and jitter.
      this.failures++;
      const delay = Math.min(MAX_BACKOFF, BASE_BACKOFF * 2 ** (this.failures - 1)) * (0.75 + this.o.random() * 0.5);
      this.connection = this.online ? 'unreachable' : 'offline';
      this.lastError = e instanceof Error ? e.message : String(e);
      if (this.online) {
        this.nextRetryAt = Date.now() + delay;
        this.retryTimer = this.o.setTimer(() => {
          this.retryTimer = null;
          this.nextRetryAt = null;
          void this.sync();
        }, delay);
      }
    }
    this.emit();
  }

  private cancelRetry() {
    if (this.retryTimer) this.o.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  // ── view ────────────────────────────────────────────────────────────────

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getView = () => this.view;

  private emit() {
    this.view = this.computeView();
    this.listeners.forEach((l) => l());
  }

  /** Server stock with this till's unsynced ops replayed on top, in order. */
  private computeView(): TillView {
    const stock = new Map(Object.values(this.snap.products).map((p) => [p.id, p.stock]));
    const pending = new Map<string, number>();
    for (const { op } of this.snap.outbox) {
      const before = stock.get(op.productId);
      if (before === undefined) continue;
      const d = localDelta(op, before);
      stock.set(op.productId, before + d);
      pending.set(op.productId, (pending.get(op.productId) ?? 0) + d);
    }
    return {
      deviceId: this.deviceId,
      label: this.o.label,
      ready: this.ready,
      connection: this.connection,
      online: this.online,
      products: Object.values(this.snap.products)
        .map((p) => ({ ...p, stock: stock.get(p.id)!, pending: pending.get(p.id) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      snapshot: this.snap,
      lastSyncedAt: this.lastSyncedAt,
      nextRetryAt: this.nextRetryAt,
      lastError: this.lastError,
    };
  }
}
