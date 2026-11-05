#!/usr/bin/env node
/**
 * SitePlan — serveur local + proxy de crawl
 * -----------------------------------------
 * Aucune dépendance : `node server.js` (port 8080 par défaut).
 *
 * Il sert l'interface statique ET expose deux endpoints utilisés par le crawler :
 *   GET  /api/health   → { ok: true }
 *   POST /api/fetch    → { url, headers } → { status, finalUrl, contentType, body }
 *
 * Avantages par rapport aux proxys CORS publics :
 *   • aucune limite CORS (le navigateur interroge le même serveur) ;
 *   • possibilité d'envoyer des en-têtes d'authentification (Cookie, Authorization) ;
 *   • délais, redirections et taille de réponse maîtrisés.
 *
 * Variables d'environnement :
 *   PORT=8080                    port d'écoute
 *   HOST=0.0.0.0                 interface d'écoute
 *   SITEPLAN_ALLOW_PRIVATE=1     autoriser le crawl de localhost / IP privées
 *                                (utile pour un site en développement)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_PRIVATE = process.env.SITEPLAN_ALLOW_PRIVATE === '1';
const FETCH_TIMEOUT_MS = Number(process.env.SITEPLAN_TIMEOUT_MS || 25000);
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 6;
const DEFAULT_UA = 'Mozilla/5.0 (compatible; SitePlan/1.1; sitemap crawler)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- helpers
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  if (!net.isIPv4(ip)) return false;
  const p = ip.split('.').map(Number);
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  return false;
}

/** Blocks SSRF: no localhost / private networks unless explicitly allowed. */
async function checkTarget(url) {
  if (ALLOW_PRIVATE) return { ok: true };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'hôte local bloqué (lancez avec SITEPLAN_ALLOW_PRIVATE=1 pour un site en développement)' };
  }
  if (net.isIP(host)) {
    return isPrivateIp(host)
      ? { ok: false, reason: 'adresse privée bloquée (SITEPLAN_ALLOW_PRIVATE=1 pour autoriser)' }
      : { ok: true };
  }
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return { ok: false, reason: `DNS introuvable pour ${host} (${err.code || err.message})` };
  }
  if (!addresses.length) return { ok: false, reason: `DNS vide pour ${host}` };
  if (addresses.some((a) => isPrivateIp(a.address))) {
    return { ok: false, reason: 'la cible résout vers un réseau privé (bloqué)' };
  }
  return { ok: true };
}

const ALLOWED_HEADERS = new Set(['cookie', 'authorization', 'user-agent', 'accept', 'accept-language', 'referer', 'x-requested-with']);

function sanitizeHeaders(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).toLowerCase().trim();
    if (!key || typeof rawValue !== 'string') continue;
    if (!ALLOWED_HEADERS.has(key) && !key.startsWith('x-')) continue;
    out[key] = rawValue.replace(/[\r\n]+/g, ' ').slice(0, 8192);
  }
  return out;
}

