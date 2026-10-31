# mem0-rs

Service mémoire HTTP de mem0-omp, en un seul binaire Rust. Il sert les 9 routes de
l'ancien mem0-http Python (mem0ai 2.2.1) avec le même contrat : port
8321 par défaut, en-tête `X-Mem0-Token`, mêmes formes JSON, mêmes codes. Tout le
stockage tient dans un seul fichier SQLite. Les embeddings et l'extraction viennent
d'une API OpenAI-compatible (oMLX).

Au-delà de ce contrat, la mémoire est **liée** et **rêve** (§ Graphe de liens, § Rêve) :
chaque souvenir porte ses entités et ses voisins, un agent relie deux souvenirs (une
cause, un remplacement), la recherche peut suivre ces liens (fusion `graphe`), et un
travail de fond juge les souvenirs trop proches, consolide les faits en observations et
en mental models. Ces routes sont propres à mem0-rs : un client de l'ancien contrat ne
voit aucune différence.

`add` avec `infer=true` (y compris quand `infer` est omis) reproduit le chemin
additif de mem0 2.2.1 : un seul appel `chat/completions` (invite d'extraction
additive avec les `custom_instructions` de l'ancien mem0-http Python, réponse lue comme
`{"memory":[{"text","attributed_to"?}]}`), embedding des faits extraits,
dédoublonnage par hash md5 contre les 10 souvenirs existants les plus proches,
événements `ADD` seuls. Un souvenir extrait n'a pas de `role` ; l'`attributed_to`
du fait est promu dans le souvenir. Le chemin de décision ADD/UPDATE/DELETE/NONE de
mem0 1.x n'est pas reproduit.

## Usage

```sh
cargo build --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked
mem0-stack/mem0-rs/target/debug/mem0-rs [--host <adresse>] [--port <port>]
mem0-stack/mem0-rs/target/debug/mem0-rs import --history-db <chemin> [--qdrant-url <url>] [--collection <nom>] [--dry-run] [--json]
mem0-stack/mem0-rs/target/debug/mem0-rs banc [--corpus <fichier>] [--embedder local|openai] [--k <k,…>] [--seuil <x>] [--repetitions <n>] [--json]
```

- Défauts : `--host 127.0.0.1`, `--port 8321`.
- Argument inconnu, valeur manquante ou port hors 1-65535 : usage sur stderr, code 2.
- Erreur de configuration, de base ou d'écoute : message sur stderr, code 1.
- SIGTERM ou SIGINT : arrêt propre (les requêtes en cours finissent), code 0.
- `import` (premier argument) : import depuis mem0-http, voir § Import depuis mem0-http.
- `banc` (premier argument) : banc de mesure des classements de la recherche, voir
  § Banc de mesure.

Vérifications : `cargo test --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked`
et `cargo clippy --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked --all-targets -- -D warnings`.

## Variables d'environnement

Lues comme `_env` de l'ancien mem0-http Python : une variable absente ou faite seulement de
blancs prend la valeur par défaut, et la valeur est trimée (sauf les deux jetons, lus
bruts).

| Variable | Défaut | Usage |
|---|---|---|
| `OMLX_BASE_URL` | `http://host.containers.internal:8000/v1` | base de l'API OpenAI-compatible des embeddings (`POST {base}/embeddings`) |
| `OMLX_EMBED_MODEL` | `bge-m3` | champ `model` de la requête d'embedding |
| `OMLX_API_TOKEN` | `not-needed` | `Authorization: Bearer` des embeddings ; jamais imprimé |
| `OMLX_CHAT_BASE_URL` | `OMLX_BASE_URL` | base du chat (`POST {base}/chat/completions`) : extraction (`add` infer=true) et rêve ; `off` coupe le chat (§ Rêve) |
| `OMLX_CHAT_API_TOKEN` | `OMLX_API_TOKEN` | `Authorization: Bearer` du chat ; jamais imprimé |
| `OMLX_LLM_MODEL` | `qwen3-8b` | modèle chat/completions de l'extraction (`add` infer=true) et du rêve |
| `EMBEDDING_DIMS` | `1024` | dimension des vecteurs ; entier positif, sinon code 1 |
| `MEM0_DB_PATH` | `$HOME/.mem0/mem0-rs.db` | seul fichier de stockage ; dossier parent créé s'il manque |
| `MEM0_HTTP_TOKEN` | `""` | jeton exigé dans `X-Mem0-Token` ; vide = aucun contrôle ; jamais imprimé |
| `OMP_INSTALLATION_TOKEN` | `""` | ajouté à `GET /health` (`installation`) s'il est non vide |
| `MEM0_BACKUP_INTERVAL_HOURS` | `24` | écart visé entre deux instantanés de la base, en heures ; `0` les coupe ; entier positif ou nul, sinon code 1 (§ Instantanés) |
| `MEM0_BACKUP_KEEP` | `7` | nombre d'instantanés gardés ; entier positif, sinon code 1 |
| `MEM0_SEARCH_FUSION` | `additive` | fusion de `POST /memory/search` quand la requête n'a pas de champ `fusion` : `additive` (mem0 2.2.1), `rrf` ou `graphe` ; sinon code 1 (§ Recherche hybride) |
| `MEM0_RRF_K` | `60` | constante `k` de la RRF (et de la fusion `graphe`) ; entier positif, sinon code 1 |
| `MEM0_DREAM_INTERVAL_MINUTES` | `60` | période du rêve de fond, en minutes ; `0` le coupe (`POST /memory/dream` reste) ; entier positif ou nul, sinon code 1 (§ Rêve) |
| `MEM0_DREAM_QUIET_MINUTES` | `10` | une portée ne rêve que si aucun souvenir n'y a été écrit depuis ce délai ; entier positif ou nul |
| `MEM0_DREAM_PAIRS` | `20` | paires de souvenirs jugées par le LLM au plus, par rêve et par portée ; `0` : aucun appel au LLM ; entier positif ou nul |
| `MEM0_DREAM_FORGET_DAYS` | `180` | jours sans rappel ni lien avant une proposition d'oubli ; `0` : jamais ; entier positif ou nul |

