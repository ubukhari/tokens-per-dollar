# Changelog

## 0.2.0 (2026-10-08)

Codex first.

- `npx --allow-git=root github:agentwares/tokens-per-dollar forecast`: from the limit readings Codex writes with every response and
  this machine's last 14 days, when your pace reaches the weekly limit (or how full it will be when
  it resets) and the 5-hour window open now; your typical and busiest 5-hour sessions against the
  5-hour limit; how much of your week the plan Codex reports holds, the rest at the credit rate
  card; for a plan you are not on, the multiple of your plan's weekly limit it would need, since
  OpenAI publishes neither; Codex credits and the OpenAI API from the same comparison. Every
  projection is labelled an estimate, every reading measured.
- Claude Code's side of the forecast is what its transcripts record: each time a plan limit refused
  a request (from 2.1.255 the `quotaLimits` field, before that the message shown), what this machine
  had used in that window at API list prices, and how many recent sessions reached the least of
  them. Hits are kept per transcript in `~/.tokens-per-dollar/limits-v1`, never their text.
- `forecast demo` runs it on seatledger's synthetic history with Codex weekly readings and Claude
  Code refusals added in their real formats.
- The forecast ends with one line about seatledger Team (13 months of every developer's history,
  rate-change email, $49 a month for up to 10 developers), with `?ref=tokens-per-dollar`; not with
  `--json`, `--quiet`, `TPD_QUIET=1` or in the demo. `TPD_TZ` sets the zone its times are printed in.
- A second plugin skill, `/tokens-per-dollar:forecast`.

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
