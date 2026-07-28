/**
 * Career-page scraper — Vercel Serverless Function
 * Runs daily via Vercel Cron (see vercel.json).
 *
 * Scrapes target company career pages (config/targets.json), scores roles
 * against config/rubric.json, and merges new finds into the pending queue
 * in KV.
 *
 * Endpoint: GET /api/scrape
 * Also accepts: GET /api/scrape?dry=1  (scrape but don't push to KV)
 */
import { createRequire } from 'module';
import { kvGet, kvSet } from './_kv.js';
const require = createRequire(import.meta.url);

const { targets: TARGETS } = require('../config/targets.json');
const RUBRIC = require('../config/rubric.json');

const MIN_SCORE = RUBRIC.minScore;

// ── SCORING ─────────────────────────────────────────────────────────────────

function scoreRole(title, description, location, company) {
  const text = `${title} ${description} ${company}`.toLowerCase();
  const tl   = title.toLowerCase();
  const ll   = location.toLowerCase();

  // Hard reject: excluded title patterns
  if (RUBRIC.titleExcludes.some(k => tl.includes(k))) return 0;

  let score = 0;

  // Seniority
  if (RUBRIC.seniority.high.some(k => tl.includes(k)))      score += RUBRIC.seniority.highPoints;
  else if (RUBRIC.seniority.mid.some(k => tl.includes(k)))  score += RUBRIC.seniority.midPoints;
  else return 0;  // not senior enough — hard reject

  // AI/Data centrality
  const aiHits = RUBRIC.aiDataKeywords.keywords.filter(k => tl.includes(k)).length;
  score += Math.min(aiHits * RUBRIC.aiDataKeywords.pointsPerHit, RUBRIC.aiDataKeywords.maxPoints);

  // Sector fit
  for (const kws of Object.values(RUBRIC.sectorKeywords.groups)) {
    if (kws.some(k => text.includes(k))) { score += RUBRIC.sectorKeywords.points; break; }
  }

  // Geography — HARD REJECT if not in allowlist
  const geo = RUBRIC.geography;
  if (!geo.allowed.some(k => ll.includes(k))) return 0;
  score += geo.preferred.some(k => ll.includes(k)) ? geo.preferredPoints : geo.okPoints;

  // P&L / commercial scope
  if (RUBRIC.plKeywords.keywords.some(k => text.includes(k))) score += RUBRIC.plKeywords.points;

  // Company ambition — always, since we only scrape target companies
  score += RUBRIC.companyAmbitionPoints;

  return Math.min(score, 100);
}

function extractLocation(text) {
  const lower = (text || "").toLowerCase();
  for (const city of RUBRIC.geography.cities) {
    if (lower.includes(city.toLowerCase())) return city;
  }
  return "";  // no fallback — empty string fails the geography allowlist
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── HTML FETCHING & PARSING ─────────────────────────────────────────────────
// We use regex-based extraction rather than a DOM parser to keep the function
// dependency-free (no cheerio/jsdom needed on Vercel).

async function fetchPage(url) {
  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } catch (e) {
    const status = res?.status ? ` (HTTP ${res.status})` : "";
    console.warn(`Fetch failed: ${url} — ${e.message}${status}`);
    return null;
  }
}

/**
 * Extract text content from HTML tags that commonly hold job titles.
 * Returns array of { text, context, href }.
 */