Les variables `QDRANT_*` ne sont pas lues par le serveur. `mem0-rs import` lit
`QDRANT_API_KEY` (en-tête `api-key`, envoyé seulement si non vide ; jamais en
argument, qui serait visible dans `ps`), plus `MEM0_DB_PATH` et `EMBEDDING_DIMS` ;
il n'utilise aucune variable `OMLX_*` et n'appelle jamais l'embedder.

## Stockage

Un seul fichier SQLite, `MEM0_DB_PATH` (journal WAL : seuls `<db>-wal`, `<db>-shm`
et `<db>-journal` peuvent apparaître à côté, plus le verrou `<db>.lock`) :

- `meta` : `schema_version` (`4`), `embedding_dims` et `rappels_depuis_us` (depuis
  quand les rappels sont comptés). Relancer la base avec une autre `EMBEDDING_DIMS`
  est refusé (code 1), sans toucher au fichier. Une base **v3** est migrée à
  l'ouverture, en une transaction : les tables du graphe sont créées et chaque
  souvenir est indexé (entités, voisins) ; rien de ce qu'elle contient n'est réécrit.
  Une base v1 ou v2 est refusée (`schema_version 2 inconnue (attendue 4)`, code 1),
  sans migration : supprimer le fichier et réimporter.
- `memories` : les souvenirs (texte, hash md5, portée, rôle — NULL pour un souvenir
  extrait —, `attributed_to` en JSON compact, `metadata`, étiquettes, dates) et leur
  vecteur creux BM25 (`sparse`, JSON `[[indice,poids],…]`). `metadata` (objet JSON
  compact, nullable) porte les clés de payload hors cœur d'un souvenir importé
  (ex. `memory_type`) ; elle est rendue avec `tags` dans le `metadata` des lignes de
  `/memory/all` et `/memory/search`, et aucune route ne l'écrit. `sparse` vaut NULL
  pour un souvenir importé sans vecteur creux (point Qdrant en liste nue) : il est
  alors hors de la partie BM25 et du N de l'IDF, comme dans Qdrant. Un PUT le
  recalcule.
- `memory_vec` (sqlite-vec, `vec0`) : le vecteur dense normalisé L2 en float32.
- `memory_terms` (FTS5) : les indices creux du souvenir en jetons `t<indice>` ;
  `memory_terms_vocab` (`fts5vocab`) en donne les fréquences documentaires.
- `history` : le schéma de mem0 (`storage.py`), révisions ADD, UPDATE et DELETE.
- `messages` : les textes des `add` infer=true rendus en 200, par portée (les 10
  plus récents sont gardés) ; ils alimentent la section `Last k Messages` de
  l'invite d'extraction, comme la table `messages` de mem0.
- Graphe (schéma v4, § Graphe de liens) : `entites` et `souvenir_entites` (les
  entités de chaque souvenir), `liens` (`source`, `cible`, `type`, poids, origine,
  raison), `indexes` (le hash du texte indexé), `rappels` (combien de fois une
  recherche a rendu un souvenir, et quand).
- Rêve (§ Rêve) : `paires_jugees`, `propositions`, `reves` (le journal),
  `modeles` (les mental models, avec leur version précédente) et `consolidations`
  (le filigrane de chaque portée).

Chaque écriture calcule son embedding avant, puis écrit souvenir, vecteurs, termes,
historique et index (entités, voisins sémantiques) dans une seule transaction ; une
suppression retire aussi les liens, entités et rappels du souvenir. Hors des instantanés de `backups/`
(§ Instantanés), aucun autre fichier n'est créé (ni
`~/.mem0/history.db`, ni journal sur disque). Retour arrière : supprimer le fichier.

Exclusivité : au démarrage, après l'écoute et avant d'ouvrir la base, le serveur
prend un verrou `flock` exclusif sur `<db>.lock` (créé si besoin, jamais supprimé)
et le garde jusqu'à son arrêt. Un second serveur sur la même base sort en code 1 :
`MEM0_DB_PATH=<db> est déjà servie par un autre processus mem0-rs (verrou <db>.lock)`.
Le verrou tombe avec le processus : il n'est jamais périmé.

## Instantanés

