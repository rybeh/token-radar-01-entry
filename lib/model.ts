// The token radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every protocol that records no token and could still issue one of its own:
// the snapshot's whole watchlist, plus every pre-token protocol below the watchlist floor that
// is not a wrapped, staked or bridged product, an exchange, or a versioned pool of another
// protocol. Protocols whose token already trades are never ranked; the dashboard shows them
// apart, at the market's own values.
//
// The implied value of a launch is priced from comparable launches in the same snapshot:
//
//   ratio        = mcap_usd / tvl_usd of a token-bearing protocol, winsorized to [0.02, 5]
//   G            = the median ratio of every token-bearing protocol with a market cap and a
//                  TVL, itself rounded to 4 places before anything is priced from it
//   multiple(cat)= clamp((n * median(cat) + 10 * G) / (n + 10), 0.05, 1.50)
//   growthMult   = 1 + clamp(change_7d, -50, 100) / 100 * 0.35     (no report: 1)
//   maturityMult = 0.75 + 0.5 * min(age_days, 1460) / 1460         (age unknown: 1)
//   implied      = max(1, round(tvl_usd * multiple * growthMult * maturityMult))
//
// A category's own median speaks in proportion to how many comparable launches it has; a
// category with one or two is mostly the market's median, shrunk by the 10 in the weight.
// The winsorize and the clamp keep one distressed or euphoric token from pricing a category.
// No protocol name is ever special-cased: the same function prices every row, and running the
// program on a future snapshot reprices the whole board from that snapshot's own figures.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  winsor_low: number;
  winsor_high: number;
  shrink_weight: number;
  multiple_low: number;
  multiple_high: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_base: number;
  maturity_span: number;
  maturity_days: number;
}

export const MODEL: ModelConstants = {
  winsor_low: 0.02,
  winsor_high: 5,
  shrink_weight: 10,
  multiple_low: 0.05,
  multiple_high: 1.5,
  growth_floor: -50,
  growth_cap: 100,
  growth_weight: 0.35,
  maturity_base: 0.75,
  maturity_span: 0.5,
  maturity_days: 1460,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'comps-1';

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One comparable-launch statistic: a category's token-bearing protocols and their multiple. */
export interface CompRow {
  category: string;
  n: number;
  median: number;
  multiple: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    comp_count: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one ranked row: the board row's figures plus its farm plan. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  category_multiple: number;
  comp_count: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  counts: { protocols: number; pre_token: number; ranked: number; watchlist: number; live: number };
  comps: CompRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Categories whose product is another token in a wrapper, or an exchange: never a launch of their own. */
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped or staked product in a name, in any case. */
const WRAPPED_WORD = /\b(?:wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are that exchange's products. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * Whether a protocol may be ranked: it records no token, and it is not a wrapped, staked or
 * bridged product of one that trades, not an exchange and not a versioned pool. The same rule
 * the house's watchlist states, applied to the whole pre-token universe.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && WRAPPED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) return false;
  return !EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

/** The comparable launches: every category's winsorized median ratio and its shrunk multiple. */
export function computeComps(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; comps: CompRow[]; byCategory: Map<string, CompRow> } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const r = clamp(p.mcap_usd / p.tvl_usd, model.winsor_low, model.winsor_high);
    all.push(r);
    const key = p.category ?? '(none)';
    const list = ratios.get(key);
    if (list === undefined) ratios.set(key, [r]);
    else list.push(r);
  }
  // G is rounded before it prices anything: the figure the dashboard states as the market
  // median is the exact figure every category is shrunk toward, no hidden precision.
  const global = round4(all.length > 0 ? median(all) : 0);
  const comps: CompRow[] = [...ratios.entries()]
    .map(([category, rs]) => {
      const med = median(rs);
      const multiple = clamp((rs.length * med + model.shrink_weight * global) / (rs.length + model.shrink_weight), model.multiple_low, model.multiple_high);
      return { category, n: rs.length, median: round4(med), multiple: round4(multiple) };
    })
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  return { global, comps, byCategory: new Map(comps.map((c) => [c.category, c])) };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comps: { global: number; byCategory: Map<string, CompRow> },
  model: ModelConstants = MODEL,
): { implied: number; multiple: number; compCount: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const comp = comps.byCategory.get(protocol.category ?? '(none)');
  const multiple = comp === undefined ? comps.global : comp.multiple;
  const growthPct = protocol.change_7d === null ? 0 : clamp(protocol.change_7d, model.growth_floor, model.growth_cap);
  const growthMult = round4(1 + (growthPct / 100) * model.growth_weight);
  const maturityMult = age === null ? 1 : round4(model.maturity_base + (Math.min(age, model.maturity_days) / model.maturity_days) * model.maturity_span);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, compCount: comp === undefined ? 0 : comp.n, growthPct, growthMult, maturityMult, age };
}

