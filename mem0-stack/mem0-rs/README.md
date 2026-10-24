# mem0-rs

Service mémoire HTTP de mem0-omp, en un seul binaire Rust. Il sert les 9 routes de
l'ancien mem0-http Python (mem0ai 2.2.1) avec le même contrat : port
8321 par défaut, en-tête `X-Mem0-Token`, mêmes formes JSON, mêmes codes. Tout le
stockage tient dans un seul fichier SQLite. Les embeddings et l'extraction viennent
d'une API OpenAI-compatible (oMLX).

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
```

- Défauts : `--host 127.0.0.1`, `--port 8321`.
- Argument inconnu, valeur manquante ou port hors 1-65535 : usage sur stderr, code 2.
- Erreur de configuration, de base ou d'écoute : message sur stderr, code 1.
- SIGTERM ou SIGINT : arrêt propre (les requêtes en cours finissent), code 0.
- `import` (premier argument) : import depuis mem0-http, voir § Import depuis mem0-http.

Vérifications : `cargo test --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked`
et `cargo clippy --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked --all-targets -- -D warnings`.

## Variables d'environnement

Lues comme `_env` de l'ancien mem0-http Python : une variable absente ou faite seulement de
blancs prend la valeur par défaut, et la valeur est trimée (sauf les deux jetons, lus
bruts).

| Variable | Défaut | Usage |
|---|---|---|
| `OMLX_BASE_URL` | `http://host.containers.internal:8000/v1` | base de l'API OpenAI-compatible (`POST {base}/embeddings` et `POST {base}/chat/completions`) |
| `OMLX_EMBED_MODEL` | `bge-m3` | champ `model` de la requête d'embedding |
| `OMLX_API_TOKEN` | `not-needed` | `Authorization: Bearer` ; jamais imprimé |
| `OMLX_LLM_MODEL` | `qwen3-8b` | modèle chat/completions de l'extraction (`add` infer=true) |
| `EMBEDDING_DIMS` | `1024` | dimension des vecteurs ; entier positif, sinon code 1 |
| `MEM0_DB_PATH` | `$HOME/.mem0/mem0-rs.db` | seul fichier de stockage ; dossier parent créé s'il manque |
| `MEM0_HTTP_TOKEN` | `""` | jeton exigé dans `X-Mem0-Token` ; vide = aucun contrôle ; jamais imprimé |
| `OMP_INSTALLATION_TOKEN` | `""` | ajouté à `GET /health` (`installation`) s'il est non vide |

Les variables `QDRANT_*` ne sont pas lues par le serveur. `mem0-rs import` lit
`QDRANT_API_KEY` (en-tête `api-key`, envoyé seulement si non vide ; jamais en
argument, qui serait visible dans `ps`), plus `MEM0_DB_PATH` et `EMBEDDING_DIMS` ;
il n'utilise aucune variable `OMLX_*` et n'appelle jamais l'embedder.

## Stockage

Un seul fichier SQLite, `MEM0_DB_PATH` (journal WAL : seuls `<db>-wal`, `<db>-shm`
et `<db>-journal` peuvent apparaître à côté, plus le verrou `<db>.lock`) :

- `meta` : `schema_version` (`3`) et `embedding_dims`. Relancer la base avec une
  autre `EMBEDDING_DIMS` est refusé (code 1), sans toucher au fichier. Une base v1
  ou v2 est refusée (`schema_version 2 inconnue (attendue 3)`, code 1), sans
  migration : supprimer le fichier et réimporter.
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

Chaque écriture calcule son embedding avant, puis écrit souvenir, vecteurs, termes et
historique dans une seule transaction. Aucun autre fichier n'est créé (ni
`~/.mem0/history.db`, ni journal sur disque). Retour arrière : supprimer le fichier.

Exclusivité : au démarrage, après l'écoute et avant d'ouvrir la base, le serveur
prend un verrou `flock` exclusif sur `<db>.lock` (créé si besoin, jamais supprimé)
et le garde jusqu'à son arrêt. Un second serveur sur la même base sort en code 1 :
`MEM0_DB_PATH=<db> est déjà servie par un autre processus mem0-rs (verrou <db>.lock)`.
Le verrou tombe avec le processus : il n'est jamais périmé.

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

mem0-rs ne le reproduit donc pas : `entity_boost` vaut toujours `0.0` et
`max_possible_score` vaut 1 (aucun hit BM25) ou 2. Aucune bibliothèque NLP n'est
utilisée.

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