Une base, un fichier : sans copie, une fausse manœuvre ou un disque qui lâche
emporte toute la mémoire. Le serveur prend donc des instantanés par `VACUUM INTO`
dans `backups/`, à côté de `MEM0_DB_PATH` (`/data/backups/` dans le conteneur,
`mem0-rs-data/backups/` sur l'hôte avec le compose) :

- nom `<base sans extension>-AAAAMMJJTHHMMSSZ.db` (UTC), par exemple
  `mem0-rs-20261024T070509Z.db` ; écrit d'abord en `.db.tmp`, renommé une fois
  complet ;
- toutes les `min(MEM0_BACKUP_INTERVAL_HOURS, 1 h)`, le serveur regarde l'instantané
  le plus récent du dossier, et n'en prend un que s'il a au moins
  `MEM0_BACKUP_INTERVAL_HOURS` (ou s'il n'y en a aucun) : le rythme survit aux
  redémarrages. Le premier contrôle a lieu une période après le démarrage, jamais
  au démarrage ;
- après chaque instantané, seuls les `MEM0_BACKUP_KEEP` plus récents sont gardés ;
  un fichier du dossier qui n'a pas la forme d'un nom d'instantané n'est jamais
  touché ;
- un échec (disque plein, dossier non inscriptible) est écrit sur stderr
  (`mem0-rs : instantané impossible : …`) et n'arrête pas le serveur.

Un instantané est une base mem0-rs complète (vecteurs, termes, historique) :
pour restaurer, arrêter le serveur, remplacer `MEM0_DB_PATH` par la copie (et
supprimer `<db>-wal` et `<db>-shm`), puis redémarrer.

## Écarts assumés au Python

Trois comportements n'existaient pas dans mem0-http et ne changent rien pour un
client correct :

- **Corps borné** : au-delà de 1 Mio (`CORPS_MAX`), toute route rend 413
  `{"detail":"corps de requête au-delà de 1048576 octets"}`, sans embedding ni
  écriture. Le Python lisait un corps sans borne en mémoire.
- **Jeton comparé en temps constant** : la durée du contrôle de `X-Mem0-Token` ne
  dépend plus de la position du premier octet faux.
- **Masquage des secrets** : `add` (infer ou non), `add_procedure` et `PUT`
  masquent les secrets du texte AVANT l'embedding, l'invite d'extraction et
  l'écriture — le `hash` est celui du texte masqué. Les familles et leur ordre sont
  ceux de `redact` du plugin (`omp-mem0-memory/write.ts`), jeton `[REDACTED]` :
  `src/redaction.rs`, jugé avec le plugin sur les cas partagés de
  `tests/redaction-cas.json`. Le plugin masquait déjà ce qu'il envoie ; le serveur
  couvre les clients qui écrivent sans lui (oracle du harness, apps OMP Console).
  `mem0-rs import` recopie la source verbatim, sans masquage.

`PUT` et `DELETE` sur un id inconnu rendent toujours le 500 de starlette, comme le
Python : c'est un cas du contrat boîte noire (`suppression`, AC-9), et l'API ne
porte pas de portée sur ces deux routes.

## Import depuis mem0-http

```sh
QDRANT_API_KEY=<clé> MEM0_DB_PATH=<base> mem0-rs import --history-db <history.db> \
  [--qdrant-url http://127.0.0.1:6333] [--collection omp_memory] [--dry-run] [--json]
```

Lit toute la collection Qdrant (`POST /collections/<nom>/points/scroll`, pages de
256, payload et vecteurs ; seule requête émise) puis le `history.db` de mem0 (ouvert
en lecture seule), et écrit la base en UNE transaction. La source n'est jamais
modifiée. Les vecteurs denses de la source sont repris tels quels (aucun appel à
l'embedder) ; le vecteur creux `bm25` source fait foi pour la partie BM25 (un point
en liste nue n'en a pas : `sparse` NULL). Les clés de payload hors cœur vont dans
`metadata`, l'historique et les messages (`messages`, contexte d'`add` infer=true)
sont recopiés verbatim.

- `--history-db` (obligatoire) : sur le poste, history.db vit dans le conteneur
  mem0-http, pas sur l'hôte ; on en prend une copie sans l'écrire :
  `"$HOME/Library/Application Support/com.omp.console/components/podman/6.1.3/bin/podman" --url "unix://$TMPDIR/podman/omp-console-api.sock" cp omp-console-mem0-http:/home/mem0/.mem0/history.db <copie>`.
- `--qdrant-url` : défaut `http://127.0.0.1:6333` (barre finale retirée).
- `--collection` : défaut `omp_memory`.
- `--dry-run` : lit la source et la cible, produit le même rapport que l'import réel
  qui suivrait, et n'écrit rien (aucun fichier créé, base existante ouverte en
  `immutable=1`) ; ligne `simulation : rien n'a été écrit dans <base>` sur stderr.
  Refusé si `<base>-wal` n'est pas vide : démarrer puis arrêter mem0-rs l'intègre.
