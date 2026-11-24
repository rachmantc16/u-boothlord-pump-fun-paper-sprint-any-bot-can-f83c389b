// Pump.fun Paper Sprint — patient momentum bot for agent-fun/replay/v2.
//
// Strategy in one paragraph: most pump.fun coins go to zero, so this bot
// mostly holds cash. It buys only coins that are already moving — price up
// strongly over two lookback windows, real buy flow dominating sell flow,
// enough trades and enough real SOL in the curve to exit — and it keeps
// every position small (a fixed slice of cash, never above the harness's
// per-coin size cap). It sells on a hard stop, a trailing stop once a coin
// has run, a take-profit, or a time stop, because on a bonding curve the
// exit is where the money is made or lost. Fees are ~1.25% per side plus a
// fixed tx fee, so the bot trades rarely and never churns.
//
// The bot speaks newline-delimited JSON on stdin/stdout by itself (hello,
// batch, done in; one reply per batch out). It is deterministic: no clock,
// no environment, no randomness.

// ------------------------------------------------------------------ types

interface HelloMsg {
  type: 'hello';
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
  fees: { base_fee_lamports: string; priority_fee_lamports: string };
}

interface TradeEv {
  event: 'TradeEvent';
  mint: string;
  is_buy: boolean;
  sol_amount: string;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_quote_reserves: string;
}

interface CreateEv {
  event: 'CreateEvent';
  mint: string;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
}

interface CompleteEv {
  event: 'CompleteEvent';
  mint: string;
}

type ChainEv = TradeEv | CreateEv | CompleteEv | { event: string; mint: string };

interface BatchMsg {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEv[];
  marks: Array<{
    mint: string;
    slot: number;
    virtual_token_reserves: string;
    virtual_quote_reserves: string;
    real_quote_reserves: string;
  }>;
  fills: Array<{ client_id: string; mint: string; side: string; status: string }>;
  account: {
    cash_lamports: string;
    positions: Array<{ mint: string; token_amount: string; cost_lamports: string }>;
  };
}

