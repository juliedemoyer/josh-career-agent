// Warm-path intelligence — LinkedIn 1st-degree connections at target companies.
// Storage: KV key `josh:network` as { canonicalCompany: [{...connection}] }.
//
// POST body { network: {...}, replace: true }  → overwrite the network blob
// GET  ?company=NVIDIA                          → return connections at that company,
//                                                 sorted by seniority rank (high → low)
// GET  (no query)                               → summary: { company: count } map

import { kvGet, kvSet } from './_kv.js';

const NETWORK_KEY = 'josh:network';

// High → low seniority rank. Higher number = more senior = better warm path.
// Order matters: check compound titles (SVP, EVP) before standalone ones (president)
// because "Senior Vice President" contains the substring "president".
function seniorityRank(position) {
  const p = (position || '').toLowerCase();
  if (/\bevp\b|\bexecutive vice president\b/.test(p)) return 90;
  if (/\bsvp\b|\bsenior vice president\b/.test(p)) return 85;
  if (/\bvp\b|\bvice president\b/.test(p)) return 80;
  // Standalone "president" (not vice-president), CEO, founders
  if (/\b(ceo|chief executive|founder|co-founder|cofounder)\b/.test(p)) return 95;
  if (/(^|[^a-z])president\b/.test(p) && !/vice[-\s]?president/.test(p)) return 95;
  // C-level officers (CDO/CTO/CFO/CMO/COO/CIO + "Chief ... Officer")
  if (/\bchief\s+[a-z\s&,]+\s+officer\b|\bcdo\b|\bcto\b|\bcfo\b|\bcmo\b|\bcoo\b|\bcio\b|\bcdio\b|\bcaio\b/.test(p)) return 92;
  if (/\bsenior director\b|\bglobal head\b|\bgroup head\b/.test(p)) return 75;
  if (/\bdirector\b|\bhead of\b/.test(p)) return 70;
  if (/\bprincipal\b|\blead\b/.test(p)) return 55;
  if (/\bsenior\s+manager\b|\bsenior\s+[a-z]+\s+manager\b/.test(p)) return 45;
  if (/\bmanager\b/.test(p)) return 35;
  return 20;
}

// Detect recruiter/HR roles — these are warm-path gold for job search.
function isRecruiterOrHR(position) {
  const p = (position || '').toLowerCase();
  return /\brecruit|talent acquisition|executive search|headhunter|hr\b|human resources|people\s*(team|partner|ops)/.test(p);
}

export default async function handler(req, res) {
  const secret   = process.env.DASHBOARD_SECRET;
  const provided = req.headers['x-dashboard-secret'];
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const body = req.body || {};
    if (!body.network || typeof body.network !== 'object') {
      return res.status(400).json({ error: 'missing network object' });
    }
    // Enrich each contact with seniorityRank + recruiter flag.
    const enriched = {};
    let total = 0;
    for (const [company, contacts] of Object.entries(body.network)) {
      const ranked = (contacts || []).map(c => ({
        ...c,
        seniorityRank: seniorityRank(c.position),
        isRecruiter:   isRecruiterOrHR(c.position),
      })).sort((a, b) => b.seniorityRank - a.seniorityRank);
      enriched[company] = ranked;
      total += ranked.length;
    }
    await kvSet(NETWORK_KEY, enriched);
    return res.status(200).json({
      ok: true,
      companies: Object.keys(enriched).length,
      total,
      summary: Object.fromEntries(Object.entries(enriched).map(([c, arr]) => [c, arr.length])),
    });
  }

  if (req.method === 'GET') {
    const network = (await kvGet(NETWORK_KEY)) || {};
    const company = req.query.company;
    if (!company) {
      // Summary mode
      const summary = Object.fromEntries(
        Object.entries(network).map(([c, arr]) => [c, arr.length])
      );
      const total = Object.values(summary).reduce((a, b) => a + b, 0);
      return res.status(200).json({ total, companies: Object.keys(summary).length, summary });
    }
    // Case-insensitive company lookup
    const key = Object.keys(network).find(k => k.toLowerCase() === company.toLowerCase());
    const contacts = key ? network[key] : [];
    return res.status(200).json({ company: key || company, count: contacts.length, contacts });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
