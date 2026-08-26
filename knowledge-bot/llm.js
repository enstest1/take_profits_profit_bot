// llm.js — OpenRouter chat-completions helper for the knowledge bot (Node 18+ fetch)
//
// OpenRouter is OpenAI-compatible. We keep the callClaude() name because extract
// and answer already import it; the wire is OpenRouter, not api.anthropic.com.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Read the OpenRouter key. Never fall back to ANTHROPIC_API_KEY — that hits a
 * different API and would 401 with an sk-or- key.
 * @returns {string}
 */
function openRouterKey() {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  return key;
}

/**
 * Flatten OpenAI-style message.content (string or text parts) to one string.
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text || ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Call Claude via OpenRouter (Haiku for extract, Sonnet for /ask).
 * @param {{ system: string, user: string, model: string, maxTokens?: number, temperature?: number }} opts
 * @returns {Promise<string>}
 */
export async function callClaude({ system, user, model, maxTokens = 4000, temperature = 0 }) {
  const key = openRouterKey();

  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          'HTTP-Referer': 'https://github.com/enstest1/take_profits_profit_bot',
          'X-Title': 'Take Profits Knowledge Bot',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2500 * attempt);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('OpenRouter API ' + res.status + ': ' + body.slice(0, 300));
    }
    const data = await res.json();
    const text = contentToText(data?.choices?.[0]?.message?.content).trim();
    if (text) return text;
    throw new Error('OpenRouter API: empty completion');
  }
  throw new Error('OpenRouter API: retries exhausted');
}

// Tolerant JSON extraction: strips code fences, finds the outermost array/object.
export function parseJsonLoose(text) {
  const stripped = (text || '')
    .replace(/^```(?:json)?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  const firstArr = stripped.indexOf('[');
  const firstObj = stripped.indexOf('{');
  let start = -1;
  let end = -1;
  if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
    start = firstArr;
    end = stripped.lastIndexOf(']');
  } else if (firstObj !== -1) {
    start = firstObj;
    end = stripped.lastIndexOf('}');
  }
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}
