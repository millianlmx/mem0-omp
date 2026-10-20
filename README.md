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
├── omp-mem0-req/                      le plugin pipeline (/req → /specs → /impl → /review)
│   ├── package.json
│   ├── extension.ts                   entrée : commandes, événements, câblage
│   ├── lotController.ts, lot.ts, lotLimits.ts, chain.ts, contract.ts, seeds.ts
│   │                                  le lot : pilote, modèle, bornes, chaîne, contrat, amorces
│   ├── runs.ts, inbox.ts, publish.ts, store.ts, runState.ts, git.ts, state.ts,
│   │   models.ts, audit.ts, commands.ts, quota.ts, context.ts, arbiter.ts
│   │                                  runs, boîtes, magasin d'état, worktrees, audit, modèles, quotas
│   ├── project.ts, projectDriver.ts, projectRelay.ts, relay.ts
│   │                                  la conduite de projet et le relais
│   └── panel.ts, panelRows.ts, panelWidth.ts, panelView.ts, panelSession.ts,
│       panelHost.ts                   le panneau /pipelines et la vue de session
├── omp-console/                       la coque macOS (SwiftUI), le noyau partagé et l'app iOS
│   └── ios/                           le projet Xcode de l'app iOS (coque-ios)
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
├── scripts/typecheck.sh               type-check des deux plugins et de test/ contre les types de l'hôte
├── scripts/plugin-smoke.ts            charge les plugins dans un vrai OMP
├── scripts/fallback-bench.ts          banc de repli de modèle sans réseau, dans une vraie session OMP
├── scripts/swift-app.sh               suite release puis bundle .app de la coque SwiftUI
├── scripts/ios-build.sh               compile et teste l'app iOS, seul chemin du dépôt qui exige Xcode
├── scripts/app-icon.sh                dessine l'icône d'OMP Console et réécrit ses fichiers versionnés iOS et Mac
├── scripts/run-console.sh             recompiler vite et relancer OMP Console (hooks git fournis)
├── scripts/recette/mac-recette-ui.sh          recette UI de l'app Mac : 23 surfaces capturées et sondées en AX, verdict 0/1/2
├── scripts/recette/mac-recette-ui/            sonde Swift, catalogue, analyse, jeu fictif et exceptions de cette recette
├── scripts/omp-console-api.ts         sonde CLI de l'API distante d'OMP Console (appairage, magasin, flux)
├── scripts/mem0-http-contrat.sh       contrat HTTP boîte noire des 9 routes (prépare la Qdrant d'import, lance, démarre mem0-rs ou son conteneur)
├── scripts/mem0-http-contrat/         lanceur, cas, formes et faux serveur OpenAI du contrat
├── scripts/release.ts                 PR de release auto-mergée, tags et releases au merge
├── scripts/no-manual-bump.sh          refuse un bump de version manuel dans une PR
├── scripts/release-simulation.sh      simule la release d'une PR sur une copie jetable
└── .github/workflows/                 check.yml (PR), release-simulation.yml (PR), release.yml (merge sur main)
```

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

**1. Le service** — obligatoire, le plugin ne le déploie pas :

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

**2. Les plugins**, depuis une session OMP :

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

- `/service` — le service OMP : `start`, `status`, `stop`, `install`, `uninstall`
  (voir « Le service » ci-dessus).
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
- `/req`, `/specs`, `/impl`, `/review` (plugin `omp-mem0-req`) — pipeline one-shot
  **piloté par le critère d'acceptation**, en quatre sessions dédiées. Chaque maillon
  descend d'un id, ce qui rend la chaîne vérifiable au lieu d'être déclarative :
  `B-n` (besoin) → `AC-n` (critère, Given/When/Then) → `S-n` (spec) → `BR-n` (lot) →
  test tagué `AC-n` → verdict.

  `/req` clarifie l'intention par des questions à enjeu (pas de check-list mécanique,
  et une option « peu importe » sur chaque `ask`) et fait émerger les **critères
  d'acceptation** — un critère est comportemental, donc de l'intention : c'est
  l'utilisateur qui le valide. La clôture est refusée tant qu'un besoin n'a pas au
  moins un critère falsifiable : c'est là que doit passer l'essentiel du temps.
  `/specs` fige des specs non ambiguës contre le dépôt réel, tracées vers les
  critères, puis découpe la feature en **lots** — des briefs **typés** (`ui` / `archi`
  / `aucun`) qui portent le « comment » que la spec laisse dehors : états d'écran et
  interactions pour `ui`, modèle de données, contrats d'API et migrations pour `archi`.
  `/impl` implémente d'un trait et **prouve chaque critère par un test qui porte son
  id** (`AC-3`), pour être retrouvable mécaniquement.
  `/review` révise le `git diff` (source de vérité de ce qui a changé) contre le
  contrat, **critère par critère** : un seul appel `bash scripts/test-ac.sh AC-1 AC-2 …`
  retrouve chaque test dans les fichiers **du diff**, lance la suite une fois, et la
  revue rapporte `AC-n → fichier:ligne → pass/fail` en citant l'assertion qui matérialise
  le *Then*. Un critère sans test traçable est un bloquant. Diff ≤ 400 lignes
  (`git diff --stat`) : lecture directe ; au-delà, délégation par lot à des sous-agents.
  L'état traverse les sessions par un **fichier contrat déterministe**
  `.omp/pipeline/contract.md` — besoins et critères, puis specs et lots y sont écrits
  par l'agent, relus tels quels à l'étape suivante — et non par la mémoire mem0 :
  besoins, critères, specs et lots sont des artefacts transitoires de la feature ;
  mem0 ne garde que les décisions durables.
  `/review` rend une évaluation structurée (STATUT, AC PAR AC, SPEC PAR SPEC,
  BLOQUANTS, RECOMMANDATIONS) et la consigne dans le contrat sous `## Revue`. La boucle se
  ferme avec `/impl --fix` : une session qui lit ce verdict et lève chaque BLOQUANT
  sans élargir le périmètre. Seul le champ
  `BLOQUANTS` décide de la suite : `STATUT` est informatif (un ancien verdict qui porte
  encore `DÉCISION FINALE` reste lisible, la ligne n'est jamais comptée). Le champ est
  relu mécaniquement : sans bloquant, il s'écrit `BLOQUANTS : aucun`.

  **Chaque maillon annonce la suite.** À la retombée terminale de la session — le seul
  instant où « la phase est finie » est vrai, OMP n'émettant `session_stop` que là, et
  jamais pour une session de sous-agent — l'extension poste dans le transcript un
  message DURABLE (pas un toast, qui disparaît au redraw) portant la commande exacte du
  maillon suivant : `/specs` après `/req`, `/impl` après `/specs`, `/review` après
  `/impl`, puis `/impl --fix` tant que `## Revue` consigne un BLOQUANT — et la fin du
  cycle est signalée quand il n'y en a aucun. Un maillon qui s'arrête faute de section
  `## Spécifications` dans le contrat le dit sans prescrire de commande. En session interactive, la
  commande est en plus préremplie dans la zone de saisie, prête à valider par Entrée —
  et jamais par-dessus un brouillon déjà tapé.

  **L'agent d'un maillon n'annonce aucune commande.** Il termine sa réponse par « ce
  maillon est terminé » : la commande suivante n'est annoncée que par la notice
  `[pipeline] Phase /x terminée — commande suivante : …` de `session_stop`. Chaque maillon
  qui écrit le contrat le fait par ÉDITION de section — il lit le contrat, ne remplace que
  la ou les sections visées, conserve le reste à l'identique, puis relit le contrat après
  écriture et vérifie que `## Besoins`, `## Critères d'acceptation`, `## Documentation`,
  `## Spécifications` et `## Lots` présents avant le sont toujours.

  **Les modèles et leurs replis se choisissent au lancement de la feature.** `/req` demande, **avant
  toute écriture** (ni branche, ni worktree, ni session), **quatre** choix dans la liste des
  modèles connus d'OMP : le modèle du groupe **cadrage+revue** (`req`, `specs`, `review`),
  **son repli**, le modèle du groupe **exécution** (`impl`, `release`), **son repli**. Les modèles proposent `défaut OMP (aucun
  modèle)` ; la liste d'un repli commence par `aucun repli` (si le principal est épuisé, la
  feature passe en « bloquée : quota ») puis reprend les modèles connus **sans le principal
  choisi juste avant**. `Échap` annule
  sans rien créer. Les quatre sont **modifiables à tout moment**, depuis OMP Console ou par le
  geste `m` du panneau `/pipelines` (et par la commande de canal `models`) : un run déjà lancé n'est ni interrompu ni relancé, tout
  run suivant utilise la valeur courante. Les runs du service (maillons du lot, arbitre) partent
  sur le principal et reçoivent le repli de **leur groupe** — le groupe cadrage+revue porte `req`,
  `specs` et `review` (la collecte, `/specs` et la revue), le groupe exécution porte `impl` (y
  compris `/impl --fix`) et `release` (la livraison) —, le repli ne servant que si ce principal
  est épuisé (voir « Repli de modèle et quota »). Les sessions interactives, elles, **basculent
  par `setModel`** (non persisté, jamais écrit dans la config OMP) : `/req` juste après sa
  relocalisation dans le worktree, `/specs`, `/impl`, `/impl --fix` et `/review` juste après leur
  nouvelle session, sur le modèle du groupe de la phase lu sur la feature du lot dont le
  worktree est le cwd. Un groupe laissé sur `défaut OMP`, un cwd **hors lot** ou une feature
  sans modèle pour ce groupe : aucun `setModel`, le modèle de la session est conservé et la
  notice le dit. La notice d'accueil de `/req` et celle de chaque commande nomment le modèle
  appliqué. Le tout s'affiche sur son rang du panneau
  (`… · cadrage+revue anthropic/claude-opus-4-7 (repli cerebras/llama3.1-8b) · exécution défaut OMP`),
  et le niveau de réflexion n'est jamais transmis : il reste celui de la config OMP.

  **Chaque feature vit dans son propre worktree git.** `/req <nom-de-feature>` crée
  `<base>/<dépôt>-<hash7>/<nom>` sur la branche `feat/<nom>` (base :
  `~/.omp/pipeline-worktrees`, ou `MEM0_PIPELINE_WORKTREES_DIR`) puis y relocalise la
  session : le contrat — relatif au cwd — vit donc sur la branche de la feature, et
  deux features en parallèle ne se marchent plus dessus. Le dépôt principal est laissé
  intact par la création (ni commit, ni fichier touché) ; `/req` s'ouvre depuis lui et
  refuse de s'ouvrir depuis un worktree. `/specs`, `/impl` et `/review` refusent de
  tourner hors du worktree d'une feature (sauf contrat hérité du mode précédent).
  **Le push vaut clôture.** Hors lot, la pipeline ne commite rien et ne pousse rien
  elle-même : dès que la branche est poussée sur `origin` — par toi, ou par la
  livraison d'une feature de lot (voir « Lot de features ») — et que l'arbre du
  worktree est propre, il est
  retiré au déclenchement suivant (maillon ou commande) — la branche reste. Un worktree
  sale ou non poussé est conservé avec sa raison, et un balayage impossible ne retire
  rien (avertissement). La mémoire reste unique : worktree et dépôt principal partagent
  le même scope mem0, et rien n'est écrit dans l'arbre de la feature.
- `/pipelines` (raccourci `alt+w`, plugin `omp-mem0-req`) — ouvre la **salle de contrôle**
  des pipelines : le **lot de features** du dépôt (ajouter, lancer, répondre, valider,
  accepter, relancer, annuler) au-dessus des pipelines en cours de toute la machine —
  voir ci-dessous.
- `/audit [contexte]` (plugin `omp-mem0-req`) — ouvre une **session d'audit** du dépôt
  principal : l'agent l'analyse en lecture seule, affiche ses faiblesses et des features
  proposées — chacune nommée, avec ses dépendances —, puis te montre **une liste à
  cocher** de tous ces éléments, faiblesses et features réunies : coches-en un ou
  plusieurs et valide (valider sans rien cocher ne lance rien). Pour chaque élément
  coché, tu **valides ou amendes l'intention** transmise à `/req`, puis tu choisis ses
  **modèles et replis** — quatre questions par élément : `cadrage+revue`, son repli, `exécution`,
  son repli (`aucun repli` est la première option, le principal choisi n'est jamais
  proposé en repli) —, chaque pipeline tourne avec les siens. Les
  pipelines cochées démarrent **en parallèle dans la limite de `MEM0_PIPELINE_SLOTS`**
  (les autres attendent un créneau) ; un élément qui dépend d'un autre élément
  choisi n'attaque qu'une fois celui-ci terminé. Redemande un lancement dans la même
  session pour lancer plus tard d'autres éléments : ceux déjà lancés n'y sont plus
  cochables. Questions et jalons sont relayés dans cette session — voir « Pipelines
  lancées par /audit ».
- `/project [contexte]` (plugin `omp-mem0-req`) — conduit un **projet** entier, segment
  par segment. D'abord un **cadrage** interactif : sur un dépôt qui a déjà du code,
  l'agent le **lit avant sa première question**, puis cerne le but et la fonction du
  projet par des questions à options ; le cadrage ne se clôt que sur ton « fin » ou sur
  le **contrôle de complétude**. L'agent propose ensuite un **plan de segments** ordonnés
  de features, que tu **corriges puis valides** — aucune pipeline ne démarre avant —,
  avec le modèle et le repli de chaque feature. Le plan et son avancement vivent dans `PROJECT.md`,
  seul fichier de la branche `omp-project`. Chaque segment part en pipelines parallèles
  **dans la limite de `MEM0_PIPELINE_SLOTS`** jusqu'aux PR, et le segment suivant démarre
  seul dès que **toutes** les PR du précédent sont fusionnées — par toi, jamais par
  `/project`. Voir « Projet ».

## Le service

Un seul process `omp` fait avancer toutes les pipelines de la machine — les maillons
d'une feature, les segments d'un projet, les audits. Il vit hors de toute session
terminal, expose une **API REST locale** (`http://127.0.0.1:<port>/v1`, jeton dans
`<état>/service.json`) que le panneau `/pipelines` et l'app OMP Console utilisent, et
c'est lui qui exécute les maillons — plus aucun `omp -p` par maillon.

- `/service start` — démarre le service DANS le process courant et ne rend jamais la
  main : c'est la commande que le job launchd exécute
  (`omp -p --no-session --pipeline-service "/service start"`).
- `/service status` — dit `en marche (pid N, port P)` ou `arrêté`, et l'état du job.
- `/service stop` — arrêt propre : plus de nouvelles requêtes, tours coupés,
  contrôleurs arrêtés, `service.json` retiré.
- `/service install` / `/service uninstall` — pose (ou retire) le job launchd
  `com.millianlmx.mem0-omp-service` dans `~/Library/LaunchAgents`, avec `KeepAlive` et
  `RunAtLoad` : le service redémarre à l'ouverture de session et après un `kill -9`,
  ce qui fait reprendre seuls les lots et les projets en cours. Le job écrit sa sortie
  dans **`<état>/service.log`** (StandardOutPath/StandardErrorPath), à côté de
  `service.json`.

Sans service, les pipelines **n'avancent plus** — aucune session terminale ne reprend
un lot — et le panneau le dit (`pilote absent — les pipelines n'avancent plus`).

Les routes de l'API (jeton `X-OMP-Service-Token` exigé partout, `{repo}` = chemin
absolu percent-encodé, refus `{error, reason}`) :

