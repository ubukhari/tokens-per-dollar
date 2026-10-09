/**
 * The moments a Claude Code limit stopped you, as the transcript records them. Claude Code writes
 * no percentage of a limit to disk (its `/usage` numbers and the status line's `rate_limits` are
 * never written to a transcript); what it does write, when the API refuses a request because a
 * plan limit is spent, is a client-made assistant line:
 *
 * - `isApiErrorMessage: true`, `error: "rate_limit"`, `message.model: "<synthetic>"`;
 * - from 2.1.255 on, `quotaLimits: { status: "rejected", rateLimitType, resetsAt, overageStatus,
 *   isUsingOverage, … }`, where `rateLimitType` is one of `five_hour`, `seven_day`,
 *   `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`, and `resetsAt`
 *   is in epoch seconds;
 * - before that, only the text the client showed: "Claude AI usage limit reached|<epoch seconds>"
 *   on early versions, then "5-hour limit reached ∙ resets 3pm" and "You've hit your session
 *   limit · resets 3pm (Europe/London)" and their weekly forms.
 *
 * Verified on 8 Oct 2026 against Claude Code 2.1.255–2.1.286 transcripts on a real machine (key
 * names, enum values and counts only) and the 2.1.286 client, whose stream schema lists those
 * `rateLimitType` values. A line's text is matched against the client's own wording and dropped;
 * only the kind of limit, the time and the reset time are kept. The same refusal is written into
 * every session and subagent that was running, so hits are deduplicated by limit and reset time.
 *
 * Kept per transcript by size and modification time under `~/.tokens-per-dollar/limits-v1/`, so a
 * second run reads only what changed, and a hit in a transcript Claude Code has since deleted is
 * kept.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { listSourceFiles, type SourceDirs } from "seatledger";

export const LIMIT_KINDS = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_overage_included",
  "overage",
  "unknown",
] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

/** One refusal Claude Code recorded because a plan limit was spent. */
export interface LimitHit {
  /** Epoch ms of the line. */
  ts: number;
  kind: LimitKind;
  /** Epoch ms the limit resets, when the transcript says; null when only the shown text is there. */
  resetsAt: number | null;
  /** `recorded`: Claude Code's own `quotaLimits` field. `text`: matched from the message it showed. */
  source: "recorded" | "text";
  /** Claude Code version that wrote it, or "". */
  version: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Seconds or milliseconds since the epoch, as ms; undefined for anything else. */
function epochMs(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function textOf(message: Record<string, unknown> | undefined): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => str(obj(b)?.text) ?? "").join("\n");
}

/**
 * The kind of limit the client's shown text names, or undefined when it is not a plan-limit
 * refusal. Only the client's own phrasings are recognised.
 */
export function kindFromText(text: string): { kind: LimitKind; resetsAt?: number } | undefined {
  const head = text.slice(0, 300);
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(head);
  if (legacy) return { kind: "unknown", resetsAt: epochMs(Number(legacy[1])) };
  if (/out of extra usage|extra usage limit|spend limit/i.test(head)) return { kind: "overage" };
  const refused = /limit reached|hit your (?:[a-z0-9-]+ )*limit/i.test(head);
  if (!refused) return undefined;
  if (/\bopus\b/i.test(head) && /weekly/i.test(head)) return { kind: "seven_day_opus" };
  if (/\bsonnet\b/i.test(head) && /weekly/i.test(head)) return { kind: "seven_day_sonnet" };
  if (/weekly/i.test(head)) return { kind: "seven_day" };
  if (/5-hour|five-hour|session limit/i.test(head)) return { kind: "five_hour" };
  return { kind: "unknown" };
}

/** The hit one transcript line records, if it records one. */
export function hitFromLine(line: Record<string, unknown>): LimitHit | undefined {
  if (line.type !== "assistant") return undefined;
  const message = obj(line.message);
  const synthetic = str(message?.model) === "<synthetic>";
  if (line.isApiErrorMessage !== true && !synthetic) return undefined;
  const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(ts)) return undefined;
  const version = str(line.version) ?? "";

  const quota = obj(line.quotaLimits);
  if (quota) {
    if (str(quota.status) !== "rejected") return undefined;
    const type = str(quota.rateLimitType);
    const kind = (LIMIT_KINDS as readonly string[]).includes(type ?? "")
      ? (type as LimitKind)
      : "unknown";
    return { ts, kind, resetsAt: epochMs(quota.resetsAt) ?? null, source: "recorded", version };
  }
  // Older versions: only the text the client showed. A rate_limit error that names no plan limit
  // (the API's own per-minute limits, an overloaded model) is not a hit.
  const found = kindFromText(textOf(message));
  if (!found) return undefined;
  return { ts, kind: found.kind, resetsAt: found.resetsAt ?? null, source: "text", version };
}

