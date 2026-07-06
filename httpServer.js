/** Single HTTP server on Railway PORT — Helius webhooks + Warden read-only routes + /health. */
import http from 'http';
import crypto from 'crypto';
import { loadDB } from './dbStore.js';
import { cycleStats } from './cycleStats.js';
import { processHeliusPayload, isDevSellEnabled } from './webhooks/devSell.js';

function pathOnly(url) {
  return (url || '/').split('?')[0];
}

export function routeRequest(req, res, client, getDb) {
  const path = pathOnly(req.url);

  if (path === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && path === '/helius-webhook') {
    if (!isDevSellEnabled()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const secret = process.env.WEBHOOK_SECRET;
    if (req.headers.authorization !== secret) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }
    res.writeHead(200);
    res.end('ok');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const db = getDb();
        processHeliusPayload(client, db, body).catch((e) =>
          console.error('[devsell] async:', e.message),
        );
      } catch (e) {
        console.error('[devsell] parse:', e.message);
      }
    });
    return;
  }

  if (path.startsWith('/warden/')) {
    const wardenToken = process.env.WARDEN_TOKEN;
    if (!wardenToken || req.headers.authorization !== 'Bearer ' + wardenToken) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (path === '/warden/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...cycleStats, now: Date.now() }));
      return;
    }
    if (path === '/warden/snapshot') {
      const body = JSON.stringify(getDb());
      const hash = crypto.createHash('sha256').update(body).digest('hex');
      if (req.headers['if-none-match'] === hash) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: hash });
      res.end(body);
      return;
    }
  }

  res.writeHead(404);
  res.end();
}

export function startHttpServer(client, getDb) {
  const port = Number(process.env.PORT) || 3000;
  const server = http.createServer((req, res) => routeRequest(req, res, client, getDb));
  server.listen(port, () => {
    const parts = ['/health'];
    if (isDevSellEnabled()) parts.push('/helius-webhook');
    if (process.env.WARDEN_TOKEN) parts.push('/warden/status', '/warden/snapshot');
    console.log('[http] listening on :' + port + ' — ' + parts.join(', '));
    if (!process.env.WARDEN_TOKEN) console.log('[http] WARDEN_TOKEN unset — /warden/* fail closed');
  });
  return server;
}
