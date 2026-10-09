#!/usr/bin/env node

// src/main.ts
import { parseArgs } from "util";
import { load as load2, parseSince, planCompare as planCompare2, resolvePlans, sourceDirs } from "seatledger";

// src/demo.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  load,
  planCompare,
  textToSvg as seatledgerSvg,
  writeSyntheticHistory
} from "seatledger";

// src/install.ts
var ON_NPM = false;
var NAME = "tokens-per-dollar";
var REPO = `https://github.com/agentwares/${NAME}`;
var INSTALL = ON_NPM ? `npx ${NAME}` : `npx --allow-git=root github:agentwares/${NAME}`;
var RUN = ON_NPM ? `npx -y ${NAME}@latest` : `npx -y --allow-git=root github:agentwares/${NAME}`;

// src/render.ts
import {
  CLIENT_LABEL,
  planById
} from "seatledger";
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var usd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
var fee = (n) => n === null ? "\u2014" : `$${n}`;
var day = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
var calendarDay = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
};
var tokens = (n) => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
var int = (n) => Math.round(n).toLocaleString("en-US");
var MARK = { anthropic: "\xB9", copilot: "\xB2", credits: "\xB3" };
function cost(q) {
  if (q.costUsd !== null) return usd(q.costUsd);
  return `from ${usd(q.fromUsd)}`;
}
function kind(q) {
  switch (q.kind) {
    case "priced":
      return "priced";
    case "estimate":
      return "estimate";
    case "measured":
    case "measured-at-limit":
      return "measured";
    default:
      return "";
  }
}
function how(q, w) {
  const plan = planById(q.plan);
  if (plan.meter === "api") return "list prices \xD7 your tokens";
  if (plan.meter === "codex-credits")
    return `${int(q.figures.codexCredits ?? 0)} credits at $0.04 ${MARK.credits}`;
  if (plan.meter === "copilot-credits")
    return `${usd(q.figures.copilotUsedUsd ?? 0)} of credits, ${usd(q.figures.includedUsd ?? 0)} included ${MARK.copilot}`;
  if (plan.vendor === "Anthropic") {
    const parts = [
      plan.timesPro === 1 ? "allowance not published" : `${plan.timesPro}\xD7 Pro a session`
    ];
    if (plan.minSeats) parts.push(`${plan.minSeats} seats min`);
    if (q.figures.apiRatesFromStartUsd)
      parts.push(`${usd(q.figures.apiRatesFromStartUsd)} Fable at API rates`);
    return `${parts.join(" \xB7 ")} ${MARK.anthropic}`;
  }
  const rd = w.codexReadings;
  if (q.kind === "measured") return "Codex's readings: never at the limit";
  if (q.kind === "measured-at-limit")
    return `Codex's readings: at the limit ${rd?.windowsAtLimit ?? 0}\xD7; credits past it`;
  return plan.id === "chatgpt-pro" ? "no 5-hour limit; weekly not published" : "limit not published";
}
function table(rows, indent = "  ") {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map(
    (r) => (indent + r.map(
      (cell, i) => i === 1 || i === 2 ? cell.padStart(widths[i]) : cell.padEnd(widths[i])
    ).join("  ")).trimEnd()
  );
}
function workloadLines(v, w, a) {
  const out = [];
  const vendor = w.client === "claude-code" ? "Anthropic" : "OpenAI";
  out.push(
    `${w.label}: ${int(w.requests)} requests, ${tokens(w.tokens.total)} tokens, ${usd(w.monthApiUsd)} at ${vendor} API list prices`
  );
  if (w.busiestFiveHours && w.busiestWeek)
    out.push(
      `  busiest 5 hours ${usd(w.busiestFiveHours.usd)} \xB7 busiest week ${usd(w.busiestWeek.usd)} (API list prices)`
    );
  const rd = w.codexReadings;
  if (rd) {
    const parts = [];
    if (rd.peakFiveHourPercent !== null)
      parts.push(`busiest 5-hour window ${Math.round(rd.peakFiveHourPercent)}%`);
    if (rd.peakWeeklyPercent !== null)
      parts.push(`busiest week ${Math.round(rd.peakWeeklyPercent)}%`);
    out.push(
      `  Codex's own readings${rd.planType ? ` (${PLAN_TYPE[rd.planType] ?? rd.planType})` : ""}: ${parts.join(", ")} of the limit${rd.windowsAtLimit ? `, at the limit ${rd.windowsAtLimit}\xD7` : ", never at it"}`
    );
  }
  out.push("");
  const quotes = v.quotes.filter((q) => q.carries.length === 1 && q.carries[0] === w.client).sort(
    (x, y) => Number(x.costUsd === null) - Number(y.costUsd === null) || (x.costUsd ?? x.fromUsd) - (y.costUsd ?? y.fromUsd) || x.name.localeCompare(y.name)
  );
  out.push(
    ...table([
      ["plan", "fee/mo", "a month like this", "", "how"],
      ...quotes.map((q) => [q.name, fee(q.feeUsd), cost(q), kind(q), how(q, w)])
    ])
  );
  if (a) {
    out.push("");
    const c = a.cheapest.parts[0];
    let line = `  Cheapest priced: ${a.cheapest.label}, ${usd(a.cheapest.costUsd)} a month (${c.kind === "measured" ? "measured" : c.kind})`;
    if (a.runnerUp && a.marginUsd !== null)
      line += `, ${usd(a.marginUsd)} less than ${a.runnerUp.label} (${usd(a.runnerUp.costUsd)})`;
    out.push(...wrap(line + "."));
    if (a.couldBeCheaper.length) {
      const first = a.couldBeCheaper[0];
      const vendorWord = planById(first.plan).vendor;
      const list = a.couldBeCheaper.map((x) => `${x.name} from ${usd(x.fromUsd)}`).join(", ");
      const five = w.busiestFiveHours ? usd(w.busiestFiveHours.usd) : "$0.00";
      const week = w.busiestWeek ? usd(w.busiestWeek.usd) : "$0.00";
      out.push(
        ...wrap(
          `  Could be cheaper, if the allowance ${vendorWord} does not publish holds your busiest 5 hours (${five}) and week (${week}): ${list}.`
        )
      );
    }
  }
  return out;
}
function wrap(line, width = 100) {
  if (line.length <= width) return [line];
  const lead = /^ */.exec(line)[0];
  const out = [];
  let cur = lead;
  for (const word of line.slice(lead.length).split(" ")) {
    if (cur.trim() && (cur + " " + word).length > width) {
      out.push(cur);
      cur = `${lead}  ${word}`;
    } else cur = cur.trim() ? `${cur} ${word}` : `${cur}${word}`;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
var change = (c) => `${calendarDay(c.date)}, ${c.vendor}${c.reported ? " (as reported)" : ""}. ${c.what}`;
function range(fromIso, toIso) {
  const a = day(fromIso);
  const b = day(toIso);
  const year = (s) => s.slice(-4);
  return year(a) === year(b) ? `${a.slice(0, -5)} \u2013 ${b}` : `${a} \u2013 ${b}`;
}
var PLAN_TYPE = { plus: "Plus", pro: "Pro" };
function renderCompare(v) {
  const out = [];
  out.push(
    "tokens-per-dollar \u2014 your coding agents' month, priced on every plan",
    `${range(v.period.from, v.period.to)} \xB7 read from this machine's transcripts; nothing was sent`,
    ""
  );
  if (v.workloads.length === 0) {
    out.push(
      "No Claude Code or Codex requests in this range on this machine.",
      `Try a longer range (--since 90d), or \`${INSTALL} demo\` to see the output on synthetic history.`
    );
    return out.join("\n");
  }
  const a = v.answer;
  for (const w of v.workloads) {
    out.push(
      ...workloadLines(
        v,
        w,
        a?.byClient.find((c) => c.client === w.client)
      ),
      ""
    );
  }
  if (a) {
    if (v.workloads.length > 1) {
      const label = a.cheapest.parts.map((p) => {
        const who = p.carries.length > 1 ? "both" : CLIENT_LABEL[p.carries[0]];
        return `${who} on ${p.name}${p.kind === "estimate" ? ` ${MARK.copilot}` : ""}`;
      }).join(" + ");
      out.push(...wrap(`All of it: ${usd(a.cheapest.costUsd)} a month, ${label}.`));
      const together = v.quotes.filter((q) => q.carries.length === 2 && q.costUsd !== null).sort((x, y) => x.costUsd - y.costUsd)[0];
      if (together && !a.cheapest.label.startsWith("both on"))
        out.push(
          `  On one plan: ${together.name}, ${usd(together.costUsd)} (estimate ${MARK.copilot}).`
        );
    }
    if (a.lastMoved) {
      out.push(...wrap(`Last vendor change that moved this answer: ${change(a.lastMoved)}`));
      if (a.lastMoved.without)
        out.push(
          ...wrap(
            `  Without it: ${a.lastMoved.without.label}, ${usd(a.lastMoved.without.costUsd)}.`
          )
        );
    } else out.push("No dated vendor change in the table moved this answer.");
    if (a.lastTouched && a.lastTouched.date > (a.lastMoved?.date ?? ""))
      out.push(...wrap(`Latest change to a plan in it: ${change(a.lastTouched)}`));
  }
  for (const u of v.upcoming) out.push(...wrap(`Announced: ${change(u)}`));
  out.push("");
  const marks = new Set(
    v.quotes.flatMap((q) => {
      const p = planById(q.plan);
      if (p.meter === "copilot-credits") return [MARK.copilot];
      if (p.meter === "codex-credits") return [MARK.credits];
      if (p.vendor === "Anthropic" && p.meter === "allowance") return [MARK.anthropic];
      return [];
    })
  );
  if (marks.has(MARK.anthropic))
    out.push(
      ...wrap(
        `${MARK.anthropic} Anthropic publishes Claude plan allowances only as multiples of Pro per 5-hour session, plus a weekly limit shared with Claude on the web; past them, extra usage is billed at API rates. "from" is the fee alone.`
      )
    );
  if (marks.has(MARK.copilot))
    out.push(
      ...wrap(
        `${MARK.copilot} An estimate: Copilot keeps no local logs, so these are your Claude Code and Codex tokens at GitHub's per-token rates; its agent would not use exactly these tokens. Included credits contain a flex allotment GitHub says may change.`
      )
    );
  if (marks.has(MARK.credits))
    out.push(
      ...wrap(
        `${MARK.credits} OpenAI does not state a price per credit for Plus or Pro; $0.04 is derived from its own figures (2,500 credits for $100; 25 credits to the dollar on its Enterprise rate card).`
      )
    );
  for (const n of v.notes) out.push(...wrap(n));
  const seen = [...new Set(v.sources.plans.map((p) => p.seen))].sort().at(-1);
  out.push(
    `Plan prices read ${seen ? calendarDay(seen) : "\u2014"} from the vendors' pages; --json lists every source and date.`
  );
  return out.join("\n");
}

// src/demo.ts
async function runDemo(plans) {
  const dir = mkdtempSync(path.join(tmpdir(), "tokens-per-dollar-demo-"));
  try {
    const synth = writeSyntheticHistory({ dir });
    const loaded = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home: path.join(dir, "home")
    });
    const view = planCompare(loaded, { now: synth.now, ...plans ? { plans } : {} });
    return { view, text: renderCompare(view), now: synth.now };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
var SYNTHETIC_LABEL = "Synthetic history, generated for this demo: not anyone's usage.";

// src/hint.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path2 from "path";
import { dayKey } from "seatledger";
var SEATLEDGER_URL = "https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar";
var HINT = `Your team's coding-agent ledger, with a flag when the token rate moves: seatledger, free for up to 3 developers; email alerts on Team, $49/month. ${SEATLEDGER_URL}`;
function tpdHome(env = process.env) {
  return env.TPD_HOME ? path2.resolve(env.TPD_HOME) : path2.join(homedir(), ".tokens-per-dollar");
}
var hintFile = (home) => path2.join(home, "hint.json");
function quietFromEnv(env) {
  const v = env.TPD_QUIET?.trim().toLowerCase();
  return v !== void 0 && v !== "" && v !== "0" && v !== "false";
}
function dim(text, env) {
  if (env.NO_COLOR !== void 0 && env.NO_COLOR !== "") return text;
  if (env.TERM === "dumb") return text;
  return `\x1B[2m${text}\x1B[22m`;
}
function lastShown(home) {
  const file = hintFile(home);
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")).last_shown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}
function seatledgerHint(ctx) {
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

// src/version.ts
import { readFileSync as readFileSync2 } from "fs";
var cached;
function version() {
  if (cached !== void 0) return cached;
  try {
    cached = JSON.parse(readFileSync2(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

// src/main.ts
var DAY = 864e5;
var HELP = `tokens-per-dollar ${version()} \u2014 your coding agents' month, priced on every plan

Usage
  ${INSTALL} [options]
      this machine's last 30 days of Claude Code and Codex, priced on Claude Pro, Max 5x, Max 20x,
      Team standard and premium, the Anthropic API, ChatGPT Plus and Pro, Codex credits, the
      OpenAI API, and Copilot Pro, Pro+ and Max (an estimate); the cheapest plan per client, the
      margin, and the last vendor change that moved the answer
  ${INSTALL} demo
      the same on synthetic history (reads nothing of yours)

Options
  --since 30d|12w|2026-09-01         from this day (default: the last 30 days); figures are
                                     stated for a 30-day month either way
  --plans <list>                     only these plans, comma-separated: ids such as
                                     claude-max-5x, chatgpt-plus, copilot-max, or a group:
                                     claude, codex, copilot
  --json                             machine-readable output, with every source and date
  --claude-dir <dir>                 Claude Code projects dir (default $CLAUDE_CONFIG_DIR/projects,
                                     ~/.claude/projects, ~/.config/claude/projects)
  --codex-dir <dir>                  Codex sessions dir (default $CODEX_HOME/sessions, ~/.codex/sessions)
  --no-cache                         do not read or write ~/.tokens-per-dollar (counts per transcript)
  --quiet                            no seatledger line (also TPD_QUIET=1)
  -h, --help / -v, --version

What it reads: token counts, model ids, timestamps and Codex's own rate-limit readings from
~/.claude/projects and ~/.codex/sessions. It never prints or keeps prompt or response text, file
paths or project names. It makes no network request and has no telemetry.

How it prices: the APIs at their list prices; Codex credits at OpenAI's rate card; Copilot at
GitHub's per-token rates, as an estimate (Copilot keeps no local logs). Anthropic and OpenAI do
not publish plan allowances as numbers, so Claude plans, and Codex plans this machine has no
readings for, get their fee and the condition under which the fee alone carries your month. Plan
prices and their sources are dated; --json lists them.
Source: ${REPO}`;
var UsageError = class extends Error {
};
async function main(argv, io = { out: process.stdout, err: process.stderr }, env = process.env) {
  const print = (s) => io.out.write(s.endsWith("\n") ? s : s + "\n");
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        since: { type: "string" },
        plans: { type: "string" },
        json: { type: "boolean" },
        quiet: { type: "boolean" },
        "claude-dir": { type: "string" },
        "codex-dir": { type: "string" },
        "no-cache": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" }
      }
    });
  } catch (err) {
    io.err.write(
      `tokens-per-dollar: ${err.message}
Run ${INSTALL} --help for usage.
`
    );
    return 2;
  }
  const { values: flags, positionals } = parsed;
  if (flags.help) return print(HELP), 0;
  if (flags.version) return print(version()), 0;
  const [command = "compare", ...rest] = positionals;
  const home = tpdHome(env);
  const fixed = env.TPD_NOW ? Date.parse(env.TPD_NOW) : NaN;
  const now = Number.isFinite(fixed) ? fixed : Date.now();
  try {
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
    if (command !== "compare" && command !== "demo")
      throw new UsageError(
        `unknown command "${command}" (tokens-per-dollar takes no command, or demo)`
      );
    const plans = flags.plans !== void 0 ? flags.plans.split(",") : void 0;
    try {
      resolvePlans(plans);
    } catch (err) {
      throw new UsageError(`--plans: ${err.message}`);
    }
    let view;
    let text;
    if (command === "demo") {
      if (flags.since !== void 0) throw new UsageError("demo always shows the last 30 days");
      const demo = await runDemo(plans);
      view = demo.view;
      text = `${SYNTHETIC_LABEL}

${demo.text}`;
    } else {
      const since = flags.since !== void 0 ? parseSince(flags.since, now) : now - 30 * DAY;
      const loaded = await load2({
        dirs: sourceDirs({ claudeDir: flags["claude-dir"], codexDir: flags["codex-dir"] }),
        home,
        since,
        cache: !flags["no-cache"],
        onRead: (n) => {
          if (n > 50 && !flags.json)
            io.err.write(
              `tokens-per-dollar: reading ${n} transcripts (later runs reuse the counts kept in ${home})\u2026
`
            );
        }
      });
      view = planCompare2(loaded, { now, since, ...plans ? { plans } : {} });
      text = renderCompare(view);
    }
    if (flags.json) {
      print(JSON.stringify(view, null, 2));
      return 0;
    }
    print(text);
    if (command !== "demo" && view.workloads.length > 0) {
      const line = seatledgerHint({
        home,
        now,
        env,
        tty: io.out.isTTY === true,
        quiet: flags.quiet ?? false
      });
      if (line) print(`
${line}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError || /--since takes/.test(err.message)) {
      io.err.write(
        `tokens-per-dollar: ${err.message}
Run ${INSTALL} --help for usage.
`
      );
      return 2;
    }
    throw err;
  }
}

// src/cli.ts
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(
      `tokens-per-dollar: ${err instanceof Error ? err.message : String(err)}
`
    );
    process.exitCode = 1;
  }
);
//# sourceMappingURL=cli.js.map