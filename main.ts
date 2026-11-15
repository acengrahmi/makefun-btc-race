// Dip-buy mean-reversion bot for cbBTC/USDC, 1-minute bars.
// Protocol: agent-fun/bars-replay/v1, via the kit SDK shim in vendor/.
//
// Idea: the dev window is a grinding downtrend (-4% over 24h) with sharp
// intraday dips followed by bounces. Trend-following (EMA cross) whipsaws
// badly here (house ema-cross loses $135 on 63 trades). This bot instead
// stays in cash most of the time and only buys a sharp, oversold dip, then
// takes a quick profit. Long only, one position, full size, no leverage.
//
// Entry (flat only), decided on a bar's close, filled at the next open:
//   - 30-minute return <= -1.2% (a real dip, not 1-minute noise)
//   - RSI(14, Wilder) < 30 (oversold)
//   - close > previous close (first up-tick: don't catch a falling knife)
// Exit (whole position), on any of:
//   - take profit: position value >= 1.007 x cost (+0.7%)
//   - stop loss:   position value <= 0.986 x cost (-1.4%)
//   - overbought:  RSI(14) > 75
//   - time stop:   held >= 240 bars (4 hours)
// A full round trip costs ~26 bps in fees, slippage and impact, so the
// 0.7% take-profit target is ~2.7x the round-trip cost. Every exit is
// re-checked on every bar, so a refused sell is re-sent while its reason
// still holds. Deterministic: float64 arithmetic only, no clock, no
// randomness, no network, no files outside the repository.

import { runBars, type BarsState, type BuyInput, type SellInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const RSI_BARS = 14;
const RSI_ENTRY_BELOW = 30;
const RSI_EXIT_ABOVE = 75;
const DIP_BARS = 30;
const DIP_PCT = 0.012; // 30-minute return <= -1.2%
// Exits compare value against cost in integers: take profit at 1007/1000
// of cost (+0.7%), stop loss at 986/1000 (-1.4%).
const MAX_HOLD_BARS = 240;
const MAX_SLIPPAGE_BPS = 100;

// --- RSI(14), Wilder's smoothing, exactly like the kit's rsi-bollinger baseline.
let prevClose: number | null = null;
let rsiChanges: number[] = [];
let avgGain: number | null = null;
let avgLoss: number | null = null;
let rsi: number | null = null;

function pushClose(close: number): void {
  if (prevClose !== null) {
    const change = close - prevClose;
    if (avgGain === null || avgLoss === null) {
      rsiChanges.push(change);
      if (rsiChanges.length === RSI_BARS) {
        let g = 0;
        let l = 0;
        for (const ch of rsiChanges) {
          if (ch > 0) g += ch;
          else l += -ch;
        }
        avgGain = g / RSI_BARS;
        avgLoss = l / RSI_BARS;
        rsi = avgGain + avgLoss === 0 ? 50 : (100 * avgGain) / (avgGain + avgLoss);
      }
    } else {
      avgGain = (avgGain * (RSI_BARS - 1) + (change > 0 ? change : 0)) / RSI_BARS;
      avgLoss = (avgLoss * (RSI_BARS - 1) + (change < 0 ? -change : 0)) / RSI_BARS;
      rsi = avgGain + avgLoss === 0 ? 50 : (100 * avgGain) / (avgGain + avgLoss);
    }
  }
  prevClose = close;
}

// --- 30-minute dip: closes by batch seq, so the dip is always 30 bars back.
const closesBySeq: (number | null)[] = [];
let entrySeq = -1;

function dip30(seq: number, close: number): number | null {
  const then = seq >= DIP_BARS ? closesBySeq[seq - DIP_BARS] : null;
  if (then === null || then === undefined || then === 0) return null;
  return close / then - 1;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const prev = prevClose;
    pushClose(close);
    closesBySeq[state.seq] = close;
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      // Compare value against cost in integers (value*1000 vs cost*1007 etc.)
      // to keep the exit test exact and deterministic.
      const takeProfit = value * 1000n >= cost * 1007n;
      const stopLoss = value * 1000n <= cost * 986n;
      const overbought = rsi !== null && rsi > RSI_EXIT_ABOVE;
      const timedOut = entrySeq >= 0 && state.seq - entrySeq >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || overbought || timedOut) {
        orders.push({ side: "sell", symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        // entrySeq stays: the position is still held until the fill lands.
      }
      return orders;
    }
    entrySeq = -1; // flat: no open position, no entry to time out.

    // Flat: look for an oversold dip with a first up-tick.
    const dip = dip30(state.seq, close);
    const upTick = prev !== null && close > prev;
    if (dip !== null && dip <= -DIP_PCT && rsi !== null && rsi < RSI_ENTRY_BELOW && upTick) {
      const cash = state.cash;
      const room = state.weightRoom(SYMBOL);
      let size = cash < room ? cash : room;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (size >= minNotional && size > 0n) {
        orders.push({ side: "buy", symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        entrySeq = state.seq;
      }
    }
    return orders;
  },
});
