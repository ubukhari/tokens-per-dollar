/**
 * The forecast as terminal text: Codex first (its readings make it the one that can be sized), then
 * Claude Code (what its transcripts show). Every estimate says so. It prints percentages, dollars,
 * credits, plan names and times; never a prompt, a path or a project name.
 */
import { CODEX_CREDIT, planById, type PlanQuote } from "seatledger";
import type { ClaudeForecast, CodexForecast, CodexWindow, ForecastView } from "./forecast.js";

export interface RenderOptions {
  /** IANA time zone for times; default the machine's own. */
  timeZone?: string | undefined;
}

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n: number): string => Math.round(n).toLocaleString("en-US");
const pct = (n: number): string => `${Math.round(n)}%`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WIDTH = 100;

type Clock = (iso: string, sameDayAs?: string) => string;

function zoned(tz: string | undefined) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(tz ? { timeZone: tz } : {}),
  });
  return (iso: string) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return {
      day: `${p.weekday} ${p.day} ${MONTHS[Number(p.month) - 1]}`,
      date: `${p.day} ${MONTHS[Number(p.month) - 1]}`,
      year: p.year!,
      time: `${p.hour}:${p.minute}`,
    };
  };
}

/** "Thu 9 Oct 14:00"; "14:00" alone when `sameDayAs` falls on the same day. */
function clock(tz: string | undefined): Clock {
  const parts = zoned(tz);
  return (iso, sameDayAs) => {
    const a = parts(iso);
    if (sameDayAs && parts(sameDayAs).day === a.day) return a.time;
    return `${a.day} ${a.time}`;
  };
}

/** "24 Sep – 8 Oct 2026". */
function range(fromIso: string, toIso: string, tz: string | undefined): string {
  const parts = zoned(tz);
  const a = parts(fromIso);
  const b = parts(toIso);
  return a.year === b.year
    ? `${a.date} – ${b.date} ${b.year}`
    : `${a.date} ${a.year} – ${b.date} ${b.year}`;
}

/** "28 hours", "2.5 days". */
function span(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  return `${(h / 24).toFixed(1)} days`;
}

/** Wrap `text` after `first`, continuing under the text's first column. */
export function hang(first: string, text: string, width = WIDTH): string[] {
  const rest = " ".repeat(first.length);
  const out: string[] = [];
  let line = first;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const prefix = out.length === 0 ? first : rest;
    if (line.length > prefix.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = rest + word;
    } else line = line.length > prefix.length ? `${line} ${word}` : `${line}${word}`;
  }
  out.push(line);
  return out.map((l) => l.trimEnd());
}

/** A label, then text that wraps under itself. */
const labelled = (label: string, text: string): string[] => hang(`  ${label.padEnd(15)}`, text);

/** Rows of a name, an amount and a sentence that wraps under itself. */
function rows(lines: readonly (readonly [string, string, string])[], indent: string): string[] {
  const a = Math.max(...lines.map((r) => r[0].length));
  const b = Math.max(...lines.map((r) => r[1].length));
  return lines.flatMap(([name, amount, text]) =>
    hang(`${indent}${name.padEnd(a)}  ${amount.padStart(b)}  `, text),
  );
}

function windowLines(w: CodexWindow, at: Clock, now: string): string[] {
  const latest = w.latest;
  if (!latest) return [];
  const p = w.projection;
  const lines: string[] = [];
  if (latest.current && latest.resetsAt) {
    const since = p && p.usedNow - latest.usedPercent >= 0.5 ? p.usedNow - latest.usedPercent : 0;
    lines.push(
      `${pct(latest.usedPercent)} used at ${at(latest.readAt, now)} (measured)${since ? `, about ${pct(since)} more since (estimate)` : ""} · resets ${at(latest.resetsAt, now)}`,
    );
  } else
    lines.push(
      `no ${w.label} window open now; the last reading was ${pct(latest.usedPercent)}, ${at(latest.readAt, now)} (measured)`,
    );
  if (!w.calibration) {
    lines.push(
      "too few readings here to size it: they have to rise at least 3 points while this machine works",
    );
  } else if (p) {
    const pace =
      p.pace === "this-window"
        ? "at this window's pace so far"
        : p.window === "fresh"
          ? "a fresh week from now, at your pace,"
          : "at your pace";
    if (p.reached) lines.push("Codex's own reading is already at 100%");
    else if (p.hitsAt)
      lines.push(
        `${pace} you reach it ${at(p.hitsAt, now)}, ${span(Date.parse(p.endsAt) - Date.parse(p.hitsAt))} before it resets (estimate)`,
      );
    else
      lines.push(
        `${pace} you do not reach it: about ${pct(p.percentAtEnd)} when it resets (estimate)`,
      );
  }
  if (w.windowsAtLimit > 0)
    lines.push(
      `${w.windowsAtLimit} ${w.label} window${w.windowsAtLimit === 1 ? "" : "s"} reached 100% in the pace period (measured)`,
    );
  const name = `${w.label[0]!.toUpperCase()}${w.label.slice(1)} limit`;
  return lines.flatMap((l, i) => labelled(i === 0 ? name : "", l));
}

