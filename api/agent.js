/**
 * Agent — core agentic loop
 *
 * Exports: runAgent(task, context, accessToken, maxIterations)
 *
 * Claude is given a set of tools and loops until stop_reason === "end_turn".
 * All other API files call runAgent() instead of making their own Claude calls.
 */
import { createRequire } from 'module';
import { kvGet, kvSet } from './_kv.js';
const require = createRequire(import.meta.url);

const PROFILE = require('../config/profile.json');
const { targets: TARGETS } = require('../config/targets.json');

const AGENT_ID = PROFILE.agentName.toLowerCase();

// ── Google token refresh ───────────────────────────────────────────────────────
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

export async function getValidAccessToken() {
  const tokens = await kvGet('josh:google_tokens');
  if (!tokens) return null;
  if (tokens.expires_at && Date.now() < tokens.expires_at - 300_000) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  if (refreshed.error) { console.error('Token refresh failed:', refreshed.error); return null; }
  await kvSet('josh:google_tokens', {
    ...tokens,
    access_token: refreshed.access_token,
    expires_at:   Date.now() + (refreshed.expires_in || 3600) * 1000,
  });
  return refreshed.access_token;
}

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_pipeline',
    description: 'Fetch current pipeline state: roles (active), pending (approval queue), dismissed (rejected).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_role',
    description: 'Update fields on an active pipeline role. Provide the role id and a fields object with the keys to merge (stage, lastContact, nextAction, actionNote, calendarUrl, gmailUrl, joshPrep). joshPrep is an array of short labels for the artifacts you are preparing for this role, e.g. ["Interview brief", "Comp benchmark file"] — the dashboard shows them on the Kanban card.',
    input_schema: {
      type: 'object',
      properties: {
        id:     { type: ['string', 'number'], description: 'Role id' },
        fields: { type: 'object', description: 'Fields to merge into the role' }
      },
      required: ['id', 'fields']
    }
  },
  {
    name: 'add_to_pending',
    description:
      'Add an item to the pending approval queue. Two kinds are allowed.\n' +
      'kind "vacancy" (default): a real posting that exists right now. Give the exact role title and its url.\n' +
      'kind "signal": an opportunity you inferred that has NOT been posted yet — a leadership change, a ' +
      'restructure, funding, a strategy statement, a warm contact moving into a decision seat, a reposted role, ' +
      'or a seasonal pattern. Never invent a job title for a signal: describe what actually happened in ' +
      '`headline` and what you infer from it in `thesis`. Every signal MUST carry at least one evidence item ' +
      'with a real url you actually fetched; signals without evidence are rejected.',
    input_schema: {
      type: 'object',
      properties: {
        kind:     { type: 'string', enum: ['vacancy', 'signal'], description: 'Defaults to "vacancy"' },
        company:  { type: 'string' },
        role:     { type: 'string', description: 'Vacancy only: the exact posted job title' },
        sector:   { type: 'string' },
        location: { type: 'string' },
        score:    { type: 'number', description: 'Vacancy: rubric score. Signal: priority 0-100' },
        source:   { type: 'string' },
        url:      { type: 'string', description: 'Vacancy only: link to the posting' },
        signalType: {
          type: 'string',
          enum: ['leadership_change', 'org_change', 'funding_growth', 'strategy_signal',
                 'warm_path', 'repost', 'seasonal'],
          description: 'Signal only'
        },
        headline: { type: 'string', description: 'Signal only: the event, factually, in one line' },
        thesis:   { type: 'string', description: 'Signal only: what you infer follows from it' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Signal only' },
        suggestedAction: { type: 'string', description: 'Signal only: the concrete next step, never "apply"' },
        evidence: {
          type: 'array',
          description: 'Signal only, required: sources you actually fetched',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              url:    { type: 'string' },
              date:   { type: 'string' }
            },
            required: ['source', 'url']
          }
        }
      },
      required: ['company', 'score']
    }
  },
  {
    name: 'search_gmail',
    description: 'Search Gmail inbox. Returns matching message metadata (id, subject, from, date, snippet). Use standard Gmail search syntax.',
    input_schema: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Gmail search query, e.g. "from:microsoft subject:interview newer_than:2d"' },
        maxResults: { type: 'number', description: 'Max messages to return (default 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_email',
    description: 'Get full details of a Gmail message including decoded body text (up to 2000 chars).',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message id' }
      },
      required: ['id']
    }
  },
  {
    name: 'star_email',
    description: 'Star a Gmail message to flag it for the candidate\'s immediate attention.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Gmail message id' }
      },
      required: ['id']
    }
  },
  {
    name: 'create_gmail_draft',
    description: 'Create a Gmail draft. NOT sent automatically — the candidate reviews and sends. Use for follow-ups, outreach, and recruiter replies.',
    input_schema: {
      type: 'object',
      properties: {
        to:       { type: 'string', description: 'Recipient email address' },
        subject:  { type: 'string' },
        body:     { type: 'string', description: 'Plain text email body' },
        threadId: { type: 'string', description: 'Optional: Gmail thread id to reply within' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'get_calendar_events',
    description: 'Fetch upcoming Google Calendar events for the candidate.',
    input_schema: {
      type: 'object',
      properties: {
        daysAhead: { type: 'number', description: 'How many days ahead to look (default 14)' }
      }
    }
  },
  {
    name: 'fetch_url',
    description: 'Fetch a public URL and return its text content (HTML stripped). Use for company research, news, and career pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' }
      },
      required: ['url']
    }
  },
  {
    name: 'post_sprint_task',
    description: 'Create a task on an external sprint board, if you use one. Set SPRINT_BOARD_URL in env to enable — otherwise this is a no-op. Use for upcoming actions, research tasks, or cross-agent collaboration.',
    input_schema: {
      type: 'object',
      properties: {
        title:          { type: 'string' },
        description:    { type: 'string' },
        priority:       { type: 'string', enum: ['low', 'medium', 'high'] },
        estimatedHours: { type: 'number' },
        tags:           { type: 'array', items: { type: 'string' }, description: 'e.g. ["collab:teammate"]' }
      },
      required: ['title', 'priority']
    }
  },
  {
    name: 'set_briefing',
    description: 'Store the morning briefing text in KV so it appears on the dashboard. Call this at the end of any morning scan task.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Briefing text with bullet points (use • character)' }
      },
      required: ['text']
    }
  },
  {
    name: 'write_vault_note',
    description: 'Write a markdown note to memory, stored in KV. Use for EOD logs, research briefs, and carry-forward notes.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename without path, e.g. "2026-04-15.md" or "burberry-research.md"' },
        content:  { type: 'string', description: 'Markdown content' }
      },
      required: ['filename', 'content']
    }
  }
];

