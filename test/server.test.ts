import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createPool, migrate } from '../server/db';
import { createApp } from '../server/app';
import { createStore, getState, sync } from '../server/store';
import type { Op } from '../shared/protocol';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shelfsync_test';
const pool = createPool(url);
let server: Server;
let base = '';

beforeAll(async () => {
  await migrate(pool);
  server = createApp(pool).listen(0);
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await pool.end();
});

const now = () => new Date().toISOString();
const sale = (productId: string, qty = 1, id: string = crypto.randomUUID()): Op => ({ id, kind: 'sale', productId, qty, at: now() });
const receive = (productId: string, qty: number): Op => ({ id: crypto.randomUUID(), kind: 'receive', productId, qty, at: now() });
const count = (productId: string, counted: number, baseSeq: number): Op => ({ id: crypto.randomUUID(), kind: 'count', productId, counted, baseSeq, at: now() });
const stockOf = async (storeId: string, id: string) => (await getState(pool, storeId)).products.find((p) => p.id === id)!.stock;

describe('sync', () => {
  it('applies a sale once, however many times it is sent', async () => {
    const s = await createStore(pool);
    const op = sale('beans', 2);
    const first = await sync(pool, s.storeId, { deviceId: 'till-1', since: 0, ops: [op] });
    expect(first.results[0]).toMatchObject({ status: 'applied', duplicate: false, delta: -2, stockAfter: 30 });
    // The response was lost; the till sends its outbox again, twice.
    const again = await sync(pool, s.storeId, { deviceId: 'till-1', since: 0, ops: [op, op] });
    expect(again.results.map((r) => [r.duplicate, r.stockAfter, r.seq])).toEqual([
      [true, 30, first.results[0]!.seq],
      [true, 30, first.results[0]!.seq],
    ]);
    expect(await stockOf(s.storeId, 'beans')).toBe(30);
  });

  it('two offline tills selling the last mug: both sales stand, the second is flagged for a recount', async () => {
    const s = await createStore(pool);
    expect(await stockOf(s.storeId, 'mug')).toBe(1);
    const a = await sync(pool, s.storeId, { deviceId: 'till-1', since: s.seq, ops: [sale('mug')] });
    const b = await sync(pool, s.storeId, { deviceId: 'till-2', since: s.seq, ops: [sale('mug')] });
    expect(a.results[0]).toMatchObject({ status: 'applied', stockAfter: 0 });
    expect(b.results[0]).toMatchObject({ status: 'flagged', stockAfter: -1 });
    expect(b.discrepancies).toEqual([expect.objectContaining({ productId: 'mug', shortfall: 1, deviceId: 'till-2' })]);

    // A third sale while still short deepens the same discrepancy rather than opening another.
    const c = await sync(pool, s.storeId, { deviceId: 'till-1', since: 0, ops: [sale('mug')] });
    expect(c.discrepancies).toEqual([expect.objectContaining({ productId: 'mug', shortfall: 2 })]);

    // The manager counts the shelf (0 left) and the books follow.
    const r = await sync(pool, s.storeId, { deviceId: 'office', since: 0, ops: [count('mug', 0, c.seq)] });
    expect(r.results[0]).toMatchObject({ status: 'applied', stockAfter: 0, delta: 2 });
    expect(r.discrepancies).toEqual([]);
  });

  it('a count keeps movements other tills made after the counting till last synced', async () => {
    const s = await createStore(pool);
    // Till 1 last saw beans = 32 at seq s.seq, then goes offline and counts 31 on the shelf.
    // Meanwhile till 2 sells 2 and syncs first.
    await sync(pool, s.storeId, { deviceId: 'till-2', since: s.seq, ops: [sale('beans', 2)] });
    const r = await sync(pool, s.storeId, { deviceId: 'till-1', since: s.seq, ops: [count('beans', 31, s.seq)] });
    // Last-write-wins would set 31 and resurrect the 2 sold units. The count's own finding (1 missing) is applied on top.
    expect(r.results[0]).toMatchObject({ status: 'applied', delta: -1, stockAfter: 29 });
    expect(r.results[0]!.message).toMatch(/kept 2 units/);
  });

  it("a count includes the counting till's own earlier, unsynced ops", async () => {
    const s = await createStore(pool);
    // Till 1, offline: sells 3 candles (6 -> 3 on its screen), then counts 3. Nothing is missing.
    const r = await sync(pool, s.storeId, { deviceId: 'till-1', since: s.seq, ops: [sale('candle', 3), count('candle', 3, s.seq)] });
    expect(r.results.map((x) => x.stockAfter)).toEqual([3, 3]);
    expect(r.results[1]!.delta).toBe(0);
  });

  it('returns only products changed since the till last pulled', async () => {
    const s = await createStore(pool);
    // A till loads the whole catalogue once from the store endpoint, then only pulls changes.
    expect(s.products).toHaveLength(6);
    const first = await sync(pool, s.storeId, { deviceId: 'till-1', since: s.seq, ops: [] });
    expect(first.products).toEqual([]);
    const r = await sync(pool, s.storeId, { deviceId: 'till-1', since: first.seq, ops: [receive('tote', 12)] });
    expect(r.products.map((p) => [p.id, p.stock])).toEqual([['tote', 30]]);
    const quiet = await sync(pool, s.storeId, { deviceId: 'till-1', since: r.seq, ops: [] });
    expect(quiet.products).toEqual([]);
  });

  it('rejects unknown products and remembers the answer', async () => {
    const s = await createStore(pool);
    const op = sale('unicorn');
    const r1 = await sync(pool, s.storeId, { deviceId: 'till-1', since: 0, ops: [op] });
    const r2 = await sync(pool, s.storeId, { deviceId: 'till-1', since: 0, ops: [op] });
    expect(r1.results[0]).toMatchObject({ status: 'rejected', duplicate: false });
    expect(r2.results[0]).toMatchObject({ status: 'rejected', duplicate: true });
  });
});

