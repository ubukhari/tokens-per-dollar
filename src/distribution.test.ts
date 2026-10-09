/**
 * The files that put tokens-per-dollar where people already are: the package, the README and its
 * picture, the CHANGELOG, the repo-root files the sync copies from `distribution/root` (the Claude
 * Code plugin marketplace), the seatledger line's claims against seatledger's plans, and the data
 * agentcheck's /tokens-per-dollar pages render. The public repo has the root files at its root and
 * no agentcheck or packages/config, so those checks run in the monorepo only.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CODEX_CREDIT,
  CODEX_CREDIT_RATES,
  COPILOT_RATES_USD,
  PLAN_CHANGES,
  PLANS,
  PRICE_SOURCES,
  priceFor,
} from "seatledger";
import { runDemo, screenshotText, SYNTHETIC_LABEL, textToSvg, type Demo } from "./demo.js";
import { HINT, SEATLEDGER_URL } from "./hint.js";
import { INSTALL, ON_NPM, REPO, RUN } from "./install.js";
import { calendarDay } from "./render.js";

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const pkg = json<{
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  files: string[];
  bin: Record<string, string>;
  homepage: string;
}>("package.json");

let demo: Demo;
beforeAll(async () => {
  demo = await runDemo();
});

describe("package", () => {
  it("depends on seatledger and nothing else", () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["seatledger"]);
  });

  it("ships the CLI and the files the README points at", () => {
    expect(pkg.name).toBe("tokens-per-dollar");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.bin).toEqual({ "tokens-per-dollar": "./dist/cli.js" });
    expect(pkg.files).toEqual(expect.arrayContaining(["dist", "README.md", "CHANGELOG.md"]));
    expect(pkg.homepage).toBe("https://agentwares-agentcheck.vercel.app/tokens-per-dollar");
  });

  it("CHANGELOG has a section for this version", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} `, "m"),
    );
  });
});

describe("README", () => {
  const readme = read("README.md");

  it("leads with the one-line use and the picture, labelled synthetic", () => {
    expect(readme).toContain("```sh\n" + INSTALL + "\n```");
    expect(readme).toContain("docs/screenshot.svg");
    expect(readme).toMatch(/synthetic history\s+generated for the demo, not anyone's usage/);
  });

  it("the picture is the CLI's real output on synthetic history (run `pnpm screenshot` after changing it)", () => {
    const shot = screenshotText(demo);
    expect(shot.split("\n")[1]).toBe(SYNTHETIC_LABEL);
    if (process.env["TPD_WRITE_INSTALL"])
      writeFileSync(here("docs/screenshot.svg"), textToSvg(shot));
    expect(read("docs/screenshot.svg")).toBe(textToSvg(shot));
    expect(read("docs/screenshot.svg")).toContain('aria-label="tokens-per-dollar output');
  });

  it("names every plan id, every dated vendor change and every source it prices from", () => {
    for (const p of PLANS) expect(readme).toContain(`\`${p.id}\``);
    for (const c of PLAN_CHANGES) expect(readme, c.date).toContain(`| ${calendarDay(c.date)} `);
    for (const url of new Set(PLANS.flatMap((p) => p.sources.map((s) => s.url))))
      expect(readme, url).toContain(url);
    for (const s of CODEX_CREDIT.sources) expect(readme, s.url).toContain(s.url);
  });

  it("says which figures are estimates, measured or derived, and that nothing is sent", () => {
    expect(readme).toContain("**an estimate**");
    expect(readme).toContain("**measured**");
    expect(readme).toContain("$0.04 a credit (derived)");
    expect(readme).toContain("never invents one");
    expect(readme).toContain("**Sends nothing.**");
  });
});

describe("the seatledger line", () => {
  it("links seatledger with ?ref=tokens-per-dollar, which seatledger's pages record", () => {
    expect(SEATLEDGER_URL).toBe(
      "https://agentwares-agentcheck.vercel.app/seatledger?ref=tokens-per-dollar",
    );
    expect(HINT.endsWith(SEATLEDGER_URL)).toBe(true);
    const ref = here("../agentcheck/src/app/seatledger/_lib/ref.ts");
    if (existsSync(ref)) expect(readFileSync(ref, "utf8")).toMatch(/"tokens-per-dollar"/);
  });

  const products = here("../../packages/config/src/products.ts");
  it.skipIf(!existsSync(products))(
    "claims only what seatledger's plans serve today (pricing.json is built from them)",
    async () => {
      const { SEATLEDGER_TIERS } = (await import(/* @vite-ignore */ products.href)) as {
        SEATLEDGER_TIERS: Record<
          string,
          { priceUsdMonthly: number; limits: { quantity: number }; features: readonly string[] }
        >;
      };
      const free = SEATLEDGER_TIERS.free!;
      const team = SEATLEDGER_TIERS.team!;
      expect(HINT).toContain(`free for up to ${free.limits.quantity} developers`);
      expect(free.priceUsdMonthly).toBe(0);
      expect(free.features).toEqual(expect.arrayContaining(["team_ledger", "rate_findings"]));
      expect(HINT).toContain(`email alerts on Team, $${team.priceUsdMonthly}/month`);
      expect(team.features).toContain("email_alerts");
      expect(free.features).not.toContain("email_alerts");
    },
  );
});

