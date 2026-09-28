# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : une fenêtre, une barre latérale à quatre sections — **Kanban**,
**Sessions**, **Fichiers**, **Projet** — et un panneau de détail. La section
**Kanban** affiche le tableau des pipelines (voir « Section Kanban » ci-dessous) ;
les trois autres gardent un contenu de remplacement. Cible minimale : macOS 14.

## Prérequis

- macOS 14 ou plus récent.
- Les Command Line Tools d'Apple : `swift --version` doit répondre.
- **`xcodebuild` n'est ni requis ni utilisable** sur un poste sans Xcode : sur un
  poste équipé des seuls Command Line Tools, il refuse de tourner (« requires
  Xcode, but active developer directory is a CommandLineTools instance »). Tout
  passe par SwiftPM (`swift build`, `swift test`) et par l'assemblage du bundle
  décrit ci-dessous.

## Builder

```bash
cd omp-console
swift build            # debug
swift build -c release # release
```

## Tester

```bash
cd omp-console
# SwiftPM ne trouve pas toujours les macros de Swift Testing (échec non
# déterministe du toolchain) : on pointe explicitement le dossier des plugins.
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

Sous les Command Line Tools seuls, XCTest n'existe pas : la suite du paquet
utilise **Swift Testing**, la seule bibliothèque de tests fournie avec le
toolchain.

Deux pièges mesurés sur Swift 6.4 CLT seuls expliquent cette ligne :

- `swift test` doit être la **première** commande écrite dans son dossier de
  build : un `swift build` préalable dans le même dossier fait échouer la
  compilation des tests (« plugin for module 'TestingMacros' not found »). D'où
  le `--scratch-path .build-tests` dédié — `scripts/swift-app.sh` compile et
  teste de son côté dans `omp-console/.build-app`.
- même sans build préalable, `swift test` échoue environ une fois sur trois en
  « plugin for module 'TestingMacros' not found », de façon non déterministe
  (reproduit sur un paquet minimal). Le `-plugin-path` explicite ci-dessus rend
  la suite déterministe.

## Lire le magasin d'état

`Sources/OMPConsole/Store/` est la **couche de lecture** du magasin d'état partagé
(`~/.omp/agent/pipeline/`, ou `MEM0_PIPELINE_STATE_DIR`) : les six répertoires
`running`, `history`, `lots`, `projects`, `inbox` et `audit` sont rendus en
modèles Swift typés, en parité avec le lecteur TypeScript de `omp-mem0-req`
(`omp-mem0-req/store.ts`, `lot.ts`, `project.ts`).

- `StoreReader` lit une racine et une horloge injectables ; une entrée au schéma
  incomplet est **écartée et nommée** (`discardedEntries` : le fichier
  `<store>/<nom>` et la raison — `JSON illisible` ou `schéma incomplet ou
  inconnu`), jamais rendue partielle ; `availability` distingue « magasin absent »
  de « magasin vide » pour chaque store, et `StoreSnapshot.root` porte la
  disponibilité de la **racine** elle-même.
- `StoreWatcher` veille un store par **notification du système de fichiers**
  (source vnode sur le répertoire, jamais de scrutation) et pousse un instantané
  typé à ses abonnés (`AsyncStream`, multicast) ; `StoreHub` agrège les six en un
  flux global. L'émission n'a lieu que si l'instantané a changé.
- La couche est un **lecteur** : aucune API d'écriture n'est appelée, jamais — un
  propriétaire mort est marqué (`isStale`), ni retiré ni déplacé vers `history/`.

`commands/` ne fait pas partie du périmètre lu. La section **Kanban** consomme ce
flux global ; les sections Sessions, Fichiers et Projet restent à leurs features
ultérieures.

## Section Kanban

`Sources/OMPConsole/Kanban/` est le **tableau des pipelines** : une ardoise unique
mêlant **tous** les dépôts, peuplée depuis le seul magasin d'état partagé — les
features de projet (`projects`), les features de lot (`lots`), les runs hors lot
(`running`) et les vingt clôtures les plus récentes (`history`, même borne que
`/pipelines`). C'est un **lecteur pur** : aucune API d'écriture n'est appelée, un
propriétaire mort n'est ni déplacé vers `history/` ni retiré (à la différence du
panneau `/pipelines`, qui réconcilie).

### Les onze colonnes

En-tête d'une colonne : `<libellé> (<n>)`. Chaque carte est rangée dans
**exactement une** colonne ; les onze colonnes sont toujours affichées, même vides.

| `KanbanColumn` (`rawValue`, identifiant AX) | Libellé |
|---|---|
| `en-attente` | En attente |
| `en-cours` | En cours |
| `question-en-vol` | Question en vol |
| `pr-ouverte` | PR ouverte |
| `fusionne` | Fusionné |
| `echec` | Échec |
| `jalon-specs` | Jalon specs |
| `jalon-review` | Jalon review |
| `bloquee` | Bloquée |
| `terminee-sans-pr` | Terminée sans PR |
| `annulee-retiree` | Annulée / retirée |

### Les trois messages d'état

| Situation | Message |
|---|---|
| aucun instantané reçu encore | `Chargement du magasin d'état…` |
| la racine `<stateDir>` n'existe pas | `Magasin d'état absent : <stateDir>` |
| la racine existe, aucune carte ni anomalie | `Magasin d'état vide : <stateDir>` |

