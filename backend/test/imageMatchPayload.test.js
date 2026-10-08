const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'webhook.js'), 'utf8');
const m = src.match(/\/\/ IMAGE_MATCH[\s\S]*?\n(\s*try \{[\s\S]*?\} catch \(_imgErr\) \{[\s\S]*?\n\s*\})/);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function run(record, mocks) {
  const aiPayload = {};
  const req = (p) => {
    if (p === './whatsappAccounts') return { getAccountByPhoneNumber: mocks.getAccount };
    if (p === '../integrations/metaMedia') return { getMediaInfo: mocks.getInfo, downloadMediaBinary: mocks.download };
    throw new Error('unexpected require ' + p);
  };
  const fn = new AsyncFunction('record', 'aiPayload', 'require', 'console', m[1]);
  return fn(record, aiPayload, req, { log() {} }).then(() => aiPayload);
}
const ok = {
  getAccount: async () => ({ accessToken: 'tok' }),
  getInfo: async () => ({ url: 'https://x/y' }),
  download: async () => ({ buffer: Buffer.from('hello') }),
};
const rec = { media_url: 'MEDIA1', phone_number_id: 'PN1' };

test('block is located inside the image branch only', () => {
  assert.ok(m, 'IMAGE_MATCH block found');
  const i = src.indexOf("if (msgType === 'image')");
  const j = src.indexOf('image_base64');
  const k = src.indexOf("else if (msgType === 'interactive')");
  assert.ok(i > -1 && i < j && j < k);
});
test('success sets image_base64', async () => {
  const p = await run(rec, ok);
  assert.strictEqual(p.image_base64, Buffer.from('hello').toString('base64'));
});
test('no media_url -> no image_base64', async () => {
  assert.strictEqual((await run({ phone_number_id: 'PN1' }, ok)).image_base64, undefined);
});
test('no account/token -> no image_base64', async () => {
  const p = await run(rec, { ...ok, getAccount: async () => null });
  assert.strictEqual(p.image_base64, undefined);
});
test('download failure never throws, payload unchanged', async () => {
  const p = await run(rec, { ...ok, download: async () => { throw new Error('boom'); } });
  assert.deepStrictEqual(p, {});
});
test('over 8MB image is skipped', async () => {
  const p = await run(rec, { ...ok, download: async () => ({ buffer: Buffer.alloc(8 * 1024 * 1024 + 1) }) });
  assert.strictEqual(p.image_base64, undefined);
});