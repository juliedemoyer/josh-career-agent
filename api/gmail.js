/**
 * Gmail Integration — Vercel Serverless Function
 *
 * Routes:
 *   GET  /api/gmail?action=auth         → returns Google OAuth consent URL
 *   GET  /api/gmail?action=callback     → exchanges code, stores tokens in KV
 *   GET  /api/gmail?action=status       → { connected: true/false }
 *   GET  /api/gmail?action=renew-watch  → renew Gmail Pub/Sub watch (weekly)
 *   POST /api/gmail                     → runs morning scan (called by cron)
 *
 * Required environment variables (set in Vercel dashboard) — see .env.example:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI   e.g. https://<your-deployment>.vercel.app/api/gmail?action=callback
 *   ANTHROPIC_API_KEY
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 */

import { runAgent } from './agent.js';
import { kvGet, kvSet } from './_kv.js';

const TOKENS_KEY   = 'josh:google_tokens';
const ROLES_KEY    = 'josh:roles';
const SKIPS_KEY    = 'josh:skips';

// ── Google OAuth 2.0 ──────────────────────────────────────────────────────────
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',    // read + star emails
  'https://www.googleapis.com/auth/calendar.readonly'
].join(' ');

function getAuthUrl(redirectUri) {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    })
  });
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type:    'refresh_token',
    })
  });
  return res.json();
}

async function getValidAccessToken() {
  const tokens = await kvGet(TOKENS_KEY);
  if (!tokens) return null;
  // Return current token if not expiring within 5 minutes
  if (tokens.expires_at && Date.now() < tokens.expires_at - 300_000) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  if (refreshed.error) { console.error('Token refresh failed:', refreshed.error); return null; }
  await kvSet(TOKENS_KEY, {
    ...tokens,
    access_token: refreshed.access_token,
    expires_at:   Date.now() + (refreshed.expires_in || 3600) * 1000,
  });
  return refreshed.access_token;
}

// ── Gmail API ─────────────────────────────────────────────────────────────────
async function searchEmails(token, query) {
  const params = new URLSearchParams({ q: query, maxResults: 20 });
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.messages || [];
}