| Route | Rôle |
|---|---|
| `GET /v1/health` | version, pid, sessions, lots |
| `POST /v1/repos/{repo}/pilot` | réveille le pilote d'un dépôt |
| `POST /v1/repos/{repo}/commands` | commande de pipeline, rend son accusé |
| `GET /v1/repos/{repo}/lot` | état du lot du dépôt (`runs[]` avec pic et compactions) |
| `GET` / `POST /v1/sessions` | liste ou crée une session de l'app |
| `GET` / `DELETE /v1/sessions/{id}` | lit (avec `contextPeak` et `compactions`, plus `model` et `thinkingLevel`) ou ferme une session |
| `GET /v1/sessions/{id}/events` | flux SSE de la session (trames `state`, `dialog`, `notice`, `prompt_end` et `model` : `{model, thinkingLevel}`, rejouée dans le snapshot d'une session de la section) |
| `POST /v1/sessions/{id}/prompt`, `…/abort`, `…/dialogs/{dialogId}` | prompt, abort, réponse de dialogue |
| `POST /v1/sessions/{id}/model` | change le modèle et le niveau de réflexion de la session de la section `{model, thinkingLevel?}` (refus : 409 pendant un tour, 409 modèle non authentifié, 400 niveau non supporté) puis enregistre le défaut du projet |
| `POST` / `DELETE /v1/projects/{repo}/conduite` | démarre ou arrête la conduite d'un projet |
| `GET` / `POST /v1/projects/{repo}/model` | lit ou écrit le défaut OMP du projet `{model, thinkingLevel?}` : clé `modelRoles.default` de `<repo>/.omp/config.yml` (`sélecteur[:niveau]`) ; les sessions de la section l'appliquent à l'ouverture, les maillons, l'arbitre et la conduite ne le lisent jamais |
| `POST /v1/audits` | démarre un audit de l'app `{repo, orientation}` |
| `POST /v1/audits/{id}/launch` | lance les propositions cochées `{selected, brief}` |
| `POST /v1/audits/{id}/escalations` | répond à une escalade `{slug, key, answer?, decision?}` |
| `DELETE /v1/audits/{id}` | arrête un audit |

### Outils de pilotage

Une session OMP **interactive** pilote le lot de son dépôt par **quatre outils**, que le
modèle appelle comme n'importe quel outil — le service reste le seul à agir. Ils parlent
au service par son API locale (`POST /v1/repos/{repo}/commands`) : le modèle ne fournit ni
URL, ni jeton, ni identifiant de commande (l'outil pose lui-même l'enveloppe
`{version, id, sentAt, repo}`, l'identifiant `pilot-…`), et le dépôt visé est celui de la
session — le dépôt principal, même depuis le worktree d'une feature.

| Outil | Paramètres | Approbation | Rend |
|---|---|---|---|
| `pipeline_state` | aucun | lecture, sans prompt | JSON `{repoRoot, lots[]}` : chaque feature avec `state`, `phase`, `sinceAt`, `waitKind`, `prUrl`, `base`, `worktree`, `branch`, `running`, et ses **questions en vol** avec leur texte et leurs options **en entier**, sans troncature (une question `ask` d'un run vivant, ou la dernière question en texte d'une feature qui attend une réponse) ; une réponse déjà acheminée n'y figure plus. Un dépôt sans lot rend `lots: []`, sans erreur |
| `pipeline_command` | `kind` + les champs de ce kind (`slug`, `text`, `toolCallId`, `selected`/`custom`, `fate`…) | **écriture, prompt à chaque appel** | l'accusé du service tel quel (`taken` ou `refused` + `reason`) ; un refus ou un service absent est une erreur d'outil |
| `pipeline_session_tail` | `slug`, `n` (1 à 1000) | lecture, sans prompt | JSON des `n` derniers messages du dernier run de la feature, du plus ancien au plus récent : rôle, texte, appels d'outil avec leurs **arguments complets** (jamais tronqués) |
| `pipeline_advance` | `slug` | **écriture, prompt à chaque appel** | l'accusé du kind `avance` (voir « Le canal de commande ») |

- **`pipeline_command`** couvre tous les kinds du canal sauf `avance` (qui a son outil) :
  `launch`, `add`, `remove`, `verdict`, `answer`, `reply`, `models`, `relaunch`, `cancel`,
  `start`, `stop`, `quota` et **`arbitrage`**. La **réponse** à une question en vol passe par
  `answer` — le chemin officiel (journal du lot, question marquée répondue) —, **jamais** par
  un fichier déposé dans la boîte du run. Un `taken` n'est pas une garantie de l'effet :
  relire `pipeline_state` ensuite.
- **Approbation** : `pipeline_command` et `pipeline_advance` déclarent une approbation
  `write` avec la politique `prompt` — l'utilisateur est **toujours** interrogé, dans les
  trois modes d'approbation d'OMP (`always-ask`, `write`, `yolo`) et même si une politique
  l'autorise pour cet outil ; seule une politique `deny` l'emporte. Un appel refusé lève
  `Tool call denied by user` avant `execute` : aucun geste n'est posté. Sans interface pour
  poser la question, l'appel échoue de même. `scripts/plugin-smoke.ts` rejoue ce contrôle
  contre l'hôte installé.
- **Armement** : les quatre outils sont enregistrés **une fois par process**, dans une
  session interactive (`ctx.hasUI`) qui n'est ni un sous-agent, ni le process du service, ni
  un run de pipeline — **dans un dépôt avec ou sans lot**. Ils ne sont **jamais** armés
  dans un **enfant headless** de lot (`--pipeline-lot` / `--pipeline-feature` /
  `--pipeline-phase`), ni dans une session hébergée par le service, ni sans interface : un
  run de pipeline ne peut donc pas piloter son propre lot. Aucun drapeau ni variable
  d'environnement ne les arme autrement.
- **Hors périmètre** : la vérification d'une PR en retard sur `main` (worktree jetable,
  gardes, builds) n'est pas un outil ; l'app Mac et le panneau n'émettent ni `arbitrage` ni
  `avance`.

### Repli de modèle et quota

Chaque run (étape de pipeline) tourne sur le **modèle principal** et le **repli** que
l'utilisateur a choisis pour son groupe (cadrage+revue ou exécution), et sur aucun autre :
le pipeline ne choisit jamais un modèle de remplacement à sa place.

- Les réglages de la session d'un run sont posés **en mémoire** (`Settings.isolated`) :
  le modèle de départ sur tous les rôles de modèle d'OMP (les sous-agents suivent le
  run) et, quand un repli existe, la chaîne native `{"default": [repli]}`. Le service
  n'écrit jamais `~/.omp/agent/config.yml`, n'appelle jamais `setModel` avec
  `persist`, et ne touche ni la session `/project` ni les sessions de l'app.
- Une 429 sur le principal fait basculer le run sur le repli **dans la même session**
  (mêmes messages, aucun redémarrage). Quand OMP ne bascule pas — par exemple un repli
  du même fournisseur après `GoUsageLimitError` — le runner bascule lui-même et envoie
  `[reprise] Le modèle X a atteint son quota : le run continue sur Y…` (3 reprises au
  plus par run).
- Le principal reprend la main dès que son échéance est passée, **au milieu d'une
  boucle d'outils** : un crochet `tool_result` du plugin rappelle `setModel` entre deux
  appels modèle (OMP ne le fait qu'à l'admission d'un prompt).
- `<état>/quota.json` (écrit par le service seul) liste les modèles épuisés et leur
  échéance, annoncée (`retry-after-ms`) ou non (5 min). **Aucun run ne démarre sur un
  modèle épuisé** : le run part sur le repli, et sans repli disponible la feature passe
  en `blocked` avec `quota` (fournisseur, modèle, échéance, phase) — jamais `failed` —,
  sa session et son worktree intacts. L'échéance s'écrit `jusqu'au JJ/MM HH:MM` ou
  `échéance non annoncée`.
- **Les sessions interactives suivent la même règle, par `setModel`.** `/req` (après sa
  relocalisation dans le worktree), `/specs`, `/impl`, `/impl --fix` et `/review` (après leur
  nouvelle session) appliquent le modèle de leur groupe : principal non épuisé → le principal ;
  principal épuisé et repli non épuisé → le repli ; sinon le modèle de la session est conservé,
  avec un avertissement qui nomme le modèle épuisé et son échéance. L'application n'est jamais
  persistée, et un échec (modèle inconnu d'OMP, `setModel` sans clé d'API ou qui jette)
  avertit en nommant le modèle sans rien défaire : la session ouverte est conservée et la
  feature reste enrôlée. Groupe sur `défaut OMP`, cwd **hors lot** ou feature sans modèle pour
  ce groupe : aucun `setModel`, et la notice dit que le modèle de la session est conservé.
- **Le run de conversation du panneau `/pipelines`** (une réponse envoyée à une session de
  feature, lancée en `omp -p`) part en `--model` sur le modèle de départ de la même règle et
  reçoit le repli du groupe en chaîne native par un overlay `--config`
  (`<état>/conversation-overlays/<empreinte du repli>.json`, écrit de façon atomique et jamais
  supprimé : OMP le relit pendant le run). Principal épuisé et repli disponible : le run part sur
  le repli, sans overlay. Principal épuisé sans repli, ou repli épuisé aussi : le lancement est
  **refusé avant tout process**, par un motif affiché dans la zone du panneau qui nomme le
  modèle épuisé et son échéance. Cible hors lot ou sans modèle de groupe : ni `--model`, ni
  repli, ni refus de quota.
- `bun scripts/fallback-bench.ts <sans-repli|repli|retour|epuise>` rejoue ces
  scénarios dans une vraie session OMP, sans réseau (fournisseur `banc` scripté, HOME
  factice, `config.yml` amorcé dont l'empreinte est comparée avant/après) et imprime une
  ligne JSON ; `test/req/context-optimization-architecture.test.ts` le lance.
- **Quota : une escalade par fournisseur, jamais un modèle choisi à ta place.** Les
  features `blocked` portant un `quota` du **même fournisseur** forment **un seul groupe**,
  décidé sur **une** surface : la session /project ou /audit **ouverte** pour les features de
  son contexte (message `[audit] quota prov épuisé jusqu'au … — features bloquées : a, b.
  Décision réservée à l'utilisateur : appelle audit_escalate avec l'élément quota:prov.`),
  sinon `/pipelines` (rang `quota <fournisseur> épuisé …`, `Entrée` ouvre la liste du
  catalogue — sans `défaut OMP` ni modèle épuisé, avec la recherche au clavier —, `Entrée`
  sur un modèle ouvre l'aperçu `Relancer <N> feature(s) bloquée(s) par <fournisseur> avec le
  repli <M> ?`, `Entrée` applique, `Échap` revient ; sans modèle connu : `aucun modèle
  connu — rien n'est relancé`). Dans la session parente, `<nom>_escalate` ouvre
  `Quota <fournisseur> épuisé — relancer <N> feature(s) avec quel repli ?` avec le même
  catalogue puis `Laisser bloquées pour l'instant` (rien ne change, l'élément n'est pas
  réinjecté avant la prochaine ouverture de la session). La commande de canal `quota`
  fait la même décision.
- **La décision rend le modèle choisi `M` le REPLI du groupe** (cadrage+revue ou exécution) de
  l'étape bloquée, pour chaque feature du groupe ; **le principal ne change pas** (et un `M`
  qui est déjà le principal du groupe laisse la feature telle quelle). `quota` et la raison
  d'arrêt sont effacés et la feature est relancée par `R` : elle **reprend sa session**
  (`[reprise] …`) sur `M` tant que le principal est épuisé, et revient sur lui à son
  échéance. Deux refus, rien n'est modifié : `aucune feature bloquée par le quota <fournisseur>`
  et `<M> est épuisé <échéance> — choisis un autre modèle`.
- **Quota dans un lot arbitré** : une feature `blocked` par un quota, dans un lot arbitré
  (session `/audit` ou `/project` de la feature), est **relancée automatiquement à
  l'échéance** du quota (registre `quota.json` compris), sans aucun changement de modèle ni
  de repli et sans compter dans la borne de relances de l'arbitre ; avant l'échéance, et
  dans un lot sans arbitre, l'escalade ci-dessus reste le seul chemin (voir « Le pilote du
  lot »).

### Contexte des runs

Le contexte de chaque run hébergé (maillons `/req`, `/specs`, `/impl`, `/impl --fix`,
`/review`, `/release`, et arbitre) est **borné** par deux seuils, relus au démarrage de
chaque run ou session hébergée (jamais écrits dans le lot) :

- `MEM0_PIPELINE_CONTEXT_SOFT` (défaut `120000`, **`90000` pour `/review`**) : seuil de
  compaction ; `MEM0_PIPELINE_CONTEXT_SOFT_<PHASE>` (`REQ`, `SPECS`, `IMPL`, `REVIEW`,
  `RELEASE`) prime pour une phase donnée ;
- `MEM0_PIPELINE_CONTEXT_HARD` (défaut `250000`) : plafond.

Une valeur absente, non numérique, nulle ou négative retombe sur le défaut de sa variable ;
si `SOFT` atteint ou dépasse `HARD`, les deux défauts s'appliquent.

- **Mesure** : le service mesure `input + cacheRead + cacheWrite` de l'usage assistant
  à chaque fin de tour assistant (chaque `message_end`), pendant le run et non plus en
  fin de run ; le pic reste archivé dans `features[].runs[]`, avec le nombre de
  compactions (`compactions`, lu 0 sur un enregistrement ancien, sans changement de
  version du lot).
- **Compaction au seuil `SOFT`** : la première mesure au-dessus **note** le franchissement
  sans interrompre le tour ; le service compacte la session **à la fin du tour** (session
  au repos), une seule fois par palier (réarmée seulement quand une mesure retombe sous
  `SOFT`). Le succès journalise `contexte compacté à <n>` ; une compaction qui échoue est
  journalisée (`compaction échouée à <n>`), ne compte pas dans `compactions` et ne relance
  pas le maillon. Une compaction native d'OMP aboutie est comptée comme compaction du run.
- **Reprise minimale** : après la compaction, le runner renvoie seulement
  `[compaction] Le contexte a été compacté. Reprends à l'étape où tu étais ; livrable
  attendu : <section de la phase>. L'extrait du contrat de ton prompt initial reste
  valable.` (≤ 400 caractères) — ni le prompt du maillon ni la directive ne sont
  réinjectés. Ces reprises ne consomment pas les reprises de quota.
- **Plafond `HARD`** : une mesure au-dessus de `HARD` après une compaction dans le palier
  n'interrompt pas tout de suite : le service injecte dans le tour « [contexte saturé]
  Écris MAINTENANT ta section livrable dans le contrat (<section>) avec ce que tu as, puis
  arrête-toi. », borné à **5 minutes**. Si ce dernier tour dépasse la borne, le run est
  coupé (code 124) et passe `échoué` « contexte dépassé (<n> tokens) » — `bloqué` s'il y a
  une question en vol. Le run coupé garde son enregistrement (pic, compactions). L'arbitre
  suit le même chemin (livrable = sa décision `arbiter_decide`), puis son échec existant.
- **Sessions parentes** (conduite `/project`, analyse d'audit de l'app) : même mesure,
  même compaction au seuil `SOFT` (une fois par palier, OMP relance lui-même le tour
  interrompu), mais la session n'est **jamais coupée** : un dépassement de `HARD` y est
  seulement journalisé — notice durable dans la session et entrée `contexte` du journal
  de conduite du dépôt. Leur pic et leurs compactions sont servis par
  `GET /v1/sessions/{id}` (`contextPeak`, `compactions`).
- **Exposition** : `GET /v1/repos/{repo}/lot` rend l'état du lot (`runs[]` avec pic et
  compactions) ; `/pipelines` affiche le pic et les compactions de chaque run, par
  exemple `contexte : impl 182k ⚠ (1 compaction)`.
