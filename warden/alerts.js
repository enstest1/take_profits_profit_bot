import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import {
  CRITICAL_COOLDOWN_MS,
  WARN_COOLDOWN_MS,
  DEFAULT_WARDEN_CHANNEL_ID,
} from './config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = fs.existsSync('/data/warden') ? '/data/warden' : path.join(ROOT, '.warden-data');
const COOLDOWN_PATH = path.join(DATA_DIR, 'cooldowns.json');
const DIGEST_PATH = path.join(DATA_DIR, 'digest-pending.json');

const WEBHOOK_URL = process.env.WARDEN_WEBHOOK_URL;
const CHANNEL_ID = process.env.WARDEN_CHANNEL_ID || DEFAULT_WARDEN_CHANNEL_ID;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const OWNER_ID = process.env.OWNER_ID;

let recent = loadCooldowns();
let digestPending = loadDigest();
let lastCriticalReminder = new Map();
let ctx = { gitSha: 'unknown', snapshotAt: null };

export function setAlertContext({ gitSha, snapshotAt }) {
  ctx = { gitSha: gitSha || 'unknown', snapshotAt: snapshotAt || null };
}

function loadCooldowns() {
  try {
    if (fs.existsSync(COOLDOWN_PATH)) return new Map(Object.entries(JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'))));
  } catch {
    /* fresh */
  }
  return new Map();
}

function saveCooldowns() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(Object.fromEntries(recent), null, 2));
}

function loadDigest() {
  try {
    if (fs.existsSync(DIGEST_PATH)) return JSON.parse(fs.readFileSync(DIGEST_PATH, 'utf8'));
  } catch {
    /* fresh */
  }
  return [];
}

function saveDigest() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DIGEST_PATH, JSON.stringify(digestPending, null, 2));
}

function footer() {
  const ts = ctx.snapshotAt ? new Date(ctx.snapshotAt).toISOString().slice(11, 19) + 'Z' : '—';
  return 'sha ' + (ctx.gitSha || 'unknown') + ' · snapshot ' + ts;
}

async function postDiscord(payload) {
  if (WEBHOOK_URL) {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('webhook ' + res.status);
    return;
  }
  if (!BOT_TOKEN) throw new Error('WARDEN_WEBHOOK_URL or DISCORD_TOKEN required');
  const res = await fetch('https://discord.com/api/v10/channels/' + CHANNEL_ID + '/messages', {
    method: 'POST',
    headers: {
      authorization: 'Bot ' + BOT_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('channel post ' + res.status + ': ' + t.slice(0, 200));
  }
}

export async function raise(checkId, severity, mint, message, diff, { deployNote } = {}) {
  const key = checkId + ':' + (mint || 'global');
  const cooldown = severity === 'CRITICAL' ? CRITICAL_COOLDOWN_MS : WARN_COOLDOWN_MS;
  const last = recent.get(key) || 0;
  const now = Date.now();

  if (severity === 'WARN') {
    if (now - last < WARN_COOLDOWN_MS) return false;
    recent.set(key, now);
    saveCooldowns();
    digestPending.push({ checkId, mint, message, diff, at: now, deployNote });
    saveDigest();
    return true;
  }

  if (now - last < cooldown) {
    const remindKey = key + ':remind';
    if (now - (lastCriticalReminder.get(remindKey) || 0) < cooldown) return false;
    lastCriticalReminder.set(remindKey, now);
    message = '⏳ still broken — ' + message;
  } else {
    recent.set(key, now);
    saveCooldowns();
  }

  const fields = [];
  if (diff) {
    fields.push({
      name: 'before → after',
      value: '```json\n' + JSON.stringify(diff, null, 1).slice(0, 900) + '\n```',
    });
  }
  if (deployNote) {
    fields.push({ name: 'deploy context', value: deployNote.slice(0, 500) });
  }

  const content = OWNER_ID ? '<@' + OWNER_ID + '> 🚨' : undefined;
  await postDiscord({
    content,
    embeds: [
      {
        title: severity + ' · ' + checkId,
        description: message.slice(0, 4000),
        fields,
        color: severity === 'CRITICAL' ? 0xe74c3c : 0xf1c40f,
        footer: { text: footer() },
        timestamp: new Date().toISOString(),
      },
    ],
  });
  return true;
}

export async function postAlive(stats) {
  const text =
    '✅ Warden alive — ' +
    stats.snapshots +
    ' snapshots (' +
    stats.changed +
    ' changed), ' +
    stats.criticals +
    ' criticals today, sha `' +
    (ctx.gitSha || 'unknown') +
    '`';
  await postDiscord({
    embeds: [{ description: text, color: 0x2ecc71, footer: { text: footer() } }],
  });
}

export async function postAllClear(message) {
  await postDiscord({
    embeds: [
      {
        title: '✅ Warden all-clear',
        description: message,
        color: 0x2ecc71,
        footer: { text: footer() },
      },
    ],
  });
}

export async function flushDailyDigest() {
  if (!digestPending.length) return;
  const lines = digestPending.map(
    (d) => '**' + d.checkId + '** `' + (d.mint || 'global') + '`\n' + d.message,
  );
  await postDiscord({
    embeds: [
      {
        title: '📋 Warden daily digest (' + digestPending.length + ' WARN)',
        description: lines.join('\n\n').slice(0, 4000),
        color: 0xf1c40f,
        footer: { text: footer() },
      },
    ],
  });
  digestPending = [];
  saveDigest();
}

export function getDigestCount() {
  return digestPending.length;
}
