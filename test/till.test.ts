import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../server/db';
import { createStore, getState, sync, SEED, NotFound } from '../server/store';
import { IndexedDbStorage, MemoryStorage, type TillStorage } from '../src/sync/storage';
import { NetworkError, StoreGone, Till, type Transport } from '../src/sync/till';
import type { SyncRequest } from '../shared/protocol';

const pool = createPool(process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/shelfsync_test');
beforeAll(() => migrate(pool));
afterAll(() => pool.end());

/** Seeded PRNG so a failing run can be replayed exactly. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Fault = 'none' | 'drop-request' | 'drop-response' | 'duplicate';

/** Calls the real server code, with injectable network faults. */
function faultyTransport() {
  const t = {
    fault: 'none' as Fault,
    calls: 0,
    transport: {
      getStore: async (id: string) => {
        try {
          return await getState(pool, id);
        } catch (e) {
          if (e instanceof NotFound) throw new StoreGone(e.message);
          throw e;
        }
      },
      sync: async (id: string, req: SyncRequest) => {
        t.calls++;
        const body = structuredClone(req);
        if (t.fault === 'drop-request') throw new NetworkError('request lost');
        // Same mapping the HTTP client does for a 404.
        const res = await sync(pool, id, body).catch((e) => {
          throw e instanceof NotFound ? new StoreGone(e.message) : e;
        });
        if (t.fault === 'drop-response') throw new NetworkError('response lost');
        if (t.fault === 'duplicate') return sync(pool, id, body);
        return res;
      },
    } satisfies Transport,
  };
  return t;
}

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let n = 0;
  return {
    setTimer: (fn: () => void) => (pending.set(++n, fn), n),
    clearTimer: (id: unknown) => void pending.delete(id as number),
    fireAll() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
    get size() {
      return pending.size;
    },
  };
}

function makeTill(deviceId: string, transport: Transport, storage: TillStorage = new MemoryStorage(), timers = manualTimers()) {
  return { till: new Till({ deviceId, label: deviceId, storage, transport, setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5 }), timers, storage };
}

const stock = (t: Till, id: string) => t.getView().products.find((p) => p.id === id)!.stock;

