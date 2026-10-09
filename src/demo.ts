/**
 * `tokens-per-dollar demo`: the comparison on seatledger's synthetic history (generated
 * transcripts in the real Claude Code and Codex formats, not anyone's usage), written to a
 * temporary directory and removed afterwards. The README picture and the sample on agentcheck's
 * pages are this output, and tests keep them identical to it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  load,
  planCompare,
  textToSvg as seatledgerSvg,
  writeSyntheticHistory,
  type PlanCompareView,
} from "seatledger";
import { INSTALL } from "./install.js";
import { renderCompare } from "./render.js";

export interface Demo {
  view: PlanCompareView;
  text: string;
  now: number;
}

export async function runDemo(plans?: readonly string[]): Promise<Demo> {
  const dir = mkdtempSync(path.join(tmpdir(), "tokens-per-dollar-demo-"));
  try {
    const synth = writeSyntheticHistory({ dir });
    const loaded = await load({
      dirs: { "claude-code": [synth.claudeDir], codex: [synth.codexDir] },
      cache: false,
      home: path.join(dir, "home"),
    });
    const view = planCompare(loaded, { now: synth.now, ...(plans ? { plans } : {}) });
    return { view, text: renderCompare(view), now: synth.now };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `demo` prints first, so its output is never read as anyone's usage. */
export const SYNTHETIC_LABEL = "Synthetic history, generated for this demo: not anyone's usage.";

/** The README picture: the command and what it printed on synthetic history. */
export function screenshotText(demo: Demo): string {
  return [`$ ${INSTALL} demo`, SYNTHETIC_LABEL, "", demo.text].join("\n").trimEnd();
}

/** seatledger's terminal-style SVG, labelled as this tool's output. */
export function textToSvg(text: string): string {
  return seatledgerSvg(text).replace(
    'aria-label="seatledger output on synthetic history"',
    'aria-label="tokens-per-dollar output on synthetic history"',
  );
}
