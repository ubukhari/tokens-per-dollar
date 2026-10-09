/**
 * `tokens-per-dollar forecast`: when your own pace reaches each limit, and what that pace costs on
 * every plan. Local; no request.
 *
 * **Codex** writes the account's own limit readings to disk with every response: the plan, and the
 * percentage used of the 5-hour window (Plus) and the weekly window, with their reset times
 * (seatledger's Codex reader keeps them as quota samples). Two things follow from them:
 *
 * 1. **The size of a window, in credits** (an estimate). While this machine works, the readings
 *    rise; the points they rose, against the Codex credits this machine's requests came to over
 *    the same intervals (OpenAI's rate card, which is token-based), give points per credit. Only
 *    intervals that start below 100% count, and only readings for the plan Codex reports now. The
 *    readings are account-wide, so use on other machines and in the cloud makes a window look
 *    smaller than it is.
 * 2. **When your pace reaches it** (an estimate). Your pace is your own last 14 days, as an average
 *    week, hour by hour (so a Monday-heavy week projects Monday-heavy). The window open now is
 *    projected from its latest reading to its reset; with none open, a fresh one from now.
 *
 * Then the price of the same pace on each Codex plan: the plan Codex reports is measured (how much
 * of your week its weekly limit holds, and the rest at the credit rate card); a plan you are not on
 * gets its fee and the multiple of your plan's limit it would need, because OpenAI publishes
 * neither limit as a number; Codex credits and the OpenAI API are priced from seatledger's
 * comparison, so the figures match `tokens-per-dollar` with no command.
 *
 * **Claude Code** writes no percentage, only the moment a limit stopped you (`claude-limits.ts`).
 * So its section says what the transcripts show: each hit, what this machine had spent in that
 * window at API list prices, and how your current pace compares with the least that has been
 * stopped. All of it labelled as what the transcript shows.
 */
import {
  apiEquivalentUsd,
  CODEX_CREDIT,
  codexCredits,
  planById,
  planCompare,
  PLANS,
  priceKey,
  type Loaded,
  type PlanCompareView,
  type PlanId,
  type PlanQuote,
  type QuotaSample,
  type UsageRecord,
} from "seatledger";
import type { LimitHit, LimitKind } from "./claude-limits.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FIVE_HOURS = 5 * HOUR;
const HOURS_PER_WEEK = 168;

/** The pace: your own last 14 days, unless --since says otherwise. */
export const PACE_DAYS = 14;
/** How far back Claude Code's limit hits are listed and sized. */
export const HIT_LOOKBACK_DAYS = 30;
/** Readings must rise this many points while this machine works before they size a window. */
export const MIN_CALIBRATION_POINTS = 3;
/** The limit Codex names `codex`: the one its plans' usage counts against. */
export const CODEX_LIMIT_ID = "codex";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/** Points of a window per Codex credit, from the readings and this machine's own requests. */
export interface Calibration {
  pointsPerCredit: number;
  /** One full window, in credits: 100 ÷ pointsPerCredit. */
  creditsPerWindow: number;
  /** Points the readings rose while this machine worked, and the credits it used meanwhile. */
  points: number;
  credits: number;
  /** Distinct windows (reset times) the intervals came from. */
  windows: number;
}

export interface Projection {
  /** `current`: the window open now, from its latest reading. `fresh`: a new one starting now. */
  window: "current" | "fresh";
  /** Percent used now (the latest reading, plus this machine's use since it). */
  usedNow: number;
  /** When the window resets (current) or would (fresh). */
  endsAt: string;
  /** When your pace reaches 100%, or null when it does not before `endsAt`. An estimate. */
  hitsAt: string | null;
  /** Percent used at `endsAt` at your pace (can pass 100). An estimate. */
  percentAtEnd: number;
  /** `your-week`: your average week, hour by hour. `this-window`: this window's own pace so far. */
  pace: "your-week" | "this-window";
  /** True when the latest reading is already at 100%. */
  reached: boolean;
}

export interface Reading {
  usedPercent: number;
  readAt: string;
  resetsAt: string | null;
  /** False once its reset has passed. */
  current: boolean;
}

