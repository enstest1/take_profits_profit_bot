/**
 * xradar/store.js — watched handles + following snapshots.
 *
 * Two isolated buckets so Take Profits never inherits the personal watch list:
 *   db.xRadar   — Bitcernals / personal (DEST_PERSONAL)
 *   db.xRadarTp — Take Profits (DEST_TP), starts empty
 *
 * Synchronous load-mutate-save, same as fib/store and xfeed/store — never
 * mutate a db object that has awaited since it was loaded, or a mid-poll
 * mergePollSnapshot can drop the write.
 */

import { loadDB, ensureDBSchema, patchXRadarNamed } from '../dbStore.js';
import { normalizeXHandle } from '../xSocial.js';
import { DEST_PERSONAL, DEST_TP } from './config.js';

const BUCKET = {
  [DEST_PERSONAL]: 'xRadar',
  [DEST_TP]: 'xRadarTp',
};

function bucketName(dest) {
  return BUCKET[dest] || BUCKET[DEST_PERSONAL];
}

function read(dest = DEST_PERSONAL) {
  const db = ensureDBSchema(loadDB());
  const name = bucketName(dest);
  if (!db[name]) db[name] = { users: {}, snapshots: {} };
  if (!db[name].users) db[name].users = {};
  if (!db[name].snapshots) db[name].snapshots = {};
  return db[name];
}

function update(dest, mutator) {
  return patchXRadarNamed(bucketName(dest), mutator);
}

export function listWatched(dest = DEST_PERSONAL) {
  return { ...read(dest).users };
}

export function listWatchedHandles(dest = DEST_PERSONAL) {
  return Object.keys(listWatched(dest));
}

/**
 * Persist a handle after X resolved it. Returns { added, user } — added=false
 * when the handle was already watched on this dest.
 */
export function addWatched(handle, profile, dest = DEST_PERSONAL) {
  const key = normalizeXHandle(handle);
  if (!key) return { added: false, user: null, error: 'bad_handle' };
  return update(dest, (xr) => {
    const existing = xr.users[key];
    if (existing) {
      // Env seed often has no id — fill it in the first time X resolves the handle.
      if (profile?.id && !existing.id) {
        existing.id = profile.id;
        existing.name = profile.name || existing.name;
        existing.username = profile.username || existing.username || key;
      }
      return { added: false, user: existing };
    }
    const user = {
      id: profile?.id || '',
      name: profile?.name || '',
      username: profile.username || key,
      addedAt: Date.now(),
    };
    xr.users[key] = user;
    console.log('[xradar] watching @' + key + ' dest=' + dest + (user.id ? ' id=' + user.id : ''));
    return { added: true, user };
  });
}

export function removeWatched(handle, dest = DEST_PERSONAL) {
  const key = normalizeXHandle(handle);
  if (!key) return false;
  return update(dest, (xr) => {
    if (!xr.users[key]) return false;
    delete xr.users[key];
    delete xr.snapshots[key];
    console.log('[xradar] stopped watching @' + key + ' dest=' + dest);
    return true;
  });
}

export function getSnapshot(handle, dest = DEST_PERSONAL) {
  return read(dest).snapshots[handle] || null;
}

/** Replace the following-id set for a handle (first run and every successful poll). */
export function writeSnapshot(handle, userIds, dest = DEST_PERSONAL) {
  update(dest, (xr) => {
    const ids = {};
    for (const id of userIds) {
      if (id) ids[String(id)] = true;
    }
    xr.snapshots[handle] = { ids, capturedAt: Date.now() };
  });
}

/** Seed env handles into the personal watch list without resolving ids. */
export function seedHandles(handles, dest = DEST_PERSONAL) {
  let added = 0;
  for (const raw of handles || []) {
    const key = normalizeXHandle(raw);
    if (!key) continue;
    const result = addWatched(key, { username: key }, dest);
    if (result.added) added += 1;
  }
  if (added) console.log('[xradar] seeded ' + added + ' handle(s) from XRADAR_HANDLES dest=' + dest);
  return added;
}
