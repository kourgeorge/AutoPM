import { AccountInfo, Position } from '../broker/IBroker';
import { getPolicy } from '../policy/load';
import { SignalResult } from '../core/types';

export function isAtMaxPositions(positions: Position[]): boolean {
  return positions.length >= getPolicy().risk.maxPositions;
}

export function hasEnoughBuyingPower(account: AccountInfo, signal: SignalResult, qty: number): boolean {
  return account.buyingPower >= qty * signal.price;
}

export function isDailyLossBreached(account: AccountInfo, startOfDayEquity: number): boolean {
  const pctChange = (account.equity - startOfDayEquity) / startOfDayEquity;
  return pctChange < -getPolicy().risk.maxDailyLossPct;
}
