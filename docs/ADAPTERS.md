# Scraper adapters

`api/scrape.js` ships with parsers for the ATS platforms (applicant tracking
systems) most large companies use. Each `config/targets.json` entry picks one
via its `parser` field.

## Identifying which parser to use

Look at the career page's URL:

| URL pattern | Parser | Notes |
|---|---|---|
| `jobs.lever.co/<company>` | `lever` | Public HTML, no API needed |
| `boards.greenhouse.io/<company>` | `greenhouse` | Public HTML, no API needed |
| `<company>.wd1.myworkdayjobs.com/...` (or `wd2`, `wd3`, `wd5`...) | `workday` | Uses Workday's JSON API directly — bypasses bot protection |
| `amazon.jobs/...` | `amazon` | Amazon's specific job-tile HTML structure |
| anything else | `generic` | Regex-based HTML title extraction — works on most plain career pages |

If you don't recognize the pattern, start with `generic` and run
`GET /api/scrape?dry=1`. If it returns 0 roles for a company with known
openings, view the page source (`curl <url>` or browser devtools) and check:
does the page render job titles server-side, or does it need JavaScript to
populate the list? The `generic` parser only sees server-rendered HTML — if
the page is a client-side SPA that fetches jobs via its own API, you'll need
a bespoke parser (see below) that hits that API directly, the way `workday`,
`amazon`, and the Microsoft/Meta functions in `scrape.js` do.

## Workday targets need two things

```json
{
  "company": "Acme Corp",
  "sector": "Big Tech",
  "url": "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/AcmeExternalCareerSite/jobs",
  "baseUrl": "https://acme.wd1.myworkdayjobs.com/en-US/AcmeExternalCareerSite",
  "parser": "workday"
}
```

- `url` — the JSON API endpoint. Find it by opening the career page's
  network tab and looking for a POST to `/wday/cxs/.../jobs`.
- `baseUrl` — used to build full job links from the `externalPath` each job
  posting returns.

Optional Workday fields: `workdayFacets` (location filters — find the facet
IDs by opening the career page's network tab, applying a location filter in
the UI, and inspecting the `appliedFacets` payload of the resulting POST
request), `workdayLimit` (default 20, Workday's per-page max),
`workdayMaxPages` (default 1 — raise it if you need more than 20 results and
don't mind slower scrapes).

## Writing a bespoke parser (company-specific API, like Microsoft/Meta)

Some companies (Microsoft, Meta, Richemont in the shipped example) expose an
internal search API instead of server-rendered HTML or a Workday-style
public API. For these, `scrape.js` has a dedicated `scrape<Company>()`
function (`scrapeMicrosoftAPI`, `scrapeMetaGraphQL`, `scrapeRichemont`) that:

1. Calls the company's internal API directly (found via browser devtools →
   Network tab while searching their career page)
2. Maps the response into `{ company, sector, role, location, score, url }`
   using the shared `scoreRole()` function
3. Is wired into `scrapeTarget()` via a `parser` value matching its name

To add one: copy the shape of `scrapeMicrosoftAPI`, add a branch in
`scrapeTarget()` for your new `parser` value, and reference it in
`config/targets.json`. These are the most fragile parsers — they break if
the company changes their internal API — so the scraper tracks consecutive
fetch failures per company (`josh:scrape:errors` in KV) so you can spot when
one needs fixing.

## The scoring rubric is separate from parsing

Every parser calls the same `scoreRole(title, description, location, company)`
function, which reads its weights from `config/rubric.json`. Parsers only
need to extract `{ title, description, location }` correctly — scoring logic
lives in one place. See `config/rubric.json`'s inline `_comment` fields for
what each section controls, especially `geography.allowed` (the hard-reject
location filter — the single most common reason a real role you know exists
scores 0).
