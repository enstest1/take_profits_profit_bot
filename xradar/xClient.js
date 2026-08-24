/**
 * xradar/xClient.js — X (Twitter) access layer for the follow radar.
 *
 * Ported from take_profi_bot/src/x-client.ts (TypeScript → plain ESM JS).
 * Only the pieces the follow radar needs were carried over: cookie auth,
 * signed GraphQL requests, getUserByScreenName, getFollowingPage.
 *
 * Two access paths live here:
 *   • raw signed GraphQL (following list, user lookup) — X exposes no library
 *     method for these, so we sign requests ourselves
 *   • goat-x-pro's XProClient (list timelines, search) — used by the digest
 *
 * Auth model: browser cookies (auth_token + ct0) from an X Premium account,
 * supplied via X_COOKIES_JSON (raw JSON string) or X_COOKIES_PATH (file).
 * X validates x-client-transaction-id cryptographically on the Following
 * endpoint, so ClientTransaction signing is required — not optional.
 *
 * Everything here is best-effort and never throws into the poll loop; the
 * caller catches per-account.
 */

import path from 'path';
import fs from 'fs';
import { parseHTML } from 'linkedom';
import { ClientTransaction, handleXMigration } from 'x-client-transaction-id';

// ─── credentials ──────────────────────────────────────────────────────────────

let _credentials = null;

/** Cookies come from env JSON (preferred on Railway) or a file path. */
function loadCookieArray() {
  const raw = process.env.X_COOKIES_JSON;
  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error('X_COOKIES_JSON is not valid JSON: ' + e.message);
    }
  }
  const p = path.resolve(process.cwd(), process.env.X_COOKIES_PATH || './cookies.json');
  if (!fs.existsSync(p)) {
    throw new Error('No X cookies found — set X_COOKIES_JSON or X_COOKIES_PATH');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** → { authToken, csrfToken, cookieString } */
export function getCredentials() {
  if (_credentials) return _credentials;
  const cookies = loadCookieArray();
  const find = (name) => cookies.find((c) => c && c.name === name)?.value || '';
  const authToken = find('auth_token');
  const csrfToken = find('ct0');
  if (!authToken || !csrfToken) {
    throw new Error('X cookies missing auth_token or ct0');
  }
  const cookieString = cookies
    .filter((c) => c && c.name && c.value)
    .map((c) => c.name + '=' + c.value)
    .join('; ');
  _credentials = { authToken, csrfToken, cookieString };
  return _credentials;
}

export function invalidateCredentials() {
  _credentials = null;
  _client = null;
  invalidateClientTransaction();
}

// ─── goat-x-pro client (list timelines / search) ──────────────────────────────
// Lazy-loaded so the follow radar never pays the import cost when the digest
// is disabled, and so a missing optional dep degrades instead of crashing boot.

let _client = null;

async function getXClient() {
  if (_client) return _client;
  const mod = await import('goat-x-pro');
  const XProClient = mod.XProClient || mod.default?.XProClient;
  if (!XProClient) throw new Error('goat-x-pro: XProClient export not found');
  const opts = {};
  const raw = process.env.X_COOKIES_JSON;
  if (raw && raw.trim()) {
    opts.cookies = JSON.parse(raw);
  } else {
    opts.cookiesPath = path.resolve(process.cwd(), process.env.X_COOKIES_PATH || './cookies.json');
  }
  if (process.env.X_PROXY) opts.proxy = process.env.X_PROXY;
  _client = new XProClient(opts);
  await _client.login();
  console.log('[xradar] goat-x-pro client logged in');
  return _client;
}

/** Tweets from an X list (auto-paginated by goat-x-pro). Used by the digest. */
export async function getListTimeline(listId, options) {
  const client = await getXClient();
  return client.getListTimeline(listId, options);
}

/** Keyword search. Used as a fallback user-timeline path. */
export async function searchTweets(query, options) {
  const client = await getXClient();
  return client.search(query, options);
}

/**
 * Collect tweets from goat-x-pro's mixed return shapes (array, async
 * iterator, or { tweets }). Caps at `max` so a busy account cannot stall a tick.
 */
async function collectTweets(result, max) {
  const out = [];
  if (!result) return out;
  if (Array.isArray(result)) return result.slice(0, max);
  if (Array.isArray(result.tweets)) return result.tweets.slice(0, max);
  if (typeof result[Symbol.asyncIterator] === 'function') {
    for await (const tweet of result) {
      if (tweet) out.push(tweet);
      if (out.length >= max) break;
    }
    return out;
  }
  return out;
}

/**
 * Recent posts + replies for one handle. Prefer goat-x-pro's user timeline
 * methods; fall back to `from:handle` search so xfeed still works if the
 * library export name shifts.
 */
export async function getUserTimeline(username, options = {}) {
  const handle = String(username || '').replace(/^@/, '').trim();
  if (!handle) return [];
  const count = options.count || 20;
  const client = await getXClient();

  const candidates = [
    ['getTweetsAndReplies', () => client.getTweetsAndReplies(handle, count)],
    ['getUserTweetsAndReplies', () => client.getUserTweetsAndReplies(handle, { count })],
    ['getUserTweets', () => client.getUserTweets(handle, { count })],
    ['getTweets', () => client.getTweets(handle, count)],
  ];

  for (const [name, call] of candidates) {
    if (typeof client[name] !== 'function') continue;
    try {
      const tweets = await collectTweets(await call(), count);
      if (tweets.length) return tweets;
    } catch (e) {
      console.warn('[xradar] ' + name + '(@' + handle + ') failed: ' + e.message);
    }
  }

  const searched = await collectTweets(await client.search('from:' + handle, { count }), count);
  return searched;
}

export function invalidateXClient() {
  _client = null;
}

// ─── constants ────────────────────────────────────────────────────────────────

// Public x.com web bearer — the same token x.com's own web client uses.
const X_WEB_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// Browser-like headers. X's WAF returns empty-body 404s for requests that don't
// fingerprint as a real browser session, so this full set is load-bearing.
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  priority: 'u=1, i',
  'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'x-twitter-client-language': 'en',
  'x-twitter-active-user': 'yes',
  'x-twitter-auth-type': 'OAuth2Session',
  origin: 'https://x.com',
  referer: 'https://x.com/',
};

