import type pg from 'pg';
import type { Discrepancy, JournalEntry, Op, OpResult, OpStatus, ProductState, StoreState, SyncRequest, SyncResponse } from '../shared/protocol';

/** Demo stores are private to one visitor and removed after this long. */
export const STORE_TTL_HOURS = 24;

/** The demo catalogue. One mug left, so two offline tills can both sell "the last one". */
export const SEED: Omit<ProductState, 'seq'>[] = [
  { id: 'mug', sku: 'CTM-001', name: 'Ceramic travel mug', priceCents: 2400, reorderAt: 4, stock: 1 },
  { id: 'beans', sku: 'CFB-250', name: 'Coffee beans, 250 g', priceCents: 1450, reorderAt: 12, stock: 32 },
  { id: 'filters', sku: 'PFL-100', name: 'Paper filters, pack of 100', priceCents: 650, reorderAt: 10, stock: 9 },
  { id: 'tote', sku: 'CTB-042', name: 'Canvas tote bag', priceCents: 1800, reorderAt: 10, stock: 18 },
  { id: 'notebook', sku: 'NDG-A5', name: 'Dot-grid notebook, A5', priceCents: 1600, reorderAt: 8, stock: 25 },
  { id: 'candle', sku: 'CND-FIG', name: 'Fig and cedar candle', priceCents: 2200, reorderAt: 5, stock: 6 },
];

export class NotFound extends Error {}

type Db = pg.Pool | pg.PoolClient;

