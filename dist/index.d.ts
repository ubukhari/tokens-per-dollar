import { PlanCompareView, SourceDirs, PlanId, QuotaSample, UsageRecord, Loaded } from 'seatledger';
export { PlanCompareView, planCompare } from 'seatledger';

/** Where output goes; tests pass their own. `out.isTTY` decides whether the seatledger line may show. */
interface Io {
    out: {
        write(chunk: string): unknown;
        isTTY?: boolean;
    };
    err: {
        write(chunk: string): unknown;
    };
}
declare function main(argv: string[], io?: Io, env?: NodeJS.ProcessEnv): Promise<number>;

/**
 * The comparison as terminal text: one section per client, plans cheapest first, then the answer,
 * the dated change that moved it, and footnotes that say which figures are estimates and why.
 * It prints counts, dollars, plan names and dates; never a prompt, a path or a project name.
 */

declare const usd: (n: number) => string;
/** "2026-09-14" → "14 Sep 2026", read as a calendar date. */
declare const calendarDay: (ymd: string) => string;
declare function renderCompare(v: PlanCompareView): string;

interface Demo {
    view: PlanCompareView;
    text: string;
    now: number;
}
declare function runDemo(plans?: readonly string[]): Promise<Demo>;
/** What `demo` prints first, so its output is never read as anyone's usage. */
declare const SYNTHETIC_LABEL = "Synthetic history, generated for this demo: not anyone's usage.";
/** The README picture: the command and what it printed on synthetic history. */
declare function screenshotText(demo: Demo): string;
/** seatledger's terminal-style SVG, labelled as this tool's output. */
declare function textToSvg(text: string): string;

declare const SEATLEDGER_URL = "https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar";
declare const HINT = "Your team's coding-agent ledger, with a flag when the token rate moves: seatledger, free for up to 3 developers; email alerts on Team, $49/month. https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar";
/**
 * The forecast's last line, every run (never with `--json`, `--quiet` or `TPD_QUIET=1`, and not in
 * the demo): the forecast reads one laptop's history, and what keeps it is seatledger Team. It names
 * only what Team serves today (`distribution.test.ts` holds it against packages/config).
 */
declare const FORECAST_HANDOFF = "This forecast reads one laptop's history. seatledger Team keeps every developer's Claude Code and Codex history for 13 months and emails you when the token rate changes, $49/month for up to 10 developers: https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar";
/** tokens-per-dollar's own files: `$TPD_HOME`, else `~/.tokens-per-dollar`. */
declare function tpdHome(env?: NodeJS.ProcessEnv): string;
interface HintContext {
    home: string;
    now: number;
    env: NodeJS.ProcessEnv;
    /** stdout is a terminal */
    tty: boolean;
    /** --quiet */
    quiet: boolean;
}
/** TPD_QUIET=1 (any value but empty, 0 or false) silences the pointer. */
declare function quietFromEnv(env: NodeJS.ProcessEnv): boolean;
/** The line to print, or null. Showing it records today, so the next call today returns null. */
declare function seatledgerHint(ctx: HintContext): string | null;

declare const LIMIT_KINDS: readonly ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage", "unknown"];
type LimitKind = (typeof LIMIT_KINDS)[number];
/** One refusal Claude Code recorded because a plan limit was spent. */
interface LimitHit {
    /** Epoch ms of the line. */
    ts: number;
    kind: LimitKind;
    /** Epoch ms the limit resets, when the transcript says; null when only the shown text is there. */
    resetsAt: number | null;
    /** `recorded`: Claude Code's own `quotaLimits` field. `text`: matched from the message it showed. */
    source: "recorded" | "text";
    /** Claude Code version that wrote it, or "". */
    version: string;
}
/**
 * The kind of limit the client's shown text names, or undefined when it is not a plan-limit
 * refusal. Only the client's own phrasings are recognised.
 */
declare function kindFromText(text: string): {
    kind: LimitKind;
    resetsAt?: number;
} | undefined;
/** The hit one transcript line records, if it records one. */
declare function hitFromLine(line: Record<string, unknown>): LimitHit | undefined;
/** Every hit in one Claude Code transcript. Streams the file; parses only candidate lines. */
declare function readLimitHits(file: string): Promise<LimitHit[]>;
/** One refusal per limit and reset: the same one is written into every session that was running. */
declare function dedupeHits(hits: readonly LimitHit[]): LimitHit[];
interface LimitHitOptions {
    dirs: SourceDirs;
    home: string;
    /** Epoch ms: hits before it are dropped, and transcripts last written before it are not read. */
    since?: number;
    cache?: boolean;
}
/** Every distinct limit hit in this machine's Claude Code transcripts, oldest first. */
declare function loadLimitHits(opts: LimitHitOptions): Promise<LimitHit[]>;

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