const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const USER_BY_SCREEN_NAME_FIELD_TOGGLES = {
  withPayments: false,
  withAuxiliaryUserLabels: true,
};

const FOLLOWERS_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// GraphQL operation IDs — override via env if X rotates them.
const USER_BY_SCREEN_NAME_QUERY_ID =
  process.env.X_USER_BY_SCREEN_NAME_QUERY_ID || 'IGgvgiOx4QZndDHuD3x9TQ';
const FOLLOWING_QUERY_ID = process.env.X_FOLLOWING_QUERY_ID || 'F42cDX8PDFxkbjjq6JrM2w';
const LIST_MEMBERS_QUERY_ID = process.env.X_LIST_MEMBERS_QUERY_ID || 'BQp2IEYkgxuSxqbTAr1e1g';
const LIST_ADD_MEMBER_QUERY_ID = process.env.X_LIST_ADD_MEMBER_QUERY_ID || 'EadD8ivrhZhYQr2pDmCpjA';
const LIST_REMOVE_MEMBER_QUERY_ID = process.env.X_LIST_REMOVE_MEMBER_QUERY_ID || 'B5tMzrMYuFHJex_4EXFTSw';

const LIST_MUTATION_FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

// ─── client transaction signing ───────────────────────────────────────────────

let _clientTx = null;
let _clientTxAt = 0;
const CLIENT_TX_TTL_MS = parseInt(process.env.CLIENT_TX_TTL_MS || String(30 * 60 * 1000), 10);

