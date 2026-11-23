'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createBrowserAuth } = require('./auth');

test('PC verification supports cancellation, expiry, one-time replies and manual resume', async () => {
  let time = 100;
  const auth = createBrowserAuth({ expireMs: 10000, now: () => time });
  const pc = auth.requestCode({ site: 'tieba', method: 'sms' });
  const { id, expiresAt } = auth.pending();
  await assert.rejects(auth.requestCode({ site: 'zhihu', method: 'email' }), { code: 'browser_challenge_busy' });
  assert.throws(() => auth.submit({ id, code: '1' }), { code: 'browser_challenge_invalid' });
  auth.submit({ id, code: '012345' });
  assert.equal(await pc, '012345');
  assert.throws(() => auth.submit({ id, code: '012345' }), { status: 410 });
  const stop = new AbortController();
  const aborted = auth.requestCode({ site: 'zhihu', method: 'email', signal: stop.signal });
  stop.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  const expired = auth.requestCode({ site: 'zhihu', method: 'sms' });
  time = expiresAt;
  assert.equal(auth.pending(), null);
  await assert.rejects(expired, { code: 'browser_challenge_expired' });
  const manual = auth.onManualChallenge({ site: 'hupu' });
  assert.equal(auth.pending().method, 'manual');
  assert.throws(() => auth.submit({ id: auth.pending().id, code: '012345' }), { status: 400 });
  auth.submit({ id: auth.pending().id, confirmed: true });
  await manual;
  const declined = auth.onManualChallenge({ site: 'xiaohongshu' });
  auth.cancel({ id: auth.pending().id });
  await assert.rejects(declined, { code: 'browser_challenge_declined' });
  const waiting = auth.requestCode({ site: 'zhihu', method: 'sms' });
  auth.close();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('credentials are session-only by default; remember needs encryption and recovers in another instance', () => {
  const temp = fs.realpathSync.native(path.resolve(__dirname, '../../temp'));
  const dir = fs.mkdtempSync(path.join(temp, 'browser-credentials-'));
  const file = path.join(dir, 'fixture.enc');
  const key = crypto.randomBytes(32);
  // Stand-in for Electron safeStorage; the real OS protector is never invoked here.
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString(text) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(buffer) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString();
    } };
  const values = { username: 'fixture-user', password: 'fixture-password' };
  try {
    const unprotected = createBrowserAuth({ credentialFile: file });
    assert.throws(() => unprotected.setCredentials({ site: 'hupu', ...values, remember: true }), { status: 503 });
    assert.throws(() => unprotected.setCredentials({ site: 'hupu', username: '', password: 'fixture' }), { status: 400 });
    unprotected.setCredentials({ site: 'xiaohongshu', username: 'example-user', password: '' });
    assert.deepEqual(unprotected.getCredentials({ site: 'xiaohongshu' }), { username: 'example-user', password: '' });
    unprotected.setCredentials({ site: 'hupu', ...values });
    assert.equal(fs.existsSync(file), false);
    assert.equal(unprotected.accountStatus().canRemember, false);
    unprotected.close();
    assert.equal(unprotected.getCredentials({ site: 'hupu' }), null);
    const protectedAuth = createBrowserAuth({ credentialFile: file, safeStorage });
    const status = protectedAuth.setCredentials({ site: 'zhihu', ...values, remember: true });
    assert.deepEqual(status.remembered, ['zhihu']);
    assert.ok(!JSON.stringify(status).includes('fixture-'));
    assert.ok(!fs.readFileSync(file, 'utf8').includes('fixture-'));
    protectedAuth.close();
    const reopened = createBrowserAuth({ credentialFile: file, safeStorage });
    assert.deepEqual(reopened.getCredentials({ site: 'zhihu' }), values);
    reopened.setCredentials({ site: 'zhihu', username: '', password: '' });
    assert.deepEqual(reopened.accountStatus().sites, []);
    reopened.close();
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