Un magasin qui ne contient que des fichiers illisibles rend le **tableau** (colonnes
vides + bandeau), jamais « vide » : les anomalies ne sont jamais tues. Le panneau de
détail sans sélection écrit `Aucune carte sélectionnée`.

### Identifiants d'accessibilité

| Identifiant | Surface |
|---|---|
| `kanban.board` | la racine du tableau (focus clavier) |
| `kanban.column.<rawValue>` | une colonne |
| `kanban.card.<id>` | une carte (`feature:<clé>:<slug>`, `project:<clé>:<slug>`, `run:<id>`, `history:<id>`) |
| `kanban.banner` | le bandeau d'anomalies (absent s'il n'y en a aucune) |
| `kanban.anomaly.<i>` | une ligne d'anomalie |
| `kanban.detail` | le panneau de détail (carte sélectionnée) |
| `kanban.detail.empty` | le panneau sans sélection |
| `kanban.empty` | les deux messages « absent » / « vide » |
| `kanban.loading` | le message de chargement |

Clavier (le tableau a le focus) : `↓`/`↑` carte suivante/précédente, `→`/`←` première
carte de la colonne suivante/précédente non vide. Clic simple sur une carte :
sélection + surbrillance + panneau de détail. Sélectionner une carte ne change
**jamais** de section : la barre latérale reste sur Kanban, et Sessions, Fichiers et
Projet gardent leur contenu de remplacement.

### Parité avec `/pipelines`

Sur le même magasin, toute entité lue par `/pipelines` a sa carte au même état :

| `/pipelines` | Tableau Kanban |
|---|---|
| rang de feature du lot | carte `feature:<clé>:<slug>`, dans la colonne de son état |
| rang `running` non apparié | carte `run:<id>` |
| rang `history` (20 plus récents) | carte `history:<id>` |
| run apparié à une feature | **fusionné** : une feature = une carte |
| colonne de droite `/phase · état · temps` | `phase`, `state`, `durée` de la carte |
| rang `PR : <url>` (feature `done`) | `PR : <url>` de la carte |
| en-tête « pilote : … mort » | marque `mort` + ligne de bandeau |
| avis « N fichier(s) d'état illisible(s) » | une ligne de bandeau par fichier |

Deux écarts **délibérés** : `/pipelines` réconcilie les propriétaires morts (le
tableau, lui, marque la carte `mort` en `Échec` sur place), et les features de
projet sans lot sont un ajout du tableau — elles font partie des sources (B-2).
`inbox/` et `audit/` ne sont pas des cartes.

### Recette : vivacité à l'écran

Le paquet ne vend aucun produit exécutable : la preuve graphique passe par le bundle
et une sonde AX (recette manuelle, jamais exécutée par la CI).

