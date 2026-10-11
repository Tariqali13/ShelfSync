import { useSyncExternalStore } from 'react';
import type { Till, TillView } from '../sync/till';

export function useTill(till: Till): TillView {
  return useSyncExternalStore(till.subscribe, till.getView, till.getView);
}
