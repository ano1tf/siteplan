'use strict';
/** Netlify Function — GET /api/health : permet à l'interface de détecter le proxy. */

exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify({ ok: true, proxy: true, name: 'siteplan', runtime: 'netlify', version: 2 }),
});