function codexLines(c: CodexForecast, at: Clock, now: string): string[] {
  const out: string[] = [];
  out.push(
    `Codex — from its own limit readings${c.plan ? ` (${c.plan.name})` : c.planType ? ` (plan "${c.planType}")` : ""}`,
  );
  if (!c.weekly && !c.fiveHour)
    out.push(
      ...hang(
        "  ",
        "Codex wrote no limit readings in this period on this machine, so its limits cannot be read or sized here.",
      ),
    );
  if (c.weekly) out.push(...windowLines(c.weekly, at, now));
  if (c.fiveHour) out.push(...windowLines(c.fiveHour, at, now));
  else if (c.weekly && c.plan?.id === "chatgpt-pro")
    out.push(...labelled("5-hour limit", "none: Codex reports no 5-hour window on Pro"));
  if (c.sessions)
    out.push(
      ...labelled(
        "Your sessions",
        `your median 5-hour session uses ${pct(c.sessions.medianPercent)} of the 5-hour limit, your busiest ${pct(c.sessions.busiestPercent)}; ${c.sessions.atOrOverLimit} of ${c.sessions.count} would reach it (estimates)`,
      ),
    );
  const cal = c.weekly?.calibration;
  out.push(
    ...labelled(
      "Your week",
      `${int(c.pace.weekCredits)} credits at this pace${cal && c.plan ? `; ${c.plan.name}'s weekly limit holds about ${int(cal.creditsPerWindow)} (estimate, from ${int(cal.points)} points of readings over ${cal.windows} window${cal.windows === 1 ? "" : "s"})` : ""}`,
    ),
  );
  for (const o of c.otherLimits)
    out.push(
      ...labelled(
        `"${o.limitId}"`,
        `Codex also reports this limit: ${pct(o.reading.usedPercent)} at ${at(o.reading.readAt, now)}; which requests count toward it is not recorded, so it is not forecast`,
      ),
    );
  out.push("", "  A 30-day month at this pace");
  out.push(
    ...rows(
      c.coverage.map((p) => {
        const cost =
          p.kind === "priced"
            ? usd(p.monthUsd ?? p.fromUsd)
            : p.kind === "measured" && p.overflowUsd !== null && p.overflowUsd > 0.005
              ? `$${p.feeUsd ?? 0}${p.monthUsd === null ? "+" : ""} + ${usd(p.overflowUsd)}`
              : p.kind === "measured" && p.monthUsd !== null
                ? usd(p.monthUsd)
                : `from $${p.feeUsd ?? 0}`;
        return [p.name, cost, p.sentence] as const;
      }),
      "    ",
    ),
  );
  return out;
}

const KIND: Readonly<Record<string, string>> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit (with extra usage)",
  overage: "extra-usage limit",
  unknown: "usage limit",
};

