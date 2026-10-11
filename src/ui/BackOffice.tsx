import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { StoreState } from '../../shared/protocol';
import { clock, deviceLabel, money, num } from './format';

interface Props {
  state: StoreState | null;
  /** Record a shelf count from the back office. */
  onCount: (productId: string, counted: number) => void;
  spotlight?: string | null;
}

/** What the server holds: the single source of truth every till converges to. */
export function BackOffice({ state, onCount, spotlight }: Props) {
  const [counting, setCounting] = useState<Record<string, string>>({});
  if (!state) return <section className="office" aria-label="Back office"><p className="muted">Loading the server's records…</p></section>;
  const names = Object.fromEntries(state.products.map((p) => [p.id, p.name]));
  const value = state.products.reduce((a, p) => a + Math.max(0, p.stock) * p.priceCents, 0);

  return (
    <section className="office" aria-label="Back office">
      <header className="office-head">
        <h2>Back office</h2>
        <p>The server's records. Every till ends up here.</p>
      </header>

      {state.discrepancies.length > 0 && (
        <div className="attention" role="alert">
          <h3><AlertTriangle size={16} aria-hidden="true" /> Needs a recount</h3>
          {state.discrepancies.map((d) => (
            <form
              key={d.id}
              className="attention-item"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(counting[d.productId] ?? '');
                if (Number.isInteger(n) && n >= 0) onCount(d.productId, n);
              }}
            >
              <p>
                <b>{names[d.productId]}</b>: sold {d.shortfall} more than the records showed. {deviceLabel(d.deviceId)} sold it while offline, after another till had already sold the stock. Both sales stand; count the shelf to set the record straight.
              </p>
              <label>
                On the shelf now
                <input inputMode="numeric" placeholder="0" value={counting[d.productId] ?? ''} onChange={(e) => setCounting((c) => ({ ...c, [d.productId]: e.target.value.replace(/[^0-9]/g, '') }))} />
              </label>
              <button type="submit" className="btn-small">Record count</button>
            </form>
          ))}
        </div>
      )}

      <table className="ledger">
        <caption>Stock on record, worth {money(value)}</caption>
        <thead>
          <tr><th scope="col">Product</th><th scope="col" className="num">Stock</th><th scope="col" className="num">Last change</th></tr>
        </thead>
        <tbody>
          {state.products.map((p) => (
            <tr key={p.id} className={spotlight === p.id ? 'is-spotlit' : ''}>
              <th scope="row">{p.name}</th>
              <td className={`num${p.stock < 0 ? ' is-negative' : p.stock <= p.reorderAt ? ' is-low' : ''}`}>{num(p.stock)}</td>
              <td className="num muted">{p.seq ? `#${p.seq}` : 'opening'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="journal-title">Journal</h3>
      {state.journal.length === 0 ? (
        <p className="muted small">No movements yet. Every change a till sends appears here once, in the order the server applied it.</p>
      ) : (
        <ol className="journal">
          {state.journal.slice(0, 14).map((j) => (
            <li key={j.seq} className={`is-${j.status}`}>
              <span className="j-seq">#{j.seq}</span>
              <span className="j-what">
                {deviceLabel(j.deviceId)}: {j.kind === 'sale' ? `sold ${j.qty}` : j.kind === 'receive' ? `received ${j.qty}` : `counted ${j.counted}`} {names[j.productId] ?? j.productId}
              </span>
              <span className="j-stock">{j.delta > 0 ? '+' : j.delta < 0 ? '−' : '±'}{Math.abs(j.delta)} → {j.stockAfter === null ? '—' : num(j.stockAfter)}</span>
              <span className="j-time">{clock(j.receivedAt)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
