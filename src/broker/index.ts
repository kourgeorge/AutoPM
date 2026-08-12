import { config } from '../core/config';
import { AlpacaBroker } from './AlpacaBroker';
import { IBKRBroker } from './IBKRBroker';
import type { IBroker } from './IBroker';

export const broker: IBroker =
  config.broker === 'ibkr' ? new IBKRBroker() : new AlpacaBroker();

export type { IBroker, Position, AccountInfo, OrderRequest, OpenOrder } from './IBroker';
