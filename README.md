# mem0 pour OMP

Une mémoire persistante par projet, branchée nativement dans OMP. Rien d'autre.

```
mem0-omp/                              racine = marketplace OMP
├── .omp-plugin/marketplace.json       catalogue (repli : .claude-plugin/)
├── omp-mem0-memory/                   le plugin mémoire
│   ├── package.json                   déclare omp.extensions
│   ├── extension.ts                   entrée : câblage et réexports
│   ├── mem0Client.ts, recall.ts, summary.ts, attach.ts, brief.ts, bootstrap.ts,
│   │   dedupe.ts, checkpoint.ts, phases.ts, state.ts, write.ts, config.ts,
│   │   tools.ts, commands.ts, purge.ts
│   │                                  les modules (un par responsabilité)
│   └── install.sh                     installation manuelle, hors marketplace
├── omp-mem0-req/                      le plugin des pipelines : client du harness (/req, /project, /audit, /pipelines)
│   ├── package.json
│   ├── extension.ts                   entrée : commandes, outils harness_launch et harness_project
│   └── harness.ts                     cible (HARNESS_URL, ~/.omp/harness.json), appels REST, résumés
├── omp-console/                       la coque macOS (SwiftUI), le noyau partagé et l'app iOS
│   └── ios/                           le projet Xcode de l'app iOS (coque-ios)
├── omp-harness/                       le Pipeline Service sur VPS : SQLite, runners OMP en RPC, heavy systemd
│   └── deploy/                        unités et tranches systemd, zram, oomd, lanceur root, install.sh
├── mem0-stack/                        mem0-rs (binaire Rust + SQLite), la voie MANUELLE
│   ├── mem0-rs/                       le serveur Rust mem0-rs (crate)
│   └── README.md                      démarrer, migrer une pile mem0-http existante, retour arrière
├── CHANGELOG.md                       journal des versions, écrit par le job de release
├── package.json                       privé, sans dépendance : npm run check, npm run typecheck, npm test
├── test/                              suite node --test
├── scripts/check.sh                   validation avant publication
├── scripts/test-files.sh              liste des fichiers de test : tous, macOS (--scope=macos), du diff (--scope=changed), outillage
├── scripts/test-ac.sh                 preuve par critère : tests du diff portant AC-n, une passe node --test, pass|fail|absent
├── scripts/ci-verdict.sh              verdict de l'agrégateur check (macos-latest) sur les jobs macOS
├── scripts/tests-instables-connus.json   tests Swift instables connus, relancés une fois par swift-app.sh
├── scripts/typecheck.sh               type-check des deux plugins et de test/ par le tsc épinglé de .typecheck/ (--prepare l'installe)
├── scripts/plugin-smoke.ts            charge les plugins dans un vrai OMP
├── scripts/swift-app.sh               suite release puis bundle .app de la coque SwiftUI
├── scripts/ios-build.sh               compile et teste l'app iOS, seul chemin du dépôt qui exige Xcode
├── scripts/app-icon.sh                dessine l'icône d'OMP Console et réécrit ses fichiers versionnés iOS et Mac
├── scripts/run-console.sh             recompiler vite et relancer OMP Console (hooks git fournis)
├── scripts/recette/                  recettes manuelles au simulateur et sur le Mac (jamais lancées par check.sh ni la CI)
├── scripts/omp-console-api.ts         sonde CLI de l'API distante d'OMP Console (appairage, état, mémoire, flux)
├── scripts/mem0-http-contrat.sh       contrat HTTP boîte noire des 9 routes (prépare la Qdrant d'import, lance, démarre mem0-rs ou son conteneur)
├── scripts/mem0-http-contrat/         lanceur, cas, formes et faux serveur OpenAI du contrat
├── scripts/release.ts                 PR de release auto-mergée, tags et releases au merge
├── scripts/no-manual-bump.sh          refuse un bump de version manuel dans une PR
├── scripts/release-simulation.sh      simule la release d'une PR sur une copie jetable
└── .github/workflows/                 check.yml (PR), release-simulation.yml (PR), release.yml (merge sur main)
```

Le harness VPS (`omp-harness/`) a lui aussi son document, `omp-harness/README.md`.
C'est le seul moteur des pipelines : il conduit chaque feature de /req au merge avec
des runners OMP enfants (`omp --mode rpc`), plafonnés par systemd. Ce qui n'est pas
tranché, il le décide seul par checkpoints WIP. L'irréversible, il le batche pour
l'humain. Le plugin `omp-mem0-req` et OMP Console en sont les clients.

