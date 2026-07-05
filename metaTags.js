/** Token meta tags — /tag command helpers. */
import { CFG } from './signals/config.js';

const TAG_RE = /^[a-z0-9_-]{2,16}$/;

export function parseTagsInput(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

export function validateTags(tags) {
  if (tags.length > CFG.MAX_TAGS) {
    return { ok: false, error: 'Max ' + CFG.MAX_TAGS + ' tags allowed (got ' + tags.length + ').' };
  }
  for (const t of tags) {
    if (!TAG_RE.test(t)) {
      return { ok: false, error: 'Invalid tag `' + t + '` — use lowercase a-z, 0-9, _, - (2–16 chars).' };
    }
  }
  return { ok: true, tags };
}

export function applyTags(entry, tags) {
  entry.tags = tags.slice(0, CFG.MAX_TAGS);
}
