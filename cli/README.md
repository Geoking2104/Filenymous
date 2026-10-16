# filenymous — CLI

Partage de fichiers chiffré de bout en bout, **100 % pair-à-pair**, depuis le terminal ou la CI.
End-to-end encrypted, **100 % peer-to-peer** file sharing from your terminal or CI.

```bash
npx filenymous upload app.zip --ttl 1h
# → https://filenymous.eu/app/#p2p:123-456-ABC/xxxxxxxxxxxxxxxxxxxxxx
```

[![npm](https://img.shields.io/npm/v/filenymous)](https://www.npmjs.com/package/filenymous)

**Installation** : `npx filenymous …` (sans installation) ou `npm i -g filenymous` — Node ≥ 18.17.

[Français](#français) · [English](#english) · [GitHub Actions](#github-actions)

---

## Français

### Principe
- La CLI est un **pair émetteur** : elle utilise exactement le protocole du transfert direct de l'application web (lien `#p2p:CODE/SECRET`, AES-256-GCM par bloc de 64 Kio, mot de passe optionnel).
- Le lien s'ouvre dans n'importe quel navigateur sur https://filenymous.eu/app/, ou avec `filenymous receive`.
- **Rien n'est stocké sur un serveur.** Le relais de signalisation (`wss://www.opendpe.net/filenymous-signal/`) ne fait que mettre les deux pairs en relation. Le fichier passe en WebRTC, directement ou via TURN, et toujours chiffré.
- Conséquence : **le processus doit rester actif** jusqu'à la fin des téléchargements. Il s'arrête de lui-même après `--max-downloads` téléchargements ou à l'expiration du `--ttl`.

### Envoyer
```bash
filenymous upload <fichier...> [--ttl 1h] [--max-downloads 1] [--password X] \
  [--webhook URL] [--webhook-no-link] [--allow-empty] [--json] [-q]
```
- Le lien est écrit sur la **sortie standard**, la progression sur stderr. Avec `--json`, la sortie standard reçoit un événement JSON par ligne.
- `--password` : un mot de passe est demandé au destinataire. Il n'est jamais envoyé : c'est une preuve HMAC, et une dérivation PBKDF2 est mêlée à la clé AES. Préférez la variable d'environnement `FILENYMOUS_PASSWORD`, qui n'apparaît pas dans l'historique du shell ni dans les logs de CI.
- Codes de sortie :
  - `0` : au moins un téléchargement terminé (ou `--allow-empty`)
  - `2` : TTL expiré sans aucun téléchargement
  - `1` : erreur, par exemple 5 mauvais mots de passe
  - `130` : Ctrl-C

### Recevoir
```bash
filenymous receive "<lien ou code>" [-o dossier] [--password X] [--timeout 30m] [--json]
```
- Les fichiers sont écrits en flux dans le dossier, sans jamais écraser un fichier existant (`nom (1).ext`).
- Les chemins reçus sont affichés sur la sortie standard.

### Webhook
Pour chaque événement, la CLI envoie en `POST` (JSON) :
```json
{ "event": "share.created | download.completed | share.expired | share.failed",
  "link": "https://filenymous.eu/app/#p2p:123-456-ABC/…", "code": "123-456-ABC",
  "file": "app.zip", "size": 1234, "expiresAt": "2026-10-16T15:00:00.000Z",
  "downloads": 1, "maxDownloads": 1, "protected": false }
```
> ⚠️ **Le lien contient le secret** (après `#`) : quiconque lit le webhook peut télécharger le fichier tant que la CLI tourne. Le **code seul suffit aussi**, car le secret lui est rattaché. Utilisez `--webhook-no-link` pour retirer `link` et `code` du webhook, ou protégez le partage par `--password`.

### Options communes
- `--signal <url>` : relais de signalisation (`FILENYMOUS_SIGNAL_URL`).
- `--app-url <url>` : base des liens (`FILENYMOUS_APP_URL`).

---

## English

### How it works
- The CLI is a **sender peer**: it speaks the web app's direct-transfer protocol unchanged (`#p2p:CODE/SECRET` links, AES-256-GCM per 64 KiB chunk, optional password gate).
- Links open in any browser at https://filenymous.eu/app/, or with `filenymous receive`.
- **Nothing is stored server-side.** The signaling relay only introduces the peers; the data flows over WebRTC (direct or TURN-relayed), always encrypted.
- So **the process must stay alive** until downloads are done. It exits by itself after `--max-downloads` or when `--ttl` expires.

### Send
```bash
filenymous upload <file...> [--ttl 1h] [--max-downloads 1] [--password X] \
  [--webhook URL] [--webhook-no-link] [--allow-empty] [--json] [-q]
```
- The link goes to **stdout** and progress to stderr. With `--json`, stdout carries JSON lines events.
- Prefer `FILENYMOUS_PASSWORD` over `--password`, so the password stays out of shell history and CI logs.
- Exit codes:
  - `0`: at least one completed download (or `--allow-empty`)
  - `2`: TTL expired with no download
  - `1`: error, e.g. 5 wrong passwords
  - `130`: interrupted

### Receive
```bash
filenymous receive "<link or code>" [-o dir] [--password X] [--timeout 30m] [--json]
```

### Webhook
The JSON payload is the same as above, POSTed for `share.created`, `download.completed`, `share.expired` and `share.failed`.
> ⚠️ **The link carries the decryption secret** in its `#fragment`, and **the code alone is enough** too. Anyone who can read your webhook payloads can download the file while the CLI runs. Use `--webhook-no-link` (drops `link` and `code`) or `--password`.

---

## GitHub Actions

```yaml
- name: Share the build for 1 hour (1 download)
  env:
    FILENYMOUS_PASSWORD: ${{ secrets.SHARE_PASSWORD }}   # optional
  run: |
    npx --yes filenymous upload dist/app.zip --ttl 1h --max-downloads 1 \
      --webhook "${{ secrets.SLACK_WEBHOOK_PROXY }}" --webhook-no-link --json > share.jsonl &
    sleep 5 && head -1 share.jsonl | jq -r .code   # announce the code, not the link, in public logs
    wait   # the job stays alive until the download completes or the TTL expires
```
> The runner has to stay up while the recipient downloads (P2P). GitHub-hosted runners reach peers through the relay's TURN servers when a direct path isn't possible.

---

## Technique / Tech notes
- WebRTC: [`node-datachannel`](https://github.com/murat-dogan/node-datachannel) (libdatachannel, prebuilt binaries, ~1 MB), WebSocket: `ws`. No other runtime dependency.
- The protocol code is **the web app's own** `ui/src/p2p` (session, protocol, signal), bundled as-is with esbuild, so CLI and browser can't drift apart. Cross-compat is covered by Playwright (CLI → browser, browser → CLI) and a CLI ⇄ CLI loopback test.
- Node ≥ 18.17.

## Développement
```bash
cd cli && npm ci
npm run build        # dist/filenymous.js (single file)
npm test             # unit + CLI⇄CLI loopback against a local relay
cd ../ui && npx playwright test e2e/cli-interop.spec.ts   # CLI ⇄ web app
```