- `--json` : rapport en un objet JSON sur une ligne (forme figée, lue par l'app).

La cible gagne : un souvenir dont l'id est déjà dans la base (`memories`, ou
`history` pour un souvenir supprimé, qui n'est donc jamais ressuscité) est compté
« déjà présent » et sauté avec son historique, même si son contenu diffère ; une
portée de messages déjà présente est sautée. Relancer l'import est donc sans effet
sur ce qui existe et n'ajoute que le nouveau.

Données rejetées (listées avec id, raison et détail, code 3) : `vecteur_absent`,
`dimension` (≠ `EMBEDDING_DIMS`), `texte_absent`, `champ_invalide` (valeur que la
base ne sait pas représenter : `hash`/`user_id` absents, `actor_id`,
`expiration_date`, date hors format, `bm25` mal formé…), `historique_orphelin`
(ligne d'historique d'un id absent de Qdrant sans `DELETE` ; un id supprimé AVEC
`DELETE` est importé normalement).

Rapport texte, une ligne par agent_id (trié, `(sans agent_id)` en dernier), puis
ses rejets et le total :

```
a1 : 3 importés, 0 déjà présents, 1 rejetés, 5 révisions, 2 messages
  rejet souvenir <id> : dimension (768 dimensions, 1024 attendues)
total : 3 importés, 0 déjà présents, 1 rejetés, 5 révisions, 2 messages
```

En `--json` : `{"agents":[{"agent_id":"a1","importes":3,"deja_presents":0,"rejetes":[{"element":"souvenir","id":"…","raison":"dimension","detail":"768 dimensions, 1024 attendues"}],"revisions":5,"messages":2}],"totaux":{"importes":3,"deja_presents":0,"rejetes":1,"revisions":5,"messages":2}}`.

Codes : 0 succès sans rejet ; 1 erreur (Qdrant injoignable ou clé refusée,
collection ou history.db introuvable, base servie par un mem0-rs en marche — son
verrou `<base>.lock` est tenu —, base illisible, écriture impossible), rien n'est
écrit et stdout reste vide ; 2 usage ; 3 import (ou simulation) mené à terme avec au
moins un rejet. Le rapport ne sort sur stdout que pour 0 et 3.

Tout ou rien : la source est lue et validée en entier avant que la cible ne soit
ouverte ; une erreur ou un Ctrl-C pendant la lecture laisse le dossier de la cible
identique, octet pour octet. L'écriture tient dans une transaction : une erreur ou un
signal l'annule. Hors garantie : une cible INEXISTANTE interrompue entre sa création
et la fin de la transaction peut rester créée avec un schéma vide (la supprimer).

## Recherche hybride

`POST /memory/search` reproduit `Memory._search_vector_store` de mem0ai 2.2.1 avec
Qdrant 1.19 et fastembed 0.8.1 :

1. 500 si la requête trimée est vide, si `threshold` est hors de [0, 1] ou si
   `limit < 0` ; `threshold` absent vaut 0.1.
2. Portée : `user_id = moi`, plus `agent_id` ; les `filters` du client passent
   d'abord, la portée les écrase. Une valeur scalaire est une égalité stricte sur un
   champ du payload (`user_id agent_id run_id role tags data text_lemmatized hash
   created_at updated_at`) ; toute autre clé ne correspond à rien.
3. Candidats sémantiques : cosinus brut (`1 − vec_distance_cosine`) décroissant, les
   `max(limit*4, 60)` premiers.
4. Candidats BM25 : vecteur creux de la requête (même encodeur que les souvenirs),
   score `Σ q_i·idf_i·d_i` avec l'IDF de Qdrant `ln((N − n + 0.5)/(n + 0.5) + 1)` sur
   toute la base (N : souvenirs qui portent un vecteur creux), puis sigmoïde dont
   `(midpoint, steepness)` dépend du nombre de mots
   de la requête.
5. Le seuil s'applique au cosinus brut AVANT la fusion ; puis
   `min((cosinus + bm25)/max_possible, 1)`, tri stable décroissant, troncature à
   `limit`, retrait des souvenirs à texte vide.

Avec `explain:true`, `score_details.semantic_score` est le cosinus brut.

L'encodeur BM25 reproduit `Qdrant/bm25` de fastembed : `\w` de Python, minuscules,
mots vides anglais, jetons de plus de 40 caractères écartés, racine Snowball
anglaise, TF BM25 (k=1.2, b=0.75, avg_len=256), indice `|murmur3_x86_32|`.

**NON-objectifs** :

- la parité de l'IDF après des suppressions : Qdrant compte les points supprimés
  dans N et n tant que le segment n'est pas reconstruit, mem0-rs ne compte que les
  souvenirs présents ;
- l'ordre entre ex-aequo exacts, que Qdrant ne garantit pas ;
- `rerank`, inerte dans le Python ;
- les opérateurs de `filters` (objets, listes, `AND`/`OR`/`NOT`, `"*"`) : 501
  `{"detail":"filters avancés (opérateurs, AND/OR/NOT, listes, \"*\") non supportés par mem0-rs"}` ;
- des écarts de l'ordre de 1e-6 sur les scores (Qdrant calcule en float32).

`GET /memory/graph` reproduit `graph_edges` de l'ancien mem0-http Python : seuil 0.75,
8 meilleurs voisins par souvenir, voisinages réunis, tri (score décroissant, source,
target).

### Fusion : additive (défaut), RRF ou graphe

Le classement se choisit par requête, avec le champ `"fusion"` du corps (`"additive"`,
`"rrf"` ou `"graphe"` ; absent ou `null` : le défaut du serveur), ou pour tout le
serveur avec `MEM0_SEARCH_FUSION` (défaut `additive`). Une autre valeur du champ rend
422 `literal_error` (`ctx.expected` : `'additive', 'rrf' or 'graphe'`), avant tout
embedding. Le
champ est propre à mem0-rs : un client qui ne l'envoie pas — le plugin — garde
exactement le classement de mem0 2.2.1, et l'ancien Python l'ignorait comme tout
champ inconnu.

- **`additive`** (défaut) : les étapes 3 à 5 ci-dessus. C'est la parité que prouve
  `scripts/mem0-http-contrat/rang.json` ; elle ne bouge pas.
- **`rrf`** : Reciprocal Rank Fusion (Cormack, Clarke et Büttcher, SIGIR 2009),
  `score = Σ 1/(k + rang)` sur le rang sémantique et le rang BM25, `k` valant
  `MEM0_RRF_K` (60 par défaut, la valeur de l'article) :
  1. Candidats : l'UNION des `max(limit*4, 60)` premiers du classement sémantique
     et des `max(limit*4, 60)` premiers hits BM25. Un souvenir que seul le BM25
     trouve (identifiant, nom de fichier, code d'erreur noyé dans un long texte)
     entre dans le classement avec son vrai cosinus : sqlite-vec calcule le cosinus
     de tout le scope, aucun score ne manque. L'additive ne le fait pas : mem0 n'y
     classe que les candidats sémantiques, et la parité l'interdit.
  2. Seuil : `threshold` juge le cosinus brut AVANT la fusion, comme pour
     l'additive. Un candidat sous le seuil sort des deux classements, et les rangs
     se comptent parmi les candidats gardés. Deux raisons : `threshold` garde un seul
     sens pour le client (un plancher de cosinus, que le plugin règle à
     `RECALL_THRESHOLD` et que le contrat vérifie sur `score_details.semantic_score`),
     et un score RRF n'a pas d'échelle absolue (au plus `2/(k+1)`, soit 0,033 pour
     k = 60) : un seuil sur lui ne voudrait rien dire.
  3. Rangs ordinaux à partir de 1 (deux cosinus égaux ont deux rangs, départagés
     par l'id) ; un classement où le souvenir n'est pas ne contribue pas. Tri
     décroissant, et à score égal l'ordre dense (cosinus le plus haut, puis id).
     Troncature à `limit`, puis retrait des textes vides, comme l'additive.
  4. `score_details` garde ses 7 clés et leurs types, que le contrat boîte noire
     vérifie à l'identique : `semantic_score` = cosinus brut, `bm25_score` = BM25
     normalisé (0 hors des hits), `entity_boost` = 0, `raw_score` = la somme RRF,
     `max_possible_score` = `1/(k+1)`, doublé dès qu'un hit BM25 existe (même règle
     que l'additive), et `final_score` = `score` = `raw_score/max_possible_score`,
     dans [0, 1].

- **`graphe`** (memoire-liee) : la RRF à trois classements, le troisième étant celui du
  graphe de la mémoire (§ Graphe de liens) — ce que l'embedding et le BM25 ne
  trouvent pas parce que le souvenir ne ressemble pas à la requête, mais qu'il est
  **relié** à ce qu'elle évoque (le correctif d'un symptôme, la convention qui en
  remplace une autre).
  1. Semences : les 10 premiers du sémantique et les 10 premiers hits BM25 au-dessus
     du seuil, chacune avec son meilleur rang `r`.
  2. Score de graphe d'un souvenir `m` de la portée, inspiré de Hindsight
     (`tanh` sature les comptes d'entités, les signaux s'ajoutent) :
     `tanh(0.5·q) + max_semence [ 1/r · (sém + typé + 0.5·tanh(0.5·s)) ]`, où `q`
     compte les entités de la requête que `m` porte, `sém` et `typé` sont les poids
     des liens `semantique` et typés (`cause`, `remplace`, `contredit`, `precise`,
     `voir`, `preuve`) entre `m` et la semence, `s` les entités partagées avec elle.
     Une entité portée par plus de `max(3, n/4)` souvenirs (`n` : taille de la
     portée) ne relie rien : le nom du projet n'est pas un lien.
  3. Le classement du graphe ne garde que les scores ≥ 0.7 (`GRAPHE_PLANCHER`), les
     10 meilleurs : sans cross-encoder derrière la fusion, une voix donnée à un voisin
     faible déclasse les bons candidats que seul le sémantique trouve (mesuré).
  4. `threshold` ne filtre que les classements sémantique et BM25 : un souvenir
     atteint par le graphe entre même sous le seuil — c'est l'objet du bras —, et
     `score_details.semantic_score` garde son vrai cosinus.
  5. `score_details` garde ses 7 clés : `entity_boost` porte le score de graphe,
     `max_possible_score` vaut `1/(k+1)` par classement actif (le sémantique
     toujours, le BM25 dès un hit, le graphe dès qu'il atteint un souvenir).

Effet sur le plugin : le rappel envoie `threshold` 0.55 puis re-trie ce qu'il reçoit
sur `semantic_score`. La fusion décide donc QUELS souvenirs entrent dans son lot
(`RECALL_POOL`), pas l'ordre final qu'il injecte ; et un hit BM25 seul sous 0.55 de
cosinus reste écarté par le seuil, quelle que soit la fusion.

La ligne « à l'écoute » du démarrage nomme la stratégie par défaut
(`recherche additive`, `recherche rrf-k60`).

## Banc de mesure

```sh
cargo run --release --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked -- banc
```

`mem0-rs banc` charge un corpus étiqueté dans une base mem0-rs jetable (dossier
temporaire supprimé à la fin), joue chaque requête avec chaque stratégie par le
chemin réel de `/memory/search` (`recherche::executer` : SQLite, sqlite-vec, FTS5,
fusion), puis imprime deux tableaux Markdown, ou un objet JSON d'une ligne avec
`--json`.

- **Stratégies** : `semantique` (cosinus seul), `bm25` (hits BM25 seuls),
  `additive`, puis `rrf-k<k>` et `graphe-k<k>` pour chaque `k` de `--k` (défaut
  `10,60`). Les deux classements seuls sont des témoins du banc, pas des valeurs de
  `fusion`.
- **Métriques**, moyennes sur les requêtes, profondeur 10 : Recall@5 et Recall@10
  (part des pertinents retrouvés), MRR@10 (inverse du rang du premier pertinent),
  nDCG@10 (gain `2^grade − 1`, remise `log2(rang + 1)`), puis nDCG@10 par catégorie
  de requête.
- **Latence** : p50 et p95, en ms, de `recherche::executer` seul (l'embedding de la
  requête est calculé une fois, avant, et n'est pas chronométré), sur
  `--repetitions` passes (défaut 5) de chaque requête. Toutes les stratégies font
  les mêmes lectures (cosinus de tout le scope, hits BM25) : leurs écarts de latence
  sont du bruit, seule une régression du chemin commun se verrait.
- **`--seuil`** : `threshold` des recherches, 0 par défaut (on mesure le classement,
  pas le plancher).
- **Corpus** : `src/banc/corpus.json`, intégré au binaire (`--corpus <fichier>` pour
  un autre, au même format). 166 souvenirs de développement en français et en
  anglais, 6 liens typés posés comme par un agent (`liens`, facultatif), 60 requêtes
  en quatre catégories — `lexicale` (identifiant, nom de fichier, code d'erreur :
  `SQLITE_BUSY`, `recall.ts`, `E0502`…), `paraphrase` (reformulation sans les mots
  du souvenir), `mixte`, `liee` (la réponse est reliée au souvenir que la requête
  évoque, par un lien ou une entité, sans lui ressembler) — chacune avec ses
  souvenirs pertinents gradués (2 : répond, 1 : utile).
- **Embedder** : `--embedder local` (défaut) est un plongeur déterministe, hors
  ligne (`src/banc/plongeur.rs`) : mots normalisés, trigrammes de caractères et
  concepts d'un petit lexique bilingue de développement, hachés puis normalisés en
  L2. Il porte un peu de signal sémantique mais n'est pas un modèle de langue : ni
  ordre des mots, ni paraphrase hors de son lexique, et ce lexique a été écrit avec
  le corpus, ce qui flatte le classement sémantique. Ses chiffres comparent les
  stratégies entre elles et détectent une régression (la suite de tests le joue) ;
  ils ne prédisent pas la qualité réelle. `--embedder openai` mesure avec le vrai
  modèle, par les mêmes variables que le serveur (`OMLX_BASE_URL`,
  `OMLX_EMBED_MODEL`, `OMLX_API_TOKEN`, `EMBEDDING_DIMS`) :
  `OMLX_BASE_URL=http://127.0.0.1:8000/v1 mem0-rs banc --embedder openai` contre
  oMLX et bge-m3.

Codes : 0 succès ; 1 corpus invalide (id en double, pertinent inconnu, grade hors
de 1..3…), embedder ou base en échec ; 2 usage.

Mesure du 2026-10-26, embedder local, build release, `banc --k 10,60,100` :

| stratégie | Recall@5 | Recall@10 | MRR@10 | nDCG@10 | p50 (ms) | p95 (ms) |
|---|---:|---:|---:|---:|---:|---:|
| semantique | 0.856 | 0.939 | 0.856 | 0.825 | 1.83 | 2.93 |
| bm25 | 0.664 | 0.708 | 0.766 | 0.676 | 1.58 | 2.07 |
| additive | 0.789 | 0.867 | 0.846 | 0.783 | 1.64 | 2.45 |
| rrf-k10 | 0.797 | 0.897 | 0.856 | 0.792 | 1.81 | 2.54 |
| rrf-k60 | 0.797 | 0.881 | 0.847 | 0.782 | 1.57 | 2.30 |
| rrf-k100 | 0.789 | 0.881 | 0.846 | 0.781 | 1.66 | 3.01 |
| graphe-k10 | 0.814 | 0.914 | 0.856 | 0.821 | 2.39 | 4.16 |
| graphe-k60 | 0.814 | 0.889 | 0.847 | 0.808 | 2.20 | 3.14 |
| graphe-k100 | 0.806 | 0.889 | 0.846 | 0.807 | 2.89 | 3.92 |

| nDCG@10 | lexicale (18) | liee (8) | mixte (17) | paraphrase (17) |
|---|---:|---:|---:|---:|
| semantique | 0.842 | 0.590 | 0.915 | 0.827 |
| bm25 | 0.896 | 0.453 | 0.840 | 0.386 |
| additive | 0.917 | 0.525 | 0.857 | 0.687 |
| rrf-k10 | 0.917 | 0.538 | 0.883 | 0.689 |
| rrf-k60 | 0.917 | 0.495 | 0.872 | 0.684 |
| rrf-k100 | 0.917 | 0.495 | 0.872 | 0.682 |
| graphe-k10 | 0.917 | 0.757 | 0.883 | 0.689 |
| graphe-k60 | 0.917 | 0.690 | 0.872 | 0.684 |
| graphe-k100 | 0.917 | 0.690 | 0.872 | 0.682 |

Lecture :

- Sur les requêtes lexicales, les deux fusions battent chaque classement seul : le
  BM25 apporte ce que l'embedding dilue.
- La RRF passe devant l'additive en Recall@10 (0.897 contre 0.867), en MRR@10 et en
  nDCG@10, surtout sur les requêtes mixtes : ce sont les hits BM25 hors des
  candidats sémantiques, que seule la RRF classe.
- La fusion `graphe` laisse intactes les catégories lexicale, mixte et paraphrase
  (le plancher de 0.7 ne laisse voter que les connexions fortes) et porte les
  requêtes `liee` de 0.538 à 0.757 en nDCG@10 (k = 10) : la réponse n'y ressemble
  pas à la requête, elle est reliée à ce qu'elle évoque.
- Sur les paraphrases, le BM25 seul s'effondre et tire les fusions sous le
  sémantique seul ; avec ce plongeur, le sémantique seul reste premier sur les
  paraphrases et les mixtes — ce que son lexique, écrit avec le corpus, rend attendu.
- `k` bouge peu : 60 et 100 donnent presque le même classement ici, 10 gagne un peu.

Le défaut reste `additive`, pour la parité. Passer à `rrf` ou à `graphe` se décide sur
une mesure avec le vrai embedder (`--embedder openai`), pas sur ce tableau ; et le
bras graphe ne vaut que ce que valent les liens de la base (posés par les agents et
par le rêve).

## Graphe de liens

Schéma v4 (memoire-liee). Chaque écriture indexe le souvenir, dans sa transaction :

- **Entités** (`src/entites.rs`) : extraction déterministe, sans modèle ni
  bibliothèque NLP, de ce qu'un souvenir de développement nomme sans ambiguïté —
  fichiers (clé : le nom de base, `src/recherche.rs` et `recherche.rs` partagent
  `recherche.rs`), routes (`/memory/search`), identifiants de code (snake_case,
  camelCase, PascalCase à majuscule interne, kebab-case avec chiffre ou trois parts,
  texte entre accents graves), constantes et codes d'erreur (`MEM0_DB_PATH`,
  `E0502`), noms propres en milieu de phrase (`Qdrant`). Au plus 32 par souvenir.
- **Voisins sémantiques** : les 8 souvenirs de même portée de cosinus ≥ 0.75 (les
  constantes de `GET /memory/graph`), stockés en liens `semantique`
  (`source < cible`).

Les liens typés sont posés par un agent ou par le rêve : `cause` (la source explique
la cible), `remplace` (la source rend la cible obsolète), `contredit`, `precise`,
`voir` ; `preuve` relie une observation aux faits qui la fondent. Un lien porte son
poids (1 pour un agent), son origine (`agent`, `reve`, `calcul`), une raison et sa date.

Routes (jeton exigé comme partout ; erreurs propres à mem0-rs : 422
`{"detail": "<raison>"}` pour un corps invalide, 404 pour un id inconnu) :

| Route | Rôle |
|---|---|
| `POST /memory/link` `{source, target, type, reason?}` | pose un lien (`type` parmi `cause`, `remplace`, `contredit`, `precise`, `voir`) ; rend `{"link": …}` |
| `POST /memory/unlink` `{source, target, type}` | retire un lien ; `{"removed": bool}` |
| `GET /memory/links?agent_id=…[&semantic=true]` | les liens de la portée (typés ; `semantique` en plus avec `semantic=true`) |
| `GET /memory/{id}/links` | les liens typés d'un souvenir vus depuis lui (`direction` `out` ou `in`), avec le texte de l'autre bout, et ses entités |
| `GET /memory/entities?agent_id=…` | les entités de la portée, les plus portées d'abord |

`POST /memory/search` avec `"links": true` ajoute à chaque ligne, après
`attributed_to`, `links` : ses liens typés (`id` de l'autre bout, `type`,
`direction`, `weight`, `origin`, `reason`). Sans ce champ, la forme des lignes ne
change pas. Chaque recherche compte un rappel pour chaque souvenir rendu (table
`rappels`, lue par le rêve).

`GET /memory/graph` garde son contrat (cosinus calculé à la volée, voisinages
réunis) : la route typée est `GET /memory/links`.

## Rêve

Le rêve de la mémoire (reve-memoire) : un travail de fond, hors du chemin des
requêtes, quand une portée est calme. Il n'efface et ne réécrit **jamais** un souvenir
écrit par un agent : il ajoute des objets dérivés (liens, observations, mental
models, propositions), et toute suppression passe par une décision humaine.

**Rêve local** (`src/reve.rs`), dans mem0-rs, sur son propre LLM (`OMLX_LLM_MODEL` via `OMLX_CHAT_BASE_URL`) :
toutes les `MEM0_DREAM_INTERVAL_MINUTES`, chaque portée qui a changé depuis son
dernier rêve et qu'aucune écriture n'a touchée depuis `MEM0_DREAM_QUIET_MINUTES` :

1. **Rejouer** — réindexe les souvenirs dont l'index manque ou ne suit plus le texte.
2. **Comparer** — chaque paire de faits de cosinus ≥ 0.85 pas encore jugée avec ces
   textes (au plus `MEM0_DREAM_PAIRS`) passe au LLM, qui répond `doublon`,
   `remplace`, `contredit`, `precise` ou `distinct`. `precise` pose un lien ;
   `contredit` pose un lien et ouvre une proposition ; `doublon` et `remplace`
   ouvrent une proposition de suppression de l'ancien (un remplacement pose aussi
   le lien `remplace`). Le verrou de la base n'est jamais tenu pendant l'appel.
3. **Oublier doucement** — une observation qui a perdu toutes ses preuves est
   retirée ; un fait ni rappelé, ni relié, ni preuve depuis `MEM0_DREAM_FORGET_DAYS`
   jours devient une proposition d'oubli (pas avant qu'une fenêtre entière se soit
   écoulée depuis la création ou la migration de la base).
4. **Journal** — une ligne `reves` par portée et par rêve.

Chat coupé (`OMLX_CHAT_BASE_URL=off`, une pile dont le serveur n'a que des
embeddings) : l'étape 2 est sautée sans erreur, les autres tournent ; `add`
infer=true rend 500 `{"detail": "add infer=true : LLM coupé (OMLX_CHAT_BASE_URL=off)"}`
sans aucun appel.

`GET /health` porte l'état du rêve local : `dream: {enabled, chat, last_run_at,
last_error}` — `enabled` : la boucle tourne (`MEM0_DREAM_INTERVAL_MINUTES` non
nul) ; `chat` : `on` ou `off` ; `last_run_at` : la fin du dernier cycle (un tour de
la boucle qui a rêvé au moins une portée, ou un `POST /memory/dream`), `null`
avant le premier ; `last_error` : ses erreurs (`« portée » : …`, jointes par
` ; `), `null` s'il a réussi.

**Consolidation** (phases 3 et 4) : elle demande un modèle qui raisonne sur toute une
portée. Le harness la confie à une session omp (`omp-harness/dreams.ts`), dont les
modèles sont déjà configurés pour les runs : il lit le dossier, le fait raisonner, et
rend le résultat, que mem0-rs valide puis applique en une transaction.

- **Observation** : un souvenir (`metadata.memory_type = "observation"`, étiquette
  `observation`, `metadata.preuves` = nombre de preuves), croyance durable fondée sur
  des faits reliés par des liens `preuve`, **affinée** plutôt qu'écrasée quand un
  fait nouveau la précise ou la contredit (son historique garde chaque version).
  Elle se cherche comme un souvenir.
- **Mental model** : la réponse permanente à une question fixe sur le projet
  (`carte`, `conventions`, `decisions`, `pieges`, `preferences`), réécrite seulement
  quand sa portée a changé (`stale`), son contenu précédent gardé. Le plugin la pose
  au prompt système en tête de session.
- **Filigrane** : jusqu'où les faits d'une portée sont consolidés ; un dossier ne
  rend que les faits plus récents (60 au plus ; le suivant prend la suite).

| Route | Rôle |
|---|---|
| `GET /memory/dream?agent_id=…` | les 10 derniers rêves de la portée (`local`, `consolidation`) et ses propositions ouvertes, avec le texte des souvenirs cités |
| `POST /memory/dream` `{agent_id?}` | un rêve local maintenant (toutes les portées sans `agent_id`), sans attendre le calme ; rend les rapports |
| `POST /memory/dream/proposal` `{id, decision: "accept" \| "reject"}` | accepter applique la suppression proposée (historisée comme toute suppression) ; 409 si déjà décidée |
| `GET /memory/dream/dossier?agent_id=…` | le dossier de consolidation : `horizon_us`, `since`, `due`, `new_facts` et `context` (faits reliés, avec entités et liens), `observations` (avec leurs preuves et `stale`), `models` |
| `POST /memory/dream/consolidation` | `{agent_id, horizon_us, observations: [{id?, text, evidence}], obsolete, causes: [{source, target, reason?}], models: [{name, content, sources}]}` : validé (422 avec la raison : preuve qui n'est pas un fait de la portée, observation inconnue, modèle inconnu…), revalidé sous le verrou après l'embedding, appliqué en une transaction, journalisé |
| `GET /memory/models?agent_id=…` | les mental models de la portée : `name`, `question`, `content`, `sources`, `updated_at`, `stale` |

Les textes écrits par le rêve (observations, raisons, mental models) passent par le
même masquage des secrets que les écritures.

## entity_boost

entity_boost est **inactif** dans la config actuelle de mem0-http : spaCy n'est pas
installé (l'image n'installe pas `mem0ai[nlp]`, et son lemmatiseur anglais ne
conviendrait pas au corpus français). Le chemin, dans mem0ai 2.2.1 :

- `mem0/utils/entity_extraction.py:751` : `extract_entities` appelle `get_nlp_full()`
  et rend `[]` quand il vaut `None` (l.756-757) ;
- `mem0/utils/spacy_models.py:21` : `_ensure_model_available` lève `ImportError`
  (« spaCy is not installed… ») ;
- `mem0/utils/spacy_models.py:44` : `get_nlp_full` attrape l'exception, pose
  `_load_failed_full = True` (l.64, définitif) et rend `None` ;
- `mem0/memory/main.py:3336` : `query_entities = extract_entities(query)` vaut donc
  `[]`, `if query_entities:` (l.3364) est faux et `entity_boosts` reste vide ;
- `mem0/utils/scoring.py:57` : `ENTITY_BOOST_WEIGHT = 0.5` n'est jamais ajouté à
  `max_possible` ;
- `mem0/utils/lemmatization.py:31` : sans spaCy, `lemmatize_for_bm25` rend le texte
  inchangé, donc `text_lemmatized` = le texte du souvenir.

mem0-rs ne le reproduit donc pas : avec les fusions `additive` et `rrf`,
`entity_boost` vaut toujours `0.0` et `max_possible_score` vaut 1 (aucun hit BM25) ou
2. Aucune bibliothèque NLP n'est utilisée. La fusion `graphe` réutilise la clé pour son
score de graphe, que les entités lexicales du schéma v4 nourrissent (§ Graphe de liens).

## Dépendances

Dépendances directes (`[dependencies]` de `Cargo.toml`) :

| Crate | Rôle |
|---|---|
| `axum` | serveur HTTP, routes |
| `tokio` | runtime async, signaux, délais des nouvelles tentatives |
| `serde` | sérialisation des réponses dans l'ordre de clés du Python |
| `serde_json` | JSON (`preserve_order` pour l'ordre des clés, `arbitrary_precision` pour les entiers hors i64) |
| `rusqlite` | SQLite embarqué (`bundled`, avec FTS5) |
| `sqlite-vec` | extension `vec0` et `vec_distance_cosine` |
| `reqwest` | client de l'API OpenAI-compatible (embeddings, chat/completions ; rustls, sans openssl) |
| `md-5` | `hash` des souvenirs (md5 du texte) |
| `uuid` | identifiants v4 des souvenirs et des révisions |
| `time` | horodatage isoformat UTC |
| `rust-stemmers` | raciniseur Snowball anglais de l'encodeur BM25 |
| `unicode-general-category` | table des catégories Unicode, pour le `\w` de Python |

`rust-stemmers` 1.2.0 est la crate qu'embarque py_rust_stemmers 0.1.8, le raciniseur
de fastembed : c'est un raciniseur Snowball retenu pour la parité BM25 (décision du
2026-10-12), pas une bibliothèque NLP (ni entités, ni lemmatiseur, ni modèle).
`unicode-general-category` n'est qu'une table Unicode. Dépendance de développement :
`sha2`, pour le faux embedder des tests.

## Mots vides

`src/stopwords_english.txt` est une copie verbatim de `english.txt` du dépôt Hugging
Face [`Qdrant/bm25`](https://huggingface.co/Qdrant/bm25), révision
`22b8d2af71a76161e18dd432d2cee0eefa66e412` (179 mots), la liste qu'utilise fastembed.
