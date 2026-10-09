/**
 * `tokens-per-dollar` — what this machine's last 30 days of Claude Code and Codex would cost on
 * every coding plan.
 *
 *   tokens-per-dollar                 the comparison, cheapest plan per client, the margin, and
 *                                     the last vendor change that moved the answer
 *   tokens-per-dollar demo            the same on synthetic history (reads nothing of yours)
 *
 * Local only: it reads transcripts through seatledger's readers, keeps counts (never text) in
 * ~/.tokens-per-dollar, and makes no network request. A terminal may show one dim line about
 * seatledger at most once a day (src/hint.ts); it is printed text, and nothing is sent.
 */
import { parseArgs } from "node:util";
import { load, parseSince, planCompare, resolvePlans, sourceDirs } from "seatledger";
import { runDemo, SYNTHETIC_LABEL } from "./demo.js";
import { seatledgerHint, tpdHome } from "./hint.js";
import { INSTALL, REPO } from "./install.js";
import { renderCompare } from "./render.js";
import { version } from "./version.js";

const DAY = 86_400_000;

const HELP = `tokens-per-dollar ${version()} — your coding agents' month, priced on every plan

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

class UsageError extends Error {}

/** Where output goes; tests pass their own. `out.isTTY` decides whether the seatledger line may show. */
export interface Io {
  out: { write(chunk: string): unknown; isTTY?: boolean };
  err: { write(chunk: string): unknown };
}

export async function main(
  argv: string[],
  io: Io = { out: process.stdout, err: process.stderr },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const print = (s: string) => io.out.write(s.endsWith("\n") ? s : s + "\n");
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
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (err) {
    io.err.write(
      `tokens-per-dollar: ${(err as Error).message}\nRun ${INSTALL} --help for usage.\n`,
    );
    return 2;
  }
  const { values: flags, positionals } = parsed;
  if (flags.help) return (print(HELP), 0);
  if (flags.version) return (print(version()), 0);

  const [command = "compare", ...rest] = positionals;
  const home = tpdHome(env);
  // TPD_NOW pins the clock (reproducible output and tests); otherwise it is now.
  const fixed = env.TPD_NOW ? Date.parse(env.TPD_NOW) : NaN;
  const now = Number.isFinite(fixed) ? fixed : Date.now();

  try {
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
    if (command !== "compare" && command !== "demo")
      throw new UsageError(
        `unknown command "${command}" (tokens-per-dollar takes no command, or demo)`,
      );
    const plans = flags.plans !== undefined ? flags.plans.split(",") : undefined;
    try {
      resolvePlans(plans);
    } catch (err) {
      throw new UsageError(`--plans: ${(err as Error).message}`);
    }

    let view;
    let text;
    if (command === "demo") {
      if (flags.since !== undefined) throw new UsageError("demo always shows the last 30 days");
      const demo = await runDemo(plans);
      view = demo.view;
      text = `${SYNTHETIC_LABEL}\n\n${demo.text}`;
    } else {
      const since = flags.since !== undefined ? parseSince(flags.since, now) : now - 30 * DAY;
      const loaded = await load({
        dirs: sourceDirs({ claudeDir: flags["claude-dir"], codexDir: flags["codex-dir"] }),
        home,
        since,
        cache: !flags["no-cache"],
        onRead: (n) => {
          if (n > 50 && !flags.json)
            io.err.write(
              `tokens-per-dollar: reading ${n} transcripts (later runs reuse the counts kept in ${home})…\n`,
            );
        },
      });
      view = planCompare(loaded, { now, since, ...(plans ? { plans } : {}) });
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
        quiet: flags.quiet ?? false,
      });
      if (line) print(`\n${line}`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError || /--since takes/.test((err as Error).message)) {
      io.err.write(
        `tokens-per-dollar: ${(err as Error).message}\nRun ${INSTALL} --help for usage.\n`,
      );
      return 2;
    }
    throw err;
  }
}
