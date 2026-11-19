# memory-stack

La voie MANUELLE du service mémoire : un seul conteneur, `memory-rs` (le binaire
Rust de `memory-rs/`, image multi-étapes), publié sur `127.0.0.1:8321`, avec le
contrat HTTP des 9 routes (plus les routes du graphe et du rêve, propres à memory-rs)
et l'en-tête `X-Memory-Token`. Sa base SQLite
`memory-rs.db` vit dans un dossier de l'hôte, `MEMORY_RS_DATA_DIR` (`./memory-rs-data`
par défaut, relatif à ce dossier). oMLX tourne en natif sur le Mac, hors
conteneur.

Toutes les commandes se lancent depuis `memory-stack/`. Remplace `podman` par
`docker` si c'est ton moteur.

## Démarrer

```bash
cp .env.example .env
mkdir -p memory-rs-data
podman compose up -d --build        # ou docker compose up -d --build
./doctor.sh
```

Le dossier de données se crée AVANT `up` : tous les moteurs ne créent pas la
source manquante d'un bind-mount. Si tu changes `MEMORY_RS_DATA_DIR` dans `.env`,
crée ce dossier-là.

## Jetons à portées

`MEMORY_HTTP_TOKEN` reste le jeton TOTAL (toutes les portées, toutes les routes).
`MEMORY_HTTP_TOKENS` (`nom:jeton:scope1,scope2;nom2:jeton2:scope3`) ou
`MEMORY_HTTP_TOKENS_FILE` (le même format, une entrée par ligne, `#` pour un
commentaire) déclarent des jetons LIMITÉS à leurs portées (`agent_id`, la scope
d'un projet). Un tel jeton (16 à 512 caractères parmi `A-Z a-z 0-9 . _ ~ + / = -`)
n'ouvre que les requêtes qui nomment une de ses portées ou visent un souvenir de
l'une d'elles ; le reste — autre portée, requête sans `agent_id`, `/memory/graph`,
rêve de toutes les portées, souvenir inconnu — rend 403. Un jeton inconnu reste un
401 ; une déclaration illisible (nom, secret, doublon, portée vide) arrête le
démarrage. Le harness donne à chaque dépôt `memory.tokenEnv` le sien
(omp-harness/README.md § « Projets perso et corpo ») : le runner d'un projet ne lit
plus la mémoire d'un autre.

## Instantanés de la base

memory-rs prend lui-même des instantanés de sa base (`VACUUM INTO`) dans
`backups/`, à l'intérieur du dossier de données : `memory-rs-data/backups/` par
défaut. Par défaut, un instantané par 24 h et les 7 plus récents gardés ; le
compose transmet les deux réglages depuis `.env` :

| Variable | Défaut | Effet |
|---|---|---|
| `MEMORY_BACKUP_INTERVAL_HOURS` | `24` | écart entre deux instantanés, en heures ; `0` les coupe |
| `MEMORY_BACKUP_KEEP` | `7` | nombre d'instantanés gardés |
| `MEMORY_BACKUP_REMOTE_CMD` | vide | copie hors machine de chaque instantané : lancée par `sh -c`, le chemin en `$1` (et `MEMORY_BACKUP_FILE`) ; ex. `restic backup --host memory "$1"` (chiffré, `RESTIC_REPOSITORY` et `RESTIC_PASSWORD_FILE` dans l'environnement) ou `curl -fsS -T "$1" https://webdav.example/memory/` (l'image n'a que `sh` et `curl` : un autre outil se monte) |
| `MEMORY_BACKUP_REMOTE_TIMEOUT_SECONDS` | `600` | délai de la copie distante |
| `MEMORY_LOG_DIR` | `logs/` à côté de la base | journal JSON `memory-AAAA-MM-JJ.jsonl` (`{"ts","level","src":"memory","msg","event"?,"err"?}`), aussi sur stderr |
| `MEMORY_LOG_RETENTION_DAYS` | `14` | jours de journal gardés |

Un échec d'instantané ou de copie distante est journalisé (`event: "backup_failed"`)
et se lit dans `GET /health` (`last_backup_at`, `last_backup_error`, avec `version`,
`uptime_s`, `memories`, `db_bytes`) ; `GET /metrics` (jeton en `X-Memory-Token` ou
`Authorization: Bearer`) l'expose au format Prometheus (`memory_memories`,
`memory_db_bytes`, `memory_backup_last_success_timestamp_seconds`, `memory_backup_failing`,
`memory_backup_failures_total`, `memory_http_requests_total{route,method,status}`,
`memory_http_request_duration_seconds`). Le harness reprend cette santé dans son
`GET /v1/status` (`memory`) et son rapport du matin.

Le premier instantané d'une pile neuve arrive une heure après le démarrage.
Restaurer : `podman compose stop memory-rs`, copier l'instantané voulu sur
`memory-rs-data/memory-rs.db` (en supprimant `memory-rs.db-wal` et `memory-rs.db-shm`),
puis `podman compose start memory-rs`. Le détail est dans
[memory-rs/README.md § Instantanés](memory-rs/README.md#instantanés).

## Fusion de la recherche

Le compose transmet aussi depuis `.env` le classement de `POST /memory/search` :

| Variable | Défaut | Effet |
|---|---|---|
| `MEMORY_SEARCH_FUSION` | `additive` | `additive` (le classement de l'ancien service Python, cf. `THIRD_PARTY_NOTICES.md`), `rrf` (Reciprocal Rank Fusion) ou `graphe` (RRF plus le graphe de liens de la mémoire) |
| `MEMORY_RRF_K` | `60` | constante `k` de la RRF |

Le choix, ses raisons et le banc de mesure qui les compare (`memory-rs banc`) sont
dans [memory-rs/README.md § Recherche hybride](memory-rs/README.md#recherche-hybride).

## Rêve de la mémoire

Quand un projet est calme, memory-rs entretient sa mémoire : il réindexe, fait juger
par le LLM (`OMLX_LLM_MODEL`) les souvenirs très proches et en tire des liens et des
**propositions** (doublon, remplacement, contradiction, oubli) — jamais des
suppressions : on les accepte ou refuse avec `/memory-dream` dans omp. La consolidation
en observations et en mental models est menée par le harness, sur une session omp.
Le compose transmet les réglages depuis `.env` :

| Variable | Défaut | Effet |
|---|---|---|
| `MEMORY_DREAM_INTERVAL_MINUTES` | `60` | période du rêve de fond, en minutes ; `0` le coupe |
| `MEMORY_DREAM_QUIET_MINUTES` | `10` | un projet ne rêve qu'après ce délai sans écriture |
| `MEMORY_DREAM_PAIRS` | `20` | paires jugées par le LLM au plus par rêve ; `0` : aucun appel au LLM |
| `MEMORY_DREAM_FORGET_DAYS` | `180` | jours sans rappel ni lien avant une proposition d'oubli ; `0` : jamais |

Le détail est dans [memory-rs/README.md § Rêve](memory-rs/README.md#rêve).

## Migrer une pile mem0-http existante

À suivre AVANT de démarrer la nouvelle pile, l'ancienne (`mem0-qdrant` et
`mem0-http`) encore debout, après avoir récupéré la nouvelle version du dépôt.
Ne lance pas `up` avant la fin du guide : l'import écrit dans le dossier de
données de la future pile, et une base servie par un memory-rs en marche est
refusée. Remplace `podman` par `docker` si besoin.

1. Préparer le dossier de données et le dossier de travail de la migration :

```bash
mkdir -p memory-rs-data migration
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

3. Construire l'image `memory-rs:local` :

```bash
podman compose build memory-rs
```

4. Simuler l'import : il partage le réseau du conteneur `mem0-qdrant` (donc
   `127.0.0.1:6333` y joint l'ancienne Qdrant), lit `history.db` en lecture seule
   et n'écrit rien :

```bash
podman run --rm --network container:mem0-qdrant -e QDRANT_API_KEY="$(podman exec mem0-qdrant printenv QDRANT__SERVICE__API_KEY)" -v "$PWD/migration:/migration:ro" -v "$PWD/memory-rs-data:/data" memory-rs:local import --history-db /migration/history.db --dry-run
```

5. Importer pour de bon, avec la même commande sans `--dry-run` :

```bash
podman run --rm --network container:mem0-qdrant -e QDRANT_API_KEY="$(podman exec mem0-qdrant printenv QDRANT__SERVICE__API_KEY)" -v "$PWD/migration:/migration:ro" -v "$PWD/memory-rs-data:/data" memory-rs:local import --history-db /migration/history.db
```

   Codes de sortie : 0, import fait ; 3, import mené à terme avec des rejets
   listés dans le rapport ; 1, rien n'a été écrit (le message dit pourquoi).
   Le rapport, les rejets et la reprise sont décrits dans
   [memory-rs/README.md § Import](memory-rs/README.md#import-depuis-mem0-http).
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

Pour revenir à l'ancienne pile, arrête memory-rs puis redémarre les deux anciens
conteneurs :

```bash
podman stop memory-rs
podman start mem0-qdrant mem0-http
```

Aucune donnée n'est copiée en retour : les souvenirs écrits dans memory-rs depuis la
bascule ne sont pas dans l'ancienne pile.

## Diagnostiquer

`./doctor.sh` suit la chaîne réelle et dit quoi faire à chaque échec ; son code de
sortie est non nul dès qu'une vérification échoue. Ses sections :

- `── Conteneur memory-rs` : le conteneur existe-t-il (`MEMORY_RS_CONTAINER`) ;
- `── Cohérence .env / conteneur` : les valeurs de `.env` sont-elles appliquées
  (sinon `podman compose up -d --force-recreate memory-rs`) ;
- `── Conteneur` : état, redémarrages, santé ;
- `── Port depuis l'hôte` : `GET /health` sur le port publié ;
- `── oMLX, vu depuis memory-rs` : oMLX joignable depuis le conteneur, modèles chargés ;
- `── Écriture puis relecture` : un aller-retour dans le scope `_doctor` ;
- `── Ancienne mémoire Python+Qdrant` : si `./qdrant_storage` ou les conteneurs
  `mem0-qdrant` / `mem0-http` sont encore là alors que la base memory-rs est vide, un
  ✗ « ancienne mémoire Python+Qdrant non migrée » donne les commandes de migration
  à coller. La nouvelle pile continue de servir pendant ce temps ; une base déjà
  peuplée est considérée comme migrée.

doctor.sh ne lance, n'arrête et ne modifie jamais rien.
