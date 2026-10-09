/**
 * The comparison as terminal text: one section per client, plans cheapest first, then the answer,
 * the dated change that moved it, and footnotes that say which figures are estimates and why.
 * It prints counts, dollars, plan names and dates; never a prompt, a path or a project name.
 */
import {
  CLIENT_LABEL,
  planById,
  type ChangeRef,
  type ClientAnswer,
  type PlanCompareView,
  type PlanQuote,
  type Workload,
} from "seatledger";
import { INSTALL } from "./install.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whole dollars for fees: "$20", "$125". */
const fee = (n: number | null): string => (n === null ? "—" : `$${n}`);

const day = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** "2026-09-14" → "14 Sep 2026", read as a calendar date. */
export const calendarDay = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
};

const tokens = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : String(n);

const int = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Footnote marks, in the order they are explained. */
const MARK = { anthropic: "¹", copilot: "²", credits: "³" } as const;

function cost(q: PlanQuote): string {
  if (q.costUsd !== null) return usd(q.costUsd);
  return `from ${usd(q.fromUsd)}`;
}

function kind(q: PlanQuote): string {
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

/** The short "how" column; the full sentence is `basis` in --json. */
function how(q: PlanQuote, w: Workload): string {
  const plan = planById(q.plan);
  if (plan.meter === "api") return "list prices × your tokens";
  if (plan.meter === "codex-credits")
    return `${int(q.figures.codexCredits ?? 0)} credits at $0.04 ${MARK.credits}`;
  if (plan.meter === "copilot-credits")
    return `${usd(q.figures.copilotUsedUsd ?? 0)} of credits, ${usd(q.figures.includedUsd ?? 0)} included ${MARK.copilot}`;
  if (plan.vendor === "Anthropic") {
    const parts = [
      plan.timesPro === 1 ? "allowance not published" : `${plan.timesPro}× Pro a session`,
    ];
    if (plan.minSeats) parts.push(`${plan.minSeats} seats min`);
    if (q.figures.apiRatesFromStartUsd)
      parts.push(`${usd(q.figures.apiRatesFromStartUsd)} Fable at API rates`);
    return `${parts.join(" · ")} ${MARK.anthropic}`;
  }
  // Codex Plus or Pro
  const rd = w.codexReadings;
  if (q.kind === "measured") return "Codex's readings: never at the limit";
  if (q.kind === "measured-at-limit")
    return `Codex's readings: at the limit ${rd?.windowsAtLimit ?? 0}×; credits past it`;
  return plan.id === "chatgpt-pro"
    ? "no 5-hour limit; weekly not published"
    : "limit not published";
}

function table(rows: string[][], indent = "  "): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    (
      indent +
      r
        .map((cell, i) =>
          i === 1 || i === 2 ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!),
        )
        .join("  ")
    ).trimEnd(),
  );
}

function workloadLines(v: PlanCompareView, w: Workload, a: ClientAnswer | undefined): string[] {
  const out: string[] = [];
  const vendor = w.client === "claude-code" ? "Anthropic" : "OpenAI";
  out.push(
    `${w.label}: ${int(w.requests)} requests, ${tokens(w.tokens.total)} tokens, ${usd(w.monthApiUsd)} at ${vendor} API list prices`,
  );
  if (w.busiestFiveHours && w.busiestWeek)
    out.push(
      `  busiest 5 hours ${usd(w.busiestFiveHours.usd)} · busiest week ${usd(w.busiestWeek.usd)} (API list prices)`,
    );
  const rd = w.codexReadings;
  if (rd) {
    const parts: string[] = [];
    if (rd.peakFiveHourPercent !== null)
      parts.push(`busiest 5-hour window ${Math.round(rd.peakFiveHourPercent)}%`);
    if (rd.peakWeeklyPercent !== null)
      parts.push(`busiest week ${Math.round(rd.peakWeeklyPercent)}%`);
    out.push(
      `  Codex's own readings${rd.planType ? ` (${PLAN_TYPE[rd.planType] ?? rd.planType})` : ""}: ${parts.join(", ")} of the limit${rd.windowsAtLimit ? `, at the limit ${rd.windowsAtLimit}×` : ", never at it"}`,
    );
  }
  out.push("");
  const quotes = v.quotes
    .filter((q) => q.carries.length === 1 && q.carries[0] === w.client)
    .sort(
      (x, y) =>
        Number(x.costUsd === null) - Number(y.costUsd === null) ||
        (x.costUsd ?? x.fromUsd) - (y.costUsd ?? y.fromUsd) ||
        x.name.localeCompare(y.name),
    );
  out.push(
    ...table([
      ["plan", "fee/mo", "a month like this", "", "how"],
      ...quotes.map((q) => [q.name, fee(q.feeUsd), cost(q), kind(q), how(q, w)]),
    ]),
  );
  if (a) {
    out.push("");
    const c = a.cheapest.parts[0]!;
    let line = `  Cheapest priced: ${a.cheapest.label}, ${usd(a.cheapest.costUsd)} a month (${c.kind === "measured" ? "measured" : c.kind})`;
    if (a.runnerUp && a.marginUsd !== null)
      line += `, ${usd(a.marginUsd)} less than ${a.runnerUp.label} (${usd(a.runnerUp.costUsd)})`;
    out.push(...wrap(line + "."));
    if (a.couldBeCheaper.length) {
      const first = a.couldBeCheaper[0]!;
      const vendorWord = planById(first.plan).vendor;
      const list = a.couldBeCheaper.map((x) => `${x.name} from ${usd(x.fromUsd)}`).join(", ");
      const five = w.busiestFiveHours ? usd(w.busiestFiveHours.usd) : "$0.00";
      const week = w.busiestWeek ? usd(w.busiestWeek.usd) : "$0.00";
      out.push(
        ...wrap(
          `  Could be cheaper, if the allowance ${vendorWord} does not publish holds your busiest 5 hours (${five}) and week (${week}): ${list}.`,
        ),
      );
    }
  }
  return out;
}