async function fetchXHomeDocument() {
  const creds = getCredentials();
  const res = await fetch('https://x.com/home', {
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      cookie: creds.cookieString,
      'user-agent': BROWSER_HEADERS['user-agent'],
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok) {
    const html = await res.text();
    return parseHTML(html).window.document;
  }
  console.warn('[xradar] /home fetch ' + res.status + ' — falling back to handleXMigration()');
  return handleXMigration();
}

async function getClientTransaction() {
  if (_clientTx && Date.now() - _clientTxAt > CLIENT_TX_TTL_MS) invalidateClientTransaction();
  if (!_clientTx) {
    const doc = await fetchXHomeDocument();
    _clientTx = await ClientTransaction.create(doc);
    _clientTxAt = Date.now();
    console.log('[xradar] ClientTransaction ready');
  }
  return _clientTx;
}

/** Pre-warm the signer at boot — avoids cold-start 404s on the first sweep. */
export async function warmClientTransaction() {
  await getClientTransaction();
}

export function invalidateClientTransaction() {
  _clientTx = null;
  _clientTxAt = 0;
}

async function generateTxId(graphqlPath, method = 'GET') {
  const tx = await getClientTransaction();
  return tx.generateTransactionId(method, '/i/api/graphql/' + graphqlPath);
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

export class XRateLimitError extends Error {
  constructor(pathName, retryAfterSec) {
    super('X rate limit (429) on ' + pathName);
    this.name = 'XRateLimitError';
    this.path = pathName;
    this.retryAfterSec = retryAfterSec;
  }
}

function parseRetryAfter(header) {
  if (!header) return null;
  const n = parseInt(header, 10);
  if (Number.isFinite(n) && n > 0) return n;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const sec = Math.ceil((date - Date.now()) / 1000);
    return sec > 0 ? sec : null;
  }
  return null;
}

function buildGraphQLUrl(pathName, variables, features, fieldToggles) {
  let url =
    'https://x.com/i/api/graphql/' +
    pathName +
    '?variables=' +
    encodeURIComponent(JSON.stringify(variables)) +
    '&features=' +
    encodeURIComponent(JSON.stringify(features));
  if (fieldToggles) url += '&fieldToggles=' + encodeURIComponent(JSON.stringify(fieldToggles));
  return url;
}

async function xGraphQL(pathName, variables, features, fieldToggles, options, retried = false) {
  const creds = getCredentials();
  const url = buildGraphQLUrl(pathName, variables, features, fieldToggles);
  const headers = {
    ...BROWSER_HEADERS,
    ...(options?.referer ? { referer: options.referer } : {}),
    authorization: X_WEB_BEARER,
    'x-csrf-token': creds.csrfToken,
    cookie: creds.cookieString,
    'content-type': 'application/json',
    'x-client-transaction-id': await generateTxId(pathName),
  };

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });

  if (res.status === 401 || res.status === 403) {
    invalidateCredentials();
    throw new Error('X auth failed (' + res.status + ') — cookies invalid or expired');
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new XRateLimitError(pathName, parseRetryAfter(res.headers.get('retry-after')));
    }
    // Stale transaction keys surface as empty-body 404s — refresh once and retry.
    if (res.status === 404 && !retried) {
      console.warn('[xradar] 404 on ' + pathName + ' — refreshing ClientTransaction, retrying');
      invalidateClientTransaction();
      return xGraphQL(pathName, variables, features, fieldToggles, options, true);
    }
    throw new Error('X GraphQL ' + res.status + ' on ' + pathName + ' — ' + body.slice(0, 200));
  }

  return res.json();
}

function mutationAlreadyOnList(text, json) {
  const blob = String(text || '') + ' ' + JSON.stringify(json?.errors || []);
  return /already.*(member|list)|is already a member|duplicate/i.test(blob);
}

function mutationNotOnList(text, json) {
  const blob = String(text || '') + ' ' + JSON.stringify(json?.errors || []);
  return /not a member|isn't a member|is not a member/i.test(blob);
}

/**
 * GraphQL mutations (ListAddMember / ListRemoveMember) are POST + JSON body.
 * GET signing would 404 these — ClientTransaction is method-sensitive.
 */
