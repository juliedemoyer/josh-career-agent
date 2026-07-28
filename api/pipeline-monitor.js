/**
 * Pipeline Monitor — Vercel Serverless Function
 *
 * Runs daily via cron (see vercel.json) to detect:
 *   - Stale roles: no contact in config/profile.json's `staleDays`
 *   - Overdue actions: nextAction date has passed
 *
 * If any are found, triggers the agent to flag them,
 * suggest concrete next steps, and create sprint tasks.
 *
 * Routes:
 *   GET /api/pipeline-monitor   → Manual trigger (dashboard or cron)
 */
import { createRequire } from 'module';
import { runAgent, getValidAccessToken } from './agent.js';
import { kvGet } from './_kv.js';
const require = createRequire(import.meta.url);

const PROFILE = require('../config/profile.json');

// ── Date parsing ──────────────────────────────────────────────────────────────
// Handles formats like: "27 Mar", "1 Apr 2026", "Apr 2026", "Apr", "—", "TBC"
function parseRoleDate(str) {
  if (!str || str === '—' || /tbc|date|follow|confirm/i.test(str)) return null;
  try {
    const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const parts = str.trim().split(/[\s,/]+/).filter(Boolean);

    // "27 Mar" or "27 Mar 2026"
    if (parts.length >= 2 && !isNaN(Number(parts[0]))) {
      const day   = parseInt(parts[0]);
      const month = MONTHS[parts[1]?.toLowerCase().slice(0, 3)];
      const year  = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
      if (month !== undefined) return new Date(year, month, day);
    }

    // "Apr 2026" or "Apr"
    const month = MONTHS[parts[0]?.toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const year = parts[1] ? parseInt(parts[1]) : new Date().getFullYear();
      return new Date(year, month, 1);
    }

    // Native fallback
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function daysUntil(date) {
  if (!date) return null;
  return Math.floor((date.getTime() - Date.now()) / 86_400_000);
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const roles = await kvGet('josh:roles') || [];
  const today = new Date();
  const staleDays = PROFILE.staleDays || 14;

  const staleRoles = [];
  const overdueRoles = [];

  for (const role of roles) {
    // Skip roles in the last pipeline stage — natural pauses are expected
    if (role.stage === PROFILE.pipelineStages[PROFILE.pipelineStages.length - 1]) continue;

    // Check staleness
    const lastContactDate = parseRoleDate(role.lastContact);
    const daysSinceContact = daysSince(lastContactDate);
    if (daysSinceContact !== null && daysSinceContact >= staleDays) {
      staleRoles.push({
        ...role,
        daysSinceContact,
        staleSince: role.lastContact,
      });
    }

    // Check overdue actions
    const nextActionDate = parseRoleDate(role.nextAction);
    const daysOverdue = nextActionDate ? -daysUntil(nextActionDate) : null;
    if (daysOverdue !== null && daysOverdue > 0) {
      overdueRoles.push({
        ...role,
        daysOverdue,
        overdueAction: role.nextAction,
      });
    }
  }

  // Nothing to do
  if (staleRoles.length === 0 && overdueRoles.length === 0) {
    return res.status(200).json({
      ok:      true,
      message: 'No stale or overdue roles — pipeline is healthy.',
      checked: roles.length,
    });
  }

  // Trigger agent
  const accessToken = await getValidAccessToken();

  try {
    await runAgent(
      `Pipeline health check. Review the stale and overdue roles below.
For each stale role: update nextAction to a specific date within the next 7 days and update actionNote with a concrete recommended action (e.g. "Send status-check to recruiter", "Activate LinkedIn warm path").
For each overdue role: update nextAction to a new realistic date and update actionNote.
If a role has been stale for 30+ days with no movement, note it as a candidate to archive — but do NOT remove it.
Create sprint tasks only for roles requiring active outreach (score 70+). Keep sprint tasks concise.`,
      {
        staleRoles:  staleRoles.sort((a, b) => b.score - a.score),
        overdueRoles: overdueRoles.sort((a, b) => b.score - a.score),
        today: today.toISOString().slice(0, 10),
      },
      accessToken,
      6,
      'monitor'
    );
  } catch (err) {
    console.error('Pipeline monitor agent error:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }

  return res.status(200).json({
    ok:      true,
    stale:   staleRoles.length,
    overdue: overdueRoles.length,
    roles:   staleRoles.concat(overdueRoles).map(r => `${r.company} (${r.stage})`),
  });
}