La coque macOS (`omp-console/`, SwiftUI) a son propre document :
`omp-console/README.md` explique comment la builder, la tester, assembler son
bundle `.app` et ouvrir l'app — il documente aussi l'app iOS, dont le projet Xcode
vit sous `omp-console/ios/`. C'est l'app unique : elle installe elle-même son
`omp` 18.6.0 et sert la mémoire par le `mem0-rs` natif embarqué dans son bundle,
lancé par un agent launchd (`com.omp.console.mem0-rs`) sur `127.0.0.1:8321` —
plus de machine podman ni de conteneurs. L'agent survit à la fermeture de l'app
et launchd le relance s'il meurt. Sur un poste qui faisait tourner l'ancienne
pile podman de l'app, la préparation reprend une seule fois ses souvenirs
(`mem0-rs import` depuis son Qdrant, `127.0.0.1:6333`, AVANT d'arrêter ses
conteneurs), sans jamais modifier la source ; un bandeau propose ensuite, sur
confirmation, de supprimer l'ancien moteur. `GET /health` garde la même adresse
et le plugin mémoire garde son contrat (`health.ok`) : le service de l'app y
ajoute seulement un champ **additif** `installation` (le jeton de
l'installation). `mem0-stack/` (ci-dessus) reste la voie MANUELLE, intacte, que
l'app ne modifie pas.

## Ce que ça fait

| Quand | Quoi |
|---|---|
| Premier démarrage dans un dépôt | Pose le brief mémoire : écrit `.omp/mem0-brief.md` et ajoute un bloc dans `AGENTS.md` qui le cite. Une fois, tout seul. |
| Chaque tour | Cherche dans la mémoire du projet sur ton prompt brut, filtré par un plancher de score, et injecte le résultat silencieusement dans le même tour. Le sommaire de la mémoire du projet part dans le prompt système — exhaustif tant qu'il n'est pas tronqué (60 entrées), au-delà de quoi il dit lui-même ce qui manque et invite à `mem0_search`. |
| Chaque `read` / `grep` / `glob` / `lsp` / `edit` / `write` | Le souvenir qui concerne les arguments de l'outil est posé en tête du résultat, sans appel réseau et sans amputer le résultat. Un même argument n'agrafe qu'une fois. |
| Fin de session | Si la session a produit du durable sans rien écrire en mémoire — fichiers modifiés, **ou** discussion substantielle sans édition (needs, specs, archi) — une relance unique demande à l'agent d'écrire ce qui sera encore vrai dans six mois. Aucune écriture automatique par extraction serveur. |
| À la demande | `mem0_search`, `mem0_add`, `mem0_update`, `mem0_forget`. |

## Installation

Trois voies, de la plus intégrée à la plus légère. Aucune n'impose de conteneur :
le plugin mémoire n'a besoin que d'un service qui réponde à `MEM0_HTTP_URL`
(`http://localhost:8321` par défaut), et sans service il se dégrade sans bloquer.

Publication et mise à jour du dépôt : voir [PUBLISHING.md](PUBLISHING.md).

### 1. L'app OMP Console

Sur un Mac Apple Silicon, l'app OMP Console fournit le service mémoire sans rien
à taper : elle installe elle-même son `omp` et démarre au premier lancement son
`mem0-rs` natif, embarqué dans son bundle (agent launchd `com.omp.console.mem0-rs`,
`127.0.0.1:8321`). L'assembler, l'ouvrir et la préparer :
[omp-console/README.md](omp-console/README.md).

L'app n'installe pas les plugins : installe-les ensuite par la voie 3, « Les
plugins seuls ». Le service mémoire de l'app répond déjà à l'adresse par défaut du
plugin mémoire, et ses pipelines sont celles du harness du VPS.

### 2. À la main, avec la pile conteneur

Sans l'app — autre machine, autre système : le service mémoire tourne dans un
conteneur que tu démarres toi-même ; les plugins ne le déploient pas.

```bash
git clone https://github.com/millianlmx/mem0-omp
cd mem0-omp/mem0-stack
cp .env.example .env        # ajuste OMLX_BASE_URL selon podman/docker
mkdir -p mem0-rs-data       # dossier de la base SQLite (MEM0_RS_DATA_DIR)
podman compose up -d        # ou: docker compose up -d
./doctor.sh
```

`doctor.sh` teste la chaîne complète — conteneur, port, oMLX, aller-retour
écriture/relecture, ancienne mémoire — et dit quoi faire à chaque échec.

Une pile mem0-http existante se migre AVANT de démarrer la nouvelle : import
d'abord, arrêt de l'ancienne ensuite. La procédure et son retour arrière sont dans
[mem0-stack/README.md](mem0-stack/README.md#migrer-une-pile-mem0-http-existante).

Installe ensuite les plugins par la voie 3.

### 3. Les plugins seuls

Depuis une session OMP :

```
/marketplace add millianlmx/mem0-omp
/marketplace install omp-mem0-memory@mem0-omp
/marketplace install omp-mem0-req@mem0-omp
```

Puis **relance `omp`** : `/reload-plugins` rafraîchit les commandes et les skills,
mais pas les modules d'extension. Ouvre une session dans un projet, `/mem0-status`.

Équivalents en ligne de commande :
`omp plugin marketplace add millianlmx/mem0-omp` puis
`omp plugin install omp-mem0-memory@mem0-omp` et
`omp plugin install omp-mem0-req@mem0-omp`. Ajoute `--scope project` pour
n'installer que sur le projet courant. Les deux plugins sont indépendants :
l'ordre d'installation n'a pas d'importance.

Sans marketplace, `omp-mem0-memory/install.sh` dépose l'extension dans
`~/.omp/agent/extensions/`, où OMP la découvre seule au démarrage.

Une seule fois, globalement. Il n'y a **rien à faire par projet** : le brief se pose
au premier démarrage dans chaque dépôt.

Le plugin mémoire parle au service de `MEM0_HTTP_URL` (voir « Config ») :

- **Service déjà joignable** — celui de l'app OMP Console (voie 1), une pile
  démarrée à la main (voie 2) ou tout autre service à cette adresse : rien de plus
  à faire, `/mem0-status` le vérifie.
- **Aucun service** — le plugin se charge et se dégrade proprement : recall vide,
  écritures en warning, `/mem0-status` en rouge. Aucune session n'est bloquée.

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
podman logs --tail 80 mem0-rs
podman compose up mem0-rs          # sans -d : l'erreur de démarrage s'affiche
```

Ensuite, deux causes couvrent la quasi-totalité des cas :

- **oMLX injoignable depuis le conteneur.** Il tourne en natif sur le Mac ;
  `localhost` dans un conteneur désigne le conteneur. Podman veut
  `host.containers.internal`, Docker Desktop `host.docker.internal`. Vérifie
  aussi qu'oMLX écoute sur `0.0.0.0` et pas seulement `127.0.0.1`.
- **`EMBEDDING_DIMS` ne correspond pas au modèle.** La dimension est inscrite
  dans la base au premier démarrage ; une base créée avec une autre dimension est
  refusée au démarrage par mem0-rs, qui sort en erreur et redémarre en boucle.

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
- `/mem0-purge-procedures` — liste les souvenirs **procéduraux** du projet, c'est-à-dire
  ceux dont la métadonnée porte `memory_type = "procedural_memory"` (écrits par
  `mem0_add kind:"procedure"` avant que le serveur ne stocke ce texte mot pour mot).
  **Simulation par défaut, rien n'est supprimé sans `--apply`.** L'aperçu montre l'id
  et le **texte intégral** de chaque procédural — c'est lui qu'on détruit, un id ne se
  relit pas — et dit combien de lignes de la scope sont visées au total. `--apply`
  supprime la liste entière, **sans exception ni moyen d'épargner un souvenir**, et le
  rapport cite les ids supprimés ; **aucun fichier de trace n'est écrit**, le rapport
  affiché est la seule trace. Les procéduraux sans id utilisable sont annoncés mais non
  supprimables (le `DELETE` est unitaire), et seule la scope du projet est visée : la
  mémoire transverse n'est jamais touchée ici.
- `/mem0-save` — demande à l'agent d'écrire maintenant ce que la session a produit
  de durable, sans attendre la fin de session.
- `/add-phase NOM BRIEF` — enregistre une phase et le rôle d'agent associé.
- `/set-phase NOM` — active une phase pour la session (`--default` réinitialise le registry).
- `/remove-phase NOM` — désenregistre une phase.
- `/req`, `/project`, `/audit`, `/pipelines` (plugin `omp-mem0-req`) — les pipelines,
  conduites par le harness du VPS : voir « Pipelines » ci-dessous.

## Pipelines

Le plugin `omp-mem0-req` est un **client du harness** (`omp-harness/`, le Pipeline
Service du VPS), seul moteur des pipelines : rien ne tourne en local. Le serveur
conduit chaque feature de /specs au merge avec des runners OMP enfants, décide seul ce
qui est réversible (checkpoints) et réserve à l'humain l'irréversible, la validation
des specs et les verdicts. Son fonctionnement, son API et son installation :
[omp-harness/README.md](omp-harness/README.md).

| Commande | Ce qu'elle fait |
|---|---|
| `/req [demande]` | Cerne les **besoins** avec toi, dans la session (questions `ask`, une à la fois), sans concevoir la solution. Une fois le compte rendu validé (`## Besoins`, `## Hors périmètre`, `## Contraintes`), l'outil `harness_launch` crée la feature sur le serveur, qui part de /specs. |
| `/project [description]` | Cerne le projet avec toi, le découpe en features autonomes (avec leurs modules quand ils sont connus), puis l'outil `harness_project` le crée : les features aux modules disjoints tournent en parallèle, chacune est mergée dès sa validation. |
| `/audit [focus]` | Lance un **audit** du dépôt sur le serveur (lecture seule de `main`). `/audit liste` montre les propositions numérotées, `/audit lancer <id> 1,3` part en projet avec celles retenues. |
| `/pipelines` | Résume la boîte de l'humain : escalades, specs et verdicts à valider, décisions à relire, features en cours, audits à trier. |

`harness_launch` et `harness_project` demandent ton accord à chaque appel, même en
mode yolo : seule une politique `deny` l'emporte. Les gestes de la boucle humaine
(répondre aux escalades, valider les specs et les verdicts, renverser une décision)
se font dans OMP Console, sur Mac ou sur iPhone.

**Configuration.** `HARNESS_URL` et `HARNESS_TOKEN` (le jeton de
`/var/lib/omp-harness/state/token`), ou `~/.omp/harness.json` :

```json
{ "url": "https://vps.example.ts.net", "token": "…", "repos": { "/Users/moi/code/demo": "demo" } }
```

Le dépôt visé est le **nom** déclaré dans la configuration du harness :
`HARNESS_REPO`, sinon l'entrée `repos` de la racine git courante, sinon le nom de ce
dossier. Sans configuration, chaque commande le dit et n'envoie rien.

## Phases

Une **phase** est un rôle nommé qu'on active sur une session (par exemple `release`,
`deploy`). Elle automatise la lecture mémoire en fin de session :

- `/add-phase release "release manager : bump + changelog + tag"` enregistre la phase
  (registry global, persisté dans `~/.omp/agent/phases.json`, rechargé au démarrage).
- `/set-phase release` l'active pour la session courante.
- Quand l'agent rend la main (`session_stop`, phase terminée), l'extension cherche en
  mémoire les instructions de la phase — recherche hybride sur le rôle de la phase, pas
  sur des mots-clés collés à la requête — et **les présente à l'agent** pour qu'il les
  applique avec ses propres outils (édition, `bash`/`git`), sous les gardes d'approbation.
  L'extension n'édite jamais de fichier elle-même.
- Si aucune instruction exécutable n'est trouvée, elle invite à en enregistrer une avec
  `mem0_add` (`… — RUN: …`) pour la prochaine fin de phase.

La phase `review` est pré-enregistrée dans les valeurs par défaut (avec `release`,
`version-bump`, `deploy`). Elle s'active par `/set-phase review`. La revue d'une
feature de pipeline, elle, est l'étape /review que le harness du VPS conduit.
Le déclenchement est **borné à une fois par session** et protégé contre les relances
(`stop_hook_active`) : la session se termine normalement. Une relance de ta part (nouveau
message) n'est pas une fin de phase et ne déclenche rien.

## Config

| Variable | Défaut | Rôle |
|---|---|---|
| `MEM0_HTTP_URL` | `http://localhost:8321` | URL du service |
| `MEM0_HTTP_TOKEN` | vide | envoyé en header `X-Mem0-Token` si défini côté serveur |
| `MEM0_PROJECT_ID` | — | force le nom de projet |
| `HARNESS_URL`, `HARNESS_TOKEN` | — | le harness du VPS et son jeton (plugin `omp-mem0-req`) ; à défaut, `~/.omp/harness.json` |
| `HARNESS_REPO` | nom de la racine git | le nom du dépôt déclaré sur le harness |
| `MEM0_AUTOSETUP` | `1` | `0` pour ne jamais écrire dans un dépôt |
| `MEM0_QUIET` | `0` | `1` pour réinjecter les souvenirs sans les afficher dans le transcript |
| `MEM0_NUDGE` | `1` | `0` coupe la relance d'écriture de fin de session (les runners du harness : la mémoire y est tenue par le service) |
| `OMLX_LLM_MODEL` | `qwen3-8b` | modèle d'extraction (dans `.env`) |
| `OMLX_EMBED_MODEL` | `bge-m3` | modèle d'embedding (dans `.env`) |

Le port est bindé sur `127.0.0.1` : accessible depuis le Mac, pas depuis le réseau.
Quand c'est la pile de l'app qui sert cette adresse, `GET /health` porte en plus un
champ **additif** `installation` (le jeton d'installation) : le protocole et les
autres champs sont inchangés, le contrat du plugin mémoire (`health.ok` seul) ne
change pas, et la voie manuelle `mem0-stack/` garde son `/health` identique.

## Tests et scripts

La suite node vit dans `test/`, rangée par **ce qu'elle éprouve** ; un fichier =
une feature (son slug), et un id `<slug>/AC-<n>` ne vit que dans un test
(`criteria/AC-13`) :

| Dossier | Ce qu'il éprouve |
|---|---|
| `test/memoire/` | le plugin `omp-mem0-memory` (rappel, brief, outils mem0) |
| `test/req/` | le plugin `omp-mem0-req`, client du harness |
| `test/harness/` | le harness du VPS : machine à états, orchestrateur, API, heavy, git, déploiement |
| `test/console/` | les sources d'OMP Console — gardes textuelles Mac et iOS (`ios-*`), noyau partagé, coque iOS |
| `test/stack/` | `mem0-stack` : mem0-rs, contrat boîte noire, migration, `doctor.sh` |
| `test/outillage/` | l'outillage du dépôt : `check.sh`, CI, release, smoke des plugins, documentation |
| `test/support/` | les modules partagés, jamais lancés seuls (pas de `.test.ts`) : `repo.ts` (racine, liste des tests, dossiers jetables, copie du dépôt, environnement des enfants), `git.ts` (dépôts git jetables), `spawn.ts` (processus enfants en parallèle), `swift-source.ts` (sources Swift sans commentaires, lexer de littéraux), `harness-fixtures.ts` et `fake-omp-rpc.ts` (harness complet aux runners factices), `fake-zod.ts`, `doctor-banc.ts` |

Un test neuf va dans le dossier de ce qu'il éprouve, sans liste à tenir :
`scripts/test-files.sh` les découvre récursivement. Un helper utile à plusieurs
fichiers va dans `test/support/`, jamais recopié d'un fichier à l'autre.

```bash
npm test                                                        # = bash scripts/check.sh --sections=tests (section ── Tests)
node --test --experimental-strip-types 'test/**/*.test.ts'      # toute la suite
node --test --experimental-strip-types test/req/client-harness.test.ts   # un fichier
bash scripts/test-files.sh --scope=changed | xargs node --test --experimental-strip-types   # les tests du diff
bash scripts/test-ac.sh AC-1 AC-2                                # preuve par critère
```

`scripts/test-files.sh --scope=changed[=<base>]` (base `HEAD`) retient : les
`test/**/*.test.ts` du diff (`git diff --name-only` + non suivis), tout test dont le texte nomme un fichier
source du diff (`chain.ts` ou `/chain"`), et les tests `--scope=macos` si le diff touche
`omp-console/`. Sans git, base inconnue ou diff vide : message sur stderr et liste complète
hors outillage — jamais une liste vide silencieuse. `--scope=outillage` liste les fichiers
qui relancent un `check.sh` complet (`check.test.ts`, `release.test.ts`,
`release-simulation.test.ts`, règle par contenu) : `--scope=changed` ne les inclut jamais,
`check.sh` sans option les lance toujours.

`scripts/test-ac.sh [--base=<rev>] AC-1 AC-2 …` : pour chaque id, imprime les fichiers de
test **du diff** qui le portent (`AC-1` ≠ `AC-10`) ou `(aucun test dans le diff)`, lance
**une** passe `node --test --test-reporter=tap` sur ces fichiers, puis `AC-n : pass|fail|absent`
(nom de test portant l'id ; un test sauté ne prouve rien) ; sortie 1 dès un `fail` ou un
`absent`.

Les tests de `test/console/` partagent une copie du dépôt par fichier
(`sharedRepo(prefix).fresh()` dans `test/support/repo.ts`, remise à neuf en ≈ 10 ms) au lieu
d'une copie par test. `check.sh` imprime `# skipped N` dans `── Tests`, en succès comme en
échec. Un test qui se saute faute de prérequis installable (outil, toolchain, script
absent) passe par `prerequisAbsent(t, prérequis, conséquence)` de `test/support/prerequis.ts`,
jamais par un `t.skip` nu : c'est ce saut que `--strict` change en échec nommé.

`scripts/` ne garde à sa racine que ce que la CI, la release et le développement
lancent (`check.sh`, `test-files.sh`, `typecheck.sh`, `release.ts`,
`swift-app.sh`, `ios-build.sh`, `run-console.sh`, `mem0-http-contrat.sh`…) ; les
recettes manuelles ou gatées (captures iOS, sondes AX, appairage, bascule réelle)
vivent dans `scripts/recette/`.

## CI et release

Chaque PR passe `./scripts/check.sh` sur Ubuntu **et** sur macOS. Le type-check y
couvre les sources des **deux** plugins comme `test/` — deux programmes `tsc` :
`tsconfig.json` pour les plugins (lib ES2023, donc une API ES2024 comme
`Promise.withResolvers` y fait échouer le job) et `tsconfig.test.json` pour la
suite (lib ES2024). Les deux programmes appliquent `strict`, `noUnusedLocals`,
`noUnusedParameters` et `noFallthroughCasesInSwitch` : une variable, un import ou
un paramètre jamais lu (préfixe `_` pour un paramètre imposé par une signature)
et un `case` non vide qui retombe dans le suivant font échouer le job. Ce `tsc`
est TypeScript 5.9.3, installé une fois dans `.typecheck/typescript` (gitignoré)
par `bash scripts/typecheck.sh --prepare` (réseau requis) ; ensuite le type-check
ne touche ni au réseau ni au cache npm. Absent ou d'une autre version, la section
Types rougit en donnant cette commande. La CI la lance avant `check.sh` (étape
« Installer le TypeScript épinglé du type-check ») dans `check`, `macos-tests`,
`release` et `release-simulation`. La validation ne se contente pas de
transpiler les extensions : `scripts/plugin-smoke.ts` charge
**réellement** chaque plugin du catalogue dans un OMP (SDK épinglé sous Bun),
vérifie les commandes enregistrées, invoque `/mem0-status` puis l'outil
`mem0_search` d'un côté, `/req` de l'autre, et exige le résultat observé — le
service mem0 étant remplacé par un stub local, donc sans conteneur ni credential.
Un plugin qui ne répond pas fait échouer le job, et `main` exige ces deux statuts
ainsi que `release-simulation` : le merge est bloqué.

Sur Ubuntu, le job `check` lance `./scripts/check.sh --strict` : ses 12
sections et toute la suite node, à chaque run. Sur macOS, le contrôle est éclaté en
jobs **parallèles**, sur des runners distincts et sans `needs` entre eux : `macos-app-swift`
(`--sections=app-swift`), `macos-app-ios` (`--sections=app-ios`) et `macos-tests (1/2)`,
`macos-tests (2/2)`, qui se partagent la suite node. Dans `macos-app-swift`, quand
`swift test` échoue, `scripts/swift-app.sh` lit les tests tombés. S'ils figurent TOUS
au registre `scripts/tests-instables-connus.json` (consulté par
`scripts/ci-verdict.sh --instables`), il les relance une seule fois
(`swift test --filter`) en les nommant. Tout autre échec reste rouge sans relance :
test non listé, rouge pendant la relance, erreur de compilation, plantage, sortie
illisible ou interruption. Le statut `check (macos-latest)`
est celui d'un job **agrégateur** qui les attend, tourne même quand l'un d'eux
échoue ou est annulé (`if: always()`), et ne réussit que si les trois résultats
valent `success` (`scripts/ci-verdict.sh`) — jamais « skipped », qui compterait
comme passant. En pull_request, les jobs macOS ne lancent que les fichiers de test
qui appellent swift ou xcodebuild (`scripts/test-files.sh --scope=macos` : nom en
`ios-*`, ou mention de `swift`, `swiftc`, `xcodebuild`, `xcrun`, `swift-app.sh` ou
`ios-build.sh`) — un fichier nouveau est classé sans liste à tenir ; la suite
complète tourne déjà sur Ubuntu. Au push vers `main`, macOS relance la suite
complète. Un nouveau commit sur une PR annule le run `check` en cours de cette PR ;
un run déclenché par un push vers `main` n'est jamais annulé.

**Caches de la CI.** Les jobs qui installent ou compilent restaurent un cache
`actions/cache@v6` avant `check.sh` : `check` et `macos-tests` le cache npm
`~/.npm` (hôte OMP) et le cache cargo (`~/.cargo/registry/index`,
`~/.cargo/registry/cache`, `~/.cargo/git/db` et `mem0-stack/mem0-rs/target`) —
dans `macos-tests`, cargo pour la partie 1/2 et au push vers `main`, plus le
scratch SwiftPM `omp-console/.build-node` pour la partie 1/2 ; `macos-app-swift`
le cache cargo (cible release de `swift-app.sh`) et `omp-console/.build-app` ;
`release-simulation` le cache cargo. L'agrégateur `check (macos-latest)` ne cache
rien, `macos-app-ios` non plus : mesuré, un DerivedData `omp-console/.build-ios`
restauré ne fait rien gagner (xcodebuild recompile tout, car les mtimes du checkout
l'invalident, et le démarrage des tests sur simulateur pèse ~235 s). Chaque clé porte
la famille, le job, l'entrée de matrice, l'OS, l'architecture, une empreinte de
la toolchain (version de Node, `rustc -vV`, Swift et Xcode, calculée par l'étape
« Empreinte des toolchains ») et le contenu : hash de `Cargo.lock` et
`Cargo.toml`, de `Package.swift`, ou
la version de l'hôte (`OMP_HOST_VERSION` et `OMP_HOST_TYPES_NODE`, déclarées une
seule fois dans l'`env:` de `check.yml`). Il n'y a pas de `restore-keys` : une
clé changée repart de zéro. Seul un job vert sauvegarde, une PR n'écrit que dans
sa propre portée (elle lit celle de `main`), et aucune commande n'est sautée sur
un cache chaud — `npm install`, cargo et `swift` sont toujours
rejoués et ne réutilisent que ce qui est encore à jour, donc le verdict est celui
d'un run à froid. Côté npm, seul le cache de contenu `~/.npm` est gardé, jamais
`node_modules` : l'hôte s'installe sans lockfile, et un arbre restauré qui
satisfait déjà les plages figerait des dépendances transitives qu'un run à froid
mettrait à jour. Dans `release-simulation`, la copie jetable change de chemin à
chaque run : l'étape de simulation pose `CARGO_TARGET_DIR` sur
`${{ runner.temp }}/cargo-target`, cible stable que le cache restaure et que
`check.sh`, `swift-app.sh` et les tests `test/stack/*` honorent.

Ces jobs pilotent `check.sh` par quatre options, que l'on peut aussi passer en
local — sans option, toutes les sections et toute la suite tournent :

| Option | Effet |
|---|---|
| `--sections=<id>[,<id>…]` | n'exécute que ces sections, dans l'ordre du script : `catalogue`, `noms`, `plugins`, `versions`, `extension`, `types`, `rust`, `smoke`, `tests`, `noyau`, `app-swift`, `app-ios` |
| `--tests-scope=macos` | `── Tests` ne lance que les fichiers de `scripts/test-files.sh --scope=macos` |
| `--tests-part=1/2` ou `2/2` | `1/2` : les tests `socle-app-swift/*` de `test/outillage/check.test.ts` ; `2/2` : tous les autres — chaque test tourne exactement une fois |
| `--strict` | un test de `test/` sauté faute de prérequis installable (`prerequisAbsent` de `test/support/prerequis.ts`) et les absences que `MEM0_OMP_REQUIRE_SMOKE`/`RUST`/`IOS` durciraient deviennent des échecs nommés ; restent des sauts : plateforme (Swift/iOS hors macOS), copie imbriquée, `MEM0_OMP_SKIP_*` |

À la racine du dépôt, `package.json` (privé, sans dépendance) donne trois alias :
`npm run check` lance `bash scripts/check.sh`, `npm run typecheck` lance
`bash scripts/typecheck.sh` et `npm test` lance `bash scripts/check.sh --sections=tests`.
Les arguments placés après `--` sont transmis tels quels (`npm run check -- --sections=types`,
`npm test -- --tests-part=1/2`) ; `npm test -- --sections=…` est refusé par `check.sh`
(option répétée). Depuis `omp-mem0-req/` ou `omp-mem0-memory/`, npm lit le
`package.json` du plugin, qui n'a pas ces alias.

Chaque PR vers `main` passe aussi `scripts/release-simulation.sh`, qui rejoue la
release de la PR **sur une copie jetable** — plan de `scripts/release.ts`,
écriture des versions, des deux catalogues et de `CHANGELOG.md`, puis
`./scripts/check.sh` — sans rien pousser, sans tag et sans PR. Son statut,
`release-simulation`, est requis : une PR dont la release simulée échouerait ne
peut pas être fusionnée.

La section `── Rust mem0-rs` joue le **contrat boîte noire** de l'API mémoire
(`scripts/mem0-http-contrat.sh --run`) contre mem0-rs : il exerce par HTTP les 9 routes du
serveur (`/health`, add, add_procedure, search, all, graph, PUT, DELETE, history)
et vérifie pour chaque réponse le jeu de clés exact et le type des valeurs. Le
serveur à tester est démarré jetable, sans conteneur : le binaire mem0-rs
(`--start-rs`) sur une base SQLite neuve, et un faux serveur OpenAI-compatible
(embeddings déterministes de 1024 dimensions, réponses chat scriptées), donc ni
oMLX ni la base réelle. Une Qdrant **native** v1.19.0 ne sert plus que de source
aux tests de `mem0-rs import` : elle se prépare une fois, hors du dépôt, par
`bash scripts/mem0-http-contrat.sh --prepare` ; sans elle, ces tests annoncent le
saut en nommant la pièce manquante. La CI la prépare avant `check.sh` (étape
« Préparer la Qdrant source des tests d'import mem0-rs ») et pose
`MEM0_OMP_REQUIRE_RUST=1` : une pièce manquante ou un cas en échec y rougit le
job. Variables lues :

| Variable | Effet |
|---|---|
| `MEM0_CONTRAT_URL` | URL de base `http://<hôte>:<port>` du serveur à tester |
| `MEM0_CONTRAT_START` | commande shell qui démarre le serveur à tester (défaut : `bash scripts/mem0-http-contrat.sh --start-rs`) |
| `MEM0_CONTRAT_EXTERNE` | `1` accepte une URL sans commande de démarrage (instance externe, vide exigée) |
| `MEM0_CONTRAT_TOKEN` | `X-Mem0-Token` envoyé à une instance externe |
| `MEM0_CONTRAT_INFER` | `0` désactive le groupe infer=true (extraction LLM) |
| `MEM0_CONTRAT_OPENAI_PORT` | port fixe du faux serveur OpenAI (libre par défaut) |
| `MEM0_CONTRAT_OPENAI_HOTE` | adresse IPv4 d'écoute du faux serveur OpenAI (défaut `127.0.0.1`, sinon refus en code 3) |
| `MEM0_CONTRAT_MOTEUR` | moteur de `--start-conteneur` (défaut : `podman` s'il est sur le PATH, sinon `docker`) |
| `MEM0_CONTRAT_QDRANT` | binaire Qdrant à utiliser à la place de celui du cache |
| `MEM0_CONTRAT_RANG_FIXTURE` | fixture de rang à utiliser à la place de `scripts/mem0-http-contrat/rang.json` |
| `MEM0_RS_BIN` | binaire démarré par `--start-rs` (défaut : `${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}/debug/mem0-rs`) |

`--start-qdrant` lance une Qdrant native jetable sur `MEM0_CONTRAT_PORT` (HTTP)
et `MEM0_CONTRAT_GRPC_PORT`, stockage dans `$MEM0_CONTRAT_WORKDIR/qdrant`, clé
API fixe `contrat-qdrant-cle` ; l'appelant attend `/readyz`. La preuve de
migration `test/stack/mem0-rs-migration.test.ts` y sème la collection `omp_memory` et
écrit à côté un `history.db`, puis les importe par `mem0-rs import`.

`--start-conteneur` démarre le service mem0-rs de `mem0-stack/docker-compose.yml`
(image `mem0-rs:local` déjà construite, sinon code 2) sous le projet
`mem0-contrat-<port>`, avec un volume nommé que l'arrêt efface (`down -v`) :
c'est la preuve locale du conteneur, jamais jouée en CI.

Les **preuves conteneur** de la bascule vivent dans
`test/stack/mem0-stack-bascule-rust.test.ts`, sautées sans leur drapeau et jamais
jouées en CI. Moteur : `MEM0_CONTRAT_MOTEUR`, sinon `podman`, sinon `docker` ;
le test refuse un moteur qui porte des conteneurs `omp-console-*`. Elles
construisent l'image par `compose build mem0-rs` et ne publient que des ports
libres (jamais 8321 ni 6333) :

- `MEM0_BASCULE_CONTENEUR=1` : un souvenir survit à `down`/`up` du conteneur, la
  base apparaît dans le dossier de l'hôte (AC-2), puis le contrat boîte noire
  passe contre `--start-conteneur` (AC-3) ;
- `MEM0_BASCULE_REEL=1` avec `MEM0_BASCULE_HISTORY_DB=<copie de history.db>` :
  répétition à blanc de la migration de `mem0-stack/README.md` sur une réplique
  de la vraie Qdrant, puis comparaison du nombre de souvenirs et des têtes de
  recherche avec la pile d'omp-console, qui n'est lue que par `inspect` et HTTP
  (AC-11, AC-12). La copie se fait par
  `"$HOME/Library/Application Support/com.omp.console/components/podman/6.1.3/bin/podman" --url "unix://$TMPDIR/podman/omp-console-api.sock" cp omp-console-mem0-http:/home/mem0/.mem0/history.db <copie>`.

```bash
export PATH=/opt/podman/bin:$PATH && podman machine start
MEM0_BASCULE_CONTENEUR=1 node --test --experimental-strip-types test/stack/mem0-stack-bascule-rust.test.ts
MEM0_BASCULE_REEL=1 MEM0_BASCULE_HISTORY_DB=<copie> node --test --experimental-strip-types test/stack/mem0-stack-bascule-rust.test.ts
podman machine stop
```

Le contrat joue aussi une phase **`rang`**, sur une instance neuve (l'IDF du BM25
ne voit que ce corpus) : la fixture commitée `scripts/mem0-http-contrat/rang.json`
porte un petit corpus, des requêtes et, capturés sur l'ancien mem0-http Python
(mem0 2.2.1), l'ordre des ids rendus par chaque recherche (`attendu`) et les
arêtes du graphe. Toute divergence d'ordre, un `semantic_score` qui n'est pas le
cosinus brut du faux embedder, un souvenir lexical rendu malgré `threshold` ou
une arête différente fait échouer le run : c'est la preuve de parité de mem0-rs.
La phase est sautée en mode externe ; une fixture illisible ou non capturée est
un refus (code 3). La fixture n'est plus recapturée : le Python qui servait de
référence est retiré.

Viser mem0-rs (binaire construit par `cargo build --manifest-path
mem0-stack/mem0-rs/Cargo.toml --locked`), sans toucher à cas.ts :

```bash
MEM0_CONTRAT_START="bash scripts/mem0-http-contrat.sh --start-rs" bash scripts/mem0-http-contrat.sh --run
```

`--start-rs` démarre le binaire sur une base SQLite neuve du répertoire de travail
de la phase ; binaire absent → `non exécuté : binaire mem0-rs absent (<chemin>)`, code 2.

La section `── Rust mem0-rs` (id `rust`, juste après `types`) éprouve la crate
`mem0-stack/mem0-rs` : `cargo clippy --all-targets -- -D warnings` (aucun
avertissement toléré), `cargo test`, `cargo build`, puis ce même contrat contre le
binaire construit, groupe infer=true compris. Les trois étapes cargo tournent même si
l'une échoue, et leur sortie n'est imprimée qu'en cas d'échec ; la commande à
relancer est donnée par chaque ✗. Sans `cargo` (ou sans clippy) dans le `PATH`, la
section annonce le saut sans ✓ et ne fait rien échouer sur un poste ; la CI installe
clippy (`rustup component add clippy`) et pose `MEM0_OMP_REQUIRE_RUST=1`, qui
change ce saut en échec. `MEM0_OMP_SKIP_RUST` non vide ignore la section : les
copies jetables des tests le posent.

Un merge sur `main` déclenche `.github/workflows/release.yml`. Le job ne pousse
**jamais** directement sur `main` (la protection de branche refuse un commit neuf
sans statuts) : il ouvre une PR de release, attend que les trois statuts passent,
la fusionne en squash, puis pousse les tags `<plugin>-v<version>` et publie les
releases GitHub. Les versions elles-mêmes sont décidées **par le job** — `fix` ⇒
patch, `feat` ⇒ mineure, rupture déclarée ⇒ majeure, d'après les commits touchant
chaque plugin — et non par la PR mergée : personne ne monte une version à la main
(une PR qui le tente échoue en CI). `CHANGELOG.md` est écrit au même moment, une
section datée par version publiée, et les versions historiques jamais publiées sont
rattrapées par le même run. Le jeton dédié que ce job exige, ses permissions et sa
création sont dans `PUBLISHING.md` § Jeton de release ; les règles de décision, le
flux en six étapes et la commande de protection de branche aussi.

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
  exposé par le service et envoyé à chaque rappel — il porte sur le **cosinus brut**
  (`explain`), jamais sur le `score` affiché, que BM25 sature.
- **Sommaire de la mémoire dans le prompt système** — exhaustif tant qu'il n'est
  pas tronqué (60 entrées) ; au-delà, il annonce le nombre d'entrées masquées et
  invite à `mem0_search`. Plus l'agrafage d'un souvenir aux résultats de
  `read`/`grep`/`glob`/`lsp`/`edit`/`write` : la mémoire arrive dans la sortie que
  l'agent lit de toute façon, au lieu de dépendre d'une consigne.
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
- **Plancher de pertinence 0.4 → 0.55, sur le cosinus brut.** Le rappel injectait des
  souvenirs hors-sujet — « recette de tarte aux pommes » (0.432), « résumé de cette
  session » (0.534), et un souvenir d'un autre dépôt au milieu de souvenirs légitimes.
  La cause n'était pas la valeur du seuil mais ce qu'il mesurait : le `score` renvoyé
  par le service est le score **combiné** (sémantique + bm25 + boost entités), que BM25
  sature — sur une sonde hors-sujet il monte à 0.716, plus haut que n'importe quelle
  ligne d'une demande pertinente, et le service classe donc dans un ordre qui n'est pas
  sémantique. Le service expose maintenant le **cosinus brut** (`explain` →
  `score_details.semantic_score`), l'extension filtre ET trie dessus (pool de 4 × la
  limite, puis troncature), la recherche manuelle `mem0_search` applique le même
  plancher — et quand un service ancien ne renvoie pas ce score, le rappel s'abstient
  et le dit au lieu d'injecter à l'aveugle. L'origine d'un souvenir n'est jamais un
  critère : seul le cosinus l'est. Déploiement : `docker compose build mem0-http &&
  docker compose up -d mem0-http`, puis relance d'OMP (l'extension ne recharge pas le
  service).
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
