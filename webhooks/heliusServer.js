/** HTTP server for Helius dev-sell webhooks — env-gated. */
import http from 'http';
import { processHeliusPayload, isDevSellEnabled } from './devSell.js';

export function startHeliusServer(client, getDb) {
  if (!isDevSellEnabled()) {
    console.log('[devsell] disabled (missing env)');
    return null;
  }

  const port = Number(process.env.PORT) || 3000;
  const secret = process.env.WEBHOOK_SECRET;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/helius-webhook') {
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
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => console.log('[devsell] webhook server on :' + port));
  return server;
}