function extractTitleCandidates(html) {
  const candidates = [];
  const tagRegex = /<(a|h[2-5]|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const attrs = match[2];
    const inner = match[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (inner.length < 10 || inner.length > 120) continue;

    let href = "";
    const hrefMatch = attrs.match(/href=["']([^"']+)["']/);
    if (hrefMatch) href = hrefMatch[1];

    const start = Math.max(0, match.index - 150);
    const end   = Math.min(html.length, match.index + match[0].length + 150);
    const context = html.slice(start, end).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

    candidates.push({ text: inner, context, href });
  }
  return candidates;
}

// ── PARSERS ─────────────────────────────────────────────────────────────────

function parseGeneric(html, company, sector, exclude = []) {
  const excludeLower = exclude.map(e => e.toLowerCase());
  const candidates = extractTitleCandidates(html);
  const roles = [];
  const seen = new Set();

  for (const { text, context, href } of candidates) {
    const tl = text.toLowerCase();

    if (text.includes("@") || tl.startsWith("skip to")) continue;
    if (excludeLower.some(ex => tl.includes(ex))) continue;
    if (RUBRIC.titleExcludes.some(ex => tl.includes(ex))) continue;

    const isSenior    = [...RUBRIC.seniority.high, ...RUBRIC.seniority.mid].some(k => tl.includes(k));
    const hasAiData   = RUBRIC.aiDataKeywords.keywords.some(k => tl.includes(k));
    const hasCommerce = RUBRIC.commercialKeywords.some(k => tl.includes(k));

    if (!(isSenior && (hasAiData || hasCommerce))) continue;
    if (seen.has(text)) continue;
    seen.add(text);

    const loc = extractLocation(context);
    const sc  = scoreRole(text, context, loc, company);

    if (sc >= MIN_SCORE) {
      roles.push({
        company, sector, role: text, location: loc, score: sc,
        url: href && href.startsWith("http") ? href : "",
      });
    }
  }
  return roles.slice(0, 5);
}

function parseLever(html, company, sector) {
  const roles = [];
  const postingRegex = /<div[^>]*class="[^"]*posting[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match;
  while ((match = postingRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<h5[^>]*>([\s\S]*?)<\/h5>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

    const locMatch = block.match(/class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\//i);
    const loc = locMatch ? locMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const hrefMatch = block.match(/href="([^"]*apply)"/i);
    const href = hrefMatch ? hrefMatch[1] : "";

    const sc = scoreRole(title, "", loc, company);
    if (sc >= MIN_SCORE) {
      roles.push({ company, sector, role: title, location: loc || extractLocation(block), score: sc, url: href });
    }
  }
  return roles;
}

function parseGreenhouse(html, company, sector) {
  const roles = [];
  const openingRegex = /<div[^>]*class="[^"]*opening[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let match;
  while ((match = openingRegex.exec(html)) !== null) {
    const block = match[1];
    const linkMatch = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const href  = linkMatch[1];
    const title = linkMatch[2].replace(/<[^>]+>/g, "").trim();

    const locMatch = block.match(/class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\//i);
    const loc = locMatch ? locMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const sc = scoreRole(title, "", loc, company);
    if (sc >= MIN_SCORE) {
      roles.push({ company, sector, role: title, location: loc || extractLocation(block), score: sc, url: href });
    }
  }
  return roles;
}

function parseAmazon(html, company, sector) {
  const roles = [];
  const cardRegex = /<div[^>]*class="[^"]*job-tile[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<h3[^>]*class="[^"]*job-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
    if (!titleMatch) continue;
    const title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

    const locMatch = block.match(/class="[^"]*location[^"]*"[^>]*>([\s\S]*?)<\//i);
    const loc = locMatch ? locMatch[1].replace(/<[^>]+>/g, "").trim() : "";

    const sc = scoreRole(title, "", loc, company);
    if (sc >= MIN_SCORE) {
      roles.push({ company, sector, role: title, location: loc || "Europe", score: sc, url: "" });
    }
  }
  return roles;
}

// ── WORKDAY API ──────────────────────────────────────────────────────────────
// Workday career sites serve their postings from a public, unauthenticated
// JSON endpoint (the same one the career page itself calls in the browser).
// Using it is more reliable and lighter on their servers than parsing HTML.
// POST to the /wday/cxs/[tenant]/[site]/jobs endpoint.

async function fetchWorkday(apiUrl, { searchText = "", appliedFacets = {}, limit = 20, maxPages = 1 } = {}) {
  const aggregated = { total: 0, jobPostings: [] };
  for (let page = 0; page < maxPages; page++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": UA,
        },
        body: JSON.stringify({ limit, offset: page * limit, searchText, appliedFacets }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      aggregated.total = data.total || aggregated.total;
      const batch = data.jobPostings || [];
      aggregated.jobPostings.push(...batch);
      if (batch.length < limit) break;
    } catch(e) {
      console.warn(`Workday fetch failed (page ${page}): ${apiUrl} — ${e.message}`);
      if (page === 0) return null;
      break;
    }
  }
  return aggregated;
}

function parseWorkday(data, company, sector, baseUrl) {
  if (!data || !Array.isArray(data.jobPostings)) return [];
  const roles = [];
  for (const job of data.jobPostings) {
    const title = (job.title || "").trim();
    // Workday sometimes returns generic "4 Locations" for multi-posted jobs.
    // Fall back to extracting country/city from externalPath so scoreRole's
    // geography allowlist has something to match against.
    let loc = job.locationsText || "";
    if (!loc || /^\d+\s+Locations?$/i.test(loc)) {
      const m = (job.externalPath || "").match(/\/job\/([^/]+)/);
      if (m) loc = m[1].replace(/-/g, " ");
    }
    if (!loc) loc = "Europe";
    const href = job.externalPath ? `${baseUrl}${job.externalPath}` : "";
    const sc   = scoreRole(title, loc, loc, company);
    if (sc >= MIN_SCORE) {
      roles.push({ company, sector, role: title, location: loc, score: sc, url: href });
    }
  }
  return roles.slice(0, 5);
}

const PARSERS = {
  generic:    parseGeneric,
  lever:      parseLever,
  greenhouse: parseGreenhouse,
  amazon:     parseAmazon,
};

// ── KV KEYS ──────────────────────────────────────────────────────────────────

const PENDING_KEY   = "josh:pending";
const DISMISSED_KEY = "josh:dismissed";
const ERRORS_KEY    = "josh:scrape:errors";

// ── MERGE LOGIC ─────────────────────────────────────────────────────────────

function mergeRoles(existing, newRoles, dismissed) {
  const existingKeys = new Set(existing.map(r => `${r.company}::${r.role}`.toLowerCase()));
  const dismissedSet = new Set((dismissed || []).map(d => typeof d === "string" ? d : `${d.company}::${d.role}`.toLowerCase()));
  let added = 0;
  const now = Date.now();

  for (const role of newRoles) {
    const fingerprint = `${role.company}::${role.role}`.toLowerCase();
    if (dismissedSet.has(fingerprint)) continue;
    if (existingKeys.has(fingerprint)) continue;

    role.id        = `p_${now}_${added}`;
    role.source    = "Scraper — career page";
    role.scrapedAt = now;
    existing.push(role);
    existingKeys.add(fingerprint);
    added++;
  }

  return { merged: existing, added };
}

// ── VERCEL CONFIG ───────────────────────────────────────────────────────────
// Max duration: 60s on Hobby plan (default is 10s)
export const config = { maxDuration: 60 };

// ── MICROSOFT CAREERS JSON API ───────────────────────────────────────────────
// Microsoft has no public career-page HTML scrape target, so it uses their
// search API directly. If you don't need Microsoft, delete this target from
// config/targets.json and this function becomes dead code (harmless).

async function scrapeMicrosoftAPI(company, sector) {
  const keywords = [
    "director data AI", "VP data AI", "head of AI", "head of data",
    "chief data officer", "chief AI officer", "chief digital officer",
  ];
  const roles = [];
  const seen = new Set();

  for (const q of keywords) {
    const url = new URL("https://gcsservices.careers.microsoft.com/search/api/v1/search");
    url.searchParams.set("q", q);
    url.searchParams.set("lc", "en_us");
    url.searchParams.set("pgSz", "20");

    let res;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);
      res = await fetch(url.toString(), {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (!res.ok) {
        console.warn(`Microsoft API "${q}": HTTP ${res.status} ${res.statusText}`);
        continue;
      }

      const data = await res.json();
      const jobs = data?.operationResult?.result?.jobs ?? [];

      for (const job of jobs) {
        const title = job.title || "";
        const loc   = job.primaryLocation || "Europe";
        const href  = job.jobId ? `https://careers.microsoft.com/us/en/job/${job.jobId}` : "";

        if (seen.has(title)) continue;
        seen.add(title);

        const sc = scoreRole(title, job.description || "", loc, company);
        if (sc >= MIN_SCORE) {
          roles.push({ company, sector, role: title, location: extractLocation(loc) || loc, score: sc, url: href });
        }
      }
    } catch (e) {
      const status = res?.status ? ` (HTTP ${res.status})` : "";
      console.warn(`Microsoft API error "${q}": ${e.message}${status}`);
    }
  }

  return roles.slice(0, 10);
}

// ── META GRAPHQL API ─────────────────────────────────────────────────────────

async function scrapeMetaGraphQL(company, sector) {
  const searches = [
    { q: "director data AI", leadership_levels: ["Director"] },
    { q: "VP data AI",        leadership_levels: ["Vice President"] },
    { q: "chief data",        leadership_levels: ["Executive"] },
  ];
  const roles = [];
  const seen = new Set();

  for (const params of searches) {
    const variables = {
      search_input: {
        q: params.q,
        divisions: [],
        offices: [],
        roles: [],
        leadership_levels: params.leadership_levels,
        saved_jobs: false,
        results_per_page: 25,
        page: 1,
      },
    };

    let res;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);

      const body = new URLSearchParams({
        variables: JSON.stringify(variables),
        doc_id: "7439712166116425",  // SearchJobsQuery — update if Meta redeploys
      });

      res = await fetch("https://www.metacareers.com/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          "Accept": "application/json",
          "X-FB-Friendly-Name": "CareersJobSearchResultsQuery",
        },
        body: body.toString(),
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (!res.ok) {
        console.warn(`Meta GraphQL "${params.q}": HTTP ${res.status} ${res.statusText}`);
        continue;
      }

      const data = await res.json();
      if (data.errors?.length) {
        console.warn(`Meta GraphQL "${params.q}": ${JSON.stringify(data.errors[0])}`);
        continue;
      }

      const jobs = data?.data?.job_search?.jobs ?? [];

      for (const job of jobs) {
        const title = job.title || "";
        const city  = job.locations?.[0]?.city || "Europe";
        const href  = job.url || (job.id ? `https://www.metacareers.com/jobs/${job.id}/` : "");

        if (seen.has(title)) continue;
        seen.add(title);

        const sc = scoreRole(title, job.sub_title || "", city, company);
        if (sc >= MIN_SCORE) {
          roles.push({ company, sector, role: title, location: extractLocation(city) || city, score: sc, url: href });
        }
      }
    } catch (e) {
      const status = res?.status ? ` (HTTP ${res.status})` : "";
      console.warn(`Meta GraphQL error "${params.q}": ${e.message}${status}`);
    }
  }

  return roles.slice(0, 10);
}