- **Directives** : `/specs` délègue obligatoirement la lecture du dépôt à des
  sous-agents scout et consigne leurs résumés dans le contrat (`### Relevé du dépôt`),
  l'analyse d'un audit et la conduite `/project` délèguent de même la leur ; `/impl` et
  `/review` annoncent la borne ci-dessus au lieu d'un objectif facultatif.

## Pipelines en cours

`/pipelines` — ou `alt+w` — monte un panneau **plein écran** qui liste les pipelines de
**tous les processus OMP de la machine**, tous dépôts confondus : la sienne comme celle
d'un autre terminal, d'un autre dépôt, d'un worktree voisin. Le chat n'est pas visible
derrière (le panneau emprunte le buffer alterné du terminal) et rien de l'écran normal
n'est modifié : à la fermeture, la transcription est exactement là où elle était. Rien
n'est à rafraîchir : le panneau relit l'état partagé une fois par seconde, l'horloge du
temps écoulé avec lui.

Chaque rang porte le dépôt et la feature, le maillon courant (`/req`, `/specs`,
`/impl`, `/review`), l'état et le temps passé sur **l'étape courante** — le compteur
repart à chaque changement de maillon, ce n'est jamais la durée totale :

```
────────────────────────────────────────────────────────────────
 Pipelines · 2 processus
 Lot · mem0-omp · 3 features · 1 terminée · 0 bloquée · 0 échouée
 · 0 annulée · 2 en cours · pilote : le service (pid 4821)
 ❯ mem0-omp/panneau-des-pipelines      /impl · --fix · tour 2/3 · 3:12
   dernière revue : 2 bloquant(s)
   mem0-omp/fetch-du-souvenir          /specs · attend réponse · 0:41
   mem0-omp/isolation-worktree         /review · terminé · 0:08
   PR : https://github.com/…/pull/12
 Hors lot · 1
   autre-depot/fix-recall              /req · tourne · 0:12
 ──────────────────────────────────────────────────────────────
 Historique · 1
   autre-depot/vieux-cycle             /review · terminé
 ↑↓ naviguer · Entrée session
 Entrée écrire · c annuler · o rejoindre
 Échap fermer
────────────────────────────────────────────────────────────────
```

L'en-tête du lot nomme **qui pilote** : `pilote : le service (pid N)` quand le service
conduit le lot — c'est le cas normal, c'est lui le pilote de la machine — `pilote : le
service (en adoption)` pour un lot qu'il n'a pas encore repris, `piloté par pid N —
consultation` quand une autre session vit encore dessus, `pilote : cette session` quand
aucun service ne tourne et que la session conduit son propre lot. Sans pilote, la ligne
dit `pilote absent — les pipelines n'avancent plus (/service start)` : aucune session
terminale ne reprend un lot.

Le panneau occupe **toute la largeur** du terminal (et toute sa hauteur) : rien n'est
rendu dans une colonne de 80 caractères, et un redimensionnement se voit au rendu
suivant, sans touche à presser. **Aucun texte n'est coupé** : un libellé, une notice, une
question, une réponse, un titre ou un pied plus large que la place disponible **revient à
la ligne**, sur autant de rangs qu'il en faut — le panneau se contente de borner les
fenêtres qui pourraient manger l'écran, et de les faire défiler.

- **Le titre** compte les **processus** vivants (runs appariés à une feature du lot +
  pipelines hors lot) : c'est ce qu'il mesure, et il le dit. Les états des rangs
  (`en cours`, `tourne`, `attend`, `bloqué`…) ne s'y trouvent pas — deux mesures
  différentes ne se lisent pas avec les mêmes mots.
- **Les sections sont nommées** : `Lot · <dépôt> · <n> features` suivi de la
  **répartition** (`1 terminée · 0 bloquée · 0 échouée · 0 annulée · 2 en cours`), puis
  `Hors lot · <n>` et `Historique · <n>`. Quand une section ne tient pas à l'écran, elle
  garde un marqueur qui **nomme la section qu'il tronque** (`… 4 de plus dans le lot`).
- **La colonne de droite** d'un rang est `<maillon> · <état> · <temps>` — jamais les
  dépendances : elles restent sur le libellé (`base-qdrant ← isolation-worktree`), une
  seule fois. Les **modèles** s'ajoutent au libellé (`base-qdrant · cadrage+revue
  anthropic/claude-opus-4-7 · exécution défaut OMP`), une fois eux aussi, suivis de ` (repli
  <R>)` quand le groupe a un repli (`cadrage+revue anthropic/claude-opus-4-7 (repli
  cerebras/llama3.1-8b) · exécution défaut OMP`) ; ils disparaissent
  pour une feature née au défaut OMP et sans repli ; `défaut OMP` nomme un groupe laissé vide, l'ancien
  modèle unique d'une feature d'avant remplissant les deux. Quand le libellé et la colonne
  ne tiennent pas ensemble sur la largeur de contenu, l'entrée peint **deux rangs** : le
  libellé, puis l'état et le temps — jamais
  coupés en deux. **Le tour de correction y figure** dès qu'il y en a un : `--fix · tour
  2/3` pour un `/impl --fix`, `tour 2/3` pour une `/review` — sans quoi un tour de
  correction se lisait comme un `/impl` neuf, et la boucle ne se suivait qu'à son blocage.
- **Un quota épuisé est lu sans ambiguïté** : l'état d'une feature bloquée par un quota
  s'affiche `bloquée : quota` (jamais `échoué`) et son second rang dit `quota : <fournisseur>
  épuisé jusqu'au JJ/MM HH:MM` (ou `échéance non annoncée`). Sous le titre du lot, **un rang
  par fournisseur épuisé** — `quota prov épuisé jusqu'au 15/11 01:13 · 2 feature(s)
  bloquée(s)`, astuce `Entrée choisir un repli` — regroupe les features bloquées que
  **aucune session /project ou /audit ouverte** ne porte (voir « Repli de modèle et quota »).
- **La raison d'arrêt** d'une feature bloquée ou échouée est portée par la liste, sur un
  second rang de son entrée : `arrêt : run tué par le délai de 3600s`. `échoué` ne dit
  pas pourquoi ; le motif, si. Deux autres seconds rangs existent : `dernière revue : n
  bloquant(s)` — le verdict que la chaîne vient de lire dans le contrat — et `PR : <url>`
  pour une feature livrée, l'URL que `gh` a imprimée.
