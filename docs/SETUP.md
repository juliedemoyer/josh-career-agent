# Setup

Full walkthrough from zero to a running deployment. Should take ~20 minutes
without Gmail/Calendar, ~45 minutes with.

## 1. Prerequisites

- A [Vercel](https://vercel.com) account (Hobby plan works)
- An [Anthropic API key](https://console.anthropic.com/settings/keys)
- Node 18+ locally (only needed for `npm run add-company`)

## 2. Fork and deploy

1. Fork this repo.
2. In Vercel: **Add New Project** → import your fork.
3. Deploy once with defaults — it will build fine but most routes will 401
   until you set env vars in step 4.

## 3. Add a KV store

Vercel Project → **Storage** tab → **Create Database** → **KV** (Upstash Redis
under the hood). Connect it to your project — Vercel auto-injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN`. Nothing else to configure.

## 4. Set required environment variables

Project → **Settings** → **Environment Variables**:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `DASHBOARD_SECRET` | any long random string — this is your dashboard password |
| `CRON_SECRET` | any long random string — lets Vercel Cron trigger `/api/scrape` without your dashboard secret |

Redeploy after adding these (Vercel → Deployments → ⋯ → Redeploy).

## 5. Edit your config — this is the actual setup

Everything that makes this *your* job search lives in `config/`, not in code:

- **`config/profile.json`** — your name, seniority level, target sectors,
  location, comp floor, pipeline stages. Edit every field.
- **`config/targets.json`** — companies to scrape. Ships with 15 real
  examples from a retail/consumer-brands search (luxury, beauty, mass
  retail, FMCG, sports, e-commerce). Delete what you don't want, or run
  `npm run add-company` to add more (see below).
- **`config/rubric.json`** — the scoring rubric. The defaults assume a senior
  (Director+) AI/data candidate open to Paris/London/NYC/Hong Kong/remote.
  Change `geography.allowed` first — that's the hard-reject filter.

Commit and push. Vercel redeploys automatically on push to your default
branch.

## 6. Open the dashboard

Visit your Vercel deployment URL. You'll be asked for `DASHBOARD_SECRET`.
It's stored in `localStorage` after first entry.

## 7. Test the scraper without waiting for the cron

```
GET https://<your-deployment>.vercel.app/api/scrape?dry=1
Header: x-dashboard-secret: <your DASHBOARD_SECRET>
```

`dry=1` scrapes and scores but doesn't write to KV. Check the `logs` array
in the response — you'll see per-company hit counts and any fetch errors.
Drop `?dry=1` once you're happy with the results.

## 8. (Optional) Gmail + Calendar

Skip this entirely if you're happy running the dashboard + scraper without
email/calendar automation — everything in steps 1–7 works standalone.

1. Google Cloud Console → new project (or reuse one) → enable **Gmail API**
   and **Google Calendar API**.
2. **OAuth consent screen** → External → add yourself as a test user (or
   publish if you want, but test mode is fine for personal use).
3. **Credentials** → Create OAuth client ID → Web application.
   - Authorized redirect URI: `https://<your-deployment>.vercel.app/api/gmail?action=callback`
4. Set env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REDIRECT_URI` (matching the redirect URI above exactly).
5. Redeploy, open the dashboard, click **Connect Gmail** — this triggers the
   OAuth consent flow and stores tokens in KV.
6. That's enough for the daily morning-scan cron (`/api/gmail`, POST, runs at
   07:00 UTC) to work. For **real-time** email triggers instead of daily
   polling, also set up Pub/Sub push notifications:
   - Enable **Cloud Pub/Sub API**.
   - Create a topic (any name, e.g. `job-search-gmail-watch`) and set
     `GOOGLE_PUBSUB_TOPIC` to match if you didn't use the default.
   - Grant publish rights on the topic to
     `serviceAccount:gmail-api-push@system.gserviceaccount.com`.
   - Create a push subscription pointed at
     `https://<your-deployment>.vercel.app/api/gmail-webhook`.
   - Set `GOOGLE_PUBSUB_PROJECT_ID` and (recommended) `GOOGLE_PUBSUB_TOKEN`
     (add `?token=<that value>` to the subscription's push endpoint URL).
   - Call `GET /api/gmail-webhook?action=register` once to start the watch.
     Vercel Cron renews it weekly (`?action=renew-watch`).

## 9. (Optional) Sprint board integration

If you already run a task board with a compatible `POST /api/tasks` endpoint,
set `SPRINT_BOARD_URL` and the agent's `post_sprint_task` tool will use it.
Leave unset and it's a harmless no-op.

## Adding a company to the scraper

```
npm run add-company
```

Interactive — asks for company name, sector, career page URL, and which
parser to use (generic HTML, Lever, Greenhouse, or Workday). Appends to
`config/targets.json`. Commit and push to deploy it.

If you're not sure which parser: pick **Generic** and run
`GET /api/scrape?dry=1` — if it finds 0 roles for a company you know has
open positions, check `docs/ADAPTERS.md` for how to identify the right
parser from the career page's URL pattern or by inspecting the page source.

## Cost

Every agent run logs token usage to KV (`josh:token_log`), visible on the
dashboard's cost tab. Rough monthly estimate with default cron frequency
(daily scrape, daily morning scan, daily pipeline monitor) on Claude Sonnet:
**$3–8/month** depending on pipeline size and email volume. The scraper
itself makes no Claude API calls — only the agent-driven flows do.
