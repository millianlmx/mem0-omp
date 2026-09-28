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

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 14, deux cibles)
├── Sources/OMPConsole/            la coque (une vue par section)
│   ├── OMPConsoleApp.swift        point d'entrée (@main)
│   ├── ConsoleRootView.swift      fenêtre, barre latérale, détail
│   ├── SectionViews.swift         les quatre vues de section
│   ├── ConsoleSection.swift       les quatre sections et leurs libellés
│   └── ConsoleModel.swift         l'état : la section courante
├── Tests/OMPConsoleTests/         la suite Swift Testing
├── Bundle/Info.plist              le plist du bundle .app
└── build/                         artefacts (bundle .app), ignorés par git
```

## Plateforme

La section `── App Swift` de `scripts/check.sh` ne tourne que sous macOS : elle
compile le paquet, lance ses tests et assemble le bundle. Sous Ubuntu, elle
annonce « non exécuté » sans faire échouer la validation du dépôt.
