// extract.js — LLM knowledge extraction for the knowledge bot.
//
// Walks each fully-backfilled channel in chronological order (cursor per
// channel), windows the messages, and asks Claude to CURATE — not summarize —
// durable knowledge: explanations, Q&A pairs, resources, how-tos,
// recommendations, decisions, warnings. Banter is discarded. Each unit keeps
// its source message IDs via a short-ref map ([m1], [m2], ...) so the model
// never has to copy 19-digit snowflakes.

import crypto from 'crypto';
import cron from 'node-cron';
import { callClaude, parseJsonLoose } from './llm.js';
import {
  allChannelRows,
  getExtractCursor,
  setExtractCursor,
  nextMessagesForExtraction,
  extractionBacklog,
  insertKnowledge,
} from './db.js';

const EXTRACT_MODEL = process.env.KB_EXTRACT_MODEL || 'anthropic/claude-haiku-4.5';
const WINDOW_CHARS = 40_000;
const MAX_WINDOWS_PER_RUN = Number(process.env.KB_MAX_WINDOWS_PER_RUN || 20);
const MIN_WINDOW_MSGS = 5;
const SETTLE_MS = 15 * 60 * 1000; // let very recent chat settle before extracting

const ANONYMIZE = process.env.KB_ANONYMIZE === '1';

const KINDS = new Set(['qa', 'explanation', 'resource', 'howto', 'recommendation', 'decision', 'warning']);

export const EXTRACT_SYSTEM = `You are the archivist for a Discord community. You receive a chronological chat window. Each message is prefixed with a short ref like [m12]. Your job is to CURATE durable knowledge — not to summarize chatter.

Extract knowledge units of these kinds only:
- "qa": a question someone asked PLUS the answer that actually resolved it (combine both into the body)
- "explanation": someone explaining a concept, tool, or how something works
- "resource": a link/tool/doc shared WITH enough context to know what it is and why it's useful (include the URL verbatim in the body)
- "howto": step-by-step instructions or a working recipe/config/command sequence
- "recommendation": advice or best practice given with reasoning
- "decision": the group settling something ("we're using X for Y because Z")
- "warning": pitfalls, scams, things that broke, "don't do X"

For each unit output:
{
  "kind": "qa|explanation|resource|howto|recommendation|decision|warning",
  "topic": "2-4 word topic label, lowercase",
  "title": "one-line title a reader could scan",
  "body": "the knowledge itself, self-contained, in clean prose or steps; preserve URLs, commands, and code verbatim",
  "refs": ["m12","m14"],
  "authors": ["username(s) who provided it"],
  "confidence": "high|medium|low"
}

Hard rules:
- A unit must be SELF-CONTAINED: a reader with zero chat context must understand it. Resolve pronouns ("it" -> the actual tool name).
- Preserve URLs, code, commands, file names, and version numbers VERBATIM. Never invent or "fix" them.
- refs must list the message refs the unit came from — the question AND the answer for qa.
- Skip greetings, jokes, reactions, off-topic chat, unresolved questions with no answer, and low-content hype.
- If the window contains nothing worth keeping, output [].
- Do not duplicate: if the same fact appears twice in this window, output it once.
- Output ONLY a valid JSON array. No prose, no markdown fences.`;

function anonName(name) {
  if (!ANONYMIZE) return name;
  return 'member-' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 4);
}

export function serializeWindow(msgs) {
  const refMap = new Map(); // ref -> msg_id
  const lines = [];
  msgs.forEach((m, i) => {
    const ref = 'm' + (i + 1);
    refMap.set(ref, m.msg_id);
    const ts = new Date(m.created_ts).toISOString().slice(0, 16).replace('T', ' ');
    let line = '[' + ref + '] [' + ts + '] ' + anonName(m.author_name) + ': ' +
      (m.content || '').replace(/\s*\n+\s*/g, ' | ').slice(0, 1500);
    if (m.reply_to) line += ' (reply to another message)';
    if (m.embeds) {
      try {
        const es = JSON.parse(m.embeds);
        for (const e of es) {
          const bits = [e.t, e.d, e.u].filter(Boolean).join(' — ');
          if (bits) line += ' ||| EMBED: "' + bits.slice(0, 300) + '"';
        }
      } catch { /* ignore bad json */ }
    }
    lines.push(line);
  });
  return { text: lines.join('\n'), refMap };
}

