import { useState } from 'react';
import { Minus, PackagePlus, ClipboardCheck, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import type { Till, TillView } from '../sync/till';
import type { Op, OpResult } from '../../shared/protocol';
import { clock, money, num, relative, useNow } from './format';
import { useTill } from './useTill';

interface Props {
  till: Till;
  place: string;
  /** Product to draw attention to (the guided scenario). */
  spotlight?: string | null;
}

export function TillPanel({ till, place, spotlight }: Props) {
  const v = useTill(till);
  const [editing, setEditing] = useState<{ productId: string; mode: 'receive' | 'count' } | null>(null);
  const [amount, setAmount] = useState('');
  const names = Object.fromEntries(v.products.map((p) => [p.id, p.name]));

  const submit = () => {
    if (!editing) return;
    const n = Number(amount);
    if (!Number.isInteger(n) || n < (editing.mode === 'count' ? 0 : 1)) return;
    if (editing.mode === 'receive') void till.receive(editing.productId, n);
    else void till.count(editing.productId, n);
    setEditing(null);
    setAmount('');
  };

  return (
    <section className={`till conn-${v.connection}`} aria-label={v.label}>
      <header className="till-head">
        <div>
          <h2>{v.label}</h2>
          <p className="till-place">{place}</p>
        </div>
        <label className="net-switch">
          <input type="checkbox" role="switch" checked={v.online} onChange={(e) => till.setOnline(e.target.checked)} aria-label={`${v.label} network`} />
          <span className="net-track" aria-hidden="true"><span className="net-thumb" /></span>
          <span className="net-label">{v.online ? <Wifi size={15} /> : <WifiOff size={15} />}{v.online ? 'Online' : 'Offline'}</span>
        </label>
      </header>

      <Status v={v} onRetry={() => void till.sync()} />

      <ul className="shelf">
        {v.products.map((p) => {
          const low = p.stock <= p.reorderAt;
          const isEditing = editing?.productId === p.id;
          return (
            <li key={p.id} className={`item${spotlight === p.id ? ' is-spotlit' : ''}`}>
              <div className="item-main">
                <span className="item-name">{p.name}</span>
                <span className="item-meta">{p.sku}, {money(p.priceCents)}</span>
              </div>
              <div className={`item-stock${p.stock < 0 ? ' is-negative' : low ? ' is-low' : ''}`}>
                <b>{num(p.stock)}</b>
                {p.pending !== 0 && <span className="pending" title="Changes on this till not yet sent">{p.pending > 0 ? '+' : '−'}{Math.abs(p.pending)} unsent</span>}
              </div>
              <div className="item-actions">
                <button type="button" className="btn-sell" onClick={() => void till.sell(p.id)} disabled={!v.ready}>
                  <Minus size={14} aria-hidden="true" />Sell 1
                </button>
                <button type="button" className="icon-act" title="Stock delivered" aria-label={`Record a delivery of ${p.name}`} onClick={() => { setEditing({ productId: p.id, mode: 'receive' }); setAmount(''); }}>
                  <PackagePlus size={16} />
                </button>
                <button type="button" className="icon-act" title="Count the shelf" aria-label={`Count ${p.name} on the shelf`} onClick={() => { setEditing({ productId: p.id, mode: 'count' }); setAmount(String(Math.max(0, p.stock))); }}>
                  <ClipboardCheck size={16} />
                </button>
              </div>
              {isEditing && (
                <form className="item-edit" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                  <label>
                    {editing.mode === 'receive' ? 'Units delivered' : 'Units on the shelf'}
                    <input autoFocus inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} />
                  </label>
                  <button type="submit" className="btn-small">{editing.mode === 'receive' ? 'Record delivery' : 'Record count'}</button>
                  <button type="button" className="btn-link" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      <Receipt v={v} names={names} />
    </section>
  );
}

function Status({ v, onRetry }: { v: TillView; onRetry: () => void }) {
  const now = useNow(500);
  const waiting = v.snapshot.outbox.length;
  const unsent = `${waiting} change${waiting === 1 ? '' : 's'} waiting to send`;
  let text: string;
  switch (v.connection) {
    case 'syncing': text = waiting ? `Sending ${unsent.replace(' waiting to send', '')}…` : 'Checking for changes…'; break;
    case 'offline': text = waiting ? `Offline. ${unsent}.` : 'Offline. Sales are saved on this till.'; break;
    case 'unreachable': text = `Can't reach the server. ${waiting ? unsent + '. ' : ''}Retrying in ${relative((v.nextRetryAt ?? now) - now)}.`; break;
    case 'expired': text = 'This demo store has expired. Start a new one at the top of the page.'; break;
    case 'error': text = `The server refused a change: ${v.lastError}`; break;
    default: text = v.lastSyncedAt ? `Up to date, synced at ${clock(v.lastSyncedAt)}.` : 'Up to date.';
  }
  return (
    <p className="till-status" role="status">
      <span className="dot" aria-hidden="true" />
      {text}
      {v.connection === 'unreachable' && (
        <button type="button" className="btn-link" onClick={onRetry}><RefreshCw size={13} aria-hidden="true" /> Retry now</button>
      )}
    </p>
  );
}

function describe(op: Op, names: Record<string, string>) {
  const name = names[op.productId] ?? op.productId;
  if (op.kind === 'sale') return { verb: 'SALE', what: `${name} ×${op.qty}` };
  if (op.kind === 'receive') return { verb: 'IN', what: `${name} +${op.qty}` };
  return { verb: 'COUNT', what: `${name} = ${op.counted}` };
}

function Stamp({ result }: { result?: OpResult }) {
  if (!result) return <span className="stamp stamp-queued">Queued</span>;
  if (result.status === 'flagged') return <span className="stamp stamp-flagged">Flagged</span>;
  if (result.status === 'rejected') return <span className="stamp stamp-flagged">Refused</span>;
  return <span className="stamp stamp-ok">#{result.seq}</span>;
}

/** The till's sync log, printed like a receipt: queued changes on top, acknowledged ones below. */
function Receipt({ v, names }: { v: TillView; names: Record<string, string> }) {
  const queued = [...v.snapshot.outbox].reverse();
  const sent = v.snapshot.history.slice(0, 12);
  return (
    <div className="receipt" aria-label={`${v.label} sync log`}>
      <div className="receipt-head">
        <span>Sync log</span>
        <span>{v.label.toUpperCase()}</span>
      </div>
      {queued.length === 0 && sent.length === 0 && <p className="receipt-empty">Nothing recorded yet. Sell something.</p>}
      <ol>
        {queued.map(({ op }) => {
          const d = describe(op, names);
          return (
            <li key={op.id} className="line is-queued">
              <span className="line-time">{clock(op.at)}</span>
              <span className="line-what"><b>{d.verb}</b> {d.what}</span>
              <Stamp />
            </li>
          );
        })}
        {sent.map(({ op, result }) => {
          const d = describe(op, names);
          return (
            <li key={op.id} className={`line is-${result.status}`}>
              <span className="line-time">{clock(op.at)}</span>
              <span className="line-what">
                <b>{d.verb}</b> {d.what}
                {result.duplicate && <em className="line-note">Server already had this one; not applied twice.</em>}
                {result.message && <em className="line-note">{result.message}</em>}
              </span>
              <Stamp result={result} />
            </li>
          );
        })}
      </ol>
      <div className="receipt-tear" aria-hidden="true" />
    </div>
  );
}