interface OrderOut {
  side: 'buy' | 'sell';
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

// ------------------------------------------------------------------ state

interface Sample {
  slot: number;
  price: number; // lamports per token base unit (virtual_quote / virtual_token)
}

interface CurveTrack {
  mint: string;
  createdSlot: number;
  complete: boolean;
  price: number;
  realQuote: bigint;
  samples: Sample[]; // ascending by slot, capped
  flowLog: Array<{ slot: number; buy: boolean; sol: number }>; // rolling flow window
  lastTradeSlot: number;
}

interface PosTrack {
  mint: string;
  entrySlot: number;
  peakRatio: number; // peak of (current value / cost)
  sold: boolean; // a full-exit sell order is already in flight
  tookProfit: boolean; // the partial take-profit already fired
}

const curves = new Map<string, CurveTrack>();
const positions = new Map<string, PosTrack>();
const pendingBuys = new Set<string>();
const cooldownUntil = new Map<string, number>();
let hello: HelloMsg | null = null;
let cash = 0n;
let heldNow = new Map<string, { tokens: bigint; cost: bigint }>();
let orderCounter = 0;

// ------------------------------------------------------------- parameters

const MIN_AGE_SLOTS = 60; // let a coin prove it is not a one-slot wonder
const MIN_REAL_QUOTE_SOL = 8; // deep curve only: real exit + bigger size cap
const MIN_WIN_TRADES = 15; // trades inside the flow window
const FLOW_WINDOW_SLOTS = 150; // ~1 minute of slots
const MIN_BUY_SHARE = 0.68; // buy SOL share of flow inside the window
const MOM_FAST_SLOTS = 30;
const MOM_FAST_MIN = 0.08; // +8% over the fast window
const MOM_SLOW_SLOTS = 120;
const MOM_SLOW_MIN = 0.25; // +25% over the slow window
const MOM_FAST_MAX = 0.5; // but not +50%: that top is someone else's exit
const MOM_SLOW_MAX = 1.0; // and not already doubled on the slow window
const SIZE_FRACTION = 0.1; // of free cash per entry
const SIZE_CAP_SOL = 0.5;
const SIZE_MIN_SOL = 0.05;
const MAX_POSITIONS = 3;
const MAX_BUYS_PER_BATCH = 1;
const HARD_STOP = 0.88; // sell everything at -12% of cost
const TRAIL_ARM = 1.15; // trailing stop arms at +15%
const TRAIL_DROP = 0.9; // and fires 10% below the peak ratio
const TAKE_PROFIT = 1.8; // sell everything at +80%
const PARTIAL_TP = 1.35; // sell half at +35%, let the rest ride the trail
const TIME_STOP_SLOTS = 900; // ~6 minutes
const TIME_STOP_MAX_RATIO = 1.05; // still flat after that long: leave
const COOLDOWN_SLOTS = 1200;
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 1500;
const LAMPORTS = 1_000_000_000;

// ---------------------------------------------------------------- helpers

function priceOf(vQuote: string, vToken: string): number {
  const t = Number(vToken);
  if (t <= 0) return 0;
  return Number(vQuote) / t;
}

function track(mint: string, slot: number): CurveTrack {
  let c = curves.get(mint);
  if (c === undefined) {
    c = {
      mint,
      createdSlot: slot,
      complete: false,
      price: 0,
      realQuote: 0n,
      samples: [],
      flowLog: [],
      lastTradeSlot: -1,
    };
    curves.set(mint, c);
  }
  return c;
}

function pushSample(c: CurveTrack, slot: number, price: number): void {
  const last = c.samples[c.samples.length - 1];
  if (last !== undefined && last.slot === slot) {
    last.price = price;
    return;
  }
  c.samples.push({ slot, price });
  // Keep roughly the last 400 slots of samples; older ones cannot be a
  // lookback reference any more.
  while (c.samples.length > 2 && slot - c.samples[0].slot > 400) c.samples.shift();
}

/** Price at or before (slot - back), or the oldest sample if none qualifies. */
function priceBack(c: CurveTrack, slot: number, back: number): number | null {
  const target = slot - back;
  let best: Sample | null = null;
  for (const s of c.samples) {
    if (s.slot <= target) best = s;
    else break;
  }
  if (best !== null) return best.price;
  return c.samples.length > 0 ? c.samples[0].price : null;
}

function nextId(): string {
  orderCounter += 1;
  return `o${orderCounter}`;
}

// -------------------------------------------------------------- main loop

function applyBatch(batch: BatchMsg): void {
  cash = BigInt(batch.account.cash_lamports);
  heldNow = new Map();
  for (const p of batch.account.positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens > 0n) heldNow.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
  }
  // Fills clear pending buys (filled, rejected or failed alike), and a
  // resolved sell re-arms the exit logic if the position is still held.
  for (const f of batch.fills) {
    if (f.side === 'buy') pendingBuys.delete(f.mint);
    if (f.side === 'sell') {
      const pt = positions.get(f.mint);
      if (pt !== undefined) pt.sold = false;
    }
  }
  // Marks refresh held / watched curves even in slots with no trades.
  for (const m of batch.marks) {
    const c = track(m.mint, m.slot);
    const px = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
    if (px > 0) {
      c.price = px;
      pushSample(c, m.slot, px);
    }
    c.realQuote = BigInt(m.real_quote_reserves);
  }
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const ce = e as CreateEv;
      const c = track(ce.mint, batch.slot);
      c.createdSlot = batch.slot;
      const px = priceOf(ce.virtual_quote_reserves, ce.virtual_token_reserves);
      if (px > 0) {
        c.price = px;
        pushSample(c, batch.slot, px);
      }
    } else if (e.event === 'TradeEvent') {
      const te = e as TradeEv;
      const c = track(te.mint, batch.slot);
      const px = priceOf(te.virtual_quote_reserves, te.virtual_token_reserves);
      if (px > 0) {
        c.price = px;
        pushSample(c, batch.slot, px);
      }
      c.realQuote = BigInt(te.real_quote_reserves);
      // Rolling flow window: log every trade, prune what aged out. (v1
      // restarted the window wholesale, which let a burst of old buys pass
      // the flow test long after the flow had actually turned.)
      c.flowLog.push({ slot: batch.slot, buy: te.is_buy, sol: Number(te.sol_amount) / LAMPORTS });
      while (c.flowLog.length > 0 && batch.slot - c.flowLog[0].slot > FLOW_WINDOW_SLOTS) c.flowLog.shift();
      c.lastTradeSlot = batch.slot;
    } else if (e.event === 'CompleteEvent') {
      const c = track(e.mint, batch.slot);
      c.complete = true;
    }
  }
  // Position bookkeeping: new holdings get a tracker, closed ones retire.
  for (const mint of heldNow.keys()) {
    if (!positions.has(mint)) {
      positions.set(mint, { mint, entrySlot: batch.slot, peakRatio: 1, sold: false, tookProfit: false });
      pendingBuys.delete(mint);
    }
  }
  for (const mint of [...positions.keys()]) {
    if (!heldNow.has(mint)) {
      positions.delete(mint);
      cooldownUntil.set(mint, batch.slot + COOLDOWN_SLOTS);
    }
  }
}

