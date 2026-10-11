import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Discrepancy, Op, OpResult, ProductState, StoreState } from '../../shared/protocol';

export interface QueuedOp {
  op: Op;
  queuedAt: string;
}

export interface SentOp {
  op: Op;
  result: OpResult;
  syncedAt: string;
}

export interface TillSnapshot {
  storeId: string | null;
  storeName: string;
  expiresAt: string | null;
  /** Server state as of `seq`, keyed by product id. */
  products: Record<string, ProductState>;
  seq: number;
  discrepancies: Discrepancy[];
  /** Operations not yet acknowledged by the server, in the order they happened. */
  outbox: QueuedOp[];
  /** Recently acknowledged operations with the server's answer, newest first. */
  history: SentOp[];
}

export interface Acknowledgement {
  sentIds: string[];
  results: OpResult[];
  products: ProductState[];
  discrepancies: Discrepancy[];
  seq: number;
  syncedAt: string;
}

/**
 * Where a till keeps its data. The one rule implementations must keep:
 * `acknowledge` removes sent ops from the outbox and stores their effects in a
 * single atomic step, so a crash in between can neither lose a sale nor apply it twice.
 */
export interface TillStorage {
  load(): Promise<TillSnapshot>;
  reset(state: StoreState): Promise<void>;
  enqueue(q: QueuedOp): Promise<void>;
  acknowledge(a: Acknowledgement): Promise<void>;
}

export const HISTORY_LIMIT = 40;

export const emptySnapshot = (): TillSnapshot => ({
  storeId: null, storeName: '', expiresAt: null, products: {}, seq: 0, discrepancies: [], outbox: [], history: [],
});

/** Pure function shared by both storages, so they cannot disagree about what an acknowledgement means. */
export function applyAcknowledgement(s: TillSnapshot, a: Acknowledgement): TillSnapshot {
  const sent = new Set(a.sentIds);
  const byId = new Map(a.results.map((r) => [r.opId, r]));
  const acked: SentOp[] = s.outbox
    .filter((q) => sent.has(q.op.id) && byId.has(q.op.id))
    .map((q) => ({ op: q.op, result: byId.get(q.op.id)!, syncedAt: a.syncedAt }))
    .reverse();
  const products = { ...s.products };
  for (const p of a.products) products[p.id] = p;
  return {
    ...s,
    products,
    seq: Math.max(s.seq, a.seq),
    discrepancies: a.discrepancies,
    outbox: s.outbox.filter((q) => !(sent.has(q.op.id) && byId.has(q.op.id))),
    history: [...acked, ...s.history].slice(0, HISTORY_LIMIT),
  };
}

export function snapshotFromState(state: StoreState): TillSnapshot {
  return {
    storeId: state.storeId,
    storeName: state.name,
    expiresAt: state.expiresAt,
    products: Object.fromEntries(state.products.map((p) => [p.id, p])),
    seq: state.seq,
    discrepancies: state.discrepancies,
    outbox: [],
    history: [],
  };
}

/** For tests and server-side use. */
export class MemoryStorage implements TillStorage {
  snapshot = emptySnapshot();
  async load() {
    return structuredClone(this.snapshot);
  }
  async reset(state: StoreState) {
    this.snapshot = snapshotFromState(state);
  }
  async enqueue(q: QueuedOp) {
    this.snapshot = { ...this.snapshot, outbox: [...this.snapshot.outbox, structuredClone(q)] };
  }
  async acknowledge(a: Acknowledgement) {
    this.snapshot = applyAcknowledgement(this.snapshot, a);
  }
}

interface TillDb extends DBSchema {
  meta: { key: string; value: unknown };
  products: { key: string; value: ProductState };
  /** Keyed by a local, monotonically increasing number so the outbox keeps its order. */
  outbox: { key: number; value: QueuedOp & { n?: number }; indexes: { byOpId: string } };
  history: { key: string; value: SentOp };
}

/**
 * IndexedDB storage, one database per till. Products, outbox, history and
 * metadata live in separate object stores, and every acknowledgement updates
 * all of them inside one readwrite transaction.
 */
