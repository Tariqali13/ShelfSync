import pg from 'pg';

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS stores (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stores_created_at ON stores (created_at);

CREATE TABLE IF NOT EXISTS products (
  store_id     uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  id           text NOT NULL,
  sku          text NOT NULL,
  name         text NOT NULL,
  price_cents  integer NOT NULL CHECK (price_cents >= 0),
  reorder_at   integer NOT NULL DEFAULT 0,
  stock        integer NOT NULL,
  seq          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (store_id, id)
);

-- Every operation a till ever sent, once. (store_id, op_id) is the idempotency key.
CREATE TABLE IF NOT EXISTS movements (
  seq          bigserial UNIQUE,
  store_id     uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  op_id        uuid NOT NULL,
  device_id    text NOT NULL,
  product_id   text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sale', 'receive', 'count')),
  qty          integer,
  counted      integer,
  base_seq     bigint,
  delta        integer NOT NULL,
  stock_after  integer,
  status       text NOT NULL CHECK (status IN ('applied', 'flagged', 'rejected')),
  message      text,
  client_at    timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, op_id)
);
CREATE INDEX IF NOT EXISTS movements_product_seq ON movements (store_id, product_id, seq);
CREATE INDEX IF NOT EXISTS movements_store_seq ON movements (store_id, seq);

-- Stock that went below zero: a sale happened that the records could not cover.
CREATE TABLE IF NOT EXISTS discrepancies (
  id            bigserial PRIMARY KEY,
  store_id      uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  product_id    text NOT NULL,
  shortfall     integer NOT NULL,
  device_id     text NOT NULL,
  opened_seq    bigint NOT NULL,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  resolved_seq  bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS discrepancies_one_open ON discrepancies (store_id, product_id) WHERE resolved_seq IS NULL;
`;

export type Pool = pg.Pool;

export function createPool(url = process.env.DATABASE_URL): pg.Pool {
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and point it at a Postgres database.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the value: it contains a password.
    throw new Error('DATABASE_URL is not a valid postgres:// URL.');
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || parsed.hostname.startsWith('/');
  return new pg.Pool({
    connectionString: url,
    // Serverless functions get few concurrent requests each; keep connections few and short-lived.
    max: Number(process.env.PG_POOL_MAX ?? 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    ssl: local ? undefined : { rejectUnauthorized: true },
  });
}

const migrated = new WeakMap<pg.Pool, Promise<void>>();

/** Create tables once per process. Safe to call on every request. */
export function migrate(pool: pg.Pool): Promise<void> {
  let p = migrated.get(pool);
  if (!p) {
    p = (async () => {
      const c = await pool.connect();
      try {
        // Two cold starts at once must not race on CREATE TABLE.
        await c.query('SELECT pg_advisory_lock(7240501)');
        await c.query(SCHEMA);
      } finally {
        await c.query('SELECT pg_advisory_unlock(7240501)').catch(() => {});
        c.release();
      }
    })();
    p.catch(() => migrated.delete(pool));
    migrated.set(pool, p);
  }
  return p;
}
