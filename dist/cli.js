#!/usr/bin/env node

// src/main.ts
import { parseArgs } from "util";
import { load as load3, parseSince, planCompare as planCompare3, resolvePlans, sourceDirs } from "seatledger";

// src/claude-limits.ts
import { createHash } from "crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "fs";
import path from "path";
import { createInterface } from "readline";
import { listSourceFiles } from "seatledger";
var LIMIT_KINDS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
  "unknown"
];
var obj = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : void 0;
var str = (v) => typeof v === "string" ? v : void 0;
function epochMs(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return void 0;
  return n < 1e12 ? n * 1e3 : n;
}
function textOf(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => str(obj(b)?.text) ?? "").join("\n");
}
function kindFromText(text) {
  const head = text.slice(0, 300);
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(head);
  if (legacy) return { kind: "unknown", resetsAt: epochMs(Number(legacy[1])) };
  if (/out of extra usage|extra usage limit|spend limit/i.test(head)) return { kind: "overage" };
  const refused = /limit reached|hit your (?:[a-z0-9-]+ )*limit/i.test(head);
  if (!refused) return void 0;
  if (/\bopus\b/i.test(head) && /weekly/i.test(head)) return { kind: "seven_day_opus" };
  if (/\bsonnet\b/i.test(head) && /weekly/i.test(head)) return { kind: "seven_day_sonnet" };
  if (/weekly/i.test(head)) return { kind: "seven_day" };
  if (/5-hour|five-hour|session limit/i.test(head)) return { kind: "five_hour" };
  return { kind: "unknown" };
}
function hitFromLine(line) {
  if (line.type !== "assistant") return void 0;
  const message = obj(line.message);
  const synthetic = str(message?.model) === "<synthetic>";
  if (line.isApiErrorMessage !== true && !synthetic) return void 0;
  const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(ts)) return void 0;
  const version2 = str(line.version) ?? "";
  const quota = obj(line.quotaLimits);
  if (quota) {
    if (str(quota.status) !== "rejected") return void 0;
    const type = str(quota.rateLimitType);
    const kind2 = LIMIT_KINDS.includes(type ?? "") ? type : "unknown";
    return { ts, kind: kind2, resetsAt: epochMs(quota.resetsAt) ?? null, source: "recorded", version: version2 };
  }
  const found = kindFromText(textOf(message));
  if (!found) return void 0;
  return { ts, kind: found.kind, resetsAt: found.resetsAt ?? null, source: "text", version: version2 };
}
async function readLimitHits(file) {
  const hits = [];
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!raw.includes('"isApiErrorMessage":true') && !raw.includes('"<synthetic>"')) continue;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      const o = obj(value);
      const hit = o && hitFromLine(o);
      if (hit) hits.push(hit);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return hits;
}
function dedupeHits(hits) {
  const sorted = [...hits].sort((a, b) => a.ts - b.ts);
  const out = [];
  const byReset = /* @__PURE__ */ new Map();
  const lastShown2 = /* @__PURE__ */ new Map();
  for (const h of sorted) {
    if (h.resetsAt !== null) {
      const key = `${h.kind}@${Math.round(h.resetsAt / 6e4)}`;
      const at2 = byReset.get(key);
      if (at2 !== void 0) {
        if (out[at2].source === "text" && h.source === "recorded")
          out[at2] = { ...h, ts: out[at2].ts };
        continue;
      }
      byReset.set(key, out.push(h) - 1);
      continue;
    }
    const at = lastShown2.get(h.kind);
    if (at !== void 0 && h.ts - out[at].ts < 30 * 6e4) continue;
    lastShown2.set(h.kind, out.push(h) - 1);
  }
  return out;
}
var LIMITS_DIR = "limits-v1";
var encode = (c) => ({
  v: 1,
  src: c.src,
  size: c.size,
  mtimeMs: c.mtimeMs,
  h: c.hits.map((x) => [
    x.ts,
    x.kind,
    x.resetsAt ?? -1,
    x.source === "recorded" ? 1 : 0,
    x.version
  ])
});
var decode = (w) => ({
  src: w.src,
  size: w.size,
  mtimeMs: w.mtimeMs,
  hits: w.h.map(([ts, kind2, resetsAt, source, version2]) => ({
    ts,
    kind: LIMIT_KINDS.includes(kind2) ? kind2 : "unknown",
    resetsAt: resetsAt < 0 ? null : resetsAt,
    source: source === 1 ? "recorded" : "text",
    version: version2
  }))
});
function readCache(home) {
  const dir = path.join(home, LIMITS_DIR);
  const out = /* @__PURE__ */ new Map();
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const wire = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (wire.v !== 1 || typeof wire.src !== "string" || !Array.isArray(wire.h)) continue;
      out.set(wire.src, decode(wire));
    } catch {
    }
  }
  return out;
}
function writeCache(home, entry) {
  const dir = path.join(home, LIMITS_DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 448 });
    const file = path.join(
      dir,
      createHash("sha256").update(entry.src).digest("hex").slice(0, 32) + ".json"
    );
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(encode(entry)), { mode: 384 });
    renameSync(tmp, file);
  } catch {
  }
}
var under = (file, roots) => roots.some((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
async function loadLimitHits(opts) {
  const useCache = opts.cache ?? true;
  const cache = useCache ? readCache(opts.home) : /* @__PURE__ */ new Map();
  const files = listSourceFiles({ "claude-code": opts.dirs["claude-code"], codex: [] }).filter(
    (f) => f.client === "claude-code"
  );
  const onDisk = new Set(files.map((f) => f.path));
  const all = [];
  const toRead = [];
  for (const f of files) {
    const hit = cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) all.push(...hit.hits);
    else if (opts.since !== void 0 && f.mtimeMs < opts.since) {
      if (hit) all.push(...hit.hits);
    } else toRead.push(f);
  }
  let next = 0;
  const worker = async () => {
    while (next < toRead.length) {
      const f = toRead[next++];
      let hits;
      try {
        hits = await readLimitHits(f.path);
      } catch {
        continue;
      }
      all.push(...hits);
      if (useCache) writeCache(opts.home, { src: f.path, size: f.size, mtimeMs: f.mtimeMs, hits });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));
  for (const [src, entry] of cache) {
    if (onDisk.has(src) || !under(src, opts.dirs["claude-code"])) continue;
    all.push(...entry.hits);
  }
  return dedupeHits(all).filter((h) => opts.since === void 0 || h.ts >= opts.since);
}

// src/demo.ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path2 from "path";
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
var day = (iso2) => {
  const d = new Date(iso2);
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
function table(rows2, indent = "  ") {
  const widths = rows2[0].map((_, i) => Math.max(...rows2.map((r) => (r[i] ?? "").length)));
  return rows2.map(
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
  const dir = mkdtempSync(path2.join(tmpdir(), "tokens-per-dollar-demo-"));
  try {
    const synth = writeSyntheticHistory({ dir });
    const loaded = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home: path2.join(dir, "home")
    });
    const view = planCompare(loaded, { now: synth.now, ...plans ? { plans } : {} });
    return { view, text: renderCompare(view), now: synth.now };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
var SYNTHETIC_LABEL = "Synthetic history, generated for this demo: not anyone's usage.";

// src/forecast-demo.ts
import {
  appendFileSync,
  mkdtempSync as mkdtempSync2,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  rmSync as rmSync2,
  statSync,
  writeFileSync as writeFileSync2
} from "fs";
import { tmpdir as tmpdir2 } from "os";
import path3 from "path";
import { apiEquivalentUsd as apiEquivalentUsd2, load as load2, writeSyntheticHistory as writeSyntheticHistory2 } from "seatledger";

// src/forecast.ts
import {
  apiEquivalentUsd,
  CODEX_CREDIT,
  codexCredits,
  planById as planById2,
  planCompare as planCompare2,
  PLANS,
  priceKey
} from "seatledger";
var HOUR = 36e5;
var DAY = 24 * HOUR;
var WEEK = 7 * DAY;
var FIVE_HOURS = 5 * HOUR;
var HOURS_PER_WEEK = 168;
var PACE_DAYS = 14;
var HIT_LOOKBACK_DAYS = 30;
var MIN_CALIBRATION_POINTS = 3;
var CODEX_LIMIT_ID = "codex";
var iso = (ts) => new Date(ts).toISOString();
function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function creditsOf(r) {
  const c = codexCredits(r);
  if (c !== null) return c;
  const usd3 = apiEquivalentUsd(r);
  return usd3 === null ? null : usd3 / CODEX_CREDIT.usd;
}
function sessionsOf(sorted) {
  const out = [];
  for (const x of sorted) {
    const cur = out[out.length - 1];
    if (cur && x.ts < cur.start + FIVE_HOURS) cur.items.push(x);
    else out.push({ start: x.ts, items: [x] });
  }
  return out;
}
function weekProfile(items, days) {
  const profile = new Array(HOURS_PER_WEEK).fill(0);
  const weeks = Math.max(days, 1) / 7;
  for (const x of items) profile[Math.floor(x.ts / HOUR) % HOURS_PER_WEEK] += x.amount / weeks;
  return profile;
}
function project(profile, start, limit, from, to) {
  let acc = start;
  let reachesAt = acc >= limit ? from : null;
  let t = from;
  while (t < to) {
    const slot = Math.floor(t / HOUR);
    const end = Math.min(to, (slot + 1) * HOUR);
    const rate = profile[slot % HOURS_PER_WEEK] ?? 0;
    const add = rate * (end - t) / HOUR;
    if (reachesAt === null && add > 0 && acc + add >= limit)
      reachesAt = t + (limit - acc) / rate * HOUR;
    acc += add;
    t = end;
  }
  return { reachesAt, atEnd: acc };
}
function rangeSum(sorted) {
  const ts = sorted.map((x) => x.ts);
  const sums = [0];
  for (const x of sorted) sums.push(sums[sums.length - 1] + x.amount);
  const upTo = (t) => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const mid = lo + hi >> 1;
      if (ts[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (a, b) => sums[upTo(b)] - sums[upTo(a)];
}
var windowLabel = (slot, minutes) => {
  if (minutes === 300) return "5-hour";
  if (minutes === 10080) return "weekly";
  if (minutes !== null) return `${Math.round(minutes / 60)}-hour`;
  return slot === "primary" ? "5-hour" : "weekly";
};
var reading = (q, now) => ({
  usedPercent: q.usedPercent,
  readAt: iso(q.ts),
  resetsAt: q.resetsAt === null ? null : iso(q.resetsAt),
  current: q.resetsAt === null || q.resetsAt > now
});
function calibrate(readings, creditsBetween) {
  const byWindow = /* @__PURE__ */ new Map();
  for (const q of readings) {
    if (q.resetsAt === null) continue;
    const k = Math.round(q.resetsAt / 6e4);
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
      const a = list[i - 1];
      const b = list[i];
      if (a.usedPercent >= 100 || b.usedPercent < a.usedPercent) continue;
      const c = creditsBetween(a.ts, b.ts);
      if (c <= 0) continue;
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
function codexWindow(slot, samples, creditsBetween, profile, now, since) {
  const mine = samples.filter((q) => q.slot === slot);
  if (mine.length === 0) return null;
  const latest = mine.reduce((a, b) => b.ts >= a.ts ? b : a);
  const minutes = latest.windowMinutes;
  const inPace = mine.filter((q) => q.ts >= since);
  const atLimit = new Set(inPace.filter((q) => q.usedPercent >= 100).map((q) => q.resetsAt ?? q.ts)).size;
  const peak = inPace.length ? Math.max(...inPace.map((q) => q.usedPercent)) : null;
  const calibration = calibrate(
    inPace.filter((q) => q.planType === latest.planType),
    creditsBetween
  );
  let projection = null;
  if (calibration) {
    const ppc = calibration.pointsPerCredit;
    const pointsProfile = profile.map((c) => c * ppc);
    const length = (minutes ?? (slot === "primary" ? 300 : 10080)) * 6e4;
    const current = latest.resetsAt !== null && latest.resetsAt > now;
    if (current) {
      const usedNow = latest.usedPercent + creditsBetween(latest.ts, now) * ppc;
      const reached = latest.usedPercent >= 100;
      if (slot === "primary") {
        const opened = latest.resetsAt - length;
        const perHour = usedNow / Math.max((now - opened) / HOUR, 0.25);
        const reachesAt = usedNow >= 100 ? now : perHour > 0 ? now + (100 - usedNow) / perHour * HOUR : Infinity;
        projection = {
          window: "current",
          usedNow,
          endsAt: iso(latest.resetsAt),
          hitsAt: reachesAt <= latest.resetsAt ? iso(reachesAt) : null,
          percentAtEnd: usedNow + perHour * ((latest.resetsAt - now) / HOUR),
          pace: "this-window",
          reached
        };
      } else {
        const p = project(pointsProfile, usedNow, 100, now, latest.resetsAt);
        projection = {
          window: "current",
          usedNow,
          endsAt: iso(latest.resetsAt),
          hitsAt: p.reachesAt === null ? null : iso(p.reachesAt),
          percentAtEnd: p.atEnd,
          pace: "your-week",
          reached
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
        reached: false
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
    projection
  };
}
var times = (x) => x >= 10 ? `${Math.round(x)}\xD7` : `${x.toFixed(1)}\xD7`;
var share = (x) => `${Math.round(x * 100)}%`;
function codexCoverage(plan, weekly, weekCredits, quotes) {
  const out = [];
  const capacity = weekly?.calibration?.creditsPerWindow ?? null;
  const month = (perWeek) => perWeek * 30 / 7;
  for (const id of ["chatgpt-plus", "chatgpt-pro"]) {
    const p = planById2(id);
    const fee2 = p.usdMonthly ?? 0;
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
        monthUsd: single ? fee2 + overflowUsd : null,
        fromUsd: fee2 + overflowUsd,
        needsTimes: null,
        sentence: (covers >= 1 ? "its weekly limit holds your whole week at this pace (estimate)" : `its weekly limit holds ${share(covers)} of your week (estimate); the rest is about ${Math.round(overflow).toLocaleString("en-US")} credits a month at $${CODEX_CREDIT.usd} a credit (derived)`) + (single ? "" : `; ${p.name}${tiers}: the readings do not say which tier`)
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
        fromUsd: fee2,
        needsTimes: need,
        sentence: need <= 1 ? `${what}; your week already fits in ${plan.name}'s weekly limit (estimate)` : `${what}; the fee alone carries your week if its weekly limit is at least ${times(need)} ${plan.name}'s, which OpenAI does not publish`
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
      fromUsd: q?.fromUsd ?? fee2,
      needsTimes: null,
      sentence: `${p.allowance}${tiers}; Codex's readings on this machine are too few to size it`
    });
  }
  for (const id of ["codex-credits", "openai-api"]) {
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
      sentence: id === "codex-credits" ? `every token at the credit rate card, $${CODEX_CREDIT.usd} a credit (derived)` : "every token at list prices"
    });
  }
  return out;
}
function codexForecast(loaded, quotes, now, since) {
  const requests = loaded.requests.filter(
    (r) => r.client === "codex" && r.ts >= since && r.ts <= now
  );
  const samples = loaded.quota.filter((q) => q.client === "codex" && q.ts <= now);
  if (requests.length === 0 && samples.filter((q) => q.ts >= since).length === 0) return null;
  let unpriced = 0;
  const amounts = [];
  for (const r of requests) {
    const c = creditsOf(r);
    if (c === null) unpriced += 1;
    else amounts.push({ ts: r.ts, amount: c });
  }
  const days = (now - since) / DAY;
  const credits = amounts.reduce((s, x) => s + x.amount, 0);
  const weekCredits = credits * 7 / Math.max(days, 1);
  const profile = weekProfile(amounts, days);
  const between = rangeSum(amounts);
  const main2 = samples.filter((q) => q.limitId === CODEX_LIMIT_ID);
  const latestAny = main2.length ? main2.reduce((a, b) => b.ts >= a.ts ? b : a) : null;
  const planType = latestAny?.planType ?? null;
  const match = PLANS.find((p) => p.codexPlanType !== void 0 && p.codexPlanType === planType);
  const plan = match ? { id: match.id, name: match.name } : null;
  const weekly = codexWindow("secondary", main2, between, profile, now, since);
  const fiveHour = codexWindow("primary", main2, between, profile, now, since);
  let sessions = null;
  const ppc5 = fiveHour?.calibration?.pointsPerCredit;
  if (ppc5) {
    const per = sessionsOf(amounts).map((s) => s.items.reduce((n, x) => n + x.amount, 0) * ppc5);
    if (per.length > 0)
      sessions = {
        count: per.length,
        medianPercent: median(per),
        busiestPercent: Math.max(...per),
        atOrOverLimit: per.filter((p) => p >= 100).length
      };
  }
  const latestOther = /* @__PURE__ */ new Map();
  for (const q of samples) {
    if (q.limitId === CODEX_LIMIT_ID || q.ts < since) continue;
    const k = `${q.limitId}/${q.slot}`;
    const prev = latestOther.get(k);
    if (!prev || q.ts >= prev.ts) latestOther.set(k, q);
  }
  return {
    planType,
    plan,
    readings: main2.filter((q) => q.ts >= since).length,
    weekly,
    fiveHour,
    sessions,
    otherLimits: [...latestOther.values()].sort((a, b) => a.limitId.localeCompare(b.limitId) || a.slot.localeCompare(b.slot)).map((q) => ({ limitId: q.limitId, slot: q.slot, reading: reading(q, now) })),
    pace: { requests: requests.length, credits, weekCredits, unpriced },
    coverage: codexCoverage(plan, weekly, weekCredits, quotes)
  };
}
var WEEKLY_KINDS = /* @__PURE__ */ new Set([
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included"
]);
var countsFor = (kind2) => (r) => kind2 === "seven_day_opus" ? priceKey(r.model).startsWith("claude-opus") : kind2 === "seven_day_sonnet" ? priceKey(r.model).startsWith("claude-sonnet") : true;
function claudeForecast(loaded, hits, now, since) {
  const all = loaded.requests.filter((r) => r.client === "claude-code" && r.ts <= now).sort((a, b) => a.ts - b.ts);
  const lookback = now - HIT_LOOKBACK_DAYS * DAY;
  const recent = hits.filter((h) => h.ts >= lookback && h.ts <= now);
  const pace = all.filter((r) => r.ts >= since);
  if (pace.length === 0 && recent.length === 0) return null;
  const usd3 = (r) => apiEquivalentUsd(r) ?? 0;
  const allSessions = sessionsOf(all);
  const spent = (from, to, keep) => {
    let s = 0;
    let n = 0;
    for (const r of all) {
      if (r.ts < from || r.ts > to || !keep(r)) continue;
      s += usd3(r);
      n += 1;
    }
    return { s, n };
  };
  const out = [];
  for (const h of recent) {
    let start;
    if (h.resetsAt !== null)
      start = h.resetsAt - (WEEKLY_KINDS.has(h.kind) ? WEEK : h.kind === "five_hour" ? FIVE_HOURS : 0);
    else {
      const s2 = allSessions.find((x) => x.start <= h.ts && h.ts < x.start + FIVE_HOURS);
      start = h.kind === "five_hour" || h.kind === "unknown" ? s2?.start ?? h.ts : h.ts - WEEK;
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
      inPace: h.ts >= since
    });
  }
  out.sort((a, b) => b.at.localeCompare(a.at));
  const five = out.filter((h) => h.kind === "five_hour" && h.requests > 0);
  const leastFive = five.length ? Math.min(...five.map((h) => h.spentUsd)) : null;
  const paceSessions = sessionsOf(pace).map((x) => ({
    start: x.start,
    usd: x.items.reduce((n, r) => n + usd3(r), 0),
    last: x.items[x.items.length - 1].ts
  }));
  const perSession = paceSessions.map((x) => x.usd);
  let open = null;
  const last = paceSessions[paceSessions.length - 1];
  if (last && now < last.start + FIVE_HOURS) {
    const perHour = last.usd / Math.max((now - last.start) / HOUR, 0.25);
    let reachesAt = null;
    if (leastFive !== null) {
      const t = last.usd >= leastFive ? now : perHour > 0 ? now + (leastFive - last.usd) / perHour * HOUR : Infinity;
      if (t < last.start + FIVE_HOURS) reachesAt = iso(t);
    }
    open = { start: iso(last.start), spentUsd: last.usd, reachesAt };
  }
  const weeklyHits = out.filter((h) => WEEKLY_KINDS.has(h.kind) && h.requests > 0);
  const leastWeek = weeklyHits.length ? Math.min(...weeklyHits.map((h) => h.spentUsd)) : null;
  const days = (now - since) / DAY;
  const paceUsd = pace.reduce((n, r) => n + usd3(r), 0);
  const weekUsd = paceUsd * 7 / Math.max(days, 1);
  let projection = null;
  const anchor = weeklyHits.find((h) => h.resetsAt !== null && h.kind === "seven_day");
  if (anchor && leastWeek !== null) {
    let reset = Date.parse(anchor.resetsAt);
    while (reset <= now) reset += WEEK;
    const start = reset - WEEK;
    const so = spent(start, now, () => true).s;
    const profile = weekProfile(
      pace.map((r) => ({ ts: r.ts, amount: usd3(r) })),
      days
    );
    const p = project(profile, so, leastWeek, now, reset);
    projection = {
      start: iso(start),
      endsAt: iso(reset),
      spentUsd: so,
      reachesAt: p.reachesAt === null ? null : iso(p.reachesAt)
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
      open
    },
    weekly: { hits: weeklyHits.length, leastUsd: leastWeek, weekUsd, projection },
    pace: { requests: pace.length, apiUsd: paceUsd }
  };
}
function forecast(loaded, opts) {
  const now = opts.now;
  const since = opts.since ?? now - PACE_DAYS * DAY;
  const compare = planCompare2(loaded, { now, since, ...opts.plans ? { plans: opts.plans } : {} });
  const codex = codexForecast(loaded, compare.quotes, now, since);
  const claude = claudeForecast(loaded, opts.hits ?? [], now, since);
  const notes = [];
  if (codex?.readings)
    notes.push(
      "Codex's readings are account-wide: Codex use on other machines and in the cloud counts in them, which makes a window look smaller than it is."
    );
  if (codex && codex.pace.unpriced > 0)
    notes.push(
      `${codex.pace.unpriced.toLocaleString("en-US")} Codex requests are on models with neither a credit rate nor a list price, and are left out of your pace.`
    );
  if (claude)
    notes.push(
      "Claude Code writes no percentage of a limit to disk, only the moment one stopped you; its limits are account-wide, so Claude on the web and desktop counts in them too."
    );
  const firstCodex = loaded.requests.find((r) => r.client === "codex");
  if (firstCodex && firstCodex.ts > since + 2 * DAY)
    notes.push(
      `Codex history on this machine starts ${iso(firstCodex.ts).slice(0, 10)}, after the pace period starts; days before it count as no use.`
    );
  return {
    view: "forecast",
    generatedAt: iso(now),
    pace: { from: iso(since), to: iso(now), days: (now - since) / DAY },
    codex,
    claude,
    compare,
    notes
  };
}

// src/forecast-render.ts
import { CODEX_CREDIT as CODEX_CREDIT2, planById as planById3 } from "seatledger";
var usd2 = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
var int2 = (n) => Math.round(n).toLocaleString("en-US");
var pct = (n) => `${Math.round(n)}%`;
var MONTHS2 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var WIDTH = 100;
function zoned(tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...tz ? { timeZone: tz } : {}
  });
  return (iso2) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso2)).map((x) => [x.type, x.value]));
    return {
      day: `${p.weekday} ${p.day} ${MONTHS2[Number(p.month) - 1]}`,
      date: `${p.day} ${MONTHS2[Number(p.month) - 1]}`,
      year: p.year,
      time: `${p.hour}:${p.minute}`
    };
  };
}
function clock(tz) {
  const parts = zoned(tz);
  return (iso2, sameDayAs) => {
    const a = parts(iso2);
    if (sameDayAs && parts(sameDayAs).day === a.day) return a.time;
    return `${a.day} ${a.time}`;
  };
}
function range2(fromIso, toIso, tz) {
  const parts = zoned(tz);
  const a = parts(fromIso);
  const b = parts(toIso);
  return a.year === b.year ? `${a.date} \u2013 ${b.date} ${b.year}` : `${a.date} ${a.year} \u2013 ${b.date} ${b.year}`;
}
function span(ms) {
  const h = ms / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"}`;
  return `${(h / 24).toFixed(1)} days`;
}
function hang(first, text, width = WIDTH) {
  const rest = " ".repeat(first.length);
  const out = [];
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
var labelled = (label, text) => hang(`  ${label.padEnd(15)}`, text);
function rows(lines, indent) {
  const a = Math.max(...lines.map((r) => r[0].length));
  const b = Math.max(...lines.map((r) => r[1].length));
  return lines.flatMap(
    ([name, amount, text]) => hang(`${indent}${name.padEnd(a)}  ${amount.padStart(b)}  `, text)
  );
}
function windowLines(w, at, now) {
  const latest = w.latest;
  if (!latest) return [];
  const p = w.projection;
  const lines = [];
  if (latest.current && latest.resetsAt) {
    const since = p && p.usedNow - latest.usedPercent >= 0.5 ? p.usedNow - latest.usedPercent : 0;
    lines.push(
      `${pct(latest.usedPercent)} used at ${at(latest.readAt, now)} (measured)${since ? `, about ${pct(since)} more since (estimate)` : ""} \xB7 resets ${at(latest.resetsAt, now)}`
    );
  } else
    lines.push(
      `no ${w.label} window open now; the last reading was ${pct(latest.usedPercent)}, ${at(latest.readAt, now)} (measured)`
    );
  if (!w.calibration) {
    lines.push(
      "too few readings here to size it: they have to rise at least 3 points while this machine works"
    );
  } else if (p) {
    const pace = p.pace === "this-window" ? "at this window's pace so far" : p.window === "fresh" ? "a fresh week from now, at your pace," : "at your pace";
    if (p.reached) lines.push("Codex's own reading is already at 100%");
    else if (p.hitsAt)
      lines.push(
        `${pace} you reach it ${at(p.hitsAt, now)}, ${span(Date.parse(p.endsAt) - Date.parse(p.hitsAt))} before it resets (estimate)`
      );
    else
      lines.push(
        `${pace} you do not reach it: about ${pct(p.percentAtEnd)} when it resets (estimate)`
      );
  }
  if (w.windowsAtLimit > 0)
    lines.push(
      `${w.windowsAtLimit} ${w.label} window${w.windowsAtLimit === 1 ? "" : "s"} reached 100% in the pace period (measured)`
    );
  const name = `${w.label[0].toUpperCase()}${w.label.slice(1)} limit`;
  return lines.flatMap((l, i) => labelled(i === 0 ? name : "", l));
}
function codexLines(c, at, now) {
  const out = [];
  out.push(
    `Codex \u2014 from its own limit readings${c.plan ? ` (${c.plan.name})` : c.planType ? ` (plan "${c.planType}")` : ""}`
  );
  if (!c.weekly && !c.fiveHour)
    out.push(
      ...hang(
        "  ",
        "Codex wrote no limit readings in this period on this machine, so its limits cannot be read or sized here."
      )
    );
  if (c.weekly) out.push(...windowLines(c.weekly, at, now));
  if (c.fiveHour) out.push(...windowLines(c.fiveHour, at, now));
  else if (c.weekly && c.plan?.id === "chatgpt-pro")
    out.push(...labelled("5-hour limit", "none: Codex reports no 5-hour window on Pro"));
  if (c.sessions)
    out.push(
      ...labelled(
        "Your sessions",
        `your median 5-hour session uses ${pct(c.sessions.medianPercent)} of the 5-hour limit, your busiest ${pct(c.sessions.busiestPercent)}; ${c.sessions.atOrOverLimit} of ${c.sessions.count} would reach it (estimates)`
      )
    );
  const cal = c.weekly?.calibration;
  out.push(
    ...labelled(
      "Your week",
      `${int2(c.pace.weekCredits)} credits at this pace${cal && c.plan ? `; ${c.plan.name}'s weekly limit holds about ${int2(cal.creditsPerWindow)} (estimate, from ${int2(cal.points)} points of readings over ${cal.windows} window${cal.windows === 1 ? "" : "s"})` : ""}`
    )
  );
  for (const o of c.otherLimits)
    out.push(
      ...labelled(
        `"${o.limitId}"`,
        `Codex also reports this limit: ${pct(o.reading.usedPercent)} at ${at(o.reading.readAt, now)}; which requests count toward it is not recorded, so it is not forecast`
      )
    );
  out.push("", "  A 30-day month at this pace");
  out.push(
    ...rows(
      c.coverage.map((p) => {
        const cost2 = p.kind === "priced" ? usd2(p.monthUsd ?? p.fromUsd) : p.kind === "measured" && p.overflowUsd !== null && p.overflowUsd > 5e-3 ? `$${p.feeUsd ?? 0}${p.monthUsd === null ? "+" : ""} + ${usd2(p.overflowUsd)}` : p.kind === "measured" && p.monthUsd !== null ? usd2(p.monthUsd) : `from $${p.feeUsd ?? 0}`;
        return [p.name, cost2, p.sentence];
      }),
      "    "
    )
  );
  return out;
}
var KIND = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  seven_day_overage_included: "weekly limit (with extra usage)",
  overage: "extra-usage limit",
  unknown: "usage limit"
};
function claudeLines(c, quotes, busiest, at, now) {
  const out = [];
  out.push(
    "Claude Code \u2014 what its transcripts show (it records when a limit stops you, not a percentage)"
  );
  if (c.hits.length === 0)
    out.push(
      ...labelled(
        "Limit hits",
        `none recorded in the last ${c.lookbackDays} days; below a limit Claude Code writes nothing about it, so how close you came cannot be read`
      )
    );
  else {
    const counts = /* @__PURE__ */ new Map();
    for (const h of c.hits) counts.set(KIND[h.kind], (counts.get(KIND[h.kind]) ?? 0) + 1);
    out.push(
      ...labelled(
        "Limit hits",
        `${c.hits.length} in the last ${c.lookbackDays} days (${[...counts].map(([k, n]) => `${k} ${n}`).join(", ")}), as recorded:`
      )
    );
    for (const h of c.hits.slice(0, 6))
      out.push(
        ...hang(
          `    ${at(h.at)}  `,
          `${KIND[h.kind]}${h.resetsAt ? `, resets ${at(h.resetsAt, h.at)}` : ""}; this machine had used ${usd2(h.spentUsd)} in that window (API list prices)${h.source === "text" ? "; from the message shown" : ""}`
        )
      );
    if (c.hits.length > 6) out.push(`    \u2026 and ${c.hits.length - 6} more (--json lists them all)`);
  }
  const f = c.fiveHour;
  if (f.sessions > 0) {
    let line = `your median 5-hour session came to ${usd2(f.medianUsd)}, your busiest ${usd2(f.busiestUsd)}`;
    if (f.leastUsd !== null)
      line += `; ${f.sessionsAtLeast} of ${f.sessions} reached ${usd2(f.leastUsd)}, the least this machine had used when the 5-hour limit stopped it (estimate)`;
    out.push(...labelled("At your pace", line));
  }
  if (f.open)
    out.push(
      ...labelled(
        "Open now",
        `${usd2(f.open.spentUsd)} since ${at(f.open.start, now)}${f.leastUsd === null ? "" : f.open.reachesAt ? `; at its pace it reaches ${usd2(f.leastUsd)} at ${at(f.open.reachesAt, now)} (estimate)` : `; at its pace it does not reach ${usd2(f.leastUsd)} before its five hours are up (estimate)`}`
      )
    );
  const w = c.weekly;
  if (w.leastUsd === null)
    out.push(
      ...labelled(
        "Weekly limit",
        `no weekly hit recorded in the last ${c.lookbackDays} days, so its size cannot be read from the transcripts; a week at your pace is ${usd2(w.weekUsd)} at API list prices`
      )
    );
  else {
    let line = `stopped this machine at ${usd2(w.leastUsd)} at the least; a week at your pace is ${usd2(w.weekUsd)} (API list prices)`;
    if (w.projection)
      line += w.projection.reachesAt ? `; the week open now reaches it ${at(w.projection.reachesAt, now)} at your pace (estimate)` : `; the week open now (resets ${at(w.projection.endsAt, now)}) does not reach it at your pace (estimate)`;
    out.push(...labelled("Weekly limit", line));
  }
  const plans = quotes.filter(
    (q) => q.carries.length === 1 && q.carries[0] === "claude-code" && q.vendor === "Anthropic"
  ).sort(
    (a, b) => (a.costUsd ?? a.fromUsd) - (b.costUsd ?? b.fromUsd) || a.name.localeCompare(b.name)
  );
  if (plans.length) {
    out.push("", "  A 30-day month at this pace");
    out.push(
      ...rows(
        plans.map((q) => {
          const plan = planById3(q.plan);
          const how2 = q.costUsd !== null ? "every token at list prices" : [
            plan.timesPro === 1 ? "allowance not published" : `${plan.timesPro}\xD7 Pro a session`,
            ...plan.minSeats ? [`${plan.minSeats} seats min`] : []
          ].join(" \xB7 ");
          return [
            q.name,
            q.costUsd !== null ? usd2(q.costUsd) : `from $${Math.round(q.fromUsd)}`,
            how2
          ];
        }),
        "    "
      )
    );
    if (busiest)
      out.push(
        ...hang(
          "    ",
          `A Claude plan's fee alone carries the month if its allowance holds your busiest 5 hours (${usd2(busiest.five)}) and busiest week (${usd2(busiest.week)}); Anthropic publishes allowances only as multiples of Pro.`
        )
      );
  }
  return out;
}
function renderForecast(v, opts = {}) {
  const tz = opts.timeZone;
  const at = clock(tz);
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const out = [
    "tokens-per-dollar forecast \u2014 when your pace reaches each limit, and what it costs on every plan",
    ...hang(
      "",
      `Pace: your last ${Math.round(v.pace.days)} days, ${range2(v.pace.from, v.pace.to, tz)} \xB7 times in ${zone} \xB7 nothing was sent`
    ),
    ""
  ];
  if (!v.codex && !v.claude) {
    out.push("No Claude Code or Codex requests in this period on this machine.");
    return out.join("\n");
  }
  if (v.codex) out.push(...codexLines(v.codex, at, v.generatedAt), "");
  if (v.claude) {
    const w = v.compare.workloads.find((x) => x.client === "claude-code");
    const busiest = w?.busiestFiveHours && w.busiestWeek ? { five: w.busiestFiveHours.usd, week: w.busiestWeek.usd } : null;
    out.push(...claudeLines(v.claude, v.compare.quotes, busiest, at, v.generatedAt), "");
  }
  for (const n of v.notes) out.push(...hang("", n));
  out.push(
    ...hang(
      "",
      `"(estimate)" is your own readings and pace carried forward; "(measured)" is what the client wrote. A credit is $${CODEX_CREDIT2.usd}, derived from OpenAI's own figures. tokens-per-dollar with no command prices Copilot too; --json lists every figure.`
    )
  );
  return out.join("\n");
}

