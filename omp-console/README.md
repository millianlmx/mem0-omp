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
│   └── OmpBinary.swift            résolution du binaire `omp`
├── Tests/OMPConsoleTests/         la suite Swift Testing
├── Bundle/Info.plist              le plist du bundle .app
└── build/                         artefacts (bundle .app), ignorés par git
```

## Plateforme

La section `── App Swift` de `scripts/check.sh` ne tourne que sous macOS : elle
compile le paquet, lance ses tests et assemble le bundle. Sous Ubuntu, elle
annonce « non exécuté » sans faire échouer la validation du dépôt ; les tests réels
du harnais y sont eux aussi « skipped », faute de `omp`.
