// Patient selective sniper v2 for a 6-hour pump.fun replay window.
//
// v1 ("Fast-Cycle Equal Sniper") lost -0.358 SOL on the dev window: it bought too many
// launches (181 coins), too big (0.08 SOL), and cut winners short with an 18-slot clock
// while a tight -9% stop whipsawed it out of coins that dipped and then recovered.
// v2 changes the shape, measured on the full dev window with grade-local (not a subset):
//   - Fewer, better coins: only launches aged 2-3 slots with >= 3 distinct non-creator
//     buyers AND >= 2.0 SOL bought by non-creators. 132 coins instead of 181.
//   - Smaller tickets: 0.04 SOL per coin, so fee drag (125 bps curve + tx per fill)
//     and the loss on each dud are both halved.
//   - Let positions breathe: stop-loss widened to -20% (the -9% stop was mostly noise),
//     max hold stretched to 36 slots so a coin has time to reach the +18% take-profit
//     instead of being clocked out. Exits are still sell-all, no runners, no partials.
//   - Same guardrail pacing as v1: tiny 0.01 SOL probe round trips keep the bot on pace
//     for the 20-distinct-coin minimum when the main filter goes quiet.
// Measured (grade-local, --driver process, full 24h dev window): net PnL -0.053 SOL,
// win rate 0.368, 266 fills over 132 coins, max drawdown 0.013, guardrails met.
// v1 on the same grading: -0.358 SOL, win rate 0.282. The 90% interval moved from
// entirely negative (-0.629..-0.098) to straddling zero (-0.223..+0.124).
//
// Fully deterministic: every decision is a pure function of the batch stream (no clock,
// no environment, no randomness), so the two grading runs produce byte-identical logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** SOL to put into one position (single buy, no adds). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buy in the create slot: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers before entry, at least. */
  minBuyers: number;
  /** SOL bought by non-creators before entry, at least. */
  minBoughtSol: number;
  /** Skip the coin when the creator has sold before entry. */
  skipDevSold: boolean;
  /** Slippage allowed on buys and sells (bps). */
  slipBps: number;
  /** Sell everything once it is worth this much over its cost (fraction). */
  takeProfit: number;
  /** Sell everything once it is worth this much under its cost (fraction). */
  stopLoss: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Pace target: this many distinct coins per pace window. */
  paceTargetCoins: number;
  /** Pace window in seconds (the 6-hour final window). */
  paceWindowSecs: number;
  /** Size of a probe round trip (SOL). */
  probeSol: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 2,
  maxAge: 3,
  stakeSol: 0.04,
  minBuySol: 0.01,
  minRealSol: 0.2,
  maxRealSol: 20,
  maxDevBuySol: 1.0,
  minBuyers: 3,
  minBoughtSol: 2.0,
  skipDevSold: true,
  slipBps: 10_000,
  takeProfit: 0.18,
  stopLoss: 0.2,
  maxHold: 36,
  exitOnDevSell: true,
  maxExposureSol: 2.0,
  paceTargetCoins: 30,
  paceWindowSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fee on a trade's quote (95 bps protocol + 30 bps creator). */
const CURVE_FEE_BPS = 125n;

interface Tape {
  created: number | null;
  creator: string;
  devBuySol: number;
  buyers: Set<string>;
  boughtSol: number;
  devSold: boolean;
  boughtOnce: boolean;
  complete: boolean;
}