```bash
bash scripts/swift-app.sh                       # depuis la racine du dépôt
MEM0_PIPELINE_STATE_DIR=/tmp/magasin-jetable \
  nohup "omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" >/tmp/omp-console.log 2>&1 &
```

Lancer le binaire **directement** (pas `open`) : son `cwd` porte alors `.git`. Puis,
avec une sonde AX (`AXUIElementCreateApplication(pid)` + parcours de
`kAXChildrenAttribute`) :

1. lire `kanban.card.<id>` deux fois à 2 s d'intervalle ⇒ la durée a augmenté ;
2. publier un `running/<id>.json` de fixture dans le magasin jetable ⇒ la carte
   apparaît ; le supprimer ⇒ elle disparaît ; réécrire son état ⇒ elle change de
   colonne ;
3. cliquer une carte (clic souris réel) ⇒ `kanban.detail` décrit la carte et la
   surbrillance suit ; lire la barre latérale ⇒ la section reste **Kanban** ;
4. relever `kanban.banner` / `kanban.anomaly.<i>` après avoir déposé un fichier
   tronqué dans le magasin.

Le magasin jetable est **obligatoire** : la recette ne touche jamais
`~/.omp/agent/pipeline` de la machine.

### Recette : parité avec `/pipelines`

Sur le **même** magasin, ouvrir `/pipelines` dans une session OMP puis comparer rang
par rang selon la table ci-dessus (dépôt, entités, colonnes, anomalies). Pour un
propriétaire mort, laisser `/pipelines` réconcilier d'abord : le tableau voit alors
l'entrée d'historique et la parité tient. Consigner les relevés dans la section
`## Revue` du contrat.

## Recette : lire une vraie session

Le paquet ne vend aucun produit exécutable : la recette du lecteur de sessions
(`SessionReader`, `renderConversation`) passe donc par un test **désactivé par
défaut**, qui ne tourne que si on le lui demande explicitement.

```bash
cd omp-console
MEM0_SESSION_RECIPE="$HOME/.omp/agent/sessions/<bucket>/<horodatage>_<id>.jsonl" \
MEM0_SESSION_RECIPE_OUT="/tmp/rendu-session.txt" \
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --filter recette
```

`MEM0_SESSION_RECIPE` est le chemin de la session à lire ; `MEM0_SESSION_RECIPE_OUT`
est le chemin du rendu à écrire (les deux sont requis). Le test n'affirme rien sur
le contenu : il écrit le rendu et annonce les comptes à confronter.

`--filter recette` (mesuré) porte sur le nom de FONCTION du test, pas sur son titre
affiché : renommer `recetteManuelleRendUneVraieSession` sans garder « recette »
dans le nom ferait sélectionner zéro test (sortie « Build complete! » seulement).

À vérifier dans le fichier de sortie :

1. la suite des têtes `== <i> …` est `1…n` sans trou ni répétition (aucune perte, aucun doublon,
   ordre du fichier) — le nombre de référence est celui des entrées annoncé par la recette, car un
   corps est rendu verbatim et peut citer une ligne qui ressemble à une tête de bloc ;
2. les pensées (`-- thinking`), les appels d'outil (`-- tool`, `-- args`) avec
   leur résultat (`== <i> tool-result …`) et leur diff (`-- diff`) apparaissent ;
3. les marqueurs `compaction` et `branch-summary` apparaissent là où le fichier
   les place ;
4. pendant qu'un run écrit sa session, relancer la même commande sur son `.jsonl`
   vivant : le rendu est produit sans erreur, la taille et la date du fichier
   relevées avant et après la lecture sont inchangées, et le run poursuit et se
   termine sans erreur ;
5. consigner en revue les commandes exactes, les chemins, la taille du rendu, le
   nombre d'entrées, le nombre d'ignorées et l'état du run après la lecture.

La CI ne l'exécute **jamais** : ni `.github/workflows/check.yml` ni
`scripts/swift-app.sh` ne posent ces variables, donc le test est rapporté
« skipped ».

## Assembler le bundle `.app`