// ── RICHEMONT / CARTIER (SAP SuccessFactors API + HTML fallback) ─────────────
// Kept as a reference implementation for a "brand under a group" scrape
// pattern (SuccessFactors API first, HTML fallback, brand-name filter).

async function scrapeRichemont(company, sector, brand = null) {
  const params = new URLSearchParams({ domain: "richemont.com", start: "0", num: "100", locale: "en_GB" });
  const apiUrl = `https://careers.richemont.com/api/apply/v2/jobs?${params}`;

  let res;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    res = await fetch(apiUrl, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (res.ok) {
      const data = await res.json();
      const allJobs = data?.jobs ?? data?.results ?? [];
      console.log(`Richemont SF API (${company}): HTTP ${res.status}, ${allJobs.length} jobs found`);

      const roles = [];
      const seen = new Set();
      for (const job of allJobs) {
        const title = job.title || job.name || "";
        const jobBrand = (job.company || job.department || job.division || "").toLowerCase();

        if (brand && !jobBrand.includes(brand) && !title.toLowerCase().includes(brand)) continue;

        const loc  = job.location?.city || job.primaryLocation || job.country || "Europe";
        const href = job.url || job.jobDetailUrl || "";

        if (seen.has(title)) continue;
        seen.add(title);

        const sc = scoreRole(title, job.description || "", loc, company);
        if (sc >= MIN_SCORE) {
          roles.push({ company, sector, role: title, location: extractLocation(loc) || loc, score: sc, url: href });
        }
      }
      return roles.slice(0, 10);
    }

    console.warn(`Richemont SF API (${company}): HTTP ${res.status} ${res.statusText} — trying HTML fallback`);
  } catch (e) {
    const status = res?.status ? ` (HTTP ${res.status})` : "";
    console.warn(`Richemont SF API error (${company}): ${e.message}${status} — trying HTML fallback`);
  }

  const htmlUrl = brand
    ? `https://careers.richemont.com/en/jobs/${brand}/`
    : "https://careers.richemont.com/en/jobs/";

  let htmlRes;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15000);
    htmlRes = await fetch(htmlUrl, {
      headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(tid);

    console.log(`Richemont HTML (${company}): HTTP ${htmlRes.status}`);
    if (!htmlRes.ok) {
      console.warn(`Richemont HTML (${company}): HTTP ${htmlRes.status} ${htmlRes.statusText}`);
      return [];
    }
    const html = await htmlRes.text();
    return parseGeneric(html, company, sector);
  } catch (e) {
    const status = htmlRes?.status ? ` (HTTP ${htmlRes.status})` : "";
    console.warn(`Richemont HTML error (${company}): ${e.message}${status}`);
    return [];
  }
}

