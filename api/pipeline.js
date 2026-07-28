import { kvGet, kvSet } from './_kv.js';

const ROLES_KEY      = 'josh:roles';
const PENDING_KEY    = 'josh:pending';
const DISMISSED_KEY  = 'josh:dismissed';
const BRIEFING_KEY   = 'josh:briefing';
const SKIPS_KEY      = 'josh:skips';
const ACTIVITY_KEY   = 'josh:activity';
const TOKEN_LOG_KEY  = 'josh:token_log';

// First-run seed data — shown once, on the very first GET, if KV is empty.
// All companies below are fictional. Replace with your own roles, or just
// clear them from the dashboard once the scraper starts populating `pending`.
const INIT_ROLES = [
  { id: 1, company: 'Maison Delacroix',  role: 'Chief Data Officer',     sector: 'Luxury', location: 'Paris',  stage: 'Interview Prep', score: 91, lastContact: '2026-06-28', nextAction: '2026-07-10', actionNote: 'Round 3 with COO scheduled — prep brief drafted, review before Thursday.', source: 'Recruiter' },
  { id: 2, company: 'Nordlys Group',     role: 'VP Data & AI',           sector: 'Retail', location: 'London', stage: 'Phone Screen',   score: 84, lastContact: '2026-07-01', nextAction: '2026-07-08', actionNote: 'Screen with Head of Talent done — awaiting hiring manager slot.', source: 'Josh scraper' },
  { id: 3, company: 'Atelier Verde',     role: 'Global Head of AI',      sector: 'Beauty', location: 'Paris',  stage: 'Applied',        score: 78, lastContact: '2026-06-30', nextAction: '2026-07-14', actionNote: 'Application in via referral — follow-up draft ready if no reply by the 14th.', source: 'Word of mouth' },
  { id: 4, company: 'Casa Solana Foods', role: 'Chief Digital Officer',  sector: 'FMCG',   location: 'Remote', stage: 'Prospecting',    score: 72, lastContact: '—',          nextAction: '2026-07-09', actionNote: 'Warm path identified: former colleague is SVP Ops — intro note drafted.', source: 'Josh scraper' },
  { id: 5, company: 'Fjord & Field',     role: 'SVP Data, Digital & AI', sector: 'Sports', location: 'Remote', stage: 'Negotiation',    score: 88, lastContact: '2026-07-03', nextAction: '2026-07-07', actionNote: 'Verbal offer received — counter framework prepared, call Monday.', source: 'Recruiter' },
];

const INIT_PENDING = [
  { id: 'p1', company: 'Baltique Maison', role: 'Chief Data & Analytics Officer', sector: 'Luxury', location: 'Paris',  score: 81, source: 'Josh scraper' },
  { id: 'p2', company: 'Verdant Goods',   role: 'VP, Consumer Data & AI',         sector: 'FMCG',   location: 'London', score: 69, source: 'Josh scraper' },
];

export default async function handler(req, res) {
  // CORS — must be set before the auth guard so the browser preflight
  // (which never carries the dashboard secret) gets the right headers back.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-dashboard-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth — every request must carry the dashboard secret
  const secret   = process.env.DASHBOARD_SECRET;
  const provided = req.headers['x-dashboard-secret'];
  if (!secret || provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    let roles     = await kvGet(ROLES_KEY);
    let pending   = await kvGet(PENDING_KEY);
    let dismissed = await kvGet(DISMISSED_KEY);
    const [briefing, activity, tokenLog] = await Promise.all([
      kvGet(BRIEFING_KEY),
      kvGet(ACTIVITY_KEY),
      kvGet(TOKEN_LOG_KEY),
    ]);
    if (!roles || roles.length === 0) { await kvSet(ROLES_KEY,   INIT_ROLES);   roles   = INIT_ROLES;   }
    if (!pending)                     { await kvSet(PENDING_KEY, INIT_PENDING); pending = INIT_PENDING; }
    if (!dismissed) dismissed = [];
    return res.status(200).json({
      roles, pending, dismissed,
      briefing:  briefing  || null,
      activity:  activity  || [],
      tokenLog:  tokenLog  || [],
      // Optional external sprint board (SPRINT_BOARD_URL env var) — the
      // dashboard's cost tab uses it as a fallback token source when the KV
      // token log is empty. Unset = feature hidden.
      sprintBoardUrl: process.env.SPRINT_BOARD_URL || null,
    });
  }

  if (req.method === 'POST') {
    const { roles, pending, dismissed, skip, briefing, activityAppend, tokenLogAppend } = req.body;
    if (roles     !== undefined) await kvSet(ROLES_KEY,     roles);
    if (pending   !== undefined) await kvSet(PENDING_KEY,   pending);
    if (dismissed !== undefined) await kvSet(DISMISSED_KEY, dismissed);
    if (briefing  !== undefined) await kvSet(BRIEFING_KEY,  briefing);
    if (skip      !== undefined) {
      const existing = (await kvGet(SKIPS_KEY)) || [];
      await kvSet(SKIPS_KEY, [...existing.slice(-99), skip]);
    }
    if (activityAppend !== undefined) {
      const existing = (await kvGet(ACTIVITY_KEY)) || [];
      const merged = [...existing, ...activityAppend].slice(-200);
      await kvSet(ACTIVITY_KEY, merged);
    }
    if (tokenLogAppend !== undefined) {
      const existing = (await kvGet(TOKEN_LOG_KEY)) || [];
      const merged = [...existing, ...tokenLogAppend].slice(-500);
      await kvSet(TOKEN_LOG_KEY, merged);
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
