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
│   ├── lotController.ts, lot.ts, chain.ts, contract.ts, seeds.ts
│   │                                  le lot : pilote, modèle, chaîne, contrat, amorces
│   ├── runs.ts, inbox.ts, publish.ts, store.ts, runState.ts, git.ts, state.ts,
│   │   models.ts, audit.ts, commands.ts
│   │                                  runs, boîtes, magasin d'état, worktrees, audit, modèles
│   ├── project.ts, projectDriver.ts, projectRelay.ts, relay.ts
│   │                                  la conduite de projet et le relais
│   └── panel.ts, panelRows.ts, panelWidth.ts, panelView.ts, panelSession.ts,
│       panelHost.ts                   le panneau /pipelines et la vue de session
├── omp-console/                       la coque macOS (SwiftUI), le noyau partagé et l'app iOS
│   └── ios/                           le projet Xcode de l'app iOS (coque-ios)
├── mem0-stack/                        mem0 + Qdrant, en local
│   └── mem0-http/                     l'API HTTP et sa config mem0
├── CHANGELOG.md                       journal des versions, écrit par le job de release
├── test/                              suite node --test
├── scripts/check.sh                   validation avant publication
├── scripts/typecheck.sh               type-check des deux plugins et de test/ contre les types de l'hôte
├── scripts/plugin-smoke.ts            charge les plugins dans un vrai OMP
├── scripts/swift-app.sh               suite release puis bundle .app de la coque SwiftUI
├── scripts/run-console.sh             recompiler vite et relancer OMP Console (hooks git fournis)
├── scripts/mem0-http-test.sh          test d'API mem0-http hors conteneur, dérivé du Dockerfile
├── scripts/release.ts                 PR de release auto-mergée, tags et releases au merge
├── scripts/no-manual-bump.sh          refuse un bump de version manuel dans une PR
├── scripts/release-simulation.sh      simule la release d'une PR sur une copie jetable
└── .github/workflows/                 check.yml (PR), release-simulation.yml (PR), release.yml (merge sur main)
```

La coque macOS (`omp-console/`, SwiftUI) a son propre document :
`omp-console/README.md` explique comment la builder, la tester, assembler son
bundle `.app` et ouvrir l'app — il documente aussi l'app iOS, dont le projet Xcode
vit sous `omp-console/ios/`. C'est l'app unique : elle installe et démarre
elle-même ses composants (son `omp` 18.6.0, son podman 6.1.3, sa machine podman
`omp-console` et les conteneurs `omp-console-qdrant` / `omp-console-mem0-http`),
migre une seule fois la base mémoire existante — l'ancienne pile est arrêtée avant
de prendre ses ports — et sa pile survit à la fermeture de l'app. `mem0-stack/`
(ci-dessus) reste la voie MANUELLE, que l'app ne modifie pas.

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
podman compose up -d        # ou: docker compose up -d
./doctor.sh
```

