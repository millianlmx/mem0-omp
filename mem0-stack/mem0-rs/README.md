# mem0-rs

Service mémoire HTTP de mem0-omp, en un seul binaire Rust. Il sert les 9 routes de
`mem0-stack/mem0-http/http_server.py` (mem0ai 2.2.1) avec le même contrat : port
8321 par défaut, en-tête `X-Mem0-Token`, mêmes formes JSON, mêmes codes. Tout le
stockage tient dans un seul fichier SQLite. Les embeddings viennent d'une API
OpenAI-compatible (oMLX).

`add` avec `infer=true` (y compris quand `infer` est omis) rend
`501 {"detail":"infer=true n'est pas encore supporté par mem0-rs"}` sans rien écrire :
l'extraction par LLM arrive avec la feature mem0-rs-extraction-llm.

## Usage

```sh
cargo build --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked
mem0-stack/mem0-rs/target/debug/mem0-rs [--host <adresse>] [--port <port>]
```

- Défauts : `--host 127.0.0.1`, `--port 8321`.
- Argument inconnu, valeur manquante ou port hors 1-65535 : usage sur stderr, code 2.
- Erreur de configuration, de base ou d'écoute : message sur stderr, code 1.
- SIGTERM ou SIGINT : arrêt propre (les requêtes en cours finissent), code 0.

Vérifications : `cargo test --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked`
et `cargo clippy --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked --all-targets -- -D warnings`.

## Variables d'environnement

Lues comme `_env` de `memory_config.py` : une variable absente ou faite seulement de
blancs prend la valeur par défaut, et la valeur est trimée (sauf les deux jetons, lus
bruts).

| Variable | Défaut | Usage |
|---|---|---|
| `OMLX_BASE_URL` | `http://host.containers.internal:8000/v1` | base de l'API embeddings (`POST {base}/embeddings`) |
| `OMLX_EMBED_MODEL` | `bge-m3` | champ `model` de la requête d'embedding |
| `OMLX_API_TOKEN` | `not-needed` | `Authorization: Bearer` ; jamais imprimé |
| `OMLX_LLM_MODEL` | `qwen3-8b` | affiché au démarrage (servira à mem0-rs-extraction-llm) |
| `EMBEDDING_DIMS` | `1024` | dimension des vecteurs ; entier positif, sinon code 1 |
| `MEM0_DB_PATH` | `$HOME/.mem0/mem0-rs.db` | seul fichier de stockage ; dossier parent créé s'il manque |
| `MEM0_HTTP_TOKEN` | `""` | jeton exigé dans `X-Mem0-Token` ; vide = aucun contrôle ; jamais imprimé |
| `OMP_INSTALLATION_TOKEN` | `""` | ajouté à `GET /health` (`installation`) s'il est non vide |

Les variables `QDRANT_*` ne sont pas lues.

## Stockage

Un seul fichier SQLite, `MEM0_DB_PATH` (journal WAL : seuls `<db>-wal`, `<db>-shm`
et `<db>-journal` peuvent apparaître à côté) :

- `meta` : `schema_version` et `embedding_dims`. Relancer la base avec une autre
  `EMBEDDING_DIMS` est refusé (code 1), sans toucher au fichier.
- `memories` : les souvenirs (texte, hash md5, portée, rôle, étiquettes, dates) et
  leur vecteur creux BM25 (`sparse`, JSON `[[indice,poids],…]`).
- `memory_vec` (sqlite-vec, `vec0`) : le vecteur dense normalisé L2 en float32.
- `memory_terms` (FTS5) : les indices creux du souvenir en jetons `t<indice>` ;
  `memory_terms_vocab` (`fts5vocab`) en donne les fréquences documentaires.
- `history` : le schéma de mem0 (`storage.py`), révisions ADD, UPDATE et DELETE.

Chaque écriture calcule son embedding avant, puis écrit souvenir, vecteurs, termes et
historique dans une seule transaction. Aucun autre fichier n'est créé (ni
`~/.mem0/history.db`, ni journal sur disque). Retour arrière : supprimer le fichier.

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
   toute la base, puis sigmoïde dont `(midpoint, steepness)` dépend du nombre de mots
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

`GET /memory/graph` reproduit `graph_edges` de `http_server.py` : seuil 0.75,
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
| `reqwest` | client de l'API embeddings (rustls, sans openssl) |
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