/** Soft-wrap a line at 100 columns, keeping its own indent and continuing two spaces deeper. */
export function wrap(line: string, width = 100): string[] {
  if (line.length <= width) return [line];
  const lead = /^ */.exec(line)![0];
  const out: string[] = [];
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

const change = (c: ChangeRef): string =>
  `${calendarDay(c.date)}, ${c.vendor}${c.reported ? " (as reported)" : ""}. ${c.what}`;

/** "7 Sep – 7 Oct 2026", or with both years when they differ. */
function range(fromIso: string, toIso: string): string {
  const a = day(fromIso);
  const b = day(toIso);
  const year = (s: string) => s.slice(-4);
  return year(a) === year(b) ? `${a.slice(0, -5)} – ${b}` : `${a} – ${b}`;
}

const PLAN_TYPE: Readonly<Record<string, string>> = { plus: "Plus", pro: "Pro" };

export function renderCompare(v: PlanCompareView): string {
  const out: string[] = [];
  out.push(
    "tokens-per-dollar — your coding agents' month, priced on every plan",
    `${range(v.period.from, v.period.to)} · read from this machine's transcripts; nothing was sent`,
    "",
  );
  if (v.workloads.length === 0) {
    out.push(
      "No Claude Code or Codex requests in this range on this machine.",
      `Try a longer range (--since 90d), or \`${INSTALL} demo\` to see the output on synthetic history.`,
    );
    return out.join("\n");
  }
  const a = v.answer;
  for (const w of v.workloads) {
    out.push(
      ...workloadLines(
        v,
        w,
        a?.byClient.find((c) => c.client === w.client),
      ),
      "",
    );
  }

  if (a) {
    if (v.workloads.length > 1) {
      const label = a.cheapest.parts
        .map((p) => {
          const who = p.carries.length > 1 ? "both" : CLIENT_LABEL[p.carries[0]!];
          return `${who} on ${p.name}${p.kind === "estimate" ? ` ${MARK.copilot}` : ""}`;
        })
        .join(" + ");
      out.push(...wrap(`All of it: ${usd(a.cheapest.costUsd)} a month, ${label}.`));
      const together = v.quotes
        .filter((q) => q.carries.length === 2 && q.costUsd !== null)
        .sort((x, y) => x.costUsd! - y.costUsd!)[0];
      if (together && !a.cheapest.label.startsWith("both on"))
        out.push(
          `  On one plan: ${together.name}, ${usd(together.costUsd!)} (estimate ${MARK.copilot}).`,
        );
    }
    if (a.lastMoved) {
      out.push(...wrap(`Last vendor change that moved this answer: ${change(a.lastMoved)}`));
      if (a.lastMoved.without)
        out.push(
          ...wrap(
            `  Without it: ${a.lastMoved.without.label}, ${usd(a.lastMoved.without.costUsd)}.`,
          ),
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
    }),
  );
  if (marks.has(MARK.anthropic))
    out.push(
      ...wrap(
        `${MARK.anthropic} Anthropic publishes Claude plan allowances only as multiples of Pro per 5-hour session, plus a weekly limit shared with Claude on the web; past them, extra usage is billed at API rates. "from" is the fee alone.`,
      ),
    );
  if (marks.has(MARK.copilot))
    out.push(
      ...wrap(
        `${MARK.copilot} An estimate: Copilot keeps no local logs, so these are your Claude Code and Codex tokens at GitHub's per-token rates; its agent would not use exactly these tokens. Included credits contain a flex allotment GitHub says may change.`,
      ),
    );
  if (marks.has(MARK.credits))
    out.push(
      ...wrap(
        `${MARK.credits} OpenAI does not state a price per credit for Plus or Pro; $0.04 is derived from its own figures (2,500 credits for $100; 25 credits to the dollar on its Enterprise rate card).`,
      ),
    );
  for (const n of v.notes) out.push(...wrap(n));
  const seen = [...new Set(v.sources.plans.map((p) => p.seen))].sort().at(-1);
  out.push(
    `Plan prices read ${seen ? calendarDay(seen) : "—"} from the vendors' pages; --json lists every source and date.`,
  );
  return out.join("\n");
}