export interface CodexWindow {
  slot: "primary" | "secondary";
  /** "5-hour", "weekly", or the window's length in hours. */
  label: string;
  windowMinutes: number | null;
  latest: Reading | null;
  /** Measured: the highest reading in the pace period, and windows whose reading reached 100%. */
  peakPercent: number | null;
  windowsAtLimit: number;
  calibration: Calibration | null;
  projection: Projection | null;
}

export interface PlanCoverage {
  plan: PlanId;
  name: string;
  feeUsd: number | null;
  /**
   * `measured`: the plan Codex reports, sized from its own readings (an estimate). `condition`:
   * a plan you are not on, whose limit OpenAI does not publish. `priced`: pay as you go.
   */
  kind: "measured" | "condition" | "priced";
  /** Of a week at your pace, the share this plan's weekly limit holds (1 = all of it). */
  coversWeek: number | null;
  /** Credits past the weekly limit in a 30-day month at your pace, and their cost. */
  overflowCredits: number | null;
  overflowUsd: number | null;
  /** A 30-day month at your pace, when one figure can be honest. */
  monthUsd: number | null;
  /** The least it could cost. */
  fromUsd: number;
  /** For `condition`: your week as a multiple of the measured plan's weekly limit. */
  needsTimes: number | null;
  sentence: string;
}

export interface CodexForecast {
  /** The plan Codex names in its latest reading (`plus`, `pro`, …), and the plan row it matches. */
  planType: string | null;
  plan: { id: PlanId; name: string } | null;
  readings: number;
  weekly: CodexWindow | null;
  fiveHour: CodexWindow | null;
  /** Your 5-hour sessions in the pace period, each as a share of the 5-hour window. Estimates. */
  sessions: {
    count: number;
    medianPercent: number;
    busiestPercent: number;
    atOrOverLimit: number;
  } | null;
  /** Other limits Codex reported (for example `premium`), latest reading only: not forecast. */
  otherLimits: { limitId: string; slot: "primary" | "secondary"; reading: Reading }[];
  pace: {
    requests: number;
    credits: number;
    /** An average week at your pace, in credits. */
    weekCredits: number;
    /** Requests on models with neither a credit rate nor a list price: left out. */
    unpriced: number;
  };
  coverage: PlanCoverage[];
}

export interface ClaudeHit {
  at: string;
  kind: LimitKind;
  resetsAt: string | null;
  source: LimitHit["source"];
  version: string;
  /** Where the window started: `resetsAt` less its length, or the 5-hour session it fell in. */
  windowStart: string;
  /** This machine's Claude Code in that window up to the hit, at API list prices. */
  spentUsd: number;
  requests: number;
  /** Inside the pace period. */
  inPace: boolean;
}

export interface ClaudeForecast {
  /** Newest first, within the lookback. */
  hits: ClaudeHit[];
  lookbackDays: number;
  fiveHour: {
    hits: number;
    /** The least and most this machine had spent in a 5-hour window when the limit stopped it. */
    leastUsd: number | null;
    mostUsd: number | null;
    sessions: number;
    medianUsd: number;
    busiestUsd: number;
    /** Sessions in the pace period that reached `leastUsd`. An estimate. */
    sessionsAtLeast: number;
    /** The 5-hour session open now, if any, and when your pace in it reaches `leastUsd`. */
    open: { start: string; spentUsd: number; reachesAt: string | null } | null;
  };
  weekly: {
    hits: number;
    leastUsd: number | null;
    /** An average week at your pace, at API list prices. */
    weekUsd: number;
    /** From the last recorded weekly reset: the week open now, projected at your pace. */
    projection: {
      start: string;
      endsAt: string;
      spentUsd: number;
      reachesAt: string | null;
    } | null;
  };
  pace: { requests: number; apiUsd: number };
}

export interface ForecastView {
  view: "forecast";
  generatedAt: string;
  pace: { from: string; to: string; days: number };
  codex: CodexForecast | null;
  claude: ClaudeForecast | null;
  /** The month at this pace on every plan: seatledger's comparison over the same days. */
  compare: PlanCompareView;
  notes: string[];
}

