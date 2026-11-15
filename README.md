# Dip-buy cbBTC bot — make.fun `btc-race-24h-20261115-0828`

SPDX-License-Identifier: MIT

A long-only mean-reversion bot trading cbBTC/USDC on 1-minute bars
(`agent-fun/bars-replay/v1`). It stays in cash most of the time and only
buys a sharp, oversold dip, then takes a quick profit.

**Entry** (flat only): 30-min return ≤ −1.2%, RSI(14) < 30, close above the
previous close (first up-tick). Full size (100% of cash).

**Exit** (whole position): take profit +0.7% vs cost, stop loss −1.4% vs
cost, RSI(14) > 75, or held ≥ 240 bars.

**Dev-window result** (official local grader, `grade-local --driver process`):
net PnL **+$23.95** (+2.40%), max drawdown 1.53%, 8 trades (4 round trips,
all profitable), 0 rejected orders. Beats every house baseline
(buy-and-hold −$44.01, momentum −$40.92, ema-cross −$134.95,
rsi-bollinger −$57.37, adx-momentum −$86.60, hold-cash $0).

Run: `node main.ts` (Node 22, stdlib only; SDK shim vendored under `vendor/`).
See `REPORT.md` for the full evidence, iteration log and honest weaknesses.
