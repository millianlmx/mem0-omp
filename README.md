# mem0 pour OMP

Une mémoire persistante par projet, branchée nativement dans OMP. Rien d'autre.

```
mem0-omp/                              racine = marketplace OMP
├── .omp-plugin/marketplace.json       catalogue (repli : .claude-plugin/)
├── omp-mem0-memory/                   le plugin
│   ├── package.json                   déclare omp.extensions
│   ├── extension.ts                   tout est là, brief compris
│   └── install.sh                     installation manuelle, hors marketplace
├── mem0-stack/                        mem0 + Qdrant, en local
└── scripts/check.sh                   validation avant publication
```

## Ce que ça fait

| Quand | Quoi |
|---|---|
| Premier démarrage dans un dépôt | Pose le brief mémoire : écrit `.omp/mem0-brief.md` et ajoute un bloc dans `AGENTS.md` qui le cite. Une fois, tout seul. |
| Chaque tour | Cherche dans la mémoire du projet sur ton prompt brut, filtré par un plancher de score, et injecte le résultat silencieusement dans le même tour. Le sommaire exhaustif de la mémoire du projet part dans le prompt système : l'agent sait ce qui existe sans avoir à chercher. |
| Chaque `read` / `grep` / `glob` / `lsp` / `edit` / `write` | Le souvenir qui concerne les arguments de l'outil est posé en tête du résultat, sans appel réseau et sans amputer le résultat. Un même argument n'agrafe qu'une fois. |
| Fin de session | Si la session a modifié des fichiers sans rien écrire en mémoire, une relance unique demande à l'agent d'écrire ce qui sera encore vrai dans six mois. Aucune écriture automatique par extraction serveur. |
| À la demande | `mem0_search`, `mem0_add`, `mem0_update`, `mem0_forget`. |

## Installation

**1. Le service** — obligatoire, le plugin ne le déploie pas :

```bash
git clone https://github.com/millian/mem0-omp
cd mem0-omp/mem0-stack
cp .env.example .env        # ajuste OMLX_BASE_URL selon podman/docker
podman compose up -d        # ou: docker compose up -d
./doctor.sh
```

`doctor.sh` teste la chaîne complète — conteneurs, port, Qdrant, oMLX, puis un
aller-retour écriture/relecture — et dit quoi faire à chaque échec.

**2. Le plugin**, depuis une session OMP :

```
/marketplace add millian/mem0-omp
/marketplace install omp-mem0-memory@mem0-omp
```

Puis **relance `omp`** : `/reload-plugins` rafraîchit les commandes et les skills,
mais pas les modules d'extension. Ouvre une session dans un projet, `/mem0-status`.

Équivalents en ligne de commande :
`omp plugin marketplace add millian/mem0-omp` puis
`omp plugin install omp-mem0-memory@mem0-omp`. Ajoute `--scope project` pour
n'installer que sur le projet courant.

Sans marketplace, `omp-mem0-memory/install.sh` dépose l'extension dans
`~/.omp/agent/extensions/`, où OMP la découvre seule au démarrage.

Une seule fois, globalement. Il n'y a **rien à faire par projet** : le brief se pose
au premier démarrage dans chaque dépôt.

Sans le service, le plugin se charge et se dégrade proprement — recall vide,
écritures en warning, `/mem0-status` en rouge. Aucune session n'est bloquée.

Publication et mise à jour du dépôt : voir [PUBLISHING.md](PUBLISHING.md).

## Le brief

Deux niveaux, pour ne pas payer le texte complet à chaque tour :

- **Bloc dans `AGENTS.md`** (~20 lignes) — toujours en contexte. Dit quoi mémoriser
  (stack, décisions d'archi avec leur raison, conventions non écrites, bugs résolus,
  exigences incontournables, préférences), quoi ne pas mémoriser, et que le dépôt
  fait autorité contre un souvenir.
- **`.omp/mem0-brief.md`** — lu à la demande. Règles détaillées et exemples de bons
  et mauvais souvenirs.

### Provisionnement

L'extension vérifie à chaque `session_start` (mémoïsé : un seul passage par projet et
par process) que les deux existent et portent le marqueur de version courant.

Elle est volontairement conservatrice :

