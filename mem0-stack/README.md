# mem0-stack

La voie MANUELLE du service mémoire : un seul conteneur, `mem0-rs` (le binaire
Rust de `mem0-rs/`, image multi-étapes), publié sur `127.0.0.1:8321`, avec le
contrat HTTP des 9 routes et l'en-tête `X-Mem0-Token`. Sa base SQLite
`mem0-rs.db` vit dans un dossier de l'hôte, `MEM0_RS_DATA_DIR` (`./mem0-rs-data`
par défaut, relatif à ce dossier). oMLX tourne en natif sur le Mac, hors
conteneur.

Toutes les commandes se lancent depuis `mem0-stack/`. Remplace `podman` par
`docker` si c'est ton moteur.

## Démarrer

```bash
cp .env.example .env
mkdir -p mem0-rs-data
podman compose up -d --build        # ou docker compose up -d --build
./doctor.sh
```

Le dossier de données se crée AVANT `up` : tous les moteurs ne créent pas la
source manquante d'un bind-mount. Si tu changes `MEM0_RS_DATA_DIR` dans `.env`,
crée ce dossier-là.

## Instantanés de la base

mem0-rs prend lui-même des instantanés de sa base (`VACUUM INTO`) dans
`backups/`, à l'intérieur du dossier de données : `mem0-rs-data/backups/` par
défaut. Par défaut, un instantané par 24 h et les 7 plus récents gardés ; le
compose transmet les deux réglages depuis `.env` :

| Variable | Défaut | Effet |
|---|---|---|
| `MEM0_BACKUP_INTERVAL_HOURS` | `24` | écart entre deux instantanés, en heures ; `0` les coupe |
| `MEM0_BACKUP_KEEP` | `7` | nombre d'instantanés gardés |

Le premier instantané d'une pile neuve arrive une heure après le démarrage.
Restaurer : `podman compose stop mem0-rs`, copier l'instantané voulu sur
`mem0-rs-data/mem0-rs.db` (en supprimant `mem0-rs.db-wal` et `mem0-rs.db-shm`),
puis `podman compose start mem0-rs`. Le détail est dans
[mem0-rs/README.md § Instantanés](mem0-rs/README.md#instantanés).

## Migrer une pile mem0-http existante

À suivre AVANT de démarrer la nouvelle pile, l'ancienne (`mem0-qdrant` et
`mem0-http`) encore debout, après avoir récupéré la nouvelle version du dépôt.
Ne lance pas `up` avant la fin du guide : l'import écrit dans le dossier de
données de la future pile, et une base servie par un mem0-rs en marche est
refusée. Remplace `podman` par `docker` si besoin.

1. Préparer le dossier de données et le dossier de travail de la migration :

```bash
mkdir -p mem0-rs-data migration
```

2. Copier `history.db` hors du conteneur `mem0-http` (la copie lit le conteneur,
   arrêté ou non, sans le modifier) :

```bash
podman cp mem0-http:/home/mem0/.mem0/history.db migration/history.db
```

   Si la copie échoue (image construite avant le passage en non-root), le fichier
   est sous `/root` :

```bash
podman cp mem0-http:/root/.mem0/history.db migration/history.db
```

3. Construire l'image `mem0-rs:local` :

```bash
podman compose build mem0-rs
```

4. Simuler l'import : il partage le réseau du conteneur `mem0-qdrant` (donc
   `127.0.0.1:6333` y joint l'ancienne Qdrant), lit `history.db` en lecture seule
   et n'écrit rien :

```bash
podman run --rm --network container:mem0-qdrant -e QDRANT_API_KEY="$(podman exec mem0-qdrant printenv QDRANT__SERVICE__API_KEY)" -v "$PWD/migration:/migration:ro" -v "$PWD/mem0-rs-data:/data" mem0-rs:local import --history-db /migration/history.db --dry-run
```

5. Importer pour de bon, avec la même commande sans `--dry-run` :

```bash
podman run --rm --network container:mem0-qdrant -e QDRANT_API_KEY="$(podman exec mem0-qdrant printenv QDRANT__SERVICE__API_KEY)" -v "$PWD/migration:/migration:ro" -v "$PWD/mem0-rs-data:/data" mem0-rs:local import --history-db /migration/history.db
```

   Codes de sortie : 0, import fait ; 3, import mené à terme avec des rejets
   listés dans le rapport ; 1, rien n'a été écrit (le message dit pourquoi).
   Le rapport, les rejets et la reprise sont décrits dans
   [mem0-rs/README.md § Import](mem0-rs/README.md#import-depuis-mem0-http).
   Relancer l'import n'ajoute que ce qui manque.

6. Arrêter l'ancienne pile :

```bash
podman stop mem0-http mem0-qdrant
```

7. Démarrer la nouvelle :

```bash
podman compose up -d
```

8. Vérifier :

```bash
./doctor.sh
```

L'ancien `./qdrant_storage` et le conteneur `mem0-http`, qui porte `history.db`,
sont conservés tels quels : aucune commande de ce guide ne les supprime ni ne les
modifie. Leur suppression éventuelle sort de ce guide.

## Retour arrière

Pour revenir à l'ancienne pile, arrête mem0-rs puis redémarre les deux anciens
conteneurs :

```bash
podman stop mem0-rs
podman start mem0-qdrant mem0-http
```

Aucune donnée n'est copiée en retour : les souvenirs écrits dans mem0-rs depuis la
bascule ne sont pas dans l'ancienne pile.

## Diagnostiquer

`./doctor.sh` suit la chaîne réelle et dit quoi faire à chaque échec ; son code de
sortie est non nul dès qu'une vérification échoue. Ses sections :

- `── Conteneur mem0-rs` : le conteneur existe-t-il (`MEM0_RS_CONTAINER`) ;
- `── Cohérence .env / conteneur` : les valeurs de `.env` sont-elles appliquées
  (sinon `podman compose up -d --force-recreate mem0-rs`) ;
- `── Conteneur` : état, redémarrages, santé ;
- `── Port depuis l'hôte` : `GET /health` sur le port publié ;
- `── oMLX, vu depuis mem0-rs` : oMLX joignable depuis le conteneur, modèles chargés ;
- `── Écriture puis relecture` : un aller-retour dans le scope `_doctor` ;
- `── Ancienne mémoire Python+Qdrant` : si `./qdrant_storage` ou les conteneurs
  `mem0-qdrant` / `mem0-http` sont encore là alors que la base mem0-rs est vide, un
  ✗ « ancienne mémoire Python+Qdrant non migrée » donne les commandes de migration
  à coller. La nouvelle pile continue de servir pendant ce temps ; une base déjà
  peuplée est considérée comme migrée.

doctor.sh ne lance, n'arrête et ne modifie jamais rien.
