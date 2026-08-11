export interface Position {
  symbol: string;
  qty: number;
  avgCost: number;
  marketValue?: number;
  unrealizedPnL?: number;
}

export interface AccountInfo {
  equity: number;
  cash: number;
  buyingPower: number;
}

export interface OrderRequest {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type: 'market' | 'limit';
  limitPrice?: number;
}

export interface OpenOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  filled: number;
  type: 'market' | 'limit';
  limitPrice?: number;
  status: string;
}

export interface IBroker {
  getPositions(): Promise<Position[]>;
  getAccountInfo(): Promise<AccountInfo>;
  getOpenOrders(): Promise<OpenOrder[]>;
  placeOrder(order: OrderRequest): Promise<{ id: string }>;
  cancelOrder(id: string): Promise<void>;
  isMarketOpen(): Promise<boolean>;
}
