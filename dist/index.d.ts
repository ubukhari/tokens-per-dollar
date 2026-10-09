import { PlanCompareView } from 'seatledger';
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

export { type Demo, HINT, type Io, SEATLEDGER_URL, SYNTHETIC_LABEL, calendarDay, main, quietFromEnv, renderCompare, runDemo, screenshotText, seatledgerHint, textToSvg, tpdHome, usd };
