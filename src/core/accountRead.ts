import { AsyncLocalStorage } from 'async_hooks';
import { broker } from '../broker';

/** One observation of each broker resource per context build, including failed reads. */
const reads = new AsyncLocalStorage<Map<string, Promise<any>>>();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  const scope = reads.getStore();
  if (!scope) return load();
  if (!scope.has(key)) scope.set(key, load());
  return scope.get(key)!;
}
export const readAccount = () => once('account', () => broker.getAccountInfo());
export const readPositions = () => once('positions', () => broker.getPositions());
export const readOrders = () => once('orders', () => broker.getOpenOrders());
export function withAccountRead<T>(work: () => Promise<T>): Promise<T> {
  return reads.run(new Map(), async () => {
    // Start independently; consumers receive the same observations or errors.
    await Promise.allSettled([readAccount(), readPositions(), readOrders()]);
    return work();
  });
}
