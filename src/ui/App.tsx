import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, RotateCcw, X } from 'lucide-react';
import type { StoreState } from '../../shared/protocol';
import { IndexedDbStorage, MemoryStorage, type TillStorage } from '../sync/storage';
import { Till } from '../sync/till';
import { createStoreRemote, httpTransport } from '../sync/http';
import { TillPanel } from './TillPanel';
import { BackOffice } from './BackOffice';
import { relative, useNow } from './format';

const STORE_KEY = 'shelfsync:store';
const PULL_EVERY_MS = 6000;

function storageFor(storeId: string, deviceId: string): TillStorage {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbStorage(`shelfsync:${storeId}:${deviceId}`);
  } catch {
    // Private windows in some browsers refuse IndexedDB.
  }
  return new MemoryStorage();
}

function readStoreId(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function writeStoreId(id: string | null) {
  try {
    if (id) localStorage.setItem(STORE_KEY, id);
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: the store just won't survive a reload.
  }
}

/** Reuse this browser's demo store if the server still has it; otherwise create one. */
async function openStore(fresh: boolean): Promise<string> {
  let id = fresh ? null : readStoreId();
  if (id) {
    try {
      await httpTransport.getStore(id);
    } catch {
      id = null; // expired or unknown: make a new one
    }
  }
  if (!id) {
    id = (await createStoreRemote()).storeId;
    writeStoreId(id);
  }
  return id;
}

type Boot = { phase: 'loading'; slow: boolean } | { phase: 'ready'; storeId: string } | { phase: 'failed'; message: string };

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading', slow: false });

  const start = useCallback((fresh: boolean) => {
    const slow = setTimeout(() => setBoot((b) => (b.phase === 'loading' ? { phase: 'loading', slow: true } : b)), 1500);
    openStore(fresh)
      .then((storeId) => setBoot({ phase: 'ready', storeId }))
      .catch((e: unknown) => setBoot({ phase: 'failed', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => clearTimeout(slow));
  }, []);

  const restart = (fresh: boolean) => {
    setBoot({ phase: 'loading', slow: false });
    start(fresh);
  };

  useEffect(() => start(false), [start]);

  if (boot.phase === 'loading') {
    return (
      <main className="boot">
        <Wordmark />
        <p>{boot.slow ? 'Waking the server and opening your store. The free database sleeps when nobody is using it; this takes a few seconds.' : 'Opening your store…'}</p>
      </main>
    );
  }
  if (boot.phase === 'failed') {
    return (
      <main className="boot">
        <Wordmark />
        <p>Couldn't open a store: {boot.message}</p>
        <button type="button" className="btn" onClick={() => restart(false)}>Try again</button>
      </main>
    );
  }
  return <Shop key={boot.storeId} storeId={boot.storeId} onNewStore={() => restart(true)} />;
}

function Wordmark() {
  return (
    <span className="wordmark">
      Shelf<span>Sync</span>
    </span>
  );
}

const SCENARIO = [
  'Setting the shelf: one ceramic travel mug left.',
  'Both tills lose their connection, like a market stall with no signal.',
  'Till 1 sells the last mug. It has no way to tell Till 2.',
  'Till 2 still sees one mug, so it sells "the last mug" too. Two customers, two mugs, one on record.',
  'Till 1 reconnects. Its sale is applied and stock on record goes to 0.',
  'Till 2 reconnects. Its sale happened, so it is kept rather than refused, but stock went to −1 and the server flags it for a recount.',
  'Nothing was lost and nothing counted twice. Count the shelf in the back office to resolve it.',
];

function Shop({ storeId, onNewStore }: { storeId: string; onNewStore: () => void }) {
  const tills = useMemo(
    () => ({
      a: new Till({ deviceId: 'till-1', label: 'Till 1', storage: storageFor(storeId, 'till-1'), transport: httpTransport }),
      b: new Till({ deviceId: 'till-2', label: 'Till 2', storage: storageFor(storeId, 'till-2'), transport: httpTransport }),
      office: new Till({ deviceId: 'office', label: 'Back office', storage: storageFor(storeId, 'office'), transport: httpTransport }),
    }),
    [storeId],
  );
  const [state, setState] = useState<StoreState | null>(null);
  const [tab, setTab] = useState<'a' | 'b' | 'office'>('a');
  const [step, setStep] = useState<number | null>(null);
  const [explain, setExplain] = useState(false);
  const running = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await httpTransport.getStore(storeId));
    } catch {
      // The back office just shows its last copy until the server is reachable.
    }
  }, [storeId]);

  // Open the tills; when one syncs, nudge the others to pull and refresh the back office.
  useEffect(() => {
    const all = [tills.a, tills.b, tills.office];
    let alive = true;
    void Promise.all(all.map((t) => t.open(storeId).catch(() => {}))).then(() => {
      if (alive) void refresh();
    });
    const last = new Map<Till, string | null>();
    const unsubs = all.map((t) =>
      t.subscribe(() => {
        const v = t.getView();
        if (v.lastSyncedAt && v.lastSyncedAt !== last.get(t)) {
          last.set(t, v.lastSyncedAt);
          if (v.snapshot.history[0]?.syncedAt === v.lastSyncedAt) {
            for (const other of all) if (other !== t) void other.sync();
            void refresh();
          }
        }
      }),
    );
    // Other tabs on the same store, and changes we would otherwise only see on the next action.
    const timer = setInterval(() => {
      for (const t of all) void t.sync();
      void refresh();
    }, PULL_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      unsubs.forEach((u) => u());
      all.forEach((t) => t.close());
    };
  }, [tills, storeId, refresh]);

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const runScenario = async () => {
    if (running.current) return;
    running.current = true;
    try {
      setStep(0);
      // Make sure the shelf really has exactly one mug, whatever the visitor did before.
      tills.a.setOnline(true);
      tills.b.setOnline(true);
      await Promise.all([tills.a.sync(), tills.b.sync()]);
      await tills.office.count('mug', 1);
      await tills.office.sync();
      await Promise.all([tills.a.sync(), tills.b.sync()]);
      await pause(1600);
      setStep(1);
      tills.a.setOnline(false);
      tills.b.setOnline(false);
      await pause(1800);
      setStep(2);
      setTab('a');
      await tills.a.sell('mug');
      await pause(2000);
      setStep(3);
      setTab('b');
      await tills.b.sell('mug');
      await pause(2400);
      setStep(4);
      setTab('a');
      tills.a.setOnline(true);
      await tills.a.sync();
      await pause(2400);
      setStep(5);
      setTab('b');
      tills.b.setOnline(true);
      await tills.b.sync();
      await refresh();
      await pause(2600);
      setStep(6);
      setTab('office');
    } finally {
      running.current = false;
    }
  };

  const spotlight = step !== null ? 'mug' : null;
  const now = useNow(30_000);
  const expiresIn = state ? new Date(state.expiresAt).getTime() - now : null;

  return (
    <div className="shop" data-tab={tab}>
      <header className="masthead">
        <div className="mast-id">
          <Wordmark />
          <p className="mast-store">
            {state?.name ?? 'Your store'}{expiresIn !== null && <span>. Private to you; resets in {relative(expiresIn)}.</span>}
          </p>
        </div>
        <p className="mast-pitch">Two tills that keep selling with no connection and sync safely when it comes back, even when both sold the last one.</p>
        <div className="mast-actions">
          <button type="button" className="btn btn-primary" onClick={() => void runScenario()} disabled={step !== null && step < SCENARIO.length - 1}>
            <Play size={15} aria-hidden="true" /> Play the last-mug problem
          </button>
          <button type="button" className="btn" onClick={() => setExplain(true)}>How sync works</button>
          <button type="button" className="btn btn-quiet" onClick={onNewStore} title="Start again with a fresh store">
            <RotateCcw size={14} aria-hidden="true" /> New store
          </button>
        </div>
      </header>

      {step !== null && (
        <div className="narration" role="status" aria-live="polite">
          <ol>
            {SCENARIO.map((s, i) => (
              <li key={i} className={i === step ? 'is-now' : i < step ? 'is-done' : ''}>{s}</li>
            ))}
          </ol>
          {step === SCENARIO.length - 1 && (
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => setStep(null)}><X size={16} /></button>
          )}
        </div>
      )}

      <nav className="tabs" aria-label="Devices">
        {(['a', 'b', 'office'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {k === 'a' ? 'Till 1' : k === 'b' ? 'Till 2' : 'Back office'}
          </button>
        ))}
      </nav>

      <div className="floor">
        <div className="pane pane-a"><TillPanel till={tills.a} place="Front counter" spotlight={spotlight} /></div>
        <div className="pane pane-b"><TillPanel till={tills.b} place="Market stall" spotlight={spotlight} /></div>
        <div className="pane pane-office">
          <BackOffice state={state} spotlight={spotlight} onCount={(id, n) => void tills.office.count(id, n)} />
        </div>
      </div>

      <footer className="foot">
        Each till keeps its own copy of the shop in this browser (IndexedDB) and its own queue of changes. Switch one off, sell, and switch it back on.
        {' '}Built by <a href="https://tariqali.dev" target="_blank" rel="noreferrer">Tariq Ali</a>. <a href="https://github.com/Tariqali13/ShelfSync" target="_blank" rel="noreferrer">Source</a>
      </footer>

      {explain && <Explainer onClose={() => setExplain(false)} />}
    </div>
  );
}

function Explainer({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="dialog-wrap" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="explain-title" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2 id="explain-title">How sync works</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} autoFocus><X size={18} /></button>
        </header>
        <dl>
          <dt>Tills record what happened, not what stock should be.</dt>
          <dd>"Sold 1" from two tills adds up to two sales. "Stock is 0" from two tills would silently lose one of them.</dd>
          <dt>Every change is saved on the till first.</dt>
          <dd>It goes into an outbox in the browser's database, so a sale never waits for the network and survives closing the tab.</dd>
          <dt>Sending is safe to repeat.</dt>
          <dd>Each change carries an ID it was given on the till. If a response gets lost and the till sends again, the server answers with its first result instead of applying it twice.</dd>
          <dt>A sale that already happened is never refused.</dt>
          <dd>If it takes stock below zero, it is recorded and flagged for a person to recount, which is what a shop would actually do.</dd>
          <dt>Counts don't erase other tills' work.</dt>
          <dd>A count says what was on the shelf as this till last knew it. Sales other tills made since then are kept on top.</dd>
          <dt>The server applies one store's changes one batch at a time.</dt>
          <dd>So every change gets the next number in order, and a till asking "what changed since #41?" can never miss one.</dd>
        </dl>
      </div>
    </div>
  );
}
