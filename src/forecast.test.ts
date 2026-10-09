import { beforeAll, describe, expect, it } from "vitest";
import type { Loaded, QuotaSample, UsageRecord } from "seatledger";
import { runForecastDemo, type ForecastDemo } from "./forecast-demo.js";
import { calibrate, creditsOf, forecast, project } from "./forecast.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-07T16:00:00Z");

function request(ts: number, i: number, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    client: "codex",
    id: `codex:r${i}`,
    ts,
    model: "gpt-5.6-sol",
    version: "0.162.0",
    project: "app",
    session: "t1",
    input: 20_000,
    output: 2_000,
    cacheRead: 80_000,
    cacheWrite: 0,
    cacheWrite1h: null,
    fast: false,
    geoUs: false,
    ...over,
  };
}

function sample(
  ts: number,
  usedPercent: number,
  resetsAt: number,
  over: Partial<QuotaSample> = {},
): QuotaSample {
  return {
    client: "codex",
    ts,
    limitId: "codex",
    slot: "secondary",
    windowMinutes: 10_080,
    usedPercent,
    resetsAt,
    planType: "plus",
    ...over,
  };
}

const loadedOf = (requests: UsageRecord[], quota: QuotaSample[]): Loaded => ({
  requests: [...requests].sort((a, b) => a.ts - b.ts),
  quota: [...quota].sort((a, b) => a.ts - b.ts),
  sources: [],
  since: undefined,
});

describe("project", () => {
  it("walks the average week hour by hour to the limit", () => {
    const flat = new Array<number>(168).fill(1);
    const p = project(flat, 90, 100, 0, 20 * HOUR);
    expect(p.reachesAt).toBe(10 * HOUR);
    expect(p.atEnd).toBeCloseTo(110);
    expect(project(flat, 0, 100, 0, 5 * HOUR)).toEqual({ reachesAt: null, atEnd: 5 });
    expect(project(flat, 100, 100, 7, 8).reachesAt).toBe(7);
    // a quiet hour adds nothing
    const quiet = new Array<number>(168).fill(0);
    expect(project(quiet, 50, 100, 0, 30 * DAY).reachesAt).toBeNull();
  });
});

describe("calibrate", () => {
  const between = (a: number, b: number) => (b - a) / HOUR; // one credit an hour of work
  it("points the readings rose over the credits this machine used meanwhile", () => {
    const reset = 7 * DAY;
    const c = calibrate(
      [sample(0, 0, reset), sample(5 * HOUR, 10, reset), sample(10 * HOUR, 20, reset)],
      between,
    );
    expect(c).toEqual({
      pointsPerCredit: 2,
      creditsPerWindow: 50,
      points: 20,
      credits: 10,
      windows: 1,
    });
  });

  it("ignores intervals from 100%, falls back to null below 3 points, and skips a reset", () => {
    const reset = 7 * DAY;
    expect(
      calibrate(
        [
          sample(0, 90, reset),
          sample(1 * HOUR, 100, reset),
          sample(2 * HOUR, 100, reset),
          sample(3 * HOUR, 100, reset),
        ],
        between,
      ),
    ).toMatchObject({ points: 10, credits: 1 });
    expect(calibrate([sample(0, 0, reset), sample(HOUR, 2, reset)], between)).toBeNull();
    expect(
      calibrate([sample(0, 0, reset), sample(HOUR, 50, reset)], () => 0),
      "a rise with no work on this machine is use elsewhere",
    ).toBeNull();
  });
});

describe("creditsOf", () => {
  it("the rate card, else the list price at $0.04 a credit, else null", () => {
    expect(creditsOf(request(0, 1))).toBeGreaterThan(0);
    expect(creditsOf(request(0, 2, { model: "codex-auto-review" }))).toBeNull();
  });
});