describe('concurrency', () => {
  it('many tills syncing at once: no lost or doubled sales, and pulls never skip a change', async () => {
    const s = await createStore(pool);
    // 24 concurrent requests, each with 3 sales of 1 tote, a third of them replaying another's batch.
    const batches = Array.from({ length: 16 }, () => [sale('tote'), sale('tote'), sale('tote')]);
    const requests = [...batches, ...batches.slice(0, 8)].map((ops, i) =>
      sync(pool, s.storeId, { deviceId: `till-${i % 5}`, since: s.seq, ops }),
    );
    const responses = await Promise.all(requests);
    const unique = new Set(responses.flatMap((r) => r.results.filter((x) => !x.duplicate).map((x) => x.opId)));
    expect(unique.size).toBe(48);
    expect(await stockOf(s.storeId, 'tote')).toBe(18 - 48);

    // Every applied movement has a distinct seq, and stock after each one is exactly one less than before.
    const state = await getState(pool, s.storeId, 1000);
    const toteMoves = state.journal.filter((j) => j.productId === 'tote').sort((a, b) => a.seq - b.seq);
    expect(toteMoves).toHaveLength(48);
    toteMoves.forEach((m, i) => expect(m.stockAfter).toBe(18 - (i + 1)));
  });
});

describe('HTTP API', () => {
  it('creates a store, syncs and reports state', async () => {
    const created = await fetch(`${base}/api/stores`, { method: 'POST' });
    expect(created.status).toBe(201);
    const s = await created.json();
    const r = await fetch(`${base}/api/stores/${s.storeId}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'till-1', since: s.seq, ops: [sale('filters', 2)] }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).results[0].stockAfter).toBe(7);
    const state = await (await fetch(`${base}/api/stores/${s.storeId}`)).json();
    expect(state.journal[0]).toMatchObject({ productId: 'filters', kind: 'sale', delta: -2, deviceId: 'till-1' });
  });

  it('explains invalid requests and unknown stores', async () => {
    const s = await createStore(pool);
    const bad = await fetch(`${base}/api/stores/${s.storeId}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'till-1', since: 0, ops: [{ id: 'x', kind: 'sale', productId: 'mug', qty: 0, at: 'now' }] }),
    });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['ops.0.id', 'ops.0.qty', 'ops.0.at']));
    const missing = await fetch(`${base}/api/stores/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).message).toMatch(/expired/);
    expect((await fetch(`${base}/api/stores/not-a-uuid/sync`, { method: 'POST' })).status).toBe(404);
  });

  it('accepts the path Netlify functions see behind the /api rewrite', async () => {
    expect((await fetch(`${base}/.netlify/functions/api/health`)).status).toBe(200);
  });

  it('removes demo stores older than a day when a new one is created', async () => {
    const old = await createStore(pool);
    await pool.query(`UPDATE stores SET created_at = now() - interval '25 hours' WHERE id = $1`, [old.storeId]);
    await createStore(pool);
    expect((await fetch(`${base}/api/stores/${old.storeId}`)).status).toBe(404);
    const left = await pool.query('SELECT count(*) FROM movements WHERE store_id = $1', [old.storeId]);
    expect(Number(left.rows[0].count)).toBe(0);
  });
});
