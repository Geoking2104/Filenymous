# Nœuds gardiens (Steward Nodes) — persistance & disponibilité

> Objectif (cahier des charges SwissTransfer) : un fichier envoyé reste
> téléchargeable **même si l'émetteur est hors ligne**, pendant toute la durée
> de validité demandée (1–30 jours), puis les données expirent et peuvent être
> nettoyées.
>
> Statut : **conception + procédure d'exploitation**. L'implémentation du
> service gardien automatisé (phase 2/3 ci-dessous) reste à faire — voir la
> feuille de route en fin de document.

---

## 1. Pourquoi un nœud gardien ?

Dans Filenymous, le flux DHT fonctionne ainsi :

| Donnée | Zome | Entrée |
|---|---|---|
| Métadonnées du transfert | `parcel` | `ParcelManifest` (nom, taille, expiration, quota, clé chiffrée) |
| Chunks chiffrés | `file_storage` | `FileMetadata` + `FileChunk` (AES-256-GCM, ~256 Kio/chunk) |
| Traces de téléchargement | `parcel` | `DownloadRecord` |

Sur une DHT Holochain, une entrée publiée est répliquée auprès des validateurs
proches de son hash (et non sur « tout le réseau »). Si tous les nœuds qui
détiennent un chunk s'éteignent, le chunk devient indisponible — c'est le même
problème que SwissTransfer résout avec ses serveurs de stockage, mais sans
serveur central.

Un **nœud gardien** est un conducteur Holochain headless, toujours en ligne,
qui conserve (épingle) les entrées `ParcelManifest` / `FileChunk`/`FileMetadata`
jusqu'à leur expiration.

---

## 2. Ce que fait un nœud gardien Filenymous

1. Rejoint le réseau public (`network_seed: "filenymous-mainnet-v2"`) via le
   bootstrap/signal décrit dans [`network/README.md`](../network/README.md).
2. Reste connecté en permanence (VPS) → il valide et **stocke durablement**
   les ops qu'il reçoit par gossip (métadonnées + chunks).
3. Épingle activement les entrées des parcels actifs : appels périodiques
   `must_get_entry()` sur les EntryHashes connus, ce qui les marque comme
   « à conserver » et les récupère si nécessaire.
4. À l'expiration (`expiry_us` dépassé), cesse de les épingler. Le nettoyage
   local des données expirées est une opération d'exploitation (phase 3).

> Remarque importante : depuis Holochain 0.5+, le conducteur ne fait pas de
> « garbage collection » automatique des entrées applicatives. Un conducteur
> qui reste en ligne **conserve** ce qu'il a validé. C'est précisément ce
> comportement qui garantit la disponibilité ; la contrepartie est un besoin
> de disque qui croît avec le trafic (voir §5).

---

## 3. Mise en place (phase 1 — manuelle, vérifiable)

### 3.1 Prérequis serveur

- VPS Ubuntu 22.04+ (le même que `bootstrap.filenymous.eu` convient, ou un
  second VPS pour l'isolation).
- Binaires Holochain (mêmes versions que le projet : voir `rust-toolchain.toml`
  et `flake.nix` ; le hApp est compilé avec `make build-happ`).
- Le fichier `workdir/filenymous.happ` (ou une release récente).

### 3.2 Config conducteur (exemple)

```yaml
# conductor-config.steward.yaml — nœud gardien Filenymous
environment_path: /opt/filenymous/steward/data
keystore:
  type: lair_server
  connection_url: "unix:///opt/filenymous/steward/ks.socket"

admin_interfaces:
  - driver:
      type: websocket
      port: 4444

network:
  bootstrap_service: "https://bootstrap.filenymous.eu"
  signal_url: "wss://bootstrap.filenymous.eu"
  transport_pool:
    - type: webrtc
      signal_url: "wss://bootstrap.filenymous.eu"
      ice_servers_override:
        - urls:
            - "stun:stun.l.google.com:19302"

app_interfaces: []   # aucun accès UI public nécessaire
```

### 3.3 Démarrage & installation du hApp

```bash
# keystore (la clé du gardien)
lair-keystore --lair-root /opt/filenymous/steward/ks serve \
  --piped > /opt/filenymous/steward/ks.pipe &

# conducteur
holochain -c conductor-config.steward.yaml

# installation du hApp (admin API)
hc sandbox call install-app workdir/filenymous.happ   # ou hc app install selon version
```

Le nœud est ensuite un pair permanent du réseau : il reçoit les nouvelles
données par gossip et les conserve.

---

## 4. Épinglage actif (phase 2 — planifié)

Pour garantir qu'un parcours de lecture (« must_get ») récupère bien les
chunks même si l'émetteur est hors ligne, le gardien maintient une liste des
parcels actifs et appelle périodiquement :

```
file_storage : get_file(<file_hash>)   → force la récupération des chunks
parcel       : get_parcel(<parcel_eh>) → vérifie l'état (expiration/quota)
```

Deux sources possibles pour alimenter cette liste :

- **Option A — dépôt explicite (recommandé)** : à la création d'un parcel,
  l'expéditeur enregistre aussi une « demande de garde » (`pin_request`) que
  les gardiens écoutent. Nécessite un petit ajout au zome `parcel`
  (fonction `request_pin`) — TODO.
- **Option B — observation réseau** : le gardien échantillonne les ancres de
  contact (`parcels.contact.<hash>`) qu'il connaît déjà et épingles tout ce
  qu'il voit passer. Plus simple, moins exhaustif.

> En attendant, tout conducteur gardien en ligne conserve déjà les données
> qu'il a validées (comportement de base décrit en §2), ce qui couvre le cas
> d'usage principal : la fenêtre où l'émetteur éteint sa machine.

---

## 5. Exploitation

- **Dimensionnement disque** : compter ~1,2 × la taille des fichiers
  hébergés (chunks + overhead DHT + base SQLite). Surveiller
  `/opt/filenymous/steward/data`.
- **Expiration** : les lectures (`get_parcel`) rejettent déjà les parcels
  expirés, et `confirm_download` refuse les téléchargements au-delà de
  l'expiration ou du quota. Côté gardien, l'épinglage s'arrête
  automatiquement à l'expiration.
- **Nettoyage** : l'arrêt de l'épinglage suffit pour les nœuds courts ; pour
  les gardiens long-terme, une purge locale (réinstallation du conducteur ou
  suppression des données expirées) peut être planifiée hors ligne.
- **Supervision** : vérifier périodiquement qu'un parcel témoin est lisible
  via l'API du gardien (`get_parcel`) depuis un client neutre.

---

## 6. Feuille de route

- [x] Conception et procédure manuelle (ce document)
- [ ] Zome : fonction `request_pin` + signaux « parcel à garder » (option A)
- [ ] Service `steward-svc` : boucle d'épinglage + purge sur expiration
- [ ] Déploiement : second conteneur/systemd sur le VPS réseau
- [ ] Test de bout en bout : envoi → émetteur hors ligne → téléchargement OK
      via le gardien → expiration → indisponible

Voir aussi : [`network/README.md`](../network/README.md) (bootstrap + signal),
[`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) (site & app).
