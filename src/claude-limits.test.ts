import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dedupeHits,
  hitFromLine,
  kindFromText,
  LIMITS_DIR,
  loadLimitHits,
  readLimitHits,
} from "./claude-limits.js";

const at = "2026-10-08T18:00:00.000Z";
const T = Date.parse(at);

/** A refusal line in the shape Claude Code 2.1.255+ writes (values are placeholders). */
const recorded = (over: Record<string, unknown> = {}, quota: Record<string, unknown> = {}) => ({
  type: "assistant",
  sessionId: "s1",
  version: "2.1.286",
  timestamp: at,
  isApiErrorMessage: true,
  error: "rate_limit",
  message: { model: "<synthetic>", content: [{ type: "text", text: "placeholder" }] },
  quotaLimits: {
    status: "rejected",
    rateLimitType: "five_hour",
    resetsAt: T / 1000 + 3600,
    overageStatus: "rejected",
    isUsingOverage: false,
    ...quota,
  },
  ...over,
});

/** An older refusal: only the text the client showed. */
const shown = (text: string, over: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: at,
  version: "2.1.120",
  isApiErrorMessage: true,
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
  ...over,
});

describe("hitFromLine", () => {
  it("reads the recorded form: kind, reset time in seconds, version", () => {
    expect(hitFromLine(recorded())).toEqual({
      ts: T,
      kind: "five_hour",
      resetsAt: T + 3_600_000,
      source: "recorded",
      version: "2.1.286",
    });
    expect(hitFromLine(recorded({}, { rateLimitType: "seven_day_opus" }))?.kind).toBe(
      "seven_day_opus",
    );
    expect(hitFromLine(recorded({}, { rateLimitType: "something_new" }))?.kind).toBe("unknown");
  });

  it("a warning is not a hit, and neither is any other line", () => {
    expect(hitFromLine(recorded({}, { status: "allowed_warning" }))).toBeUndefined();
    expect(hitFromLine({ ...recorded(), type: "user" })).toBeUndefined();
    expect(
      hitFromLine({
        type: "assistant",
        timestamp: at,
        message: { model: "claude-opus-5-5", content: [{ type: "text", text: "limit reached" }] },
      }),
    ).toBeUndefined();
  });

  it("reads the older shown forms by the client's own wording", () => {
    expect(hitFromLine(shown("Claude AI usage limit reached|1759950000"))).toMatchObject({
      kind: "unknown",
      resetsAt: 1_759_950_000_000,
      source: "text",
    });
    expect(hitFromLine(shown("5-hour limit reached ∙ resets 3pm"))?.kind).toBe("five_hour");
    expect(
      hitFromLine(shown("You've hit your session limit · resets 3pm (Europe/London)"))?.kind,
    ).toBe("five_hour");
    expect(hitFromLine(shown("Weekly limit reached ∙ resets Oct 9, 3pm"))?.kind).toBe("seven_day");
    expect(hitFromLine(shown("Opus weekly limit reached ∙ resets Oct 9"))?.kind).toBe(
      "seven_day_opus",
    );
    expect(hitFromLine(shown("You're out of extra usage · resets 3pm"))?.kind).toBe("overage");
  });

  it("an API error that names no plan limit (per-minute limits, overload) is not a hit", () => {
    expect(hitFromLine(shown("API Error: Rate limited. Please try again later."))).toBeUndefined();
    expect(hitFromLine(shown("Opus is experiencing high load"))).toBeUndefined();
    expect(kindFromText("Request was aborted.")).toBeUndefined();
  });
});

describe("dedupeHits", () => {
  it("one refusal per limit and reset, keeping the first moment and the recorded form", () => {
    const a = hitFromLine(recorded())!;
    const b = { ...a, ts: a.ts + 2000 }; // the same refusal in a subagent's transcript
    const weekly = { ...a, kind: "seven_day" as const, resetsAt: a.resetsAt! + 86_400_000 };
    expect(dedupeHits([b, a, weekly])).toEqual([a, weekly]);
    const text = { ...a, source: "text" as const, resetsAt: null, ts: a.ts - 1000 };
    const textLater = { ...text, ts: text.ts + 60_000 };
    expect(dedupeHits([text, textLater])).toHaveLength(1);
  });
});

describe("loadLimitHits", () => {
  let root: string;
  let projects: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "tpd-limits-"));
    projects = path.join(root, "projects");
    mkdirSync(path.join(projects, "-home-dev-app", "s1", "subagents"), { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", timestamp: at, message: { content: "secret prompt" } }),
      JSON.stringify(recorded()),
      "{ not json",
    ];
    writeFileSync(path.join(projects, "-home-dev-app", "s1.jsonl"), lines.join("\n") + "\n");
    writeFileSync(
      path.join(projects, "-home-dev-app", "s1", "subagents", "agent-1.jsonl"),
      JSON.stringify(recorded({ isSidechain: true, timestamp: "2026-10-08T18:00:01.000Z" })) + "\n",
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads every transcript once, dedupes across them, and keeps hits only (never text)", async () => {
    const home = path.join(root, "home");
    const dirs = { "claude-code": [projects], codex: [] };
    const hits = await loadLimitHits({ dirs, home });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("five_hour");
    expect(await readLimitHits(path.join(projects, "-home-dev-app", "s1.jsonl"))).toHaveLength(1);

    // the second run is served from the cache, which holds no text
    const again = await loadLimitHits({ dirs, home });
    expect(again).toEqual(hits);
    const cached = readdirSync(path.join(home, LIMITS_DIR)).map((f) =>
      readFileSync(path.join(home, LIMITS_DIR, f), "utf8"),
    );
    expect(cached).toHaveLength(2);
    for (const c of cached) {
      expect(c).not.toContain("secret prompt");
      expect(c).not.toContain("placeholder");
    }
    // `since` drops older hits
    expect(await loadLimitHits({ dirs, home, since: T + 1 })).toEqual([]);
  });
});