async function xGraphQLPost(pathName, variables, features, options, retried = false) {
  const creds = getCredentials();
  const queryId = String(pathName).split('/')[0];
  const url = 'https://x.com/i/api/graphql/' + pathName;
  const headers = {
    ...BROWSER_HEADERS,
    ...(options?.referer ? { referer: options.referer } : {}),
    authorization: X_WEB_BEARER,
    'x-csrf-token': creds.csrfToken,
    cookie: creds.cookieString,
    'content-type': 'application/json',
    'x-client-transaction-id': await generateTxId(pathName, 'POST'),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ queryId, variables, features }),
    signal: AbortSignal.timeout(20000),
  });

  const raw = await res.text().catch(() => '');
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  if (res.status === 401 || res.status === 403) {
    invalidateCredentials();
    throw new Error('X auth failed (' + res.status + ') — cookies invalid or expired');
  }

  if (!res.ok) {
    if (res.status === 429) {
      throw new XRateLimitError(pathName, parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status === 404 && !retried) {
      console.warn('[xradar] 404 on POST ' + pathName + ' — refreshing ClientTransaction, retrying');
      invalidateClientTransaction();
      return xGraphQLPost(pathName, variables, features, options, true);
    }
    if (options?.alreadyOk && mutationAlreadyOnList(raw, json)) return { already: true, data: json };
    if (options?.missingOk && mutationNotOnList(raw, json)) return { missing: true, data: json };
    throw new Error('X GraphQL POST ' + res.status + ' on ' + pathName + ' — ' + raw.slice(0, 200));
  }

  if (json?.errors?.length && !json?.data?.list) {
    if (options?.alreadyOk && mutationAlreadyOnList(raw, json)) return { already: true, data: json };
    if (options?.missingOk && mutationNotOnList(raw, json)) return { missing: true, data: json };
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }

  return json;
}

// ─── parsing ──────────────────────────────────────────────────────────────────

/** Parse a GraphQL user result (supports both legacy and core API shapes). */
export function parseGraphQLUserResult(result) {
  if (!result) return null;
  if (result.__typename === 'UserUnavailable') return null;
  const id = result.rest_id || '';
  if (!id) return null;

  const legacy = result.legacy || {};
  const core = result.core || {};
  const avatar = result.avatar || {};
  const profileImg = avatar.image_url || legacy.profile_image_url_https || '';

  return {
    id,
    username: String(core.screen_name || legacy.screen_name || '').trim(),
    name: String(core.name || legacy.name || '').trim(),
    bio: String(legacy.description || ''),
    followersCount: legacy.followers_count || 0,
    followingCount: legacy.friends_count || 0,
    avatarUrl: profileImg.replace('_normal', '_200x200'),
    isBlueVerified: result.is_blue_verified || false,
    createdAt: legacy.created_at ? String(legacy.created_at) : undefined,
    tweetCount: legacy.statuses_count || 0,
    isLegacyVerified: legacy.verified || false,
  };
}

