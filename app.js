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

  const STORAGE_KEY = 'siteplan:v3';
  const MAX_URLS_PER_SITEMAP = 45000;
  const ASSET_EXTS = /\.(js|mjs|cjs|ts|tsx|jsx|css|scss|less|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|flac|aac|woff2?|ttf|otf|eot|map)(\?.*)?$/i;
  const HTML_EXTS = /\.(html?|php|htm|xhtml)$/i;
  const INTERNAL_SEGMENTS = ['api', '_next', '_nuxt', '_astro', '_app', '__next', 'wp-admin', 'wp-includes', '.git', 'node_modules', '.next', 'dist', 'build', 'vendor', '.cache', '__pycache__'];

  const CORS_PROXIES = [
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    (u) => `https://cors.eu.org/${u}`,
  ];

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
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const set = new Set();
    doc.querySelectorAll('a[href], link[rel="alternate"][href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (h) set.add(h);
    });
    doc.querySelectorAll('loc').forEach((l) => {
      if (l.textContent) set.add(l.textContent.trim());
    });
    return Array.from(set);
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
  async function scanFiles(fileObjects, sourceName = 'folder') {
    // Build paths
    const paths = fileObjects.map((f) => f.path);
    // Determine common root for folder uploads
    let rootPrefix = '';
    if (sourceName === 'folder') {
      const first = paths[0] || '';
      const slash = first.indexOf('/');
      if (slash > 0) rootPrefix = first.slice(0, slash + 1);
    }
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

    if ((framework === 'next-app') && appDir) {
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
      if (pagesDir) {
        const pageRe = new RegExp(`^${pagesDir}/(.*)\.(tsx|ts|jsx|js|mdx?)$`);
        paths.forEach((p) => {
          const rp = rel(p);
          const m = rp.match(pageRe);
          if (!m) return;
          let page = m[1];
          if (page.startsWith('api/') || page === 'api') return;
          if (page.startsWith('_')) return;
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
        const txt = await f.text();
        const links = extractLinks(txt, base);
        const lm = f.lastModified ? new Date(f.lastModified).toISOString().slice(0,10) : null;
        const r = addMany(links, 'html-scan', lm);
        linksAdded += r.added;
      } catch {}
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
      </div>
      <ul class="scan-list">
        ${routes.slice(0, 20).map((r) => `<li class="${r.dynamic ? 'dyn' : ''}"><span>${escapeXml(r.path)}</span> <span class="tag ${r.dynamic ? 'dyn' : ''}">${r.dynamic ? 'dyn' : r.priority}</span></li>`).join('')}
        ${routes.length > 20 ? `<li style="justify-content:center;color:var(--text-dim)">… et ${routes.length - 20} autres</li>` : ''}
      </ul>
    `;
    // Switch to URLs tab (step 3)
    updateStepper();
  }

  async function handleZip(file) {
    if (!window.JSZip) { showToast('JSZip non disponible.', 'error'); return; }
    const res = $('#projectScanResult');
    res.style.display = 'flex';
    res.innerHTML = `<div style="padding:20px;text-align:center;">
      <div style="display:inline-block;width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--primary);border-radius:50%;animation:spin 1s linear infinite;"></div>
      <p style="margin:10px 0 0;color:var(--text-muted)">Extraction du ZIP en cours…</p>
    </div>`;
    // Inject spin keyframe if not present
    if (!$('#spin-kf')) {
      const s = document.createElement('style');
      s.id = 'spin-kf';
      s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }
    try {
      const zip = await JSZip.loadAsync(file);
      const items = [];
      for (const [relPath, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (/(^|\/)__MACOSX(\/|$)/.test(relPath) || relPath.startsWith('.')) continue;
        items.push({
          name: relPath.split('/').pop(),
          path: relPath,
          size: entry._data ? entry._data.uncompressedSize : 0,
          lastModified: entry.date ? entry.date.getTime() : null,
          text: () => entry.async('string'),
        });
      }
      await scanFiles(items, 'zip');
    } catch (e) {
      res.style.display = 'flex';
      res.innerHTML = `<div class="scan-badge err">✗ Erreur ZIP</div><p style="margin:8px 0 0;color:#fda4af;font-size:13px;">${escapeXml(e.message)}</p>`;
      showToast('Erreur lors de la lecture du ZIP.', 'error');
    }
  }

  // ---------- Crawler ----------
  async function crawl(startUrl) {
    const base = $('#baseUrl').value.trim() || startUrl;
    const baseHost = new URL(base).host;
    const max = parseInt($('#crawlMax').value, 10) || 500;
    const delay = parseInt($('#crawlDelay').value, 10) || 0;

    const queue = [startUrl];
    const visited = new Set();
    let found = 0, errs = 0;
    const log = $('#crawlLog');
    log.innerHTML = '';
    const addLog = (msg, cls = '') => {
      const li = document.createElement('div');
      if (cls) li.className = cls;
      li.textContent = msg;
      log.insertBefore(li, log.firstChild);
      while (log.children.length > 80) log.removeChild(log.lastChild);
    };
    $('#crawlProgress').style.display = 'block';
    addLog(`> Démarrage depuis ${startUrl} (max ${max})`, 'info');
    crawlAbort = { stopped: false };
    const tick = () => {
      $('#crawlFound').textContent = found;
      $('#crawlQueue').textContent = queue.length;
      $('#crawlErrors').textContent = errs;
      $('#crawlFill').style.width = Math.min(100, (found / max) * 100) + '%';
    };
    const fetchWithProxy = async (url) => {
      for (const p of CORS_PROXIES) {
        try { const r = await fetch(p(url), { redirect: 'follow' }); if (r.ok) return await r.text(); } catch {}
      }
      try { const r = await fetch(url); if (r.ok) return await r.text(); } catch {}
      throw new Error('Tous les proxys ont échoué');
    };
    while (queue.length > 0 && found < max && !crawlAbort.stopped) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      tick();
      try {
        const html = await fetchWithProxy(url);
        const links = extractLinks(html, url);
        const r = addUrl(url, { source: 'crawl', fromCrawl: true });
        if (r.ok) found++;
        for (const h of links) {
          const n = normalizeUrl(h, url);
          if (!n) continue;
          try { if (new URL(n).host !== baseHost) continue; } catch { continue; }
          if (isExcluded(n, { crawl: true })) continue;
          if (!visited.has(n) && !queue.includes(n) && queue.length < max * 2) queue.push(n);
        }
        addLog(`✓ ${url}`, 'ok');
        if (delay) await new Promise((r) => setTimeout(r, delay));
        render();
      } catch (e) {
        errs++; addLog(`✗ ${url} — ${e.message}`, 'err');
      }
    }
    if (crawlAbort.stopped) addLog('> Arrêté par l\'utilisateur.', 'warn');
    else addLog(`> Terminé : ${found} pages trouvées.`, 'ok');
    crawlAbort = null;
    render(); saveState(); updateStepper();
  }

  // ---------- Sitemap import ----------
  async function importSitemapFromUrl(url) {
    try {
      let text = null;
      for (const p of CORS_PROXIES) {
        try { const r = await fetch(p(url)); if (r.ok) { text = await r.text(); break; } } catch {}
      }
      if (!text) { const r = await fetch(url); text = await r.text(); }
      parseAndImportSitemap(text);
    } catch (e) { showToast('Erreur: ' + e.message, 'error'); }
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
    el.addEventListener('drop', (e) => { if (e.dataTransfer) onFiles(e.dataTransfer.files); });
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
    wireDropzone($('#projectDropzone'), (files) => {
      if (!files.length) return;
      if (!$('#baseUrl').value.trim()) { showToast('Veuillez d\'abord saisir l\'URL de base.', 'error'); return; }
      handleProjectFiles(files);
    }, [$('#pickZip'), $('#pickFolder')]);
    $('#pickZip').addEventListener('click', (e) => { e.stopPropagation(); $('#zipInput').click(); });
    $('#pickFolder').addEventListener('click', (e) => { e.stopPropagation(); $('#folderInput').click(); });
    $('#zipInput').addEventListener('change', (e) => {
      if (e.target.files[0]) handleZip(e.target.files[0]);
      e.target.value = '';
    });
    $('#folderInput').addEventListener('change', (e) => {
      if (e.target.files.length) {
        if (!$('#baseUrl').value.trim()) { showToast('Veuillez d\'abord saisir l\'URL de base.', 'error'); return; }
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
      const u = $('#crawlStart').value.trim() || $('#baseUrl').value.trim();
      if (!u) { showToast('URL de départ requise.', 'error'); return; }
      const start = normalizeUrl(u, u);
      if (!start) { showToast('URL invalide.', 'error'); return; }
      if (!$('#baseUrl').value.trim()) $('#baseUrl').value = start;
      $('#crawlProgress').style.display = 'none';
      setTimeout(() => crawl(start), 80);
    });
    $('#stopCrawl').addEventListener('click', () => { if (crawlAbort) crawlAbort.stopped = true; });
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

    // Also prevent drop of files outside dropzones from opening the browser
    ['dragover','drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showToast('Copié.', 'success'); }
    catch { showToast('Copie impossible.', 'error'); }
    document.body.removeChild(ta);
  }

  // ---------- Multi-source handler for drag-drop ----------
  async function handleProjectFiles(fileList) {
    const files = Array.from(fileList);
    // Detect if it's a single zip
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.zip')) {
      handleZip(files[0]);
      return;
    }
    // Multiple files or a folder — check if any is a zip
    const zips = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
    if (zips.length && files.length === zips.length) {
      // If multiple zips, only handle first for now
      handleZip(zips[0]);
      return;
    }
    // Otherwise treat as folder / files
    scanFiles(normalizeFileList(files), 'folder');
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
