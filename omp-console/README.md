# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : une fenêtre, une barre latérale à quatre sections — **Kanban**,
**Sessions**, **Fichiers**, **Projet** — et un panneau de détail. Chaque vue
n'affiche aujourd'hui qu'un contenu de remplacement : **aucune logique métier**
n'y vit encore. Cible minimale : macOS 14.

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
  incomplet est **écartée et comptée**, jamais rendue partielle ; `availability`
  distingue « magasin absent » de « magasin vide ».
- `StoreWatcher` veille un store par **notification du système de fichiers**
  (source vnode sur le répertoire, jamais de scrutation) et pousse un instantané
  typé à ses abonnés (`AsyncStream`, multicast) ; `StoreHub` agrège les six en un
  flux global. L'émission n'a lieu que si l'instantané a changé.
- La couche est un **lecteur** : aucune API d'écriture n'est appelée, jamais — un
  propriétaire mort est marqué (`isStale`), ni retiré ni déplacé vers `history/`.

`commands/` ne fait pas partie du périmètre lu. Les vues (kanban, sessions,
fichiers, projet) consommeront ces flux dans les features suivantes : aucune n'est
branchée ici.
## Visionneuse de session

La section **Sessions** de la barre latérale liste les runs du magasin d'état
(les vivants d'abord, puis les runs clos) : chaque ligne est un bouton, et la
cliquer ouvre la **conversation de la session de ce run** dans une fenêtre dédiée.

- **Une fenêtre par session.** Re-choisir un run déjà ouvert ramène sa fenêtre au
  premier plan (la valeur présentée est la session, pas l'entrée du magasin) ;
  choisir un autre run en ouvre une seconde. Le titre de la fenêtre est
  `« <libellé du run> — <étiquette de session> »`.
- **Les faits essentiels y sont, une fois chacun, dans l'ordre du fichier** :
  messages avec leur rôle (« vous », « agent »), nom et cible de chaque appel
  d'outil, arguments, résultats, question `ask` et ses options, marqueurs de
  compaction et de branche.
- **Chaque appel d'outil se plie et se déplie individuellement** (replié par
  défaut ; un appel `ask` entre déplié), avec le statut `⇒ en attente`,
  `⇒ ok · N lignes` ou `⇒ erreur · N lignes`.
- **Diffs colorés par contenu** : tout diff unifié reçu d'un outil est détecté dans
  le texte du résultat, et le diff d'un appel d'édition d'OMP (`details.diff`) est
  classé ligne à ligne. Ajout, suppression, contexte et en-têtes sont distingués —
  par la couleur ET par la valeur d'accessibilité de chaque ligne (« ligne
  ajoutée », « ligne supprimée », « contexte », « en-tête de diff »).
- **Une question `ask` est mise en évidence, et ne se répond pas ici** : la
  visionneuse affiche la question et ses options, sans aucun geste pour y répondre.
- **Suivi automatique** : la vue ouvre le fil par la fin, puis suit les faits
  nouveaux en relisant **seulement les octets neufs** (le lecteur tient un curseur
  d'octets ; la veille est une source vnode sur le fichier, jamais une scrutation).
  Un geste vers le haut suspend le suivi — la position ne bouge plus et le bouton
  **« Revenir au direct »** apparaît ; l'activer reprend le suivi.
- **États explicites** : « en attente des premiers faits » tant que le fichier
  n'existe pas, « Session illisible : … Nouvelle tentative automatique. » s'il n'est
  pas lisible, « Session vide — aucun fait. » s'il est vide. Le bandeau du haut
  annonce en permanence `N faits · N ignorés · suivi|suivi suspendu`, plus l'état de
  lecture et, le cas échéant, `· fichier réécrit — affichage reconstruit`.
- **Lecture seule** : la visionneuse n'appelle aucune API d'écriture. Vérifier
  tient en une commande : la taille et l'empreinte du `.jsonl` ne changent pas
  pendant qu'on défile, qu'on plie ou que des faits arrivent.

### Recette : journaliser une vraie session

Même principe que la recette du lecteur — un test **désactivé par défaut** :

```bash
cd omp-console
MEM0_VIEWER_RECIPE="$HOME/.omp/agent/sessions/<bucket>/<horodatage>_<id>.jsonl" \
MEM0_VIEWER_RECIPE_OUT="/tmp/journal-visionneuse.txt" \
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --filter recette
```

Le journal écrit une ligne par fait affiché (identité de ligne, rôle, texte, appels
d'outil avec leur cible et leurs arguments, question `ask` et options, diffs), à
confronter à la session de référence et au TUI.

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
│   └── Store/                     la couche de lecture du magasin d'état
│       ├── PipelineStore.swift    racine du magasin et noms des six stores
│       ├── StoreModels.swift      modèles typés et validation champ par champ
│       ├── StoreSnapshot.swift    enveloppes d'un instantané
│       ├── StoreReader.swift      balayage, filtrage, comptage des illisibles
│       ├── StoreWatcher.swift     veille vnode d'un store et flux d'abonnés
│       └── StoreHub.swift         le flux global, agrégat des six
│   └── Viewer/                    la visionneuse de session (aucune écriture)
│       ├── ViewerTarget.swift     la valeur d'une fenêtre : la session, et son titre
│       ├── SessionSelectorModel.swift  les runs choisissables, depuis le magasin
│       ├── SessionSelectorView.swift   la section « Sessions » : la liste
│       ├── SessionRows.swift      faits affichables, en-tête d'appel, question `ask`
│       ├── SessionDiffLines.swift diffs : classification et découpe des corps
│       ├── SessionFileWatcher.swift  veille vnode du fichier de session
│       ├── SessionViewerModel.swift  lignes, plis, suivi, états, journal d'octets
│       ├── SessionViewerView.swift   bandeau, flux, états vides, « Revenir au direct »
│       ├── SessionRowView.swift      le rendu d'un fait (dont les lignes de diff)
│       └── ScrollBottomObserver.swift la géométrie du défilement et ses gestes
├── Tests/OMPConsoleTests/         la suite Swift Testing
├── Bundle/Info.plist              le plist du bundle .app
└── build/                         artefacts (bundle .app), ignorés par git
```

## Plateforme

La section `── App Swift` de `scripts/check.sh` ne tourne que sous macOS : elle
compile le paquet, lance ses tests et assemble le bundle. Sous Ubuntu, elle
annonce « non exécuté » sans faire échouer la validation du dépôt ; les tests réels
du harnais y sont eux aussi « skipped », faute de `omp`.