// ── Tool implementations ───────────────────────────────────────────────────────
async function executeTool(name, input, accessToken) {
  try {
    switch (name) {

      case 'get_pipeline': {
        const [roles, pending, dismissed] = await Promise.all([
          kvGet('josh:roles'),
          kvGet('josh:pending'),
          kvGet('josh:dismissed'),
        ]);
        return { roles: roles || [], pending: pending || [], dismissed: dismissed || [] };
      }

      case 'update_role': {
        const roles = await kvGet('josh:roles') || [];
        const idx = roles.findIndex(r => String(r.id) === String(input.id));
        if (idx === -1) return { error: `Role id ${input.id} not found` };
        roles[idx] = { ...roles[idx], ...input.fields };
        await kvSet('josh:roles', roles);
        return { ok: true, updated: roles[idx] };
      }

      case 'add_to_pending': {
        const kind = input.kind === 'signal' ? 'signal' : 'vacancy';

        // A signal is a hypothesis, not a posting. Two rules are enforced here
        // rather than in the prompt, so a model that ignores its instructions
        // still cannot put an unsourced or invented vacancy in front of the
        // candidate:
        //   1. every signal must cite at least one real url it fetched
        //   2. a signal may never carry a job title — it has not been posted
        if (kind === 'signal') {
          const evidence = Array.isArray(input.evidence)
            ? input.evidence.filter(e => e && typeof e.url === 'string' && /^https?:\/\//i.test(e.url))
            : [];
          if (evidence.length === 0) {
            return { ok: false, reason: 'Signal rejected: at least one evidence item with a real url is required' };
          }
          if (!input.headline) {
            return { ok: false, reason: 'Signal rejected: headline (what actually happened) is required' };
          }
          input = { ...input, evidence, role: 'No posting yet — watching' };
        } else if (!input.role) {
          return { ok: false, reason: 'Vacancy rejected: role title is required' };
        }

        const pending = await kvGet('josh:pending') || [];
        const key = kind === 'signal'
          ? `${input.company}::${input.headline}`.toLowerCase()
          : `${input.company}::${input.role}`.toLowerCase();
        const exists = pending.some(p =>
          (p.kind === 'signal'
            ? `${p.company}::${p.headline || ''}`
            : `${p.company}::${p.role || ''}`).toLowerCase() === key
        );
        if (exists) return { ok: false, reason: 'Already in pending queue' };

        const newRole = { id: `p${Date.now()}`, kind, foundAt: Date.now(), ...input };
        await kvSet('josh:pending', [...pending, newRole]);
        return { ok: true, added: newRole };
      }

      case 'search_gmail': {
        if (!accessToken) return { error: 'Gmail not connected' };
        const params = new URLSearchParams({
          q: input.query,
          maxResults: String(input.maxResults || 10)
        });
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = await res.json();
        const messages = data.messages || [];
        const details = await Promise.all(
          messages.slice(0, 10).map(m => getEmailMeta(accessToken, m.id))
        );
        return { messages: details };
      }

      case 'get_email': {
        if (!accessToken) return { error: 'Gmail not connected' };
        return await getEmailFull(accessToken, input.id);
      }

      case 'star_email': {
        if (!accessToken) return { error: 'Gmail not connected' };
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${input.id}/modify`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ addLabelIds: ['STARRED'] })
          }
        );
        return { ok: res.ok };
      }

      case 'create_gmail_draft': {
        if (!accessToken) return { error: 'Gmail not connected' };
        return await createDraft(accessToken, input);
      }

      case 'get_calendar_events': {
        if (!accessToken) return { error: 'Gmail not connected' };
        const daysAhead = input.daysAhead || 14;
        const now      = new Date().toISOString();
        const future   = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
        const params = new URLSearchParams({
          timeMin: now, timeMax: future,
          maxResults: '25', singleEvents: 'true', orderBy: 'startTime'
        });
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const data = await res.json();
        return {
          events: (data.items || []).map(e => ({
            id:          e.id,
            htmlLink:    e.htmlLink,
            summary:     e.summary || '(no title)',
            start:       e.start?.dateTime || e.start?.date,
            end:         e.end?.dateTime || e.end?.date,
            location:    e.location || '',
            description: (e.description || '').slice(0, 300),
            organizer:   e.organizer?.email || '',
            status:      e.status,
            myResponseStatus: e.attendees?.find(a => a.self)?.responseStatus || 'accepted',
          }))
        };
      }

      case 'fetch_url': {
        const res = await fetch(input.url, {
          headers: { 'User-Agent': `Mozilla/5.0 (compatible; ${PROFILE.agentName}Agent/1.0)` },
          signal: AbortSignal.timeout(10000)
        });
        const html = await res.text();
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);
        return { url: input.url, text };
      }

      case 'post_sprint_task': {
        const boardUrl = process.env.SPRINT_BOARD_URL;
        if (!boardUrl) return { ok: false, reason: 'SPRINT_BOARD_URL not set — sprint board integration disabled' };
        const res = await fetch(`${boardUrl}/api/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId:        AGENT_ID,
            title:          input.title,
            description:    input.description || '',
            priority:       input.priority,
            estimatedHours: input.estimatedHours || 0.5,
            tags:           input.tags || [],
            source:         'agent',
          })
        });
        const data = await res.json();
        return { ok: res.ok, task: data };
      }

      case 'set_briefing': {
        await kvSet('josh:briefing', {
          text: input.text,
          ts:   Date.now(),
        });
        return { ok: true };
      }

      case 'write_vault_note': {
        const today = new Date().toISOString().slice(0, 10);
        const key = input.filename.includes('.') ? input.filename : `${input.filename}.md`;
        await kvSet(`josh:vault:${key}`, { content: input.content, ts: Date.now() });
        if (key.match(/^\d{4}-\d{2}-\d{2}/)) {
          await kvSet('josh:vault:latest', { content: input.content, ts: Date.now(), date: today });
        }
        return { ok: true, key: `josh:vault:${key}` };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    console.error(`Tool ${name} failed:`, err.message);
    return { error: err.message };
  }
}

