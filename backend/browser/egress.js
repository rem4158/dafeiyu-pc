'use strict';

const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns/promises');
const crypto = require('node:crypto');
const { trustedHost } = require('./sites');

const reserved = new net.BlockList();
for (const [address, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) {
  reserved.addSubnet(address, bits);
}

// Connect to the exact public address checked here; Chrome still negotiates its own TLS.
async function publicAddress(host) {
  const matches = await dns.lookup(host, { all: true, family: 4 });
  if (!matches.length || matches.some(({ address }) => reserved.check(address))) throw new Error('Non-public target');
  return matches[0].address;
}

function publicHostname(host) {
  return host.includes('.') && !net.isIP(host) &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(host);
}

async function openProxy(allowedHost) {
  const password = crypto.randomBytes(18).toString('hex');
  const expected = 'Basic ' + Buffer.from('browser:' + password).toString('base64');
  const sockets = new Set();
  const addresses = new Map();
  let closed = false;
  function track(socket) {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  }
  const server = http.createServer((_req, res) => res.writeHead(403).end());
  server.on('connection', track);
  server.on('connect', async (req, client, head) => {
    if (req.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="browser"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const match = /^([a-z0-9.-]{1,253}):443$/i.exec(req.url);
    if (!match || !allowedHost(match[1]) || sockets.size > 160) return client.destroy();
    try {
      const host = match[1];
      if (!addresses.has(host)) addresses.set(host, publicAddress(host));
      const address = await addresses.get(host);
      if (closed || client.destroyed) return;
      const upstream = net.connect({ host: address, port: 443 });
      track(upstream);
      upstream.setTimeout(45000, () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch { client.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    proxy: { server: 'http://127.0.0.1:' + server.address().port, username: 'browser', password, bypass: '<-loopback>' },
    async close() {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

const openEgress = (site, manual) => openProxy(host => trustedHost(site, host, manual));
const openPublicEgress = () => openProxy(publicHostname);

module.exports = { openEgress, openPublicEgress, publicAddress, publicHostname };