export function buildWindows(msgs) {
  const windows = [];
  let cur = [];
  let curLen = 0;
  for (const m of msgs) {
    const est = (m.content || '').length + 80;
    if (curLen + est > WINDOW_CHARS && cur.length) {
      windows.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(m);
    curLen += est;
  }
  if (cur.length) windows.push(cur);
  return windows;
}

export function validateUnits(raw, refMap) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const u of raw) {
    if (!u || typeof u !== 'object') continue;
    if (!KINDS.has(u.kind)) continue;
    if (!u.title || !u.body) continue;
    const sourceIds = (Array.isArray(u.refs) ? u.refs : [])
      .map((r) => refMap.get(String(r).trim()))
      .filter(Boolean);
    out.push({
      kind: u.kind,
      topic: String(u.topic || '').slice(0, 60).toLowerCase(),
      title: String(u.title).slice(0, 200),
      body: String(u.body).slice(0, 4000),
      source_ids: JSON.stringify(sourceIds),
      authors: JSON.stringify((u.authors || []).slice(0, 6)),
      confidence: ['high', 'medium', 'low'].includes(u.confidence) ? u.confidence : 'medium',
    });
  }
  return out;
}

let extracting = false;

export async function runExtraction() {
  if (extracting) return { skipped: true };
  extracting = true;
  const started = Date.now();
  let windowsDone = 0;
  let unitsAdded = 0;
  try {
    const channels = allChannelRows().filter((c) => c.backfill_done);
    for (const ch of channels) {
      if (windowsDone >= MAX_WINDOWS_PER_RUN) break;
      let cursor = getExtractCursor(ch.channel_id);

      while (windowsDone < MAX_WINDOWS_PER_RUN) {
        const msgs = nextMessagesForExtraction(ch.channel_id, cursor).filter(
          (m) => m.created_ts < Date.now() - SETTLE_MS,
        );
        if (msgs.length < MIN_WINDOW_MSGS) break;

        for (const win of buildWindows(msgs)) {
          if (windowsDone >= MAX_WINDOWS_PER_RUN) break;
          const { text, refMap } = serializeWindow(win);
          let units = [];
          try {
            const raw = await callClaude({
              system: EXTRACT_SYSTEM,
              user: 'Channel: ' + ch.name + '\n\n' + text,
              model: EXTRACT_MODEL,
              maxTokens: 6000,
              temperature: 0,
            });
            units = validateUnits(parseJsonLoose(raw), refMap);
          } catch (e) {
            console.error('[extract] window failed in ' + ch.name + ': ' + e.message);
          }
          for (const u of units) {
            insertKnowledge({ ...u, channel_id: ch.channel_id, created_ts: Date.now() });
            unitsAdded++;
          }
          cursor = win[win.length - 1].created_ts;
          setExtractCursor(ch.channel_id, cursor);
          windowsDone++;
        }
      }
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if (windowsDone) {
      console.log('[extract] ' + windowsDone + ' windows -> ' + unitsAdded + ' knowledge units in ' + secs + 's');
    }
    return { windowsDone, unitsAdded };
  } finally {
    extracting = false;
  }
}

export function backlogReport() {
  return allChannelRows()
    .filter((c) => c.backfill_done)
    .map((c) => ({ name: c.name, backlog: extractionBacklog(c.channel_id, getExtractCursor(c.channel_id)) }))
    .filter((r) => r.backlog > 0);
}

export function startExtractCron() {
  const expr = process.env.KB_EXTRACT_CRON || '15 * * * *'; // hourly at :15
  cron.schedule(expr, () => {
    runExtraction().catch((e) => console.error('[extract] cron failed:', e.message));
  }, { timezone: process.env.KB_TZ || 'UTC' });
  console.log("[extract] cron '" + expr + "' — model " + EXTRACT_MODEL +
    ', max ' + MAX_WINDOWS_PER_RUN + ' windows/run');
}
