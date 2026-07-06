/** /x slash command — profile + renames + group history + verdict. */
import { EmbedBuilder } from 'discord.js';
import {
  normalizeXHandle,
  xHistoryReportLine,
  chainHasRuggedToken,
  fmtCompact,
} from './xSocial.js';
import { resolveUserInputToKey } from './chains.js';

const CACHE_TTL_MS = 10 * 60 * 1000;
const reportCache = new Map();

/** Accept handle / query / username — Discord may cache older option names. */
function getXQuery(interaction) {
  const named =
    interaction.options.getString('handle') ||
    interaction.options.getString('query') ||
    interaction.options.getString('username');
  if (named) return named.trim();
  const data = interaction.options?.data || [];
  const strOpt = data.find((o) => o.type === 3 && o.value);
  return strOpt ? String(strOpt.value).trim() : '';
}

async function fetchProfile(handle) {
  if (!process.env.RAPIDAPI_KEY) return { ok: false, unavailable: true };
  try {
    const res = await fetch(
      'https://twitter241.p.rapidapi.com/user?username=' + encodeURIComponent(handle),
      {
        headers: {
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
          'x-rapidapi-host': 'twitter241.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) return { ok: false, unavailable: true };
    const twttr = await res.json();
    const userResult =
      twttr?.result?.data?.user?.result || twttr?.result || twttr?.user?.result || null;
    const core = userResult?.legacy || null;
    const userCore = userResult?.core || null;
    if (!core) return { ok: false, unavailable: true };
    const createdAtRaw = core.created_at || userCore?.created_at || null;
    const createdAt = createdAtRaw ? new Date(createdAtRaw) : null;
    const followers = core.followers_count || 0;
    const following = core.friends_count || 0;
    return {
      ok: true,
      createdAt,
      followers,
      following,
      ratio: following > 0 ? followers / following : null,
      paid: !!(core.verified || userResult?.is_blue_verified),
      profilePic: core.profile_image_url_https || userResult?.avatar?.image_url || null,
    };
  } catch {
    return { ok: false, unavailable: true };
  }
}

async function fetchRenames(handle) {
  try {
    const res = await fetch('https://api.memory.lol/v1/tw/' + encodeURIComponent(handle), {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, unavailable: true, prior: [] };
    const memory = await res.json();
    const prior = [];
    if (memory?.accounts) {
      const accountData = Object.values(memory.accounts)[0];
      if (accountData) {
        for (const name of Object.keys(accountData)) {
          if (name.toLowerCase() === handle.toLowerCase()) continue;
          const dates = accountData[name];
          const firstSeen = dates?.[0] || dates?.[dates.length - 1] || 'unknown';
          prior.push({
            name: normalizeXHandle(name) || name.toLowerCase(),
            dateRange: firstSeen,
          });
        }
      }
    }
    return { ok: true, prior };
  } catch {
    return { ok: false, unavailable: true, prior: [] };
  }
}

function fmtMonthYear(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

function parseRenameDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function evaluateVerdict(profile, renames, db, handleChain) {
  const reasons = [];
  let partial = !profile.ok || renames.unavailable;
  const ageDays =
    profile.ok && profile.createdAt
      ? Math.floor((Date.now() - profile.createdAt.getTime()) / 86400000)
      : null;

  const rug = chainHasRuggedToken(db, handleChain);
  if (rug.hit) {
    reasons.push('prior handle @' + rug.handle + ' tied to rugged $' + rug.symbol);
    return { level: 'DANGER', reasons, partial };
  }

  if (ageDays !== null && ageDays < 7) {
    reasons.push('account age < 7 days');
    return { level: 'DANGER', reasons, partial };
  }

  const twelveMonthsAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const recentRenames = (renames.prior || []).filter((r) => {
    const d = parseRenameDate(r.dateRange);
    return d && d.getTime() >= twelveMonthsAgo;
  });
  if (recentRenames.length >= 2) reasons.push('renamed ' + recentRenames.length + '× in 12 months');

  if (profile.ok && ageDays !== null && ageDays > 730) {
    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const newestRename = (renames.prior || [])
      .map((r) => parseRenameDate(r.dateRange))
      .filter(Boolean)
      .sort((a, b) => b - a)[0];
    if (newestRename && newestRename.getTime() >= sixMonthsAgo) {
      reasons.push('possible purchased account');
    }
  }

  if (ageDays !== null && ageDays < 30) reasons.push('account age < 30 days');

  if (profile.ok && profile.followers > 0 && profile.following / profile.followers > 3) {
    reasons.push('following/followers ratio > 3');
  }

  if (reasons.length) {
    return { level: 'WARN', reasons, partial };
  }
  return { level: 'OK', reasons: [], partial };
}

function verdictColor(level) {
  if (level === 'DANGER') return 0xe74c3c;
  if (level === 'WARN') return 0xf1c40f;
  return 0x2ecc71;
}

function resolveQueryToHandle(db, raw) {
  const trimmed = String(raw || '').trim();
  const caKey = resolveUserInputToKey(db, trimmed);
  if (caKey) {
    const entry = db.tokens[caKey] || db.archived?.[caKey];
    if (!entry?.xHandle) return { error: 'That token has no X account on record.' };
    return { handle: entry.xHandle };
  }
  const handle = normalizeXHandle(trimmed);
  if (handle) return { handle };
  return { error: "Couldn't parse that as an X account or tracked CA." };
}

export async function handleX(interaction, { loadDB, ensureDBSchema }) {
  const raw = getXQuery(interaction);
  const db = ensureDBSchema(loadDB());
  const resolved = resolveQueryToHandle(db, raw);

  if (resolved.error) {
    return interaction.reply({
      content: resolved.error || 'Missing X handle — try `/x handle:yourname`',
      ephemeral: true,
    });
  }

  await interaction.deferReply();
  const handle = resolved.handle;

  const cacheKey = handle;
  const cached = reportCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    console.log('[x] cache hit @' + handle);
    return interaction.editReply({ embeds: [cached.embed] });
  }

  const [profile, renames] = await Promise.all([fetchProfile(handle), fetchRenames(handle)]);
  const handleChain = [handle, ...(renames.prior || []).map((r) => r.name)].filter(
    (h, i, a) => h && a.indexOf(h) === i,
  );

  const lines = [];
  lines.push('𝕏 **@' + handle + '**');

  if (profile.unavailable) {
    lines.push('Profile: unavailable');
  } else if (profile.ok) {
    const ratioStr = profile.ratio != null ? profile.ratio.toFixed(2) : '—';
    const paid = profile.paid ? ' · ✔ paid' : '';
    lines.push(
      'Created ' +
        fmtMonthYear(profile.createdAt) +
        ' · ' +
        fmtCompact(profile.followers) +
        ' followers · following ' +
        fmtCompact(profile.following) +
        ' (ratio ' +
        ratioStr +
        ')' +
        paid,
    );
  }

  if (renames.unavailable) {
    lines.push('Renames: unavailable');
  } else if (!renames.prior?.length) {
    lines.push('Renames: none detected');
  } else {
    const renameParts = renames.prior
      .slice(0, 6)
      .map((r) => '@' + r.name + ' (' + (r.dateRange || 'unknown') + ')');
    lines.push('Renames (' + renames.prior.length + '): ' + renameParts.join(' ← '));
  }

  const histLine = xHistoryReportLine(db, handleChain);
  if (histLine) lines.push(histLine);

  const verdict = evaluateVerdict(profile, renames, db, handleChain);
  const verdictIcon = verdict.level === 'DANGER' ? '🚨' : verdict.level === 'WARN' ? '⚠️' : '✅';
  const reasonStr = verdict.reasons.length ? verdict.reasons.join(' · ') : 'no structural flags';
  const partial = verdict.partial ? ' (partial data)' : '';
  lines.push(
    '🛡️ X Risk: ' + verdictIcon + ' ' + verdict.level + ' — ' + reasonStr + partial,
  );

  const embed = new EmbedBuilder()
    .setColor(verdictColor(verdict.level))
    .setDescription(lines.join('\n').slice(0, 4000));
  if (profile.profilePic) embed.setThumbnail(profile.profilePic);

  reportCache.set(cacheKey, { at: Date.now(), embed });
  return interaction.editReply({ embeds: [embed] });
}
