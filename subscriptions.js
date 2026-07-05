/** Follow-caller and watch-token subscriptions. */
import { sendDM } from './dmRouter.js';
import { resolveUserInputToKey } from './chains.js';

export function ensureSubscriptionsDb(db) {
  db.subscriptions = db.subscriptions || { followCaller: {}, watchToken: {} };
  if (!db.subscriptions.followCaller) db.subscriptions.followCaller = {};
  if (!db.subscriptions.watchToken) db.subscriptions.watchToken = {};
  return db.subscriptions;
}

export function followCaller(db, callerUserId, subscriberId) {
  const subs = ensureSubscriptionsDb(db);
  const list = subs.followCaller[callerUserId] = subs.followCaller[callerUserId] || [];
  if (!list.includes(subscriberId)) list.push(subscriberId);
}

export function unfollowCaller(db, callerUserId, subscriberId) {
  const subs = ensureSubscriptionsDb(db);
  const list = subs.followCaller[callerUserId];
  if (!list || !list.includes(subscriberId)) return false;
  subs.followCaller[callerUserId] = list.filter((id) => id !== subscriberId);
  return true;
}

export function watchToken(db, mint, subscriberId) {
  const subs = ensureSubscriptionsDb(db);
  const list = subs.watchToken[mint] = subs.watchToken[mint] || [];
  if (!list.includes(subscriberId)) list.push(subscriberId);
}

export function unwatchToken(db, mint, subscriberId) {
  const subs = ensureSubscriptionsDb(db);
  const list = subs.watchToken[mint];
  if (!list || !list.includes(subscriberId)) return false;
  subs.watchToken[mint] = list.filter((id) => id !== subscriberId);
  return true;
}

export async function notifyFollowSubscribers(client, db, entry, mint, embed) {
  const subs = ensureSubscriptionsDb(db);
  const list = subs.followCaller[entry.postedByUserId] || [];
  for (const subId of list) {
    if (subId === entry.postedByUserId) continue;
    await sendDM(client, subId, embed, subId + ':' + mint + ':newcall', 60_000);
  }
}

export async function notifyWatchSubscribers(client, db, mint, embed, alertKind, postedByUserId) {
  const subs = ensureSubscriptionsDb(db);
  const list = subs.watchToken[mint] || [];
  for (const subId of list) {
    if (subId === postedByUserId) continue;
    await sendDM(client, subId, embed, subId + ':' + mint + ':' + alertKind, 60_000);
  }
}

export function resolveMintForCommand(db, rawInput) {
  return resolveUserInputToKey(db, rawInput);
}
