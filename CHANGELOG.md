# Changelog

## 0.1.0 (2026-10-08)

First release.

- `npx --allow-git=root github:agentwares/tokens-per-dollar`: this machine's last 30 days of Claude Code and Codex, priced on Claude
  Pro, Max 5x, Max 20x, Team standard and premium, the Anthropic API, ChatGPT Plus and Pro, Codex
  credits, the OpenAI API, and Copilot Pro, Pro+ and Max (an estimate, since Copilot keeps no local
  logs). Prints the cheapest priced plan per client, the margin against another vendor's cheapest,
  the plans that could be cheaper and on what condition, and the last dated vendor change that
  moved the answer.
- Allowances Anthropic and OpenAI do not publish as numbers are never invented. Claude plans show
  their fee and your busiest 5 hours and week at API prices; ChatGPT Plus and Pro are measured from
  Codex's own limit readings for the plan you were on.
- `--since`, `--plans`, `--json`, `demo`. Plan prices, rate cards and vendor changes are one dated,
  sourced table in seatledger, read 8 October 2026.
- One dim line about seatledger's team ledger at most once a day, only on a terminal, never with
  `--json`; `--quiet` or `TPD_QUIET=1` turns it off. Printing it sends nothing.
- Local only: reads transcripts through seatledger's readers, keeps counts (never text) in
  `~/.tokens-per-dollar`, makes no network request and has no telemetry.
- A Claude Code plugin, `/tokens-per-dollar:plans`, that runs the CLI and explains the answer.
