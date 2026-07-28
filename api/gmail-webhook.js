/**
 * Gmail Webhook — Vercel Serverless Function
 *
 * Receives Gmail push notifications via Google Cloud Pub/Sub.
 * When a new recruitment email arrives, triggers the agent loop.
 *
 * Routes:
 *   POST /api/gmail-webhook   → Pub/Sub push delivery
 *   GET  /api/gmail-webhook?action=register   → Register/renew Gmail watch (call once, then weekly)
 *
 * One-time setup (do this after first deployment) — see docs/SETUP.md:
 *   1. Google Cloud Console → enable Pub/Sub API
 *   2. Create a topic (any name — set GOOGLE_PUBSUB_TOPIC to match, defaults to "job-search-gmail-watch")
 *   3. Grant publish rights to: serviceAccount:gmail-api-push@system.gserviceaccount.com
 *   4. Create push subscription → https://<your-deployment>/api/gmail-webhook
 *   5. Call GET /api/gmail-webhook?action=register to start the watch
 *
 * Required env vars:
 *   GOOGLE_PUBSUB_PROJECT_ID — your GCP project id
 *   GOOGLE_PUBSUB_TOKEN      — a secret string you choose; add ?token=... to the subscription URL
 *   GOOGLE_PUBSUB_TOPIC      — optional, defaults to "job-search-gmail-watch"
 *   (all other vars shared with gmail.js)
 */
import { createRequire } from 'module';
import { runAgent, getValidAccessToken } from './agent.js';
import { kvGet, kvSet } from './_kv.js';
const require = createRequire(import.meta.url);

const { targets: TARGETS } = require('../config/targets.json');

const HISTORY_KEY = 'josh:gmail_history_id';

// Recruitment-relevant keyword list — generic terms + every company name in
// config/targets.json, so this list stays in sync automatically when you add
// or remove targets there.
const GENERIC_KEYWORDS = [
  'interview', 'offer', 'opportunity', 'application', 'recruiter',
  'hiring', 'role', 'position', 'follow up', 'next steps',
  'chief', 'vp ', 'vice president', 'director', 'head of', 'svp',
];
const RECRUITMENT_KEYWORDS = [
  ...GENERIC_KEYWORDS,
  ...TARGETS.map(t => t.company.toLowerCase()),
];

// ── Gmail history ─────────────────────────────────────────────────────────────
async function getNewMessages(accessToken, startHistoryId) {
  if (!startHistoryId) return [];
  const params = new URLSearchParams({
    startHistoryId: String(startHistoryId),
    historyTypes:   'messageAdded',
    maxResults:     '20',
  });
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/history?${params}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (data.error) {
    console.error('History fetch error:', data.error);
    return [];
  }
  const messages = [];
  for (const record of (data.history || [])) {
    for (const added of (record.messagesAdded || [])) {
      messages.push(added.message);
    }
  }
  return messages;
}

async function getEmailMeta(accessToken, id) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
    `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const msg = await res.json();
  const headers = msg.payload?.headers || [];
  const get = name => headers.find(h => h.name === name)?.value || '';
  return {
    id:       msg.id,
    threadId: msg.threadId,
    subject:  get('Subject'),
    from:     get('From'),
    date:     get('Date'),
    snippet:  (msg.snippet || '').slice(0, 200),
    labelIds: msg.labelIds || [],
  };
}

function isRecruitmentRelevant(msg) {
  // Inbox only (skip sent, trash, spam)
  const labels = msg.labelIds || [];
  if (!labels.includes('INBOX')) return false;

  const text = `${msg.subject || ''} ${msg.from || ''} ${msg.snippet || ''}`.toLowerCase();
  return RECRUITMENT_KEYWORDS.some(kw => text.includes(kw));
}

// ── Register/renew Gmail watch ────────────────────────────────────────────────
async function registerWatch(accessToken) {
  const projectId = process.env.GOOGLE_PUBSUB_PROJECT_ID;
  if (!projectId) return { error: 'GOOGLE_PUBSUB_PROJECT_ID not set' };
  const topic = process.env.GOOGLE_PUBSUB_TOPIC || 'job-search-gmail-watch';

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/watch',
    {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        topicName: `projects/${projectId}/topics/${topic}`,
        labelIds:  ['INBOX'],
      })
    }
  );
  const data = await res.json();
  if (data.historyId) {
    await kvSet(HISTORY_KEY, data.historyId);
    console.log('Gmail watch registered. historyId:', data.historyId, 'expires:', new Date(parseInt(data.expiration)).toISOString());
  }
  return data;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── GET ?action=register — register or renew Gmail watch ──────────────────
  if (req.method === 'GET' && req.query?.action === 'register') {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return res.status(200).json({ error: 'Gmail not connected' });
    const result = await registerWatch(accessToken);
    return res.status(200).json(result);
  }

  // ── POST — Pub/Sub push notification ─────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).end();

  // Optional token verification (set GOOGLE_PUBSUB_TOKEN and add ?token=... to subscription URL)
  const expectedToken = process.env.GOOGLE_PUBSUB_TOKEN;
  if (expectedToken && req.query?.token !== expectedToken) {
    console.warn('Pub/Sub token mismatch — rejecting');
    return res.status(403).end();
  }

  // Must ack within 10s or Pub/Sub will retry
  // We ack immediately then run the agent
  const body = req.body;
  res.status(200).end();

  // ── Process notification async ────────────────────────────────────────────
  try {
    const message = body?.message;
    if (!message?.data) return;

    // Decode Pub/Sub message
    let notification;
    try {
      notification = JSON.parse(Buffer.from(message.data, 'base64').toString());
    } catch {
      console.error('Failed to decode Pub/Sub message');
      return;
    }

    const { historyId: newHistoryId } = notification;
    if (!newHistoryId) return;

    const accessToken = await getValidAccessToken();
    if (!accessToken) {
      console.error('Gmail webhook: no valid access token');
      return;
    }

    // Get last known historyId
    const lastHistoryId = await kvGet(HISTORY_KEY);

    // Fetch new messages since last check
    const newMessages = await getNewMessages(accessToken, lastHistoryId || newHistoryId);

    // Update stored historyId regardless of what we find
    await kvSet(HISTORY_KEY, newHistoryId);

    if (newMessages.length === 0) return;

    // Fetch metadata for new messages
    const messageMeta = await Promise.all(
      newMessages.slice(0, 10).map(m => getEmailMeta(accessToken, m.id).catch(() => null))
    );
    const validMessages = messageMeta.filter(Boolean);

    // Filter to recruitment-relevant only
    const relevant = validMessages.filter(isRecruitmentRelevant);
    if (relevant.length === 0) return;

    console.log(`Gmail webhook: ${relevant.length} relevant new message(s) — triggering agent`);

    // Trigger agent loop
    await runAgent(
      'New recruitment email(s) received. For each relevant email: read it, check if it signals a pipeline change (interview scheduled, offer received, rejection, etc.), update the pipeline accordingly, star important emails, and create a Gmail draft reply if a response is clearly needed. Use get_pipeline first to see current state.',
      { newEmails: relevant, receivedAt: new Date().toISOString() },
      accessToken,
      6
    );
  } catch (err) {
    console.error('Gmail webhook agent error:', err.message);
  }
}
