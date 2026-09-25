'use strict';
//
// Download helper shared by the engine and model installers.
//
// Design note (Apr 29): "but i wanted download for user, not manual install".
// Everything the app needs must arrive by pressing a button, so this has to
// cope with the realities of multi-GB model files: redirects, resumable partial
// downloads, progress reporting, and atomic completion so a half-file is never
// mistaken for an installed model.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { createHash } = require('crypto');

const MAX_REDIRECTS = 8;

function request(url, headers, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(url, { headers }, (res) => {
      const { statusCode } = res;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(request(next, headers, redirectsLeft - 1));
      }
      if (statusCode !== 200 && statusCode !== 206) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Download timed out')));
  });
}

/**
 * Download `url` to `dest`, resuming a previous partial download when possible.
 *
 * Writes to `<dest>.part` and renames on completion, so the presence of `dest`
 * always means a complete file — the check every "is this installed?" probe
 * relies on.
 *
 * @param {object} opts
 * @param {(p:{received:number,total:number,pct:number,speed:number})=>void} opts.onProgress
 * @param {AbortSignal} opts.signal
 * @param {string} opts.sha256  optional expected digest
 */
async function downloadFile(url, dest, opts = {}) {
  const { onProgress, signal, sha256 } = opts;
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest)) return { path: dest, cached: true };

  let start = 0;
  if (fs.existsSync(part)) {
    try { start = fs.statSync(part).size; } catch { start = 0; }
  }

  const headers = { 'User-Agent': 'ai-mentat-local-studio' };
  if (start > 0) headers.Range = `bytes=${start}-`;

  let res;
  try {
    res = await request(url, headers);
  } catch (e) {
    // A server that refuses Range restarts cleanly rather than failing outright.
    if (start > 0) {
      try { fs.unlinkSync(part); } catch {}
      return downloadFile(url, dest, opts);
    }
    throw e;
  }

  // 200 in response to a Range request means the server ignored it.
  if (start > 0 && res.statusCode === 200) {
    try { fs.unlinkSync(part); } catch {}
    start = 0;
  }

  const total = start + Number(res.headers['content-length'] || 0);
  let received = start;
  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    const abort = () => {
      res.destroy();
      out.destroy();
      reject(new Error('cancelled'));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }

    let lastTick = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 200) {
        lastTick = now;
        const secs = (now - startedAt) / 1000;
        onProgress({
          received, total,
          pct: total ? Math.min(100, (received / total) * 100) : 0,
          speed: secs > 0 ? (received - start) / secs : 0,
        });
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    res.pipe(out);
    out.on('finish', resolve);
  });

  if (sha256) {
    const actual = await hashFile(part);
    if (actual !== sha256.toLowerCase()) {
      try { fs.unlinkSync(part); } catch {}
      throw new Error(`Checksum mismatch: expected ${sha256}, got ${actual}`);
    }
  }

  fs.renameSync(part, dest);
  if (onProgress) onProgress({ received: total || received, total: total || received, pct: 100, speed: 0 });
  return { path: dest, cached: false };
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function fetchJson(url) {
  const res = await request(url, {
    'User-Agent': 'ai-mentat-local-studio',
    Accept: 'application/vnd.github+json',
  });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function humanBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

module.exports = { downloadFile, fetchJson, hashFile, humanBytes };