// ── SCRAPE ONE TARGET ───────────────────────────────────────────────────────

async function scrapeTarget(target) {
  if (target.parser === "microsoft") {
    const roles = await scrapeMicrosoftAPI(target.company, target.sector);
    return { company: target.company, roles, error: roles.length === 0 ? "API returned no matching roles" : null };
  }

  if (target.parser === "meta") {
    const roles = await scrapeMetaGraphQL(target.company, target.sector);
    return { company: target.company, roles, error: null };
  }

  if (target.parser === "richemont") {
    const roles = await scrapeRichemont(target.company, target.sector, target.brand);
    return { company: target.company, roles, error: null };
  }

  // Workday targets use a JSON API rather than HTML scraping
  if (target.parser === "workday") {
    const data = await fetchWorkday(target.url, {
      searchText: target.workdaySearchText || "",
      appliedFacets: target.workdayFacets || {},
      limit: target.workdayLimit || 20,
      maxPages: target.workdayMaxPages || 1,
    });
    if (!data) return { company: target.company, roles: [], error: "fetch failed" };
    const roles = parseWorkday(data, target.company, target.sector, target.baseUrl || "");
    return { company: target.company, roles, error: null };
  }

  const html = await fetchPage(target.url);
  if (!html) return { company: target.company, roles: [], error: "fetch failed — see logs for HTTP status" };

  const parserFn = PARSERS[target.parser] || parseGeneric;
  const roles = target.parser === "generic"
    ? parserFn(html, target.company, target.sector, target.exclude || [])
    : parserFn(html, target.company, target.sector);

  return { company: target.company, roles, error: null };
}

