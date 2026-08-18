/**
 * One-shot script: connect to IBKR, print live positions + account info, then exit.
 * Usage:  BROKER=ibkr ts-node src/scripts/ibkrPositions.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

// Override the per-request timeout to 30 s for this script so a slow
// Gateway handshake does not abort the query prematurely.
process.env.IBKR_API_TIMEOUT_MS = '30000';

import { IBKRBroker } from '../broker/IBKRBroker';

async function main() {
  const broker = new IBKRBroker();

  // IB Gateway needs up to 5 s to complete the TWS handshake on a live account.
  await new Promise(r => setTimeout(r, 5000));

  try {
    const [account, positions] = await Promise.all([
      broker.getAccountInfo(),
      broker.getPositions(),
    ]);

    console.log('\n=== IBKR ACCOUNT ===');
    console.log(`  Net Liquidation : $${account.equity.toFixed(2)}`);
    console.log(`  Cash            : $${account.cash.toFixed(2)}`);
    console.log(`  Buying Power    : $${account.buyingPower.toFixed(2)}`);

    console.log('\n=== OPEN POSITIONS ===');
    if (positions.length === 0) {
      console.log('  (none)');
    } else {
      const rows = positions.map(p => ({
        symbol:    p.symbol.padEnd(8),
        qty:       String(p.qty).padStart(8),
        avgCost:   `$${p.avgCost.toFixed(4)}`.padStart(12),
        mktValue:  p.marketValue != null ? `$${p.marketValue.toFixed(2)}`.padStart(12) : '        n/a'.padStart(12),
        unrealPnL: p.unrealizedPnL != null ? `$${p.unrealizedPnL.toFixed(2)}`.padStart(12) : '        n/a'.padStart(12),
      }));

      console.log('  Symbol     Qty      AvgCost    MktValue   UnrealPnL');
      console.log('  ' + '-'.repeat(60));
      for (const r of rows) {
        console.log(`  ${r.symbol} ${r.qty} ${r.avgCost} ${r.mktValue} ${r.unrealPnL}`);
      }
    }

    console.log('');
  } finally {
    broker.disconnect();
  }
}

main().catch(err => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