export interface ForecastOptions {
  now: number;
  /** Epoch ms the pace starts; default 14 days before `now`. */
  since?: number;
  /** Claude Code limit hits (from `loadLimitHits`). */
  hits?: readonly LimitHit[];
  plans?: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const iso = (ts: number): string => new Date(ts).toISOString();

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * One Codex request in credits: OpenAI's rate card, else its API list price at the derived $0.04 a
 * credit (at which every rate on the card is the model's list price), else null.
 */
export function creditsOf(r: UsageRecord): number | null {
  const c = codexCredits(r);
  if (c !== null) return c;
  const usd = apiEquivalentUsd(r);
  return usd === null ? null : usd / CODEX_CREDIT.usd;
}

/** Sessions that open at a request and last five hours, as the vendors describe theirs. */
function sessionsOf<T extends { ts: number }>(
  sorted: readonly T[],
): { start: number; items: T[] }[] {
  const out: { start: number; items: T[] }[] = [];
  for (const x of sorted) {
    const cur = out[out.length - 1];
    if (cur && x.ts < cur.start + FIVE_HOURS) cur.items.push(x);
    else out.push({ start: x.ts, items: [x] });
  }
  return out;
}

/** An average week, hour by hour (168 slots of absolute hours, so time zones do not matter). */
function weekProfile(items: readonly { ts: number; amount: number }[], days: number): number[] {
  const profile = new Array<number>(HOURS_PER_WEEK).fill(0);
  const weeks = Math.max(days, 1) / 7;
  for (const x of items) profile[Math.floor(x.ts / HOUR) % HOURS_PER_WEEK]! += x.amount / weeks;
  return profile;
}

/** Walk the profile hour by hour from `from` to `to`, adding to `start`, until `limit`. */
export function project(
  profile: readonly number[],
  start: number,
  limit: number,
  from: number,
  to: number,
): { reachesAt: number | null; atEnd: number } {
  let acc = start;
  let reachesAt: number | null = acc >= limit ? from : null;
  let t = from;
  while (t < to) {
    const slot = Math.floor(t / HOUR);
    const end = Math.min(to, (slot + 1) * HOUR);
    const rate = profile[slot % HOURS_PER_WEEK] ?? 0;
    const add = (rate * (end - t)) / HOUR;
    if (reachesAt === null && add > 0 && acc + add >= limit)
      reachesAt = t + ((limit - acc) / rate) * HOUR;
    acc += add;
    t = end;
  }
  return { reachesAt, atEnd: acc };
}

/** Prefix sums over requests sorted by time: the amount in (a, b] in O(log n). */
function rangeSum(sorted: readonly { ts: number; amount: number }[]) {
  const ts = sorted.map((x) => x.ts);
  const sums = [0];
  for (const x of sorted) sums.push(sums[sums.length - 1]! + x.amount);
  const upTo = (t: number): number => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid]! <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (a: number, b: number): number => sums[upTo(b)]! - sums[upTo(a)]!;
}

const windowLabel = (slot: "primary" | "secondary", minutes: number | null): string => {
  if (minutes === 300) return "5-hour";
  if (minutes === 10_080) return "weekly";
  if (minutes !== null) return `${Math.round(minutes / 60)}-hour`;
  return slot === "primary" ? "5-hour" : "weekly";
};

const reading = (q: QuotaSample, now: number): Reading => ({
  usedPercent: q.usedPercent,
  readAt: iso(q.ts),
  resetsAt: q.resetsAt === null ? null : iso(q.resetsAt),
  current: q.resetsAt === null || q.resetsAt > now,
});

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

/** Points per credit from the readings of one window kind, over intervals this machine worked in. */
export function calibrate(
  readings: readonly QuotaSample[],
  creditsBetween: (a: number, b: number) => number,
): Calibration | null {
  const byWindow = new Map<number, QuotaSample[]>();
  for (const q of readings) {
    if (q.resetsAt === null) continue;
    const k = Math.round(q.resetsAt / 60_000);
    const list = byWindow.get(k) ?? [];
    list.push(q);
    byWindow.set(k, list);
  }
  let points = 0;
  let credits = 0;
  let windows = 0;
  for (const list of byWindow.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let used = false;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.usedPercent >= 100 || b.usedPercent < a.usedPercent) continue;
      const c = creditsBetween(a.ts, b.ts);
      if (c <= 0) continue; // a rise with no work here is use elsewhere: it cannot be sized
      points += Math.min(b.usedPercent, 100) - a.usedPercent;
      credits += c;
      used = true;
    }
    if (used) windows += 1;
  }
  if (points < MIN_CALIBRATION_POINTS || credits <= 0) return null;
  const pointsPerCredit = points / credits;
  return { pointsPerCredit, creditsPerWindow: 100 / pointsPerCredit, points, credits, windows };
}

