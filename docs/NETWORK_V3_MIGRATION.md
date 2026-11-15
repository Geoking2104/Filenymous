# Réseau `filenymous-mainnet-v3` : note de migration

_Novembre 2026_

## Ce qui change
Filenymous passe à un **nouveau réseau P2P** (`filenymous-mainnet-v3`). Cette coupure unique regroupe trois changements :

1. **Correctifs de sécurité dans les règles de validation** (identité et parcels) :
   - seul l'auteur peut modifier ou supprimer ses entrées et ses liens ;
   - personne ne peut plus rattacher sa propre clé de chiffrement à l'identité d'un autre ;
   - personne ne peut révoquer le parcel d'un autre, ni épuiser sa limite de téléchargements ;
   - un enregistrement de téléchargement appartient forcément à celui qui télécharge.
2. **Propriétés du DNA** (`dnas/filenymous/dna.yaml`) : le zome `delivery` les exige à la genesis. Sans elles, le hApp ne s'installait pas (`GenesisFailed "No properties"`).
3. **Seed unique `filenymous-mainnet-v3`** partout. Avant, le DNA disait `v2` et le desktop `v1`.

Les points 1 et 2 modifient le hash du DNA. Le réseau v3 est donc **distinct** des réseaux v1 et v2, et les nœuds des deux côtés ne se voient pas.

## Ce que les utilisateurs doivent faire
- **Republier leur identité (manuel).** Dans l'onglet **Identité**, chaque utilisateur doit revérifier son e-mail ou son téléphone (OTP). Cette étape republie le ContactClaim et la clé X25519. Il peut aussi utiliser « Publier la clé » s'il veut seulement republier la clé. Le keypair local est conservé, et rien n'est republié automatiquement. Tant qu'un contact ne l'a pas fait, il est introuvable par son e-mail ou son téléphone.
- **Renvoyer les fichiers en cours.** Les parcels, liens de téléchargement et révocations publiés sur l'ancien réseau ne sont pas visibles depuis v3, et aucun outil de migration n'existe.
- **Coffre-fort (Safe) et wallet** : rien à faire. Ils sont stockés localement et ne passent pas par ce DNA.
- **Agent vault** (`filenymous-agent-vault`) : c'est un hApp séparé avec son propre DNA, il n'est pas concerné par cette coupure.

## Desktop (à savoir)
`src-tauri` installe l'app `filenymous` seulement si elle est absente (`install_app_if_necessary`). Une installation desktop qui aurait déjà l'ancienne app **resterait sur l'ancien DNA**. Il faut soit réinstaller ou réinitialiser le profil, soit ajouter une logique de remplacement (désactivation de l'ancienne app, puis installation de v3). Cette logique n'est pas encore implémentée, et `src-tauri` ne compile de toute façon pas encore avec Holochain 0.6.1.
Un profil peut forcer une autre seed via `network-seed.txt`. Il faut l'effacer ou le mettre à jour.

## Pour les développeurs
- `network_seed` dans `dnas/filenymous/dna.yaml` et `DEFAULT_NETWORK_SEED` dans `src-tauri/src/config.rs` doivent rester identiques. La CI le vérifie.
- `make test-validation` : tests de validation sur un conductor 0.6.1.