function claudeLines(
  c: ClaudeForecast,
  quotes: readonly PlanQuote[],
  busiest: { five: number; week: number } | null,
  at: Clock,
  now: string,
): string[] {
  const out: string[] = [];
  out.push(
    "Claude Code — what its transcripts show (it records when a limit stops you, not a percentage)",
  );
  if (c.hits.length === 0)
    out.push(
      ...labelled(
        "Limit hits",
        `none recorded in the last ${c.lookbackDays} days; below a limit Claude Code writes nothing about it, so how close you came cannot be read`,
      ),
    );
  else {
    const counts = new Map<string, number>();
    for (const h of c.hits) counts.set(KIND[h.kind]!, (counts.get(KIND[h.kind]!) ?? 0) + 1);
    out.push(
      ...labelled(
        "Limit hits",
        `${c.hits.length} in the last ${c.lookbackDays} days (${[...counts].map(([k, n]) => `${k} ${n}`).join(", ")}), as recorded:`,
      ),
    );
    for (const h of c.hits.slice(0, 6))
      out.push(
        ...hang(
          `    ${at(h.at)}  `,
          `${KIND[h.kind]}${h.resetsAt ? `, resets ${at(h.resetsAt, h.at)}` : ""}; this machine had used ${usd(h.spentUsd)} in that window (API list prices)${h.source === "text" ? "; from the message shown" : ""}`,
        ),
      );
    if (c.hits.length > 6) out.push(`    … and ${c.hits.length - 6} more (--json lists them all)`);
  }
  const f = c.fiveHour;
  if (f.sessions > 0) {
    let line = `your median 5-hour session came to ${usd(f.medianUsd)}, your busiest ${usd(f.busiestUsd)}`;
    if (f.leastUsd !== null)
      line += `; ${f.sessionsAtLeast} of ${f.sessions} reached ${usd(f.leastUsd)}, the least this machine had used when the 5-hour limit stopped it (estimate)`;
    out.push(...labelled("At your pace", line));
  }
  if (f.open)
    out.push(
      ...labelled(
        "Open now",
        `${usd(f.open.spentUsd)} since ${at(f.open.start, now)}${
          f.leastUsd === null
            ? ""
            : f.open.reachesAt
              ? `; at its pace it reaches ${usd(f.leastUsd)} at ${at(f.open.reachesAt, now)} (estimate)`
              : `; at its pace it does not reach ${usd(f.leastUsd)} before its five hours are up (estimate)`
        }`,
      ),
    );
  const w = c.weekly;
  if (w.leastUsd === null)
    out.push(
      ...labelled(
        "Weekly limit",
        `no weekly hit recorded in the last ${c.lookbackDays} days, so its size cannot be read from the transcripts; a week at your pace is ${usd(w.weekUsd)} at API list prices`,
      ),
    );
  else {
    let line = `stopped this machine at ${usd(w.leastUsd)} at the least; a week at your pace is ${usd(w.weekUsd)} (API list prices)`;
    if (w.projection)
      line += w.projection.reachesAt
        ? `; the week open now reaches it ${at(w.projection.reachesAt, now)} at your pace (estimate)`
        : `; the week open now (resets ${at(w.projection.endsAt, now)}) does not reach it at your pace (estimate)`;
    out.push(...labelled("Weekly limit", line));
  }

  const plans = quotes
    .filter(
      (q) => q.carries.length === 1 && q.carries[0] === "claude-code" && q.vendor === "Anthropic",
    )
    .sort(
      (a, b) => (a.costUsd ?? a.fromUsd) - (b.costUsd ?? b.fromUsd) || a.name.localeCompare(b.name),
    );
  if (plans.length) {
    out.push("", "  A 30-day month at this pace");
    out.push(
      ...rows(
        plans.map((q) => {
          const plan = planById(q.plan);
          const how =
            q.costUsd !== null
              ? "every token at list prices"
              : [
                  plan.timesPro === 1
                    ? "allowance not published"
                    : `${plan.timesPro}× Pro a session`,
                  ...(plan.minSeats ? [`${plan.minSeats} seats min`] : []),
                ].join(" · ");
          return [
            q.name,
            q.costUsd !== null ? usd(q.costUsd) : `from $${Math.round(q.fromUsd)}`,
            how,
          ] as const;
        }),
        "    ",
      ),
    );
    if (busiest)
      out.push(
        ...hang(
          "    ",
          `A Claude plan's fee alone carries the month if its allowance holds your busiest 5 hours (${usd(busiest.five)}) and busiest week (${usd(busiest.week)}); Anthropic publishes allowances only as multiples of Pro.`,
        ),
      );
  }
  return out;
}

export function renderForecast(v: ForecastView, opts: RenderOptions = {}): string {
  const tz = opts.timeZone;
  const at = clock(tz);
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const out: string[] = [
    "tokens-per-dollar forecast — when your pace reaches each limit, and what it costs on every plan",
    ...hang(
      "",
      `Pace: your last ${Math.round(v.pace.days)} days, ${range(v.pace.from, v.pace.to, tz)} · times in ${zone} · nothing was sent`,
    ),
    "",
  ];
  if (!v.codex && !v.claude) {
    out.push("No Claude Code or Codex requests in this period on this machine.");
    return out.join("\n");
  }
  if (v.codex) out.push(...codexLines(v.codex, at, v.generatedAt), "");
  if (v.claude) {
    const w = v.compare.workloads.find((x) => x.client === "claude-code");
    const busiest =
      w?.busiestFiveHours && w.busiestWeek
        ? { five: w.busiestFiveHours.usd, week: w.busiestWeek.usd }
        : null;
    out.push(...claudeLines(v.claude, v.compare.quotes, busiest, at, v.generatedAt), "");
  }
  for (const n of v.notes) out.push(...hang("", n));
  out.push(
    ...hang(
      "",
      `"(estimate)" is your own readings and pace carried forward; "(measured)" is what the client wrote. A credit is $${CODEX_CREDIT.usd}, derived from OpenAI's own figures. tokens-per-dollar with no command prices Copilot too; --json lists every figure.`,
    ),
  );
  return out.join("\n");
}