function codexWindow(
  slot: "primary" | "secondary",
  samples: readonly QuotaSample[],
  creditsBetween: (a: number, b: number) => number,
  profile: readonly number[],
  now: number,
  since: number,
): CodexWindow | null {
  const mine = samples.filter((q) => q.slot === slot);
  if (mine.length === 0) return null;
  const latest = mine.reduce((a, b) => (b.ts >= a.ts ? b : a));
  const minutes = latest.windowMinutes;
  const inPace = mine.filter((q) => q.ts >= since);
  const atLimit = new Set(inPace.filter((q) => q.usedPercent >= 100).map((q) => q.resetsAt ?? q.ts))
    .size;
  const peak = inPace.length ? Math.max(...inPace.map((q) => q.usedPercent)) : null;
  const calibration = calibrate(
    inPace.filter((q) => q.planType === latest.planType),
    creditsBetween,
  );

  let projection: Projection | null = null;
  if (calibration) {
    const ppc = calibration.pointsPerCredit;
    const pointsProfile = profile.map((c) => c * ppc);
    const length = (minutes ?? (slot === "primary" ? 300 : 10_080)) * 60_000;
    const current = latest.resetsAt !== null && latest.resetsAt > now;
    if (current) {
      const usedNow = latest.usedPercent + creditsBetween(latest.ts, now) * ppc;
      const reached = latest.usedPercent >= 100;
      if (slot === "primary") {
        // A 5-hour window: its own pace so far, not your average week.
        const opened = latest.resetsAt! - length;
        const perHour = usedNow / Math.max((now - opened) / HOUR, 0.25);
        const reachesAt =
          usedNow >= 100 ? now : perHour > 0 ? now + ((100 - usedNow) / perHour) * HOUR : Infinity;
        projection = {
          window: "current",
          usedNow,
          endsAt: iso(latest.resetsAt!),
          hitsAt: reachesAt <= latest.resetsAt! ? iso(reachesAt) : null,
          percentAtEnd: usedNow + perHour * ((latest.resetsAt! - now) / HOUR),
          pace: "this-window",
          reached,
        };
      } else {
        const p = project(pointsProfile, usedNow, 100, now, latest.resetsAt!);
        projection = {
          window: "current",
          usedNow,
          endsAt: iso(latest.resetsAt!),
          hitsAt: p.reachesAt === null ? null : iso(p.reachesAt),
          percentAtEnd: p.atEnd,
          pace: "your-week",
          reached,
        };
      }
    } else if (slot === "secondary") {
      const p = project(pointsProfile, 0, 100, now, now + length);
      projection = {
        window: "fresh",
        usedNow: 0,
        endsAt: iso(now + length),
        hitsAt: p.reachesAt === null ? null : iso(p.reachesAt),
        percentAtEnd: p.atEnd,
        pace: "your-week",
        reached: false,
      };
    }
  }
  return {
    slot,
    label: windowLabel(slot, minutes),
    windowMinutes: minutes,
    latest: reading(latest, now),
    peakPercent: peak,
    windowsAtLimit: atLimit,
    calibration,
    projection,
  };
}