export class IndexedDbStorage implements TillStorage {
  private dbp: Promise<IDBPDatabase<TillDb>>;

  constructor(name: string) {
    this.dbp = openDB<TillDb>(name, 1, {
      upgrade(db) {
        db.createObjectStore('meta');
        db.createObjectStore('products', { keyPath: 'id' });
        db.createObjectStore('outbox', { autoIncrement: true }).createIndex('byOpId', 'op.id', { unique: true });
        db.createObjectStore('history', { keyPath: 'op.id' });
      },
    });
  }

  async load(): Promise<TillSnapshot> {
    const db = await this.dbp;
    const tx = db.transaction(['meta', 'products', 'outbox', 'history'], 'readonly');
    const meta = tx.objectStore('meta');
    const [storeId, storeName, expiresAt, seq, discrepancies, products, outbox, history] = await Promise.all([
      meta.get('storeId'), meta.get('storeName'), meta.get('expiresAt'), meta.get('seq'), meta.get('discrepancies'),
      tx.objectStore('products').getAll(),
      tx.objectStore('outbox').getAll(),
      tx.objectStore('history').getAll(),
    ]);
    await tx.done;
    return {
      storeId: (storeId as string) ?? null,
      storeName: (storeName as string) ?? '',
      expiresAt: (expiresAt as string) ?? null,
      seq: (seq as number) ?? 0,
      discrepancies: (discrepancies as Discrepancy[]) ?? [],
      products: Object.fromEntries(products.map((p) => [p.id, p])),
      outbox: outbox.map(({ op, queuedAt }) => ({ op, queuedAt })),
      history: history.sort((a, b) => (b.syncedAt === a.syncedAt ? (b.result.seq ?? 0) - (a.result.seq ?? 0) : b.syncedAt.localeCompare(a.syncedAt))),
    };
  }

  async reset(state: StoreState) {
    const db = await this.dbp;
    const tx = db.transaction(['meta', 'products', 'outbox', 'history'], 'readwrite');
    await Promise.all([tx.objectStore('products').clear(), tx.objectStore('outbox').clear(), tx.objectStore('history').clear()]);
    const meta = tx.objectStore('meta');
    await Promise.all([
      meta.put(state.storeId, 'storeId'), meta.put(state.name, 'storeName'), meta.put(state.expiresAt, 'expiresAt'),
      meta.put(state.seq, 'seq'), meta.put(state.discrepancies, 'discrepancies'),
      ...state.products.map((p) => tx.objectStore('products').put(p)),
    ]);
    await tx.done;
  }

  async enqueue(q: QueuedOp) {
    const db = await this.dbp;
    await db.add('outbox', q);
  }

  async acknowledge(a: Acknowledgement) {
    const db = await this.dbp;
    const tx = db.transaction(['meta', 'products', 'outbox', 'history'], 'readwrite');
    const outbox = tx.objectStore('outbox');
    const results = new Map(a.results.map((r) => [r.opId, r]));
    for (const id of a.sentIds) {
      const result = results.get(id);
      if (!result) continue;
      const key = await outbox.index('byOpId').getKey(id);
      if (key === undefined) continue;
      const q = await outbox.get(key);
      await outbox.delete(key);
      if (q) await tx.objectStore('history').put({ op: q.op, result, syncedAt: a.syncedAt });
    }
    for (const p of a.products) await tx.objectStore('products').put(p);
    const meta = tx.objectStore('meta');
    const seq = ((await meta.get('seq')) as number | undefined) ?? 0;
    await meta.put(Math.max(seq, a.seq), 'seq');
    await meta.put(a.discrepancies, 'discrepancies');
    // Keep history bounded.
    const all = await tx.objectStore('history').getAll();
    if (all.length > HISTORY_LIMIT) {
      all.sort((x, y) => x.syncedAt.localeCompare(y.syncedAt));
      for (const old of all.slice(0, all.length - HISTORY_LIMIT)) await tx.objectStore('history').delete(old.op.id);
    }
    await tx.done;
  }
}
