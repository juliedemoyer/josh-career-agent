# Signals

Scraping only finds jobs that have already been posted. By then the shortlist
is often half-formed, and at senior level the best conversations start before
anything reaches a careers page.

So the pending queue holds two different kinds of thing.

| | Vacancy | Signal |
|---|---|---|
| What it is | A posting that exists right now | An opportunity inferred from a market event |
| Where it came from | The scraper | Reasoning over news, your network, or the scraper's own history |
| Carries | A role title and a url | A headline, a thesis, and evidence |
| The action | Add to pipeline, then apply | Research, reach out, or watch |
| In the dashboard | Champagne card, "+ Add" | Sage card, "Signal · …" chip, "Watch" |

## The rule that makes this safe

An agent that can infer opportunities can also invent them. A card reading
"Pernod Ricard — Chief Data Officer" with no posting behind it is a
hallucinated vacancy, and one of those destroys trust in everything else on
the screen.

So a signal is structurally incapable of looking like a posting:

- **A signal may never carry a job title.** `add_to_pending` overwrites the
  `role` field with `No posting yet — watching`. What actually happened goes
  in `headline`; what you infer from it goes in `thesis`. The two stay
  visibly separate in the UI.
- **A signal must cite evidence.** At least one item with a real `https://`
  url that the agent actually fetched. Signals arriving without one are
  rejected by the tool handler.

Both rules live in `api/agent.js`, not in the prompt. A model that ignores
its instructions still cannot put an unsourced claim in front of you.

## The seven signal types

| Type | The event | Why it matters |
|---|---|---|
| `leadership_change` | A senior leader arrives or departs | The classic musical chairs. Either the seat reopens, or the successor rebuilds the team beneath them. The highest-value signal in an executive search |
| `org_change` | A restructure, a new division, a new market | New boxes on an org chart need people in them |
| `funding_growth` | A raise, an acquisition, an expansion | Money arrives before headcount does |
| `strategy_signal` | An earnings call or strategy day names data/AI as a priority | Budget typically precedes hiring by a couple of quarters |
| `warm_path` | Someone in your network moves into a decision-making seat at a target | No posting needed. This is a conversation, not an application |
| `repost` | A role you already saw is posted again | Their search failed or stalled, which is the best moment to approach |
| `seasonal` | This company opened a comparable role at this time last year | Weak on its own, useful as a tiebreaker for where to spend outreach |

`repost` and `seasonal` need no external source at all: they fall out of the
scraper's own history, which is already in KV. They cost nothing extra to
compute.

## Scoring

The rubric in `config/rubric.json` scores job titles, and a signal has none,
so signals get their own 0 to 100 priority:

```
company fit      0-40   sector and geography match from your rubric
signal strength  0-30   by type — leadership_change scores highest, seasonal lowest
warm path        0-20   do you already know someone there
recency          0-10   decays over the signal's life
```

Signals expire after 60 days. A leadership change from eight months ago is
history, not a lead.

## Generating them

Signals reach the queue through the same `add_to_pending` tool the agent
already uses, so any of these works:

- **Interactively.** Ask Claude Code to check what changed at your target
  companies this week and log what it finds. Cheapest way to start, and the
  best way to tune what a useful signal looks like for your search.
- **On a schedule.** A cron endpoint that walks a list of sources you control
  (company newsrooms, press release feeds, an RSS list) with the agent's
  `fetch_url` tool, and logs anything matching the taxonomy above.
  Configured sources rather than open web search is deliberate: every signal
  traces back to a source you chose, which is auditable and cheap.
- **From your own data.** `repost` and `seasonal` are pure functions of the
  scrape history already in KV.

The scheduled generator is not in this repo yet. The data model, the
guardrails, the scoring and the UI are, so a working version is a single
endpoint away. See the roadmap in the README.
