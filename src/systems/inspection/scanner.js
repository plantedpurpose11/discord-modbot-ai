const { createHash } = require('node:crypto');
const { Parser } = require('htmlparser2');
const sharp = require('sharp');
const jsQR = require('jsqr');
const { fetchPublic } = require('./fetch');
const { scanAntivirus } = require('./antivirus');
const { checkLocalPatterns } = require('../moderation/patterns');
const digest = data => createHash('sha256').update(data).digest('hex');
function extractLinks(text) {
  return [...new Set((text.match(/(?:https?:\/\/|www\.)[^\s<>"`]+/gi) || []).map(value => (value.startsWith('www.') ? `https://${value}` : value).replace(/[),.;!?]+$/, '')))];
}
function htmlEvidence(buffer) {
  let text = ''; let hidden = 0; const destinations = [];
  const parser = new Parser({
    onopentag(name, attrs) {
      if (['script', 'style', 'noscript'].includes(name)) hidden++;
      if (name === 'form' && attrs.action) destinations.push(attrs.action);
      if (name === 'meta' && attrs['http-equiv']?.toLowerCase() === 'refresh') destinations.push((attrs.content || '').replace(/^.*?url\s*=\s*/i, '').replace(/^['"]|['"]$/g, ''));
    },
    onclosetag(name) { if (['script', 'style', 'noscript'].includes(name)) hidden = Math.max(0, hidden - 1); },
    ontext(value) { if (!hidden && text.length < 12000) text += `${value} `; },
  }, { decodeEntities: true });
  parser.end(buffer.toString('utf8'));
  return { truncated: text.length > 6000 || destinations.length > 10, text: text.replace(/\s+/g, ' ').trim().slice(0, 6000), destinations: destinations.slice(0, 10) };
}
function dangerous(name, buffer = Buffer.alloc(0)) {
  return /\.(?:exe|scr|com|msi|dll|bat|cmd|ps1|vbs|js|jar|lnk|hta|sh|app|apk)$/i.test(name)
    || buffer.subarray(0, 2).toString() === 'MZ' || buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
}
function attachmentIdentity(message) {
  return [...(message.attachments?.values() || [])].map(a => ({ id: a.id, name: a.name, size: a.size, url: a.url ? a.url.split('?')[0] : '' }));
}
class Inspector {
  constructor({ fetch = fetchPublic, antivirus = scanAntivirus } = {}) { this.fetch = fetch; this.antivirus = antivirus; this.active = 0; }
  async inspect(message, config) {
    const attachments = config.scanAttachments ? [...(message.attachments?.values() || [])] : [];
    const links = config.inspectLinks ? extractLinks(message.content) : [];
    const result = { evidence: [], images: [], issues: [], verdict: null, hasMedia: attachments.length > 0 || links.length > 0 };
    if (!result.hasMedia) return result;
    if (this.active >= 3) return { ...result, issues: ['Inspector busy; content not scanned'] };
    this.active++;
    const deadline = Date.now() + 20000;
    const policy = url => {
      const verdict = checkLocalPatterns(url.href, config);
      if (verdict.category !== 'safe') { result.verdict = verdict; throw new Error('Destination violates server policy'); }
    };
    const fetch = (url, maxBytes) => this.fetch(url, { maxBytes, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())), onURL: policy });
    try {
      if (attachments.length > config.maxAttachments) result.issues.push('Attachment count exceeds inspection limit');
      for (const attachment of attachments.slice(0, config.maxAttachments)) {
        const name = String(attachment.name || 'unnamed').slice(0, 120);
        try {
          if (config.blockDangerousFiles && dangerous(name)) { result.verdict = { category: 'dangerous_file', confidence: 1, reason: 'Executable/script attachment blocked by policy', source: 'attachment' }; continue; }
          if (attachment.size > config.maxAttachmentBytes || Date.now() >= deadline) throw new Error('Attachment exceeds size or time limit');
          // Only Discord attachment CDN hosts, validated again for each redirect.
          const response = await this.fetch(attachment.url, { maxBytes: config.maxAttachmentBytes, timeoutMs: Math.max(1, Math.min(10000, deadline - Date.now())), onURL: url => {
            if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) throw new Error('Attachment host is not Discord CDN');
          } });
          const bytes = response.body;
          result.evidence.push(`Attachment ${name}: sha256=${digest(bytes)}`);
          const av = await this.antivirus(bytes);
          if (av === 'infected') { result.verdict = { category: 'malware', confidence: 1, reason: 'Antivirus detected an infected attachment', source: 'clamav' }; continue; }
          if (config.blockDangerousFiles && dangerous(name, bytes)) { result.verdict = { category: 'dangerous_file', confidence: 1, reason: 'Executable file signature detected', source: 'attachment' }; continue; }
          const image = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(0, 3).toString() === 'GIF' || (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
          if (image) {
            const metadata = await sharp(bytes, { limitInputPixels: 16000000 }).metadata();
            if ((metadata.pages || 1) > 1) result.issues.push(`${name}: animated image; only first frame inspected`);
            const resized = sharp(bytes, { limitInputPixels: 16000000, pages: 1 }).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true });
            const { data, info } = await resized.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            const qr = jsQR(new Uint8ClampedArray(data), info.width, info.height);
            if (qr) { result.evidence.push(`QR content: ${qr.data.slice(0, 2000)}`); if (config.inspectLinks) links.push(...extractLinks(qr.data)); }
            result.images.push((await resized.jpeg({ quality: 75 }).toBuffer()).toString('base64'));
          } else if (/\.(?:txt|csv|json|md|log|html?)$/i.test(name) && !bytes.includes(0)) {
            if (bytes.length > 6000) result.issues.push(`${name}: text exceeds AI inspection limit`);
            const text = /\.html?$/i.test(name) ? htmlEvidence(bytes).text : bytes.toString('utf8').slice(0, 6000);
            result.evidence.push(`File text: ${text}`);
            if (config.inspectLinks) links.push(...extractLinks(text));
          } else result.issues.push(`${name}: unsupported content format; antivirus ${av}`);
        } catch (error) { result.issues.push(`${name}: ${safeError(error)}`); }
      }
      const unique = [...new Set(links)];
      if (unique.length > config.maxLinks) result.issues.push('Link count exceeds inspection limit');
      for (const url of unique.slice(0, config.maxLinks)) {
        try {
          if (Date.now() >= deadline) throw new Error('Inspection time limit exceeded');
          const page = await fetch(url, 262144);
          const type = String(page.headers['content-type'] || '');
          const path = new URL(page.url).pathname;
          if (config.blockDangerousFiles && dangerous(path, page.body)) { result.verdict = { category: 'dangerous_file', confidence: 1, reason: 'Link destination serves executable content', source: 'link' }; continue; }
          if (!/^(text\/html|text\/plain|application\/xhtml\+xml)/i.test(type)) throw new Error('Destination content type not supported');
          const parsed = /html/i.test(type) ? htmlEvidence(page.body) : { text: page.body.toString('utf8').slice(0, 6000), destinations: [] };
          if (parsed.truncated || (!/html/i.test(type) && page.body.length > 6000)) result.issues.push('Destination text exceeds AI inspection limit');
          if (!parsed.text.trim()) result.issues.push('Destination has no readable text; client-side content not executed');
          const targets = parsed.destinations.map(target => { try { const resolved = new URL(target, page.url); policy(resolved); return resolved.href; } catch (error) { if (result.verdict) throw error; return '[invalid destination]'; } });
          result.evidence.push(JSON.stringify({ redirects: page.hops, destination: page.url, sha256: digest(page.body), text: parsed.text, formOrRefreshTargets: targets }));
        } catch (error) { result.issues.push(`Link inspection: ${safeError(error)}`); }
      }
      // Includes extracted document text and QR payloads without treating it as instructions.
      const extracted = checkLocalPatterns(result.evidence.join('\n'), config);
      if (extracted.category !== 'safe' && !result.verdict) result.verdict = extracted;
      return result;
    } finally { this.active--; }
  }
}
function safeError(error) { return ['Error', 'TypeError'].includes(error.name) && !/https?:|token|key|password/i.test(error.message) ? error.message.slice(0, 120) : 'Scan failed; staff review required'; }
module.exports = { Inspector, extractLinks, htmlEvidence, dangerous, attachmentIdentity, digest };