// src/forecast-demo.ts
var WEEKLY_TOKENS_PER_POINT = 44e3;
var FIVE_HOUR_USD = 18;
var HOUR2 = 36e5;
var WEEK2 = 7 * 24 * HOUR2;
var MONDAY = 4 * 24 * HOUR2;
var walk = (dir) => readdirSync2(dir).flatMap((n) => {
  const p = path3.join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : n.endsWith(".jsonl") ? [p] : [];
});
function weeklyWindows(codexDir) {
  const files = walk(codexDir).sort();
  let week = -1;
  let tokens2 = 0;
  for (const file of files) {
    const lines = readFileSync2(file, "utf8").split("\n");
    const next = lines.map((raw) => {
      if (!raw.includes('"token_count"')) return raw;
      const line = JSON.parse(raw);
      const ts = Date.parse(line.timestamp);
      const w = Math.floor((ts - MONDAY) / WEEK2);
      if (w !== week) {
        week = w;
        tokens2 = 0;
      }
      tokens2 += line.payload.info?.last_token_usage?.total_tokens ?? 0;
      const limits = line.payload.rate_limits;
      if (limits?.secondary)
        limits.secondary = {
          used_percent: Math.min(100, Math.round(tokens2 / WEEKLY_TOKENS_PER_POINT * 10) / 10),
          window_minutes: 10080,
          resets_at: Math.round((MONDAY + (w + 1) * WEEK2) / 1e3)
        };
      return JSON.stringify(line);
    });
    writeFileSync2(file, next.join("\n"));
  }
}
async function fiveHourRefusals(claudeDir, home) {
  const loaded = await load2({
    dirs: { "claude-code": [claudeDir], codex: [] },
    clients: ["claude-code"],
    cache: false,
    home
  });
  let start = -Infinity;
  let spent = 0;
  let stopped = false;
  let n = 0;
  for (const r of loaded.requests) {
    if (r.ts >= start + 5 * HOUR2) {
      start = r.ts;
      spent = 0;
      stopped = false;
    }
    spent += apiEquivalentUsd2(r) ?? 0;
    if (stopped || spent < FIVE_HOUR_USD) continue;
    stopped = true;
    n += 1;
    const file = path3.join(claudeDir, `-home-dev-${r.project}`, `${r.session}.jsonl`);
    appendFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId: r.session,
        version: r.version,
        isSidechain: false,
        isApiErrorMessage: true,
        error: "rate_limit",
        timestamp: new Date(r.ts + 1e3).toISOString(),
        message: {
          id: `msg_synthetic_limit_${n}`,
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: "synthetic limit message" }],
          usage: { input_tokens: 0, output_tokens: 0 }
        },
        quotaLimits: {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: Math.round((start + 5 * HOUR2) / 1e3),
          overageStatus: "rejected",
          isUsingOverage: false
        }
      }) + "\n"
    );
  }
  return n;
}
async function runForecastDemo() {
  const dir = mkdtempSync2(path3.join(tmpdir2(), "tokens-per-dollar-forecast-"));
  try {
    const synth = writeSyntheticHistory2({ dir });
    const home = path3.join(dir, "home");
    weeklyWindows(synth.codexDir);
    await fiveHourRefusals(synth.claudeDir, home);
    const dirs = { "claude-code": [synth.claudeDir], codex: [synth.codexDir] };
    const loaded = await load2({ dirs, cache: false, home });
    const hits = await loadLimitHits({ dirs, home, cache: false });
    const view = forecast(loaded, { now: synth.now, hits });
    return { view, text: renderForecast(view, { timeZone: "UTC" }), now: synth.now };
  } finally {
    rmSync2(dir, { recursive: true, force: true });
  }
}
var FORECAST_SYNTHETIC_LABEL = "Synthetic history, generated for this demo (with limit readings added): not anyone's usage.";

