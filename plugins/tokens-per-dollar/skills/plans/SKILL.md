---
name: plans
description: Explain what this machine's last 30 days of Claude Code and Codex would cost on every coding plan - Claude Pro, Max 5x, Max 20x and Team, the Anthropic and OpenAI APIs, ChatGPT Plus and Pro, Codex credits, and Copilot Pro, Pro+ and Max as an estimate - with the cheapest priced plan, the margin, what an unpublished allowance would have to hold, and the dated vendor change that last moved the answer, by running tokens-per-dollar on the local transcripts. Use when the user asks whether Claude Max is worth it versus the API, which plan is cheapest for their usage, what Codex credits or Copilot AI credits come to, or whether a limit change affects them.
argument-hint: "[--since 30d] [--plans claude,codex,copilot]"
---

# Explain what this month costs on each plan

tokens-per-dollar (MIT, [source](https://github.com/agentwares/tokens-per-dollar)) reads this
machine's Claude Code and Codex transcripts, takes the token counts and prices them on each coding plan from the vendors' own dated
prices. It makes no network calls and sends nothing anywhere.

Run it with the Bash tool (Claude Code asks the user to approve the command; this skill pre-approves
nothing):

```sh
npx -y --allow-git=root github:agentwares/tokens-per-dollar $ARGUMENTS
```

Then explain it in plain words:

1. **The answer, per client**: the cheapest priced plan, what a month like this one costs on it,
   and the margin against the cheapest plan from another vendor. Say what kind of figure it is:
   priced from published rates, measured from Codex's own limit readings, or an estimate (every
   Copilot row: Copilot keeps no local logs and its agent would not use exactly these tokens).
2. **Plans with "from"**: Anthropic publishes Claude plan allowances only as multiples of Pro per
   5-hour session plus a weekly limit, with no token or dollar figure; OpenAI publishes none for a
   Codex plan the user was not on. Read back the condition: the fee alone carries the month if the
   allowance holds the busiest 5 hours and busiest week shown, at API prices. Past the allowance,
   extra usage is billed at API rates (Claude) or credits (Codex). Do not guess an allowance, and do
   not present an estimate as the vendor's number.
3. **The change that moved the answer**: its date and what changed, in the output's own words.
   Say what changed, never why a vendor did it.
4. **What it cannot see**: use on other machines, and Claude on the web and desktop, which shares a
   Claude plan's allowance. Codex's readings are account-wide.

The prices are dated (the last line says when they were read). If the user is about to change plans,
suggest they check the vendor's pricing page first. Do not change any plan or subscription on the
user's behalf.
