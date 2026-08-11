import { AlpacaBroker } from './AlpacaBroker';
import type { IBroker } from './IBroker';

export const broker: IBroker = new AlpacaBroker();

export type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder } from './IBroker';