/** The pace: your own last 14 days, unless --since says otherwise. */
declare const PACE_DAYS = 14;
/** How far back Claude Code's limit hits are listed and sized. */
declare const HIT_LOOKBACK_DAYS = 30;
/** Points of a window per Codex credit, from the readings and this machine's own requests. */
interface Calibration {
    pointsPerCredit: number;
    /** One full window, in credits: 100 ÷ pointsPerCredit. */
    creditsPerWindow: number;
    /** Points the readings rose while this machine worked, and the credits it used meanwhile. */
    points: number;
    credits: number;
    /** Distinct windows (reset times) the intervals came from. */
    windows: number;
}
interface Projection {
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
interface Reading {
    usedPercent: number;
    readAt: string;
    resetsAt: string | null;
    /** False once its reset has passed. */
    current: boolean;
}
interface CodexWindow {
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
interface PlanCoverage {
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
interface CodexForecast {
    /** The plan Codex names in its latest reading (`plus`, `pro`, …), and the plan row it matches. */
    planType: string | null;
    plan: {
        id: PlanId;
        name: string;
    } | null;
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
    otherLimits: {
        limitId: string;
        slot: "primary" | "secondary";
        reading: Reading;
    }[];
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
interface ClaudeHit {
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
interface ClaudeForecast {
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
        open: {
            start: string;
            spentUsd: number;
            reachesAt: string | null;
        } | null;
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
    pace: {
        requests: number;
        apiUsd: number;
    };
}
interface ForecastView {
    view: "forecast";
    generatedAt: string;
    pace: {
        from: string;
        to: string;
        days: number;
    };
    codex: CodexForecast | null;
    claude: ClaudeForecast | null;
    /** The month at this pace on every plan: seatledger's comparison over the same days. */
    compare: PlanCompareView;
    notes: string[];
}
interface ForecastOptions {
    now: number;
    /** Epoch ms the pace starts; default 14 days before `now`. */
    since?: number;
    /** Claude Code limit hits (from `loadLimitHits`). */
    hits?: readonly LimitHit[];
    plans?: readonly string[];
}
/**
 * One Codex request in credits: OpenAI's rate card, else its API list price at the derived $0.04 a
 * credit (at which every rate on the card is the model's list price), else null.
 */
declare function creditsOf(r: UsageRecord): number | null;
/** Walk the profile hour by hour from `from` to `to`, adding to `start`, until `limit`. */
declare function project(profile: readonly number[], start: number, limit: number, from: number, to: number): {
    reachesAt: number | null;
    atEnd: number;
};
/** Points per credit from the readings of one window kind, over intervals this machine worked in. */
declare function calibrate(readings: readonly QuotaSample[], creditsBetween: (a: number, b: number) => number): Calibration | null;
declare function forecast(loaded: Loaded, opts: ForecastOptions): ForecastView;

interface RenderOptions {
    /** IANA time zone for times; default the machine's own. */
    timeZone?: string | undefined;
}
declare function renderForecast(v: ForecastView, opts?: RenderOptions): string;

interface ForecastDemo {
    view: ForecastView;
    text: string;
    now: number;
}
declare function runForecastDemo(): Promise<ForecastDemo>;
/** What `forecast demo` prints first, so its output is never read as anyone's usage. */
declare const FORECAST_SYNTHETIC_LABEL = "Synthetic history, generated for this demo (with limit readings added): not anyone's usage.";
/** The command and what it printed, for the README and the pages. */
declare function forecastScreenshotText(demo: ForecastDemo): string;

export { type Calibration, type ClaudeForecast, type ClaudeHit, type CodexForecast, type CodexWindow, type Demo, FORECAST_HANDOFF, FORECAST_SYNTHETIC_LABEL, type ForecastDemo, type ForecastOptions, type ForecastView, HINT, HIT_LOOKBACK_DAYS, type Io, type LimitHit, type LimitKind, PACE_DAYS, type PlanCoverage, type Projection, SEATLEDGER_URL, SYNTHETIC_LABEL, calendarDay, calibrate, creditsOf, dedupeHits, forecast, forecastScreenshotText, hitFromLine, kindFromText, loadLimitHits, main, project, quietFromEnv, readLimitHits, renderCompare, renderForecast, runDemo, runForecastDemo, screenshotText, seatledgerHint, textToSvg, tpdHome, usd };
