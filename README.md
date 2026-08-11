# ShelfSync

ShelfSync is an offline-aware inventory and operations workspace built as an independent full-stack portfolio project. It demonstrates business workflow design, state management, stock validation, responsive UI, and a Node.js API foundation.

## Product capabilities

- Inventory search, stock valuation, and low-stock signals
- Validated stock movements with browser-side persistence
- Offline queue state and reconnection feedback
- Purchase-order, supplier, and reporting workspaces
- CSV inventory export
- Record detail drawers and workflow feedback
- Local Express API for products, orders, suppliers, and stock movements

All data is synthetic. No client code, customer records, credentials, or proprietary workflows are included.

## Architecture

```text
React + TypeScript (Vite)
        |
        +--> local offline state / queue
        |
        v
Express API (Node.js)
        |
        +--> inventory, suppliers, orders, stock movements
```

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev:api
```

In another terminal:

```bash
npm run dev
```

The API runs on `http://localhost:4001`; Vite prints the client URL.

## Quality

```bash
npm run build
npm run lint
```

## Roadmap

- PostgreSQL persistence and tenant isolation
- Authenticated roles and approvals
- Camera-backed barcode scanning
- Inventory receiving, supplier management, and browser end-to-end tests

## Security

Use synthetic data only. Keep configuration in local `.env` files and never commit secrets.

See [SECURITY.md](SECURITY.md).
