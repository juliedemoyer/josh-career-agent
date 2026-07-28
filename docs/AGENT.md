# How the agent works

`api/agent.js` exports one function, `runAgent(task, context, accessToken,
maxIterations, queryType)`, used by every other function that needs Claude:
the daily morning scan (`api/gmail.js`), the pipeline health check
(`api/pipeline-monitor.js`), and the real-time Gmail webhook
(`api/gmail-webhook.js`).

## The loop

1. Build a system prompt from `config/profile.json` + `config/targets.json`
   (see `buildSystemPrompt()` — nothing here is hardcoded; edit the config
   files, not this function).
2. Send the task + context to Claude with a fixed set of tools (see below).
3. If Claude requests tool calls, execute them (in parallel where possible),
   feed results back, loop.
4. Stop when Claude returns `end_turn`, or after `maxIterations` (default 8)
   as a safety cap.

Every call logs token usage and estimated cost to `josh:token_log` in KV,
tagged by `queryType` (`monitor`, `chat`, `code`, etc.) so the dashboard's
cost tab can break down spend by activity.

## Tools available to the agent

| Tool | What it does |
|---|---|
| `get_pipeline` | Read current roles/pending/dismissed |
| `update_role` | Merge fields into an active role (stage, dates, notes, `joshPrep` artifact chips shown on the Kanban card) |
| `add_to_pending` | Queue a vacancy, or a signal (needs evidence, never gets a job title — see [SIGNALS.md](SIGNALS.md)) |
| `search_gmail` / `get_email` / `star_email` | Read-only + starring, Gmail |
| `create_gmail_draft` | **Never sends** — creates a draft for you to review |
| `get_calendar_events` | Read-only calendar |
| `fetch_url` | Fetch and strip HTML from any public URL (research) |
| `post_sprint_task` | Optional — no-op unless `SPRINT_BOARD_URL` is set |
| `set_briefing` | Writes the text shown on the dashboard's briefing card |
| `write_vault_note` | Writes a markdown note to KV (daily memory) |

## The approval gate

This is the load-bearing design decision: **the agent can read anything, but
it can only write pipeline state and drafts — never send email, never make
irreversible external commitments.** `create_gmail_draft` explicitly does not
send. New roles go to a `pending` queue, not straight into your active
pipeline — you approve or dismiss from the dashboard. This is what makes
"run daily via cron, unattended" a reasonable thing to turn on.

If you extend the tool list, keep this invariant: any tool that acts outside
your own KV store (sends something, posts something publicly, spends money)
should either not exist or should require a human click somewhere before it
takes effect.

## Model and cost notes

- Defaults to `claude-sonnet-4-6` (override with `ANTHROPIC_MODEL`).
- Pricing constants in `agent.js` (`PRICE`) are for Sonnet — update them if
  you switch models, or the cost tracking on the dashboard will be wrong.
- The scraper (`api/scrape.js`) makes zero Claude API calls — scoring is pure
  keyword-matching against `config/rubric.json`. Only the three agent-driven
  flows (morning scan, pipeline monitor, Gmail webhook) cost tokens.
