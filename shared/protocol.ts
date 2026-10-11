import { z } from 'zod';

/**
 * The sync protocol shared by the tills (browser) and the server.
 *
 * Tills never send stock levels, only what happened: "sold 2", "received 12",
 * "counted 7". Those operations are deltas, so the server can apply them in any
 * interleaving from any number of tills and still arrive at the right stock,
 * where "set stock to N" from two devices would silently lose one of them.
 */

const id = z.string().min(1).max(40);
const qty = z.number().int().min(1).max(10_000);

const base = {
  /** Client-generated UUID. Doubles as the idempotency key: replays are answered, not re-applied. */
  id: z.uuid(),
  productId: id,
  /** When it happened on the till (for the journal only; ordering is the server's job). */
  at: z.iso.datetime(),
};

export const SaleOp = z.object({ ...base, kind: z.literal('sale'), qty });
export const ReceiveOp = z.object({ ...base, kind: z.literal('receive'), qty });
/**
 * A stock count: "I counted N on the shelf". `baseSeq` is the last server
 * sequence number the till had seen for this product when it counted, so
 * movements other tills made after that are kept rather than overwritten.
 */
export const CountOp = z.object({ ...base, kind: z.literal('count'), counted: z.number().int().min(0).max(1_000_000), baseSeq: z.number().int().min(0) });

export const Op = z.discriminatedUnion('kind', [SaleOp, ReceiveOp, CountOp]);
export type Op = z.infer<typeof Op>;
export type OpKind = Op['kind'];

export const SyncRequest = z.object({
  deviceId: z.string().min(1).max(64),
  /** Highest server sequence this till has already pulled (from the store endpoint or a previous sync). */
  since: z.number().int().min(0),
  ops: z.array(Op).max(200),
});
export type SyncRequest = z.infer<typeof SyncRequest>;

export interface ProductState {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  reorderAt: number;
  stock: number;
  /** Sequence number of the last movement that touched this product. */
  seq: number;
}

/**
 * - applied: done as asked.
 * - flagged: done, but it took stock below zero. A sale that already happened
 *   at the till cannot be refused, so it is recorded and raised for a person
 *   to resolve, usually with a recount.
 * - rejected: not applied (e.g. the product does not exist).
 */
export type OpStatus = 'applied' | 'flagged' | 'rejected';

export interface OpResult {
  opId: string;
  status: OpStatus;
  /** True when this op had already been received; the original result is returned. */
  duplicate: boolean;
  delta: number;
  stockAfter: number | null;
  seq: number | null;
  message?: string;
}

export interface Discrepancy {
  id: number;
  productId: string;
  /** How far below zero stock went. */
  shortfall: number;
  openedSeq: number;
  openedAt: string;
  deviceId: string;
}

export interface JournalEntry {
  seq: number;
  opId: string;
  deviceId: string;
  productId: string;
  kind: OpKind;
  qty: number | null;
  counted: number | null;
  delta: number;
  stockAfter: number;
  status: OpStatus;
  at: string;
  receivedAt: string;
}

export interface SyncResponse {
  results: OpResult[];
  /** Products changed since the request's `since`. */
  products: ProductState[];
  discrepancies: Discrepancy[];
  seq: number;
}

export interface StoreState {
  storeId: string;
  name: string;
  products: ProductState[];
  discrepancies: Discrepancy[];
  journal: JournalEntry[];
  seq: number;
  expiresAt: string;
}

/** Stock change an op implies, given the stock the till believes the product has. */
export function localDelta(op: Op, believedStock: number): number {
  switch (op.kind) {
    case 'sale':
      return -op.qty;
    case 'receive':
      return op.qty;
    case 'count':
      return op.counted - believedStock;
  }
}
