// answer.js — retrieval + generation pipelines for the knowledge bot:
// /ask (RAG with jump-link citations), /search (verbatim), /guide, /faq,
// and the weekly knowledge roundup.

import { callClaude } from './llm.js';
import {
  searchKnowledge,
  searchMessages,
  knowledgeSince,
  knowledgeByKind,
  getMessagesByIds,
  logQa,
} from './db.js';

const ANSWER_MODEL = process.env.KB_ANSWER_MODEL || 'anthropic/claude-sonnet-4.6';

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const ANSWER_SYSTEM = `You answer questions for a Discord community using ONLY the knowledge units provided. Each unit is labeled [K1], [K2], ...

Rules:
- Answer ONLY from the units. If they don't contain the answer, say so plainly and suggest what to ask in the server instead. Never fill gaps from outside knowledge.
- Cite the units you used inline, like: "Use the staging flag first [K2]." Cite only units you actually relied on.
- Preserve URLs, commands, and code from the units verbatim.
- If units disagree, say so and present both, citing each.
- Concise Discord markdown. No preamble, no "based on the knowledge provided".
- Under 1600 characters total.`;

const GUIDE_SYSTEM = `You compose a structured guide for a Discord community from the knowledge units provided ([K1], [K2], ...). The reader is a beginner to this topic.

Structure:
# <Guide title>
> One-line description of who this is for.
## Start here — the 3-5 most important things, in learning order
## Core concepts — explanations, each 2-4 sentences
## How-tos & recipes — concrete steps, commands verbatim
## Resources — links with one-line context each (URLs verbatim)
## Pitfalls & warnings
## Open questions — things the community hasn't answered yet (only if evident)

Rules:
- Use ONLY the provided units; note gaps honestly rather than inventing content.
- Cite sparingly: at most one [K#] per bullet/paragraph, only where a reader would want the source.
- Markdown output only. Under 3500 words.`;

const FAQ_SYSTEM = `You compose an FAQ for a Discord community from the Q&A knowledge units provided ([K1], [K2], ...).

- Pick the most broadly useful questions (max 12), deduplicate near-identical ones, order from beginner to advanced.
- Format each as: **Q: <question>**\nA: <answer, tightened, URLs/commands verbatim> [K#]
- Use ONLY the provided units. Markdown output only.`;

const ROUNDUP_SYSTEM = `You write the weekly knowledge roundup for a Discord community from this week's knowledge units ([K1], [K2], ...).

Format:
**📚 This week the server learned:**
Group by topic, one tight bullet per item, most useful first. Cite [K#] per bullet. Include new resources (URLs verbatim) and any warnings prominently. Skip filler. Under 1800 characters. If there is genuinely little, keep it short — never pad.`;

// ---------------------------------------------------------------------------
// Retrieval + citation plumbing
// ---------------------------------------------------------------------------

function unitBlock(units) {
  return units
    .map((u, i) => {
      const authors = safeParse(u.authors, []);
      return (
        '[K' + (i + 1) + '] (' + u.kind + (u.topic ? ' · ' + u.topic : '') + ')\n' +
        u.title + '\n' + u.body +
        (authors.length ? '\n— from: ' + authors.join(', ') : '')
      );
    })
    .join('\n\n---\n\n');
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json ?? '') ?? fallback;
  } catch {
    return fallback;
  }
}

export function jumpLink(guildId, channelId, msgId) {
  return 'https://discord.com/channels/' + guildId + '/' + channelId + '/' + msgId;
}

// Map cited [K#] tags back to source-message jump links (receipts).
export function buildCitations(answerText, units) {
  const cited = new Set();
  for (const m of answerText.matchAll(/\[K(\d+)\]/g)) {
    const idx = Number(m[1]) - 1;
    if (units[idx]) cited.add(idx);
  }
  const lines = [];
  for (const idx of [...cited].sort((a, b) => a - b)) {
    const u = units[idx];
    const ids = safeParse(u.source_ids, []).slice(0, 2);
    const msgs = getMessagesByIds(ids);
    const links = msgs
      .filter((m) => m.guild_id)
      .map((m) => jumpLink(m.guild_id, m.channel_id, m.msg_id));
    lines.push('[K' + (idx + 1) + '] ' + u.title + (links.length ? ' — ' + links.join(' · ') : ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export async function ask(question, userId = null) {
  const units = searchKnowledge(question, 12);
  if (!units.length) {
    return {
      answer:
        "The archive doesn't have anything on that yet. Try /search for raw messages, or ask in the server — once it's answered, I'll learn it.",
      citations: [],
      qaId: userId ? logQa(userId, question, '(no results)') : null,
    };
  }
  const answer = await callClaude({
    system: ANSWER_SYSTEM,
    user: 'QUESTION: ' + question + '\n\nKNOWLEDGE UNITS:\n\n' + unitBlock(units),
    model: ANSWER_MODEL,
    maxTokens: 1500,
    temperature: 0.2,
  });
  const citations = buildCitations(answer, units);
  const qaId = userId ? logQa(userId, question, answer) : null;
  return { answer, citations, qaId };
}

export function verbatimSearch(query, limit = 6) {
  return searchMessages(query, limit).map((m) => ({
    author: m.author_name,
    when: new Date(m.created_ts).toISOString().slice(0, 10),
    snippet: (m.content || '').slice(0, 180),
    link: m.guild_id ? jumpLink(m.guild_id, m.channel_id, m.msg_id) : null,
  }));
}

export async function makeGuide(topic) {
  const units = searchKnowledge(topic, 30);
  if (units.length < 3) {
    return { md: null, note: 'Not enough archived knowledge on "' + topic + '" yet (found ' + units.length + ' units).' };
  }
  const md = await callClaude({
    system: GUIDE_SYSTEM,
    user: 'GUIDE TOPIC: ' + topic + '\n\nKNOWLEDGE UNITS:\n\n' + unitBlock(units),
    model: ANSWER_MODEL,
    maxTokens: 8000,
    temperature: 0.3,
  });
  const sources = buildCitations(md, units);
  return { md: md + (sources.length ? '\n\n## Sources\n' + sources.map((s) => '- ' + s).join('\n') : ''), note: null };
}

export async function makeFaq(topic = null) {
  const units = topic ? searchKnowledge(topic, 30).filter((u) => u.kind === 'qa') : knowledgeByKind('qa', 40);
  if (units.length < 3) {
    return { md: null, note: 'Not enough answered questions archived yet' + (topic ? ' for "' + topic + '"' : '') + '.' };
  }
  const md = await callClaude({
    system: FAQ_SYSTEM,
    user: (topic ? 'FAQ TOPIC: ' + topic + '\n\n' : '') + 'Q&A UNITS:\n\n' + unitBlock(units),
    model: ANSWER_MODEL,
    maxTokens: 4000,
    temperature: 0.2,
  });
  return { md, note: null };
}

export async function makeRoundup(days = 7) {
  const units = knowledgeSince(Date.now() - days * 24 * 3600 * 1000, 80);
  if (!units.length) return { text: null, note: 'No new knowledge extracted in the last ' + days + ' days.' };
  const text = await callClaude({
    system: ROUNDUP_SYSTEM,
    user: 'UNITS FROM THE LAST ' + days + ' DAYS:\n\n' + unitBlock(units),
    model: ANSWER_MODEL,
    maxTokens: 1500,
    temperature: 0.3,
  });
  const citations = buildCitations(text, units).slice(0, 8);
  return { text, citations, note: null };
}
