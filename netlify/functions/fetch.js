'use strict';
/**
 * Netlify Function — POST /api/fetch
 * Même contrat que le proxy local (server.js), pour un déploiement 100% statique
 * sur Netlify : le site reste statique, seule cette fonction fait le fetch.
 *
 * Note : les fonctions Netlify synchrones sont limitées à 10 s, d'où le timeout
 * de 8 s (ajustable via SITEPLAN_TIMEOUT_MS, max ~9 s).
 */

const { fetchPage } = require('../../lib/proxy');

const TIMEOUT_MS = Number(process.env.SITEPLAN_TIMEOUT_MS || 8000);
const ALLOW_PRIVATE = process.env.SITEPLAN_ALLOW_PRIVATE === '1';

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

const json = (statusCode, payload) => ({ statusCode, headers: HEADERS, body: JSON.stringify(payload) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...HEADERS,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'utilisez POST' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'corps JSON invalide' });
  }

  let target;
  try {
    target = new URL(String((payload && payload.url) || ''));
  } catch {
    return json(400, { error: 'URL invalide' });
  }

  const result = await fetchPage(target.href, payload.headers, {
    timeoutMs: TIMEOUT_MS,
    allowPrivate: ALLOW_PRIVATE,
  });

  if (result.error) {
    console.warn(`[siteplan] ✗ ${target.href} — ${result.error}`);
    return json(502, { error: result.error });
  }
  return json(200, result);
};