function friendlyNetworkError(err) {
  const cause = err && err.cause;
  const code = (cause && cause.code) || (err && err.code);
  const map = {
    ENOTFOUND: 'nom de domaine introuvable',
    EAI_AGAIN: 'DNS temporairement indisponible',
    ECONNREFUSED: 'connexion refusée par le serveur',
    ECONNRESET: 'connexion réinitialisée par le serveur',
    ETIMEDOUT: 'délai de connexion dépassé',
    EHOSTUNREACH: 'hôte injoignable',
    CERT_HAS_EXPIRED: 'certificat TLS expiré',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificat TLS auto-signé',
    SELF_SIGNED_CERT_IN_CHAIN: 'chaîne de certificats TLS auto-signée',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificat TLS non vérifiable (proxy/antivirus interceptant le HTTPS ?)',
    ERR_TLS_CERT_ALTNAME_INVALID: 'certificat TLS invalide pour ce domaine',
  };
  if (code && map[code]) return map[code];
  if (err && (err.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT')) {
    return `délai dépassé (${FETCH_TIMEOUT_MS / 1000} s)`;
  }
  const detail = (cause && (cause.message || cause.code)) || (err && err.message) || String(err);
  return String(detail).replace(/^fetch failed:?\s*/i, '') || 'erreur réseau inconnue';
}

async function fetchFollow(startUrl, baseHeaders) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    const check = await checkTarget(target);
    if (!check.ok) return { error: check.reason, status: 403 };

    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: baseHeaders,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      return { error: friendlyNetworkError(err), status: 502 };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try { response.body?.cancel(); } catch { /* ignore */ }
      if (!location) return { status: response.status, finalUrl: current, contentType: '', body: '' };
      const next = new URL(location, current).href;
      if (!/^https?:/i.test(next)) return { error: `redirection non http(s) : ${next}`, status: 502 };
      current = next;
      continue;
    }

    const contentType = response.headers.get('content-type') || '';
    const textual = /text\/|xml|json|javascript|html/i.test(contentType) || !contentType;
    let body = '';
    if (textual) {
      try {
        const buf = await response.arrayBuffer();
        body = Buffer.from(buf.slice(0, MAX_BODY_BYTES)).toString('utf8');
      } catch (err) {
        return { error: `lecture de la réponse impossible (${friendlyNetworkError(err)})`, status: 502 };
      }
    } else {
      try { response.body?.cancel(); } catch { /* ignore */ }
    }

    return {
      status: response.status,
      finalUrl: current,
      contentType,
      body,
      truncated: body.length >= MAX_BODY_BYTES,
    };
  }
  return { error: `trop de redirections (> ${MAX_REDIRECTS})`, status: 502 };
}

// ---------------------------------------------------------------- API
async function handleFetch(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, 128 * 1024) || '{}');
  } catch (err) {
    return json(res, 400, { error: `requête invalide : ${err.message}` });
  }

  let target;
  try {
    target = new URL(String(payload.url || ''));
  } catch {
    return json(res, 400, { error: 'URL invalide' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return json(res, 400, { error: 'seules les URLs http(s) sont autorisées' });
  }

  const headers = sanitizeHeaders(payload.headers);
  if (!headers['user-agent']) headers['user-agent'] = DEFAULT_UA;
  if (!headers.accept) headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  if (!headers['accept-language']) headers['accept-language'] = 'fr,en;q=0.7';

  const started = Date.now();
  const result = await fetchFollow(target.href, headers);
  if (result.error) {
    console.warn(`  ✗ ${target.href} — ${result.error}`);
    return json(res, 502, { error: result.error });
  }
  console.log(`  ✓ ${result.status} ${target.href} → ${result.finalUrl} (${Date.now() - started} ms)`);
  return json(res, 200, result);
}

// ---------------------------------------------------------------- static files
function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return notFound(res); }
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  const filePath = path.join(ROOT, path.normalize(decoded).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) return notFound(res);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 — fichier introuvable');
}

// ---------------------------------------------------------------- server
const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return notFound(res);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (pathname === '/api/health' || pathname === '/api/health/') {
    return json(res, 200, { ok: true, proxy: true, name: 'siteplan', version: 1 });
  }
  if (pathname === '/api/fetch') {
    if (req.method !== 'POST') return json(res, 405, { error: 'utilisez POST' });
    return handleFetch(req, res).catch((err) => json(res, 500, { error: err.message }));
  }
  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'endpoint inconnu' });

  return serveStatic(req, res, pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🗺️  SitePlan — serveur local');
  console.log(`  → http://localhost:${PORT}`);
  console.log('');
  console.log(`  Proxy de crawl : /api/fetch ${ALLOW_PRIVATE ? '(réseaux privés autorisés)' : '(réseaux privés bloqués)'}`);
  console.log(`  Délai réseau   : ${FETCH_TIMEOUT_MS} ms · redirections max : ${MAX_REDIRECTS}`);
  console.log('');
  console.log('  Ctrl+C pour arrêter.');
  console.log('');
});