`doctor.sh` teste la chaîne complète — conteneurs, port, Qdrant, oMLX, puis un
aller-retour écriture/relecture — et dit quoi faire à chaque échec.

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
  contrat, **critère par critère** : il retrouve le test par `grep AC-n`, le lit, le
  lance, et rapporte `AC-n → fichier:ligne → pass/fail`. Un critère sans test traçable
  est un bloquant.
  L'état traverse les sessions par un **fichier contrat déterministe**
  `.omp/pipeline/contract.md` — besoins et critères, puis specs et lots y sont écrits
  par l'agent, relus tels quels à l'étape suivante — et non par la mémoire mem0 :
  besoins, critères, specs et lots sont des artefacts transitoires de la feature ;
  mem0 ne garde que les décisions durables.
  `/review` rend une évaluation structurée (STATUT, AC PAR AC, SPEC PAR SPEC,
  BLOQUANTS, DÉCISION) et la consigne dans le contrat sous `## Revue`. La boucle se
  ferme avec `/impl --fix` : une session qui lit ce verdict et lève chaque BLOQUANT
  sans élargir le périmètre, puis relance `/review` pour reconfirmer. Le champ
  `BLOQUANTS` est relu mécaniquement : sans bloquant, il s'écrit `BLOQUANTS : aucun`.

  **Chaque maillon annonce la suite.** À la retombée terminale de la session — le seul
  instant où « la phase est finie » est vrai, OMP n'émettant `session_stop` que là, et
  jamais pour une session de sous-agent — l'extension poste dans le transcript un
  message DURABLE (pas un toast, qui disparaît au redraw) portant la commande exacte du
  maillon suivant : `/specs` après `/req`, `/impl` après `/specs`, `/review` après
  `/impl`, puis `/impl --fix` tant que `## Revue` consigne un BLOQUANT — et la fin du
  cycle est signalée quand il n'y en a aucun. Un maillon qui s'arrête faute de section
  `## Spécifications` dans le contrat renvoie vers `/specs`. En session interactive, la
  commande est en plus préremplie dans la zone de saisie, prête à valider par Entrée —
  et jamais par-dessus un brouillon déjà tapé.

  **Les deux modèles se choisissent au lancement de la feature.** `/req` demande, **avant
  toute écriture** (ni branche, ni worktree, ni session), **deux** modèles dans la liste des
  modèles connus d'OMP — celui des maillons `req` et `specs`, puis celui de `impl`, `review`
  et `release` —, avec à chaque fois la réponse `défaut OMP (aucun modèle)` ; `Échap` annule
  sans rien créer. Les deux sont **modifiables à tout moment**, depuis OMP Console ou par le
  geste `m` du panneau `/pipelines` : un run déjà lancé n'est ni interrompu ni relancé, tout
  run suivant utilise la valeur courante. Chaque modèle part en `--model` sur les runs de
  **son groupe** — la collecte et `/specs` pour le premier, `/impl`, `/review` et la
  livraison pour le second — et les deux s'affichent sur son rang du panneau
  (`… · req+specs anthropic/claude-opus-4-7 · impl+review défaut OMP`). Un groupe laissé sur
  `défaut OMP` ne transmet aucun `--model`, et le niveau de réflexion n'est jamais transmis :
  il reste celui de la config OMP.

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
  **deux modèles** (`req+specs`, puis `impl+review`) — deux questions par élément, chaque
  pipeline tourne avec les siens. Les
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
  avec les deux modèles de chaque feature. Le plan et son avancement vivent dans `PROJECT.md`,
  seul fichier de la branche `omp-project`. Chaque segment part en pipelines parallèles
  **dans la limite de `MEM0_PIPELINE_SLOTS`** jusqu'aux PR, et le segment suivant démarre
  seul dès que **toutes** les PR du précédent sont fusionnées — par toi, jamais par
  `/project`. Voir « Projet ».

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
 · 0 annulée · 2 en cours · pilote : cette session
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

