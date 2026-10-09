/**
 * `tokens-per-dollar forecast demo`: the forecast on seatledger's synthetic history, with the limit
 * readings a forecast needs added to it. Everything is generated, in the real on-disk formats, in a
 * temporary directory that is removed afterwards; nothing of anyone's is read.
 *
 * seatledger's generator writes Codex rollouts whose 5-hour readings rise with the work, but whose
 * weekly reading starts again every day, and Claude Code transcripts with no limit in them. So,
 * before reading it back, this demo adds two things a real history has:
 *
 * - **a Codex weekly window that runs a week**: each weekly reading becomes the week's tokens so
 *   far over {@link WEEKLY_TOKENS_PER_POINT}, resetting at 00:00 UTC each Monday, capped at 100% as
 *   Codex caps it (work past it is what extra credits pay for);
 * - **Claude Code 5-hour refusals**: in each 5-hour session whose Claude Code use passes
 *   {@link FIVE_HOUR_USD} at API list prices, the line Claude Code writes when the limit stops it
 *   (`quotaLimits`, `rateLimitType: "five_hour"`), at the request that passed it.
 */
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apiEquivalentUsd, load, writeSyntheticHistory } from "seatledger";
import { loadLimitHits } from "./claude-limits.js";
import { forecast, type ForecastView } from "./forecast.js";
import { renderForecast } from "./forecast-render.js";
import { INSTALL } from "./install.js";

/** Synthetic: one point of the weekly window per this many Codex tokens. */
export const WEEKLY_TOKENS_PER_POINT = 44_000;
/** Synthetic: the 5-hour limit stops Claude Code past this much use, at API list prices. */
export const FIVE_HOUR_USD = 18;

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
/** Monday 5 Jan 1970 00:00 UTC: weeks counted from here start on Mondays. */
const MONDAY = 4 * 24 * HOUR;

export interface ForecastDemo {
  view: ForecastView;
  text: string;
  now: number;
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith(".jsonl") ? [p] : [];
  });

/** Rewrite every Codex weekly reading as a week that runs Monday to Monday. */
function weeklyWindows(codexDir: string): void {
  const files = walk(codexDir).sort();
  let week = -1;
  let tokens = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const next = lines.map((raw) => {
      if (!raw.includes('"token_count"')) return raw;
      const line = JSON.parse(raw) as {
        timestamp: string;
        payload: {
          info?: { last_token_usage?: { total_tokens?: number } };
          rate_limits?: { secondary?: Record<string, unknown> };
        };
      };
      const ts = Date.parse(line.timestamp);
      const w = Math.floor((ts - MONDAY) / WEEK);
      if (w !== week) {
        week = w;
        tokens = 0;
      }
      tokens += line.payload.info?.last_token_usage?.total_tokens ?? 0;
      const limits = line.payload.rate_limits;
      if (limits?.secondary)
        limits.secondary = {
          used_percent: Math.min(100, Math.round((tokens / WEEKLY_TOKENS_PER_POINT) * 10) / 10),
          window_minutes: 10_080,
          resets_at: Math.round((MONDAY + (w + 1) * WEEK) / 1000),
        };
      return JSON.stringify(line);
    });
    writeFileSync(file, next.join("\n"));
  }
}

/** Add the refusal Claude Code writes where a 5-hour session passes the synthetic limit. */
async function fiveHourRefusals(claudeDir: string, home: string): Promise<number> {
  const loaded = await load({
    dirs: { "claude-code": [claudeDir], codex: [] },
    clients: ["claude-code"],
    cache: false,
    home,
  });
  let start = -Infinity;
  let spent = 0;
  let stopped = false;
  let n = 0;
  for (const r of loaded.requests) {
    if (r.ts >= start + 5 * HOUR) {
      start = r.ts;
      spent = 0;
      stopped = false;
    }
    spent += apiEquivalentUsd(r) ?? 0;
    if (stopped || spent < FIVE_HOUR_USD) continue;
    stopped = true;
    n += 1;
    const file = path.join(claudeDir, `-home-dev-${r.project}`, `${r.session}.jsonl`);
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId: r.session,
        version: r.version,
        isSidechain: false,
        isApiErrorMessage: true,
        error: "rate_limit",
        timestamp: new Date(r.ts + 1000).toISOString(),
        message: {
          id: `msg_synthetic_limit_${n}`,
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: "synthetic limit message" }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        quotaLimits: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.round((start + 5 * HOUR) / 1000),
          overageStatus: "rejected",
          isUsingOverage: false,
        },
      }) + "\n",
    );
  }
  return n;
}

export async function runForecastDemo(): Promise<ForecastDemo> {
  const dir = mkdtempSync(path.join(tmpdir(), "tokens-per-dollar-forecast-"));
  try {
    const synth = writeSyntheticHistory({ dir });
    const home = path.join(dir, "home");
    weeklyWindows(synth.codexDir);
    await fiveHourRefusals(synth.claudeDir, home);
    const dirs = { "claude-code": [synth.claudeDir], codex: [synth.codexDir] };
    const loaded = await load({ dirs, cache: false, home });
    const hits = await loadLimitHits({ dirs, home, cache: false });
    const view = forecast(loaded, { now: synth.now, hits });
    return { view, text: renderForecast(view, { timeZone: "UTC" }), now: synth.now };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `forecast demo` prints first, so its output is never read as anyone's usage. */
export const FORECAST_SYNTHETIC_LABEL =
  "Synthetic history, generated for this demo (with limit readings added): not anyone's usage.";

/** The command and what it printed, for the README and the pages. */
export function forecastScreenshotText(demo: ForecastDemo): string {
  return [`$ ${INSTALL} forecast demo`, FORECAST_SYNTHETIC_LABEL, "", demo.text]
    .join("\n")
    .trimEnd();
}