- **N'écrit jamais hors d'un dépôt.** Il faut un `.git` en remontant, ou un
  `AGENTS.md` déjà présent. `omp` lancé depuis `$HOME` ne touche à rien.
- **Ajoute sans écraser.** Un `AGENTS.md` existant est complété en fin de fichier.
- **Une version périmée est signalée, pas remplacée** — sinon une édition manuelle
  du brief se ferait effacer en silence. `/mem0-brief --update` est le seul chemin
  qui réécrit ; il remplace le bloc en place, sans toucher au reste du fichier.
- `MEM0_AUTOSETUP=0` désactive complètement l'écriture.

Édite `.omp/mem0-brief.md` comme tu veux : tant que le marqueur de version en tête
reste inchangé, il ne sera pas réécrit.

## Cloisonnement

La mémoire est scopée **par projet**. Le nom est déduit dans cet ordre :
`MEM0_PROJECT_ID` → `package.json` / `pyproject.toml` / `Cargo.toml` /
`Package.swift` / `*.xcodeproj` à la racine du dépôt → nom du dossier racine.

Deux projets ne doivent jamais résoudre vers le même nom, sinon leurs mémoires se
mélangent. `/mem0-status` affiche le nom résolu — vérifie-le une fois par projet.

Un second scope, `global`, sert aux préférences valables partout. Les deux sont
interrogés en parallèle au recall.

## Amorcer un projet déjà commencé

Sur un dépôt existant, la mémoire démarre vide : elle ne se remplira qu'au fil des
sessions. `/mem0-init` lui donne une base immédiatement.

```
/mem0-init                 amorçage complet
/mem0-init --scan-only     empreinte technique seule, sans solliciter le modèle
/mem0-init --force         réamorce un projet qui a déjà des souvenirs
```

Deux phases, séparées selon ce que chacune sait faire :

1. **Empreinte technique, lue sur disque.** Écosystème et dépendances, gestionnaire
   de paquets déduit du lockfile, fichiers de config outillage, CI, conteneurs,
   dossiers de premier niveau, branche courante. Écrit en `infer=false` : ce sont
   déjà des faits, les faire passer par le LLM d'extraction ne ferait que les
   paraphraser en perdant des détails. Instantané, exact, gratuit.
2. **Relecture guidée, confiée au modèle.** Un prompt injecté via `sendUserMessage`
   lui demande de lire README/AGENTS/CONTRIBUTING/docs, de regarder les 40 derniers
   commits, d'ouvrir deux ou trois fichiers du cœur du projet, puis d'enregistrer
   **12 souvenirs maximum** : objet du projet, décisions d'architecture avec leur
   raison, conventions réelles non documentées, contraintes non négociables, pièges
   connus. Avec la consigne explicite de ne rien enregistrer qu'il n'ait vérifié —
   un souvenir faux est rappelé avec la même autorité qu'un souvenir juste.

Si le projet a déjà des souvenirs, une confirmation est demandée avant de
réamorcer : les quasi-doublons ne sont pas toujours rattrapés par la fusion mem0 et
diluent le recall.

## Quand ça ne répond pas

`/mem0-status` en erreur avec « socket connection was closed unexpectedly » ne
veut pas dire que le service est absent : ça veut dire que le port est tenu par
le proxy du moteur de conteneurs pendant que le conteneur **redémarre en
boucle**. La connexion est acceptée puis fermée, au lieu d'un « connection
refused » franc.

```bash
cd mem0-stack && ./doctor.sh
podman logs --tail 80 mem0-http
podman compose up mem0-http        # sans -d : le traceback s'affiche
```

Deux vérifications marchent même quand le conteneur redémarre en boucle, parce
qu'elles n'ont besoin que de l'image :

```bash
podman run --rm mem0-stack-mem0-http:latest python memory_config.py   # config résolue
podman run --rm mem0-stack-mem0-http:latest python test_api.py        # conformité API mem0
```

Un `NameError` sur la première veut dire que le fichier embarqué diffère de
celui sur disque : `podman compose build --no-cache mem0-http`, puis `up -d`.

Ensuite, trois causes couvrent la quasi-totalité des cas :

- **oMLX injoignable depuis le conteneur.** Il tourne en natif sur le Mac ;
  `localhost` dans un conteneur désigne le conteneur. Podman veut
  `host.containers.internal`, Docker Desktop `host.docker.internal`. Vérifie
  aussi qu'oMLX écoute sur `0.0.0.0` et pas seulement `127.0.0.1`.