// ---------------------------------------------------------------- farm plans

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** What one transaction costs on the protocol's main chain: Ethereum mainnet is the dear one. */
function gasFor(p: SnapshotProtocol): string {
  return chainOf(p) === 'Ethereum' ? 'about $6-12 of gas on Ethereum' : 'under $2 of gas';
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('risk curator') || c.includes('curator')) return `Deposit $${capital} of USDC into a ${n}-curated vault on ${chain} (its app lists the vaults) and keep the vault shares in the same wallet`;
  if (c.includes('allocator') || c.includes('collateral markets')) return `Deposit $${capital} of USDC into ${n}'s allocator vault on ${chain} and keep the shares in the same wallet`;
  if (c.includes('cdp')) return `Open a vault in ${n} on ${chain}: deposit $${capital} of ETH as collateral and mint a small amount of its stablecoin, keeping the collateral ratio above 250%`;
  if (c.includes('uncollateralized') || c.includes('lend')) return `Supply $${capital} of USDC to ${n} on ${chain} and leave it supplied; do not borrow in the first week`;
  if (c.includes('dex')) return `Provide $${capital} of liquidity to ${n}'s largest USDC pool on ${chain} and make one swap through the same pool`;
  if (c.includes('derivative') || c.includes('option') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${n} and open one small position, under 2x, sized so a 10% move cannot liquidate it`;
  if (c.includes('basis')) return `Deposit $${capital} of USDC into ${n}'s basis vault on ${chain} and keep the shares in the same wallet`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC or ETH to ${n} itself and keep it there; make your first swap inside one of the chain's own apps`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${n}, then use the bridged funds in one app on that chain instead of bridging straight back`;
  if (c.includes('restak') || c.includes('staking')) return `Stake $${capital} of ETH through ${n} on ${chain} and keep the receipt token in the same wallet`;
  if (c.includes('rwa')) return `Mint $${capital} of ${n}'s yield asset on ${chain} with USDC and hold the asset in the same wallet`;
  if (c.includes('stable') || c.includes('btc')) return `Mint or deposit $${capital} of the asset through ${n} on ${chain} and hold it in the same wallet`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} for a position you actually hold, and keep the policy until it expires`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in a liquid market on ${n}; let it settle rather than trading out early`;
  if (c.includes('index')) return `Buy $${capital} of ${n}'s index token on ${chain} and hold it in the same wallet`;
  if (c.includes('card') || c.includes('payment')) return `Load $${capital} onto ${n} and route your ordinary spending through it`;
  if (c.includes('leveraged') || c.includes('farm')) return `Open a small farm on ${n} with $${capital} of USDC on ${chain}, at the lowest leverage it offers`;
  if (c.includes('yield') || c.includes('liquidity')) return `Deposit $${capital} of USDC into ${n}'s main vault on ${chain} and keep the vault shares in the same wallet`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open`;
}

/** The weekly qualifying action, by the same category reading. */
function weeklyAction(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `top up the position by a small amount, or repay a slice of any borrow, keeping the health factor above 2`;
  if (c.includes('derivative') || c.includes('option')) return `place one small trade and close it inside the week, so the account shows steady, ordinary use`;
  if (c.includes('chain')) return `make two or three ordinary transactions: a swap, a transfer, and one contract interaction in the chain's own apps`;
  if (c.includes('dex') || c.includes('liquidity')) return `make one swap through your pool and harvest any fees back into the position`;
  if (c.includes('bridge')) return `bridge a small amount in the other direction, alternating weeks, and use it where it lands`;
  return `top up the position by a small amount, or move a slice between two of ${n}'s vaults if it offers more than one`;
}

/**
 * A protocol's farm plan: six steps, each an action with its cost and its time, derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const gas = gasFor(p);
  const hold = holdDaysFor(age);
  return [
    `Set up one fresh wallet for this farm and fund it from your main wallet; keep its seed phrase offline and never reuse the wallet for another farm. Cost: one funding transfer, ${gas}. Time: 10 minutes.`,
    `${coreAction(p, capital, chain)}. Cost: $${capital} of capital plus ${gas}. Time: 15 minutes to set up.`,
    `Once a week, ${weeklyAction(p)}. Cost: ${gas} a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days, so the activity counts in more than one weekly snapshot of the protocol. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Open ${p.name}'s own app and look for its points, rewards or season page; note what it counts, and claim only from links the protocol itself publishes. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`,
    `Write the wallet, the dates, the amounts and the transaction hashes in a farm log, and review the position monthly. Cost: nothing but the log. Time: 5 minutes.`,
  ];
}

// ---------------------------------------------------------------- the board

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = computeComps(snapshot, model);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter((p) => isRankable(p) || watch.has(p.slug))
    .map((p) => ({ p, v: impliedValue(p, snapshot.as_of, comps, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: s.v.multiple,
      comp_count: s.v.compCount,
      growth_pct: s.v.growthPct,
      growth_multiplier: s.v.growthMult,
      maturity_multiplier: s.v.maturityMult,
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** One row of board.json as the program contract states it: rank, slug, value, farm plan. */
export interface BoardFileRow {
  rank: number;
  slug: string;
  implied_value_usd: number;
  farm_steps: string[];
}

/**
 * The board as board.json carries it. The rich row (figures, model components) is the
 * dashboard's dataset in data.js; the file itself holds exactly the four stated fields.
 */
export function boardFileRows(board: BoardRow[]): BoardFileRow[] {
  return board.map((r) => ({ rank: r.rank, slug: r.slug, implied_value_usd: r.implied_value_usd, farm_steps: r.farm_steps }));
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? Math.round((p.mcap_usd / p.tvl_usd) * 1000) / 1000 : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const comps = computeComps(snapshot, model);
  const watch = new Set(snapshot.watchlist);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_multiple: comps.global,
    counts: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      ranked: board.length,
      watchlist: snapshot.watchlist.length,
      live: snapshot.protocols.filter((p) => !isPreToken(p)).length,
    },
    comps: comps.comps,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: watch.has(r.slug),
      category_multiple: r.model.category_multiple,
      comp_count: r.model.comp_count,
      growth_multiplier: r.model.growth_multiplier,
      maturity_multiplier: r.model.maturity_multiplier,
      implied_value_usd: r.implied_value_usd,
      farm_steps: r.farm_steps,
    })),
    live: liveRows(snapshot),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set<string>();
  for (const r of board) {
    if (slugs.has(r.slug)) return `slug ${r.slug} appears twice`;
    slugs.add(r.slug);
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `slug ${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value: not a ranking';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
