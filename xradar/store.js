/**
 * xradar/store.js — watched handles + following snapshots.
 *
 * db.xRadar = {
 *   users: { "<handle>": { id, name, addedAt } },
 *   snapshots: { "<handle>": { ids: { "<userId>": true }, capturedAt } },
 * }
 *
 * Synchronous load-mutate-save, same as fib/store and xfeed/store — never
 * mutate a db object that has awaited since it was loaded, or a mid-poll
 * mergePollSnapshot can drop the write.
 */

import { loadDB, ensureDBSchema, patchXRadar } from '../dbStore.js';
import { normalizeXHandle } from '../xSocial.js';

function read() {
  const db = ensureDBSchema(loadDB());
  if (!db.xRadar) db.xRadar = { users: {}, snapshots: {} };
  if (!db.xRadar.users) db.xRadar.users = {};
  if (!db.xRadar.snapshots) db.xRadar.snapshots = {};
  return db;
}

function update(mutator) {
  return patchXRadar(mutator);
}

export function listWatched() {
  return { ...read().xRadar.users };
}

export function listWatchedHandles() {
  return Object.keys(listWatched());
}

/**
 * Persist a handle after X resolved it. Returns { added, user } — added=false
 * when the handle was already watched.
 */
export function addWatched(handle, profile) {
  const key = normalizeXHandle(handle);
  if (!key) return { added: false, user: null, error: 'bad_handle' };
  return update((xr) => {
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
      username: profile?.username || key,
      addedAt: Date.now(),
    };
    xr.users[key] = user;
    console.log('[xradar] watching @' + key + (user.id ? ' id=' + user.id : ''));
    return { added: true, user };
  });
}

export function removeWatched(handle) {
  const key = normalizeXHandle(handle);
  if (!key) return false;
  return update((xr) => {
    if (!xr.users[key]) return false;
    delete xr.users[key];
    delete xr.snapshots[key];
    console.log('[xradar] stopped watching @' + key);
    return true;
  });
}

export function getSnapshot(handle) {
  return read().xRadar.snapshots[handle] || null;
}

/** Replace the following-id set for a handle (first run and every successful poll). */
export function writeSnapshot(handle, userIds) {
  update((xr) => {
    const ids = {};
    for (const id of userIds) {
      if (id) ids[String(id)] = true;
    }
    xr.snapshots[handle] = { ids, capturedAt: Date.now() };
  });
}

/** Seed env handles into the watch list without resolving ids (resolver fills those). */
export function seedHandles(handles) {
  let added = 0;
  for (const raw of handles || []) {
    const key = normalizeXHandle(raw);
    if (!key) continue;
    const result = addWatched(key, { username: key });
    if (result.added) added += 1;
  }
  if (added) console.log('[xradar] seeded ' + added + ' handle(s) from XRADAR_HANDLES');
  return added;
}