export async function createStore(pool: pg.Pool, name = 'Corner Store'): Promise<StoreState> {
  const id = crypto.randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Housekeeping on the way in: nobody else cleans up demo stores.
    await c.query(`DELETE FROM stores WHERE created_at < now() - make_interval(hours => $1)`, [STORE_TTL_HOURS]);
    await c.query('INSERT INTO stores (id, name) VALUES ($1, $2)', [id, name]);
    for (const p of SEED) {
      await c.query(
        'INSERT INTO products (store_id, id, sku, name, price_cents, reorder_at, stock) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, p.id, p.sku, p.name, p.priceCents, p.reorderAt, p.stock],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return getState(pool, id);
}

export async function getState(db: Db, storeId: string, journalLimit = 60): Promise<StoreState> {
  const s = await db.query<{ name: string; expires_at: Date }>(
    `SELECT name, created_at + make_interval(hours => $2) AS expires_at FROM stores WHERE id = $1`,
    [storeId, STORE_TTL_HOURS],
  );
  const store = s.rows[0];
  if (!store) throw new NotFound('This store does not exist or has expired.');
  const [products, discrepancies, journal, seq] = await Promise.all([
    productsSince(db, storeId, -1),
    openDiscrepancies(db, storeId),
    db.query(
      `SELECT seq, op_id, device_id, product_id, kind, qty, counted, delta, stock_after, status, client_at, received_at
         FROM movements WHERE store_id = $1 ORDER BY seq DESC LIMIT $2`,
      [storeId, journalLimit],
    ),
    currentSeq(db, storeId),
  ]);
  return {
    storeId,
    name: store.name,
    products,
    discrepancies,
    journal: journal.rows.map(
      (r): JournalEntry => ({
        seq: Number(r.seq), opId: r.op_id, deviceId: r.device_id, productId: r.product_id, kind: r.kind,
        qty: r.qty, counted: r.counted, delta: r.delta, stockAfter: r.stock_after, status: r.status,
        at: r.client_at.toISOString(), receivedAt: r.received_at.toISOString(),
      }),
    ),
    seq,
    expiresAt: store.expires_at.toISOString(),
  };
}

async function productsSince(db: Db, storeId: string, since: number): Promise<ProductState[]> {
  const r = await db.query(
    `SELECT id, sku, name, price_cents, reorder_at, stock, seq FROM products
      WHERE store_id = $1 AND seq > $2 ORDER BY name`,
    [storeId, since],
  );
  return r.rows.map((p) => ({ id: p.id, sku: p.sku, name: p.name, priceCents: p.price_cents, reorderAt: p.reorder_at, stock: p.stock, seq: Number(p.seq) }));
}

async function openDiscrepancies(db: Db, storeId: string): Promise<Discrepancy[]> {
  const r = await db.query(
    `SELECT id, product_id, shortfall, device_id, opened_seq, opened_at FROM discrepancies
      WHERE store_id = $1 AND resolved_seq IS NULL ORDER BY opened_seq`,
    [storeId],
  );
  return r.rows.map((d) => ({ id: Number(d.id), productId: d.product_id, shortfall: d.shortfall, deviceId: d.device_id, openedSeq: Number(d.opened_seq), openedAt: d.opened_at.toISOString() }));
}

async function currentSeq(db: Db, storeId: string): Promise<number> {
  const r = await db.query('SELECT COALESCE(max(seq), 0) AS seq FROM movements WHERE store_id = $1', [storeId]);
  return Number(r.rows[0].seq);
}

/**
 * Apply a till's queued operations and return what changed since it last pulled.
 *
 * All of a store's syncs are serialised with a transaction-scoped advisory
 * lock. Besides keeping stock arithmetic simple, this guarantees sequence
 * numbers become visible in order: without it, a sync could commit seq 11
 * while another still holds 10, and a till pulling "since 11" would never see 10.
 */
export async function sync(pool: pg.Pool, storeId: string, req: SyncRequest): Promise<SyncResponse> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [storeId]);
    const exists = await c.query('SELECT 1 FROM stores WHERE id = $1', [storeId]);
    if (!exists.rowCount) throw new NotFound('This store does not exist or has expired.');

    const results: OpResult[] = [];
    for (const op of req.ops) results.push(await applyOp(c, storeId, req.deviceId, op));

    const [products, discrepancies, seq] = [
      await productsSince(c, storeId, req.since),
      await openDiscrepancies(c, storeId),
      await currentSeq(c, storeId),
    ];
    await c.query('COMMIT');
    return { results, products, discrepancies, seq };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function applyOp(c: pg.PoolClient, storeId: string, deviceId: string, op: Op): Promise<OpResult> {
  // Replays (a retry after a lost response, a till re-sending its outbox) get the original answer.
  const prior = await c.query('SELECT seq, delta, stock_after, status, message FROM movements WHERE store_id = $1 AND op_id = $2', [storeId, op.id]);
  if (prior.rows[0]) {
    const p = prior.rows[0];
    return { opId: op.id, status: p.status, duplicate: true, delta: p.delta, stockAfter: p.stock_after, seq: Number(p.seq), message: p.message ?? undefined };
  }

  const prod = await c.query<{ stock: number }>('SELECT stock FROM products WHERE store_id = $1 AND id = $2 FOR UPDATE', [storeId, op.productId]);
  const qty = op.kind === 'count' ? null : op.qty;
  const counted = op.kind === 'count' ? op.counted : null;
  const baseSeq = op.kind === 'count' ? op.baseSeq : null;

  if (!prod.rows[0]) {
    // Recorded anyway, so a retry gets the same answer instead of being treated as new.
    const message = `Unknown product "${op.productId}".`;
    const r = await c.query(
      `INSERT INTO movements (store_id, op_id, device_id, product_id, kind, qty, counted, base_seq, delta, stock_after, status, message, client_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, 'rejected', $9, $10) RETURNING seq`,
      [storeId, op.id, deviceId, op.productId, op.kind, qty, counted, baseSeq, message, op.at],
    );
    return { opId: op.id, status: 'rejected', duplicate: false, delta: 0, stockAfter: null, seq: Number(r.rows[0].seq), message };
  }

  const stock = prod.rows[0].stock;
  let delta: number;
  let message: string | undefined;
  if (op.kind === 'sale') delta = -op.qty;
  else if (op.kind === 'receive') delta = op.qty;
  else {
    // The till counted the shelf as it saw it at baseSeq, plus its own earlier ops (already applied, in order).
    // Movements by *other* tills after baseSeq happened independently of that count, so they stay.
    const others = await c.query<{ sum: string }>(
      `SELECT COALESCE(sum(delta), 0) AS sum FROM movements
        WHERE store_id = $1 AND product_id = $2 AND seq > $3 AND device_id <> $4 AND status <> 'rejected'`,
      [storeId, op.productId, op.baseSeq, deviceId],
    );
    const othersSince = Number(others.rows[0]!.sum);
    delta = op.counted - (stock - othersSince);
    if (othersSince !== 0) message = `Count kept ${Math.abs(othersSince)} unit${Math.abs(othersSince) === 1 ? '' : 's'} moved by other tills since this till last synced.`;
  }

  const stockAfter = stock + delta;
  const status: OpStatus = stockAfter < 0 ? 'flagged' : 'applied';
  if (status === 'flagged') message = `Stock went to \u2212${-stockAfter}: more was sold than the records show. Recount to resolve.`;

  const ins = await c.query(
    `INSERT INTO movements (store_id, op_id, device_id, product_id, kind, qty, counted, base_seq, delta, stock_after, status, message, client_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING seq`,
    [storeId, op.id, deviceId, op.productId, op.kind, qty, counted, baseSeq, delta, stockAfter, status, message ?? null, op.at],
  );
  const seq = Number(ins.rows[0].seq);
  await c.query('UPDATE products SET stock = $3, seq = $4 WHERE store_id = $1 AND id = $2', [storeId, op.productId, stockAfter, seq]);

  if (stockAfter < 0) {
    await c.query(
      `INSERT INTO discrepancies (store_id, product_id, shortfall, device_id, opened_seq)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (store_id, product_id) WHERE resolved_seq IS NULL DO UPDATE SET shortfall = EXCLUDED.shortfall`,
      [storeId, op.productId, -stockAfter, deviceId, seq],
    );
  } else if (op.kind === 'count') {
    // A count is the reconciliation: what is on the shelf is now the record.
    await c.query('UPDATE discrepancies SET resolved_seq = $3 WHERE store_id = $1 AND product_id = $2 AND resolved_seq IS NULL', [storeId, op.productId, seq]);
  }

  return { opId: op.id, status, duplicate: false, delta, stockAfter, seq, message };
}
