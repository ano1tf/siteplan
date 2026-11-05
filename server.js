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
 * Déploiement :
 *   • local / VPS : `node server.js`
 *   • Render      : Web Service, Start Command `node server.js` (PORT est fourni)
 *   • Netlify     : pas ce fichier, mais netlify/functions/fetch.js (même contrat)
 *
 * Variables d'environnement :
 *   PORT=8080                    port d'écoute
 *   HOST=0.0.0.0                 interface d'écoute
 *   SITEPLAN_ALLOW_PRIVATE=1     autoriser le crawl de localhost / IP privées
 *                                (utile pour un site en développement)
 *   SITEPLAN_TIMEOUT_MS=25000    délai max par requête sortante
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/proxy');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ALLOW_PRIVATE = process.env.SITEPLAN_ALLOW_PRIVATE === '1';
const FETCH_TIMEOUT_MS = Number(process.env.SITEPLAN_TIMEOUT_MS || 25000);

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

// ---------------------------------------------------------------- API
async function handleFetch(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req, 128 * 1024)) || '{}');
  } catch (err) {
    return json(res, 400, { error: `requête invalide : ${err.message}` });
  }

  let target;
  try {
    target = new URL(String(payload.url || ''));
  } catch {
    return json(res, 400, { error: 'URL invalide' });
  }

  const started = Date.now();
  const result = await fetchPage(target.href, payload.headers, {
    timeoutMs: FETCH_TIMEOUT_MS,
    allowPrivate: ALLOW_PRIVATE,
  });
  if (result.error) {
    console.warn(`  ✗ ${target.href} — ${result.error}`);
    return json(res, 502, { error: result.error });
  }
  console.log(`  ✓ ${result.status} ${target.href} → ${result.finalUrl} (${Date.now() - started} ms)`);
  return json(res, 200, result);
}

// ---------------------------------------------------------------- static files
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 — fichier introuvable');
}

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
    return json(res, 200, { ok: true, proxy: true, name: 'siteplan', runtime: 'node', version: 2 });
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
  console.log(`  Délai réseau   : ${FETCH_TIMEOUT_MS} ms`);
  console.log('');
  console.log('  Ctrl+C pour arrêter.');
  console.log('');
});
