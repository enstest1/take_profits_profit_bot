import 'dotenv/config';
import http from 'http';
import {
  STATUS_INTERVAL_MS,
  SNAPSHOT_INTERVAL_MS,
  PRICE_TRUTH_INTERVAL_MS,
} from './config.js';
import { pullStatus, pullSnapshot } from './pullClient.js';
import {
  initShadowStore,
  loadPreviousSnapshot,
  storeSnapshot,
  initLegacyEvmKeys,
  loadLegacyEvmKeys,
  loadMeta,
} from './shadowStore.js';
import * as alerts from './alerts.js';
import { runSnapshotChecks, runLayer2Checks } from './checks/runChecks.js';
import {
  createOpsState,
  checkHeartbeat,
  checkPerformance,
  checkAlertVolume,
  noteDeploy,
  inDeployWindow,
  noteCritical,
} from './checks/ops.js';

const ops = createOpsState();
let lastStatus = null;
let lastPriceTruthAt = 0;
let lastDigestDay = null;
let lastAliveDay = null;
let snapshotChangedCount = 0;
let prevBroken = 0;

function requireEnv() {
  if (!process.env.WARDEN_TOKEN) throw new Error('WARDEN_TOKEN required');
  if (!process.env.BOT_STATUS_URL && !process.env.WARDEN_BOT_URL) {
    throw new Error('BOT_STATUS_URL required');
  }
  if (!process.env.WARDEN_WEBHOOK_URL && !process.env.DISCORD_TOKEN) {
    throw new Error('WARDEN_WEBHOOK_URL or DISCORD_TOKEN required for channel ' + (process.env.WARDEN_CHANNEL_ID || '1484009058401910844'));
  }
}

function makeRaise(gitSha, snapshotAt) {
  alerts.setAlertContext({ gitSha, snapshotAt });
  return (checkId, severity, mint, message, diff, opts = {}) => {
    if (severity === 'CRITICAL') noteCritical(ops);
    const deployNote = inDeployWindow(ops)
      ? opts.deployNote || 'deploy window sha `' + ops.deploySha + '`'
      : opts.deployNote;
    return alerts.raise(checkId, severity, mint, message, diff, { deployNote });
  };
}

async function onStatus() {
  let status;
  try {
    status = await pullStatus();
    lastStatus = status;
    noteDeploy(ops, status.gitSha);
    const raise = makeRaise(status.gitSha, Date.now());
    const hb = checkHeartbeat(status, ops, raise);
    if (hb?.recovered) {
      await alerts.postAllClear('Bot poll loop recovered after outage.');
    }
    checkPerformance(status, ops, raise);
    checkAlertVolume(status, ops, raise);
    prevBroken = status.broken ?? prevBroken;
  } catch (e) {
    console.error('[warden] status pull failed:', e.message);
    const raise = makeRaise('unknown', Date.now());
    checkHeartbeat(null, ops, raise);
  }
}

async function onSnapshot() {
  const meta = loadMeta();
  let pulled;
  try {
    pulled = await pullSnapshot(meta.lastHash);
  } catch (e) {
    console.error('[warden] snapshot pull failed:', e.message);
    return;
  }
  if (pulled.unchanged) {
    console.log('[warden] snapshot unchanged (304)');
    if (lastStatus) checkCanariesOnly();
    return;
  }

  const db = pulled.db;
  const gitSha = lastStatus?.gitSha || 'unknown';
  const prevEnvelope = loadPreviousSnapshot();
  const prevDb = prevEnvelope?.db || null;
  if (!loadLegacyEvmKeys()) initLegacyEvmKeys(db);

  const stored = storeSnapshot(db, { hash: pulled.hash, gitSha });
  if (!stored.changed) return;

  snapshotChangedCount += 1;

  const raise = makeRaise(gitSha, stored.envelope?.pulledAt || Date.now());
  const ctx = {
    legacyFrozen: loadLegacyEvmKeys(),
    statusBroken: lastStatus?.broken ?? 0,
    prevBroken,
    prevSnap: prevDb,
  };

  runSnapshotChecks(prevDb, db, raise, ctx);

  if (lastStatus) checkCanariesOnly();

  const now = Date.now();
  if (now - lastPriceTruthAt >= PRICE_TRUTH_INTERVAL_MS) {
    lastPriceTruthAt = now;
    await runLayer2Checks(db, lastStatus, raise, {
      pollIntervalMs: lastStatus.pollIntervalMs,
    });
  }
}

async function checkCanariesOnly() {
  const { checkCanaries } = await import('./checks/canary.js');
  const meta = loadMeta();
  if (!meta.lastSnapshotId) return;
  const prevEnvelope = loadPreviousSnapshot();
  if (!prevEnvelope?.db) return;
  const raise = makeRaise(lastStatus?.gitSha, Date.now());
  checkCanaries(prevEnvelope.db, lastStatus, raise);
}

async function dailyTasks() {
  const day = new Date().toISOString().slice(0, 10);
  const hour = new Date().getUTCHours();

  if (hour === 23 && lastDigestDay !== day) {
    lastDigestDay = day;
    await alerts.flushDailyDigest().catch((e) => console.error('[warden] digest:', e.message));
  }

  if (hour === 12 && lastAliveDay !== day) {
    lastAliveDay = day;
    await alerts
      .postAlive({
        snapshots: loadMeta().snapshotCount || 0,
        changed: snapshotChangedCount,
        criticals: ops.criticalsToday,
      })
      .catch((e) => console.error('[warden] alive:', e.message));
    ops.criticalsToday = 0;
    snapshotChangedCount = 0;
  }
}

function startHealthServer() {
  const port = Number(process.env.WARDEN_PORT) || Number(process.env.PORT) || 8790;
  http
    .createServer((req, res) => {
      if (req.url?.split('?')[0] === '/health') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(404);
      res.end();
    })
    .listen(port, () => console.log('[warden] health on :' + port));
}

async function main() {
  requireEnv();
  initShadowStore();
  console.log('[warden] starting — channel ' + (process.env.WARDEN_CHANNEL_ID || '1484009058401910844'));
  startHealthServer();

  await onStatus();
  await onSnapshot();

  setInterval(() => void onStatus().catch(() => {}), STATUS_INTERVAL_MS);
  setInterval(() => void onSnapshot().catch(() => {}), SNAPSHOT_INTERVAL_MS);
  setInterval(() => void dailyTasks().catch(() => {}), 60_000);
}

main().catch((e) => {
  console.error('[warden] fatal:', e);
  process.exit(1);
});
