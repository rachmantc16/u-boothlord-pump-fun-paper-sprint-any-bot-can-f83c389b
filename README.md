# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rachmantc16/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rachmantc16/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A patient momentum paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2). Most pump.fun coins go to zero, so the bot mostly holds cash: it buys only coins already moving up over two lookback windows with buy flow dominating sell flow, enough trades and enough real SOL in the curve to exit, sized as a small slice of cash under the harness's per-coin cap. It exits on a hard stop, a trailing stop, a partial then full take-profit, or a time stop — trading rarely, because ~1.25% per side in curve fees plus a fixed tx fee punishes churn.

## Strategy rules

- **Entry:** coin at least ~20 slots old, ≥3 SOL of real reserves, ≥8 trades in the rolling ~150-slot flow window with buys ≥58% of flowed SOL, price up ≥12% over ~30 slots and ≥20% over ~120 slots, but not up more than +120% on the fast window (that top is someone else's exit liquidity).
- **Sizing:** 6% of free cash per entry, capped at 0.35 SOL and at the harness's per-coin reserve cap; at most 8 open positions and 3 new buys per batch; a 600-slot cooldown before re-entering a coin that was exited.
- **Exits:** hard stop at −22% of cost; sell half at +60%; sell everything at +110%; trailing stop 18% below the peak once a position has run +25%; time stop after ~1800 slots if still below +10%.

## Run it

```sh
node main.ts
```

The bot is a single self-contained `main.ts` (Node 22, no dependencies): it reads newline-delimited JSON (hello, batch, done) on stdin and writes exactly one reply per batch on stdout. It is deterministic — no clock, no environment, no randomness.

---

<sub>Entered on [make.fun](https://make.fun/?ref=pas2z9sw&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
