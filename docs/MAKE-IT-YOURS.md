# Make It Yours

Career switching is a full-time job, and most people have to do it on top of
the job they already have. Josh exists so your few free hours go to
conversations and preparation instead of tracking career pages and drafting
follow-ups. For that to work, it has to know your search as well as you do.

Josh ships configured for a fictional candidate. Before your first real run,
answer the questions below. Every answer maps to one field in `config/`, and
nothing outside `config/` needs editing.

Work through them in order. It takes about 30 minutes, and the quality of
everything Josh does (scoring, briefings, drafts) is a direct function of how
honestly you answer.

## 1. Who are you? → `config/profile.json`

| Question | Field | Example |
|---|---|---|
| What should the agent call you? | `candidateName` | `"Alex Rivera"` |
| What do you want to call the agent? | `agentName` | `"Josh"` (pick your own) |
| What level are you searching at? | `seniorityLevel` | `"Senior executive: CDO / VP Data & AI level"` |
| Which sectors are in scope? | `targetSectors` | `["Luxury", "Beauty", "Retail"]` |
| Where can you work? | `location` | `"Paris, open to London/Europe"` |
| What is the number below which you walk away? | `compensationFloor` | `"€180,000 base"` |
| What are your pipeline stages? | `pipelineStages` | Default five stages work for most searches |
| After how many quiet days is a role stale? | `staleDays` | `14` |

The compensation floor deserves real thought: the agent uses it when
reasoning about negotiation-stage roles, and it never suggests accepting
below it.

## 2. What does a great role look like? → `config/rubric.json`

The scraper scores every job title from 0 to 100 with plain weighted keyword
matching (no LLM call, so scoring 15 career pages daily costs nothing).
Anything scoring below `minScore` (default 60) is discarded before you see it.

Questions to answer, with the shipped weights as a worked example:

**Which titles count as senior enough?**
Seniority is the biggest single component. The defaults give C-suite and VP
titles 25 points (`highPoints`) and Director / Head of / GM titles 15 points
(`midPoints`). If you are searching at Director level, promote those terms
into the `high` list and add Senior Manager terms to `mid`.

**Which titles are an instant no?**
`titleExcludes` hard-rejects a title regardless of other signals. The
defaults reject anything below Director (analyst, specialist, coordinator),
support functions (executive assistant, recruiter), and scraper noise
("skip to content", cookie banners). Tune this first if you see junk in your
pending queue.

**What domain keywords matter to you?**
The example search is a data / AI leadership search, so `aiDataKeywords`
gives 7 points per hit ("ai", "data", "machine learning", "analytics"...)
capped at 20 points (`maxPoints`). Swap these for your own domain: supply
chain, finance, sustainability, whatever your search is about.

**Which sectors fit?**
`sectorKeywords.groups` awards 20 points when the role or company matches
one of your sector groups (luxury, retail, tech, fmcg in the defaults).
Rename the groups and keywords to your own industries.

**Where are you willing to work?**
Geography is a two-tier filter worth up to 15 points: `preferred` cities
score 15, `ok` regions score 8, and anything not in `allowed` is
hard-rejected with a score of 0, no matter how senior the title. This is
the most common reason a role you expected to see never appears, so set
`allowed` generously and `preferred` precisely.

**Do you care about P&L scope?**
`plKeywords` adds up to 10 points for commercial signals ("p&l",
"revenue", "growth", "budget"). Keep it if you are targeting operator
roles, empty the list if you are not.

A worked example with the default weights: "VP Data & Analytics, Paris" at a
luxury company scores 25 (VP) + 14 (two AI/data hits) + 20 (sector) + 15
(preferred city) + 10 (P&L keywords present) = 84. "Data Analyst, Lyon"
scores 0: `analyst` is in `titleExcludes`, and Lyon is not in `allowed`.

## 3. Which companies should it watch? → `config/targets.json`

- Which 10 to 20 companies do you actually want scraped daily? Start from
  `config/companies-universe.json` (a reference list of ~50 large retail and
  consumer companies) or your own shortlist.
- For each: what is the career page URL, and which parser does it need
  (`generic`, `workday`, `greenhouse`, `lever`, or one of the site-specific
  parsers)? Run `npm run add-company` and it will ask you exactly these
  questions. See [ADAPTERS.md](ADAPTERS.md) to identify the parser.
- Keep the dashboard dropdown in `public/app.html` (`SCRAPE_TARGETS`) in
  sync with your final list.
- The dashboard's "Daily scraper targets" popup has an **+ Add company**
  button that shows these same instructions in-app, so you never have to
  remember where the list lives.

## 4. What may the agent do without you? → deployment settings

The approval gate is fixed in code (drafts are never sent, scraped roles land
in a pending queue), but you still choose:

- What time does the daily cron run? Default 07:00 UTC in `vercel.json`.
- Is Gmail/Calendar connected at all? Skipping it is fine: you lose the
  inbox sweep and calendar cross-reference, everything else works.
- Who can see the dashboard? Pick a strong `DASHBOARD_SECRET`; it is the
  only thing between the internet and your pipeline.

## 5. Sanity check

After configuring, run one dry scrape (`/api/scrape?dry=1`) and read the
results before trusting the cron. If the pending queue contains nonsense,
the fix is almost always in `titleExcludes` or `geography.allowed`.
