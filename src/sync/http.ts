import type { StoreState, SyncRequest, SyncResponse } from '../../shared/protocol';
import { BadRequest, NetworkError, StoreGone, type Transport } from './till';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  } catch {
    throw new NetworkError('Cannot reach the server.');
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // A proxy or platform error page: treat as temporarily unavailable.
    throw new NetworkError(`The server answered ${res.status} without data.`);
  }
  const message = (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
  if (res.status === 404) throw new StoreGone(message);
  if (res.status === 400) throw new BadRequest(message);
  if (!res.ok) throw new NetworkError(message);
  return body as T;
}

export const httpTransport: Transport = {
  getStore: (storeId) => call<StoreState>(`/api/stores/${storeId}`),
  sync: (storeId, req: SyncRequest) => call<SyncResponse>(`/api/stores/${storeId}/sync`, { method: 'POST', body: JSON.stringify(req) }),
};

export const createStoreRemote = () => call<StoreState>('/api/stores', { method: 'POST' });
