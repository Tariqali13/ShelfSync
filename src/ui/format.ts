import { useEffect, useState } from 'react';

/** Current time that re-renders the caller every `ms` (render functions must not read the clock). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Signed integer with a real minus sign. */
export const num = (n: number) => (n < 0 ? `\u2212${-n}` : String(n));

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function relative(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

export const DEVICE_LABELS: Record<string, string> = { 'till-1': 'Till 1', 'till-2': 'Till 2', office: 'Back office' };
export const deviceLabel = (id: string) => DEVICE_LABELS[id] ?? id;
