# 🗺️ SitePlan — Générateur pro de sitemap.xml

Générateur de `sitemap.xml` / `sitemap-index.xml` / `robots.txt` **100% côté client** — aucun back-end, aucune donnée stockée. Un petit serveur local optionnel (`node server.js`) peut être lancé pour un crawl fiable et authentifié.

Conçu pour les **projets complexes** (Next.js, Astro, Nuxt, SvelteKit, Remix, VitePress, PHP, HTML statique) : il scanne automatiquement vos routes, détecte les segments dynamiques `[slug]`, et peut aussi générer du code `app/sitemap.ts` pour Next.js.

## ✨ Fonctionnalités

- **📂 Scan automatique du projet** : déposez votre dossier, SitePlan détecte le framework et extrait toutes les pages (y compris App Router Next.js, route groups `(auth)`, segments dynamiques `[slug]`, etc.).
- **🕷️ Crawler intégré** : partez d'une URL, le crawler découvre les liens internes. Il lit aussi `robots.txt` + `sitemap.xml` pour amorcer la découverte (utile pour les sites rendus en JavaScript).
- **🔐 Crawl de sites protégés** : avec le proxy local (`node server.js`), envoyez un `Cookie` ou un `Authorization: Bearer …` pour crawler un site derrière une connexion / un staging.
- **⏹ Arrêt instantané** du crawl (abandon de la requête en cours, pas d'attente de timeout).
- **📥 Import d'un sitemap existant** (URL ou fichier XML).
- **🧩 Extraction depuis HTML** collé ou **📄 upload de fichiers HTML/PHP**.
- **📋 Ajout manuel** (unique ou en lot).
- **🌍 Support multilingue** (balises `<xhtml:link rel="alternate" hreflang="…">`).
- **🚫 Patterns d'exclusion** (glob : `*`, `**`, `?`).
- **🔄 Déduplication**, filtre, actions en masse (fréquence/priorité/suppression).
- **🔧 Normalisation** : slashs finaux, index.html, ancres, query strings.

### Exports
- `sitemap.xml` (format standard, max 50 000 URLs / 50 Mo)
- `sitemap-index.xml` (fractionnement automatique pour les gros sites)
- `robots.txt` (règles par défaut + lien vers le sitemap)
- `app/sitemap.ts` (Next.js App Router)
- `app/robots.ts` (Next.js App Router)

## 🚀 Utilisation

### Option A — avec le proxy local (recommandé)

```bash
node server.js          # http://localhost:8080
```

Aucune dépendance à installer (Node ≥ 18). Le serveur sert l'interface **et** expose un proxy de crawl :

| Endpoint | Rôle |
| --- | --- |
| `GET /api/health` | détection automatique du proxy par l'interface |
| `POST /api/fetch` | `{ url, headers }` → `{ status, finalUrl, contentType, body }` |

Ce proxy supprime les limites CORS, ajoute un timeout, suit les redirections et permet
d'envoyer des en-têtes d'authentification (`Cookie`, `Authorization`, `User-Agent`).

```bash
PORT=3000 node server.js                     # autre port
SITEPLAN_ALLOW_PRIVATE=1 node server.js      # autoriser le crawl de localhost / IP privées (site en dev)
```

> `SITEPLAN_ALLOW_PRIVATE=1` est nécessaire pour crawler votre serveur de développement
> (`http://localhost:3000`). Par défaut les réseaux privés sont bloqués (protection SSRF).

### Option B — sans serveur (site statique)

```bash
python3 -m http.server 8080
# ou
npx serve .
```

Puis ouvrez http://localhost:8080. Le crawler fonctionne alors via des **proxys CORS publics** :
certains sites les bloquent (Cloudflare, gros sites, sites derrière une connexion), et
l'authentification n'est pas possible. Dans ce cas, utilisez l'option A.

Ou ouvrez `index.html` directement dans votre navigateur (double-clic) : tout fonctionne
sauf le crawler (pas de réseau autorisé en `file://`), à utiliser via les imports ZIP / sitemap / HTML.

### 🕷️ Crawler un site protégé (connexion / staging)

1. `node server.js`
2. Ouvrez http://localhost:8080 → onglet **Crawler**.
3. Ouvrez le bloc **🔐 Site protégé**, collez l'en-tête `Cookie` (ou un token `Bearer`) récupéré
   dans les DevTools de votre navigateur, sur une page déjà connectée.
4. Démarrez le crawl : les en-têtes sont envoyés à chaque requête.

Les valeurs restent en mémoire de l'onglet (jamais écrites dans le `localStorage`).

## ☁️ Déploiement : Netlify ou Render ?

L'interface est **un site statique** (aucun build, aucune dépendance). Le seul besoin
d'un serveur concerne le **crawler** : sans lui, il passe par des proxys CORS publics
(lents, bloqués par certains sites, et **impossible d'envoyer un cookie**).

| Cible | Type | Crawl fiable | Sites protégés (cookie) | Effort |
| --- | --- | --- | --- | --- |
| **Netlify** (recommandé) | statique + 2 fonctions serverless | ✅ | ✅ | 0 config (fichiers fournis) |
| **Render** | Web Service Node | ✅ | ✅ | start `node server.js` |
| GitHub Pages / S3 / statique pur | statique seul | ⚠️ proxys publics | ❌ | 0 |

Les deux premières options utilisent **le même code** (`lib/proxy.js`) et exposent le
même contrat `/api/health` + `/api/fetch` : l'interface le détecte automatiquement
(badge vert « Proxy local actif »).

### Netlify — site statique + fonctions (recommandé)

`netlify.toml` est déjà prêt : publication à la racine, fonctions dans `netlify/functions`,
redirections `/api/health` et `/api/fetch` vers les fonctions.

```bash
# 1. pousser le dépôt sur GitHub, puis « Add new site → Import an existing project »
# 2. Build command  : (vide)
# 3. Publish dir    : .
# 4. Deploy
```

Aucune variable d'environnement n'est nécessaire. En option :

- `SITEPLAN_TIMEOUT_MS` — délai réseau des fonctions (défaut `8000`).
  ⚠️ Netlify coupe les fonctions synchrones à **10 s** : n'augmentez pas au-delà de ~9000.
- `SITEPLAN_ALLOW_PRIVATE=1` — inutile en production (bloqué par la plateforme), utile seulement en local.

> Un site lent dont le serveur met > 8 s à répondre produira une erreur de crawl sur Netlify.
> Dans ce cas, réduisez le nombre d'URLs ou passez sur Render.

### Render — Web Service

```
Environment     : Node
Build Command   : npm install        # aucune dépendance, quasi instantané
Start Command   : node server.js     # ou: npm start
Health Check    : /api/health
```

Render fournit `PORT`, le serveur l'utilise automatiquement. Le proxy n'a pas de limite
de 10 s (`SITEPLAN_TIMEOUT_MS=25000` par défaut), ce qui est plus confortable pour de
gros sites.

### Hébergeur statique pur (GitHub Pages, S3…)

Ça fonctionne pour tout **sauf le crawl authentifié** : le crawler utilisera les proxys
CORS publics. Si vous voulez garder un hébergement statique mais un crawl fiable, copiez
`lib/proxy.js` + `netlify/functions/fetch.js` vers un Cloudflare Worker ou une fonction
Vercel (`/api/health` + `/api/fetch`) : le contrat est identique.

## 🧠 Exemple avec un projet Next.js (comme 4ur)

1. Saisissez `https://4ur.fr` dans "URL de base".
2. Onglet 📂 **Dossier projet** → déposez le dossier racine de votre projet Next.js.
3. SitePlan détecte le framework et ajoute toutes les routes trouvées dans `src/app/**/page.tsx`.
4. (Optionnel) Activez les options avancées pour ajouter des règles d'exclusion.
5. Dans l'export, choisissez **Next.js sitemap.ts** et téléchargez `sitemap.ts` dans votre dossier `app/`.

## 📁 Structure

```
siteplan/
├── index.html              # Interface (statique)
├── styles.css              # Design
├── app.js                  # Logique (scan, crawl, exports)
├── jszip.min.js            # Lecture des archives ZIP
├── server.js               # Serveur statique + proxy de crawl (local / Render)
├── lib/proxy.js            # Cœur du proxy, partagé serveur + serverless
├── netlify/functions/      # /api/health + /api/fetch pour un déploiement Netlify
├── netlify.toml            # Config Netlify (publish + redirects + fonctions)
├── package.json            # `npm start` pour Render (aucune dépendance)
└── README.md
```

Aucune dépendance npm, aucun build requis. `server.js` utilise uniquement les modules
natifs de Node (≥ 18, pour `fetch`).

## 🧪 Dépannage

| Symptôme | Cause | Solution |
| --- | --- | --- |
| Le crawl ne trouve que la page d'accueil | proxys publics bloqués / site rendu en JS / accès protégé | lancez `node server.js` et crawlez depuis `http://localhost:8080` |
| « HTTP 401 / 403 » dans les logs | site derrière une connexion | renseignez `Cookie` / `Authorization` (proxy local requis) |
| `node server.js` → « adresse privée bloquée » | crawl de `localhost` / IP privée | `SITEPLAN_ALLOW_PRIVATE=1 node server.js` |
| Le ZIP analyse 0 route | ZIP d'un build minifié, ou URL de base vide | déposez les **sources** (ou `dist/` avec les `.html`) et renseignez l'URL de base |
| Badge orange « Proxys publics » après déploiement | fonctions absentes ou non routées | vérifiez `netlify.toml` (redirects `/api/*`) ou que Render tourne bien `node server.js` |
| Crawl en erreur au-delà de ~8 s sur Netlify | limite de 10 s des fonctions synchrones | augmentez `SITEPLAN_TIMEOUT_MS` (max 9000) ou passez sur Render |
