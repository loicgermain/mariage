# Mariage Loïc & Caro — suivi budget & invités

App web (PWA) mono-utilisateur (couple) pour suivre le budget, les revenus/épargne,
l'échéancier de paiements, les invités (foyers) et les tâches d'un mariage.

## Stack

Vanilla JS, zéro build, zéro dépendance npm. Tout tourne directement dans le
navigateur via `<script type="module">`.

- `index.html` — structure HTML + tout le CSS (custom properties, dark mode via
  `prefers-color-scheme`, responsive tablette `@media (min-width: 768px)`).
- `app.js` (~1400 lignes) — toute la logique : rendu, état, actions, export Excel.
  Pas de framework, pas de virtual DOM : re-render en réinjectant du HTML via
  `innerHTML` dans `#content` / `#modal-root`.
- `data.js` — constantes (catégories de dépenses, budgets prévisionnels, groupes
  d'invités, régimes/allergènes) + `DEFAULT_DATA` (structure vide de secours).
- `firebase.js` — couche de persistance. Deux modes :
  - **Firebase configuré** (clé réelle dans `firebaseConfig`) → Firebase Auth
    (email/mdp) + Realtime Database (`ref 'mariage'`), sync temps réel via `onValue`.
  - **Non configuré** (placeholder `VOTRE_...`) → fallback `localStorage`
    (clé `mariage-data`), sync entre onglets via l'event `storage`.
- `manifest.json` + `sw.js` — PWA installable. Service worker en stratégie
  network-first avec `cache: 'reload'` pour les fichiers same-origin (contourne
  le cache HTTP `max-age=600` de GitHub Pages, sinon une nouvelle version peut
  mettre ~10 min à apparaître). Incrémenter `CACHE` (`mariage-vNN`) dans `sw.js`
  à chaque déploiement qui change les assets, pour invalider proprement le cache.

## Déploiement

Statique, servi depuis GitHub Pages sous le chemin `/mariage/` (voir `start_url`
dans `manifest.json` et `ASSETS` dans `sw.js`). Aucun build : push sur la branche
servie = déploiement.

## Modèle de données (Realtime DB / localStorage)

```
{
  depenses: [ { id, categorie, nom, montant, paye, caution, date, notes... } ],
  revenus:  [ { id, source, montant, date, ... } ],
  foyers:   [ { id, nom, groupe, membres: [{ nom, statut(attente/confirme/decline), regime, allergenes }], ... } ],
  taches:   [ { id, texte, fait, ... } ],
  epargne:  { ... solde compte, virement auto mensuel ... }
}
```
Catégories de dépenses et budgets prévisionnels : voir `CATS` / `BUDGETS` dans
`data.js`. Groupes d'invités : `GROUPES`. Régimes/allergènes pour la carte repas :
`REGIMES` / `ALLERGENES`.

## Fonctionnalités (onglets)

- **Dashboard** — métriques clés (budget total, dépensé, restant, épargne),
  prochains paiements, alertes de dépassement.
- **Dépenses** — liste filtrable/triable par catégorie, statut payé/caution.
- **Planning (Échéancier)** — échéancier des paiements + carte de projection de
  trésorerie (courbe canvas maison avec interaction tactile), carte virement
  auto épargne, carte statut du compte épargne (modèle "solde réel").
- **Revenus** — liste des rentrées d'argent (cadeaux, participations...).
- **Invités** — foyers repliables/dépliables, membres avec statut RSVP
  (à confirmer / confirmé / décliné), régime alimentaire et allergènes par membre.
- **Export Excel** — deux boutons distincts : export invités (publipostage) et
  export finances (`toCSV` + `downloadText` dans `app.js`).
- **Mode discret** (`togglePrivacy`) — masque les montants à l'écran.
- **Auth** — écran de login si Firebase configuré ; `body.locked` masque nav et
  actions tant que non connecté.

## Conventions de code

- Tout en français : noms de variables, UI, messages, commentaires, et
  **messages de commit en français** (voir `git log`).
- Pas de build/bundler/linter : éditer directement `app.js` / `index.html`, pas
  de TypeScript, pas de JSX.
- Sections repérées par des commentaires bannière `// ── Titre ──...` dans
  `app.js` — les respecter en ajoutant du code dans la bonne section plutôt que
  d'en créer une nouvelle à la fin du fichier.
- Re-render complet d'un onglet via ses fonctions `render*()` (`renderDashboard`,
  `renderDepenses`, `renderEcheancier`, `renderRevenus`, `renderInvites`, ...)
  plutôt que des mises à jour DOM ciblées.
- Sauvegarde : `scheduleSave()` (debounce) après toute mutation de l'état, qui
  écrit vers Firebase ou localStorage selon `isConfigured`.