L'en-tête du lot nomme **qui pilote** : `pilote : cette session` quand c'est la tienne,
`piloté par pid N — consultation` quand une autre session conduit ce lot (les gestes qui
écrivent ne sont alors plus annoncés, ils seraient refusés), `pilote absent — l reprend`
quand le propriétaire a disparu — le lot est à l'arrêt, et rien ne le dit mieux que ces
trois mots.

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
  seule fois. Les **deux modèles** s'ajoutent au libellé (`base-qdrant · req+specs
  anthropic/claude-opus-4-7 · impl+review défaut OMP`), une fois eux aussi, et disparaissent
  pour une feature née au défaut OMP ; `défaut OMP` nomme un groupe laissé vide, l'ancien
  modèle unique d'une feature d'avant remplissant les deux. Quand le libellé et la colonne
  ne tiennent pas ensemble sur la largeur de contenu, l'entrée peint **deux rangs** : le
  libellé, puis l'état et le temps — jamais
  coupés en deux. **Le tour de correction y figure** dès qu'il y en a un : `--fix · tour
  2/3` pour un `/impl --fix`, `tour 2/3` pour une `/review` — sans quoi un tour de
  correction se lisait comme un `/impl` neuf, et la boucle ne se suivait qu'à son blocage.
- **La raison d'arrêt** d'une feature bloquée ou échouée est portée par la liste, sur un
  second rang de son entrée : `arrêt : run tué par le délai de 3600s`. `échoué` ne dit
  pas pourquoi ; le motif, si. Deux autres seconds rangs existent : `dernière revue : n
  bloquant(s)` — le verdict que la chaîne vient de lire dans le contrat — et `PR : <url>`
  pour une feature livrée, l'URL que `gh` a imprimée.
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
  `~/.omp/agent/pipeline` — ou `MEM0_PIPELINE_STATE_DIR`. Aucun serveur, aucun démon :
  des fichiers, et rien d'autre.
- **Le canal de commande** : `<état>/commands/` reçoit des commandes d'un client
  extérieur (un fichier JSON par commande, écrit dans un temporaire puis renommé), et
  le pilote propriétaire du dépôt visé les prend en charge en écrivant son accusé dans
  `<état>/commands/acks/<id>.json` — `prise en charge` avant d'agir, ou `refusée` avec
  son motif. Les commandes sont `launch` (créer le lot et lancer une feature), `add` et
  `remove` (modifier la liste à chaud), `verdict` (`v` ou `y`, comme les touches du
  panneau), `answer` (répondre à une question en vol d'un run), `reply` (répondre à une
  question en texte d'un maillon terminé : le maillon repart sur sa session) et `stop`
  (interrompre le pilote). Un même identifiant rejoué ne produit ni second accusé ni
  second effet.
  L'app **omp-console** est un de ces clients : elle dépose ses gestes par ce canal et
  par les boîtes des runs, et affiche l'accusé du pilote (voir « Agir depuis le
  Kanban » de `omp-console/README.md`).

## Lot de features

Un **lot** enchaîne plusieurs features : chacune a son pipeline (les quatre maillons
`/req` → `/specs` → `/impl` → `/review`), et le lot les fait avancer **tout seul** — un
processus par maillon — en ne s'arrêtant que là où il a besoin de toi. Il se pilote
entièrement depuis le panneau.

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
  existent, **deux étapes** : `Modèle req+specs` puis `Modèle impl+review`. La liste des
  modèles connus s'y affiche avec `défaut OMP (aucun modèle)` en tête ; `↑`/`↓` (ou `k`/`j`)
  déplacent le curseur, une frappe **filtre** la liste (Retour arrière l'efface, un filtre
  sans résultat le dit), `PageUp`/`PageDown` font défiler la fenêtre, `Entrée` valide le
  choix affiché (sur la seconde étape, il ouvre l'aperçu) et `Échap` rend l'étape précédente —
  le champ des dépendances depuis la première —, tampon compris. Le curseur partant sur la
  première ligne, `Entrée` seul reproduit le comportement d'avant : la feature naît sans
  modèle. L'aperçu n'annonce que les groupes **renseignés**
  (`Créer gamma ? · 0 dépendance(s) · req+specs anthropic/claude-opus-4-7`). Le worktree de la
  feature est créé au lancement (`feat/<nom>`), jamais à l'ajout. **Modèles** (`m`) ouvre les
  deux mêmes étapes, pré-positionnées sur les valeurs courantes, puis un aperçu
  (`Modifier les modèles de gamma ? · req+specs … · impl+review défaut OMP`) : `Entrée`
  applique, un refus du pilote s'affiche tel quel, et un run déjà lancé n'est ni interrompu
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
- **La boucle de correction** (`/impl --fix` → `/review`) tourne seule, dans la limite de
  `MEM0_PIPELINE_REVIEW_CAP` tours (3 par défaut) : au-delà, la feature passe *bloqué* au
  lieu de boucler. Deux garanties de fond : `/impl --fix` consigne ses levées dans une section
  `## Corrections` et **n'écrit jamais** dans `## Revue` (seule `/review` écrit le verdict), et
  une revue qui rend la main **sans réécrire** `## Revue` est jugée *illisible* — jamais
  « propre » sur le verdict laissé par la correction précédente. Le verdict est lu dans la
  **dernière** section `## Revue` du contrat, et « aucun bloquant » s'écrit de plusieurs
  façons (`- BLOQUANTS : aucun`, `Aucun bloquant.`, `aucun (tous levés)`, `néant`…).
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
  le **relais** de ces pipelines : chaque question d'un maillon et chaque jalon lui
  arrive comme un message `[audit]` qui nomme sa feature et son maillon. Elle répond
  seule (`audit_reply`), valide « specs validées » et « revue propre »
  (`audit_approve`) — la chaîne va alors jusqu'à la PR sans aucune touche — ou te
  remonte l'élément dans sa session (`audit_escalate`) avec la question et les options
  d'origine, précédées de `Question de /<maillon> — feature <nom>` ; ta réponse part
  **mot pour mot** au maillon qui l'a posée. Quand plusieurs pipelines demandent en même
  temps, leurs dialogues s'ouvrent **un à la fois**, dans l'ordre des demandes. Le
  plafond de la boucle revue ⇄ correction te revient toujours, et aucune PR n'est
  ouverte avant ta décision. Pendant le relais, le panneau affiche `relayé à /audit` et
  refuse d'y répondre ou d'y valider. **Quitter ou fermer** la session `/audit` fait
  retomber questions et jalons sur le panneau, comme pour une feature ordinaire (y
  compris une question restée sans réponse) ; **y revenir** (`/resume`) lui rend le
  relais et lui réinjecte ce qui attend encore. Rien n'est jamais fusionné. Le battement
  du relais vit dans `<état>/audit/<sha1(session)[:16]>.json`.

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
  **Abandonner** (rien n'est écrit). À la validation, tu choisis les deux modèles de chaque
  feature (`req+specs`, puis `impl+review`), le document est écrit et le segment 1 part.
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
  `MEM0_PIPELINE_SLOTS`). Tant que la session `/project` est la session courante, chaque
  question d'un maillon, chaque jalon et chaque échec lui arrive en message `[project]`.
  Ses cinq outils : `project_plan` (le plan), `project_amend` (sa modification),
  `project_reply` (répondre seule, quand le cadrage, le plan et le contrat donnent la
  réponse), `project_approve` (« specs validées », « revue propre » : la chaîne va
  jusqu'à la PR sans aucune touche) et `project_escalate` (te remonter l'élément ; ta
  réponse part **mot pour mot**). Pendant le relais, le panneau affiche `relayé à
  /project` et refuse d'y répondre ou d'y valider ; quitter ou fermer la session fait
  retomber questions et jalons sur le panneau.