const times = (x: number): string => (x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`);
const share = (x: number): string => `${Math.round(x * 100)}%`;

function codexCoverage(
  plan: { id: PlanId; name: string } | null,
  weekly: CodexWindow | null,
  weekCredits: number,
  quotes: readonly PlanQuote[],
): PlanCoverage[] {
  const out: PlanCoverage[] = [];
  const capacity = weekly?.calibration?.creditsPerWindow ?? null;
  const month = (perWeek: number) => (perWeek * 30) / 7;
  for (const id of ["chatgpt-plus", "chatgpt-pro"] as const) {
    const p = planById(id);
    const fee = p.usdMonthly ?? 0;
    const tiers = p.priceNote ? ` (${p.priceNote})` : "";
    if (plan?.id === id && capacity !== null) {
      const covers = weekCredits > 0 ? Math.min(1, capacity / weekCredits) : 1;
      const overflow = month(Math.max(0, weekCredits - capacity));
      const overflowUsd = overflow * CODEX_CREDIT.usd;
      const single = id === "chatgpt-plus";
      out.push({
        plan: id,
        name: p.name,
        feeUsd: p.usdMonthly,
        kind: "measured",
        coversWeek: covers,
        overflowCredits: overflow,
        overflowUsd,
        monthUsd: single ? fee + overflowUsd : null,
        fromUsd: fee + overflowUsd,
        needsTimes: null,
        sentence:
          (covers >= 1
            ? "its weekly limit holds your whole week at this pace (estimate)"
            : `its weekly limit holds ${share(covers)} of your week (estimate); the rest is about ${Math.round(overflow).toLocaleString("en-US")} credits a month at $${CODEX_CREDIT.usd} a credit (derived)`) +
          (single ? "" : `; ${p.name}${tiers}: the readings do not say which tier`),
      });
      continue;
    }
    if (plan && capacity !== null) {
      const need = weekCredits / capacity;
      const what = id === "chatgpt-pro" ? `no 5-hour limit${tiers}` : "a 5-hour window too";
      out.push({
        plan: id,
        name: p.name,
        feeUsd: p.usdMonthly,
        kind: "condition",
        coversWeek: null,
        overflowCredits: null,
        overflowUsd: null,
        monthUsd: null,
        fromUsd: fee,
        needsTimes: need,
        sentence:
          need <= 1
            ? `${what}; your week already fits in ${plan.name}'s weekly limit (estimate)`
            : `${what}; the fee alone carries your week if its weekly limit is at least ${times(need)} ${plan.name}'s, which OpenAI does not publish`,
      });
      continue;
    }
    const q = quotes.find((x) => x.plan === id && x.carries.length === 1);
    out.push({
      plan: id,
      name: p.name,
      feeUsd: p.usdMonthly,
      kind: "condition",
      coversWeek: null,
      overflowCredits: null,
      overflowUsd: null,
      monthUsd: q?.costUsd ?? null,
      fromUsd: q?.fromUsd ?? fee,
      needsTimes: null,
      sentence: `${p.allowance}${tiers}; Codex's readings on this machine are too few to size it`,
    });
  }
  for (const id of ["codex-credits", "openai-api"] as const) {
    const q = quotes.find((x) => x.plan === id && x.carries.length === 1);
    if (!q || q.costUsd === null) continue;
    out.push({
      plan: id,
      name: q.name,
      feeUsd: null,
      kind: "priced",
      coversWeek: null,
      overflowCredits: null,
      overflowUsd: null,
      monthUsd: q.costUsd,
      fromUsd: q.fromUsd,
      needsTimes: null,
      sentence:
        id === "codex-credits"
          ? `every token at the credit rate card, $${CODEX_CREDIT.usd} a credit (derived)`
          : "every token at list prices",
    });
  }
  return out;
}