function parseUserTimelinePage(data) {
  const timeline = data?.data?.user?.result?.timeline;
  const instructions = timeline?.timeline?.instructions || [];
  const users = [];
  let nextCursor = null;

  for (const instr of instructions) {
    if (instr?.type !== 'TimelineAddEntries') continue;
    for (const entry of instr.entries || []) {
      const entryId = entry?.entryId;
      if (entryId && String(entryId).startsWith('cursor-bottom')) {
        nextCursor = entry?.content?.value || null;
        continue;
      }
      const parsed = parseGraphQLUserResult(entry?.content?.itemContent?.user_results?.result);
      if (parsed) users.push(parsed);
    }
  }
  return { users, nextCursor };
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function getUserByScreenName(username) {
  const data = await xGraphQL(
    USER_BY_SCREEN_NAME_QUERY_ID + '/UserByScreenName',
    { screen_name: username, withGrokTranslatedBio: true },
    USER_BY_SCREEN_NAME_FEATURES,
    USER_BY_SCREEN_NAME_FIELD_TOGGLES,
  );
  const parsed = parseGraphQLUserResult(data?.data?.user?.result);
  if (!parsed) throw new Error('User @' + username + ' not found');
  return { ...parsed, username: parsed.username || username };
}

/** One page of accounts that `userId` follows (newest first). */
export async function getFollowingPage(userId, cursor, screenName) {
  const count = parseInt(process.env.FOLLOWING_PAGE_COUNT || '20', 10);
  const variables = { userId, count, includePromotedContent: false, withGrokTranslatedBio: true };
  if (cursor) variables.cursor = cursor;

  const handle = screenName ? String(screenName).replace(/^@/, '').trim() : '';
  const referer = handle ? 'https://x.com/' + handle + '/following' : undefined;

  const data = await xGraphQL(
    FOLLOWING_QUERY_ID + '/Following',
    variables,
    FOLLOWERS_FEATURES,
    undefined,
    { referer },
  );
  return parseUserTimelinePage(data);
}

/**
 * One page of an X list's members. Same timeline shape as Following, so it
 * reuses the same parser.
 *
 * Note: the ListMembers GraphQL operation id rotates occasionally — override
 * with X_LIST_MEMBERS_QUERY_ID if members stop resolving.
 */
export async function getListMembersPage(listId, cursor) {
  const variables = { listId: String(listId), count: 100, withSafetyModeUserFields: true };
  if (cursor) variables.cursor = cursor;

  const data = await xGraphQL(
    LIST_MEMBERS_QUERY_ID + '/ListMembers',
    variables,
    FOLLOWERS_FEATURES,
    undefined,
    { referer: 'https://x.com/i/lists/' + String(listId) + '/members' },
  );

  // ListMembers nests under data.list.members_timeline rather than data.user.
  const timeline = data?.data?.list?.members_timeline?.timeline
    || data?.data?.user?.result?.timeline?.timeline;
  const instructions = timeline?.instructions || [];
  const users = [];
  let nextCursor = null;

  for (const instr of instructions) {
    if (instr?.type !== 'TimelineAddEntries') continue;
    for (const entry of instr.entries || []) {
      if (String(entry?.entryId || '').startsWith('cursor-bottom')) {
        nextCursor = entry?.content?.value || null;
        continue;
      }
      const parsed = parseGraphQLUserResult(entry?.content?.itemContent?.user_results?.result);
      if (parsed) users.push(parsed);
    }
  }
  return { users, nextCursor };
}

/** Every member of a list, paginated. `max` caps how many we pull. */
export async function getListMembers(listId, max = 200) {
  const all = [];
  let cursor;
  for (let page = 0; page < 10 && all.length < max; page++) {
    const { users, nextCursor } = await getListMembersPage(listId, cursor);
    if (!users.length) break;
    all.push(...users);
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await new Promise((r) => setTimeout(r, 800)); // pace pagination
  }
  return all.slice(0, max);
}

/**
 * Add `userId` to a list the cookie account owns. Idempotent: already-a-member
 * is success so /xwatch can be re-run without erroring.
 */
export async function addListMember(listId, userId) {
  const data = await xGraphQLPost(
    LIST_ADD_MEMBER_QUERY_ID + '/ListAddMember',
    { listId: String(listId), userId: String(userId) },
    LIST_MUTATION_FEATURES,
    { referer: 'https://x.com/i/lists/' + String(listId), alreadyOk: true },
  );
  if (data?.already) return { already: true };
  if (data?.data?.list || data?.list) return { already: false };
  throw new Error('ListAddMember returned no list');
}

/**
 * Remove `userId` from the list. Idempotent: not-a-member is success so
 * /xwatch remove stays clean if they were follow-only.
 */
export async function removeListMember(listId, userId) {
  const data = await xGraphQLPost(
    LIST_REMOVE_MEMBER_QUERY_ID + '/ListRemoveMember',
    { listId: String(listId), userId: String(userId) },
    LIST_MUTATION_FEATURES,
    { referer: 'https://x.com/i/lists/' + String(listId), missingOk: true },
  );
  if (data?.missing) return { missing: true };
  return { missing: false };
}