- **Le pic de contexte et les compactions de chaque run** s'écrivent sur une sous-ligne
  `contexte : …`, après les autres : le service mesure, à chaque fin de tour assistant,
  `input + cacheRead + cacheWrite` et retient le **maximum** du run (`—` quand le run n'a
  émis aucun usage) ; l'enregistrement (au plus 100 par feature, les plus anciens
  retirés) est ajouté **à la fin du run** — étape ou arbitre —, donc rien n'apparaît pour
  un run en cours. Les groupes suivent `req`, `specs`, `impl`, `review`, `release`,
  `arbitre`, séparés par ` · ` ; un pic s'écrit `<n>` sous 1000, sinon en milliers
  (`82k`), suivi de ` ⚠` au-delà de 120 000 (marqueur d'affichage, indépendant des
  variables de « Contexte des runs »), puis de ` (1 compaction)` ou ` (<k> compactions)`
  quand le run a été compacté — rien à 0 compaction :
  `contexte : req 41k · specs 82k · impl BR-1 82k, BR-2 131k ⚠ (1 compaction) · review 90k`.
  Un run d'impl par lot porte l'id du lot, un `--fix` s'écrit `fix <pic>`. La ligne est
  absente tant qu'aucun run n'est terminé (et pour un lot d'avant cette version).
- **Le pied a toujours trois rangs** : les touches du panneau, celles de la **ligne
  sélectionnée** — `Entrée écrire`, `Entrée répondre`, `v valider`, `y accepter`,
  `R relancer`, `x retirer`, `c annuler`, `d supprimer` (le seul rang qu'il supprime est
  l'entrée d'historique), `o rejoindre` quand le rang a une session — puis `Échap
  fermer`. Rien n'y est annoncé qui n'agisse : sur un rang où `d` ne supprime rien,
  `d supprimer` n'apparaît pas ; `o rejoindre` disparaît quand un run écrit déjà cette
  session (la vue reste lisible, mais la bascule n'a pas de sens), `l lancer` quand rien
  n'est à lancer, et `c annuler` s'affiche aussi sur une feature **bloquée** ou
  **échouée** — c'est la seule façon d'abandonner un pipeline arrêté par le plafond de
  correction, en choisissant le sort de son worktree.

Le cadre, les rangs, le curseur et les couleurs viennent des **composants pi-tui de
l'hôte** — les mêmes que les écrans d'OMP (`DynamicBorder` pour les règles, `Text` pour
les rangs, le thème actif pour les couleurs et le curseur de sélection) : le panneau ne
jure pas à côté du reste. Sans ces composants (hôte d'une autre version), il **refuse de
s'ouvrir** et le dit (`panneau indisponible : composants de l'hôte absents (OMP)`) plutôt
que d'afficher un écran à moitié peint.

- **État** : `tourne` quand l'agent travaille, `attend` quand la pipeline est suspendue
  à une question — un `ask` en vol, une approbation d'outil en attente, ou l'agent qui a
  rendu la main. Une question `ask` **en vol** dit `attend réponse` (c'est une réponse qui
  la débloque, pas une inactivité), et le pied annonce `Entrée répondre`. L'état est
  calculé par le processus **propriétaire** de la pipeline, jamais deviné par celui qui lit.
- **La sélection suit la LIGNE, pas son rang** : une fin de maillon qui insère une entrée
  d'historique, un run qui change de maillon et se déplace dans la liste ne font plus
  glisser le curseur sur la voisine — `Entrée`, `o` et `d` visent la ligne que tu avais
  choisie, jamais celle qui a pris sa place. Et rien n'est peint hors budget : la ligne
  sélectionnée est toujours visible, sur un terminal de 20 rangs comme de 60.
- **Entrée** ouvre la **vue de session** de la ligne, dans le panneau : la transcription
  du fichier de session, du plus ancien au plus récent, relue en direct — un maillon qui
  travaille se voit avancer **sans rien toucher** (≤ 2 s), et remonter dans la vue fige la
  position de lecture : le contenu qui arrive ne la déplace pas d'un rang. **La vue suit
  le maillon COURANT** : quand la chaîne passe de `/review` à `/impl --fix`, la
  transcription bascule sur la nouvelle session et l'annonce (`nouveau maillon /impl —
  session …`) au lieu de laisser la revue à l'écran ; une feature échouée montre la
  session du run qui a échoué, pas celle de son dernier succès. Le rendu est
  celui d'OMP, **par les composants d'OMP** : chaque entrée est confiée au composant de
  l'hôte qui la rend dans une vraie session — le markdown est mis en forme, un appel
  d'outil montre sa carte (et son **diff**, ajouts en `+`, suppressions en `-`) —, si bien
  qu'une session se lit ici comme dans OMP. `ctrl+o` — la touche de pliage **native**
  d'OMP — bascule d'un coup le dépliage de **toutes** les entrées repliables de la vue,
  exactement comme dans le transcript principal, et les entrées qui arrivent ensuite
  naissent dans l'état courant. L'en-tête rappelle le rang, son maillon, son état et le
  nom du fichier — et `run en cours` quand un run est en train d'écrire cette session.
  `lecture seule` n'y figure **jamais** : une vue dont la zone de saisie accepte une
  écriture ne peut pas s'annoncer en lecture seule — quand elle l'est vraiment, la raison
  est écrite **dans la zone** (`lecture seule — <raison>`). Le défilement est celui d'une
  session OMP : `↑`/`k` et `↓`/`j` d'un rang, `maj+↑`/`maj+↓` de cinq, `PageUp`/`PageDown`
  d'une fenêtre, `Début`/`Fin` aux extrémités (`Fin` réarme le suivi du direct), et la
  **molette** de trois rangs par cran.
- **La vue répond** — c'est le seul endroit d'où une écriture part, vers le lot ou vers
  une session, et elle n'en part qu'après confirmation. Sa **zone de saisie** choisit sa
  forme selon le rang, et elle dit toujours laquelle :
  - la pipeline **attend une réponse et sa question propose des choix** : les options
    sont rendues `(1) …`, `(2) …` — `↑`/`↓`, `1`…`9` ou un clic choisissent, `Entrée`
    ouvre l'aperçu `Envoyer à <feature> · /<maillon> : « <libellé> »`, un second `Entrée`
    livre le libellé. La ligne `autre — saisir ma réponse` bascule sur l'éditeur libre,
    tampon vide ;
  - un **maillon du lot pose une question `ask`** : la question et ses options
    apparaissent **dans la conversation** — une question à la fois, 1 à 9 options — et la
    zone prend la même forme d'options, sa première ligne rappelant la question, chaque
    option portant la **description** que le maillon a fournie quand il y en a une.
    Choisir une option et presser **un seul `Entrée`** livre le libellé au maillon, qui
    repart **dans son tour en cours** : **aucun nouveau run n'est lancé**, et l'état du
    rang cesse d'être `attend réponse`. Un clic sur une option, lui, ne livre rien : il
    ouvre l'aperçu, comme partout ailleurs.
    Les options d'une feature en attente, elles, viennent du **texte** de la question
    (forme `- (1) <libellé>`, une par ligne) — la convention que le lot impose à ce
    dialogue-là ; celles-là n'ont pas de description, et leur réponse passe par l'aperçu ;
  - la pipeline **attend une réponse sans choix** (ou vous avez choisi « autre ») :
    `Réponse : <tampon>▏`, avec la question du maillon **toujours peinte au-dessus**
    pendant la rédaction. Les caractères imprimables s'ajoutent, un texte collé entre
    d'un bloc (borné à 4 000 caractères, notice `message tronqué à 4000 caractères`
    au-delà), `⌫` efface. **Un seul `Entrée` livre** la réponse à une question `ask` en
    vol — c'est le seul geste du panneau qui n'a pas d'aperçu, parce que la question
    attend ; partout ailleurs (message à un run vivant, mise en file, reprise d'une
    session), `Entrée` ouvre l'aperçu, et c'est le second `Entrée` qui livre. `Échap`
    revient au tampon intact, et il le **conserve** : revenir à la liste puis rouvrir la
    vue du même rang restitue le brouillon dans un éditeur libre — une livraison réussie,
    elle, l'oublie. Un tampon vide est refusé (`réponse vide`), l'éditeur reste ouvert ;
  - la pipeline **travaille** et son run est **vivant** : le même éditeur, mais l'aperçu
    dit `Envoyer au maillon — injecté dans son tour en cours`. Le message part dans la
    boîte de réception du run, que le maillon consomme : il en tient compte **dans le
    tour en cours**, avant de rendre la main, et **aucun nouveau run n'est lancé**. La
    notice `message transmis au maillon` accuse la livraison ; un message confirmé juste
    avant la mort du run est reporté au prochain run plutôt que perdu ;
  - la pipeline **travaille** sans run vivant joignable (rang tenu par un process d'une
    version antérieure) : l'aperçu dit `Mettre en file pour <feature> · … le message part
    au prochain maillon`. Le run en cours n'est ni interrompu ni avorté, le message attend
    dans la **file** de la feature et part avec le prochain run que le pilote démarre pour
    elle. La liste l'annonce (`· 1 message en attente`), et la file est bornée (9
    messages, 12 000 caractères) ;
  - la pipeline est **bloquée** : le même éditeur libre, et ta réponse relance le maillon
    **dans sa session** (`--resume`) avec son contexte — il reprend là où il s'était
    arrêté, et la chaîne du lot repart ;
  - le rang est une **session terminée** hors lot : le même éditeur, et ta réponse lance
    un **nouveau run sur cette session** (`--resume`) — elle s'ajoute à la conversation
    que tu as sous les yeux ;
  - la pipeline **ne tourne pas** (terminée, échouée, annulée, à venir, ou arrêtée sur un
    jalon de specs/revue) : `lecture seule — <raison>`, avec la raison écrite en toutes
    lettres. Aucun champ de saisie n'est offert — un champ absent est plus honnête qu'un
    champ qui refuse. Une **session vivante dans un autre process** y tombe, avec son
    motif (`cette session appartient à un autre process (pid <n>)`) : rien n'entre dans un
    run qui ne nous écoute pas, et **rien n'est envoyé**.
  Deux refus protègent l'arbre de travail lui-même : écrire dans une ligne dont un
  **maillon du lot travaille déjà dans ce worktree** (`un maillon du lot travaille dans ce
  worktree` — deux agents sur le même arbre se marcheraient dessus), et écrire dans une
  ligne qui **est ta propre session** (`c'est ta session — réponds-y directement`, sinon
  le pilote relancerait un run sur le fichier que tu as ouvert). Les jalons du lot sont
  aussi accessibles **depuis la vue**, zone fermée : `v`, `y`, `R`, `c`, `o` y font
  exactement ce qu'ils font dans la liste, et l'on revient à la transcription après
  l'action — c'est là qu'on lit ce qu'on valide.
  Une question à choix se répond donc **sans quitter le panneau**, jusqu'à la clôture
  d'une collecte `/req` : la chaîne enchaîne ensuite toute seule sur le maillon suivant.
  Pendant qu'une conversation est ouverte, le lot continue d'enchaîner ses autres
  maillons — la vue ne met rien en pause.
- **`o`** rejoint vraiment la session correspondante (la bascule OMP, avec son
  transcript) — y compris inter-processus, inter-dépôts et depuis un worktree voisin : la
  session courante est d'abord amenée sur le répertoire de travail enregistré par la
  cible, donc les commandes suivantes partent de là, et la session quittée reste intacte
  et reprenable (seul le périmètre de la **session** change : réglages et plugins du
  processus, eux, ne bougent pas). Deux refus, avant toute lecture disque : tant qu'un
  **run vit** sur la ligne (deux écrivains sur un fichier de session le corrompraient —
  la ligne le dit, `Entrée` reste disponible), et quand la ligne **est** la session
  courante du processus (viser la sienne abandonnerait le tour en cours). Si le fichier
  de session n'existe pas (ou pas encore écrit sur le disque), ou s'il ne porte pas
  d'en-tête de session valide, le panneau **reste ouvert** et le dit : basculer vers un
  chemin absent — ou vers un fichier de 0 octet — créerait une session vide à la place.
  Même refus, avec sa cause, quand le répertoire de travail enregistré par la cible a
  disparu (worktree archivé) : le panneau nomme le chemin manquant et rien n'est créé.
  Après une bascule réussie, le panneau se referme.
- **`d`** supprime l'entrée d'historique sélectionnée, définitivement et sans
  confirmation (une entrée à la fois). Sur une pipeline en cours, il ne supprime rien et
  le dit.
- **`↑`/`k`, `↓`/`j`, `Entrée`, `o`, `d`, `ctrl+o`, `Échap`/`Ctrl+C`** — c'est un overlay
  focalisé : tant qu'il est ouvert, aucune touche n'atteint l'éditeur, et `Échap` est le
  seul moyen de le fermer depuis la liste (depuis la vue de session, il ramène à la
  liste). Dans la vue, **`ctrl+o`** bascule d'un coup le dépliage de **toutes** les
  entrées repliables — les cartes d'appels d'outils, les messages d'affichage, les
  résumés — exactement comme dans le transcript d'OMP, et le pied le rappelle
  (`ctrl+o déplier/replier`). C'est la touche de pliage native d'OMP, et l'hôte la cède
  au panneau tant que l'overlay est ouvert : elle ne vole rien à la saisie, même quand la
  zone de réponse contient du texte. Le **texte de l'éditeur est restauré** à la
  fermeture.
- **À la souris** : le clic gauche prend la ligne visée — et, dans la vue, l'option
  visée — et la molette déplace la sélection d'un cran dans la liste, ou **trois rangs**
  de transcription dans la vue (le facteur du lecteur plein écran d'OMP). Conséquence
  assumée du plein écran : tant que le panneau est ouvert, la sélection de texte native
  du terminal est capturée par le panneau.
- **La sélection est mémorisée par dépôt** : fermer le panneau puis le rouvrir (`alt+w`)
  rend la même ligne — et la vue de session s'ouvre par `Entrée`, se referme par `Échap`,
  sans qu'aucune commande soit à retaper.
- **Une ligne par feature** : dès qu'une feature du lot a un run, c'est **sa** ligne qui
  porte le maillon, l'état et le temps de ce run — elle n'apparaît jamais deux fois (une
  ligne de lot + une ligne « en cours »). Ce qui reste dans « en cours », ce sont les
  pipelines hors lot (autres dépôts, autres sessions) ; l'historique, lui, garde une
  trace par maillon terminé.
- **Fin de pipeline** : un cycle clos par `/review` sans bloquant quitte la liste des
  pipelines en cours et rejoint l'**historique** avec l'état `terminé` ; un processus
  qui disparaît sans terminer y entre en `échoué` (constaté par le premier lecteur, à
  partir du pid du propriétaire). L'historique vit sur le disque : il survit aux
  redémarrages d'OMP, et `d` est le seul moyen d'en retirer une entrée.
- **Où c'est écrit** : `<état>/running/<id>.json` (une entrée par pipeline, écrite par
  son propriétaire, remplacée atomiquement) et `<état>/history/<id>.json`, sous
  `~/.omp/agent/pipeline` — ou `MEM0_PIPELINE_STATE_DIR`. Le magasin reste des fichiers :
  c'est ce que lisent le panneau et l'app. Les **maillons**, eux, sont exécutés par le
  **service** (`/service start`, un seul process `omp` pour toute la machine) : le
  panneau et l'app lui envoient leurs gestes par son API locale, et plus aucune session
  terminale ne pilote un lot.
- **Le canal de commande** : `<état>/commands/` reçoit des commandes d'un client
  extérieur (un fichier JSON par commande, écrit dans un temporaire puis renommé), et
  le pilote propriétaire du dépôt visé les prend en charge en écrivant son accusé dans
  `<état>/commands/acks/<id>.json` — `prise en charge` avant d'agir, ou `refusée` avec
  son motif. Les commandes sont `launch` (créer le lot et lancer une feature), `add` et
  `remove` (modifier la liste à chaud), `models` (modèles et replis d'une feature : une clé de
  repli absente laisse le repli inchangé, `null` le retire), `quota` (choisir le repli d'un
  fournisseur épuisé : `{provider, model}`), `verdict` (`v` ou `y`, comme les touches du
  panneau), `answer` (répondre à une question en vol d'un run), `reply` (répondre à une
  question en texte d'un maillon terminé : le maillon repart sur sa session), `relaunch`
  `{slug}` (rouvrir un crédit de correction et relancer une feature `bloqué`, `échoué` ou
  `annulé` ; refus `relance possible sur une feature bloquée, échouée ou annulée` sinon),
  `cancel` `{slug, fate}` (abandonner une feature ; `fate` = `keep`, `archive` ou `delete`
  pour le sort du worktree), `start` (ouvrir le lot brouillon → en marche et lancer ses
  features en attente), `arbitrage`, `avance` et `stop` (interrompre le pilote). Un même
  identifiant rejoué ne produit ni second accusé ni second effet.
  - **`arbitrage` `{slug, text}`** : en **un seul geste journalisé au lot**, ajoute au
    contrat de la feature (`.omp/pipeline/contract.md` de son worktree) un paragraphe
    `### Arbitrage du <date UTC>` sous la section `## Arbitrages du pilote` (créée au
    besoin), **puis relance** la feature ; les prompts de lot suivants renvoient le run à
    cette section, qui prime sur ses hypothèses. **Tout ou rien** : une feature qui ne peut
    pas être relancée est refusée AVANT l'accusé (refus nommés ci-dessous, rien n'est
    écrit) ; si la relance échoue APRÈS l'accusé `taken` (dépendance ou worktree disparu
    entre-temps), le contrat est restauré octet pour octet, rien n'est journalisé et un
    avis `[pipeline] commande arbitrage : <motif> — contrat restauré` est émis. L'arbitrage
    **n'annule jamais** une feature : une feature vivante est
    refusée, pas arrêtée. Refus nommés, dans l'ordre : `arbitrage vide` ;
    `arbitrage refusé : la feature est figée sur une question en vol` ;
    `arbitrage refusé : la feature est en cours` ;
    `arbitrage refusé : la feature est figée sur une question` ;
    `arbitrage refusé : la feature attend la validation d'un jalon` ;
    `arbitrage refusé : un maillon tourne dans le worktree` ; `arbitrage en cours — la
    décision sera consignée au journal` (l'arbitre juge la feature) ; `relance possible sur
    une feature bloquée, échouée ou annulée` ; `arbitrage impossible : la feature n'a pas de
    worktree` ; puis, avant l'accusé et sans rien écrire, les refus de la relance
    (dépendance non terminée, `worktree introuvable sur le disque`, `worktree sans
    branche`). L'entrée de journal porte `kind: "arbitrage"` et la source `utilisateur`.
  - **`avance` `{slug}`** : fait avancer le worktree d'une feature **au repos** sur sa base
    distante. Le service lit l'URL et la branche par défaut par `gh repo view`, récupère la
    base en **HTTPS** (jamais SSH, aucune clé) dans une référence privée
    `refs/omp-pipeline/avance/<slug>`, puis applique `git merge --ff-only` : jamais de
    réécriture, jamais de merge commit. Refus nommés, sans rien modifier :
    `avance impossible : la feature n'a pas de worktree` ; `avance refusée : un maillon
    tourne dans le worktree` (aucun `gh`, aucun fetch, aucun merge) ; `avance impossible :
    worktree introuvable sur le disque` ; `avance impossible : gh indisponible` /
    `gh repo view : <erreur>` / `URL HTTPS du dépôt introuvable (gh repo view)` ;
    `avance impossible : fetch : <erreur>` ; **`avance refusée : non fast-forward`** quand
    la branche a divergé de la base ; `avance refusée : modifications locales en conflit
    avec <base> : <chemins>`. Succès (ou déjà à jour) : journal `kind: "avance"`, question
    `avance sur <base>`, réponse `<ancien HEAD> → <nouveau HEAD>`. La base mémorisée de la
    feature (`base`) n'est pas modifiée.
  - **Journal** : `arbitrage` et `avance` sont deux **kinds** d'entrée du journal du lot
    (source `utilisateur`). OMP Console saute les entrées de kind inconnu : aucune mise à
    jour de l'app n'est nécessaire. Ni l'app ni le panneau n'émettent ces deux commandes :
    elles viennent des outils de pilotage (« Outils de pilotage », plus haut).
  L'app **omp-console** est un de ces clients : elle dépose ses gestes par ce canal et
  par les boîtes des runs, et affiche l'accusé du pilote (voir « Agir depuis le
  Kanban » de `omp-console/README.md`).

## Lot de features

Un **lot** enchaîne plusieurs features : chacune a son pipeline (les quatre maillons
`/req` → `/specs` → `/impl` → `/review`), et le lot les fait avancer **tout seul** — un
maillon par run, exécuté par le service — en ne s'arrêtant que là où il a besoin de toi.
Il se pilote entièrement depuis le panneau, et ses gestes partent au service par son API.

```
────────────────────────────────────────────────────────────────
 Pipelines · 0 processus
 Lot · mem0-omp · 3 features · 0 terminée · 1 bloquée · 0 échouée
 · 0 annulée · 2 en cours
 ❯ isolation-worktree             /specs · attend validation · 1:20
   base-qdrant ← isolation-worktree      /req · en attente · 0:12
   panneau-lot                           /impl · bloqué · 4:03
   panneau-lot                           arrêt : revue bloquante
 Hors lot · 0
 aucune pipeline en cours
 ──────────────────────────────────────────────────────────────
 Historique · 0
 aucun historique
 a ajouter · l lancer · Entrée session
 v valider · c annuler · o rejoindre
 Échap fermer
────────────────────────────────────────────────────────────────
```

La **seconde ligne de pied** est contextuelle : elle n'annonce que les touches qui
s'appliquent à la ligne sélectionnée (`Entrée répondre`, `Entrée écrire`, `v valider`,
`y accepter`, `R relancer`, `x retirer`, `c annuler` — `aucune action` si aucune ne
s'applique), et elle est peinte **dans tous les cas**. `d supprimer` n'apparaît que sur
une entrée d'historique, le seul rang qu'il supprime ; `o rejoindre` que sur un rang qui a
une session. `a ajouter` et `l lancer` n'apparaissent que si un pilote de lot existe dans
la session : sans lui, les deux touches refusent et ne s'annoncent pas.

Un état **bloqué** ou **échoué** porte sa raison sur un second rang de la même entrée
(`arrêt : <motif>`) : `bloqué` ne dit pas pourquoi, le motif le dit. Une feature qui attend
un jalon garde ce jalon dans sa colonne d'état (`attend validation`, `attend réponse`,
`attend accord`) que son run ait publié son entrée ou non, et le temps affiché se mesure
depuis l'instant **le plus ancien** des deux — publier une entrée ne fait jamais reculer
l'horloge sous tes yeux.

**Tout geste qui change l'état du lot s'annonce avant d'agir** : `l` (lancer), `x`
(retirer), `R` (relancer), `v` (valider les specs), `y` (accepter la revue), `m`
(modèles), `c` (annuler, après le choix `1 gardé · 2 archivé · 3 supprimé`) et le dernier
champ d'un `a` (ajouter) affichent d'abord un **aperçu** — le destinataire, la transition
d'état, la conséquence — puis attendent `Entrée` pour agir. `Échap` revient en arrière
sans aucun
effet, tampon compris. Rien n'est écrit avant la confirmation, et un refus du pilote
s'affiche tel quel au lieu d'être avalé.

- **Ajouter** (`a`) : trois champs — nom, **Description** (elle amorce la collecte),
  dépendances (slugs séparés par des virgules, vide admis) — puis, quand des modèles connus
  existent, **quatre étapes** : `Modèle cadrage+revue`, `Repli cadrage+revue`, `Modèle exécution`,
  `Repli exécution`. La liste des
  modèles connus s'y affiche avec `défaut OMP (aucun modèle)` en tête ; la liste d'un **repli**
  commence par `aucun repli` puis reprend les modèles connus **sans le principal choisi juste
  avant** (`défaut OMP` n'est jamais un repli). `↑`/`↓` (ou `k`/`j`)
  déplacent le curseur, une frappe **filtre** la liste (Retour arrière l'efface, un filtre
  sans résultat le dit), `PageUp`/`PageDown` font défiler la fenêtre, `Entrée` valide le
  choix affiché (sur la dernière étape, il ouvre l'aperçu) et `Échap` rend l'étape précédente —
  le champ des dépendances depuis la première —, tampon compris. Le curseur partant sur la
  première ligne, `Entrée` seul reproduit le comportement d'avant : la feature naît sans
  modèle ni repli. L'aperçu n'annonce que les groupes **renseignés**, chacun suivi de son repli
  (`Créer gamma ? · 0 dépendance(s) · cadrage+revue anthropic/claude-opus-4-7 (repli aucun)`). Le worktree de la
  feature est créé au lancement (`feat/<nom>`), jamais à l'ajout. **Modèles** (`m`) ouvre les
  quatre mêmes étapes, pré-positionnées sur les valeurs courantes (le repli actuel, ou
  `aucun repli`), puis un aperçu
  (`Modifier les modèles de gamma ? · cadrage+revue <A|défaut OMP> (repli <R|aucun>) · exécution <B|défaut OMP> (repli <R|aucun>)`) : `Entrée`
  applique, un refus du pilote s'affiche tel quel — un repli identique au principal du même
  groupe est refusé —, et un run déjà lancé n'est ni interrompu
  ni relancé — le run suivant relit la valeur courante. Sans modèle connu, `m` le dit
  (`aucun modèle connu — modèles inchangés`) sans rien ouvrir. **Retirer** (`x`) enlève une
  feature qui n'a pas encore démarré.
- **Lancer** (`l`) : chaque feature démarre son maillon courant, dans la limite de
  `MEM0_PIPELINE_SLOTS` (4 par défaut) — au-delà, les features runnables restent `pending`
  avec le motif *attend un créneau* dans `/pipelines`, et démarrent dans l'ordre du lot dès
  qu'un run se termine. Deux features sans dépendance ne s'attendent jamais, tant qu'il reste
  un créneau.
- **La chaîne** : collecte → specs → implémentation → revue → livraison. Elle ne s'arrête
  que sur trois jalons : une **question** de l'agent, la **validation des specs** (`v`),
  l'**accord de fin de revue** (`y`). Entre deux jalons, tu n'as rien à lancer. Une question
  posée **en texte** (pas par l'outil `ask`) arrête la chaîne de la même façon, quel que soit
  le maillon : la feature passe *attend réponse*, et ta réponse la relance dans sa session.
- **L'implémentation par lot (impl par lot)** : à la validation des specs (`v`), si la
  section `## Lots` du contrat compte **au moins deux** lots (`BR-<n> — type: …`, le tiret
  pouvant aussi être `–` ou `-` entouré d'espaces), le
  pilote **fige** la découpe (`implLots`, `implLot` dans le lot de la feature) et lance
  **un run `/impl` par lot, chacun dans une session neuve**, au lieu d'un seul run pour
  tout le contrat. Le prompt du run du lot *i* porte, après la graine et avant la
  directive de lot, la ligne `[lot <id> (<i+1>/<N>)] Implémente UNIQUEMENT le lot <id> du
  contrat. Lots déjà faits : … Lots suivants (autres runs) : ….` ; le panneau affiche la
  phase `/impl <id> (<i+1>/<N>)`. Chaque run de maillon reçoit aussi un bloc
  `[extrait du contrat]` — les seules sections utiles à sa phase (`/specs` : Besoins + AC ;
  lot `BR-k` : Besoins + AC + `## Documentation` (≤ 15 000 caractères) + les `S-n` que le
  lot cite + le bloc `BR-k` ; `/impl --fix` : AC + Revue + Corrections ; release :
  Besoins + AC + Revue ; `/review` lit le fichier entier) — et, pour un lot `BR-k` avec
  k > 1, un bloc `[résumé du run précédent]` (dernier message du run du lot précédent,
  ≤ 2 000 caractères). Les directives ne demandent plus qu'une lecture du contrat, sans
  relecture après écriture (le pilote détecte seul une section disparue), et
  n'ouvrent le fichier que si une référence manque à l'extrait. Quand un lot finit, le lot
  **suivant** part à la place de la revue ; après le dernier, la découpe est effacée et la
  chaîne passe à `/review`
  comme avant. Une question, une réponse, une relance ou une reprise après quota d'un
  lot reprennent **la session de ce lot**. Un contrat réécrit pendant l'impl ne change
  pas la découpe en cours. Avec moins de deux lots : un seul run, comme avant. Les
  directives `/specs`, `/impl` et `/review` demandent en plus de déléguer la lecture du
  dépôt à des sous-agents, sous la borne de contexte décrite à « Contexte des runs »
  (compaction au seuil, échec du run au plafond). La boucle de correction
  (`/impl --fix` en **un seul** run, sans ligne `[lot …]`), l'accord de fin de revue et la
  livraison (commit, push, PR) ne changent pas.
- **La boucle de correction** (`/impl --fix` → `/review`) tourne seule, dans la limite de
  `MEM0_PIPELINE_REVIEW_CAP` tours (3 par défaut) : au-delà, la feature passe *bloqué* au
  lieu de boucler. Deux garanties de fond : `/impl --fix` consigne ses levées dans une section
  `## Corrections` et **n'écrit jamais** dans `## Revue` (seule `/review` écrit le verdict), et
  une revue qui rend la main **sans réécrire** `## Revue` est jugée *illisible* — jamais
  « propre » sur le verdict laissé par la correction précédente. Le verdict est lu dans la
  **dernière** section `## Revue` du contrat. L'en-tête du champ accepte `BLOQUANTS :`,
  `BLOQUANTS:` et `BLOQUANTS (2) :` (le nombre entre parenthèses est ignoré). « Aucun
  bloquant » s'écrit `- BLOQUANTS : aucun`, `Aucun bloquant.`, `aucun (tous levés)` ou
  `néant` ; une ligne **ambiguë** (`Aucun bloquant ; voir …`, `… mais …`, `… sauf …`, un
  bloquant numéroté barré `1. ~~…~~`) rend le verdict *illisible*, jamais « propre » — un
  bloquant explicite prime. Le compte est celui des lignes non vides et non barrées du
  champ, quelle que soit leur forme (numérotée, puce, phrase libre).
  **Verdict croisé** : la table `AC PAR AC` de la revue est relue aussi — avec
  `BLOQUANTS : aucun`, un critère en `fail`, « aucun test »/« sans test » ou un `AC-<n>` du
  contrat absent d'une table présente rend le verdict *bloquant*, un bloquant par critère
  (« AC-n : échec en AC PAR AC », « AC-n : non prouvé en AC PAR AC (aucun test | absent de
  la table) »), que `/impl --fix` reçoit en tête de prompt. Limite : sans aucune table
  `AC PAR AC`, le champ `BLOQUANTS` seul décide.
  **Revue illisible** sous le plafond : la **même** session de revue reprend (`--resume`)
  avec la seule consigne de réécrire `AC PAR AC` et le champ `BLOQUANTS` au format exact,
  au lieu d'une revue neuve. **Revue incrémentale** : après une correction, tant que
  `0 < fixes < plafond − 1`, le prompt de `/review` porte `[revue incrémentale]` et les
  bloquants de la revue précédente — lecture bornée aux bloquants levés, à `## Corrections`
  et aux fichiers nommés, tous les critères relancés, verdict complet ; la première revue et
  les deux derniers tours sont intégraux.
  Deux compteurs la bornent, chacun à `MEM0_PIPELINE_REVIEW_CAP` : `fixes` (tours
  `/impl --fix` consommés) et `unreadableRuns` (revues illisibles d'affilée, remis à zéro par
  tout verdict lisible) ; tous deux sont comptés au lancement du run et remis à zéro par une
  relance `R`. Le panneau affiche le compteur tel quel : `--fix · tour <fixes>/<plafond>` pendant
  une correction, `tour <unreadableRuns>/<plafond>` pendant une revue illisible relancée,
  rien quand il vaut 0. À la fin d'une revue, `feature.lastVerdictModel` retient le modèle
  **effectivement** utilisé au dernier tour (après repli) et la notification de fin de revue
  le nomme.
- **Tout autre blocage est un échec arbitré** : un verdict de revue illisible au plafond,
  « /impl n'a rien produit », « aucune spécification écrite par /specs », un contrat endommagé
  ou un worktree invérifiable sont relayés à `/audit`/`/project` comme un **échec**
  (élément `failure`) et arbitrés : l'arbitre relance au maillon courant ou escalade, sous la
  même borne de 2 relances. Seuls le plafond de revue, un quota et un blocage hérité d'une
  dépendance gardent leur traitement propre.
- **Un run en échec ne passe pas pour un succès** : un maillon dont le dernier tour finit en
  erreur d'API (`stopReason: "error"`) autre qu'un quota passe *échoué* (`failed`), avec le
  message d'erreur pour motif d'arrêt — un quota garde son blocage et son repli de modèle. Un
  `/impl` (avec ou sans `--fix`, et chaque lot d'impl) qui rend la main sans avoir changé le
  worktree — `git status --porcelain` vide et `HEAD` inchangé depuis le début du run ; le
  contrat `.omp/pipeline/`, ignoré par git, ne compte pas — passe *bloqué* (`blocked`)
  « /impl n'a rien produit » au lieu d'enchaîner `/review` ; une question posée en texte
  garde la priorité, et une vérification git impossible bloque aussi (« vérification du
  worktree impossible : … »).
- **Un contrat endommagé bloque la feature.** Au lancement de chaque run (`/req`,
  `/specs`, `/impl` y compris `--fix`, `/review`), le pilote retient les titres
  `## Besoins`, `## Critères d'acceptation` et `## Spécifications` présents dans le
  contrat. Un run qui se termine en succès après avoir fait **disparaître** l'un d'eux
  passe la feature en `blocked`, raison « contrat endommagé par /<phase> — section(s)
  disparue(s) : … », et aucun maillon suivant ne part. Seule la disparition du titre
  compte : une section vidée mais présente, ou absente dès le départ, ne déclenche rien.
  Le maillon de livraison (release) et le mode interactif sont hors garde.
- **Une question de l'agent ne consomme pas le budget du run** : le délai du maillon est
  suspendu tant qu'une question est en vol, et une question qui arrive déclenche une alerte
  (transcript + toast) avec son texte — sans elle, un maillon pouvait expirer en « délai
  dépassé » pendant que tu réfléchissais.
- **Répondre** (`Entrée` sur la ligne, puis la zone de saisie de la vue) : dans un run
  lancé par le panneau, le maillon dispose d'un outil
  `ask` à options — **une question à la fois, 1 à 9 options**. La question s'affiche dans
  la conversation, où tu sélectionnes une option ; **un seul `Entrée`** livre la réponse,
  qui repart dans le maillon **sans lancer de nouveau run** : la question se résout dans
  le tour en cours, et la chaîne reprend à la fin de ce tour. Un message tapé pendant que
  le maillon travaille lui est **injecté dans le tour en cours** (celui-là passe par
  l'aperçu), même sans question posée. Quand un maillon a fini son tour (état « attend
  réponse » ou « bloqué »), ta réponse le relance **dans sa session** (`--resume`) : il
  reprend exactement là où il s'était arrêté. Hors lot, un run n'est pas armé : le maillon
  garde ses questions en clair, reprises dans l'alerte durable du transcript.
- **La livraison** : après ton accord, un dernier run met **un** commit (message
  conventionnel, aucune version touchée — le bump appartient au job de release, qui
  le calcule après la fusion) et écrit le corps de la PR ; le
  pilote **pousse la branche vers l'URL HTTPS du dépôt** (jamais `origin` en SSH) puis
  ouvre la PR avec `gh` — son URL est consignée dans le panneau.
- **Relancer** (`R`) repart du maillon courant d'une feature bloquée, échouée **ou
  annulée** (dont le worktree est conservé), sans toucher aux autres pipelines — et sans
  repartir tant qu'une dépendance de la feature n'est pas terminée
  (`dépendance <nom> non terminée`). **Annuler** (`c`) te fait choisir
  le devenir du worktree :
  `1` conservé en place, `2` archivé (les fichiers ignorés — le contrat, les caches — sont
  copiés sous `~/.omp/pipeline-archive/…`, puis le worktree est retiré), `3` supprimé —
  **la branche reste** dans les trois cas. Une feature *bloquée* ou *échouée* s'annule
  aussi : c'est la seule façon d'abandonner un pipeline que le plafond de correction a
  arrêté, en gardant la main sur son worktree.
- **Dépendances** : une feature ne démarre qu'après la fin de celles dont elle dépend, et
  reste *bloqué* si l'une d'elles échoue, se bloque ou est annulée — **mais elle repart
  seule** dès que sa dépendance redevient saine (aucun `R` à donner). Le worktree d'une
  dépendante part de la **branche de sa dépendance** : elle voit donc le code dont elle
  dépend, sans attendre une fusion.
- **Le récap** : quand le dernier pipeline atteint un état terminal, le lot poste son
  décompte (terminées, bloquées, échouées, annulées) dans le transcript ; si une relance
  repart, le récap suivant décrit le VRAI état final.
- **Où c'est piloté** : `<état>/lots/<sha1(realpath(dépôt))[:16]>.json`, écrit par **un
  seul** process, le pilote. Fermer ce process ne perd pas le lot : la première session
  qui le rouvre le **reprend**. Les runs en cours sont **tués** à la fermeture de la session
  pilote (sinon ils survivraient sans pilote ni échéance), et une feature dont le run vit
  encore n'est ni relancée ni jugée au moment de la reprise : la nouvelle session attend sa
  fin. Le pilote est **un par dépôt** : rejoindre une session d'un autre dépôt puis revenir
  ne casse pas le lot en cours. Un lot dont le battement du propriétaire est périmé (plus de
  cinq périodes) est tenu pour abandonné même si son pid vit encore (pid réutilisé).
- **Une feature ouverte par `/req`** suit exactement la même chaîne : sa collecte se
  déroule dans ta session (avec les questions à options d'`ask`), puis le lot prend la
  main dès `/specs`. `/specs`, `/impl` et `/review` restent utilisables à la main tant
  qu'aucun lot ne pilote la feature. Une feature de lot ajoutée par `a` **ne démarre
  qu'au `l`** : l'inscription d'une collecte `/req` ne lance pas les autres.
- **Pipelines lancées par `/audit`** : chaque élément lancé entre dans le lot (section
  *Lot* du panneau, même pilote) et démarre sans attendre `l`, même si le lot est au
  brouillon — ses autres features attendent toujours `l`. Les éléments lancés ensemble
  tournent en parallèle **dans la limite de `MEM0_PIPELINE_SLOTS`** (les autres attendent un
  créneau) ; un élément qui dépend d'un autre élément choisi reste en
  attente (`slug ← dépendance`) jusqu'à ce que celui-ci soit terminé, puis part de sa
  branche.
  Tant que la session `/audit` est la session **courante** du process pilote, elle est
  le **relais** de ces pipelines, mais elle ne répond plus : chaque question d'un maillon
  et chaque jalon (« specs validées », « revue propre ») est tranché par un **arbitre** —
  une session d'un instant, neuve, qui lit le **rapport** de l'audit, le brief, le contrat,
  le **journal du lot** (toutes les features du même audit), le journal de la feature et le
  dépôt en **lecture seule** — sans aucun tour de la session `/audit`. La décision est
  **consignée au journal** (source `contexte` ou `arbitrage`, avec sa justification) et la
  chaîne repart. L'arbitre tranche tout choix technique ; il **escalade** seulement un
  choix de produit (nouveau besoin non couvert par le rapport ou le brief, changement de
  périmètre, texte visible par l'utilisateur sans convention dans le dépôt) : la feature
  reste alors en attente et la session `/audit` reçoit UN
  message `[audit] escalade — <feature> /<maillon> : <question>` (options numérotées, `motif
  de l'arbitre`) ; elle te le remonte par `audit_escalate` (dialogue avec la question et les
  options d'origine), et ta réponse — ou `Valider les specs` / `Accepter la revue et livrer
  (PR)` — part **mot pour mot**, source `utilisateur`. Les outils `audit_reply` et
  `audit_approve` n'existent plus : la session ne répond jamais seule. Elle reçoit encore
  les groupes de quota ; le plafond de la boucle revue ⇄ correction et l'échec d'un run
  lui sont relayés **directement** quand le lot n'a pas d'arbitre, et seulement **escaladés**
  sinon (un échec est un élément `failure`, message `[audit] Échec — feature <slug>`,
  dialogue « Relancer la feature » / « Abandonner la feature (worktree et branche
  conservés) ») ; aucune PR n'est ouverte avant ta décision. Quand plusieurs pipelines
  demandent en même temps, leurs dialogues s'ouvrent **un à la fois**, dans l'ordre des
  demandes. Pendant un
  arbitrage le panneau affiche `arbitrage en cours` et refuse réponse, `v` et `y`
  (`arbitrage en cours — la décision sera consignée au journal`, de même par la commande de
  canal). Une feature escaladée n'est plus jamais arbitrée pour la même question : seule une
  action de ta part la débloque. **Session fermée** : l'arbitrage et la tenue des escalades
  continuent dans le service ; le panneau affiche sous la feature `escalade /<maillon> :
  <question>` et accepte Entrée, `v` et `y` (source `utilisateur`). **Rouverte** (`/resume`),
  la session relit le lot et le journal et ne se voit réinjecter, une fois par armement, que
  les escalades en attente — jamais une décision déjà au journal. Tant qu'elle est ouverte,
  le panneau affiche `relayé à /audit` pour ces escalades et refuse d'y répondre. Rien
  n'est jamais fusionné. Le battement du relais vit dans
  `<état>/audit/<sha1(session)[:16]>.json`. Les règles de l'arbitre (corpus, lecture seule,
  justification, options, vérifications des jalons) sont décrites sous « Le pilote du
  lot », dans la section *Projet*.

  **Rapport, brief et journal** : l'outil `audit_propose` exige un `rapport` non vide — le
  texte complet de l'analyse (faiblesses, features proposées, fichiers, symboles et chemins
  cités) ; absent ou vide, il est refusé comme un brief manquant (`Error: rapport is
  missing` / `is empty`), avant tout dialogue. Il exige aussi un `brief` (`purpose`,
  `function`, `decisions`, `constraints`, `nonGoals`). Après la sélection et la validation
  des intentions, **avant** les questions de modèle, tu valides le brief dans un éditeur
  titré `Brief de l'audit — …` (mêmes cinq rubriques que pour `/project`, mêmes règles :
  rubrique absente → l'éditeur rouvre, Échap n'écrit rien) ; il est écrit tel que tu l'as
  validé dans `<état>/briefs/<sha1(session)[:16]>.md`, et le rapport, tel que l'agent l'a
  fourni, dans `<état>/reports/<sha1(session)[:16]>.md` au même instant — sans brief écrit
  (Échap, aucune pipeline retenue), aucun rapport n'est écrit. Un nouvel `audit_propose`
  validé dans la même session réécrit le brief et le rapport. Chaque run d'une feature de
  l'audit reçoit ce brief et le journal de sa feature (`<état>/journal/…jsonl`, voir
  « Projet ») dans son prompt ; le rapport, lui, n'est lu que par l'arbitre.

  **Audits lancés depuis OMP Console** : la section Audit de l'app ne passe ni par
  `/audit` ni par son relais. `POST /v1/audits` écrit un enregistrement
  `<état>/audits/<id>.json` (écrit par le seul service, jamais supprimé ; état
  `analysing`, `proposed`, `launched`, `stopped` ou `failed`) puis ouvre une session
  d'analyse interne au service, invisible de `GET /v1/sessions`, dont tout dialogue est
  refusé d'office. Elle enregistre ses propositions par l'outil `audit_report` (mêmes
  paramètres qu'`audit_propose`, dont le `rapport` obligatoire, aucun dialogue) : un
  `rapport` absent ou vide est refusé et l'audit reste `analysing` ; sinon le rapport est
  gardé en brouillon `<état>/audits/<id>.report.md` (il n'entre pas dans l'enregistrement
  publié aux apps). L'app montre les cases et le brief, et
  `POST /v1/audits/{id}/launch` écrit le brief validé, recopie le brouillon en rapport
  `<état>/reports/<sha1(clé)[:16]>.md`, puis ajoute les seules propositions
  cochées par le pilote du service. La **clé de contexte** de l'audit vaut
  `<état>/audits/<id>` : portée par `auditSession` de chaque feature lancée, elle isole le
  rapport, le brief, le journal et l'arbitrage — deux audits du même dépôt ne se mélangent
  pas. Un audit antérieur sans brouillon se lance sans rapport. Les
  escalades de l'arbitre se lisent dans le lot (`escalation`) et se répondent par
  `POST /v1/audits/{id}/escalations`, traduites en commande de pipeline (`answer`,
  `reply`, `verdict`, `cancel`). `DELETE /v1/audits/{id}` arrête l'audit : ses features non
  livrées sont annulées (dossier et branche gardés), ses PR déjà ouvertes restent, sans
  aucun appel `gh`. Une analyse coupée par l'arrêt du service passe `failed` au
  redémarrage ; le service recopie à chaque balayage la phase, l'état et la PR des
  features lancées dans l'audit.

## Projet

`/project [contexte]` conduit un projet du **dépôt principal** (pas du worktree d'une
feature), dans une session interactive — le contexte optionnel est transmis à l'agent.

- **Refus** : un dossier sans dépôt git, ou un dépôt sans distant GitHub (`git remote
  -v` : `origin` s'il désigne `github.com` en HTTPS, SSH ou `git@`, sinon le premier
  remote qui le désigne ; GitHub Enterprise n'est pas reconnu), est refusé avec la
  marche à suivre. `/project` ne crée **ni dépôt, ni distant, ni fichier** : les créer
  reste à ta charge.
- **Cadrage, puis plan** : une session neuve s'ouvre sur le cadrage. L'agent soumet son
  plan par l'outil `project_plan` — but, fonction, segments ordonnés de features
  (chacune un nom en kebab-case et une intention qui amorcera son `/req`). Si tu n'as pas
  dit « fin », l'outil te demande d'abord si le cadrage est complet. Il te montre le
  plan : **Valider**, **Corriger** (un éditeur où `## <segment>` ouvre un segment et
  `- <nom> — <intention>` ajoute une feature ; l'ordre des lignes est l'ordre du plan ;
  un texte illisible ou un nom déjà pris rouvre l'éditeur avec l'erreur) ou
  **Abandonner** (rien n'est écrit). À la validation, tu choisis le modèle **et le repli** de chaque
  feature pour `cadrage+revue`, puis pour `exécution` (quatre questions par feature), le document
  est écrit et le segment 1 part ; un amendement appliqué pose les mêmes quatre questions à ses
  features neuves.
- **Le document et sa branche** : `PROJECT.md` est le **seul** fichier de la branche
  orpheline `omp-project` (worktree privé `<état>/projects/<sha1(realpath(dépôt))[:16]>.doc`). Il porte le but,
  la fonction, chaque segment et ses features dans l'ordre, avec leur état, leur PR et
  leurs deux modèles ; les features retirées sont listées à part. Il est réécrit et **commité à
  chaque changement d'état** — plan validé ou modifié, feature lancée, PR ouverte,
  fusionnée, en échec, relancée ou retirée, projet arrêté, repris ou terminé — puis
  poussé vers l'URL HTTPS du dépôt (`gh repo view`). Un commit ou un push impossible est
  signalé une fois et ne bloque jamais les pipelines. Ne l'édite pas à la main.
- **La base de chaque segment** : au démarrage d'un segment, la branche par défaut du
  distant est récupérée en HTTPS (`git fetch <URL> +refs/heads/<défaut>:refs/omp-project/base`)
  et **chaque feature du segment part de ce commit** — donc du code de toutes les PR
  fusionnées du segment précédent, jamais du `HEAD` local. Distant injoignable ou vide :
  le segment attend, et réessaie toutes les 60 s.
- **Le relais `[project]`** : les features d'un projet sont des features du lot (section
  *Lot* du panneau, même pilote, pipelines parallèles dans la limite de
  `MEM0_PIPELINE_SLOTS`). Les questions et les jalons y sont tranchés par l'**arbitre**
  (rapport, brief, contrat, journal du lot, dépôt en lecture seule), consignés au journal, sans
  aucun tour de la session
  `/project` — même arbitre et mêmes règles que pour `/audit`. Tant que la session `/project`
  est la session courante, elle reçoit en message `[project]` les **escalades** de l'arbitre
  (`[project] escalade — <feature> /<maillon> : <question>`, options, motif), les échecs et
  les groupes de quota. Ses trois outils : `project_plan` (le plan), `project_amend` (sa
  modification) et `project_escalate` (te remonter l'élément ; ta réponse, ou ton `Valider
  les specs` / `Accepter la revue et livrer (PR)`, part **mot pour mot**, source
  `utilisateur`). La session ne répond jamais seule. Pendant un arbitrage le panneau
  affiche `arbitrage en cours` et refuse réponse, `v` et `y` ; session ouverte il affiche
  `relayé à /project` pour les escalades ; session fermée, la feature reste en attente sous
  `escalade /<maillon> : <question>` et tu réponds depuis le panneau. Rouverte, la session
  ne se voit réinjecter, une fois, que les escalades en attente.
- **Fusions** : `/project` sonde les PR du segment courant (`gh pr view`) au plus une fois
  par minute. Il ne fusionne **jamais** : quand toutes les PR du segment sont fusionnées
  (par toi), le segment suivant démarre seul ; quand le dernier l'est, le projet est
  terminé.
- **Échecs** : pipeline en erreur ou bloquée, plafond de la boucle revue ⇄ correction,
  abandon, lancement refusé ou PR fermée sans fusion — la feature est **en échec**, aucun
  segment suivant ne démarre, et l'échec te revient avec trois choix : **relancer** la
  feature, la **retirer** du plan (le segment s'achève sans elle), ou **arrêter** le
  projet (plus aucune pipeline n'est lancée ; celles en cours continuent sous
  `/pipelines`). Un plafond ou un échec d'une feature arbitrée n'est retenu qu'une fois
  l'arbitre passé : tant que l'arbitrage court, le projet n'en voit rien ; une relance de
  l'arbitre remet la feature en marche sans qu'elle ait été un échec de projet ; une
  escalade ou un abandon de l'arbitre devient l'échec habituel, avec le motif de l'arbitre
  dans la raison.
- **Évolution du plan** : `project_amend` propose la nouvelle liste des segments pas
  encore démarrés — ajout, retrait ou modification de features, sur ta demande ou à
  l'initiative de l'agent. Tu l'appliques, la corriges ou la rejettes : rien n'est
  appliqué sans ta validation, et aucun segment ne démarre pendant le dialogue. Le
  segment courant ne change jamais par cette voie.
- **Le brief durable** : `project_plan` porte aussi `decisions`, `constraints` et `nonGoals`
  (des listes de phrases courtes). Juste après l'éditeur du plan et **avant** les questions de
  modèle, tu valides le **brief** dans un éditeur (rubriques `## But`, `## Fonction`,
  `## Décisions`, `## Contraintes`, `## Non-objectifs`) : le texte que tu valides est écrit tel
  quel dans `<état>/briefs/<sha1(clé)[:16]>.md`, **avant** le plan. Une rubrique absente
  rouvre l'éditeur (`brief incomplet : rubrique « <X> » absente`) ; Échap n'écrit ni plan ni
  brief. Un `project_amend` appliqué rouvre l'éditeur sur le brief courant dont les rubriques
  fournies (`decisions`, `constraints`, `nonGoals`, `purpose`, `function`) sont remplacées ;
  Échap n'applique pas l'amendement. Le brief est relu depuis le fichier à chaque usage.
  **Le rapport du projet** : le `PROJECT.md` rendu est aussi écrit, tel quel, dans
  `<état>/reports/<sha1(clé)[:16]>.md` au plan validé puis à chaque amendement validé (et
  seulement alors) ; l'arbitre le lit comme rapport du contexte du projet.
- **Le journal et le contexte des étapes** : chaque décision appliquée — réponse à une
  question, « specs validées », « revue propre », choix d'un repli après un quota — s'ajoute,
  avec sa feature, sa question, sa réponse et sa source (`utilisateur` pour toi), à
  `<état>/journal/<sha1(realpath(dépôt))[:16]>.jsonl` (une ligne JSON par entrée, ajout seul ;
  une décision de l'arbitre y porte en plus sa justification).
  Le prompt de **chaque** run d'une feature du projet embarque, après le prompt de base, le
  brief (borné à 8 000 caractères : rubriques courtes entières, les lourdes coupées au
  prorata) et les entrées du journal **de cette feature** limitées à la phase courante et
  aux jalons (50 au plus, « (n décisions d'autres maillons omises) » sinon) : l'étape les
  lit avant de poser une question. Le **journal du lot** (les entrées de toutes les
  features du même projet ou audit) n'est lu que par l'arbitre.
- **Le pilote du lot** (l'arbitre) : une question d'une étape (`/req`, `/specs`, `/impl`, `/review`) ou un
  jalon (« specs validées », « revue propre ») d'une feature du projet n'est plus relayé à la
  session `/project` : le **service** tient **UNE session d'arbitre par lot**, ouverte au premier
  élément et **gardée tant que le lot vit** — chaque élément suivant, de n'importe quelle
  feature du lot, lui arrive comme un nouveau tour. La session se souvient donc du rapport,
  du brief, de ses décisions passées et de celles de l'utilisateur (une question déjà
  tranchée dans une feature sœur reçoit la même réponse ; une décision de source
  `utilisateur` prévaut). Elle a pour cwd le **dépôt principal** — chaque élément nomme le
  worktree de sa feature, lu par chemin absolu. **L'arbitre tourne toujours sur le groupe
  cadrage+revue (principal puis repli), quelle que soit la phase de l'élément arbitré**, et
  son modèle est fixé **par contexte**, pas par feature : la première feature du contexte qui
  déclare un modèle cadrage+revue le donne, avec son repli (le défaut OMP sinon) — deux
  features aux modèles différents ne rouvrent donc pas la session à chaque alternance. Épuisé
  pour quota, l'élément est escaladé, jamais basculé sur le groupe exécution. Les
  tours d'une **même session** sont **sériels** (la décision d'un élément est au journal
  avant que le tour du suivant ne soit construit) ; deux contextes avancent en parallèle.
  Un tour est borné à 10 minutes depuis son départ. Toute coupure (échéance, plafond de
  contexte, arrêt) **ferme** la session : le tour suivant la rouvre avec son message
  d'ouverture. Le pilote de lot en est le **propriétaire** : une session du service dont
  il n'a pas l'ouverture (contrôleur recréé) est fermée puis rouverte, jamais reprise à
  l'aveugle. Elle se ferme avec le récap de fin de lot ou l'arrêt du pilote. Le **plafond**
  de la boucle revue ⇄ correction et l'**échec** d'un run sont arbitrés aussi, et le
  **quota** épuisé a son propre traitement (sous-puces Plafond, Échec, Quota ci-dessous).
  - **Ouverture**, une fois par session : la directive, puis le **corpus du lot** — le rapport
    du contexte (`(aucun rapport)` quand il n'existe pas, sans bloquer), le brief et le
    **journal du lot** (les entrées de toutes les features du même audit ou projet, bornées
    aux N dernières par `MEM0_PIPELINE_ARBITER_JOURNAL`, 200 par défaut, entier de 1 à
    10000). Borné à 200 000 caractères : au-delà, une première ligne annonce la troncature
    et nomme les sections coupées ; on sacrifie d'abord les plus anciennes entrées du
    journal, puis la fin du rapport — le brief reste intact.
  - **Tour**, par élément : le **worktree** de la feature, l'élément, puis le **corpus de
    l'élément** — les **seules sections du contrat de son étape** (`/req` : Besoins + AC ;
    `/specs` et `/impl` : AC + Spécifications + Lots ; `/review` : AC + Revue ; release :
    Besoins + AC + Revue ; jalon « specs validées » : AC + Spécifications + Lots ; plafond ou
    échec : AC + Revue + Corrections ; jalon « revue propre » : le contrat **entier sauf
    `## Revue`** — l'arbitre ne relit jamais le verdict du relecteur qu'il doit contrôler),
    le **journal du lot depuis le dernier tour** (les entrées que la session n'a pas encore
    reçues, suivies par position dans le journal, sans horloge : ce que les autres features
    et l'utilisateur ont décidé entre-temps ; `- (aucune décision nouvelle)` sinon ; après
    une **compaction** de la session, le tour suivant reporte le journal du lot **entier**)
    et les 50 entrées les plus récentes du journal de la feature. Même borne de 200 000
    caractères : journal du lot d'abord, puis fin du contrat — les entrées de la feature
    restent intactes. Le tour finit par le **rappel des règles** (trancher le technique,
    justifier, options par libellé ou numéro, cohérence avec le journal, corriger une
    décision refusée) — le digest de la directive qui survit à une compaction. Les
    citations se vérifient dans l'ouverture, le tour et, au jalon « revue propre », le diff
    et la liste des critères soumis.
  - **Mesure** : le récap de fin de lot ajoute `arbitrage : N décisions (contexte x,
    arbitrage y, utilisateur z) — S sessions de pilote, T tours` — ce que l'utilisateur a dû
    trancher lui-même, et le coût en sessions.
  - **Dépôt en lecture seule** : seuls `read`, `grep`, `glob`, `lsp` et `arbiter_decide` sont
    actifs ; tout autre outil (`bash`, `write`, `edit` compris) est refusé par l'extension
    (liste blanche), donc aucun fichier du worktree ne peut changer.
  - **Décision** : l'arbitre appelle `arbiter_decide` pour chaque élément — réponse (source `contexte`
    ou `arbitrage`), approbation d'un jalon, ou escalade. Il tranche tout choix technique ;
    l'escalade est réservée aux choix de produit (nouveau besoin non couvert par le rapport
    ou le brief, changement de périmètre, texte visible par l'utilisateur sans convention
    dans le dépôt). Le pilote **vérifie la décision à l'appel** : refusée, l'outil rend à
    l'arbitre le motif exact du refus et il la corrige dans le même tour (au plus 2 refus
    renvoyés, puis la décision est retenue telle quelle) ; une escalade n'est jamais
    refusée. Un tour fini sur une décision refusée escalade avec ce motif, jamais « arbitre
    sans décision ».
  - **Justification** : une réponse **et une approbation de jalon** portent au moins une
    justification que le pilote vérifie — une citation présente dans le corpus (espaces
    repliés), une référence `chemin:ligne` ou `chemin:début-fin` relative au worktree (le
    fichier existe dans le worktree, les lignes sont dans sa plage ; `..`, chemin absolu hors
    worktree ou lien sortant sont rejetés) ou une rubrique (titre) présente dans le rapport.
    Sans aucune justification, ou avec seulement des justifications rejetées, l'élément est
    escaladé (« approbation refusée par le pilote : aucune justification » pour un jalon)
    avec un motif qui nomme les rejets.
  - **Options** : pour une question à options, la réponse est reconnue par son numéro
    (`2`, espaces tolérés), son libellé exact ou son libellé normalisé (casse, espaces
    repliés, ponctuation finale ignorés) ; la réponse transmise est le libellé canonique,
    marqué sélectionné. Un numéro hors plage escalade ; un texte qui ne correspond à aucune
    option reste une réponse libre.
  - **Vérifications des jalons**, en plus du jugement de l'arbitre : « specs validées »
    n'est approuvé que si chaque critère `AC-<n>` du contrat est référencé par une
    spécification `S-<n>` (`SP-<n>` et `SPEC-<n>` comptent ; le prompt exige la cohérence
    avec le rapport ; un critère prouvé par un build, un contrôle manuel ou un smoke prévu
    au contrat est recevable) ; « revue propre » reçoit le `git diff --stat` et le diff du
    worktree par rapport à `HEAD` (fichiers non suivis non ignorés compris, bornés à 60 000
    caractères avec troncature annoncée) et, pour chaque `AC-<n>`, les fichiers **du diff**
    (modifiés ou non suivis, hors `.omp/`) qui le portent — un critère porté seulement par un
    fichier commité hors du diff vaut « (aucun fichier) ». Un diff vide est refusé (« diff
    vide : aucun changement à livrer »). Deux critères sont **tirés au sort de façon
    déterministe** (sha256 du diff) : le prompt les nomme et l'approbation exige pour chacun
    une **attestation** `attestations: ["AC-<n> chemin:ligne"]` vérifiée dans un fichier du
    diff — dans un fichier qui porte l'id du critère quand il y en a un (l'assertion de test
    qui matérialise le *Then*), sinon à la ligne modifiée qui réalise le critère (preuve par
    build, `plutil`, smoke). Sinon : « attestation manquante pour AC-n (<motif>) ». Une
    attestation vérifiée est une justification.
  - **Validation et journal** : le pilote **valide** la décision sans rien accorder sur
    parole (jalon « répondu », aucun appel, échéance de 10 minutes ⇒ escalade,
    `feature.escalation` posée) ; chaque décision acceptée est consignée au journal avec sa
    justification (motif, citations, références, rubriques ; les anciennes lignes sans ce
    champ restent lues). Une question déjà au journal est livrée telle quelle, sans arbitre.
  - **Ce qui se voit pendant l'arbitrage** : une feature arbitrée (contexte d'audit ou de
    projet, lot piloté par le service) reçoit sa marque `feature.arbitration` **dans la
    sauvegarde même** qui la met en attente (question, jalon, plafond, échec) : aucun lecteur
    ne la voit attendre l'utilisateur avant l'arbitre. La marque dit `status: "queued"` (en
    file derrière d'autres éléments de la même session de pilote) puis `"deciding"` avec
    `decidingAt` au départ de son tour ; le lot porte `arbiter: true` quand son pilote arbitre.
    Aucune alerte (« attend ta réponse », « attend ta validation », « attend ton accord »,
    « bloqué », « échoué ») ne part pour une feature arbitrée : la **seule** alerte est celle de
    l'**escalade**, `[pipeline] <dépôt>/<feature> : l'arbitre te confie <la question | la
    validation des spécifications | l'accord pour livrer | le plafond de revue | l'échec du
    run> (maillon /<étape>)`, suivie de `motif de l'arbitre : …` et de la question (sauf
    relais `/audit` ouvert : la session la reçoit). OMP Console range les features
    arbitrées dans la voie « Chez l’arbitre » (« L’arbitre décide depuis m:ss » / « En file pour
    l’arbitre »), sans bouton ni notification, ne met dans « À vous » que les escalades, motif
    affiché (« Motif de l’arbitre : … »), et liste les « Décisions de l’arbitre » de tous les lots.
  - **Plafond de la boucle revue ⇄ correction** (arbitré dès qu'une feature a un contexte
    d'audit ou de projet) : l'arbitre lit `## Revue` (les bloquants) et `## Corrections`, puis
    rend l'une de trois décisions — **relancer** avec un recentrage (les bloquants précis à
    lever, ce qui a déjà été tenté ; le recentrage n'est injecté que dans le prompt du run
    `/impl --fix` qui suit, jamais dans une relance `R` ultérieure ni dans le journal), **abandonner**
    (la feature est annulée avec le motif de l'arbitre comme raison d'arrêt ; worktree et
    branche conservés) ou **escalader** quand les bloquants dépendent d'un préalable extérieur
    (PR à fusionner, décision produit).
  - **Échec d'un run** : l'arbitre reçoit la raison d'arrêt, la fin de stderr (2 000
    caractères) et la fin de stdout (4 000 caractères) du run, puis **relance** — le run repart
    avec les mêmes modèle principal et repli, sans aucune écriture de modèle — ou
    **escalade** quand la cause est hors de portée (binaire absent, git refusé,
    authentification). Un échec ne s'abandonne pas.
  - **Quota épuisé** : jamais arbitré, et l'arbitre ne choisit jamais un modèle ni un repli
    (le repli est celui de l'utilisateur, déjà appliqué par le runner). Avant l'échéance du
    quota, l'élément `quota:<fournisseur>` est relayé à l'utilisateur comme ci-dessus ; une
    fois l'échéance (`exhaustedUntil`) passée et le registre `quota.json` libéré, chaque
    feature **arbitrée** encore bloquée par ce quota est relancée **sans changement de
    configuration de modèles** (une seule fois, à sa propre échéance). Ces relances ne
    comptent dans aucune borne. **Sans arbitre**, aucune relance n'a lieu, même après
    l'échéance : tu relances toi-même (`R`) ou tu choisis un repli.
  - **Bornes** : au plus **2 relances** par l'arbitre au titre du plafond et **2** au titre de
    l'échec, pour une même feature, avec deux compteurs **indépendants**
    (`feature.arbiterRelaunches`, persisté dans le lot). Une relance du plafond ne rend
    pas un crédit entier : `fixes` repart à `plafond − 1`, soit **un** tour de correction
    par relance d'arbitre (`R` remet toujours `fixes` à zéro). Une fois la borne atteinte, le
    plafond ou l'échec suivant est escaladé sans relance ni session d'arbitre, avec le motif
    `borne de relances par l'arbitre atteinte (2/2)`. Les compteurs ne sont remis à zéro que
    par la **livraison** de la feature : ni `R`, ni une réponse, ni un choix de repli ne les
    remettent à zéro. Le nombre de relances n'est pas configurable.
  - **Journal** : une relance (plafond ou échec), un abandon et une relance de quota à
    l'échéance sont consignés au journal avec la source `arbitrage`, la phase de la feature
    et la justification de l'arbitre ; une escalade n'est pas journalisée. Le panneau
    affiche sur le rang d'une feature relancée par l'arbitre `relancé par l'arbitre (k/2)`,
    où `k` est le compteur du motif de la dernière relance (plafond ou échec), jusqu'à la
    livraison.
  - **Repli à l'utilisateur** : sans arbitre (lot non arbitré) ou arbitre indisponible
    (modèle de la phase épuisé — `arbitre indisponible : quota épuisé (<fournisseur>)` —,
    run de l'arbitre en échec ou sans décision — `arbitre sans décision`), le plafond,
    l'échec et le quota remontent à l'utilisateur comme avant : aucune relance automatique
    et aucun compteur incrémenté. Pour `/project`, un plafond ou un échec **en cours
    d'arbitrage** n'est pas encore un échec de projet ; s'il est escaladé, l'échec de projet
    habituel est relayé avec ` — motif de l'arbitre : …` ajouté à sa raison, et une feature
    abandonnée par l'arbitre porte `pipeline abandonnée : <motif>`.
  Aucun message ne part vers la session `/project`, qu'elle soit ouverte ou non.
  L'étape sait d'où vient la réponse : `[réponse de l'utilisateur]`, `[réponse tirée du
  contexte]` ou `[réponse de l'arbitre]` en tête du prompt, `Réponse tirée du contexte` /
  `Réponse de l'arbitre` dans le résultat de `ask`, et `[jalon « specs validées » — décision
  de l'arbitre]` (ou `de l'utilisateur`) à la fin du prompt qui suit un jalon ; la livraison
  ne dit plus que l'utilisateur a accepté. La même mécanique sert `/audit`.
- **Arrêt et reprise** : relancer `/project` dans le dépôt — ou `/resume` de la session
  `/project` — reprend le projet là où il en était (plan, avancement, questions en
  attente), sans refaire le cadrage ni relancer une feature déjà lancée ou terminée. Un
  projet arrêté propose de reprendre ou de repartir d'un nouveau cadrage ; un projet
  terminé, d'en commencer un nouveau. Un projet déjà conduit par une autre session vivante
  est refusé.
- **Où c'est rangé** : le projet dans `<état>/projects/<sha1(realpath(dépôt))[:16]>.json`
  (un par dépôt, écrit par la seule session qui le conduit), le battement de son relais
  dans `<état>/audit/<sha1(clé)[:16]>.json`.

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
`version-bump`, `deploy`). Elle s'active par `/set-phase review`. La commande
`/review` ouvre quant à elle une session de revue indépendante, sans passer par
le système de phases — mais `review` est aussi disponible comme phase pour les
déclenchements automatiques en fin de session.
Le déclenchement est **borné à une fois par session** et protégé contre les relances
(`stop_hook_active`) : la session se termine normalement. Une relance de ta part (nouveau
message) n'est pas une fin de phase et ne déclenche rien.

## Config

| Variable | Défaut | Rôle |
|---|---|---|
| `MEM0_HTTP_URL` | `http://localhost:8321` | URL du service |
| `MEM0_HTTP_TOKEN` | vide | envoyé en header `X-Mem0-Token` si défini côté serveur |
| `MEM0_PROJECT_ID` | — | force le nom de projet |
| `MEM0_PIPELINE_WORKTREES_DIR` | `~/.omp/pipeline-worktrees` | base des worktrees de feature (`~` accepté, chemin relatif ignoré) |
| `MEM0_PIPELINE_STATE_DIR` | `~/.omp/agent/pipeline` | magasin d'état des pipelines (`running/` + `history/`), des lots (`lots/`), du canal de commande (`commands/` + `commands/acks/`) et du service (`service.json` — pid, port, jeton — et `service.log`, la sortie du job launchd), lu par `/pipelines` (`~` accepté, chemin relatif ignoré) |
| `MEM0_PIPELINE_REVIEW_CAP` | `3` | plafond des tours de correction (`/impl --fix`, compteur `fixes`) et des revues illisibles d'affilée (`unreadableRuns`) d'une feature de lot avant de la passer `bloqué` (entier, 1-20) |
| `MEM0_PIPELINE_SLOTS` | `4` | runs de features du lot menés en parallèle (entier, 1-32) ; au-delà, les features runnables attendent un créneau (`attend un créneau` dans `/pipelines`) — les runs hors lot ne comptent pas |
| `MEM0_PIPELINE_RUN_TIMEOUT_MS` | `3600000` | budget de travail d'un run de maillon en millisecondes (10 s à 24 h), suspendu tant qu'une question est en vol ; au-delà, la feature passe `échoué` « délai dépassé (<budget> min) ». Seule borne dure : le minuteur du runner coupe la session à budget + 1 h (code 124) et la feature passe `échoué` « délai dépassé (<budget + 60> min) », soit 120 min par défaut |
| `MEM0_PIPELINE_CONTEXT_SOFT` | `120000` (`90000` en `/review`) | seuil de compaction du contexte d'un run ou d'une session parente hébergés (tokens, entier ≥ 1) ; la compaction part à la fin du tour en cours ; s'il atteint ou dépasse `MEM0_PIPELINE_CONTEXT_HARD`, les deux défauts s'appliquent |
| `MEM0_PIPELINE_CONTEXT_SOFT_<PHASE>` | — | `REQ`, `SPECS`, `IMPL`, `REVIEW`, `RELEASE` : seuil `SOFT` propre à une phase, prioritaire sur `MEM0_PIPELINE_CONTEXT_SOFT` |
| `MEM0_PIPELINE_CONTEXT_HARD` | `250000` | plafond : un run encore au-dessus après une compaction reçoit un dernier tour « écris ta section livrable maintenant » borné à 5 min, puis passe `échoué` (`bloqué` si une question est en vol) ; une session parente n'est jamais coupée |
| `MEM0_PIPELINE_OMP_BIN` | `omp` | binaire `omp` du job launchd du service et des runs de conversation (chemin absolu si `omp` n'est pas dans le `PATH`) |
| `MEM0_SERVICE_PORT` | `8788` | port d'écoute de l'API du service (boucle locale uniquement) ; s'il est occupé, le service prend un port éphémère et `service.json` porte le port réel — les clients lisent toujours ce fichier |
| `MEM0_PIPELINE_ARCHIVE_DIR` | `~/.omp/pipeline-archive` | base d'archivage des worktrees de feature annulés (`~` accepté, chemin relatif ignoré) |
| `MEM0_AUTOSETUP` | `1` | `0` pour ne jamais écrire dans un dépôt |
| `MEM0_QUIET` | `0` | `1` pour réinjecter les souvenirs sans les afficher dans le transcript |
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
| `test/req/` | le plugin `omp-mem0-req` (pipelines, lot, panneau, service, sessions) |
| `test/console/` | les sources d'OMP Console — gardes textuelles Mac et iOS (`ios-*`), noyau partagé, coque iOS |
| `test/stack/` | `mem0-stack` : mem0-rs, contrat boîte noire, migration, `doctor.sh` |
| `test/outillage/` | l'outillage du dépôt : `check.sh`, CI, release, smoke des plugins, documentation |
| `test/support/` | les modules partagés, jamais lancés seuls (pas de `.test.ts`) : `repo.ts` (racine, liste des tests, dossiers jetables, copie du dépôt, environnement des enfants), `git.ts` (dépôts git jetables), `spawn.ts` (processus enfants en parallèle), `swift-source.ts` (sources Swift sans commentaires, lexer de littéraux), `req-fixtures.ts` (lots, contrats, sessions, faux kit du plugin req), `fake-zod.ts`, `doctor-banc.ts` |

Un test neuf va dans le dossier de ce qu'il éprouve, sans liste à tenir :
`scripts/test-files.sh` les découvre récursivement. Un helper utile à plusieurs
fichiers va dans `test/support/`, jamais recopié d'un fichier à l'autre.

```bash
npm test                                                        # = bash scripts/check.sh --sections=tests (section ── Tests)
node --test --experimental-strip-types 'test/**/*.test.ts'      # toute la suite
node --test --experimental-strip-types test/req/lot.test.ts     # un fichier
bash scripts/test-files.sh --scope=changed | xargs node --test --experimental-strip-types   # les tests du diff
bash scripts/test-ac.sh AC-1 AC-2                                # preuve par critère
```

`scripts/test-files.sh --scope=changed[=<base>]` (base `HEAD`) retient : les
`test/**/*.test.ts` du diff (`git diff --name-only` + non suivis), `test/req/<slug>.test.ts`
du slug de `.omp/pipeline/contract.md` s'il existe, tout test dont le texte nomme un fichier
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
`absent`. C'est l'appel unique que la directive `/review` impose.

Les tests de `test/console/` partagent une copie du dépôt par fichier
(`sharedRepo(prefix).fresh()` dans `test/support/repo.ts`, remise à neuf en ≈ 10 ms) au lieu
d'une copie par test. `check.sh` imprime `# skipped N` dans `── Tests`, en succès comme en
échec.

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
et un `case` non vide qui retombe dans le suivant font échouer le job. La
validation ne se contente pas de transpiler les extensions :
`scripts/plugin-smoke.ts` charge
**réellement** chaque plugin du catalogue dans un OMP (SDK épinglé sous Bun),
vérifie les commandes enregistrées, invoque `/mem0-status` puis l'outil
`mem0_search` d'un côté, `/req` de l'autre, et exige le résultat observé — le
service mem0 étant remplacé par un stub local, donc sans conteneur ni credential.
Un plugin qui ne répond pas fait échouer le job, et `main` exige ces deux statuts
ainsi que `release-simulation` : le merge est bloqué.

Sur Ubuntu, le job `check` lance `./scripts/check.sh` sans option : ses 12
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

Ces jobs pilotent `check.sh` par trois options, que l'on peut aussi passer en
local — sans option, toutes les sections et toute la suite tournent :

| Option | Effet |
|---|---|
| `--sections=<id>[,<id>…]` | n'exécute que ces sections, dans l'ordre du script : `catalogue`, `noms`, `plugins`, `versions`, `extension`, `types`, `rust`, `smoke`, `tests`, `noyau`, `app-swift`, `app-ios` |
| `--tests-scope=macos` | `── Tests` ne lance que les fichiers de `scripts/test-files.sh --scope=macos` |
| `--tests-part=1/2` ou `2/2` | `1/2` : les tests `socle-app-swift/*` de `test/outillage/check.test.ts` ; `2/2` : tous les autres — chaque test tourne exactement une fois |

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