function codexForecast(
  loaded: Loaded,
  quotes: readonly PlanQuote[],
  now: number,
  since: number,
): CodexForecast | null {
  const requests = loaded.requests.filter(
    (r) => r.client === "codex" && r.ts >= since && r.ts <= now,
  );
  const samples = loaded.quota.filter((q) => q.client === "codex" && q.ts <= now);
  if (requests.length === 0 && samples.filter((q) => q.ts >= since).length === 0) return null;

  let unpriced = 0;
  const amounts: { ts: number; amount: number }[] = [];
  for (const r of requests) {
    const c = creditsOf(r);
    if (c === null) unpriced += 1;
    else amounts.push({ ts: r.ts, amount: c });
  }
  const days = (now - since) / DAY;
  const credits = amounts.reduce((s, x) => s + x.amount, 0);
  const weekCredits = (credits * 7) / Math.max(days, 1);
  const profile = weekProfile(amounts, days);
  const between = rangeSum(amounts);

  // the main limit; others (e.g. `premium`) are shown as read, not forecast
  const main = samples.filter((q) => q.limitId === CODEX_LIMIT_ID);
  const latestAny = main.length ? main.reduce((a, b) => (b.ts >= a.ts ? b : a)) : null;
  const planType = latestAny?.planType ?? null;
  const match = PLANS.find((p) => p.codexPlanType !== undefined && p.codexPlanType === planType);
  const plan = match ? { id: match.id, name: match.name } : null;

  const weekly = codexWindow("secondary", main, between, profile, now, since);
  const fiveHour = codexWindow("primary", main, between, profile, now, since);

  let sessions: CodexForecast["sessions"] = null;
  const ppc5 = fiveHour?.calibration?.pointsPerCredit;
  if (ppc5) {
    const per = sessionsOf(amounts).map((s) => s.items.reduce((n, x) => n + x.amount, 0) * ppc5);
    if (per.length > 0)
      sessions = {
        count: per.length,
        medianPercent: median(per),
        busiestPercent: Math.max(...per),
        atOrOverLimit: per.filter((p) => p >= 100).length,
      };
  }

  const latestOther = new Map<string, QuotaSample>();
  for (const q of samples) {
    if (q.limitId === CODEX_LIMIT_ID || q.ts < since) continue;
    const k = `${q.limitId}/${q.slot}`;
    const prev = latestOther.get(k);
    if (!prev || q.ts >= prev.ts) latestOther.set(k, q);
  }

  return {
    planType,
    plan,
    readings: main.filter((q) => q.ts >= since).length,
    weekly,
    fiveHour,
    sessions,
    otherLimits: [...latestOther.values()]
      .sort((a, b) => a.limitId.localeCompare(b.limitId) || a.slot.localeCompare(b.slot))
      .map((q) => ({ limitId: q.limitId, slot: q.slot, reading: reading(q, now) })),
    pace: { requests: requests.length, credits, weekCredits, unpriced },
    coverage: codexCoverage(plan, weekly, weekCredits, quotes),
  };
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

const WEEKLY_KINDS: ReadonlySet<LimitKind> = new Set([
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
]);

/** Requests a weekly model limit counts: Opus for `seven_day_opus`, Sonnet for `seven_day_sonnet`. */
const countsFor = (kind: LimitKind) => (r: UsageRecord) =>
  kind === "seven_day_opus"
    ? priceKey(r.model).startsWith("claude-opus")
    : kind === "seven_day_sonnet"
      ? priceKey(r.model).startsWith("claude-sonnet")
      : true;

function claudeForecast(
  loaded: Loaded,
  hits: readonly LimitHit[],
  now: number,
  since: number,
): ClaudeForecast | null {
  const all = loaded.requests
    .filter((r) => r.client === "claude-code" && r.ts <= now)
    .sort((a, b) => a.ts - b.ts);
  const lookback = now - HIT_LOOKBACK_DAYS * DAY;
  const recent = hits.filter((h) => h.ts >= lookback && h.ts <= now);
  const pace = all.filter((r) => r.ts >= since);
  if (pace.length === 0 && recent.length === 0) return null;

  const usd = (r: UsageRecord) => apiEquivalentUsd(r) ?? 0;
  const allSessions = sessionsOf(all);
  const spent = (from: number, to: number, keep: (r: UsageRecord) => boolean) => {
    let s = 0;
    let n = 0;
    for (const r of all) {
      if (r.ts < from || r.ts > to || !keep(r)) continue;
      s += usd(r);
      n += 1;
    }
    return { s, n };
  };

  const out: ClaudeHit[] = [];
  for (const h of recent) {
    let start: number;
    if (h.resetsAt !== null)
      start =
        h.resetsAt - (WEEKLY_KINDS.has(h.kind) ? WEEK : h.kind === "five_hour" ? FIVE_HOURS : 0);
    else {
      const s = allSessions.find((x) => x.start <= h.ts && h.ts < x.start + FIVE_HOURS);
      start = h.kind === "five_hour" || h.kind === "unknown" ? (s?.start ?? h.ts) : h.ts - WEEK;
    }
    if (h.kind === "overage") start = h.ts;
    const { s, n } = spent(start, h.ts, countsFor(h.kind));
    out.push({
      at: iso(h.ts),
      kind: h.kind,
      resetsAt: h.resetsAt === null ? null : iso(h.resetsAt),
      source: h.source,
      version: h.version,
      windowStart: iso(start),
      spentUsd: s,
      requests: n,
      inPace: h.ts >= since,
    });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));

  const five = out.filter((h) => h.kind === "five_hour" && h.requests > 0);
  const leastFive = five.length ? Math.min(...five.map((h) => h.spentUsd)) : null;
  const paceSessions = sessionsOf(pace).map((x) => ({
    start: x.start,
    usd: x.items.reduce((n, r) => n + usd(r), 0),
    last: x.items[x.items.length - 1]!.ts,
  }));
  const perSession = paceSessions.map((x) => x.usd);
  let open: ClaudeForecast["fiveHour"]["open"] = null;
  const last = paceSessions[paceSessions.length - 1];
  if (last && now < last.start + FIVE_HOURS) {
    const perHour = last.usd / Math.max((now - last.start) / HOUR, 0.25);
    let reachesAt: string | null = null;
    if (leastFive !== null) {
      const t =
        last.usd >= leastFive
          ? now
          : perHour > 0
            ? now + ((leastFive - last.usd) / perHour) * HOUR
            : Infinity;
      if (t < last.start + FIVE_HOURS) reachesAt = iso(t);
    }
    open = { start: iso(last.start), spentUsd: last.usd, reachesAt };
  }

  const weeklyHits = out.filter((h) => WEEKLY_KINDS.has(h.kind) && h.requests > 0);
  const leastWeek = weeklyHits.length ? Math.min(...weeklyHits.map((h) => h.spentUsd)) : null;
  const days = (now - since) / DAY;
  const paceUsd = pace.reduce((n, r) => n + usd(r), 0);
  const weekUsd = (paceUsd * 7) / Math.max(days, 1);
  let projection: ClaudeForecast["weekly"]["projection"] = null;
  const anchor = weeklyHits.find((h) => h.resetsAt !== null && h.kind === "seven_day");
  if (anchor && leastWeek !== null) {
    let reset = Date.parse(anchor.resetsAt!);
    while (reset <= now) reset += WEEK;
    const start = reset - WEEK;
    const so = spent(start, now, () => true).s;
    const profile = weekProfile(
      pace.map((r) => ({ ts: r.ts, amount: usd(r) })),
      days,
    );
    const p = project(profile, so, leastWeek, now, reset);
    projection = {
      start: iso(start),
      endsAt: iso(reset),
      spentUsd: so,
      reachesAt: p.reachesAt === null ? null : iso(p.reachesAt),
    };
  }

  return {
    hits: out,
    lookbackDays: HIT_LOOKBACK_DAYS,
    fiveHour: {
      hits: five.length,
      leastUsd: leastFive,
      mostUsd: five.length ? Math.max(...five.map((h) => h.spentUsd)) : null,
      sessions: perSession.length,
      medianUsd: median(perSession),
      busiestUsd: perSession.length ? Math.max(...perSession) : 0,
      sessionsAtLeast: leastFive === null ? 0 : perSession.filter((x) => x >= leastFive).length,
      open,
    },
    weekly: { hits: weeklyHits.length, leastUsd: leastWeek, weekUsd, projection },
    pace: { requests: pace.length, apiUsd: paceUsd },
  };
}