Depuis la **racine** du dépôt :

```bash
bash scripts/swift-app.sh
```

Le script compile en release, lance la suite en release, écrit le bundle dans
`omp-console/build/OMP Console.app`, le signe en ad hoc puis vérifie la
signature (`codesign --verify --strict`). Sous une plateforme autre que macOS, il
annonce « non exécuté » et sort en code 2 sans rien compiler.

## Ouvrir l'app

Double-cliquez `omp-console/build/OMP Console.app`, ou :

```bash
open "omp-console/build/OMP Console.app"
```

La fenêtre s'ouvre ; la barre de menus porte **« OMP Console »**. Pour le vérifier
sans cliquer (le processus doit être lancé) :

```bash
lsappinfo list | grep "OMP Console"
```

## Héberger une session OMP

Menu **Fichier ▸ « Nouvelle session OMP »** (⌘N) ouvre la fenêtre **Session OMP**,
qui héberge **une seule** session à la fois (la scène est à instance unique : il ne
peut pas exister deux `omp` hébergés).

1. **Choisir le projet** — bouton « Choisir un dossier… » (⌘O). Le dossier choisi
   devient le cwd passé au `omp` hébergé ; il est mémorisé, et il n'est jamais
   réécrit sans un geste de votre part.
2. **Choisir le mode** — deux modes, une différence réelle :
   - **`rpc-ui — dialogues actifs`** : le seul mode headless où l'outil `ask` de
     l'hôte existe. C'est le mode où un prompt peut déclencher une question à choix
     multiples, à laquelle la fenêtre répond.
   - **`rpc — sans dialogues`** : mode conducteur, sans `ask` côté hôte. Le prompt
     part, les événements arrivent, aucune question n'est posée.
3. **Lancer la session** (⌘R), saisir un prompt (↩ pour envoyer, ⌘↩ pour
   « Envoyer »), **lire** la transcription brute des trames reçues et le journal.
4. **Arrêter la session** (⌘.) ou quitter l'app : le process est terminé par la
   fermeture de son stdin (fin propre du protocole), il n'en reste aucun orphelin,
   et le fichier de session `.jsonl` reste sur disque, résumable.

États affichés dans la fenêtre : projet absent, `Aucune session`, `Lancement…`,
`Session vivante (pid <n>, session <8 caractères>)`, dialogue en attente,
`Arrêt en cours…`, `Session arrêtée`, `Process mort (code|signal <n>)` (avec un
bouton **Relancer**, qui reprend le même `.jsonl`), et l'erreur explicite en cas
d'échec. Un prompt n'est jamais relancé tout seul après une mort : la relance est
un clic.

### Trouver le binaire `omp`

La variable d'environnement **`OMP_CONSOLE_OMP_BINARY`** fixe le chemin du binaire :
quand elle est posée et non vide, c'est le **seul** candidat — pratique pour un
`omp` hors des emplacements habituels, ou pour forcer un poste sans `omp` (utile
avec le harnais ci-dessous).

Sans elle, l'ordre de recherche est : chaque entrée de `PATH`, puis
`~/.bun/bin/omp`, `/opt/homebrew/bin/omp`, `/usr/local/bin/omp` — le premier
fichier **exécutable** gagne. Les trois emplacements explicites ne sont pas
décoratifs : une app lancée par le Finder hérite du `PATH` de `launchd`
(`/usr/bin:/bin:/usr/sbin:/sbin`) et ne verrait donc jamais `~/.bun/bin`, où `omp`
s'installe couramment.

Si aucun candidat n'est exécutable, la fenêtre affiche « Binaire `omp` introuvable :
cherché dans PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin. » — aucune session
fantôme n'est affichée comme vivante.

## Harnais réel

La suite de tests contient quatre tests **réels** qui lancent un vrai `omp` (donc
font de vrais appels au modèle) et parcourent l'aller-retour complet : prompt →
événements → dialogue `ask` répondu → fin de tour, le mode conducteur sans
dialogues, un `SIGKILL` suivi d'une relance qui reprend le même `.jsonl`, et la
fermeture de l'app sans orphelin.

