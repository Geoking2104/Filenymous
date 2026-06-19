# Déploiement Filenymous sur Holo Host

## Vue d'ensemble

Le déploiement Holo Host produit un `.webhapp` = hApp compilé + `ui.zip` (filenymous-app.html).
Une fois déployé, les utilisateurs accèdent à Filenymous directement via navigateur, sans aucune installation.

```
filenymous-app.html  ─→  ui.zip  ┐
dnas/ zomes/ (Rust) ─→  .happ   ┼─→  filenymous.webhapp  ─→  Holo Host
```

---

## Étape 1 — Créer un compte Publisher Holo Host

1. Aller sur **https://hbs.holo.host**
2. Cliquer **"Sign Up as Publisher"**
3. Compléter le profil (nom, email, description du hApp)
4. Générer un **Publisher Token** (API key) dans Settings → API Tokens
5. Noter l'email et le token — ils seront utilisés comme secrets GitHub

---

## Étape 2 — Configurer les secrets GitHub

Dans le repo GitHub (`Geoking2104/Filenymous`) :
**Settings → Secrets and variables → Actions → New repository secret**

| Secret                  | Valeur                              |
|-------------------------|-------------------------------------|
| `HOLO_PUBLISHER_EMAIL`  | Email de ton compte hbs.holo.host   |
| `HOLO_PUBLISHER_TOKEN`  | Token API généré à l'étape 1        |
| `CACHIX_AUTH_TOKEN`     | (Optionnel) token Cachix pour cache Nix |

---

## Étape 3 — Pousser les changements sur GitHub

```bash
cd C:\Users\geoff\Documents\Claude\Projects\Filenymous\filenymous

git add filenymous-app.html \
        Makefile \
        web-happ.yaml \
        .github/workflows/build.yml \
        .github/workflows/release.yml \
        .github/workflows/holo-deploy.yml

git commit -m "feat: single-file HTML UI + Holo Web Conductor + holo-deploy workflow"
git push origin main
```

---

## Étape 4 — Déclencher le déploiement Holo Host

### Option A — Déploiement manuel (recommandé pour tester)

1. Aller dans le repo GitHub → **Actions**
2. Cliquer sur **"Deploy to Holo Host"**
3. Cliquer **"Run workflow"**
4. Choisir l'environnement : `production` ou `staging`
5. Attendre ~10 min (compilation WASM + pack + deploy)

### Option B — Déploiement automatique sur tag

```bash
git tag v0.1.0
git push origin v0.1.0
```
→ Déclenche automatiquement `holo-deploy.yml`

---

## Étape 5 — Vérifier le déploiement

Une fois le workflow GitHub Actions terminé (✅) :

- **App web** : https://filenymous.holo.host
- **Web-bridge** : https://filenymous.holo.host/web-bridge
- **Dashboard publisher** : https://hbs.holo.host → ton hApp apparaît avec le statut "Live"

---

## Ce qui se passe côté client

Quand un utilisateur ouvre `filenymous.holo.host` dans son navigateur :

1. `filenymous-app.html` se charge (c'est le `index.html` dans `ui.zip`)
2. `init()` tente de connecter le conductor local (`ws://localhost:8888`) → échec
3. `initHoloWebConductor()` est appelé (`CFG.holoDeployed = true`)
4. `@holo-host/web-client` se connecte au Chaperone (`chaperone.holo.host`)
5. Le Chaperone ouvre une popup de connexion → l'utilisateur crée/récupère son compte Holo
6. `S.mode = 'holo'` → toutes les opérations passent par le HoloPort hébergé
7. L'utilisateur peut envoyer et recevoir des fichiers sans rien installer

---

## Structure des fichiers modifiés

```
filenymous/
├── filenymous-app.html          ← UI standalone (holoDeployed: true)
├── web-happ.yaml                ← bundle manifest (hApp + ui.zip)
├── Makefile                     ← build-ui utilise le HTML single-file
├── workdir/
│   ├── ui.zip                   ← index.html = filenymous-app.html
│   └── filenymous.happ          ← produit par make build-happ (CI)
└── .github/workflows/
    ├── build.yml                ← CI : UI zip = single-file HTML
    ├── release.yml              ← Release : UI zip = single-file HTML
    └── holo-deploy.yml          ← Deploy Holo Host (nouveau)
```

---

## Dépannage

| Problème | Solution |
|----------|----------|
| Workflow échoue sur `nix develop` | Vérifier que le flake.nix est valide, ajouter `CACHIX_AUTH_TOKEN` |
| `holo login` échoue | Vérifier `HOLO_PUBLISHER_EMAIL` et `HOLO_PUBLISHER_TOKEN` dans GitHub Secrets |
| `holo deploy` : hApp ID inconnu | Créer d'abord le hApp dans le dashboard hbs.holo.host, puis relancer |
| Mode `bridge` au lieu de `holo` | Vérifier que le domaine servi est bien `filenymous.holo.host` (Chaperone valide le domaine) |
| Chaperone popup bloquée | Désactiver le bloqueur de popups pour `holo.host` |
