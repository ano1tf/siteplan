# 🗺️ SitePlan — Générateur pro de sitemap.xml

Générateur de `sitemap.xml` / `sitemap-index.xml` / `robots.txt` **100% côté client** — aucune donnée n'est envoyée sur un serveur.

Conçu pour les **projets complexes** (Next.js, Astro, Nuxt, SvelteKit, Remix, VitePress, PHP, HTML statique) : il scanne automatiquement vos routes, détecte les segments dynamiques `[slug]`, et peut aussi générer du code `app/sitemap.ts` pour Next.js.

## ✨ Fonctionnalités

- **📂 Scan automatique du projet** : déposez votre dossier, SitePlan détecte le framework et extrait toutes les pages (y compris App Router Next.js, route groups `(auth)`, segments dynamiques `[slug]`, etc.).
- **🕷️ Crawler intégré** : partez d'une URL, le crawler découvre les liens internes (plusieurs proxys CORS publics de secours).
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

Servez simplement le dossier avec un serveur statique :

```bash
python3 -m http.server 8080
# ou
npx serve .
```

Puis ouvrez http://localhost:8080.

Ou ouvrez `index.html` directement dans votre navigateur (double-clic).

## 🧠 Exemple avec un projet Next.js (comme 4ur)

1. Saisissez `https://4ur.fr` dans "URL de base".
2. Onglet 📂 **Dossier projet** → déposez le dossier racine de votre projet Next.js.
3. SitePlan détecte le framework et ajoute toutes les routes trouvées dans `src/app/**/page.tsx`.
4. (Optionnel) Activez les options avancées pour ajouter des règles d'exclusion.
5. Dans l'export, choisissez **Next.js sitemap.ts** et téléchargez `sitemap.ts` dans votre dossier `app/`.

## 📁 Structure

```
siteplan/
├── index.html   # Interface
├── styles.css   # Design
├── app.js       # Logique (scan, crawl, exports)
└── README.md
```

Aucune dépendance, aucun build requis.
