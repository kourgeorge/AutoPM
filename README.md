# AutoTrade

An autonomous momentum trading agent powered by Claude AI. Connects to Interactive Brokers (live) or Alpaca (paper) through a unified broker abstraction, uses Yahoo Finance for market data, and executes EMA/RSI/ATR-based signals with built-in risk management.

---

## Architecture

```
src/
├── broker/
│   ├── IBroker.ts        # Broker interface (agent talks to this only)
│   ├── IBKRBroker.ts     # IBKR implementation via TWS socket API
│   ├── AlpacaBroker.ts   # Alpaca implementation via REST API
│   └── index.ts          # Active broker (swap here to change broker)
├── prices/
│   └── yahoo.ts          # getPrice / getPrices via Yahoo Finance
├── IBKR/
│   └── ibkrClient.ts     # Low-level IBKR position reader
├── agent.ts              # Main trading loop (entry/exit/full)
├── deepAgent.ts          # Claude AI signal analysis
├── signals.ts            # EMA crossover + RSI + ATR signal generation
├── indicators.ts         # EMA, RSI, ATR calculations
├── riskManager.ts        # Position sizing, loss limits, buying power checks
├── orderManager.ts       # Order execution helpers
├── alpacaClient.ts       # Alpaca REST client
├── modelProvider.ts      # Claude API client
├── config.ts             # Strategy, risk, and API configuration
├── types.ts              # Shared types
└── index.ts              # Entry point + cron scheduler
```

### Broker abstraction

The agent only depends on `IBroker` — it never imports broker-specific code directly:

```typescript
import { broker } from './broker';

const positions = await broker.getPositions();
const orders    = await broker.getOpenOrders();
await broker.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 10, type: 'market' });
await broker.cancelOrder(id);
```

To switch brokers, change one line in `src/broker/index.ts`:

```typescript
export const broker: IBroker = new IBKRBroker();   // live
// export const broker: IBroker = new AlpacaBroker(); // paper
```

### Price data

Prices come from Yahoo Finance (free, no subscription required):

```typescript
import { getPrice, getPrices } from './prices/yahoo';

const price  = await getPrice('AAPL');
const prices = await getPrices(['AAPL', 'NVDA', 'QQQ']);
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your keys:

```env
# Broker — IBKR (live)
IBKR_HOST=127.0.0.1
IBKR_PORT=4001          # 4001 = IB Gateway live | 4002 = paper | 7496 = TWS live | 7497 = TWS paper
IBKR_CLIENT_ID=1

# Broker — Alpaca (paper)
ALPACA_KEY_ID=your_key
ALPACA_SECRET_KEY=your_secret
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# AI
AI_API_KEY=your_anthropic_key
AI_MODEL=claude-sonnet-4-6       # optional override
AI_MAX_TOKENS=4096               # optional override
```

### 3. Start IB Gateway (for IBKR)

1. Launch **IB Gateway 10.x** and log in
2. Go to **Configure → Settings → API → Settings**
3. Enable **"Enable ActiveX and Socket Clients"**
4. Confirm port matches `IBKR_PORT` (default `4001`)
5. Ensure `127.0.0.1` is in the trusted IPs list

---

## Usage

### Run the trading agent

```bash
# Full run (entry + exit checks) — respects market hours
npm run dev

# Scheduled runs (9:45 AM + 3:30 PM ET, weekdays)
npm start

# Force a single run regardless of market hours
npm run run-once-force
```

### Check IBKR positions

```bash
npm run ibkr:positions
```

---

## Strategy

**Signal generation** (`signals.ts`):
- **Entry**: EMA(9) crosses above EMA(21) **and** RSI(14) > 50
- **Exit**: EMA(9) crosses below EMA(21) **or** RSI(14) < 40
- Stop loss: entry − 2 × ATR(14)
- Take profit: entry + 6 × ATR(14) — 3:1 R/R

**Risk management** (`riskManager.ts`):
- Max open positions: 5 (configurable)
- Position size: 5% of equity per trade (configurable)
- Daily loss limit: 3% of equity — halts trading for the day

**Watchlist** (configurable in `config.ts`):
AAPL, MSFT, NVDA, META, GOOGL, AMZN, TSLA, AMD, CRM, ADBE, NFLX, UBER, SHOP, SQ, COIN

---

## Configuration

All strategy and risk parameters are in `src/config.ts`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `emaFast` | 9 | Fast EMA period |
| `emaSlow` | 21 | Slow EMA period |
| `rsiPeriod` | 14 | RSI period |
| `rsiEntryMin` | 50 | Min RSI to enter long |
| `rsiExitMax` | 40 | RSI below which to exit |
| `atrPeriod` | 14 | ATR period |
| `maxPositions` | 5 | Max simultaneous positions |
| `positionSizePct` | 0.05 | Fraction of equity per trade |
| `stopLossAtrMult` | 2.0 | Stop = entry − N × ATR |
| `takeProfitAtrMult` | 6.0 | Target = entry + N × ATR |
| `maxDailyLossPct` | 0.03 | Daily loss halt threshold |