const root = "distribution/root";
const frontmatter = (text: string): Record<string, string> =>
  Object.fromEntries(
    (text.split("---")[1] ?? "")
      .split("\n")
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!.replace(/^"|"$/g, "")]),
  );

describe.skipIf(!existsSync(here(root)))("repo-root files (distribution/root)", () => {
  it("the marketplace's plugin resolves, and its version matches this package", () => {
    const marketplace = json<{
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    }>(`${root}/.claude-plugin/marketplace.json`);
    // agentguard's marketplace is "agentwares" and seatledger's "seatledger"
    expect(marketplace.name).toBe("tokens-per-dollar");
    expect(marketplace.owner.name).toBe("agentwares");
    expect(marketplace.plugins).toHaveLength(1);
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      const plugin = json<{ name: string; version: string }>(
        `${root}/${entry.source.slice(2)}/.claude-plugin/plugin.json`,
      );
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(pkg.version);
    }
  });

  it("plugin.json links the page, the docs, the repository, privacy, terms and support", () => {
    const plugin = json<Record<string, string>>(
      `${root}/plugins/tokens-per-dollar/.claude-plugin/plugin.json`,
    );
    expect(plugin.homepage).toBe(pkg.homepage);
    expect(plugin.documentationUrl).toBe("https://github.com/agentwares/tokens-per-dollar#readme");
    expect(plugin.repository).toBe("https://github.com/agentwares/tokens-per-dollar");
    for (const k of ["privacyPolicyUrl", "termsOfServiceUrl", "supportUrl"])
      expect(plugin[k]).toMatch(/^https:\/\/agentwares/);
    expect(plugin.license).toBe("MIT");
  });

  it("the one skill, plans, runs the published CLI", () => {
    expect(readdirSync(here(`${root}/plugins/tokens-per-dollar/skills`))).toEqual(["plans"]);
    const text = read(`${root}/plugins/tokens-per-dollar/skills/plans/SKILL.md`);
    const front = frontmatter(text);
    expect(front.name).toBe("plans");
    expect(front.description!.length).toBeGreaterThan(80);
    expect(front.description!.length).toBeLessThanOrEqual(1024);
    expect(text).toContain(`${RUN} $ARGUMENTS`);
    expect(text).toContain("never why");
  });

  it("no skill or manifest pre-approves a tool: Claude Code asks before every command", () => {
    const walk = (dir: string): string[] =>
      readdirSync(here(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`],
      );
    const files = walk(`${root}/plugins`);
    for (const f of files.filter((x) => x.endsWith(".md"))) {
      const text = read(f);
      const front = text.startsWith("---") ? (text.split("---")[1] ?? "") : "";
      expect(front, f).not.toMatch(/^\s*(allowed-tools|allowedTools)\s*:/m);
    }
    for (const f of [
      ...files.filter((x) => x.endsWith(".json")),
      `${root}/.claude-plugin/marketplace.json`,
    ])
      expect(read(f), f).not.toMatch(/allowed-?tools/i);
  });

  it("the listing icon is a 1024 px square PNG drawn from distribution/icon.svg (`pnpm icon`)", () => {
    const plugin = json<{ icon?: string }>(
      `${root}/plugins/tokens-per-dollar/.claude-plugin/plugin.json`,
    );
    expect(plugin.icon).toBe("./.claude-plugin/icon.png");
    const file = `${root}/plugins/tokens-per-dollar/${plugin.icon!.slice(2)}`;
    const png = readFileSync(here(file));
    expect(statSync(here(file)).size).toBeLessThan(2 * 1024 * 1024);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    const key = "tokens-per-dollar-icon-source-sha256\0";
    const at = png.indexOf(key, 0, "latin1");
    expect(at, "icon.png carries no source hash: run `pnpm icon`").toBeGreaterThan(0);
    const drawnFrom = png.subarray(at + key.length, at + key.length + 64).toString("latin1");
    const svg = createHash("sha256").update(read("distribution/icon.svg")).digest("hex");
    expect(drawnFrom, "distribution/icon.svg changed: run `pnpm icon`").toBe(svg);
  });

  it("the plugin folder has the README the directory lists it by, naming what it runs", () => {
    const readme = read(`${root}/plugins/tokens-per-dollar/README.md`);
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40);
    expect(readme).toContain(RUN);
    expect(readme).toContain("pre-approves nothing");
    expect(readme).not.toMatch(/`[^`]*\.png[^`]*`/);
  });
});

/**
 * agentcheck's /tokens-per-dollar pages render seatledger's plan table and this CLI's demo output
 * from one generated file, so a page can never show a price the CLI does not use. To regenerate:
 *
 *   TPD_WRITE_DATA=1 pnpm --filter tokens-per-dollar exec vitest run src/distribution
 *   pnpm exec prettier --write apps/agentcheck/src/app/tokens-per-dollar/_data.ts
 */
const DATA = here("../agentcheck/src/app/tokens-per-dollar/_data.ts");
/** The models whose API list prices the pages quote. */
const PAGE_MODELS = [
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-4-5",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
];
describe.skipIf(!existsSync(DATA) && !process.env["TPD_WRITE_DATA"])(
  "the data on agentcheck's /tokens-per-dollar pages",
  () => {
    it("is seatledger's plan table and what the `demo` command prints", async () => {
      const lines = [SYNTHETIC_LABEL, "", ...demo.text.split("\n")];
      const asOf = new Date(demo.now).toISOString().slice(0, 10);
      const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
      const want = {
        SAMPLE_AS_OF: asOf,
        SAMPLE_LINES: lines,
        PLANS: plain(PLANS),
        PLAN_CHANGES: plain(PLAN_CHANGES),
        CODEX_CREDIT: plain(CODEX_CREDIT),
        CODEX_CREDIT_RATES: plain(CODEX_CREDIT_RATES),
        COPILOT_RATES_USD: plain(COPILOT_RATES_USD),
        API_PRICES: plain(
          Object.fromEntries(
            PAGE_MODELS.map((m) => {
              const p = priceFor(m)!;
              return [
                m,
                {
                  input: p.input,
                  cachedInput: p.cacheRead,
                  cacheWrite: p.cacheWrite,
                  output: p.output,
                },
              ];
            }),
          ),
        ),
        API_PRICE_SOURCES: plain(PRICE_SOURCES),
      };
      if (process.env["TPD_WRITE_DATA"])
        writeFileSync(
          DATA,
          [
            "/**",
            " * seatledger's dated plan table and the tokens-per-dollar CLI's real output on synthetic",
            " * history (its `demo` command: generated transcripts, not anyone's usage).",
            " * Written by apps/tokens-per-dollar-cli/src/distribution.test.ts, which fails when either",
            " * changes and this file does not. Do not edit by hand.",
            " */",
            'import type { Cited, DataPlan, DataPlanChange, Rates } from "./_types";',
            "",
            `export const SAMPLE_AS_OF = ${JSON.stringify(want.SAMPLE_AS_OF)};`,
            `export const SAMPLE_LINES: readonly string[] = ${JSON.stringify(want.SAMPLE_LINES)};`,
            `export const PLANS: readonly DataPlan[] = ${JSON.stringify(want.PLANS)};`,
            `export const PLAN_CHANGES: readonly DataPlanChange[] = ${JSON.stringify(want.PLAN_CHANGES)};`,
            `export const CODEX_CREDIT: { usd: number; derived: boolean; how: string; sources: readonly Cited[] } = ${JSON.stringify(want.CODEX_CREDIT)};`,
            `export const CODEX_CREDIT_RATES: Readonly<Record<string, Rates>> = ${JSON.stringify(want.CODEX_CREDIT_RATES)};`,
            `export const COPILOT_RATES_USD: Readonly<Record<string, Rates>> = ${JSON.stringify(want.COPILOT_RATES_USD)};`,
            "/** API list prices per million tokens for the models the pages name (5-minute cache writes). */",
            `export const API_PRICES: Readonly<Record<string, Rates>> = ${JSON.stringify(want.API_PRICES)};`,
            `export const API_PRICE_SOURCES: readonly { provider: string; url: string; read: string }[] = ${JSON.stringify(want.API_PRICE_SOURCES)};`,
            "",
          ].join("\n"),
        );
      const data = (await import(/* @vite-ignore */ DATA.href)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(want)) expect(plain(data[k]), k).toEqual(v);
    });
  },
);

/**
 * One install command (src/install.ts), everywhere it is shown. Any form of it found elsewhere must
 * be INSTALL, or RUN where an agent runs it unattended; code and agentcheck's pages import it rather
 * than spell it. After flipping ON_NPM, rewrite the files that cannot import it:
 *
 *   TPD_WRITE_INSTALL=1 pnpm --filter tokens-per-dollar exec vitest run src/distribution
 *
 * which also redraws docs/screenshot.svg and the mirror agentcheck's pages import.
 */
const COMMAND =
  /npx (?:-{1,2}[\w-]+(?:=[\w-]+)? )*(?:github:agentwares\/)?tokens-per-dollar(?:@latest)?(?![\w./-])/g;
const WRITE = Boolean(process.env["TPD_WRITE_INSTALL"]);
const forms = (text: string): string[] => [...text.matchAll(COMMAND)].map((m) => m[0]);
const walk = (rel: string): string[] =>
  !existsSync(here(rel))
    ? []
    : statSync(here(rel)).isFile()
      ? [rel]
      : readdirSync(here(rel), { withFileTypes: true })
          .filter((e) => !["node_modules", "dist", ".next"].includes(e.name))
          .flatMap((e) => walk(`${rel}/${e.name}`));

/** Re-pad the `# comments` of a shell block that names the command, so its columns line up. */
function realign(text: string): string {
  return text.replace(/```sh\n([\s\S]*?)```/g, (block, body: string) => {
    if (forms(body).length === 0) return block;
    const rows = body.split("\n").map((l) => /^(\S.*?\S)\s{2,}(# .*)$/.exec(l));
    const width = Math.max(0, ...rows.map((m) => (m ? m[1]!.length : 0))) + 2;
    const lines = body.split("\n").map((l, i) => {
      const m = rows[i];
      return m ? m[1]!.padEnd(width) + m[2]! : l;
    });
    return "```sh\n" + lines.join("\n") + "```";
  });
}

describe("the install command", () => {
  it(`is ${INSTALL} while ON_NPM is ${String(ON_NPM)}`, () => {
    expect(INSTALL).toBe(`npx ${ON_NPM ? "" : "--allow-git=root github:agentwares/"}${pkg.name}`);
    expect(RUN).toBe(
      ON_NPM
        ? `npx -y ${pkg.name}@latest`
        : `npx -y --allow-git=root github:agentwares/${pkg.name}`,
    );
    expect(REPO).toBe(`https://github.com/agentwares/${pkg.name}`);
  });

  // README, CHANGELOG and the plugin files in the monorepo; the same files at the root of the
  // public repo, where distribution/root has become the repo root; and, in the monorepo,
  // seatledger's README and CHANGELOG, which point at this CLI
  const docs = [
    "README.md",
    "CHANGELOG.md",
    ...walk("distribution"),
    ...walk(".claude-plugin"),
    ...walk("plugins"),
    ...walk("../seatledger-cli/README.md"),
    ...walk("../seatledger-cli/CHANGELOG.md"),
  ].filter((f) => /\.(md|json)$/.test(f));

  it.each(docs)("%s names only INSTALL or RUN", (file) => {
    const text = read(file);
    if (WRITE) {
      const next = realign(
        text.replace(COMMAND, (m) => (/ (?:-y|--yes) /.test(m) ? RUN : INSTALL)),
      );
      if (next !== text) writeFileSync(here(file), next);
    }
    for (const form of forms(read(file))) expect([INSTALL, RUN], file).toContain(form);
  });

  it("code, scripts and tests import it rather than spell it", () => {
    const files = [...walk("src"), ...walk("scripts")].filter((f) => f !== "src/install.ts");
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect(forms(read(file)), file).toEqual([]);
  });

  it("the README picture shows it", () => {
    expect(screenshotText(demo).split("\n")[0]).toBe(`$ ${INSTALL} demo`);
  });
});

/** agentcheck's pages import a mirror of src/install.ts, written here; nothing there spells it. */
const AGENTCHECK = "../agentcheck/src";
const MIRROR = `${AGENTCHECK}/app/tokens-per-dollar/_install.ts`;
describe.skipIf(!existsSync(here(AGENTCHECK)))("the install command on agentcheck", () => {
  it("the mirror its pages import is src/install.ts", () => {
    const text = [
      "/**",
      " * How to run tokens-per-dollar, mirrored from apps/tokens-per-dollar-cli/src/install.ts, the one constant.",
      " * Written by apps/tokens-per-dollar-cli/src/distribution.test.ts, which fails when the two differ.",
      " */",
      `export const ON_NPM: boolean = ${String(ON_NPM)};`,
      `export const INSTALL = ${JSON.stringify(INSTALL)};`,
      `export const REPO = ${JSON.stringify(REPO)};`,
      "",
    ].join("\n");
    if (WRITE) writeFileSync(here(MIRROR), text);
    expect(read(MIRROR)).toBe(text);
  });

  it("no other agentcheck file spells the command", () => {
    const files = walk(AGENTCHECK).filter((f) => f !== MIRROR && /\.(tsx?|md|txt|json)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(forms(read(file)), file).toEqual([]);
  });
});