function decide(batch: BatchMsg): OrderOut[] {
  const orders: OrderOut[] = [];
  if (hello === null) return orders;
  const slot = batch.slot;
  const maxOrders = hello.caps.max_orders_per_batch;

  // ---- exits first: protecting capital outranks every new entry.
  for (const [mint, pos] of positions) {
    const held = heldNow.get(mint);
    if (held === undefined || pos.sold) continue;
    const c = curves.get(mint);
    if (c === undefined || c.complete || c.price <= 0) continue;
    const value = c.price * Number(held.tokens);
    const ratio = value / Number(held.cost);
    if (ratio > pos.peakRatio) pos.peakRatio = ratio;
    let sell = false;
    if (ratio <= HARD_STOP) sell = true;
    else if (ratio >= TAKE_PROFIT) sell = true;
    else if (pos.peakRatio >= TRAIL_ARM && ratio <= pos.peakRatio * TRAIL_DROP) sell = true;
    else if (slot - pos.entrySlot >= TIME_STOP_SLOTS && ratio < TIME_STOP_MAX_RATIO) sell = true;
    // Partial take-profit: bank half at +60% so a round trip that later
    // fades still paid its fees, and let the other half ride the trail.
    if (!sell && !pos.tookProfit && ratio >= PARTIAL_TP && orders.length < maxOrders) {
      const half = held.tokens / 2n;
      if (half > 0n) {
        orders.push({
          side: 'sell',
          client_id: nextId(),
          mint,
          token_amount: half.toString(),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        pos.tookProfit = true;
      }
    }
    if (sell && orders.length < maxOrders) {
      orders.push({
        side: 'sell',
        client_id: nextId(),
        mint,
        token_amount: held.tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      pos.sold = true;
    }
  }

  // ---- entries: only with spare position slots and spare orders.
  const openCount = positions.size + pendingBuys.size;
  if (openCount < Math.min(MAX_POSITIONS, hello.caps.max_open_positions)) {
    let buys = 0;
    let budget = cash;
    // Best momentum first, so a crowded batch funds the strongest coins.
    const candidates: Array<{ c: CurveTrack; score: number }> = [];
    for (const c of curves.values()) {
      if (c.complete || c.price <= 0) continue;
      if (heldNow.has(c.mint) || pendingBuys.has(c.mint)) continue;
      if (slot - c.createdSlot < MIN_AGE_SLOTS) continue;
      if ((cooldownUntil.get(c.mint) ?? -1) > slot) continue;
      if (Number(c.realQuote) / LAMPORTS < MIN_REAL_QUOTE_SOL) continue;
      while (c.flowLog.length > 0 && slot - c.flowLog[0].slot > FLOW_WINDOW_SLOTS) c.flowLog.shift();
      if (c.flowLog.length < MIN_WIN_TRADES) continue;
      let buySol = 0;
      let flow = 0;
      for (const t of c.flowLog) {
        flow += t.sol;
        if (t.buy) buySol += t.sol;
      }
      if (flow <= 0 || buySol / flow < MIN_BUY_SHARE) continue;
      const fast = priceBack(c, slot, MOM_FAST_SLOTS);
      const slow = priceBack(c, slot, MOM_SLOW_SLOTS);
      if (fast === null || slow === null || fast <= 0 || slow <= 0) continue;
      const fastRet = c.price / fast - 1;
      const slowRet = c.price / slow - 1;
      if (fastRet < MOM_FAST_MIN || fastRet > MOM_FAST_MAX) continue;
      if (slowRet < MOM_SLOW_MIN || slowRet > MOM_SLOW_MAX) continue;
      candidates.push({ c, score: fastRet + slowRet });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const { c } of candidates) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (orders.length >= maxOrders) break;
      if (positions.size + pendingBuys.size >= Math.min(MAX_POSITIONS, hello.caps.max_open_positions)) break;
      const capByReserve =
        (c.realQuote * BigInt(hello.caps.max_order_bps_of_real_reserve)) / 10000n;
      let size = BigInt(Math.floor(Number(budget) * SIZE_FRACTION));
      const capSol = BigInt(Math.floor(SIZE_CAP_SOL * LAMPORTS));
      if (size > capSol) size = capSol;
      if (size > capByReserve) size = capByReserve;
      if (size < BigInt(Math.floor(SIZE_MIN_SOL * LAMPORTS))) continue;
      if (size > budget) continue;
      orders.push({
        side: 'buy',
        client_id: nextId(),
        mint: c.mint,
        quote_lamports: size.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      pendingBuys.add(c.mint);
      budget -= size;
      buys += 1;
    }
  }
  return orders;
}

async function main(): Promise<void> {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of process.stdin) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === '') continue;
      const msg = JSON.parse(line) as { type: string };
      if (msg.type === 'hello') {
        hello = msg as unknown as HelloMsg;
        cash = BigInt(hello.capital.lamports);
      } else if (msg.type === 'batch') {
        const batch = msg as unknown as BatchMsg;
        applyBatch(batch);
        const orders = decide(batch);
        process.stdout.write(JSON.stringify({ type: 'reply', seq: batch.seq, orders }) + '\n');
      } else if (msg.type === 'done') {
        return;
      }
    }
  }
}

await main();