// ---------------------------------------------------------------------------------------------
// The forecast
// ---------------------------------------------------------------------------------------------

export function forecast(loaded: Loaded, opts: ForecastOptions): ForecastView {
  const now = opts.now;
  const since = opts.since ?? now - PACE_DAYS * DAY;
  const compare = planCompare(loaded, { now, since, ...(opts.plans ? { plans: opts.plans } : {}) });
  const codex = codexForecast(loaded, compare.quotes, now, since);
  const claude = claudeForecast(loaded, opts.hits ?? [], now, since);

  const notes: string[] = [];
  if (codex?.readings)
    notes.push(
      "Codex's readings are account-wide: Codex use on other machines and in the cloud counts in them, which makes a window look smaller than it is.",
    );
  if (codex && codex.pace.unpriced > 0)
    notes.push(
      `${codex.pace.unpriced.toLocaleString("en-US")} Codex requests are on models with neither a credit rate nor a list price, and are left out of your pace.`,
    );
  if (claude)
    notes.push(
      "Claude Code writes no percentage of a limit to disk, only the moment one stopped you; its limits are account-wide, so Claude on the web and desktop counts in them too.",
    );
  const firstCodex = loaded.requests.find((r) => r.client === "codex");
  if (firstCodex && firstCodex.ts > since + 2 * DAY)
    notes.push(
      `Codex history on this machine starts ${iso(firstCodex.ts).slice(0, 10)}, after the pace period starts; days before it count as no use.`,
    );

  return {
    view: "forecast",
    generatedAt: iso(now),
    pace: { from: iso(since), to: iso(now), days: (now - since) / DAY },
    codex,
    claude,
    compare,
    notes,
  };
}
