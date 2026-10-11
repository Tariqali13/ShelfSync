# ShelfSync

[![Live demo](https://img.shields.io/badge/Live%20demo-Netlify-00C7B7?logo=netlify&logoColor=white)](https://shelf-sync.netlify.app)

ShelfSync is an offline-aware inventory and operations workspace built as an independent full-stack portfolio project. It demonstrates business workflow design, state management, stock validation, responsive UI, and a Node.js API foundation.

**[Open the live demo →](https://shelf-sync.netlify.app)**

## Product capabilities

- Inventory search, stock valuation, and low-stock signals
- Validated stock movements with browser-side persistence
- Offline queue state and reconnection feedback
- Purchase-order, supplier, and reporting workspaces
- CSV inventory export
- Record detail drawers and workflow feedback
- Netlify Function-backed order and supplier data for the deployed demo

All data is synthetic. No client code, customer records, credentials, or proprietary workflows are included.

## Deployment

The public demo is deployed on Netlify. The React/Vite client is served from `dist`, and a same-origin Netlify Function supplies the synthetic purchase-order and supplier data used by the live workspace.

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

---

Built by [Tariq Ali](https://tariqali.dev). Data in the demo is synthetic.
