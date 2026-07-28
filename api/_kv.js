// Shared Vercel KV / Upstash REST helpers used by every function in api/.
// Uses the standard Vercel KV integration env var names so this works with
// zero extra config once you've added the Vercel KV (Upstash) integration.

export async function kvGet(key) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res   = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.result) return null;
  if (typeof data.result === 'object') return data.result;
  try { return JSON.parse(data.result); } catch { return null; }
}

export async function kvSet(key, value) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(value),
  });
  return res.ok;
}