- **Fusions** : `/project` sonde les PR du segment courant (`gh pr view`) au plus une fois
  par minute. Il ne fusionne **jamais** : quand toutes les PR du segment sont fusionnées
  (par toi), le segment suivant démarre seul ; quand le dernier l'est, le projet est
  terminé.
- **Échecs** : pipeline en erreur ou bloquée, plafond de la boucle revue ⇄ correction,
  abandon, lancement refusé ou PR fermée sans fusion — la feature est **en échec**, aucun
  segment suivant ne démarre, et l'échec te revient avec trois choix : **relancer** la
  feature, la **retirer** du plan (le segment s'achève sans elle), ou **arrêter** le
  projet (plus aucune pipeline n'est lancée ; celles en cours continuent sous
  `/pipelines`).
- **Évolution du plan** : `project_amend` propose la nouvelle liste des segments pas
  encore démarrés — ajout, retrait ou modification de features, sur ta demande ou à
  l'initiative de l'agent. Tu l'appliques, la corriges ou la rejettes : rien n'est
  appliqué sans ta validation, et aucun segment ne démarre pendant le dialogue. Le
  segment courant ne change jamais par cette voie.
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
| `MEM0_PIPELINE_STATE_DIR` | `~/.omp/agent/pipeline` | magasin d'état des pipelines (`running/` + `history/`), des lots (`lots/`) et du canal de commande (`commands/` + `commands/acks/`), lu par `/pipelines` (`~` accepté, chemin relatif ignoré) |
| `MEM0_PIPELINE_REVIEW_CAP` | `3` | plafond des tours de correction (`/impl --fix`) d'une feature de lot avant de la passer `bloqué` (entier, 1-20) |
| `MEM0_PIPELINE_SLOTS` | `4` | runs de features du lot menés en parallèle (entier, 1-32) ; au-delà, les features runnables attendent un créneau (`attend un créneau` dans `/pipelines`) — les runs hors lot ne comptent pas |
| `MEM0_PIPELINE_RUN_TIMEOUT_MS` | `3600000` | budget d'un run de maillon en millisecondes (10 s à 24 h) ; au-delà, la feature passe `échoué` |
| `MEM0_PIPELINE_OMP_BIN` | `omp` | binaire `omp` des runs du lot (chemin absolu si `omp` n'est pas dans le `PATH`) |
| `MEM0_PIPELINE_ARCHIVE_DIR` | `~/.omp/pipeline-archive` | base d'archivage des worktrees de feature annulés (`~` accepté, chemin relatif ignoré) |
| `MEM0_AUTOSETUP` | `1` | `0` pour ne jamais écrire dans un dépôt |
| `MEM0_QUIET` | `0` | `1` pour réinjecter les souvenirs sans les afficher dans le transcript |
| `OMLX_LLM_MODEL` | `qwen3-8b` | modèle d'extraction (dans `.env`) |
| `OMLX_EMBED_MODEL` | `bge-m3` | modèle d'embedding (dans `.env`) |

Le port est bindé sur `127.0.0.1` : accessible depuis le Mac, pas depuis le réseau.

## CI et release

Chaque PR passe `./scripts/check.sh` sur macOS **et** Ubuntu. Le type-check y
couvre les sources des **deux** plugins comme `test/` — deux programmes `tsc` :
`tsconfig.json` pour les plugins (lib ES2023, donc une API ES2024 comme
`Promise.withResolvers` y fait échouer le job) et `tsconfig.test.json` pour la
suite (lib ES2024). La validation ne se contente pas de transpiler les
extensions : `scripts/plugin-smoke.ts` charge
**réellement** chaque plugin du catalogue dans un OMP (SDK épinglé sous Bun),
vérifie les commandes enregistrées, invoque `/mem0-status` puis l'outil
`mem0_search` d'un côté, `/req` de l'autre, et exige le résultat observé — le
service mem0 étant remplacé par un stub local, donc sans conteneur ni credential.
Un plugin qui ne répond pas fait échouer le job, et `main` exige ces deux statuts
ainsi que `release-simulation` : le merge est bloqué.

Chaque PR vers `main` passe aussi `scripts/release-simulation.sh`, qui rejoue la
release de la PR **sur une copie jetable** — plan de `scripts/release.ts`,
écriture des versions, des deux catalogues et de `CHANGELOG.md`, puis
`./scripts/check.sh` — sans rien pousser, sans tag et sans PR. Son statut,
`release-simulation`, est requis : une PR dont la release simulée échouerait ne
peut pas être fusionnée.

La même PR exécute **hors du build d'image** le test d'API de mem0-http : la CI
dérive du Dockerfile la version de Python (`actions/setup-python` la sert depuis
le cache du runner) et la liste d'exigences installées, puis la section
`── API mem0-http` les lance contre `test_api.py` — aucun conteneur, aucun
credential, et la sortie du test est recopiée telle quelle, parce que c'est elle
qui nomme la route fautive. Un serveur qui n'est plus conforme à l'API mem0
installée fait donc échouer la PR, et pas seulement la construction de l'image.
Sur un poste, l'environnement se prépare une fois :
`bash scripts/mem0-http-test.sh --prepare`.

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