async function getEmailDetails(token, id) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
    `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const msg = await res.json();
  const headers = msg.payload?.headers || [];
  const get = name => headers.find(h => h.name === name)?.value || '';
  return {
    id:        msg.id,
    threadId:  msg.threadId,
    subject:   get('Subject'),
    from:      get('From'),
    date:      get('Date'),
    snippet:   (msg.snippet || '').slice(0, 200),
    labelIds:  msg.labelIds || [],
  };
}

// ── Google Calendar API ───────────────────────────────────────────────────────
async function getUpcomingEvents(token) {
  const now      = new Date().toISOString();
  const twoWeeks = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const params = new URLSearchParams({
    timeMin:      now,
    timeMax:      twoWeeks,
    maxResults:   25,
    singleEvents: 'true',
    orderBy:      'startTime',
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return (data.items || []).map(e => ({
    id:          e.id,
    summary:     e.summary || '(no title)',
    start:       e.start?.dateTime || e.start?.date,
    location:    e.location || '',
    description: (e.description || '').slice(0, 200),
  }));
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, code } = req.query || {};

  // Derive redirect URI from the request host so it works on preview deployments too
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = host.includes('localhost') ? 'http' : 'https';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ||
    `${proto}://${host}/api/gmail?action=callback`;

  // ── GET ?action=auth ───────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'auth') {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(200).json({
        error: 'not_configured',
        message: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ANTHROPIC_API_KEY in Vercel project settings.'
      });
    }
    return res.status(200).json({ url: getAuthUrl(redirectUri) });
  }

  // ── GET ?action=callback ───────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'callback') {
    if (!code) return res.status(400).send('Missing code');
    const tokens = await exchangeCode(code, redirectUri);
    if (tokens.error) return res.status(400).send(`OAuth error: ${tokens.error_description || tokens.error}`);
    await kvSet(TOKENS_KEY, {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    });
    // Redirect back to dashboard
    res.setHeader('Location', '/?gmail=connected');
    return res.status(302).end();
  }

  // ── GET ?action=status ─────────────────────────────────────────────────────
  if (req.method === 'GET' && action === 'status') {
    const tokens = await kvGet(TOKENS_KEY);
    return res.status(200).json({ connected: !!tokens });
  }

  // ── GET ?action=renew-watch — renew Gmail Pub/Sub watch (expires every 7 days) ──
  if (req.method === 'GET' && action === 'renew-watch') {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return res.status(200).json({ error: 'Gmail not connected' });
    const projectId = process.env.GOOGLE_PUBSUB_PROJECT_ID;
    if (!projectId) return res.status(200).json({ error: 'GOOGLE_PUBSUB_PROJECT_ID not set — skipping watch renewal' });
    const topic = process.env.GOOGLE_PUBSUB_TOPIC || 'job-search-gmail-watch';
    const watchRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topicName: `projects/${projectId}/topics/${topic}`,
        labelIds:  ['INBOX'],
      })
    });
    const data = await watchRes.json();
    if (data.historyId) {
      await kvSet('josh:gmail_history_id', data.historyId);
    }
    return res.status(200).json(data);
  }

  // ── POST — morning scan (called by Vercel cron at 07:00 UTC) ──────────────
  if (req.method === 'POST') {
    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      return res.status(200).json({
        ok: false,
        error: 'not_authenticated',
        message: 'Gmail not connected. Open the dashboard and click "Connect Gmail".'
      });
    }

    // Load pipeline data and skip history in parallel (passed as context to the agent)
    const [roles, skips] = await Promise.all([
      kvGet(ROLES_KEY),
      kvGet(SKIPS_KEY),
    ]);
    const pipelineRoles = roles || [];

    // Pre-fetch emails and calendar so the agent has immediate context
    // (avoids spending tool-call iterations on basic data gathering)
    const companies = [...new Set(pipelineRoles.map(r => r.company.split(/[\s,]/)[0].toLowerCase()))].slice(0, 8);
    const companyFilter = companies.map(c => `from:*${c}*`).join(' OR ');
    const emailQuery = `newer_than:1d (${companyFilter} OR subject:interview OR subject:offer OR subject:opportunity OR subject:"follow up" OR label:recruiters)`;

    const [emailList, calEvents] = await Promise.all([
      searchEmails(accessToken, emailQuery),
      getUpcomingEvents(accessToken),
    ]);

    const emails = await Promise.all(emailList.slice(0, 15).map(m => getEmailDetails(accessToken, m.id)));
    const recruitKW = ['interview', 'call', 'chat', 'coffee', 'catch up', 'meet', ...companies];
    const relevantEvents = calEvents.filter(e =>
      recruitKW.some(kw => (e.summary + e.description).toLowerCase().includes(kw))
    );

    // Hand off to the agent — it will call tools (update_role, star_email, set_briefing, etc.)
    try {
      await runAgent(
        'Morning scan. You have pre-fetched emails and calendar events in context. Review them against the pipeline. Update stages where evidence is clear (e.g. interview scheduled → Interview Prep). Star priority emails. Draft a reply if an urgent response is clearly needed. Write the morning briefing using set_briefing. Use get_pipeline first to confirm current state before making updates.',
        {
          prefetchedEmails:  emails,
          calendarEvents:    relevantEvents,
          recentSkips:       (skips || []).slice(-20),
          today:             new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }),
        },
        accessToken,
        10
      );
    } catch (err) {
      console.error('Morning scan agent error:', err.message);
      return res.status(200).json({ ok: false, error: err.message });
    }

    return res.status(200).json({
      ok:     true,
      emails: emails.length,
      events: relevantEvents.length,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