// src/hint.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "fs";
import { homedir } from "os";
import path4 from "path";
import { dayKey } from "seatledger";
var SEATLEDGER_URL = "https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar";
var HINT = `Your team's coding-agent ledger, with a flag when the token rate moves: seatledger, free for up to 3 developers; email alerts on Team, $49/month. ${SEATLEDGER_URL}`;
var FORECAST_HANDOFF = `This forecast reads one laptop's history. seatledger Team keeps every developer's Claude Code and Codex history for 13 months and emails you when the token rate changes, $49/month for up to 10 developers: ${SEATLEDGER_URL}`;
function tpdHome(env = process.env) {
  return env.TPD_HOME ? path4.resolve(env.TPD_HOME) : path4.join(homedir(), ".tokens-per-dollar");
}
var hintFile = (home) => path4.join(home, "hint.json");
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
    const v = JSON.parse(readFileSync3(file, "utf8")).last_shown;
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
    mkdirSync2(ctx.home, { recursive: true });
    writeFileSync3(hintFile(ctx.home), JSON.stringify({ last_shown: today }) + "\n");
  } catch {
    return null;
  }
  return dim(HINT, ctx.env);
}

// src/version.ts
import { readFileSync as readFileSync4 } from "fs";
var cached;
function version() {
  if (cached !== void 0) return cached;
  try {
    cached = JSON.parse(readFileSync4(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    cached = "0.0.0";
  }
  return cached;
}

// src/main.ts
var DAY2 = 864e5;
var HELP = `tokens-per-dollar ${version()} \u2014 your coding agents' month, priced on every plan

Usage
  ${INSTALL} [options]
      this machine's last 30 days of Claude Code and Codex, priced on Claude Pro, Max 5x, Max 20x,
      Team standard and premium, the Anthropic API, ChatGPT Plus and Pro, Codex credits, the
      OpenAI API, and Copilot Pro, Pro+ and Max (an estimate); the cheapest plan per client, the
      margin, and the last vendor change that moved the answer
  ${INSTALL} demo
      the same on synthetic history (reads nothing of yours)
  ${INSTALL} forecast
      at your pace over the last 14 days, when you reach Codex's weekly and 5-hour limits (from
      Codex's own limit readings), how much of your week ChatGPT Plus or Pro holds, what the same
      pace costs on Codex credits and the API, and the Claude Code limit hits its transcripts
      record; every projection is labelled an estimate
  ${INSTALL} forecast demo
      the forecast on synthetic history (reads nothing of yours)

Options
  --since 30d|12w|2026-09-01         from this day (default: the last 30 days; for forecast, the
                                     last 14); figures are stated for a 30-day month either way
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
  TPD_TZ=Europe/London               the forecast's times in this zone (default: this machine's)

What it reads: token counts, model ids, timestamps, Codex's own rate-limit readings, and the
moments Claude Code recorded a limit stopping you, from ~/.claude/projects and ~/.codex/sessions.
It never prints or keeps prompt or response text, file paths or project names.
It makes no network request and has no telemetry.

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
    if (command === "forecast") {
      if (rest.length > 1 || rest[0] !== void 0 && rest[0] !== "demo")
        throw new UsageError(`unexpected argument "${rest[rest[0] === "demo" ? 1 : 0]}"`);
      return await runForecast(rest[0] === "demo", flags, { print, io, env, home, now });
    }
    if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
    if (command !== "compare" && command !== "demo")
      throw new UsageError(
        `unknown command "${command}" (tokens-per-dollar takes no command, forecast, or demo)`
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
      const since = flags.since !== void 0 ? parseSince(flags.since, now) : now - 30 * DAY2;
      const loaded = await load3({
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
      view = planCompare3(loaded, { now, since, ...plans ? { plans } : {} });
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
async function runForecast(demo, flags, ctx) {
  const { print, io, env, home, now } = ctx;
  const plans = flags.plans !== void 0 ? flags.plans.split(",") : void 0;
  try {
    resolvePlans(plans);
  } catch (err) {
    throw new UsageError(`--plans: ${err.message}`);
  }
  if (demo) {
    if (flags.since !== void 0) throw new UsageError("forecast demo always uses 14 days");
    const d = await runForecastDemo();
    if (flags.json) return print(JSON.stringify(d.view, null, 2)), 0;
    print(`${FORECAST_SYNTHETIC_LABEL}

${d.text}`);
    return 0;
  }
  const since = flags.since !== void 0 ? parseSince(flags.since, now) : now - PACE_DAYS * DAY2;
  const from = Math.min(since, now - HIT_LOOKBACK_DAYS * DAY2);
  const dirs = sourceDirs({ claudeDir: flags["claude-dir"], codexDir: flags["codex-dir"] });
  const cache = !flags["no-cache"];
  const loaded = await load3({
    dirs,
    home,
    since: from,
    cache,
    onRead: (n) => {
      if (n > 50 && !flags.json)
        io.err.write(
          `tokens-per-dollar: reading ${n} transcripts (later runs reuse the counts kept in ${home})\u2026
`
        );
    }
  });
  const hits = await loadLimitHits({ dirs, home, since: from, cache });
  const view = forecast(loaded, { now, since, hits, ...plans ? { plans } : {} });
  if (flags.json) return print(JSON.stringify(view, null, 2)), 0;
  print(renderForecast(view, { timeZone: env.TPD_TZ || void 0 }));
  if ((view.codex || view.claude) && !flags.quiet && !quietFromEnv(env))
    print(`
${FORECAST_HANDOFF}`);
  return 0;
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