- **`EMBEDDING_DIMS` ne correspond pas au modèle.** La collection Qdrant est
  créée avec cette dimension au premier appel ; la changer ensuite fait rejeter
  toutes les écritures. Supprime `mem0-stack/qdrant_storage` pour repartir.
- **Premier démarrage lent.** L'import de `mem0ai` prend du temps ; le
  `start_period` du healthcheck est à 45 s pour cette raison.

Note sur les versions de mem0 : la 2.x a cassé l'API de la 1.x sans renommer
les méthodes. `from_config` est redevenu synchrone, `search`/`get_all` refusent
`user_id`/`agent_id` au premier niveau (il faut passer par `filters`), et
`limit` s'appelle `top_k`. Chacune de ces ruptures ne se manifeste qu'à
l'exécution de la route concernée, avec un `500`. D'où la borne `mem0ai<3.0`
dans le Dockerfile et `test_api.py`, exécuté **au build** : une rupture d'API
fait désormais échouer la construction de l'image, pas la première requête.

## Commandes

- `/mem0-status` — connexion, projet résolu, état du brief, nombre de souvenirs, et
  les compteurs de la session : tours, rappels non vides, explorations, agrafages,
  modifications, écritures mémoire, présence du sommaire.
- `/mem0-init` — amorce un projet existant (voir ci-dessus).
- `/mem0-brief` — état du brief. `--update` réécrit la version courante.
- `/mem0-dedupe` — repère les souvenirs redondants et supprime les moins informatifs.
  **Simulation par défaut, rien n'est écrit sans `--apply`.** L'aperçu est fait pour
  être vérifié avant d'écrire : une paire par bloc, avec son score de recouvrement,
  le texte **intégral** du souvenir voué à la suppression — c'est lui qu'on détruit,
  un id ne se relit pas — et les mots qu'il contient et que le souvenir conservé ne
  reprend pas. « perte : aucune » signifie que la suppression ne coûte aucun
  vocabulaire ; une liste de mots signifie qu'il faut regarder de près, voire
  fusionner à la main avec `mem0_update` plutôt que supprimer. Aucune paire n'est
  masquée. `--strict` ne traite que les recouvrements quasi totaux, `--scope global`
  cible la mémoire transverse. Avec `--apply`, le rapport liste les ids supprimés.
- `/mem0-save` — demande à l'agent d'écrire maintenant ce que la session a produit
  de durable, sans attendre la fin de session.

## Config

| Variable | Défaut | Rôle |
|---|---|---|
| `MEM0_HTTP_URL` | `http://localhost:8321` | URL du service |
| `MEM0_HTTP_TOKEN` | vide | envoyé en header `X-Mem0-Token` si défini côté serveur |
| `MEM0_PROJECT_ID` | — | force le nom de projet |
| `MEM0_AUTOSETUP` | `1` | `0` pour ne jamais écrire dans un dépôt |
| `OMLX_LLM_MODEL` | `qwen3-8b` | modèle d'extraction (dans `.env`) |
| `OMLX_EMBED_MODEL` | `bge-m3` | modèle d'embedding (dans `.env`) |

Le port est bindé sur `127.0.0.1` : accessible depuis le Mac, pas depuis le réseau.

## Changements par rapport à la v1

- **Brief posé automatiquement**, avec citation d'un fichier de référence, au lieu
  d'un bloc à recopier dans chaque projet.
- **`/mem0-init`** pour amorcer un dépôt existant, au lieu d'attendre que la mémoire
  se remplisse toute seule au fil des sessions.
- **Scope par projet.** Avant, `user_id` était constant et `agent_id` valait le
  profil OMP : tous les projets partageaient le même index, et le nom du projet
  n'était qu'un mot de plus dans la requête d'embedding — pas un filtre. C'est
  maintenant une cloison dure.
- **Timeouts par opération.** Le budget unique de 4 s s'appliquait aussi aux
  écritures, qui déclenchent deux passes LLM locales (10 à 60 s). Elles échouaient
  toutes, silencieusement, au moment où la session se fermait. Lecture 3 s,
  écriture 120 s.
