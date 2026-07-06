import fetch from 'node-fetch';

export function botBaseUrl() {
  const url = process.env.BOT_STATUS_URL || process.env.WARDEN_BOT_URL;
  if (!url) throw new Error('BOT_STATUS_URL required');
  return url.replace(/\/$/, '');
}

function authHeaders(etag) {
  const h = { authorization: 'Bearer ' + process.env.WARDEN_TOKEN };
  if (etag) h['if-none-match'] = etag;
  return h;
}

export async function pullStatus() {
  const res = await fetch(botBaseUrl() + '/warden/status', {
    headers: authHeaders(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error('/warden/status ' + res.status);
  return res.json();
}

export async function pullSnapshot(lastHash) {
  const res = await fetch(botBaseUrl() + '/warden/snapshot', {
    headers: authHeaders(lastHash),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 304) return { unchanged: true, hash: lastHash };
  if (!res.ok) throw new Error('/warden/snapshot ' + res.status);
  const hash = res.headers.get('etag');
  const db = await res.json();
  return { unchanged: false, hash, db };
}
