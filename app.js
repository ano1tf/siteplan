/* =========================================================
   SitePlan — Pro sitemap generator
   Supports: ZIP upload, folder upload, crawl, sitemap import,
             HTML paste, manual. Frameworks: Next.js (App/Pages),
             Astro, Nuxt, SvelteKit, Remix, VitePress, static HTML/PHP.
   Exports: sitemap.xml, sitemap-index.xml, robots.txt,
            Next.js sitemap.ts, Next.js robots.ts
   ========================================================= */

(() => {
  'use strict';

  // ---------- State ----------
  /** @type {Array<{loc:string,lastmod?:string,changefreq?:string,priority?:string,source?:string,dynamic?:boolean,selected?:boolean}>} */
  let urls = [];
  let editMode = false;
  let crawlAbort = null;
  let currentExport = 'xml';
  let initialized = false;

  const STORAGE_KEY = 'siteplan:v3';
  const MAX_URLS_PER_SITEMAP = 45000;
  const ASSET_EXTS = /\.(js|mjs|cjs|ts|tsx|jsx|css|scss|less|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|flac|aac|woff2?|ttf|otf|eot|map)(\?.*)?$/i;
  const HTML_EXTS = /\.(html?|php|htm|xhtml)$/i;
  const INTERNAL_SEGMENTS = ['api', '_next', '_nuxt', '_astro', '_app', '__next', 'wp-admin', 'wp-includes', '.git', 'node_modules', '.next', 'dist', 'build', 'vendor', '.cache', '__pycache__'];

  const CRAWL_TIMEOUT_MS = 15000;
  const PROXY_HEALTH_URL = 'api/health';
  const PROXY_FETCH_URL = 'api/fetch';

  /**
   * Public CORS proxies, used only when the local proxy (server.js) is not available.
   * Order matters: fastest / most reliable first, services that refuse HTML last.
   */
  const PUBLIC_PROXIES = [
    { name: 'allorigins', json: true, build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}` },
    { name: 'codetabs', build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
    { name: 'cors.lol', build: (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}` },
    { name: 'allorigins-raw', build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'corsproxy.io', build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` },
  ];

  // ---------- Network layer ----------
  // Two transports: a local Node proxy (no CORS limits, supports auth headers)
  // and public CORS proxies as a fallback. Every request has a hard timeout so
  // the crawler can never hang forever on a dead proxy.
  const proxyState = { local: false, checked: false, checking: null };
  // Consecutive failures per proxy: after 3, stop wasting time on it.
  const proxyFails = new Map();
  let localProxyFails = 0;

  function isAbortError(err, signal) {
    return (signal && signal.aborted) || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
  }

  /** AbortSignal linked to a parent signal, with its own timeout. */
  function linkedSignal(parent, ms) {
    const ctrl = new AbortController();
    let reason = null;
    const onAbort = () => { reason = 'aborted'; ctrl.abort(); };
    if (parent) {
      if (parent.aborted) onAbort();
      else parent.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => { reason = 'timeout'; ctrl.abort(); }, ms);
    return {
      signal: ctrl.signal,
      reason: () => reason,
      cleanup: () => {
        clearTimeout(timer);
        if (parent) parent.removeEventListener('abort', onAbort);
      },
    };
  }

  const sleep = (ms, signal) => new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

  async function probeLocalProxy(force = false) {
    if (proxyState.checked && !force) return proxyState.local;
    if (proxyState.checking && !force) return proxyState.checking;
    proxyState.checking = (async () => {
      let ok = false;
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        try {
          const s = linkedSignal(null, 2500);
          const r = await fetch(PROXY_HEALTH_URL, { signal: s.signal, cache: 'no-store' });
          s.cleanup();
          if (r.ok) {
            const data = await r.json().catch(() => ({}));
            ok = !!(data && data.ok);
          }
        } catch { ok = false; }
      }
      proxyState.local = ok;
      proxyState.checked = true;
      proxyState.checking = null;
      updateProxyBadge();
      return ok;
    })();
    return proxyState.checking;
  }

  function updateProxyBadge() {
    const dot = $('#proxyDot');
    const label = $('#proxyLabel');
    if (!dot || !label) return;
    dot.classList.remove('on', 'off', 'pending');
    if (!proxyState.checked) {
      dot.classList.add('pending');
      label.textContent = 'Vérification du proxy local…';
      return;
    }
    if (proxyState.local) {
      dot.classList.add('on');
      label.innerHTML = 'Proxy local actif — crawl fiable, <strong>cookies et authentification possibles</strong>.';
    } else {
      dot.classList.add('off');
      label.innerHTML = 'Proxys publics — certains sites bloquent/limitent. Pour un crawl fiable' +
        ' (et les sites protégés) : <code>node server.js</code> en local, ou un déploiement Netlify (fonctions incluses).';
    }
  }

  /** Auth headers typed by the user (local proxy only). */
  function getCrawlHeaders() {
    const out = {};
    const cookie = ($('#crawlCookie')?.value || '').trim();
    const auth = ($('#crawlAuthorization')?.value || '').trim();
    const ua = ($('#crawlUserAgent')?.value || '').trim();
    if (cookie) out.Cookie = cookie;
    if (auth) out.Authorization = /^(basic|bearer|token)\s/i.test(auth) ? auth : `Bearer ${auth}`;
    if (ua) out['User-Agent'] = ua;
    return out;
  }

  async function fetchViaLocalProxy(url, headers, signal) {
    const s = linkedSignal(signal, CRAWL_TIMEOUT_MS + 10000);
    try {
      const r = await fetch(PROXY_FETCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, headers }),
        signal: s.signal,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok || !data || data.error) {
        throw new Error((data && data.error) || `proxy local HTTP ${r.status}`);
      }
      return {
        status: data.status || 200,
        body: typeof data.body === 'string' ? data.body : '',
        contentType: data.contentType || '',
        finalUrl: data.finalUrl || url,
        via: 'proxy local',
      };
    } finally { s.cleanup(); }
  }

  async function fetchViaPublicProxy(proxy, url, signal) {
    const s = linkedSignal(signal, CRAWL_TIMEOUT_MS);
    try {
      const r = await fetch(proxy.build(url), { signal: s.signal, redirect: 'follow', cache: 'no-store' });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (proxy.json) {
        let data = null;
        try { data = JSON.parse(text); } catch { throw new Error('réponse illisible'); }
        if (!data || typeof data.contents !== 'string') throw new Error('réponse illisible');
        return {
          status: (data.status && data.status.http_code) || 200,
          body: data.contents,
          contentType: '',
          finalUrl: (data.status && data.status.url) || url,
          via: proxy.name,
        };
      }
      return { status: r.status, body: text, contentType: r.headers.get('content-type') || '', finalUrl: url, via: proxy.name };
    } finally { s.cleanup(); }
  }

  /** Detect proxy error pages / bot walls that would otherwise look like a valid page. */
  function detectBlockedPage(body) {
    if (!body || body.length > 400000) return null;
    const head = body.slice(0, 20000).toLowerCase();
    if (head.includes('cf-browser-verification') || head.includes('just a moment...') || head.includes('attention required! | cloudflare')) {
      return 'page protégée par Cloudflare (challenge anti-bot)';
    }
    if (head.includes('enable javascript and cookies to continue')) return 'page protégée par un challenge JavaScript';
    if (head.includes('too many requests') && body.length < 3000) return 'proxy saturé (trop de requêtes)';
    return null;
  }

  /**
   * Fetch a page through the best available transport.
   * Returns {status, body, contentType, finalUrl, via}. Never hangs.
   */
  async function fetchPage(url, opts = {}) {
    const headers = opts.headers || {};
    const signal = opts.signal;
    if (!proxyState.checked) await probeLocalProxy();
    const errors = [];

    if (proxyState.local) {
      try {
        const page = await fetchViaLocalProxy(url, headers, signal);
        localProxyFails = 0;
        return page;
      } catch (err) {
        if (isAbortError(err, signal)) throw err;
        errors.push(`proxy local : ${err.message}`);
        localProxyFails++;
        if (localProxyFails >= 3) {
          // The server is up but cannot reach the internet (TLS interception,
          // firewall, DNS…): switch to public proxies for the rest of the session.
          proxyState.local = false;
          proxyState.checked = true;
          updateProxyBadge();
          console.warn('[SitePlan] proxy local injoignable → repli sur les proxys publics.');
        }
      }
    }

    const authBlocked = Object.keys(headers).length > 0;
    for (const proxy of PUBLIC_PROXIES) {
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      if ((proxyFails.get(proxy.name) || 0) >= 3) continue;
      try {
        const page = await fetchViaPublicProxy(proxy, url, signal);
        const blocked = detectBlockedPage(page.body);
        if (blocked) { errors.push(`${proxy.name} : ${blocked}`); proxyFails.set(proxy.name, 1); continue; }
        if (!page.body) { errors.push(`${proxy.name} : réponse vide`); proxyFails.set(proxy.name, 1); continue; }
        proxyFails.delete(proxy.name);
        return page;
      } catch (err) {
        if (isAbortError(err, signal)) throw err;
        errors.push(`${proxy.name} : ${err.message}`);
        const n = (proxyFails.get(proxy.name) || 0) + 1;
        proxyFails.set(proxy.name, n);
        if (n >= 3) console.warn(`[SitePlan] proxy ${proxy.name} désactivé pour cette session (${n} échecs).`);
      }
    }

    const suffix = authBlocked
      ? ' — les en-têtes d\'authentification ne fonctionnent qu\'avec le proxy local (node server.js)'
      : '';
    throw new Error(`aucun proxy n'a pu charger la page${suffix}${errors.length ? ` (${errors.slice(0, 3).join(' · ')})` : ''}`);
  }

  // ---------- DOM ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------- Utils ----------
  const escapeXml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const todayIso = () => new Date().toISOString().slice(0, 10);

  function showToast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(showToast._h);
    showToast._h = setTimeout(() => (t.className = 'toast'), 3000);
  }

  // ---------- URL normalization ----------
  function normalizeUrl(raw, base) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (s.startsWith('#')) return null;
    if (/^(mailto:|javascript:|tel:|data:|ftp:|blob:|about:)/i.test(s)) return null;
    if ($('#stripHash').checked) s = s.split('#')[0];
    if ($('#stripSearch').checked) s = s.split('?')[0];
    if (!s || s === '#') return null;
    let resolved;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) resolved = new URL(s);
      else {
        if (!base) return null;
        resolved = new URL(s, base);
      }
    } catch { return null; }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    if ($('#stripIndex').checked) {
      resolved.pathname = resolved.pathname.replace(/\/index\.(html?|php|asp|aspx|jsp)$/i, '/');
    }
    if ($('#stripTrailing').checked) {
      if (resolved.pathname.length > 1 && resolved.pathname.endsWith('/')) {
        resolved.pathname = resolved.pathname.replace(/\/+$/, '') || '/';
      }
    }
    if ($('#stripHash')) resolved.hash = '';
    if ($('#stripSearch')) resolved.search = '';
    return resolved.toString();
  }

  // ---------- Glob matching ----------
  function globToRegex(pattern) {
    let p = pattern.trim();
    if (!p) return null;
    let re = '^', i = 0;
    while (i < p.length) {
      const c = p[i];
      if (c === '*') {
        if (p[i + 1] === '*') { re += '.*'; i += 2; if (p[i] === '/') { re += '/?'; i++; } }
        else { re += '[^/]*'; i++; }
      } else if (c === '?') { re += '[^/]'; i++; }
      else if ('.+^$()|{}[]\\'.includes(c)) { re += '\\' + c; i++; }
      else { re += c; i++; }
    }
    re += '$';
    return new RegExp(re, 'i');
  }

  function isExcluded(url, opts = {}) {
    const u = new URL(url);
    const path = u.pathname;
    if (opts.crawl && ASSET_EXTS.test(path)) return true;
    for (const seg of INTERNAL_SEGMENTS) {
      const re = new RegExp(`(^|/)${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`, 'i');
      if (re.test(path)) return true;
    }
    const patterns = $('#excludePatterns').value.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const p of patterns) {
      const r = globToRegex(p);
      if (r && (r.test(path) || r.test(path + u.search) || r.test(url.slice(u.origin.length)))) return true;
    }
    return false;
  }

  // ---------- Storage ----------
  function saveState() {
    try {
      const hreflangs = $$('.hreflang-row').map((row) => ({
        lang: $('.hf-lang', row).value, url: $('.hf-url', row).value,
      })).filter((h) => h.lang && h.url);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        urls,
        baseUrl: $('#baseUrl').value,
        defaultChangefreq: $('#defaultChangefreq').value,
        defaultPriority: $('#defaultPriority').value,
        lastmodMode: $('#lastmodMode').value,
        defaultLastmod: $('#defaultLastmod').value,
        excludePatterns: $('#excludePatterns').value,
        stripIndex: $('#stripIndex').checked,
        stripTrailing: $('#stripTrailing').checked,
        stripHash: $('#stripHash').checked,
        stripSearch: $('#stripSearch').checked,
        useHreflang: $('#useHreflang').checked,
        hreflangs,
      }));
    } catch {}
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (Array.isArray(s.urls)) urls = s.urls;
      if (s.baseUrl) $('#baseUrl').value = s.baseUrl;
      if (s.defaultChangefreq) $('#defaultChangefreq').value = s.defaultChangefreq;
      if (s.defaultPriority) $('#defaultPriority').value = s.defaultPriority;
      if (s.lastmodMode) $('#lastmodMode').value = s.lastmodMode;
      if (s.defaultLastmod) $('#defaultLastmod').value = s.defaultLastmod;
      if (s.excludePatterns) $('#excludePatterns').value = s.excludePatterns;
      if (typeof s.stripIndex === 'boolean') $('#stripIndex').checked = s.stripIndex;
      if (typeof s.stripTrailing === 'boolean') $('#stripTrailing').checked = s.stripTrailing;
      if (typeof s.stripHash === 'boolean') $('#stripHash').checked = s.stripHash;
      if (typeof s.stripSearch === 'boolean') $('#stripSearch').checked = s.stripSearch;
      if (typeof s.useHreflang === 'boolean') $('#useHreflang').checked = s.useHreflang;
      if (Array.isArray(s.hreflangs)) s.hreflangs.forEach((h) => addHreflangRow(h.lang, h.url));
    } catch {}
  }

  function getDefaultLastmod() {
    const m = $('#lastmodMode').value;
    if (m === 'today') return todayIso();
    if (m === 'custom') return $('#defaultLastmod').value || '';
    return '';
  }

  // ---------- Adding URLs ----------
  function addUrl(loc, opts = {}) {
    const base = $('#baseUrl').value.trim();
    const n = normalizeUrl(loc, base);
    if (!n) return { ok: false, reason: 'invalid' };
    if (isExcluded(n, { crawl: !!opts.fromCrawl })) return { ok: false, reason: 'excluded' };
    if (urls.some((u) => u.loc === n)) return { ok: false, reason: 'duplicate' };
    urls.push({
      loc: n,
      lastmod: opts.lastmod !== undefined ? opts.lastmod : getDefaultLastmod(),
      changefreq: opts.changefreq || $('#defaultChangefreq').value,
      priority: opts.priority || $('#defaultPriority').value,
      source: opts.source || 'manual',
      dynamic: !!opts.dynamic,
      selected: false,
    });
    return { ok: true };
  }
  function addMany(locs, source = 'manual', lastmod = null) {
    let added = 0, dup = 0, excl = 0, inv = 0;
    locs.forEach((l) => {
      const r = addUrl(l, { source, lastmod: lastmod || undefined });
      if (r.ok) added++;
      else if (r.reason === 'duplicate') dup++;
      else if (r.reason === 'excluded') excl++;
      else inv++;
    });
    return { added, dup, excl, inv };
  }

  function extractLinks(html, base) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const set = new Set();
    const push = (v) => { if (v) { const s = String(v).trim(); if (s) set.add(s); } };
    doc.querySelectorAll('a[href], area[href]').forEach((a) => push(a.getAttribute('href')));
    // alternates / canonical (useful for i18n and no-<a> pages)
    doc.querySelectorAll('link[href]').forEach((l) => {
      const rel = (l.getAttribute('rel') || '').toLowerCase();
      if (rel.includes('alternate') || rel.includes('canonical')) push(l.getAttribute('href'));
    });
    doc.querySelectorAll('meta[property="og:url"], meta[name="twitter:url"]').forEach((m) => push(m.getAttribute('content')));
    // sitemap XML pasted or fetched
    doc.querySelectorAll('loc').forEach((l) => push(l.textContent));
    return Array.from(set);
  }

  /** Returns {links, noindex, loginForm} for a fetched HTML page. */
  function analyzePage(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    let noindex = false;
    doc.querySelectorAll('meta[name="robots"], meta[name="googlebot"]').forEach((m) => {
      const c = (m.getAttribute('content') || '').toLowerCase();
      if (c.includes('noindex') || c.includes('none')) noindex = true;
    });
    const loginForm = !!doc.querySelector('input[type="password"]');
    return { links: extractLinks(html), noindex, loginForm };
  }


  // ---------- Project / ZIP scanning ----------
  function normalizeFileList(files) {
    return Array.from(files).map((f) => ({
      name: f.name,
      path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'),
      size: f.size,
      lastModified: f.lastModified,
      text: () => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsText(f);
      }),
    }));
  }

  /**
   * Scan a virtual file list (from folder upload OR zip) with {path, name, text(), lastModified}.
   */
  /** Folder names that must never be stripped as a ZIP/folder "root". */
  const KEEP_ROOT = new Set(['src', 'app', 'pages', 'public', 'docs', 'assets', 'static', 'components', 'lib', 'styles', 'css', 'js', 'img', 'images', 'fonts', 'content', 'routes', 'layouts', 'templates']);

  /**
   * GitHub/zips usually wrap everything in a single folder ("mon-site-main/").
   * Detect it so framework config files are found at the expected location.
   */
  function stripCommonRoot(paths) {
    if (!paths.length) return '';
    const firsts = new Set();
    for (const p of paths) {
      const i = p.indexOf('/');
      firsts.add(i > 0 ? p.slice(0, i) : '');
      if (i <= 0) return '';
    }
    if (firsts.size !== 1) return '';
    const root = [...firsts][0];
    if (!root || KEEP_ROOT.has(root.toLowerCase())) return '';
    return root + '/';
  }

  /** A single unreadable entry (corrupted / encrypted / huge) must never block the scan. */
  function readTextSafe(fileObj, timeoutMs = 5000) {
    return Promise.race([
      Promise.resolve().then(() => fileObj.text()),
      new Promise((_, reject) => setTimeout(() => reject(new Error('lecture du fichier expirée')), timeoutMs)),
    ]);
  }

  async function scanFiles(fileObjects, sourceName = 'folder') {
    // Build paths
    const paths = fileObjects.map((f) => f.path);
    const rootPrefix = stripCommonRoot(paths);
    const rel = (p) => rootPrefix ? p.slice(rootPrefix.length) : p.replace(/^\/+/, '');

    const has = (p) => paths.some((x) => {
      const rp = rel(x);
      return rp === p || rp.startsWith(p + '/');
    });
    const hasRe = (re) => paths.some((p) => re.test(rel(p)));

    let framework = 'static';
    let appDir = null, pagesDir = null;
    if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts') || has('next.config.cjs')) {
      framework = 'next-app';
      appDir = has('src/app') ? 'src/app' : (has('app') ? 'app' : null);
      pagesDir = has('src/pages') ? 'src/pages' : (has('pages') ? 'pages' : null);
    } else if (has('astro.config.mjs') || has('astro.config.js') || has('astro.config.ts')) {
      framework = 'astro';
      appDir = has('src/pages') ? 'src/pages' : 'pages';
    } else if (has('nuxt.config.js') || has('nuxt.config.ts')) {
      framework = 'nuxt';
      appDir = has('pages') ? 'pages' : null;
    } else if (has('svelte.config.js')) {
      framework = 'sveltekit';
      appDir = has('src/routes') ? 'src/routes' : (has('routes') ? 'routes' : null);
    } else if (has('remix.config.js') || paths.some((p) => /^app\/routes\//.test(rel(p)))) {
      framework = 'remix';
      appDir = has('app/routes') ? 'app/routes' : 'routes';
    } else if (has('.vitepress/config.js') || has('.vitepress/config.ts') || has('.vitepress/config.mjs')) {
      framework = 'vitepress';
      appDir = has('docs') ? 'docs' : '.';
    } else if (paths.some((p) => /(^|\/)(src\/)?app\/page\.(t|j)sx?$/.test(rel(p)))
      || paths.some((p) => /(^|\/)(src\/)?pages\/(index|_app|_document)\.(t|j)sx?$/.test(rel(p)))) {
      // Next.js project without next.config.* (zips of a sub-folder, monorepos…)
      framework = 'next-app';
      appDir = has('src/app') ? 'src/app' : (has('app') ? 'app' : null);
      pagesDir = has('src/pages') ? 'src/pages' : (has('pages') ? 'pages' : null);
    } else if (paths.some((p) => /(^|\/)src\/pages\/.*\.astro$/.test(rel(p)))) {
      framework = 'astro';
      appDir = has('src/pages') ? 'src/pages' : 'pages';
    } else if (paths.some((p) => HTML_EXTS.test(p))) {
      framework = 'static-html';
    }

    const routes = []; // {path, file, dynamic, priority, freq, lastmod}
    const byPath = new Map();
    fileObjects.forEach((f) => byPath.set(rel(f.path), f));

    const defaultPriorityFor = (route) => {
      if (!route || route === '') return '1.0';
      const depth = route.split('/').filter(Boolean).length;
      if (depth === 0) return '1.0';
      if (depth === 1) return '0.8';
      if (depth === 2) return '0.7';
      return '0.5';
    };
    const defaultFreqFor = (route) => {
      if (!route) return 'weekly';
      if (/(blog|news|posts|articles|actualites)/i.test(route)) return 'daily';
      if (/(about|a-propos|contact|mentions|legal|confidentialite|methode)/i.test(route)) return 'yearly';
      if (/(tarifs|pricing|produits|products|realisations|services|web|security|lab|simulateur)/i.test(route)) return 'monthly';
      return 'weekly';
    };

    if (framework === 'next-app' && (appDir || pagesDir)) {
      if (appDir) {
      const pageRe = new RegExp(`^${appDir}/(.*)page\.(tsx|ts|jsx|js|mdx?)$`);
      paths.forEach((p) => {
        const rp = rel(p);
        const m = rp.match(pageRe);
        if (!m) return;
        // skip private folders (_components, _lib, etc.)
        if (/\/_/.test('/' + m[1])) return;
        let segs = m[1].split('/').filter(Boolean);
        segs = segs.filter((s) => !/^\(.*\)$/.test(s)); // route groups
        const route = segs.join('/');
        const hasDynamic = /\[.*?\]/.test(route);
        const f = byPath.get(rp);
        routes.push({
          path: route ? '/' + route : '/',
          file: rp,
          dynamic: hasDynamic,
          priority: defaultPriorityFor(route),
          freq: defaultFreqFor(route),
          lastmod: f?.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null,
        });
      });
      }
      if (pagesDir) {
        const pageRe = new RegExp(`^${pagesDir}/(.*)\.(tsx|ts|jsx|js|mdx?)$`);
        paths.forEach((p) => {
          const rp = rel(p);
          const m = rp.match(pageRe);
          if (!m) return;
          let page = m[1];
          if (page.startsWith('api/') || page === 'api') return;
          if (page.startsWith('_')) return;
          if (/^(404|500|_error)$/.test(page)) return; // pages d'erreur
          if (page === 'index') page = '';
          else page = page.replace(/\/index$/, '');
          const hasDynamic = /\[.*?\]/.test(page);
          const f = byPath.get(rp);
          routes.push({
            path: '/' + page,
            file: rp,
            dynamic: hasDynamic,
            priority: defaultPriorityFor(page),
            freq: defaultFreqFor(page),
            lastmod: f?.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null,
          });
        });
      }
    } else if ((framework === 'astro' || framework === 'nuxt') && appDir) {
      const re = new RegExp(`^${appDir}/(.*)\.(astro|mdx?|vue|tsx|jsx|ts|js|html)$`);
      paths.forEach((p) => {
        const rp = rel(p);
        const m = rp.match(re);
        if (!m) return;
        let page = m[1];
        if (page.startsWith('_')) return;
        if (page === 'index') page = '';
        else page = page.replace(/\/index$/, '');
        let route = page;
        if (framework === 'nuxt') {
          route = route.replace(/\/_([^/]+)/g, '/[$1]');
          if (route.startsWith('_')) route = '[' + route.slice(1) + ']';
        }
        const hasDynamic = /\[.*?\]/.test(route);
        const f = byPath.get(rp);
        routes.push({
          path: '/' + route, file: rp, dynamic: hasDynamic,
          priority: defaultPriorityFor(route), freq: defaultFreqFor(route),
          lastmod: f?.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null,
        });
      });
    } else if (framework === 'sveltekit' && appDir) {
      const re = new RegExp(`^${appDir}/(.*)\\+page\.(svelte|md|mdx)$`);
      paths.forEach((p) => {
        const rp = rel(p);
        const m = rp.match(re);
        if (!m) return;
        let seg = m[1];
        let route = seg.split('/').filter(Boolean).join('/');
        route = route.replace(/\([^/]+\)\//g, '');
        const hasDynamic = /\[.*?\]/.test(route);
        const f = byPath.get(rp);
        routes.push({
          path: route ? '/' + route : '/', file: rp, dynamic: hasDynamic,
          priority: defaultPriorityFor(route), freq: defaultFreqFor(route),
          lastmod: f?.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null,
        });
      });
    } else if (framework === 'vitepress' && appDir) {
      const re = /\.(md|mdx)$/i;
      const exclude = /(^|\/)(\.vitepress|node_modules|public|dist)(\/|$)/;
      paths.forEach((p) => {
        const rp = rel(p);
        if (exclude.test(rp)) return;
        if (!re.test(rp)) return;
        let page = rp.replace(/\.(md|mdx)$/i, '');
        if (appDir !== '.' && page.startsWith(appDir + '/')) page = page.slice(appDir.length + 1);
        if (page === 'index' || page.endsWith('/index')) page = page.replace(/\/?index$/, '') || '/';
        if (page.startsWith('/')) page = page.slice(1);
        const f = byPath.get(rp);
        routes.push({
          path: '/' + page, file: rp, dynamic: false,
          priority: defaultPriorityFor(page), freq: defaultFreqFor(page),
          lastmod: f?.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null,
        });
      });
    } else if (framework === 'static-html') {
      const skip = /(^|\/)(node_modules|\.git|\.next|dist|build|vendor|\.cache|__pycache__)(\/|$)/;
      fileObjects.forEach((f) => {
        const rp = rel(f.path);
        if (!HTML_EXTS.test(rp) || skip.test(rp)) return;
        let page = rp.replace(HTML_EXTS, '');
        if (page.endsWith('/index') || page === 'index') page = page.replace(/\/?index$/, '') || '/';
        page = page.replace(/\\/g, '/');
        if (!page.startsWith('/')) page = '/' + page;
        routes.push({
          path: page, file: rp, dynamic: false,
          priority: defaultPriorityFor(page), freq: defaultFreqFor(page),
          lastmod: f.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null,
        });
      });
    }

    // Add routes
    const base = $('#baseUrl').value.trim();
    let added = 0;
    routes.forEach((r) => {
      const full = base ? normalizeUrl(r.path, base) : null;
      if (!full) return;
      const res = addUrl(full, {
        source: `proj:${framework}`,
        lastmod: r.lastmod || getDefaultLastmod(),
        changefreq: r.freq,
        priority: r.priority,
        dynamic: r.dynamic,
      });
      if (res.ok) added++;
    });

    // Extract links from HTML/PHP files within the project
    let linksAdded = 0;
    const htmlFiles = fileObjects.filter((f) => HTML_EXTS.test(f.path) && !/(^|\/)(node_modules|\.git|\.next|dist|build)(\/|$)/.test(rel(f.path)));
    for (const f of htmlFiles) {
      try {
        const txt = await readTextSafe(f, 8000);
        if (!txt) continue;
        const links = extractLinks(txt, base);
        const lm = f.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null;
        const r = addMany(links, 'html-scan', lm);
        linksAdded += r.added;
      } catch { /* fichier illisible : on continue */ }
    }

    render();
    saveState();
    displayScanResult(framework, routes, added, linksAdded, sourceName);
  }

  function displayScanResult(framework, routes, added, linksAdded, sourceName) {
    const fwNames = {
      'next-app': 'Next.js (App Router)', 'astro': 'Astro', 'nuxt': 'Nuxt',
      'sveltekit': 'SvelteKit', 'remix': 'Remix', 'vitepress': 'VitePress',
      'static-html': 'HTML / PHP statique', 'static': 'Fichiers statiques',
    };
    const dyn = routes.filter((r) => r.dynamic).length;
    const res = $('#projectScanResult');
    res.style.display = 'flex';
    res.innerHTML = `
      <div>
        <div class="scan-badge">✓ ${sourceName === 'zip' ? 'ZIP analysé' : 'Dossier analysé'}</div>
        <p class="scan-title">${fwNames[framework] || framework}</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0 12px;font-size:12px;color:var(--text-muted)">
          <span>📄 <strong style="color:#e7ecf5">${routes.length}</strong> routes</span>
          ${dyn ? `<span>⚡ <strong style="color:#fcd34d">${dyn}</strong> dyn.</span>` : ''}
          <span>🔗 <strong style="color:#e7ecf5">${linksAdded}</strong> liens</span>
          <span>✅ <strong style="color:#6ee7b7">${added}</strong> ajoutées</span>
        </div>
        ${dyn ? `<div class="scan-warn">⚠️ ${dyn} route(s) dynamique(s) détectée(s) (ex: <code>[slug]</code>). Elles sont marquées ⚡ dans le tableau. Remplacez-les par vos vraies URLs (base de données, etc.).</div>` : ''}
        ${routes.length === 0 ? `<div class="scan-warn">⚠️ Aucune route détectée dans cette archive.<br>
          • Vérifiez que le ZIP contient bien vos <strong>fichiers source</strong> (<code>app/</code>, <code>pages/</code>, <code>*.html</code>…), pas seulement un build minifié.<br>
          • Les dossiers <code>node_modules/</code>, <code>.git/</code> et <code>__MACOSX/</code> sont ignorés.<br>
          • Framework non reconnu ? Utilisez l'onglet « Fichiers HTML » ou le crawler.</div>` : ''}
      </div>
      <ul class="scan-list">
        ${routes.slice(0, 20).map((r) => `<li class="${r.dynamic ? 'dyn' : ''}"><span>${escapeXml(r.path)}</span> <span class="tag ${r.dynamic ? 'dyn' : ''}">${r.dynamic ? 'dyn' : r.priority}</span></li>`).join('')}
        ${routes.length > 20 ? `<li style="justify-content:center;color:var(--text-dim)">… et ${routes.length - 20} autres</li>` : ''}
      </ul>
    `;
    // Switch to URLs tab (step 3)
    updateStepper();
  }

  function ensureBaseUrl() {
    if ($('#baseUrl').value.trim()) return true;
    showToast("Renseignez d'abord l'URL de base (étape ①) : elle sert à construire les URLs.", 'error');
    const input = $('#baseUrl');
    input.focus();
    if (input.scrollIntoView) input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }

  function renderScanPanel(html) {
    const res = $('#projectScanResult');
    if (!res) return;
    res.style.display = 'flex';
    res.innerHTML = html;
  }

  function renderScanLoading(text) {
    renderScanPanel(`<div style="padding:20px;text-align:center;">
      <div class="spinner"></div>
      <p style="margin:10px 0 0;color:var(--text-muted)">${escapeXml(text)}</p>
    </div>`);
  }

  const ZIP_JUNK = /(^|\/)(__MACOSX|node_modules|\.git|\.svn|\.hg|\.idea|\.vscode|\.DS_Store|Thumbs\.db)(\/|$)|(^|\/)\._|\.DS_Store$/i;

  async function handleZip(file) {
    if (!window.JSZip) { showToast('JSZip non disponible.', 'error'); return; }
    if (!file) return;
    if (!ensureBaseUrl()) return;
    if (file.size === 0) {
      renderScanPanel('<div class="scan-badge err">✗ Fichier vide</div><p class="scan-err">Le ZIP fait 0 octet.</p>');
      return;
    }
    renderScanLoading('Extraction du ZIP…');
    if (!$('#spin-kf')) {
      const s = document.createElement('style');
      s.id = 'spin-kf';
      s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}.spinner{display:inline-block;width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 1s linear infinite;}';
      document.head.appendChild(s);
    }
    try {
      const zip = await JSZip.loadAsync(file, { checkCRC32: false });
      const items = [];
      let skipped = 0;
      for (const [relPath, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
        if (!clean || ZIP_JUNK.test(clean)) { skipped++; continue; }
        items.push({
          name: clean.split('/').pop(),
          path: clean,
          size: entry._data ? entry._data.uncompressedSize : 0,
          lastModified: entry.date ? entry.date.getTime() : null,
          text: () => entry.async('string'),
        });
      }
      if (!items.length) {
        throw new Error('Le ZIP ne contient aucun fichier exploitable (archive vide, ou uniquement node_modules/.git).');
      }
      if (items.length > 25000) {
        throw new Error(`ZIP trop volumineux (${items.length} fichiers). Supprimez node_modules/ et .git/ avant de zipper.`);
      }
      renderScanLoading(`${items.length} fichiers trouvés — analyse des routes…`);
      await scanFiles(items, 'zip');
      if (skipped) console.info(`[SitePlan] ${skipped} fichier(s) ignoré(s) (node_modules, .git, __MACOSX…).`);
    } catch (e) {
      const msg = /end of central directory|corrupted zip|not a zip/i.test(e.message || '')
        ? "Ce fichier n'est pas un ZIP valide (ou il est protégé par mot de passe)."
        : (e.message || 'Erreur inconnue');
      renderScanPanel(`<div class="scan-badge err">✗ Erreur ZIP</div><p class="scan-err">${escapeXml(msg)}</p>`);
      showToast('Erreur lors de la lecture du ZIP.', 'error');
    }
  }

  // ---------- Crawler ----------
  const crawlUI = { running: false };

  function setCrawlRunning(running) {
    crawlUI.running = running;
    const start = $('#startCrawl');
    const stop = $('#stopCrawl');
    if (start) start.disabled = running;
    if (stop) {
      stop.disabled = !running;
      stop.textContent = '⏹ Arrêter';
    }
  }

  /** Stop button: abort the in-flight request immediately (never wait for a timeout). */
  function requestStopCrawl() {
    if (!crawlUI.running || !crawlAbort) return;
    crawlAbort.stopped = true;
    try { crawlAbort.controller.abort(); } catch { /* ignore */ }
    const stop = $('#stopCrawl');
    if (stop) { stop.disabled = true; stop.textContent = '⏳ Arrêt…'; }
    const log = $('#crawlLog');
    if (log) {
      const d = document.createElement('div');
      d.className = 'warn';
      d.textContent = '> Arrêt demandé — abandon de la requête en cours…';
      log.insertBefore(d, log.firstChild);
    }
  }

  const hostKey = (host) => String(host || '').toLowerCase().replace(/^www\./, '');

  /** Read the site's sitemaps and robots.txt to seed URLs (works even if the home page is JS-only). */
  async function seedFromSitemaps(origin, opts) {
    const { signal, headers, log, addLoc, max, isAllowedHost } = opts;
    const sitemapQueue = [];
    const seenSitemaps = new Set();
    let added = 0;

    try {
      const robots = await fetchPage(new URL('/robots.txt', origin).href, { signal, headers });
      if (robots.status < 400 && robots.body) {
        const lines = robots.body.split(/\r?\n/);
        for (const line of lines) {
          const m = line.match(/^\s*sitemap:\s*(\S+)/i);
          if (m) sitemapQueue.push(m[1]);
          if (/^\s*disallow:\s*\/\s*$/i.test(line)) {
            log('⚠ robots.txt contient « Disallow: / » — le site refuse les robots, le crawl peut être bloqué.', 'warn');
          }
        }
        if (sitemapQueue.length) log(`robots.txt : ${sitemapQueue.length} sitemap(s) référencé(s).`, 'info');
      }
    } catch { /* pas de robots.txt : normal */ }

    if (!sitemapQueue.length) {
      sitemapQueue.push(new URL('/sitemap.xml', origin).href, new URL('/sitemap_index.xml', origin).href);
    }

    while (sitemapQueue.length && seenSitemaps.size < 12 && added < max) {
      if (signal.aborted) break;
      const smUrl = sitemapQueue.shift();
      if (seenSitemaps.has(smUrl)) continue;
      seenSitemaps.add(smUrl);
      let page;
      try { page = await fetchPage(smUrl, { signal, headers }); } catch { continue; }
      if (page.status >= 400 || !page.body) continue;
      let doc;
      try { doc = new DOMParser().parseFromString(page.body, 'application/xml'); } catch { continue; }
      if (!doc || doc.querySelector('parsererror')) continue;
      // sitemap index → follow children
      doc.querySelectorAll('sitemap > loc').forEach((n) => {
        const v = (n.textContent || '').trim();
        if (v) sitemapQueue.push(v);
      });
      const locs = Array.from(doc.querySelectorAll('url > loc'))
        .map((n) => (n.textContent || '').trim())
        .filter((v) => /^https?:\/\//i.test(v));
      if (!locs.length) continue;
      let usable = 0;
      for (const loc of locs) {
        if (added >= max) break;
        let host;
        try { host = new URL(loc).hostname; } catch { continue; }
        if (!isAllowedHost(host)) continue;
        if (addLoc(loc)) { added++; usable++; }
      }
      let label = smUrl;
      try { label = new URL(smUrl).pathname; } catch { /* ignore */ }
      log(`✓ sitemap ${label} : ${locs.length} URL(s), ${usable} ajoutée(s).`, 'ok');
    }
    return added;
  }

  async function crawl(startUrl) {
    if (crawlUI.running) return;

    const baseInput = ($('#baseUrl').value || '').trim() || startUrl;
    let baseObj;
    try { baseObj = new URL(baseInput); } catch {
      showToast('URL de base invalide.', 'error');
      return;
    }
    const start = normalizeUrl(startUrl, baseObj.href);
    if (!start) { showToast('URL de départ invalide.', 'error'); return; }

    const max = Math.max(1, Math.min(10000, parseInt($('#crawlMax').value, 10) || 500));
    const delay = Math.max(0, parseInt($('#crawlDelay').value, 10) || 0);
    const skipNoindex = $('#crawlSkipNoindex') ? $('#crawlSkipNoindex').checked : true;
    const allowSubdomains = $('#crawlSubdomains') ? $('#crawlSubdomains').checked : false;
    const headers = getCrawlHeaders();
    const baseHost = hostKey(baseObj.hostname);
    const isAllowedHost = (host) => {
      const h = hostKey(host);
      return h === baseHost || (allowSubdomains && h.endsWith('.' + baseHost));
    };

    const log = $('#crawlLog');
    log.innerHTML = '';
    const addLog = (msg, cls = '') => {
      const li = document.createElement('div');
      if (cls) li.className = cls;
      li.textContent = msg;
      log.insertBefore(li, log.firstChild);
      while (log.children.length > 120) log.removeChild(log.lastChild);
    };

    $('#crawlProgress').style.display = 'block';
    $('#crawlFound').textContent = '0';
    $('#crawlQueue').textContent = '0';
    $('#crawlErrors').textContent = '0';
    $('#crawlFill').style.width = '0%';
    setCrawlRunning(true);
    crawlAbort = { stopped: false, controller: new AbortController() };
    const abort = crawlAbort;
    const signal = abort.controller.signal;

    const queue = [];
    const enqueued = new Set();
    const visited = new Set();
    let found = 0, errs = 0, duplicates = 0, noindexSkipped = 0;
    let renderTimer = null;

    const tick = () => {
      $('#crawlFound').textContent = String(found);
      $('#crawlQueue').textContent = String(queue.length);
      $('#crawlErrors').textContent = String(errs);
      $('#crawlFill').style.width = Math.min(100, (found / max) * 100) + '%';
    };
    const scheduleRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => { renderTimer = null; render(); }, 400);
    };
    const addLoc = (loc) => {
      const r = addUrl(loc, { source: 'crawl', fromCrawl: true });
      if (r.ok) { found++; return true; }
      if (r.reason === 'duplicate') duplicates++;
      return false;
    };
    const push = (raw, fromUrl) => {
      const n = normalizeUrl(raw, fromUrl || baseObj.href);
      if (!n) return false;
      let u;
      try { u = new URL(n); } catch { return false; }
      if (!isAllowedHost(u.hostname)) return false;
      if (isExcluded(n, { crawl: true })) return false;
      if (visited.has(n) || enqueued.has(n)) return false;
      if (queue.length >= max * 3) return false;
      enqueued.add(n);
      queue.push(n);
      return true;
    };

    let stoppedByUser = false;
    proxyFails.clear();
    localProxyFails = 0;
    try {
      await probeLocalProxy(true);
      addLog(`> Démarrage depuis ${start} (max ${max})`, 'info');
      if (proxyState.local) {
        addLog(`Réseau : proxy local${Object.keys(headers).length ? ' + en-têtes d\'authentification' : ''}.`, 'info');
      } else {
        addLog('Réseau : proxys publics (CORS). Pour un résultat fiable et les sites protégés, lancez « node server.js ».', 'warn');
        if (Object.keys(headers).length) addLog('⚠ Cookie / Authorization ignorés : ils nécessitent le proxy local.', 'warn');
      }

      if (!isAllowedHost(new URL(start).hostname)) {
        addLog(`⚠ L'URL de départ n'est pas sur le domaine de base (${baseObj.hostname}) — vérifiez l'URL de base.`, 'warn');
      }

      // 1. Seed with robots.txt + sitemap(s): fast and covers JS-rendered sites.
      const seeded = await seedFromSitemaps(baseObj.origin, { signal, headers, log: addLog, addLoc, max, isAllowedHost });
      if (seeded) {
        addLog(`> ${seeded} URL(s) ajoutée(s) depuis les sitemaps.`, 'ok');
        tick(); scheduleRender();
      }
      if (abort.stopped) throw new DOMException('aborted', 'AbortError');

      // 2. Breadth-first crawl from the start URL.
      push(start);
      let authHintShown = false;
      while (queue.length && !abort.stopped && found < max) {
        const url = queue.shift();
        enqueued.delete(url);
        if (visited.has(url)) continue;
        visited.add(url);
        tick();

        let page;
        try {
          page = await fetchPage(url, { signal, headers });
        } catch (err) {
          if (abort.stopped || isAbortError(err, signal)) break;
          errs++;
          addLog(`✗ ${url} — ${err.message}`, 'err');
          if (!authHintShown) {
            authHintShown = true;
            addLog('ℹ Si le site est privé/protégé : lancez « node server.js », ouvrez http://localhost:8080 et renseignez un Cookie ou un token.', 'warn');
          }
          tick();
          continue;
        }

        if (abort.stopped) break;

        if (page.status >= 400) {
          errs++;
          const hint = (page.status === 401 || page.status === 403)
            ? ' (accès protégé — ajoutez un Cookie/Authorization via le proxy local)'
            : '';
          addLog(`✗ ${url} — HTTP ${page.status}${hint}`, 'err');
          tick();
          continue;
        }

        const ct = (page.contentType || '').toLowerCase();
        if (ct && !/text\/html|application\/xhtml|text\/plain|application\/xml/.test(ct)) {
          addLog(`↷ ${url} — ignoré (${ct.split(';')[0]})`, 'warn');
          continue;
        }

        const effective = page.finalUrl || url;
        const analysis = analyzePage(page.body);

        if (analysis.loginForm && analysis.links.length < 6 && !proxyState.local) {
          addLog(`⚠ ${url} ressemble à une page de connexion : le contenu réel est derrière un login.`, 'warn');
        }

        if (skipNoindex && analysis.noindex) {
          noindexSkipped++;
          addLog(`↷ ${url} — noindex, non ajoutée`, 'warn');
        } else {
          let effectiveHost = '';
          try { effectiveHost = new URL(effective).hostname; } catch { /* ignore */ }
          if (effectiveHost && isAllowedHost(effectiveHost)) {
            const r = addUrl(effective, { source: 'crawl', fromCrawl: true });
            if (r.ok) found++;
            else if (r.reason === 'duplicate') duplicates++;
          }
          addLog(`✓ ${url}${page.via && page.via !== 'proxy local' ? ` (via ${page.via})` : ''}`, 'ok');
        }

        for (const raw of analysis.links) {
          push(raw, effective);
        }

        tick();
        scheduleRender();
        if (delay) await sleep(delay, signal);
      }

      stoppedByUser = abort.stopped;
    } catch (err) {
      if (!isAbortError(err, signal) && !abort.stopped) {
        addLog(`✗ Erreur inattendue : ${err.message}`, 'err');
      }
      stoppedByUser = abort.stopped;
    } finally {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      if (stoppedByUser) addLog(`> Crawl arrêté par l'utilisateur (${found} URL(s) conservée(s)).`, 'warn');
      else if (found >= max) addLog(`> Limite de ${max} URLs atteinte.`, 'ok');
      else addLog(`> Terminé : ${found} URL(s) trouvée(s), ${errs} erreur(s)${duplicates ? `, ${duplicates} déjà présente(s)` : ''}${noindexSkipped ? `, ${noindexSkipped} noindex ignorée(s)` : ''}.`, 'ok');
      $('#crawlQueue').textContent = '0';
      crawlAbort = null;
      setCrawlRunning(false);
      render(); saveState(); updateStepper();
    }
  }

  // ---------- Sitemap import ----------
  async function importSitemapFromUrl(url) {
    const btn = $('#importSitemapUrl');
    const prevLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Import…'; }
    try {
      await probeLocalProxy();
      const seen = new Set();
      const pending = [url];
      const all = [];
      const errors = [];
      while (pending.length && seen.size < 20) {
        const sm = pending.shift();
        if (seen.has(sm)) continue;
        seen.add(sm);
        let page;
        try { page = await fetchPage(sm); } catch (e) { errors.push(e.message); continue; }
        if (page.status >= 400) { errors.push(`${sm} → HTTP ${page.status}`); continue; }
        const doc = new DOMParser().parseFromString(page.body, 'application/xml');
        if (doc.querySelector('parsererror')) { errors.push(`${sm} → XML invalide`); continue; }
        const children = Array.from(doc.querySelectorAll('sitemap > loc')).map((n) => n.textContent.trim()).filter(Boolean);
        const locs = Array.from(doc.querySelectorAll('url > loc')).map((n) => n.textContent.trim()).filter(Boolean);
        if (children.length && !locs.length) { children.forEach((c) => pending.push(c)); continue; }
        all.push(...locs);
      }
      if (!all.length) {
        showToast(errors[0] ? `Import impossible : ${errors[0]}` : 'Aucune URL trouvée dans ce sitemap.', 'error');
        return;
      }
      const r = addMany(all, 'import');
      render(); saveState(); updateStepper();
      showToast(`${r.added} URL(s) importée(s) sur ${all.length}${seen.size > 1 ? ` (${seen.size} sitemaps)` : ''}.`, r.added ? 'success' : 'error');
    } catch (e) {
      showToast('Erreur : ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = prevLabel || 'Importer'; }
    }
  }

  function parseAndImportSitemap(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const sitemaps = Array.from(doc.querySelectorAll('sitemap > loc')).map((n) => n.textContent.trim());
    const locs = Array.from(doc.querySelectorAll('url > loc')).map((n) => n.textContent.trim());
    if (sitemaps.length && !locs.length) {
      showToast(`Sitemap index détecté (${sitemaps.length} sitemaps). Importez-les un par un.`, 'error');
      return;
    }
    const r = addMany(locs, 'import');
    render(); saveState(); updateStepper();
    showToast(`${r.added} URLs importées sur ${locs.length}.`, r.added ? 'success' : 'error');
  }

  const readFileAsText = (f) => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(f);
  });

  // ---------- Rendering ----------
  function visibleUrls() {
    const q = ($('#filterUrls').value || '').trim().toLowerCase();
    return urls.filter((u) => !q || u.loc.toLowerCase().includes(q));
  }

  function srcTagClass(src) {
    if (!src) return '';
    if (src.startsWith('proj') || src === 'folder' || src === 'zip') return 'proj';
    if (src === 'crawl') return 'crawl';
    if (src.startsWith('sitemap') || src === 'import') return 'import';
    return '';
  }

  function renderTable() {
    const tbody = $('#urlTbody');
    tbody.innerHTML = '';
    if (urls.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8"><div class="empty-state"><div class="empty-ic">🪺</div><p>Aucune URL pour le moment</p><small>Ajoutez-en via le ZIP, le dossier, le crawl…</small></div></td></tr>`;
      $('#urlCount').textContent = '0';
      $('#statsRow').style.display = 'none';
      $('#bulkActions').style.display = 'none';
      return;
    }
    $('#urlCount').textContent = String(urls.length);
    $('#statsRow').style.display = 'flex';
    const vis = visibleUrls();
    const total = urls.length;
    $('#statTotal').innerHTML = `<strong>${total}</strong> URL${total > 1 ? 's' : ''}`;
    const f = $('#filterUrls').value.trim();
    $('#statFiltered').textContent = f ? `· ${vis.length} affichée(s)` : '';

    const sel = urls.filter((u) => u.selected).length;
    $('#bulkActions').style.display = sel > 0 ? 'flex' : 'none';
    $('#selectedCount').textContent = sel;

    vis.forEach((u) => {
      const idx = urls.indexOf(u);
      const tr = document.createElement('tr');
      if (u.dynamic) tr.classList.add('dynamic-row');
      const srcLabel = (u.source || 'manual').replace('proj:', '');
      if (editMode) {
        tr.innerHTML = `
          <td><input type="checkbox" class="row-sel" data-i="${idx}" ${u.selected ? 'checked' : ''}></td>
          <td>${idx + 1}</td>
          <td><input type="text" class="cell-url" value="${escapeXml(u.loc)}" data-edit="loc" data-i="${idx}"></td>
          <td><input type="date" value="${escapeXml(u.lastmod || '')}" data-edit="lastmod" data-i="${idx}"></td>
          <td><select data-edit="changefreq" data-i="${idx}">
            ${['always','hourly','daily','weekly','monthly','yearly','never'].map((v) => `<option value="${v}" ${u.changefreq===v?'selected':''}>${v}</option>`).join('')}
          </select></td>
          <td><select data-edit="priority" data-i="${idx}">
            ${['1.0','0.9','0.8','0.7','0.6','0.5','0.4','0.3','0.2','0.1'].map((v) => `<option value="${v}" ${u.priority===v?'selected':''}>${v}</option>`).join('')}
          </select></td>
          <td><span class="src-tag ${srcTagClass(u.source)}">${escapeXml(srcLabel)}</span></td>
          <td><button class="row-delete" data-del="${idx}">✕</button></td>`;
      } else {
        tr.innerHTML = `
          <td><input type="checkbox" class="row-sel" data-i="${idx}" ${u.selected ? 'checked' : ''}></td>
          <td>${idx + 1}</td>
          <td class="url-cell">${escapeXml(u.loc)}</td>
          <td style="color:var(--text-muted);font-size:12px;">${escapeXml(u.lastmod || '—')}</td>
          <td style="color:var(--text-muted);font-size:12px;">${escapeXml(u.changefreq || '—')}</td>
          <td style="color:var(--text-muted);font-size:12px;">${escapeXml(u.priority || '—')}</td>
          <td><span class="src-tag ${srcTagClass(u.source)}">${escapeXml(srcLabel)}</span></td>
          <td><button class="row-delete" data-del="${idx}">✕</button></td>`;
      }
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      urls.splice(+b.dataset.del, 1); render(); saveState();
    }));
    tbody.querySelectorAll('.row-sel').forEach((cb) => cb.addEventListener('change', () => {
      urls[+cb.dataset.i].selected = cb.checked; renderTable();
    }));
    if (editMode) {
      tbody.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('change', () => {
        const i = +el.dataset.i;
        urls[i][el.dataset.edit] = el.value;
        if (el.dataset.edit === 'loc') {
          const base = $('#baseUrl').value.trim();
          urls[i].loc = normalizeUrl(el.value, base) || el.value;
        }
        renderOutput(); saveState();
      }));
    }
    $('#selectAll').checked = urls.length > 0 && urls.every((u) => u.selected);
  }

  // ---------- Syntax-highlighted output ----------
  function highlightXml(xml) {
    return escapeXml(xml)
      .replace(/(&lt;\/?[\w:-]+)/g, '<span class="tok-tag">$1</span>')
      .replace(/(\s)([\w:-]+)=(&quot;)/g, '$1<span class="tok-attr">$2</span>=$3')
      .replace(/&quot;([^&]*?)&quot;/g, '&quot;<span class="tok-val">$1</span>&quot;')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-com">$1</span>');
  }
  function highlightTs(ts) {
    return escapeXml(ts)
      .replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="tok-com">$1</span>')
      .replace(/\b(import|from|export|default|const|let|var|function|return|if|else|type|as|async|await|new|class|extends|for|while|switch|case|break|continue)\b/g, '<span class="tok-kw">$1</span>')
      .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="tok-str">$1</span>')
      .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-val">$1</span>');
  }

  function renderOutput() {
    const pre = $('#outputPreview');
    const stats = $('#outputStats');
    if (urls.length === 0) {
      pre.innerHTML = '<code class="dim">// Ajoutez des URLs pour voir l\'export.</code>';
      stats.textContent = ''; $('#codeFilename').textContent = currentExport === 'nextSitemap' ? 'sitemap.ts' : currentExport === 'nextRobots' ? 'robots.ts' : 'sitemap.xml';
      $('#codeLang').textContent = currentExport.startsWith('next') ? 'TS' : currentExport === 'robots' ? 'TXT' : 'XML';
      return;
    }
    const base = $('#baseUrl').value.trim() || 'https://example.com';
    const sitemapUrl = base.replace(/\/$/, '') + '/sitemap.xml';
    let content = '', filename = '', lang = 'XML';

    if (currentExport === 'xml') {
      content = buildXmlSitemap(urls.slice(0, MAX_URLS_PER_SITEMAP));
      filename = 'sitemap.xml'; lang = 'XML';
      if (urls.length > MAX_URLS_PER_SITEMAP) content = `<!-- ⚠️ ${urls.length} URLs (> ${MAX_URLS_PER_SITEMAP}) : utilisez l'export sitemap-index.xml -->\n\n` + content;
    } else if (currentExport === 'index') {
      const chunks = splitSitemaps();
      const list = chunks.map((_, i) => ({ loc: base.replace(/\/$/, '') + `/sitemap-${i+1}.xml`, lastmod: todayIso() }));
      content = buildSitemapIndex(list) + `\n\n<!-- ${chunks.length} sous-sitemap(s), ${urls.length} URLs au total -->`;
      filename = 'sitemap-index.xml'; lang = 'XML';
    } else if (currentExport === 'robots') {
      content = buildRobotsTxt(sitemapUrl); filename = 'robots.txt'; lang = 'TXT';
    } else if (currentExport === 'nextSitemap') {
      content = buildNextSitemapTs(); filename = 'sitemap.ts'; lang = 'TS';
    } else if (currentExport === 'nextRobots') {
      content = buildNextRobotsTs(); filename = 'robots.ts'; lang = 'TS';
    }

    $('#codeFilename').textContent = filename;
    $('#codeLang').textContent = lang;
    pre.innerHTML = lang === 'TS' ? highlightTs(content) : (lang === 'XML' ? highlightXml(content) : escapeXml(content));
    pre.dataset.content = content; pre.dataset.filename = filename;
    const bytes = new Blob([content]).size;
    stats.innerHTML = `<span>📦 ${urls.length} URLs</span> · <span>💾 ${(bytes/1024).toFixed(1)} KB</span>`;
  }

  function render() { renderTable(); renderOutput(); }

  function updateStepper() {
    const s1 = urls.length === 0;
    $('#stepper').querySelectorAll('.step').forEach((el, i) => {
      el.classList.remove('active', 'done');
      const n = i + 1;
      if ((n === 1 && s1) || (n === 2 && urls.length === 0) || (n === 3 && urls.length > 0 && currentExport === 'xml') || (n === 4)) {
        // N/A: we highlight based on current state
      }
    });
    // Simpler logic: step 1 if no baseUrl filled, else step 2 if 0 urls, else step 3 always (step 4 when export tab used)
    const steps = $('#stepper').querySelectorAll('.step');
    steps.forEach((s) => s.classList.remove('active', 'done'));
    let active = 1;
    if (!$('#baseUrl').value.trim()) active = 1;
    else if (urls.length === 0) active = 2;
    else if (currentExport === 'xml') active = 3;
    else active = 4;
    steps.forEach((s) => {
      const n = +s.dataset.step;
      if (n < active) s.classList.add('done');
      if (n === active) s.classList.add('active');
    });
  }

  // ---------- Exports content builders ----------
  function buildXmlSitemap(list) {
    const useHreflang = $('#useHreflang').checked;
    const hreflangs = $$('.hreflang-row').map((r) => ({
      lang: $('.hf-lang', r).value.trim(), url: $('.hf-url', r).value.trim(),
    })).filter((h) => h.lang && h.url);
    const L = ['<?xml version="1.0" encoding="UTF-8"?>'];
    const attrs = ['xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'];
    if (useHreflang && hreflangs.length) attrs.push('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    attrs.push('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"');
    attrs.push('xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd"');
    L.push(`<urlset ${attrs.join(' ')}>`);
    for (const u of list) {
      L.push('  <url>');
      L.push(`    <loc>${escapeXml(u.loc)}</loc>`);
      if (u.lastmod) L.push(`    <lastmod>${escapeXml(u.lastmod)}</lastmod>`);
      if (u.changefreq) L.push(`    <changefreq>${escapeXml(u.changefreq)}</changefreq>`);
      if (u.priority) L.push(`    <priority>${escapeXml(u.priority)}</priority>`);
      if (useHreflang && hreflangs.length) {
        for (const h of hreflangs) {
          try {
            const uUrl = new URL(u.loc);
            const hBase = h.url.endsWith('/') ? h.url : h.url + '/';
            const alt = new URL(uUrl.pathname + uUrl.search, hBase).toString();
            L.push(`    <xhtml:link rel="alternate" hreflang="${escapeXml(h.lang)}" href="${escapeXml(alt)}"/>`);
          } catch {}
        }
        L.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(u.loc)}"/>`);
      }
      L.push('  </url>');
    }
    L.push('</urlset>');
    return L.join('\n');
  }
  function buildSitemapIndex(sitemaps) {
    const L = ['<?xml version="1.0" encoding="UTF-8"?>'];
    L.push('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    for (const s of sitemaps) {
      L.push('  <sitemap>');
      L.push(`    <loc>${escapeXml(s.loc)}</loc>`);
      L.push(`    <lastmod>${escapeXml(s.lastmod)}</lastmod>`);
      L.push('  </sitemap>');
    }
    L.push('</sitemapindex>');
    return L.join('\n');
  }
  function splitSitemaps() {
    const out = [];
    for (let i = 0; i < urls.length; i += MAX_URLS_PER_SITEMAP) out.push(urls.slice(i, i + MAX_URLS_PER_SITEMAP));
    return out;
  }
  function buildRobotsTxt(sitemapUrl) {
    return [
      'User-agent: *',
      'Allow: /',
      '',
      '# Disallow private paths',
      'Disallow: /api/',
      'Disallow: /admin/',
      'Disallow: /dashboard/',
      'Disallow: /_next/',
      'Disallow: /_nuxt/',
      '',
      `Sitemap: ${sitemapUrl}`,
    ].join('\n');
  }
  function buildNextSitemapTs() {
    const base = $('#baseUrl').value.trim() || 'https://example.com';
    const routes = urls.map((u) => {
      try { return { path: new URL(u.loc).pathname, priority: parseFloat(u.priority), changeFrequency: u.changefreq, dynamic: u.dynamic }; }
      catch { return null; }
    }).filter(Boolean);
    const o = [];
    o.push(`import type { MetadataRoute } from "next";`);
    o.push(``);
    o.push(`const BASE_URL = (`);
    o.push(`  process.env.NEXT_PUBLIC_SITE_URL ?? "${base.replace(/\/$/, '')}"`);
    o.push(`).replace(/\\/$/, "");`);
    o.push(``);
    o.push(`const ROUTES: Array<{`);
    o.push(`  path: string;`);
    o.push(`  priority: number;`);
    o.push(`  changeFrequency: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";`);
    o.push(`}> = [`);
    routes.forEach((r) => {
      o.push(`  { path: "${r.path}", priority: ${r.priority}, changeFrequency: "${r.changeFrequency}" },${r.dynamic ? ' // ⚡ dynamique' : ''}`);
    });
    o.push(`];`);
    o.push(``);
    o.push(`export default function sitemap(): MetadataRoute.Sitemap {`);
    o.push(`  const lastModified = new Date();`);
    o.push(`  return ROUTES.map((route) => ({`);
    o.push(`    url: \`\${BASE_URL}\${route.path}\`,`);
    o.push(`    lastModified,`);
    o.push(`    changeFrequency: route.changeFrequency,`);
    o.push(`    priority: route.priority,`);
    o.push(`  }));`);
    o.push(`}`);
    if (routes.some((r) => r.dynamic)) {
      o.push(``);
      o.push(`/*`);
      o.push(` * ⚡ Routes dynamiques détectées. Exemple :`);
      o.push(` *   import { prisma } from "@/lib/db";`);
      o.push(` *   const posts = await prisma.post.findMany({ select: { slug: true, updatedAt: true } });`);
      o.push(` *   return [...ROUTES.map(...), ...posts.map(p => ({ url: \`\${BASE_URL}/blog/\${p.slug}\`, ... }))];`);
      o.push(` */`);
    }
    return o.join('\n');
  }
  function buildNextRobotsTs() {
    const base = $('#baseUrl').value.trim() || 'https://example.com';
    return [
      `import type { MetadataRoute } from "next";`,
      ``,
      `export default function robots(): MetadataRoute.Robots {`,
      `  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "${base.replace(/\/$/, '')}";`,
      `  return {`,
      `    rules: [`,
      `      { userAgent: "*", allow: "/", disallow: ["/api/", "/admin/"] },`,
      `    ],`,
      `    sitemap: \`\${baseUrl}/sitemap.xml\`,`,
      `    host: baseUrl,`,
      `  };`,
      `}`,
    ].join('\n');
  }

  // ---------- Tabs ----------
  function initTabs() {
    $$('.pill').forEach((b) => b.addEventListener('click', () => {
      $$('.pill').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === b.dataset.tab));
    }));
    $$('.exp-tab').forEach((b) => b.addEventListener('click', () => {
      currentExport = b.dataset.exp;
      $$('.exp-tab').forEach((x) => x.classList.toggle('active', x === b));
      renderOutput(); updateStepper();
    }));
    $$('.step').forEach((s) => s.addEventListener('click', () => {
      const n = s.dataset.step;
      // Scroll to section
      const section = $(`.card[data-section="${n}"]`);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  // ---------- Dropzones ----------
  function wireDropzone(el, onFiles, clickTargets = []) {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'LABEL' || e.target.tagName === 'INPUT') return;
      for (const t of clickTargets) if (e.target === t || t.contains(e.target)) return;
      if (clickTargets[0]) clickTargets[0].click();
    });
    ['dragenter','dragover'].forEach((ev) => el.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.add('dragover');
    }));
    ['dragleave','drop'].forEach((ev) => el.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      if (ev === 'dragleave' && el.contains(e.relatedTarget)) return;
      el.classList.remove('dragover');
    }));
    el.addEventListener('drop', (e) => { if (e.dataTransfer) onFiles(e.dataTransfer.files, e.dataTransfer); });
  }

  // ---------- Hreflang ----------
  function addHreflangRow(lang = '', url = '') {
    const box = $('#hreflangList');
    const row = document.createElement('div');
    row.className = 'hreflang-row';
    row.innerHTML = `
      <input type="text" class="hf-lang" placeholder="fr" value="${escapeXml(lang)}">
      <input type="url" class="hf-url" placeholder="https://fr.example.com/" value="${escapeXml(url)}">
      <button type="button" class="btn btn-ghost btn-sm hf-remove">✕</button>`;
    $('.hf-remove', row).addEventListener('click', () => { row.remove(); saveState(); renderOutput(); });
    $('.hf-lang,.hf-url', row).forEach((i) => i.addEventListener('input', () => { saveState(); renderOutput(); }));
    box.appendChild(row);
  }
  function updateHreflang() { $('#hreflangBox').style.display = $('#useHreflang').checked ? 'block' : 'none'; }
  function updateLastmod() { $('#customLastmodRow').style.display = $('#lastmodMode').value === 'custom' ? 'block' : 'none'; }

  // ---------- Init ----------
  function init() {
    if (initialized) return; // DOMContentLoaded can fire twice (e.g. re-dispatch)
    initialized = true;
    $('#defaultLastmod').value = todayIso();
    loadState();
    updateLastmod(); updateHreflang();
    initTabs();

    // Config
    ['baseUrl','defaultChangefreq','defaultPriority','defaultLastmod','excludePatterns'].forEach((id) => {
      $('#'+id).addEventListener('change', () => { saveState(); render(); updateStepper(); });
      $('#'+id).addEventListener('blur', () => { saveState(); render(); updateStepper(); });
    });
    $('#lastmodMode').addEventListener('change', () => { updateLastmod(); saveState(); render(); });
    ['stripIndex','stripTrailing','stripHash','stripSearch'].forEach((id) => {
      $('#'+id).addEventListener('change', () => { saveState(); render(); });
    });
    $('#useHreflang').addEventListener('change', () => { updateHreflang(); saveState(); renderOutput(); });
    $('#addHreflang').addEventListener('click', () => addHreflangRow());
    $('#filterUrls').addEventListener('input', () => renderTable());
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
        e.preventDefault(); $('#filterUrls').focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#filterUrls').focus(); }
    });

    // Project dropzone (ZIP + folder)
    wireDropzone($('#projectDropzone'), (files, dataTransfer) => {
      if (!ensureBaseUrl()) return;
      if ((!files || !files.length) && !dataTransfer) return;
      handleProjectFiles(files, dataTransfer);
    }, [$('#pickZip'), $('#pickFolder')]);
    $('#pickZip').addEventListener('click', (e) => { e.stopPropagation(); $('#zipInput').click(); });
    $('#pickFolder').addEventListener('click', (e) => { e.stopPropagation(); $('#folderInput').click(); });
    $('#zipInput').addEventListener('change', (e) => {
      if (e.target.files[0]) handleZip(e.target.files[0]);
      e.target.value = '';
    });
    $('#folderInput').addEventListener('change', (e) => {
      if (e.target.files.length && ensureBaseUrl()) {
        renderScanLoading(`${e.target.files.length} fichiers trouvés — analyse des routes…`);
        scanFiles(normalizeFileList(e.target.files), 'folder');
      }
      e.target.value = '';
    });

    // HTML files dropzone
    wireDropzone($('#dropzone'), (files) => handleHtmlFiles(files), [$('#fileInput')]);
    $('#fileInput').addEventListener('change', (e) => { handleHtmlFiles(e.target.files); e.target.value = ''; });

    // Sitemap dropzone
    wireDropzone($('#sitemapDz'), (files) => {
      if (!files[0]) return;
      readFileAsText(files[0]).then(parseAndImportSitemap).catch((e) => showToast('Erreur: '+e.message, 'error'));
    }, [$('#sitemapFile')]);
    $('#sitemapFile').addEventListener('change', (e) => {
      if (e.target.files[0]) readFileAsText(e.target.files[0]).then(parseAndImportSitemap);
      e.target.value = '';
    });

    // Buttons
    $('#addSingle').addEventListener('click', handleAddSingle);
    $('#singleUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSingle(); } });
    $('#addBatch').addEventListener('click', handleAddBatch);
    $('#addFromHtml').addEventListener('click', handleAddFromHtml);
    $('#clearAll').addEventListener('click', () => {
      if (!urls.length) return;
      if (confirm('Vider toutes les URLs ?')) { urls = []; render(); saveState(); showToast('Liste vidée.', 'success'); }
    });
    $('#editMode').addEventListener('click', () => {
      editMode = !editMode;
      $('#editMode').innerHTML = editMode
        ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Terminer'
        : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg> Modifier';
      render();
    });
    $('#dedupeBtn').addEventListener('click', () => {
      const seen = new Set(); const before = urls.length;
      urls = urls.filter((u) => (seen.has(u.loc) ? false : (seen.add(u.loc), true)));
      render(); saveState(); showToast(`${before - urls.length} doublon(s) retiré(s).`, 'success');
    });
    $('#copyOutput').addEventListener('click', () => {
      const content = $('#outputPreview').dataset.content || '';
      if (!content) { showToast('Rien à copier.', 'error'); return; }
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(content).then(
          () => showToast('Copié dans le presse-papier.', 'success'),
          () => fallbackCopy(content)
        );
      } else fallbackCopy(content);
    });
    $('#downloadOutput').addEventListener('click', () => {
      const content = $('#outputPreview').dataset.content || '';
      const filename = $('#outputPreview').dataset.filename || 'sitemap.xml';
      if (!content) { showToast('Ajoutez des URLs.', 'error'); return; }
      const type = filename.endsWith('.ts') ? 'text/plain' : (filename.endsWith('.xml') ? 'application/xml' : 'text/plain');
      const blob = new Blob([content], { type: type + ';charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 500);
      showToast(`${filename} téléchargé.`, 'success');
    });
    $('#startCrawl').addEventListener('click', () => {
      if (crawlUI.running) return;
      const u = $('#crawlStart').value.trim() || $('#baseUrl').value.trim();
      if (!u) { showToast('URL de départ requise.', 'error'); return; }
      const start = normalizeUrl(u, u);
      if (!start) { showToast('URL invalide.', 'error'); return; }
      if (!$('#baseUrl').value.trim()) $('#baseUrl').value = start;
      $('#crawlStart').value = start;
      saveState();
      crawl(start);
    });
    $('#crawlStart').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('#startCrawl').click(); }
    });
    $('#stopCrawl').addEventListener('click', requestStopCrawl);
    $('#stopCrawl').disabled = true;
    $('#recheckProxy').addEventListener('click', async () => {
      proxyState.checked = false;
      updateProxyBadge();
      await probeLocalProxy(true);
      showToast(proxyState.local ? 'Proxy local disponible ✓' : 'Proxy local indisponible — proxys publics utilisés.', proxyState.local ? 'success' : 'error');
    });
    updateProxyBadge();
    probeLocalProxy();
    $('#importSitemapUrl').addEventListener('click', () => {
      const u = $('#sitemapUrl').value.trim();
      if (!u) { showToast('URL requise.', 'error'); return; }
      importSitemapFromUrl(u);
    });

    // Bulk
    $('#selectAll').addEventListener('change', (e) => {
      urls.forEach((u) => (u.selected = e.target.checked));
      renderTable();
    });
    $('#bulkDelete').addEventListener('click', () => {
      const n = urls.filter((u) => u.selected).length;
      urls = urls.filter((u) => !u.selected);
      render(); saveState(); showToast(`${n} URL(s) supprimée(s).`, 'success');
    });
    $('#bulkChangefreq').addEventListener('click', () => {
      const v = prompt('Changefreq ?', $('#defaultChangefreq').value);
      if (!v) return;
      urls.filter((u) => u.selected).forEach((u) => (u.changefreq = v));
      render(); saveState();
    });
    $('#bulkPriority').addEventListener('click', () => {
      const v = prompt('Priority ?', $('#defaultPriority').value);
      if (!v) return;
      urls.filter((u) => u.selected).forEach((u) => (u.priority = v));
      render(); saveState();
    });

    render(); updateStepper();

    // Prevent the browser from opening dropped files, and still handle drops
    // that happen outside a dropzone (very common "it does nothing" case).
    ['dragover','drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
    window.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      const files = Array.from(dt.files);
      const zips = files.filter((f) => /\.zip$/i.test(f.name));
      if (zips.length) { handleZip(zips[0]); return; }
      const html = files.filter((f) => HTML_EXTS.test(f.name));
      if (html.length) { handleHtmlFiles(html); return; }
      if (files.every((f) => /\.xml$/i.test(f.name))) {
        readFileAsText(files[0]).then(parseAndImportSitemap).catch((err) => showToast('Erreur: ' + err.message, 'error'));
        return;
      }
      showToast('Format non reconnu : déposez un .zip, des .html/.php ou un .xml.', 'error');
    });
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('Copié.', 'success'); }
    catch { showToast('Copie impossible.', 'error'); }
    document.body.removeChild(ta);
  }

  // ---------- Multi-source handler for drag-drop ----------
  /** Recursively read a drag-and-dropped directory entry (Chrome/Edge/Safari). */
  async function readEntry(entry, prefix = '') {
    if (!entry) return [];
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      return [{ file, path: prefix + file.name }];
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((res, rej) => {
        const out = [];
        const read = () => reader.readEntries((batch) => {
          if (!batch.length) return res(out);
          out.push(...batch);
          read();
        }, rej);
        read();
      });
      const out = [];
      for (const child of children) out.push(...await readEntry(child, prefix + entry.name + '/'));
      return out;
    }
    return [];
  }

  /** Files dropped as a folder arrive empty through dataTransfer.files → use webkitGetAsEntry. */
  async function filesFromDataTransfer(dt) {
    const entries = [];
    if (dt && dt.items) {
      for (const item of Array.from(dt.items)) {
        if (item.kind !== 'file') continue;
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) entries.push(entry);
      }
    }
    if (!entries.length) {
      return Array.from((dt && dt.files) || []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    }
    const pairs = [];
    for (const entry of entries) pairs.push(...await readEntry(entry, ''));
    return pairs;
  }

  function pairsToScanItems(pairs) {
    return pairs.map(({ file, path }) => ({
      name: file.name,
      path: (path || file.name).replace(/\\/g, '/'),
      size: file.size,
      lastModified: file.lastModified,
      text: () => readFileAsText(file),
    }));
  }

  async function handleProjectFiles(fileList, dataTransfer) {
    if (!ensureBaseUrl()) return;
    let pairs = [];
    if (dataTransfer) {
      try { pairs = await filesFromDataTransfer(dataTransfer); } catch { pairs = []; }
    }
    if (!pairs.length) {
      pairs = Array.from(fileList || []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    }
    if (!pairs.length) { showToast('Aucun fichier détecté dans le dépôt.', 'error'); return; }

    const zips = pairs.filter((p) => /\.zip$/i.test(p.file.name));
    if (zips.length === pairs.length) {
      if (zips.length > 1) showToast('Plusieurs ZIP déposés : seul le premier est analysé.', 'error');
      handleZip(zips[0].file);
      return;
    }
    if (zips.length) showToast('Les .zip déposés avec d\'autres fichiers sont ignorés — déposez le ZIP seul.', 'error');

    const files = pairs.filter((p) => !/\.zip$/i.test(p.file.name));
    if (!files.length) return;
    if (files.length > 25000) {
      renderScanPanel(`<div class="scan-badge err">✗ Trop de fichiers</div><p class="scan-err">${files.length} fichiers déposés (limite 25 000). Déposez un ZIP sans node_modules.</p>`);
      return;
    }
    renderScanLoading(`${files.length} fichiers trouvés — analyse des routes…`);
    await scanFiles(pairsToScanItems(files), 'folder');
  }

  async function handleHtmlFiles(files) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    let added = 0;
    for (const f of arr) {
      try {
        const text = await readFileAsText(f);
        const base = $('#baseUrl').value.trim();
        const links = extractLinks(text, base);
        let selfPath = '/' + f.name.replace(/^\/+/, '');
        if (selfPath === '/index.html') selfPath = '/';
        if (HTML_EXTS.test(f.name)) {
          const r = addUrl(selfPath, { source: 'files' });
          if (r.ok) added++;
        }
        const lm = f.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null;
        const r = addMany(links, 'files', lm);
        added += r.added;
      } catch {}
    }
    render(); saveState(); updateStepper();
    showToast(`${arr.length} fichier(s) · ${added} URL(s) ajoutée(s).`, added ? 'success' : 'error');
  }

  function handleAddSingle() {
    const loc = $('#singleUrl').value;
    if (!loc.trim()) { showToast('URL requise.', 'error'); return; }
    const r = addUrl(loc, {
      changefreq: $('#singleChangefreq').value || undefined,
      priority: $('#singlePriority').value || undefined,
      lastmod: $('#singleLastmod').value || undefined,
      source: 'manual',
    });
    if (!r.ok) { showToast(r.reason === 'duplicate' ? 'Doublon.' : r.reason === 'excluded' ? 'Exclue.' : 'Invalide.', 'error'); return; }
    $('#singleUrl').value = ''; $('#singleLastmod').value = '';
    $('#singleChangefreq').value = ''; $('#singlePriority').value = '';
    render(); saveState(); updateStepper(); showToast('URL ajoutée.', 'success');
  }
  function handleAddBatch() {
    const lines = $('#batchUrls').value.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { showToast('Aucune URL.', 'error'); return; }
    const r = addMany(lines, 'manual');
    $('#batchUrls').value = ''; render(); saveState(); updateStepper();
    showToast(`${r.added} ajoutée(s)${r.dup ? `, ${r.dup} doublon(s)` : ''}${r.excl ? `, ${r.excl} exclue(s)` : ''}.`, r.added ? 'success' : 'error');
  }
  function handleAddFromHtml() {
    const html = $('#htmlCode').value;
    if (!html.trim()) { showToast('Collez du HTML.', 'error'); return; }
    const base = $('#baseUrl').value.trim();
    const links = extractLinks(html, base);
    if (!links.length) { showToast('Aucun lien détecté.', 'error'); return; }
    const r = addMany(links, 'html');
    $('#htmlCode').value = ''; render(); saveState(); updateStepper();
    showToast(`${links.length} lien(s) détecté(s), ${r.added} ajouté(s).`, r.added ? 'success' : 'error');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