/** Every hit in one Claude Code transcript. Streams the file; parses only candidate lines. */
export async function readLimitHits(file: string): Promise<LimitHit[]> {
  const hits: LimitHit[] = [];
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      if (!raw.includes('"isApiErrorMessage":true') && !raw.includes('"<synthetic>"')) continue;
      let value: unknown;
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

/** One refusal per limit and reset: the same one is written into every session that was running. */
export function dedupeHits(hits: readonly LimitHit[]): LimitHit[] {
  const sorted = [...hits].sort((a, b) => a.ts - b.ts);
  const out: LimitHit[] = [];
  const byReset = new Map<string, number>();
  /** The last kept text-only hit of each kind: a refusal is shown in every running session. */
  const lastShown = new Map<LimitKind, number>();
  for (const h of sorted) {
    if (h.resetsAt !== null) {
      const key = `${h.kind}@${Math.round(h.resetsAt / 60_000)}`;
      const at = byReset.get(key);
      if (at !== undefined) {
        // keep the first moment, and the recorded form over the shown text
        if (out[at]!.source === "text" && h.source === "recorded")
          out[at] = { ...h, ts: out[at]!.ts };
        continue;
      }
      byReset.set(key, out.push(h) - 1);
      continue;
    }
    const at = lastShown.get(h.kind);
    if (at !== undefined && h.ts - out[at]!.ts < 30 * 60_000) continue;
    lastShown.set(h.kind, out.push(h) - 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cache: one small file per transcript, hits only
// ---------------------------------------------------------------------------------------------

export const LIMITS_DIR = "limits-v1";

interface Wire {
  v: 1;
  src: string;
  size: number;
  mtimeMs: number;
  /** ts, kind, resetsAt (-1 = not recorded), source (1 = recorded), version */
  h: [number, string, number, 0 | 1, string][];
}

interface Cached {
  src: string;
  size: number;
  mtimeMs: number;
  hits: LimitHit[];
}

const encode = (c: Cached): Wire => ({
  v: 1,
  src: c.src,
  size: c.size,
  mtimeMs: c.mtimeMs,
  h: c.hits.map((x) => [
    x.ts,
    x.kind,
    x.resetsAt ?? -1,
    x.source === "recorded" ? 1 : 0,
    x.version,
  ]),
});

const decode = (w: Wire): Cached => ({
  src: w.src,
  size: w.size,
  mtimeMs: w.mtimeMs,
  hits: w.h.map(([ts, kind, resetsAt, source, version]) => ({
    ts,
    kind: (LIMIT_KINDS as readonly string[]).includes(kind) ? (kind as LimitKind) : "unknown",
    resetsAt: resetsAt < 0 ? null : resetsAt,
    source: source === 1 ? "recorded" : "text",
    version,
  })),
});

function readCache(home: string): Map<string, Cached> {
  const dir = path.join(home, LIMITS_DIR);
  const out = new Map<string, Cached>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const wire = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Wire;
      if (wire.v !== 1 || typeof wire.src !== "string" || !Array.isArray(wire.h)) continue;
      out.set(wire.src, decode(wire));
    } catch {
      // an interrupted write; the transcript is read again
    }
  }
  return out;
}

function writeCache(home: string, entry: Cached): void {
  const dir = path.join(home, LIMITS_DIR);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(
      dir,
      createHash("sha256").update(entry.src).digest("hex").slice(0, 32) + ".json",
    );
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(encode(entry)), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // a cache that cannot be written costs speed, never a report
  }
}

export interface LimitHitOptions {
  dirs: SourceDirs;
  home: string;
  /** Epoch ms: hits before it are dropped, and transcripts last written before it are not read. */
  since?: number;
  cache?: boolean;
}

const under = (file: string, roots: string[]): boolean =>
  roots.some((r) => file === r || file.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

/** Every distinct limit hit in this machine's Claude Code transcripts, oldest first. */
export async function loadLimitHits(opts: LimitHitOptions): Promise<LimitHit[]> {
  const useCache = opts.cache ?? true;
  const cache = useCache ? readCache(opts.home) : new Map<string, Cached>();
  const files = listSourceFiles({ "claude-code": opts.dirs["claude-code"], codex: [] }).filter(
    (f) => f.client === "claude-code",
  );
  const onDisk = new Set(files.map((f) => f.path));
  const all: LimitHit[] = [];
  const toRead: typeof files = [];
  for (const f of files) {
    const hit = cache.get(f.path);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) all.push(...hit.hits);
    else if (opts.since !== undefined && f.mtimeMs < opts.since) {
      if (hit) all.push(...hit.hits);
    } else toRead.push(f);
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < toRead.length) {
      const f = toRead[next++]!;
      let hits: LimitHit[];
      try {
        hits = await readLimitHits(f.path);
      } catch {
        continue; // unreadable: skip, never fail the report
      }
      all.push(...hits);
      if (useCache) writeCache(opts.home, { src: f.path, size: f.size, mtimeMs: f.mtimeMs, hits });
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, toRead.length) }, worker));
  // Hits in transcripts Claude Code has since deleted, kept from the cache.
  for (const [src, entry] of cache) {
    if (onDisk.has(src) || !under(src, opts.dirs["claude-code"])) continue;
    all.push(...entry.hits);
  }
  return dedupeHits(all).filter((h) => opts.since === undefined || h.ts >= opts.since);
}