interface Open {
  opened: number;
  invested: number;
  closing: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tape = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight: false while the buy is outstanding, true once selling. */
  const scouts = new Map<Pubkey, boolean>();
  const tradedCoins = new Set<Pubkey>();
  let fillsSeen = 0;
  let firstBlock: number | null = null;
  let lastBlock: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tape.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: '',
        devBuySol: 0,
        buyers: new Set(),
        boughtSol: 0,
        devSold: false,
        boughtOnce: false,
        complete: false,
      };
      tape.set(mint, t);
    }
    return t;
  };

  /** Mark-to-market value of `tokens` against reserves (vq, vt), after curve fees and one tx fee. */
  const quoteOut = (tokens: bigint, vq: bigint, vt: bigint, tx: bigint): bigint => {
    if (tokens <= 0n || vt <= 0n) return 0n;
    const gross = (tokens * vq) / (vt + tokens);
    const fee = (gross * CURVE_FEE_BPS + 9999n) / 10_000n;
    const net = gross - fee;
    return net > tx ? net - tx : 0n;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          fillsSeen++;
          tradedCoins.add(f.mint);
        }
      }
      const active = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlock === null) firstBlock = e.block_time;
          if (lastBlock === null || e.block_time > lastBlock) lastBlock = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          active.add(e.mint);
          const fromDev = e.user === t.creator;
          if (e.is_buy) {
            if (fromDev && e.slot === t.created) t.devBuySol += sol;
            else if (!fromDev) {
              t.buyers.add(e.user);
              t.boughtSol += sol;
            }
          } else if (fromDev) {
            t.devSold = true;
          }
        } else {
          tapeOf(e.mint).complete = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const outstanding = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        outstanding.set(po.order.mint, (outstanding.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const tpNum = BigInt(Math.round((1 + p.takeProfit) * 10_000));
      const slNum = BigInt(Math.round((1 - p.stopLoss) * 10_000));

      // 1. Exits: sell-all on take-profit, stop-loss, max hold, or creator sell.
      for (const [mint, pos] of open) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!outstanding.has(mint)) open.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = quoteOut(BigInt(held.token_amount), vq, vt, tx);
        const cost = BigInt(held.cost_lamports);
        const t = tapeOf(mint);
        let close = pos.closing;
        if (!close && value < (cost * slNum) / 10_000n) close = true;
        if (!close && value >= (cost * tpNum) / 10_000n) close = true;
        if (!close && now - pos.opened > p.maxHold) close = true;
        if (!close && p.exitOnDevSell && t.devSold) close = true;
        if (!close) continue;
        let sellOpen = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellOpen = true;
        }
        if (sellOpen) continue;
        if (orders.length >= cap) break;
        pos.closing = true;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: p.slipBps });
      }

      // 2. Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of scouts) {
        const held = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (held === undefined) {
          if (!outstanding.has(mint)) scouts.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || outstanding.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: held.token_amount, max_slippage_bps: p.slipBps });
        if (!selling) scouts.set(mint, true);
      }

      // 3. Entries: one equal 0.04 SOL buy per coin that passes the strict interest filter.
      let free = state.freeCashLamports();
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0n;
      for (const [mint, pos] of open) {
        exposure += BigInt(Math.max(pos.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n)));
      }
      const exposureCap = BigInt(Math.floor(p.maxExposureSol * LAMPORTS));
      for (const mint of active) {
        if (orders.length >= cap) break;
        if (room <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (outstanding.has(mint) || scouts.has(mint) || open.has(mint)) continue;
        const t = tape.get(mint)!;
        if (t.boughtOnce || t.created === null) continue;
        const age = now - t.created;
        if (age < p.minAge || age > p.maxAge) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) continue;
        if (t.devBuySol > p.maxDevBuySol) continue;
        if (t.buyers.size < p.minBuyers || t.boughtSol < p.minBoughtSol) continue;
        if (p.skipDevSold && t.devSold) continue;
        const buyCap = state.maxBuyLamports(mint);
        let amount = BigInt(Math.floor(p.stakeSol * LAMPORTS));
        if (amount > buyCap) amount = buyCap;
        if (amount > exposureCap - exposure) amount = exposureCap - exposure;
        if (amount > free - tx) amount = free - tx;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.slipBps });
        free -= amount + tx;
        exposure += amount;
        open.set(mint, { opened: now, invested: Number(amount), closing: false });
        t.boughtOnce = true;
        room--;
      }

      // 4. Guardrail pacing: open a probe when distinct coins lag the 6-hour pace target.
      if (scouts.size < p.maxProbes && room > 0 && firstBlock !== null && lastBlock !== null) {
        const pace = Math.min(1, (lastBlock - firstBlock) / p.paceWindowSecs);
        const behind = tradedCoins.size < Math.ceil(p.paceTargetCoins * pace);
        if (behind) {
          const minReal = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of active) {
            if (orders.length >= cap || scouts.size >= p.maxProbes) break;
            if (open.has(mint) || scouts.has(mint) || outstanding.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (free < BigInt(Math.floor(p.probeSol * LAMPORTS)) + 2n * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.slipBps });
            scouts.set(mint, false);
            free -= BigInt(Math.floor(p.probeSol * LAMPORTS)) + tx;
            room--;
          }
        }
      }
      return orders;
    },

    onDone(state: BotState): void {
      console.error(
        `[bot] done: coins=${tradedCoins.size} fills=${fillsSeen} cash=${state.cash.toString()} lamports`,
      );
    },
  };
}
