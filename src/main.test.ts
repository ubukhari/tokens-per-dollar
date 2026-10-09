import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeSyntheticHistory, type PlanCompareView } from "seatledger";
import { HINT, SEATLEDGER_URL } from "./hint.js";
import { main, type Io } from "./main.js";

let root: string;
let synth: ReturnType<typeof writeSyntheticHistory>;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "tpd-main-"));
  synth = writeSyntheticHistory({ dir: path.join(root, "src") });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function io(tty = false) {
  let out = "";
  let err = "";
  const sink: Io = {
    out: { write: (s: string) => ((out += s), true), isTTY: tty },
    err: { write: (s: string) => ((err += s), true) },
  };
  return { sink, out: () => out, err: () => err };
}

let homeN = 0;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  TPD_HOME: path.join(root, `home-${++homeN}`),
  TPD_NOW: new Date(synth.now).toISOString(),
  NO_COLOR: "1",
  ...extra,
});
const dirs = () => ["--claude-dir", synth.claudeDir, "--codex-dir", synth.codexDir];

describe("tokens-per-dollar", () => {
  it("--help and --version", async () => {
    const h = io();
    expect(await main(["--help"], h.sink, env())).toBe(0);
    expect(h.out()).toContain("--since 30d|12w|2026-09-01");
    expect(h.out()).toContain("--plans <list>");
    expect(h.out()).toContain("makes no network request");
    const v = io();
    expect(await main(["-v"], v.sink, env())).toBe(0);
    expect(v.out().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prices this machine's last 30 days, per client, with the answer and the change that moved it", async () => {
    const r = io();
    expect(await main(dirs(), r.sink, env())).toBe(0);
    const text = r.out();
    expect(text).toContain(
      "7 Sep – 7 Oct 2026 · read from this machine's transcripts; nothing was sent",
    );
    expect(text).toMatch(/^Claude Code: 2,313 requests/m);
    expect(text).toMatch(/^Codex: 628 requests/m);
    expect(text).toContain("Cheapest priced: Copilot Max");
    expect(text).toContain("Cheapest priced: ChatGPT Plus, $20.00 a month (measured)");
    expect(text).toContain("Last vendor change that moved this answer: 1 Jun 2026, GitHub.");
    expect(text).toContain("Plan prices read 8 Oct 2026");
    // never a project folder, a path or anything from the transcripts beyond counts and model ids
    for (const s of ["webapp", "api-server", "infra", root, "/home/dev"])
      expect(text).not.toContain(s);
  });

  it("--json is the view seatledger_plan_compare returns, with sources, and no seatledger line", async () => {
    const r = io(true);
    expect(await main([...dirs(), "--json"], r.sink, env())).toBe(0);
    const v = JSON.parse(r.out()) as PlanCompareView;
    expect(v.view).toBe("plan_compare");
    expect(v.sources.plans.length).toBe(13);
    expect(r.out()).not.toContain("seatledger?ref=");
    for (const s of ["webapp", "api-server", "infra"]) expect(r.out()).not.toContain(`"${s}"`);
  });

  it("--plans narrows by id or group; an unknown plan is a usage error", async () => {
    const r = io();
    expect(await main([...dirs(), "--json", "--plans", "codex,copilot-max"], r.sink, env())).toBe(
      0,
    );
    const v = JSON.parse(r.out()) as PlanCompareView;
    expect(v.plansCompared).toEqual([
      "openai-api",
      "chatgpt-plus",
      "chatgpt-pro",
      "codex-credits",
      "copilot-max",
    ]);
    const bad = io();
    expect(await main([...dirs(), "--plans", "claude-ultra"], bad.sink, env())).toBe(2);
    expect(bad.err()).toMatch(/--plans: unknown plan "claude-ultra"/);
  });

  it("--since takes a span or a date and scales to a month; anything else is a usage error", async () => {
    const r = io();
    expect(await main([...dirs(), "--json", "--since", "10d"], r.sink, env())).toBe(0);
    const v = JSON.parse(r.out()) as PlanCompareView;
    expect(v.period.days).toBeGreaterThan(9);
    expect(v.period.days).toBeLessThan(10);
    expect(v.notes.join(" ")).toMatch(/scaled from 9\.\d days to a 30-day month/);
    const bad = io();
    expect(await main([...dirs(), "--since", "last week"], bad.sink, env())).toBe(2);
    expect(bad.err()).toMatch(/--since takes/);
    const extra = io();
    expect(await main(["report"], extra.sink, env())).toBe(2);
  });

  it("says so when there is nothing in range", async () => {
    const empty = mkdtempSync(path.join(root, "empty-"));
    const r = io(true);
    expect(await main(["--claude-dir", empty, "--codex-dir", empty], r.sink, env())).toBe(0);
    expect(r.out()).toContain("No Claude Code or Codex requests in this range on this machine.");
    expect(r.out()).not.toContain(SEATLEDGER_URL);
  });

  it("demo runs on synthetic history, says so first, and needs no transcripts", async () => {
    const r = io(true);
    expect(await main(["demo"], r.sink, env())).toBe(0);
    expect(r.out().split("\n")[0]).toBe(
      "Synthetic history, generated for this demo: not anyone's usage.",
    );
    expect(r.out()).not.toContain(SEATLEDGER_URL);
  });
});

describe("the seatledger line", () => {
  it("is the last line on a terminal, once a day, with ?ref=tokens-per-dollar", async () => {
    const e = env();
    const first = io(true);
    await main(dirs(), first.sink, e);
    const lines = first.out().trimEnd().split("\n");
    expect(lines.at(-1)).toBe(HINT);
    expect(HINT).toContain(
      "https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar",
    );
    const again = io(true);
    await main(dirs(), again.sink, e);
    expect(again.out()).not.toContain(SEATLEDGER_URL);
    const tomorrow = io(true);
    await main(dirs(), tomorrow.sink, {
      ...e,
      TPD_NOW: new Date(synth.now + 86_400_000).toISOString(),
    });
    expect(tomorrow.out()).toContain(SEATLEDGER_URL);
  });

  it("never off a terminal, with --quiet, with TPD_QUIET=1 or in --json", async () => {
    for (const [args, extra, tty] of [
      [dirs(), {}, false],
      [[...dirs(), "--quiet"], {}, true],
      [dirs(), { TPD_QUIET: "1" }, true],
      [[...dirs(), "--json"], {}, true],
    ] as const) {
      const r = io(tty);
      await main([...args], r.sink, env(extra));
      expect(r.out()).not.toContain(SEATLEDGER_URL);
    }
  });
});

describe("local only", () => {
  it("makes no request: a run with fetch removed completes", async () => {
    const spy = vi.fn(() => {
      throw new Error("tokens-per-dollar must not make a request");
    });
    vi.stubGlobal("fetch", spy);
    try {
      const r = io(true);
      expect(await main(dirs(), r.sink, env())).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("no source file reaches for the network", () => {
    const dir = new URL("./", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toMatch(
        /\bfetch\(|node:https?|node:net|node:dgram|XMLHttpRequest|WebSocket/,
      );
    }
  });
});
