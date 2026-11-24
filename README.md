# Pump.fun Paper Sprint: Any Bot Can Win

[![Make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/DizellaCapital/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/DizellaCapital/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for the make.fun bounty
`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b` — a paper-trading bot that runs on a
6-hour replay of real pump.fun chain data. Pure net PnL wins; winner takes the whole $2 pot.

## Strategy: fast-cycle equal sniper

On a 6-hour window, simple beats clever. This bot buys launches **early and often**, one equal
0.08 SOL ticket per coin, and cycles its 5 position slots fast so it trades dozens of coins in
6 hours instead of a handful:

- **Entry (age 2–6 slots after create):** at least 3 distinct non-creator buyers, at least
  0.8 SOL bought by non-creators, creator's own buy ≤ 1 SOL, creator has not sold, real SOL
  0.2–20. One buy per coin, never an add.
- **Exit (sell all):** +18% take-profit, −9% stop-loss, max hold 18 slots, or immediately when
  the creator sells. No runner, no partial take-profit, no trailing stop.
- **Guardrail pacing:** the bot tracks its own pace against a 30-coin / 6-hour target; when it
  lags, it opens tiny 0.01 SOL probe round trips so the 20-coin minimum bar is met even on a
  quiet stretch.

Fully deterministic: every decision is a pure function of the batch stream (no clock, no
environment, no randomness), so the two grading runs produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts` (Node 22, type-stripping).
- `strategy.ts` — the trading logic.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim (byte-identical copy of the
  kit's `sdk/ts/makefun-bot.ts`), zero dependencies.

## Local grading

From the bounty kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Bounty

- Slug: `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`
- Pot: $2, winner-takes-all (#1). Deadline: 2026-11-26T05:40:00Z.
- Scoring: net PnL on 6 hours of pump.fun chain data collected after entries close; a prize
  needs net PnL above holding cash (above 0 SOL after every fee).

## License

MIT — see `LICENSE`.
