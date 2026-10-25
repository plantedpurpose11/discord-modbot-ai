const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const ipaddr = require('ipaddr.js');
function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
function parseURL(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Unsupported URL scheme, credentials or port');
  url.hash = '';
  return url;
}
async function resolvePublic(url, lookup = dns.lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Non-public network destination blocked');
  return addresses[0];
}
function request(url, address, maxBytes, timeout) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.get(url, {
      agent: false, // A fresh socket, pinned DNS result, no shared cookies or proxy.
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: { 'User-Agent': 'Sentinel-LinkInspector/1.0', Accept: 'text/html,text/plain,image/*,application/octet-stream;q=0.5', 'Accept-Encoding': 'identity' },
    });
    const fail = error => { reject(error); req.destroy(error); };
    const timer = setTimeout(() => fail(new Error('Inspection timed out')), timeout);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.on('response', res => {
      res.on('error', reject);
      if (res.statusCode >= 300 && res.statusCode < 400) { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) }); res.destroy(); return; }
      if (Number(res.headers['content-length'] || 0) > maxBytes || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        fail(new Error('Response too large or compressed')); return;
      }
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) fail(new Error('Response exceeds inspection size limit'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
  });
}
async function fetchPublic(input, { maxBytes = 262144, timeoutMs = 12000, maxRedirects = 3, onURL = () => {}, lookup, transport = request } = {}) {
  const deadline = Date.now() + timeoutMs;
  let url = parseURL(input); const visited = new Set(); const hops = [];
  for (let n = 0; n <= maxRedirects; n++) {
    if (visited.has(url.href)) throw new Error('Redirect loop');
    visited.add(url.href); hops.push(url.href);
    onURL(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Inspection timed out');
    let timer;
    const address = await Promise.race([resolvePublic(url, lookup), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timed out')), remaining); })]).finally(() => clearTimeout(timer));
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('Inspection timed out');
    const response = await transport(url, address, maxBytes, timeout);
    if (response.status >= 300 && response.status < 400) {
      if (!response.headers.location) throw new Error('Redirect without destination');
      url = parseURL(new URL(response.headers.location, url).href); continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Destination returned HTTP ${response.status}`);
    return { ...response, url: url.href, hops };
  }
  throw new Error('Too many redirects');
}
module.exports = { fetchPublic, parseURL, publicAddress, resolvePublic, request };