- **Plus d'écriture automatique.** Avant : le segment de conversation partait vers
  mem0 toutes les 3 questions avec `infer=true`. Sur 38 souvenirs, 26 venaient de là
  et étaient inexploitables — hallucinations grand public et paraphrases creuses. La
  cause est dans mem0 2.0.20 : `custom_fact_extraction_prompt` est du config mort, le
  chemin réel est un prompt grand public non remplaçable. Maintenant, c'est l'agent
  qui écrit, avec une relance unique en fin de session quand la session a modifié des
  fichiers sans rien mémoriser.
- **Rappel sur le prompt brut, avec plancher de score.** Le gabarit qui enveloppait
  la demande annulait son pouvoir discriminant : le gabarit seul sortait un top-1 plus
  haut que n'importe quelle vraie question. Le `threshold` de mem0 est maintenant
  exposé par le service et envoyé à chaque rappel.
- **Sommaire exhaustif dans le prompt système**, plus agrafage d'un souvenir aux
  résultats de `read`/`grep`/`glob`/`lsp`/`edit`/`write` : la mémoire arrive dans la
  sortie que l'agent lit de toute façon, au lieu de dépendre d'une consigne.
- **Recherche hybride réellement active.** L'image installe `fastembed`, donc mem0
  écrit le vecteur creux BM25 et les identifiants exacts (`EMBEDDING_DIMS`) se
  retrouvent : rang 1 au lieu d'absent du top 8.
- **Clé de session stable** au lieu d'un `WeakSet` sur l'objet `ctx`, qui pouvait
  faire partir le recall à chaque tour ou jamais selon la version d'OMP.
- **Quatre tools au lieu de cinq**, avec des descriptions qui disent *quand* les
  utiliser. `mem0_add` couvre faits et procédures via `kind`, et déduplique lui-même :
  score vectoriel pour « même sujet », recouvrement lexical pour « n'apporte rien de
  plus ». Sans recouvrement, pas de fusion — quel que soit le score.
- **Les prompts d'extraction du serveur ont été retirés** : en mem0 2.0.20,
  `custom_fact_extraction_prompt` et `custom_update_memory_prompt` n'ont aucun
  appelant. Seul `custom_instructions` est réellement injecté, et il ne sert plus qu'à
  l'échappatoire `mem0_add(infer: true)`.
- Plus de couche MCP stdio (`server.py`). Si un autre client en a besoin, reprends-la
  telle quelle depuis l'ancien zip.
- Plus de pipeline.

## À vérifier contre ta version d'OMP

L'API d'extension bouge vite. Trois points, tous signalés par un warning plutôt que
par une erreur :

- `event.prompt` sur `before_agent_start`, et la forme du retour
  `{ message: { customType, content, display, attribution } }`.
- `event.systemPrompt` (`string[]`) et `event.content` / `event.input` /
  `event.isError` sur `tool_result` — c'est par là que passent le sommaire et
  l'agrafage. Un retour de `tool_result` REMPLACE le contenu du résultat : le handler
  reconstruit toujours `[bloc mémoire, ...event.content]`.
- `SessionStopEventResult` (`{ continue, additionalContext }`) pour la relance de fin
  de session ; le runtime plafonne les continuations, et l'extension n'en demande
  qu'une par session.
- `pi.zod` : depuis la v17.2.10, zod est remplacé par `omptype` avec une façade de
  compatibilité. L'usage ici est basique et devrait passer ; si un `registerTool`
  échoue au chargement, c'est le premier endroit à regarder.
- `pi.sendUserMessage(content)` et `ctx.waitForIdle()`, utilisés par `/mem0-init`.
  Si la relecture ne démarre pas, `/mem0-init --scan-only` reste utilisable et tu
  peux coller le prompt à la main.

L'event `session_start` n'est pas critique : si ta version ne l'émet pas, le premier
`before_agent_start` fait la même vérification.

Test de bout en bout, une minute : ouvre une session dans un projet, vérifie que
`.omp/mem0-brief.md` et le bloc `AGENTS.md` sont apparus, dis « note que le linter de
ce projet est Ruff » — l'agent doit appeler `mem0_add` — puis `/mem0-status` doit
compter une écriture mémoire. Nouvelle session : demande quel linter tu utilises ; la
réponse doit venir du rappel, sans lecture de fichier.