// ── Gmail helpers (used by tools) ─────────────────────────────────────────────
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
  };
}

async function getEmailFull(accessToken, id) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const msg = await res.json();
  const headers = msg.payload?.headers || [];
  const get = name => headers.find(h => h.name === name)?.value || '';

  let body = '';
  function extractBody(part) {
    if (part?.mimeType === 'text/plain' && part?.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    for (const sub of (part?.parts || [])) {
      const result = extractBody(sub);
      if (result) return result;
    }
    return '';
  }
  body = extractBody(msg.payload).slice(0, 2000);

  return {
    id:       msg.id,
    threadId: msg.threadId,
    subject:  get('Subject'),
    from:     get('From'),
    date:     get('Date'),
    snippet:  (msg.snippet || '').slice(0, 300),
    body,
  };
}

async function createDraft(accessToken, { to, subject, body, threadId }) {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const draftBody = { message: { raw: encoded } };
  if (threadId) draftBody.message.threadId = threadId;

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(draftBody)
  });
  const data = await res.json();
  if (!res.ok) return { error: data.error?.message || 'Draft creation failed' };
  return { ok: true, draftId: data.id };
}

// ── Claude API call ───────────────────────────────────────────────────────────
async function callClaude(system, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type':      'application/json',
    },
    body: JSON.stringify({
      model:      process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system,
      tools:      TOOLS,
      messages,
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Claude API error: ${JSON.stringify(data)}`);
  return data;
}

// ── System prompt ─────────────────────────────────────────────────────────────
// Built entirely from config/profile.json + config/targets.json — edit those
// files, not this function, to change how the agent reasons about your search.
function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const keyTargets = [...new Set(TARGETS.map(t => t.company))].join(', ');
  const behaviour = PROFILE.agentBehaviour.map(line => `- ${line}`).join('\n');

  return `You are ${PROFILE.agentName}, an autonomous executive recruitment agent for ${PROFILE.candidateName}.
Today is ${today}.

CANDIDATE PROFILE:
- ${PROFILE.seniorityLevel}
- Target sectors: ${PROFILE.targetSectors.join(', ')}
- Location: ${PROFILE.location}
- Compensation floor: ${PROFILE.compensationFloor}
- Key targets: ${keyTargets}

PIPELINE STAGES: ${PROFILE.pipelineStages.join(' → ')}

SCORING RUBRIC: see config/rubric.json for the exact weights used by the scraper.
This system prompt only needs the summary above — the scraper does the scoring.

STALE RULE: A role is stale if lastContact is ${PROFILE.staleDays}+ days ago.

YOUR BEHAVIOUR:
${behaviour}`;
}

// ── Token log ─────────────────────────────────────────────────────────────────
// Sonnet pricing (USD per token) — update if you change ANTHROPIC_MODEL.
const PRICE = { input: 3e-6, output: 15e-6, cacheWrite: 3.75e-6, cacheRead: 0.3e-6 };

async function appendTokenLog(entry) {
  try {
    const existing = (await kvGet('josh:token_log')) || [];
    const merged   = [...existing, entry].slice(-500);
    await kvSet('josh:token_log', merged);
  } catch (err) {
    console.error('Token log write failed:', err.message);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Run the agent.
 *
 * @param {string} task         - What the agent should accomplish
 * @param {object} context      - Additional context (emails, events, stale roles, etc.)
 * @param {string} accessToken  - Google OAuth access token (nullable if no Gmail needed)
 * @param {number} maxIterations - Safety cap on tool-calling loops (default 8)
 * @param {string} queryType    - Category for token log: 'monitor'|'warmpath'|'chat'|'cowork'|'code'
 * @returns {{ result: string|null, iterations: number, usage: object }}
 */
export async function runAgent(task, context = {}, accessToken = null, maxIterations = 8, queryType = 'api') {
  const system = buildSystemPrompt();
  const messages = [{
    role:    'user',
    content: `Task: ${task}\n\nContext:\n${JSON.stringify(context, null, 2)}`
  }];

  let iterations    = 0;
  let finalText     = null;
  let totalInput    = 0;
  let totalOutput   = 0;
  let totalCacheWrite = 0;
  let totalCacheRead  = 0;

  while (iterations < maxIterations) {
    const response = await callClaude(system, messages);
    messages.push({ role: 'assistant', content: response.content });

    const u = response.usage || {};
    totalInput      += u.input_tokens                  || 0;
    totalOutput     += u.output_tokens                 || 0;
    totalCacheWrite += u.cache_creation_input_tokens   || 0;
    totalCacheRead  += u.cache_read_input_tokens       || 0;

    if (response.stop_reason === 'end_turn') {
      finalText = response.content.find(b => b.type === 'text')?.text || null;
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');

      const toolResults = await Promise.all(
        toolUses.map(async t => {
          const result = await executeTool(t.name, t.input, accessToken);
          return {
            type:        'tool_result',
            tool_use_id: t.id,
            content:     JSON.stringify(result),
          };
        })
      );
      messages.push({ role: 'user', content: toolResults });
    }

    iterations++;
  }

  if (iterations >= maxIterations) {
    console.warn(`Agent hit maxIterations (${maxIterations}) for task: ${task}`);
  }

  const costUSD =
    totalInput      * PRICE.input      +
    totalOutput     * PRICE.output     +
    totalCacheWrite * PRICE.cacheWrite +
    totalCacheRead  * PRICE.cacheRead;

  const usage = {
    inputTokens:       totalInput,
    outputTokens:      totalOutput,
    cacheWriteTokens:  totalCacheWrite,
    cacheReadTokens:   totalCacheRead,
    costUSD:           Math.round(costUSD * 100000) / 100000,
  };

  // Fire-and-forget — don't block the response on KV write
  appendTokenLog({ ts: Date.now(), type: queryType, iterations, ...usage });

  return { result: finalText, iterations, usage };
}