describe("forecast on hand-built histories", () => {
  // 14 days of one working session a day, 09:00–12:00 UTC, 30 requests each
  const requests: UsageRecord[] = [];
  for (let d = 14; d >= 1; d--)
    for (let i = 0; i < 30; i++)
      requests.push(request(NOW - d * DAY + 9 * HOUR + i * 6 * 60_000, d * 100 + i));
  const perDay = requests
    .filter((r) => r.ts >= NOW - DAY - 16 * HOUR && r.ts < NOW - 16 * HOUR)
    .reduce((s, r) => s + (creditsOf(r) ?? 0), 0);

  it("Pro: no 5-hour window, a weekly limit sized from its readings, Plus as a condition", () => {
    // the weekly window runs 1 Oct 16:00 – 8 Oct 16:00; each day's work adds 10 points
    const reset = NOW + DAY;
    const quota: QuotaSample[] = [];
    let used = 0;
    for (const r of requests.filter((x) => x.ts > reset - 7 * DAY)) {
      used += ((creditsOf(r) ?? 0) / perDay) * 10;
      quota.push(sample(r.ts, Math.round(used * 10) / 10, reset, { planType: "pro" }));
    }
    const v = forecast(loadedOf(requests, quota), { now: NOW });
    const c = v.codex!;
    expect(c.plan?.id).toBe("chatgpt-pro");
    expect(c.fiveHour).toBeNull();
    expect(c.weekly?.calibration?.creditsPerWindow).toBeCloseTo(perDay * 10, -1);
    expect(c.weekly?.projection?.window).toBe("current");
    expect(c.weekly?.projection?.hitsAt).toBeNull();
    expect(c.weekly?.projection?.percentAtEnd).toBeCloseTo(used + 10, 0);
    const pro = c.coverage.find((p) => p.plan === "chatgpt-pro")!;
    expect(pro.kind).toBe("measured");
    expect(pro.coversWeek).toBe(1);
    expect(pro.monthUsd).toBeNull(); // the readings do not say which Pro tier
    expect(pro.sentence).toContain("do not say which tier");
    const plus = c.coverage.find((p) => p.plan === "chatgpt-plus")!;
    expect(plus.kind).toBe("condition");
    expect(plus.sentence).toContain("already fits");
    expect(c.coverage.map((p) => p.plan)).toEqual([
      "chatgpt-plus",
      "chatgpt-pro",
      "codex-credits",
      "openai-api",
    ]);
  });

  it("no readings: no window can be sized, and the plans say so", () => {
    const v = forecast(loadedOf(requests, []), { now: NOW });
    expect(v.codex?.weekly).toBeNull();
    expect(v.codex?.plan).toBeNull();
    for (const p of v.codex!.coverage.filter((x) => x.kind === "condition"))
      expect(p.sentence).toContain("too few to size it");
    expect(v.claude).toBeNull();
  });

  it("a weekly window that is over projects a fresh one from now", () => {
    const reset = NOW - DAY;
    const quota = [sample(NOW - 3 * DAY, 10, reset), sample(NOW - 2 * DAY, 40, reset)];
    const v = forecast(loadedOf(requests, quota), { now: NOW });
    expect(v.codex?.weekly?.latest?.current).toBe(false);
    expect(v.codex?.weekly?.projection?.window).toBe("fresh");
    expect(v.codex?.weekly?.projection?.usedNow).toBe(0);
  });
});

describe("forecast on the synthetic history (`forecast demo`)", () => {
  let demo: ForecastDemo;
  beforeAll(async () => {
    demo = await runForecastDemo();
  });

  it("Codex: the weekly window open now reaches 100% before it resets, measured on Plus", () => {
    const c = demo.view.codex!;
    expect(c.plan).toEqual({ id: "chatgpt-plus", name: "ChatGPT Plus" });
    expect(c.weekly?.latest?.current).toBe(true);
    expect(c.weekly?.projection?.hitsAt?.slice(0, 10)).toBe("2026-10-08");
    expect(c.weekly?.windowsAtLimit).toBe(2);
    expect(c.fiveHour?.projection?.hitsAt).toBeNull();
    const plus = c.coverage.find((p) => p.plan === "chatgpt-plus")!;
    expect(plus.kind).toBe("measured");
    expect(plus.coversWeek).toBeGreaterThan(0.6);
    expect(plus.coversWeek).toBeLessThan(0.9);
    expect(plus.monthUsd).toBeCloseTo(20 + plus.overflowUsd!, 6);
    const pro = c.coverage.find((p) => p.plan === "chatgpt-pro")!;
    expect(pro.kind).toBe("condition");
    expect(pro.needsTimes).toBeCloseTo(1 / plus.coversWeek!, 6);
  });

  it("the pay-as-you-go rows are seatledger's comparison over the same days", () => {
    const c = demo.view.codex!;
    for (const id of ["codex-credits", "openai-api"] as const) {
      const q = demo.view.compare.quotes.find((x) => x.plan === id)!;
      expect(c.coverage.find((p) => p.plan === id)?.monthUsd).toBe(q.costUsd);
    }
    expect(demo.view.compare.period.days).toBe(14);
  });

  it("Claude Code: the refusals the transcripts record, and the pace against the least of them", () => {
    const cl = demo.view.claude!;
    expect(cl.hits.length).toBeGreaterThan(0);
    for (const h of cl.hits) {
      expect(h.kind).toBe("five_hour");
      expect(h.source).toBe("recorded");
      expect(h.spentUsd).toBeGreaterThanOrEqual(18);
    }
    expect(cl.fiveHour.leastUsd).toBe(Math.min(...cl.hits.map((h) => h.spentUsd)));
    expect(cl.fiveHour.sessionsAtLeast).toBeGreaterThan(0);
    expect(cl.weekly.leastUsd).toBeNull();
  });

  it("labels every projection, and prints no project, path or text", () => {
    expect(demo.text).toContain("(estimate)");
    expect(demo.text).toContain("(measured)");
    expect(demo.text).toContain("you reach it Thu 8 Oct");
    const json = JSON.stringify(demo.view);
    for (const s of ["webapp", "api-server", "infra", "/home/dev", "synthetic limit message"]) {
      expect(demo.text).not.toContain(s);
      expect(json).not.toContain(s);
    }
    for (const line of demo.text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });
});