// ── MAIN HANDLER ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth — accept either:
  //   1. Vercel cron header:  Authorization: Bearer $CRON_SECRET
  //   2. Manual trigger:      x-dashboard-secret: $DASHBOARD_SECRET
  const cronSecret      = process.env.CRON_SECRET;
  const dashSecret      = process.env.DASHBOARD_SECRET;
  const authHeader      = req.headers['authorization'] || '';
  const dashHeader      = req.headers['x-dashboard-secret'] || '';
  const cronOk  = cronSecret  && authHeader === `Bearer ${cronSecret}`;
  const dashOk  = dashSecret  && dashHeader === dashSecret;
  if (!cronOk && !dashOk) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dry = req.query.dry === "1";
  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  log(`=== Scraper starting (${new Date().toISOString()}) — ${TARGETS.length} targets ===`);

  const results = await Promise.allSettled(TARGETS.map(t => scrapeTarget(t)));

  const allFound = [];
  const fetchErrors = [];
  for (let i = 0; i < results.length; i++) {
    const company = TARGETS[i].company;
    if (results[i].status === "rejected") {
      log(`  ${company}: error — ${results[i].reason}`);
      fetchErrors.push({ company, error: String(results[i].reason) });
      continue;
    }
    const { roles, error } = results[i].value;
    if (error) {
      log(`  ${company}: ${error}`);
      if (/fetch failed|HTTP \d|timeout|aborted/i.test(error)) {
        fetchErrors.push({ company, error });
      }
      continue;
    }

    if (roles.length > 0) {
      log(`  ${company}: ${roles.length} role(s) found ≥ ${MIN_SCORE}`);
      for (const r of roles) log(`    [${r.score}] ${r.role} — ${r.location}`);
    } else {
      log(`  ${company}: no matching roles`);
    }
    allFound.push(...roles);
  }

  // Track repeated fetch failures so you can spot blind spots (e.g. a company
  // redesigned their career page and the parser stopped matching anything).
  if (!dry) {
    const prev = (await kvGet(ERRORS_KEY)) || {};
    const next = {};
    const failedNow = new Set(fetchErrors.map(e => e.company));
    for (const { company, error } of fetchErrors) {
      const prior = prev[company] || { consecutiveFailures: 0, firstFailedAt: null };
      next[company] = {
        consecutiveFailures: (prior.consecutiveFailures || 0) + 1,
        firstFailedAt:       prior.firstFailedAt || new Date().toISOString(),
        lastFailedAt:        new Date().toISOString(),
        lastError:           error,
      };
    }
    for (const [company, entry] of Object.entries(prev)) {
      if (!failedNow.has(company) && !TARGETS.some(t => t.company === company)) {
        next[company] = entry;
      }
    }
    await kvSet(ERRORS_KEY, next);
    if (fetchErrors.length > 0) {
      log(`Recorded ${fetchErrors.length} fetch error(s) to ${ERRORS_KEY}`);
    }
  }

  let existing  = (await kvGet(PENDING_KEY)) || [];
  let dismissed = (await kvGet(DISMISSED_KEY)) || [];
  const { merged, added } = mergeRoles(existing, allFound, dismissed);

  if (!dry) {
    await Promise.all([
      kvSet(PENDING_KEY, merged),
      kvSet("josh:lastScrape", Date.now()),
    ]);
    log(`Saved ${merged.length} pending roles to KV (${added} new)`);
  } else {
    log(`[DRY RUN] Would save ${merged.length} pending roles (${added} new)`);
  }

  log(`=== Done. ${allFound.length} scraped, ${added} new, ${merged.length} total ===`);

  return res.status(200).json({
    ok: true,
    scraped:  allFound.length,
    added,
    total:    merged.length,
    newRoles: allFound,
    logs,
  });
}