Ces tests ne tournent que si **`omp` est résoluble** sur la machine (garde sur la
plateforme macOS **et** la résolution du binaire). Ailleurs — notamment en
intégration continue, où aucun binaire `omp` n'est installé — ils sont rapportés
« skipped » et la suite reste verte. Leur nom de fonction commence par `harness`,
donc :

```bash
cd omp-console
# Une boucle locale rapide, sans appel modèle et sans session réelle :
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --skip harness
```

`scripts/swift-app.sh` et `bash scripts/check.sh` lancent la suite **sans** ce
filtre : sur un poste qui a `omp`, ils exécutent donc une vraie session avec appel
modèle, et prennent le temps d'un tour réel. `OMP_CONSOLE_OMP_BINARY=/nonexistent/omp`
force le chemin « non exécuté » quand on veut la suite complète sans session réelle.

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 14, deux cibles)
├── Sources/OMPConsole/
│   ├── OMPConsoleApp.swift        point d'entrée (@main), scènes et menu
│   ├── ConsoleRootView.swift      fenêtre, barre latérale, détail
│   ├── SectionViews.swift         les quatre vues de section
│   ├── ConsoleSection.swift       les quatre sections et leurs libellés
│   ├── ConsoleModel.swift         l'état : la section courante
│   ├── SessionConsoleView.swift   fenêtre « Session OMP » (cinq zones, tous les états)
│   ├── SessionConsoleModel.swift  projet, mode, prompt, dialogue, statut, actions
│   ├── SessionHost.swift          session hébergée : poignée de main, corrélation,
│   │                              dialogues, mort, relance, arrêt propre
│   ├── RpcFrames.swift            trames JSONL : décodage, commandes, réponses
│   ├── RpcChunkDecoder.swift      fragments v2 et lignes illisibles
│   ├── RpcTransport.swift         process hébergé : tubes, signaux, sortie
│   ├── OmpBinary.swift            résolution du binaire `omp`
│   ├── Session/                   le lecteur de sessions (aucune vue, aucune E/S d'écriture)
│   │   ├── SessionModel.swift     le modèle de conversation : des valeurs
│   │   ├── SessionReader.swift    lecture incrémentale tirée par l'appelant
│   │   └── SessionRendering.swift le rendu texte du modèle (fonctions pures)
│   ├── Store/                     la couche de lecture du magasin d'état
│   │   ├── PipelineStore.swift    racine du magasin et noms des six stores
│   │   ├── StoreModels.swift      modèles typés et validation champ par champ
│   │   ├── StoreSnapshot.swift    enveloppes d'un instantané
│   │   ├── StoreReader.swift      balayage, filtrage, entrées écartées nommées
│   │   ├── StoreWatcher.swift     veille vnode d'un store et flux d'abonnés
│   │   └── StoreHub.swift         le flux global, agrégat des six
│   └── Kanban/                    le tableau des pipelines (lecture seule)
│       ├── KanbanModels.swift     colonnes, cartes, sources, marques, clé de dépôt
│       ├── KanbanBoard.swift      construction pure de l'ardoise, textes de parité
│       ├── KanbanAnomalies.swift  illisible, mort, doublon : bandeau et marques
│       ├── KanbanModel.swift      abonnement au flux, sélection, clavier
│       ├── KanbanView.swift       la section : bandeau, onze colonnes, clavier
│       ├── KanbanCardView.swift   une carte cliquable (durée sous TimelineView)
│       └── KanbanDetailView.swift le panneau de détail
├── Tests/OMPConsoleTests/         la suite Swift Testing
├── Bundle/Info.plist              le plist du bundle .app
└── build/                         artefacts (bundle .app), ignorés par git
```

## Plateforme

La section `── App Swift` de `scripts/check.sh` ne tourne que sous macOS : elle
compile le paquet, lance ses tests et assemble le bundle. Sous Ubuntu, elle
annonce « non exécuté » sans faire échouer la validation du dépôt ; les tests réels
du harnais y sont eux aussi « skipped », faute de `omp`.
