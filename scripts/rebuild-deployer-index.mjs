#!/usr/bin/env node
/** One-time rebuild of db.deployers from tokens + archived. */
import { loadDB, saveDB, ensureDBSchema } from '../dbStore.js';
import { indexDeployer } from '../risk/deployers.js';

const db = ensureDBSchema(loadDB());
let count = 0;
for (const [mint, e] of Object.entries(db.tokens)) {
  if (e.devWallet) {
    indexDeployer(db, e.devWallet, mint);
    count += 1;
  }
}
for (const [mint, e] of Object.entries(db.archived || {})) {
  if (e.devWallet) {
    indexDeployer(db, e.devWallet, mint);
    count += 1;
  }
}
saveDB(db);
console.log('[rebuild-deployer-index] indexed ' + count + ' entries');
