# tokens-per-dollar

What this machine's last 30 days of Claude Code and Codex would cost on every coding plan, explained
inside Claude Code.

- `/tokens-per-dollar:plans` runs `npx -y --allow-git=root github:agentwares/tokens-per-dollar` (with your arguments, such
  as `--since 90d` or `--plans claude,copilot`) and explains the answer: the cheapest priced plan for
  each client, the margin, what an allowance the vendor does not publish would have to hold for a
  flat plan to carry your month, and the dated vendor change that last moved the answer.

## What it runs, reads and sends

- **Runs** one command, through the Bash tool. The skill pre-approves nothing, so Claude Code asks
  you before the command runs.
- **Fetches** tokens-per-dollar with `npx`, from where that command names, and its one dependency,
  `seatledger`, from the npm registry.
- **Reads** this machine's Claude Code transcripts (`~/.claude/projects`) and Codex rollouts
  (`~/.codex/sessions`), and keeps counts, never text, in `~/.tokens-per-dollar`.
- **Sends nothing.** The command makes no network request, has no telemetry and needs no account.

Plan prices come from the vendors' own pages, each with the date it was read. Copilot figures are
estimates: Copilot keeps no local logs.

Source, the full CLI and its documentation: [github.com/agentwares/tokens-per-dollar](https://github.com/agentwares/tokens-per-dollar).
MIT licensed, by agentwares.
