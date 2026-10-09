/**
 * The one pointer to seatledger: the last line of the human output, at most once a day per
 * machine, only to a terminal, never with `--json`, and never at all with `--quiet` or
 * `TPD_QUIET=1`.
 *
 * It names only what seatledger serves today, as its live pricing.json lists it: a team ledger
 * with rate-change findings, free for up to 3 developers, and email alerts on Team at $49 a month
 * (`distribution.test.ts` holds these against packages/config, which pricing.json is built from).
 * Printing it sends nothing; the day it was last shown is the only state, in
 * `~/.tokens-per-dollar/hint.json`, and if that cannot be written the line is not shown, so a
 * read-only home never turns it into a line on every run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dayKey } from "seatledger";

export const SEATLEDGER_URL =
  "https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar";

export const HINT = `Your team's coding-agent ledger, with a flag when the token rate moves: seatledger, free for up to 3 developers; email alerts on Team, $49/month. ${SEATLEDGER_URL}`;

/**
 * The forecast's last line, every run (never with `--json`, `--quiet` or `TPD_QUIET=1`, and not in
 * the demo): the forecast reads one laptop's history, and what keeps it is seatledger Team. It names
 * only what Team serves today (`distribution.test.ts` holds it against packages/config).
 */
export const FORECAST_HANDOFF = `This forecast reads one laptop's history. seatledger Team keeps every developer's Claude Code and Codex history for 13 months and emails you when the token rate changes, $49/month for up to 10 developers: ${SEATLEDGER_URL}`;

/** tokens-per-dollar's own files: `$TPD_HOME`, else `~/.tokens-per-dollar`. */
export function tpdHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TPD_HOME ? path.resolve(env.TPD_HOME) : path.join(homedir(), ".tokens-per-dollar");
}

export interface HintContext {
  home: string;
  now: number;
  env: NodeJS.ProcessEnv;
  /** stdout is a terminal */
  tty: boolean;
  /** --quiet */
  quiet: boolean;
}

export const hintFile = (home: string): string => path.join(home, "hint.json");

/** TPD_QUIET=1 (any value but empty, 0 or false) silences the pointer. */
export function quietFromEnv(env: NodeJS.ProcessEnv): boolean {
  const v = env.TPD_QUIET?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Dim, unless NO_COLOR asks for plain text or the terminal cannot show it. */
export function dim(text: string, env: NodeJS.ProcessEnv): string {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return text;
  if (env.TERM === "dumb") return text;
  return `\u001b[2m${text}\u001b[22m`;
}

function lastShown(home: string): string | null {
  const file = hintFile(home);
  if (!existsSync(file)) return null;
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { last_shown?: unknown }).last_shown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The line to print, or null. Showing it records today, so the next call today returns null. */
export function seatledgerHint(ctx: HintContext): string | null {
  if (!ctx.tty || ctx.quiet || quietFromEnv(ctx.env)) return null;
  const today = dayKey(ctx.now);
  if (lastShown(ctx.home) === today) return null;
  try {
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(hintFile(ctx.home), JSON.stringify({ last_shown: today }) + "\n");
  } catch {
    return null;
  }
  return dim(HINT, ctx.env);
}
