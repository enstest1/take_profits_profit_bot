/**
 * Create an empty X list owned by X_COOKIES_JSON.
 * Prints only { id, name, isPrivate } — never cookies.
 *
 * Usage: node scripts/create-x-list.mjs "List name" "optional description"
 */
if (typeof ArrayBuffer.prototype.transfer !== 'function') {
  // x-client-transaction-id expects Node 22; polyfill so GraphQL signing works on 20.
  ArrayBuffer.prototype.transfer = function (newLen) {
    const len = newLen == null ? this.byteLength : newLen;
    const out = new ArrayBuffer(len);
    new Uint8Array(out).set(new Uint8Array(this).subarray(0, Math.min(this.byteLength, len)));
    return out;
  };
}

const { createList } = await import('../xradar/xClient.js');

const name = process.argv[2];
const description = process.argv[3] || '';
if (!name) {
  console.error('Usage: node scripts/create-x-list.mjs "<name>" ["<description>"]');
  process.exit(1);
}

const list = await createList({ name, description, isPrivate: true });
process.stdout.write(JSON.stringify(list) + '\n');
