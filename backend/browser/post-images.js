'use strict';

const https = require('node:https');
const { secureUrl, trustedHost, challengeImageHost } = require('./sites');
const { publicAddress } = require('./egress');

const maxBytes = 2 * 1024 * 1024;
function imageType(data) {
  if (data.length < 12) return null;
  if (data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'image/jpeg';
  if (data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  return null;
}

async function fetchPublicImage(url, headers, signal, method = 'GET') {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  timeout.throwIfAborted();
  // The system DNS lookup itself has no AbortSignal option.
  const address = await new Promise((resolve, reject) => {
    const stop = () => reject(timeout.reason);
    timeout.addEventListener('abort', stop, { once: true });
    publicAddress(url.hostname).then(resolve, reject).finally(() => timeout.removeEventListener('abort', stop));
  });
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, signal: timeout, family: 4, agent: false,
      lookup: (_host, _opts, cb) => cb(null, address, 4) }, res => {
      const contentType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (res.statusCode !== 200 || !/^image\/(?:png|jpeg|webp)\b/i.test(res.headers['content-type'] || '') ||
          Number(res.headers['content-length']) > maxBytes) {
        res.destroy(); reject(new Error('Unsupported image response')); return;
      }
      const chunks = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) res.destroy(new Error('Image exceeds budget'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), contentType, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function readVerificationImage(source, method, signal, origin) {
  const url = secureUrl(source);
  if (!url || !challengeImageHost('zhihu', url.hostname) || !['GET', 'HEAD'].includes(method)) return null;
  const headers = { Referer: 'https://www.zhihu.com/', Accept: 'image/png,image/jpeg,image/webp' };
  if (origin === 'https://www.zhihu.com') headers.Origin = origin;
  return fetchPublicImage(url, headers, signal, method);
}

async function readImage(site, item, referer, signal, fixtures) {
  const url = secureUrl(item.raw);
  if (!url || !trustedHost(site,url.hostname)) return null;
  let data;
  if (fixtures) {
    const fixture = fixtures.get(url.href);
    if (!Buffer.isBuffer(fixture?.body) || fixture.body.length > maxBytes) return null;
    data = fixture.body;
  } else {
    data = (await fetchPublicImage(url, { Referer: referer, Accept: 'image/png,image/jpeg,image/webp' }, signal)).body;
  }
  const mimeType = imageType(data);
  return mimeType ? { mimeType, data, source_url: item.url, alt: item.alt } : null;
}

module.exports = { readImage, readVerificationImage, imageType, maxBytes };
