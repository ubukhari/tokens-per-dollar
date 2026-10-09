---
name: forecast
description: Forecast when this machine's own Codex pace reaches the 5-hour and weekly limits, from the limit readings Codex writes to disk, and what the same pace costs on ChatGPT Plus, Pro, Codex credits and the OpenAI API; plus the Claude Code limit hits its transcripts record, by running tokens-per-dollar forecast on the local logs. Use when the user asks whether they will hit their Codex weekly limit, when it resets, why it seems to keep resetting, whether Plus or Pro covers their week, what Codex usage costs, or how close Claude Code came to its limits.
argument-hint: "[--since 14d] [--json]"
---

# Forecast the week against the limits

tokens-per-dollar (MIT, [source](https://github.com/agentwares/tokens-per-dollar)) reads the limit
readings Codex writes into its session files with every response (the share of the 5-hour and
weekly windows used, when each resets, and the plan), the token counts of this machine's last 14
days, and the refusals Claude Code records when a plan limit stops it. It makes no network calls and
sends nothing anywhere.

Run it with the Bash tool (Claude Code asks the user to approve the command; this skill pre-approves
nothing):

```sh
npx -y --allow-git=root github:agentwares/tokens-per-dollar forecast $ARGUMENTS
```

Then explain it in plain words:

1. **Codex's weekly limit**: how much is used now, when it resets, and when the user's pace reaches
   it, or how full it will be at the reset. Say which figures are **measured** (what Codex wrote)
   and which are **estimates** (the window sized from the readings, and the pace carried forward).
   Never present an estimate as OpenAI's number: OpenAI publishes no limit as a number.
2. **The 5-hour limit** (Plus has one, Pro does not): the window open now, and how the user's
   typical and busiest sessions compare with it.
3. **The plans**: how much of a week the plan Codex reports holds, and what the rest costs at the
   credit rate card; for the plan the user is not on, read back the condition (the multiple of
   their plan's weekly limit it would need), and say OpenAI does not publish it. Codex credits and
   the OpenAI API are priced per token.
4. **Claude Code**: the limit hits the transcripts record, what this machine had used in each
   window, and how many recent sessions reached the least of them. Claude Code writes no
   percentage below a limit, so do not guess how close the user came.
5. **What it cannot see**: Codex's readings and Claude's limits are account-wide, so use on other
   machines, in the cloud, and on the web counts in them, and this machine's files do not.

If the user is about to change plans, suggest they check the vendor's pricing page first. Do not
change any plan or subscription on the user's behalf.
