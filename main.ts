// Pump.fun Paper Sprint: Any Bot Can Win — entrypoint (v2: patient selective sniper).
//
// The grader runs this file as `node /bot/main.ts` (Node strips the types; no build,
// no install). It speaks the agent-fun/replay/v2 protocol over stdin/stdout through the
// vendored shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts/makefun-bot.ts): the harness sends a hello, then one batch per slot, then done.
// Each batch carries that slot's events, the latest marks, the fills that resolved, and
// the account; this bot answers with the orders for that slot. See strategy.ts for the
// trading logic (v2: narrow 2-3 slot entry window, >= 2 SOL of real buying, 0.04 SOL
// tickets, +18% take-profit, -20% stop, 36-slot max hold).
//
// Determinism: the strategy reads nothing but the batch stream — no clock, no
// environment, no Math.random — so the two grading runs produce byte-identical logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
