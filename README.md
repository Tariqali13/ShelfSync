# ShelfSync

An offline-first point of sale. Each till keeps selling with no connection, keeps its changes in the browser, and syncs them when the connection comes back, without losing a sale or counting one twice. That includes the awkward case: two tills, both offline, both selling the last item.

**Live demo: [shelf-sync.netlify.app](https://shelf-sync.netlify.app)**. You get a private demo store with two tills and a back office. Switch a till's network off, sell, switch it back on. Or press *Play the last-mug problem*.

![Two offline tills have each sold the last mug; both sales are queued on the tills](docs/offline.png)

## The problem it solves

A shop with more than one till, and a connection that comes and goes (a market stall, a basement, a pop-up). Two things go wrong in a naive design.

**Lost updates.** If tills sync *stock levels* ("mugs = 0"), two tills that each sold one mug offline both report 0, and one of the sales disappears. ShelfSync tills sync *what happened* ("sold 1 mug", "received 12", "counted 7 on the shelf"). Deltas from any number of tills add up correctly in any order.

**Selling what you don't have.** Both tills see one mug left, and both sell it. The second sale can't be refused: the customer has already left with the mug. So the server records it, stock goes to −1, and it raises a discrepancy for a person to resolve with a recount. That's what a real shop would do, and the books stay honest.

![After both tills reconnect, the second sale is flagged and the back office asks for a recount](docs/flagged.png)

## How sync works

```
 Till (browser)                                     Server (Netlify Function + Postgres)
 ─────────────                                      ───────────────────────────────────
 record sale ──► outbox in IndexedDB                POST /api/stores/:id/sync
                 (survives closing the tab)         { deviceId, since: 41, ops: [...] }
                       │                                       │
       network on? ────┴──► send outbox in order ───► one transaction per store:
                                                      · advisory lock (serialise this store)
                                                      · each op: already seen? return first answer
                                                      ·          else apply delta, assign seq
                                                      · return changes with seq > 41
 apply answer ◄─────────────────────────────────────── { results, products, seq: 44 }
 (outbox removal + new state in ONE IndexedDB transaction)
```

- **Local first.** A sale is written to the till's outbox (IndexedDB) before anything touches the network, so the till never waits and a closed tab loses nothing.
- **Idempotent.** Every operation carries an ID generated on the till. If a response is lost and the till sends again, the server returns its first answer instead of applying it twice ([`server/store.ts`](server/store.ts)).
- **Atomic acknowledgement.** Removing ops from the outbox and saving their effects happen in one IndexedDB transaction, so a crash in between can neither drop a sale nor re-send an applied one as new ([`src/sync/storage.ts`](src/sync/storage.ts)).
- **Ordered and gap-free.** Each store's syncs are serialised with a transaction-scoped advisory lock. Without it, two concurrent syncs could commit sequence numbers out of order, and a till pulling "everything since #11" would never see #10.
- **Counts that don't erase other tills' work.** A count says "as this till last knew the shelf (seq *n*), there are *k*". The server keeps movements other tills made after *n* on top, instead of overwriting them with last-write-wins.
- **Backoff.** When the server can't be reached, the till retries at 1, 2, 4, 8, 16 and then every 30 seconds, with jitter, and keeps selling meanwhile ([`src/sync/till.ts`](src/sync/till.ts)).

## Correctness

The sync engine is tested against the real server code and a real Postgres database, through a transport that fails on purpose:

- **Chaos convergence.** Three tills make random sales, deliveries and counts while switching their network on and off. The network meanwhile drops requests, loses responses after the server has applied them, and delivers requests twice. When the network heals, every till must match the server, every operation must be on the server exactly once, and stock must equal opening stock plus the sum of all movements. CI runs 5 seeds; it has also passed 200.
- **Concurrency.** 24 simultaneous syncs (a third of them replays) sell exactly 48 totes, with every intermediate stock level accounted for.
- **Each rule above has its own test**: the last-mug conflict, counts keeping other tills' sales, counts including the till's own unsynced sales, lost responses, ops recorded during an in-flight sync, backoff timings, an outbox surviving a reload, expired stores, and invalid requests.

```bash
npm test     # 22 tests; needs Postgres (see below)
```

## Stack

React 19, TypeScript, Vite, IndexedDB ([idb](https://github.com/jakearchibald/idb)), Express 5 running as a Netlify Function, PostgreSQL (Neon), Zod for the shared protocol, Vitest, and lucide-react icons.

```
shared/protocol.ts    operations, results and validation shared by tills and server
server/               Express API, schema, the sync transaction
src/sync/             Till (outbox, sync loop, backoff), IndexedDB and in-memory storage, HTTP transport
src/ui/               two tills, back office, guided scenario
netlify/functions/    the API as a serverless function under /api
```

## Run it

```bash
npm install
cp .env.example .env          # point DATABASE_URL at any Postgres 14+
npm run dev:api               # API on :4001 (creates its tables on first request)
npm run dev                   # app on :5173, proxies /api
```

Tests use `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/shelfsync_test`).

<img src="docs/phone.png" width="300" alt="ShelfSync on a phone, with two sales waiting to send" />

## About the demo

Each visitor gets a private store, deleted after 24 hours. All products and numbers are made up. The two tills run side by side in one page so you can watch them disagree and then converge. Each has its own IndexedDB database and outbox, exactly as two separate devices would.

## Licence

MIT. Built by [Tariq Ali](https://tariqali.dev).
