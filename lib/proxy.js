'use strict';
/**
 * Cœur du proxy de crawl, partagé par :
 *   • server.js                      → `node server.js` (local / Render / VPS)
 *   • netlify/functions/fetch.js     → déploiement statique Netlify
 *
 * Contrat identique dans les deux cas :
 *   entrée  : { url: string, headers?: { Cookie?, Authorization?, User-Agent? } }
 *   sortie  : { status, finalUrl, contentType, body, truncated? }
 *          ou { error, status? } en cas d'échec réseau / de cible refusée.
 *
 * Aucune dépendance npm : uniquement les modules natifs de Node (≥ 18).
 */

const dns = require('dns').promises;
const net = require('net');

const DEFAULT_UA = 'Mozilla/5.0 (compatible; SitePlan/1.1; sitemap crawler)';
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 6;

// En-têtes que l'utilisateur peut transmettre (liste blanche stricte).
const ALLOWED_HEADERS = new Set([
  'cookie', 'authorization', 'user-agent', 'accept',
  'accept-language', 'referer', 'x-requested-with',
]);

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

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
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

/** Anti-SSRF : refuse localhost et les réseaux privés sauf autorisation explicite. */
async function checkTarget(url, { allowPrivate = false } = {}) {
  if (allowPrivate) return { ok: true };
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: 'hôte local bloqué (SITEPLAN_ALLOW_PRIVATE=1 pour un site en développement)' };
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

function friendlyNetworkError(err, timeoutMs) {
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
    const human = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
    return `délai dépassé (${human})`;
  }
  const detail = (cause && (cause.message || cause.code)) || (err && err.message) || String(err);
  return String(detail).replace(/^fetch failed:?\s*/i, '') || 'erreur réseau inconnue';
}

/**
 * Récupère une page en suivant les redirections manuellement (pour pouvoir
 * contrôler chaque saut et renvoyer l'URL finale).
 */
async function fetchPage(startUrl, rawHeaders = {}, options = {}) {
  const {
    timeoutMs = 25000,
    maxRedirects = MAX_REDIRECTS,
    allowPrivate = false,
    maxBytes = MAX_BODY_BYTES,
    userAgent = DEFAULT_UA,
  } = options;

  const headers = sanitizeHeaders(rawHeaders);
  if (!headers['user-agent']) headers['user-agent'] = userAgent;
  if (!headers.accept) headers.accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  if (!headers['accept-language']) headers['accept-language'] = 'fr,en;q=0.7';

  let current = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let target;
    try {
      target = new URL(current);
    } catch {
      return { error: 'URL invalide', status: 400 };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { error: 'seules les URLs http(s) sont autorisées', status: 400 };
    }

    const check = await checkTarget(target, { allowPrivate });
    if (!check.ok) return { error: check.reason, status: 403 };

    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { error: friendlyNetworkError(err, timeoutMs), status: 502 };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try { response.body?.cancel(); } catch { /* ignore */ }
      if (!location) return { status: response.status, finalUrl: current, contentType: '', body: '' };
      let next;
      try { next = new URL(location, current).href; } catch {
        return { error: `redirection invalide : ${location}`, status: 502 };
      }
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
        body = Buffer.from(buf.slice(0, maxBytes)).toString('utf8');
      } catch (err) {
        return { error: `lecture de la réponse impossible (${friendlyNetworkError(err, timeoutMs)})`, status: 502 };
      }
    } else {
      try { response.body?.cancel(); } catch { /* ignore */ }
    }

    return {
      status: response.status,
      finalUrl: current,
      contentType,
      body,
      truncated: body.length >= maxBytes,
    };
  }
  return { error: `trop de redirections (> ${maxRedirects})`, status: 502 };
}

module.exports = {
  DEFAULT_UA,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  sanitizeHeaders,
  isPrivateIp,
  checkTarget,
  friendlyNetworkError,
  fetchPage,
};