describe('a till', () => {
  it('keeps selling offline and sends everything once when it reconnects', async () => {
    const s = await createStore(pool);
    const net = faultyTransport();
    const { till } = makeTill('till-1', net.transport);
    await till.open(s.storeId, false);
    await till.sell('beans', 2);
    await till.sell('beans', 1);
    await till.receive('filters', 10);
    expect(net.calls).toBe(0);
    expect(stock(till, 'beans')).toBe(29);
    expect(till.getView().snapshot.outbox).toHaveLength(3);

    till.setOnline(true);
    await till.sync();
    expect(till.getView().snapshot.outbox).toHaveLength(0);
    expect(till.getView().snapshot.history.map((h) => h.result.status)).toEqual(['applied', 'applied', 'applied']);
    const server = await getState(pool, s.storeId);
    expect(server.products.find((p) => p.id === 'beans')!.stock).toBe(29);
    expect(server.products.find((p) => p.id === 'filters')!.stock).toBe(19);
  });

  it('survives a lost response: the retry is recognised and nothing is applied twice', async () => {
    const s = await createStore(pool);
    const net = faultyTransport();
    const { till, timers } = makeTill('till-1', net.transport);
    await till.open(s.storeId);
    net.fault = 'drop-response';
    await till.sell('tote', 3);
    await till.sync();
    expect(till.getView().connection).toBe('unreachable');
    expect(till.getView().snapshot.outbox).toHaveLength(1); // still queued, though the server has it
    net.fault = 'none';
    timers.fireAll();
    await till.sync();
    const [h] = till.getView().snapshot.history;
    expect(h!.result).toMatchObject({ duplicate: true, stockAfter: 15 });
    expect((await getState(pool, s.storeId)).products.find((p) => p.id === 'tote')!.stock).toBe(15);
  });

  it('backs off exponentially while the server is unreachable', async () => {
    const s = await createStore(pool);
    const net = faultyTransport();
    const timers = manualTimers();
    const delays: number[] = [];
    const till = new Till({
      deviceId: 'till-1', label: 'Till 1', storage: new MemoryStorage(), transport: net.transport, random: () => 0.5,
      setTimer: (fn, ms) => (delays.push(ms), timers.setTimer(fn)), clearTimer: timers.clearTimer,
    });
    await till.open(s.storeId);
    net.fault = 'drop-request';
    await till.sell('mug');
    for (let i = 0; i < 7; i++) {
      await till.sync();
      timers.fireAll();
    }
    await till.sync();
    expect(delays.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('keeps ops recorded while a sync is in flight, and sends them next', async () => {
    const s = await createStore(pool);
    const net = faultyTransport();
    const { till } = makeTill('till-1', net.transport);
    await till.open(s.storeId);
    const first = till.sell('notebook');
    const second = till.sell('notebook', 2); // recorded while the first sync is out
    await Promise.all([first, second]);
    await till.sync();
    await till.sync();
    expect(till.getView().snapshot.outbox).toHaveLength(0);
    expect((await getState(pool, s.storeId)).products.find((p) => p.id === 'notebook')!.stock).toBe(22);
  });

  it('reports an expired store instead of retrying forever', async () => {
    const s = await createStore(pool);
    const net = faultyTransport();
    const { till } = makeTill('till-1', net.transport);
    await till.open(s.storeId);
    await pool.query('DELETE FROM stores WHERE id = $1', [s.storeId]);
    await till.sell('mug');
    await till.sync();
    expect(till.getView().connection).toBe('expired');
    expect(till.getView().snapshot.outbox).toHaveLength(1); // the sale is not thrown away
  });
});

describe('IndexedDB storage', () => {
  it('keeps the outbox across a reload, in order', async () => {
    const s = await createStore(pool);
    const net = faultyTransport();
    const name = `till-${crypto.randomUUID()}`;
    const a = makeTill('till-1', net.transport, new IndexedDbStorage(name));
    await a.till.open(s.storeId, false);
    await a.till.sell('candle', 1);
    await a.till.receive('candle', 4);
    await a.till.count('candle', 8);
    a.till.close();

    // The tab is closed and reopened: a new Till on the same database.
    const b = makeTill('till-1', net.transport, new IndexedDbStorage(name));
    await b.till.open(s.storeId, false);
    expect(b.till.getView().snapshot.outbox.map((q) => q.op.kind)).toEqual(['sale', 'receive', 'count']);
    expect(stock(b.till, 'candle')).toBe(8);
    b.till.setOnline(true);
    await b.till.sync();
    expect(b.till.getView().snapshot.outbox).toHaveLength(0);

    const c = makeTill('till-1', net.transport, new IndexedDbStorage(name));
    await c.till.open(s.storeId, false);
    expect(c.till.getView().snapshot.outbox).toHaveLength(0);
    expect(c.till.getView().snapshot.history).toHaveLength(3);
    expect(stock(c.till, 'candle')).toBe(8);
  });
});

describe('convergence under chaos', () => {
  // Three tills, random sales/deliveries/counts, random network switches and faults.
  // Whatever happens, once the network is healthy everyone must agree, and every op must count exactly once.
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`seed ${seed}`, async () => {
      const r = rng(seed);
      const s = await createStore(pool);
      const net = faultyTransport();
      const tills = await Promise.all(
        ['till-1', 'till-2', 'till-3'].map(async (id) => {
          const t = makeTill(id, net.transport);
          await t.till.open(s.storeId);
          return t;
        }),
      );
      const ids = SEED.map((p) => p.id);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      const recorded: string[] = [];

      for (let step = 0; step < 120; step++) {
        const { till, timers } = pick(tills);
        const x = r();
        if (x < 0.45) recorded.push((await till.sell(pick(ids), 1 + Math.floor(r() * 3))).id);
        else if (x < 0.6) recorded.push((await till.receive(pick(ids), 1 + Math.floor(r() * 10))).id);
        else if (x < 0.68) recorded.push((await till.count(pick(ids), Math.floor(r() * 30))).id);
        else if (x < 0.8) till.setOnline(!till.getView().online);
        else if (x < 0.9) net.fault = pick<Fault>(['none', 'none', 'drop-request', 'drop-response', 'duplicate']);
        else timers.fireAll();
        if (r() < 0.3) await till.sync();
      }

      // Heal the network and let everyone catch up.
      net.fault = 'none';
      for (let round = 0; round < 3; round++) {
        for (const { till, timers } of tills) {
          till.setOnline(true);
          timers.fireAll();
          await till.sync();
        }
      }

      const server = await getState(pool, s.storeId, 10_000);
      // Every recorded op is on the server exactly once.
      expect(server.journal).toHaveLength(recorded.length);
      expect(new Set(server.journal.map((j) => j.opId))).toEqual(new Set(recorded));
      // Stock equals the opening stock plus every movement's delta.
      for (const p of SEED) {
        const deltas = server.journal.filter((j) => j.productId === p.id).reduce((a, j) => a + j.delta, 0);
        expect(server.products.find((x) => x.id === p.id)!.stock).toBe(p.stock + deltas);
      }
      // Every till shows exactly what the server has, with nothing pending.
      for (const { till } of tills) {
        expect(till.getView().snapshot.outbox).toHaveLength(0);
        for (const p of server.products) {
          const mine = till.getView().products.find((x) => x.id === p.id)!;
          expect([p.id, mine.stock, mine.pending]).toEqual([p.id, p.stock, 0]);
        }
      }
    });
  }
});
