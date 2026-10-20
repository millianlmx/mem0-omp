# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : **une seule fenêtre**, une barre latérale à huit sections en deux
groupes — **Pilotage** (**Accueil**, **Pipelines**, **Projet**, **Audit**,
**Statistiques**) et **Consultation** (**Terminal**, **Fichiers**, **Mémoire**),
raccourcis ⌘1…⌘8 — et un panneau de détail. Rien n'ouvre de fenêtre annexe :
l'app est utilisable entièrement en plein écran. Les fenêtres ne se regroupent pas
en onglets : Présentation et Fenêtre n'ont aucune entrée d'onglet, et aucun menu
ne montre de séparateur en tête, en fin ou en double.

Les cinq sections de **Pilotage** lisent et lancent le travail sur le **serveur de
pipelines du VPS** (`omp-harness`, le seul moteur de pipelines, voir « Serveur de
pipelines ») : l'app n'exécute aucune pipeline elle-même. Les trois sections de
**Consultation** restent locales au Mac : **Terminal** le terminal intégré (voir
« Section Terminal »), **Fichiers** la visionneuse de fichiers et de diffs (voir
« Lire les fichiers et les diffs d'une cible ») et **Mémoire** la mémoire du
projet (voir « Consulter et corriger la mémoire du projet »). Liquid Glass est
réservé à la couche fonctionnelle que le système dessine (barre latérale, barres
d'outils, feuilles) ; le contenu emploie des surfaces opaques et les boutons
standard `.bordered`/`.borderedProminent` (HIG Materials : « Don't use Liquid
Glass in the content layer »).
Cible minimale : macOS 26.

- [Prérequis](#prérequis)
- [Premiers pas](#premiers-pas)
- [Cibles](#cibles)
- [Builder](#builder)
- [Tester](#tester)
- [Serveur de pipelines](#serveur-de-pipelines)
- [Lire les fichiers et les diffs d'une cible](#lire-les-fichiers-et-les-diffs-dune-cible)
- [Recette : lire une vraie cible](#recette--lire-une-vraie-cible)
- [Assembler le bundle `.app`](#assembler-le-bundle-app)
- [Ouvrir l'app](#ouvrir-lapp)
- [Recompiler et relancer d'un coup](#recompiler-et-relancer-dun-coup)
- [Les hooks git : recompiler après un pull](#les-hooks-git--recompiler-après-un-pull)
- [Composants de l'app](#composants-de-lapp)
- [Le binaire `omp` de l'app](#le-binaire-omp-de-lapp)
- [Section Terminal (terminal intégré)](#section-terminal-terminal-intégré)
- [Confirmation au Quitter](#confirmation-au-quitter)
- [Harnais réel](#harnais-réel)
- [Consulter et corriger la mémoire du projet](#consulter-et-corriger-la-mémoire-du-projet)
- [API distante](#api-distante)
- [Vocabulaire et typographie](#vocabulaire-et-typographie)
- [Structure du paquet](#structure-du-paquet)
- [Plateforme](#plateforme)
- [Coque iOS](#coque-ios)

## Prérequis

- macOS 26 ou plus récent, sur **Apple Silicon (arm64)** : l'app installe son
  `omp` et embarque son service mémoire `mem0-rs` pour cette architecture, et
  refuse les autres.
- Pour **assembler** le bundle : Rust (`cargo`), qui compile le `mem0-rs` embarqué
  (voir « Assembler le bundle `.app` »). L'app installée n'en a pas besoin.
- Les Command Line Tools d'Apple suffisent pour **builder et tester** le paquet :
  `swift --version` doit répondre. Tout passe par SwiftPM (`swift build`,
  `swift test`).
- **Xcode** (et non plus les seuls Command Line Tools) est requis pour
  **assembler** le bundle : `scripts/swift-app.sh` appelle le processeur de
  métadonnées App Intents d'Xcode, que les Command Line Tools n'ont pas.
  `xcrun --find appintentsmetadataprocessor` doit répondre ; `DEVELOPER_DIR` est
  honoré (sinon `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`).
  `xcodebuild` ne sert pas à construire : contre `Package.swift`, il construit le
  produit exécutable comme un « tool », sans extraire aucune métadonnée App Intents.
- **Le serveur de pipelines du VPS** pour les sections de Pilotage : son adresse
  https et son jeton se saisissent dans la feuille « Serveur » (voir « Serveur de
  pipelines »). Sans serveur relié, ces sections le disent et proposent « Relier le
  serveur… » ; Terminal, Fichiers et Mémoire n'en ont pas besoin.
- **Rien d'autre à installer** : ni `omp`, ni Docker, ni podman, ni conteneur —
  l'app installe son `omp` et démarre son service mémoire au premier lancement
  (voir « Composants de l'app » et « Service mémoire »). Restent hors périmètre,
  mais SIGNALÉS par l'app quand ils manquent : **oMLX** (natif, port 8000) et
  **git**.

## Premiers pas

Tout se fait depuis l'app, sans terminal :

1. **La préparation** — l'app installe son composant (OMP 18.6.0), reprend une
   seule fois les souvenirs de l'ancienne mémoire à conteneurs si elle en trouve
   une, démarre son service mémoire (`mem0-rs`, agent launchd) et sonde oMLX. La
   feuille « Préparation d'OMP Console » montre une ligne par étape
   (Composants, Migration de la mémoire, Service mémoire, Prérequis) avec son état ;
   pendant une étape, un bloc pleine largeur sous les lignes nomme l'étape en
   cours et porte une barre de progression, chiffrée quand la taille du
   téléchargement est connue, indéterminée sinon.
   - **OMP absent au lancement** : rien ne se télécharge d'office. La feuille est
     **bloquante** — aucun « Fermer », Échap sans effet — et ne propose que
     « Quitter » (⌘Q, à gauche ; il quitte vraiment l'app), « Réessayer » (relit la
     présence d'OMP sans rien télécharger ; s'il manque toujours, la feuille le
     dit) et « Installer » (`↩`, proéminent), qui lance toute la préparation. Dès
     que le binaire d'OMP est placé, la feuille devient fermable, pendant que la
     mémoire se prépare.
   - **OMP présent** (seule la mémoire reste à préparer) : la préparation
     démarre d'elle-même et la feuille est **fermable** ; « Fermer » (Échap)
     n'interrompt RIEN — la préparation continue en arrière-plan ; `↩` déclenche
     le bouton proéminent.
   - **Échec** : une phrase claire (« Pas de réseau : … », « empreinte SHA-256
     différente », « Ce Mac n'est pas pris en charge (arm64 requis) », …) ; le
     détail technique, s'il existe, est replié derrière « Afficher le détail » et,
     déplié, tient dans une zone de hauteur fixe qui défile. « Réessayer » (`↩`)
     relance la chaîne. Un échec de la migration ou du service mémoire dit la
     conséquence puis le geste (« Le service mémoire n'a pas répondu : les
     souvenirs sont indisponibles. Réessayez ; si l'échec revient, copiez le
     diagnostic pour le signaler. ») ; un port tenu par un autre programme nomme
     ce programme (« Le programme « nc » occupe la place réservée à la mémoire :
     celle-ci ne peut pas démarrer. Quittez-le, puis réessayez. »), sans pid ni
     port. « Copier le diagnostic » (`sheet.setup.diagnostic`, sous « Réessayer »
     et « Fermer ») met la commande, le détail brut, le port et le geste shell
     dans le presse-papiers, et la phrase relayée à l'iPhone (`setupBanner` de
     `GET /v1/components`) ne porte que la conséquence.
   - **Import avec rejets** : la ligne « Migration de la mémoire » dit le nombre
     d'éléments laissés de côté et leurs raisons ; le pied propose « Basculer
     quand même », « Réessayer » (`↩`) et « Fermer » (voir « Migration unique de
     l'ancienne mémoire »).

   À la fin de toute la préparation, la feuille se ferme d'elle-même. Rien ne
   dépend d'un `omp` système.
2. **Relier le serveur de pipelines** — sans serveur relié, l'Accueil, Pipelines,
   Projet, Audit et Statistiques montrent « Aucun serveur relié… » et le bouton
   « Relier le serveur… » (`server.configure`), qui ouvre la feuille « Serveur » :
   l'adresse du serveur et son jeton d'accès (voir « Serveur de pipelines »).
3. **Piloter** — Pipelines lance une feature, Projet un projet, Audit un audit ;
   l'Accueil résume la boîte de l'humain et y répond (questions à trancher, specs et
   verdicts à valider, décisions à relire, audits à trier). Le serveur conduit seul
   chaque feature de /req au merge ; l'app ne lance aucun process `omp` pour une
   pipeline.

**La mémoire survit à ⌘Q** : le service mémoire est un agent launchd
(`com.omp.console.mem0-rs`), pas un process de l'app — le Quitter de l'app ne le
touche pas. Fermer l'app (ou la voir plantée) ne coupe donc pas la mémoire : une
session `omp` au terminal, ou un `omp -p`, sur un dépôt reçoit toujours son rappel
par `http://localhost:8321` (le défaut du plugin `omp-mem0-memory`).

Les commandes `/req`, `/project`, `/audit` et `/pipelines` d'une session OMP passent
par le même serveur (plugin `omp-mem0-req`). Quelle copie de ce plugin OMP charge,
comment en changer (version publiée ou copie de travail) et comment relancer `omp`
ensuite : `PUBLISHING.md` § « Mettre à jour », à la racine du dépôt.

### Barres d'outils

| Section | Barre d'outils |
|---|---|
| Accueil, Pipelines, Projet, Audit, Statistiques | « Actualiser » (`server.refresh`, ⌘R : relit la boîte et, hors Accueil, le catalogue du serveur ; inactif sans serveur relié ou pendant une lecture), puis « Serveur » (`server.open`) : la feuille du serveur de pipelines |
| Terminal | « Choisir… » (`terminal.choose`), « Relancer » (`terminal.relaunch`), « Lancer OMP » (`terminal.launchOmp`) — trois groupes séparés |

Identifiants des sections de Pilotage : `home.harness`, `pipelines.harness`,
`project.harness`, `audit.harness`, `stats.harness` (le formulaire de chaque
section), `server.failure` (l'échec du dernier échange, en tête), `server.configure`
(sans serveur relié) ; champs de lancement `pipelines.launch.title`,
`pipelines.launch.request`, `pipelines.launch.commit`, `project.launch.title`,
`project.launch.commit`, `audit.launch.focus`, `audit.launch.commit` ; feuille
« Serveur » `server.sheet` (`server.address`, `server.secret`, `server.save`,
`server.forget`). Feuille « Préparation d'OMP Console » `sheet.setup`
(`sheet.setup.install`, `sheet.setup.retry`, `sheet.setup.switchAnyway`,
`sheet.setup.quit`, `sheet.setup.close`, `sheet.setup.ompMissing`,
`sheet.setup.retryMissed`, lignes
`sheet.setup.row.<components|migration|service|prerequisites>`, bloc de
progression `sheet.setup.progress` avec `sheet.setup.progress.label` et
`sheet.setup.progress.bar`, échec `sheet.setup.failure`, rejets de l'import
`sheet.setup.rejected` (choix `sheet.setup.rejected.choice`),
`sheet.setup.detail.toggle`, `sheet.setup.detail`, `sheet.setup.diagnostic`).

Le badge d'état des composants embarqués, au pied de la barre latérale, est
`components.badge` (mot + point teinté) ; son état ne dépend que de la présence
des deux binaires sous la racine de l'app. Quand un composant manque, c'est un
bouton (AXButton) qui rouvre la feuille de préparation.

## Cibles

Le paquet déclare ces cibles (une ligne par cible, `omp-console/Package.swift`) :

- **OMPConsole** — la coque macOS : les vues, les modèles d'écran et les
  adaptateurs au système (AppKit, SwiftUI, PTY, réseau). Cible exécutable ;
  dépend de `ConsoleCore` et de `ConsoleClient` (le client du serveur de
  pipelines, partagé avec l'app iOS).
- **OMPConsoleTests** — la suite Swift Testing de la coque ; dépend de
  `OMPConsole`, de `ConsoleCore` et de `ConsoleClient` (son test de contrat
  confronte le catalogue du client aux routes servies).
- **ConsoleClient** — la **cible partagée macOS/iOS du client distant** : le
  client typé du contrat d'API, la découverte Bonjour, le transport HTTP, le flux
  SSE, le trousseau et le modèle observable unique — plus le client du serveur de
  pipelines du VPS (`Harness*.swift`). Dépendance unique :
  `ConsoleCore` ; ni AppKit ni UIKit.
- **ConsoleClientTests** — la suite Swift Testing hermétique de la couche
  cliente (doublures de transport, de trousseau et de découverte : aucun Mac
  réel) ; dépend de `ConsoleClient` et de `ConsoleCore`.
- **ConsoleCore** — la **cible partagée macOS/iOS** : le vocabulaire figé des
  sections (`ConsoleSection`), les mots du serveur de pipelines
  (`PipelineServerText`), le socle du contrat de l'API distante (`ConsoleAPI`), le
  noyau du graphe de la mémoire et le rendu Markdown (`MarkdownDocument`). Aucune
  dépendance (ni interne, ni externe) : elle se compile seule
  (`swift build --target ConsoleCore`) et n'importe ni AppKit ni UIKit — la
  section « Noyau partagé » de `scripts/check.sh` le tient.

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
# `--no-parallel` : la suite mêle des tests à VEILLE qui attendent sur le fil
# principal (modèles Fichiers et Terminal) et des tests de vue ; en parallèle elle
# rend 10 à 15 échecs de délai ; mesuré le 2026-10-04 : en série 701 tests verts, 0 échec (~54 s).
swift test --scratch-path .build-tests --no-parallel \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

Sous les Command Line Tools seuls, XCTest n'existe pas : la suite du paquet
utilise **Swift Testing**, la seule bibliothèque de tests fournie avec le
toolchain.

Trois pièges mesurés sur Swift 6.4 CLT seuls expliquent cette ligne :

- `swift test` doit être la **première** commande écrite dans son dossier de
  build : un `swift build` préalable dans le même dossier fait échouer la
  compilation des tests (« plugin for module 'TestingMacros' not found »). D'où
  le `--scratch-path .build-tests` dédié — `scripts/swift-app.sh` compile et
  teste de son côté dans `omp-console/.build-app`.
- même sans build préalable, `swift test` échoue environ une fois sur trois en
  « plugin for module 'TestingMacros' not found », de façon non déterministe
  (reproduit sur un paquet minimal). Le `-plugin-path` explicite ci-dessus rend
  la suite déterministe.
- en **parallèle**, la suite complète est instable : les tests de modèle à veille
  interrogent le fil principal, que les tests de vue saturent — mesuré le
  2026-09-29 (fusion des trois features de « Les vues ») : 10 à 15 échecs de
  délai sur 212 tests en parallèle, 212/212 en série. `--no-parallel` est donc la
  règle du dépôt, dans la commande locale comme dans `scripts/swift-app.sh`.

## Serveur de pipelines

Les cinq sections de **Pilotage** — Accueil, Pipelines, Projet, Audit et
Statistiques — sont servies par le serveur de pipelines du VPS (`omp-harness`, voir
`omp-harness/README.md`), sur le Mac (`Sources/OMPConsole/Server/`) comme sur
l'iPhone et l'iPad (`ios/OMPConsoleIOS/IOSHarnessScreens.swift`). C'est le seul
moteur de pipelines : l'app lit son état et lui envoie des gestes, sans jamais
exécuter une étape elle-même.

- **Connexion directe.** L'app joint le serveur en https (Tailscale ou un reverse
  proxy TLS), sans passer par le Mac sur iOS. La feuille « Serveur » (bouton
  « Serveur » de la barre d'outils, `Sources/OMPConsole/Server/ServerSheet.swift`
  et `ios/OMPConsoleIOS/IOSServerSheet.swift`) demande deux choses : l'adresse,
  gardée dans les préférences (`harness.address`), et le jeton du serveur
  (`/var/lib/omp-harness/state/token`), gardé dans le trousseau
  (`com.omp.console.harness`). Elles ne sont enregistrées qu'après une boîte
  effectivement lue ; « Oublier ce serveur » les efface de l'appareil.
- **Un seul client.** Un `HarnessModel` et un `HarnessDrafts` pour toute la
  fenêtre : les cinq sections partagent la même boîte, le même catalogue et les
  mêmes brouillons de lancement. Sans serveur relié, chacune montre le même appel à
  le relier ; l'échec du dernier échange s'affiche en tête de section, avec sa
  cause puis son remède.
- **Accueil** — le résumé de la boîte de l'humain (`GET /v1/inbox`) : ce qui
  attend une décision (questions à trancher, specs à valider, verdicts à valider,
  décisions à relire, audits à trier), puis le détail, en sections :
  - **À trancher** : les escalades d'une feature, répondues en un seul geste
    (`POST /v1/runs/{id}/escalations`) ; la feature reprend quand toutes ont leur
    réponse ;
  - **Specs à valider** : la porte des specs — après /specs, la feature attend
    l'humain avant /impl. « Lire les specs » montre `specs.md` du run
    (`GET /v1/runs/{id}`), « Valider les specs » lance /impl, « Refuser » demande une
    raison, qui fait réécrire les specs et rejoint la mémoire du projet ;
  - **Verdicts à valider** : verdict, risque, bloquants, points non vérifiés ; un
    verdict faible demande de lire les différences. « Valider et fusionner » ou
    « Refuser » avec une raison (`POST /v1/runs/{id}/validate`) ;
  - **Décisions prises seules** : chaque choix réversible d'un agent est un point
    de reprise — « Accepter », ou « Renverser… » avec une option et une raison, qui
    fait reprendre la feature à cet endroit ;
  - **Features en cours**, chacune avec « Arrêter la feature » (confirmé ; la
    branche reste, pour inspection).
- **Pipelines** — « Nouvelle feature » : le dépôt (parmi ceux que le serveur déclare,
  `GET /v1/status`), un titre et la demande ; « Lancer » (`POST /v1/runs`) confie la
  feature au serveur, qui la conduit seul — besoins, specs (à valider),
  implémentation, revue, fusion. Puis « Toutes les features », avec leur état et
  leur étape.
- **Projet** — « Nouveau projet » : un nom et ses features (titre et demande,
  « Ajouter une feature » / « Retirer ») ; « Lancer » (`POST /v1/projects`) : les
  features dont les modules sont disjoints tournent en parallèle, chacune fusionnée
  dès sa validation. Puis la liste des projets (`GET /v1/projects`), avec le
  décompte de leurs features fusionnées.
- **Audit** — « Nouvel audit » : un périmètre (vide : le dépôt entier) ; « Lancer »
  (`POST /v1/audits`). Un agent lit la branche principale sans rien modifier, puis
  propose des faiblesses à corriger et des features. Les propositions se cochent,
  puis « Lancer la sélection en projet » (`POST /v1/audits/{id}/launch`) ;
  « Annuler l'audit » (`POST /v1/audits/{id}/cancel`) tant qu'il n'est pas lancé.
- **Statistiques** — `GET /v1/stats` : features (total, par état, fusionnées sur 7
  jours, taux de fusion, délai médian jusqu'à la fusion, corrections par fusion),
  étapes (nombre, échecs, durée médiane), tests (repris du cache, relancés après un
  manque de mémoire) et capacité du serveur (runners, slots lourds, mémoire libre).
- **Mise à jour en direct.** L'app suit le flux SSE du serveur
  (`GET /v1/events`) à partir du curseur de la boîte ; chaque événement relit la
  boîte et, une fois une section de catalogue ouverte, le catalogue. Une coupure
  garde la dernière boîte reçue, signalée « Hors ligne : dernière boîte reçue ».
  « Actualiser » (⌘R) relit à la demande.
- **Badges.** La barre latérale (et, sur iOS, la barre d'onglets) porte sur
  « Accueil » le nombre de ce qui attend l'humain, et sur « Audit » le nombre
  d'audits à trier.
- **Code partagé.** Le modèle (`HarnessModel`), les brouillons (`HarnessDrafts`),
  le transport (`HarnessTransport`) et le contrat (`HarnessWire`) vivent dans
  `ConsoleClient` ; les mots vivent dans `ConsoleCore` (`PipelineServerText`). La
  garde `test/console/serveur-de-pipelines.test.ts` confronte chaque champ décodé
  au JSON réel du serveur et chaque route appelée à son routeur.

## Lire les fichiers et les diffs d'une cible

La section **Fichiers** est une visionneuse **strictement en lecture** de l'arbre
d'une cible git — le dépôt principal ou l'un des worktrees `feat/*` connus, une
seule cible à la fois.

**Sans projet choisi** (la préférence `session.projectRoot` absente ou vers un
dossier disparu), la section affiche « Aucun projet ouvert » — « Choisissez le
projet dont vous voulez parcourir les fichiers. » — et un bouton **Choisir un
projet…** (`files.chooseProject`). Le même bouton porte l'état vide de
**Mémoire** et du **Terminal** : quand l'app connaît des projets (les derniers
choisis, `projects.recent`, racines git encore présentes), il ouvre un menu d'une
entrée par projet — nommée par son dossier, « nom — dossier parent » quand deux
projets portent le même nom —, puis « Choisir un dossier… » ; quand elle n'en
connaît aucun, c'est un bouton simple qui ouvre directement le panneau
d'ouverture (« Choisissez le dossier du projet. »). Le choix devient le projet de
l'app (`ProjectChooserModel`, seul écrivain de la préférence) et remplit l'écran
courant sans changer de section. Un panneau annulé, ou un projet dont le dossier a
disparu entre-temps (il sort alors du menu), laisse l'état vide tel quel.

1. **Choisir la cible** — le sélecteur « Dossier » de l'en-tête. La cible par défaut
   est celle du projet ouvert (la préférence partagée `session.projectRoot`) ; à
   défaut, le dépôt principal. Chaque cible affiche sa base de comparaison : `HEAD`
   pour le principal, ou `base <sha7>` — la base de fusion avec la branche par
   défaut du principal.
2. **Parcourir l'arbre** — colonne de gauche : fichiers **suivis** et **non suivis**
   de la cible, `.gitignore` appliqué. Un fichier suivi supprimé sur disque y reste,
   avec le badge « supprimé » ; un fichier ignoré par git n'y figure jamais.
3. **Lire un fichier** — un clic (ou ↑/↓) publie le document à droite, avec un
   sélecteur « Affichage » (`files.document.mode`) quand plusieurs vues existent :
   - un **Markdown** (`.md`, `.markdown`) est **rendu** en blocs complets — titres,
     paragraphes (emphase, code, liens), listes imbriquées, citations, blocs de code
     colorés, tableaux, séparateurs — dans une colonne de lecture
     (`files.document.markdown`, `MarkdownDocument`) ; « Source » montre le texte ;
   - tout autre fichier texte s'affiche dans une **visionneuse de code** à la Xcode
     (`files.document.code`) : gouttière numérotée, police monospacée, coloration
     lexicale (mots-clés, chaînes, commentaires, nombres, types, attributs —
     `CodeHighlighter`) pour Swift, TypeScript/JavaScript, Python, shell, JSON et
     YAML, texte brut numéroté sinon ;
   - « Diff » montre l'écart entre la cible et sa base (commits de la branche **et**
     modifications non commitées) ; un fichier non suivi y apparaît comme un ajout
     complet. Le diff est rendu en une seule colonne, hunks dans l'ordre de git,
     retraits en rouge, ajouts en vert — et jamais par la couleur seule : le `-` et
     le `+` de tête sont toujours là.
4. **Suivre les changements** — la cible active est surveillée par **FSEvents** (un
   seul descripteur récursif sur sa racine) : un fichier ajouté ou modifié met
   l'arbre et le document à jour sans geste, au plus un rechargement par 300 ms
   d'accalmie. Pas de scrutation périodique. **⌘R** (ou « Rafraîchir ») force un
   rechargement immédiat.

**Échecs lisibles.** Aucun texte affiché ne cite de commande git, de code de
sortie, de stderr ni de chemin : chaque `FilesError` a sa phrase dans `FilesText`
(« Les outils de développement d'Apple sont introuvables… », « Ce dossier n'est
pas un projet suivi… », « La lecture du projet a échoué… », etc.) et le détail brut
(`FilesError.diagnostic` : commande, code, stderr, chemin) ne part que par le bouton
**Copier le diagnostic** (presse-papiers, retour « Diagnostic copié » pendant 2 s).
L'état d'erreur montre la phrase, « Rafraîchir » (`files.error.refresh`, même action
que ⌘R) puis la copie (`files.error.diagnostic`) ; le bandeau d'avis (veille
arrêtée, dossier disparu) porte `files.notice.diagnostic` ; un fichier illisible,
une base de comparaison introuvable ou un diff en échec portent
`files.document.diagnostic`. Un fichier binaire dit « Ce fichier n'est pas du
texte : il ne peut pas être affiché. », sans taille ; un dossier vide « Aucun
fichier dans ce dossier. ».

**Garanties de lecture seule.** Les seules commandes git employées sont
`ls-files -z --cached`, `ls-files -z --others --exclude-standard`,
`diff --no-color --no-ext-diff <base> -- <chemin>`,
`diff --no-color --no-ext-diff --no-index -- /dev/null <chemin>`,
`worktree list --porcelain`, `rev-parse --git-common-dir`, `rev-parse --abbrev-ref
`HEAD`, `symbolic-ref --short --quiet refs/remotes/origin/HEAD` et `merge-base` —
toutes préfixées de `-C <répertoire> -c core.pager=cat`, jamais par un shell. **La
liste blanche est refusée à l'exécution, avant tout lancement** : une sous-commande
absente de la liste (`push`, `add`, `status`, `fetch`…), `worktree` sous une forme
autre que `list` (`worktree add`, `worktree remove`, `worktree prune`…) ou
`symbolic-ref` en écriture (`-d`, `--delete`, `-m`, ou deux positionnels) ne crée
**aucun** process git et échoue par « git <sous-commande> n'est pas une commande de
lecture autorisée — aucun process n'a été lancé. » Il n'existe ni exception, ni
échappatoire, ni variable d'environnement pour l'assouplir. Ni
`git add` (donc jamais `-N`), ni `update-index`, ni `git status` (qui rafraîchit
l'index), ni aucune autre commande d'écriture. Le contenu d'un fichier non suivi
passe par `--no-index`, qui ne touche pas l'index : le fichier reste `??`. Les
tests de la suite le vérifient sur une cible réelle, `git status --porcelain`,
l'empreinte du fichier d'index et les empreintes de tous les fichiers à l'appui.

**Mesure du 2026-09-28** (poste millian, Swift 6.4 CLT seuls, git 2.54.0) :
`bash scripts/swift-app.sh` — compilation release et **177 tests verts**, bundle
assemblé puis signature vérifiée ; `bash scripts/check.sh` — « Dépôt prêt à
publier. ». Les deux recettes (session, cible) sont rapportées « skipped » : aucun
script de CI ne pose leurs variables.

**Mesure du 2026-09-30** (poste millian, Swift 6.4 CLT seuls, git 2.54.0) :
`swift test --no-parallel` — **531 tests verts**, 11 rapportés « skipped » (les
recettes réelles et le harnais `omp` ; aucun script ne pose leurs variables). Une
échéance de commande `git` escalade désormais `SIGTERM` → 2 s de grâce →
`SIGKILL` par l'exécuteur partagé `ProcessRunner`, et l'appel ne rend la main
qu'une fois l'enfant mort et récolté.

Les gestes à l'écran (choisir une cible dans le sélecteur, déplier l'arbre, voir le
diff coloré, ⌘R) restent une **vérification manuelle du poste** : dans un shell de
pipeline sans session d'affichage, le bundle se lance et son état est vivant —
l'application est bien au premier plan (`OMP Console` dans la barre de menus) et son
arbre d'accessibilité expose sa fenêtre et ses sections — mais la fenêtre
n'est peinte sur aucun écran, donc une capture d'écran ne la montre pas.

## Recette : lire une vraie cible

La visionneuse n'a pas non plus de produit exécutable à elle : sa recette passe par
le même véhicule — un test **désactivé par défaut**, qui n'écrit rien dans la cible
et se contente de rendre ce que la section afficherait.

```bash
cd omp-console
MEM0_FILES_RECIPE="$HOME/.omp/pipeline-worktrees/<lot>/<slug>" \
MEM0_FILES_RECIPE_OUT="/tmp/rendu-visionneuse.txt" \
swift test --scratch-path .build-tests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing" \
  --filter recette
```

`MEM0_FILES_RECIPE` est le chemin de la cible à lire (un worktree de feature, ou le
dépôt principal) ; `MEM0_FILES_RECIPE_OUT` est le chemin du rendu à écrire (les deux
sont requis). Le test n'affirme rien sur le contenu : il écrit le rendu et annonce
les comptes à confronter.

Le rendu porte quatre sections : la **cible active** (libellé, chemin, branche,
base), le **catalogue** des cibles connues, l'**arbre** (une ligne par entrée, avec
son badge), le **diff** d'un fichier choisi et le **contenu** du premier fichier de
l'arbre. Le fichier du diff est un fichier **non suivi** s'il en existe un (son diff
est un ajout complet, garanti non vide), sinon le premier des 60 premiers fichiers
suivis qui porte une différence — la borne est écrite dans le rendu : sur un dépôt de
plusieurs milliers de fichiers, demander un diff à git pour chacun coûterait des
minutes à une recette qui n'a rien de plus à prouver. Le contenu est écrit **tel
quel** (aucune troncature dans le produit), borné à 200 lignes avec la marque
explicite de ce qui a été omis.

Mesure du 2026-09-28 (worktree `feat/visionneuse-de-fichiers-et-diffs`, contrat
présent, fichiers non suivis créés par la feature) :

```
recette : …/visionneuse-de-fichiers-et-diffs → /tmp/rendu-visionneuse.txt ;
15 cibles, 177 entrées, 17274 octets de rendu
```

À vérifier dans le fichier de sortie :

1. la cible active est bien celle passée en argument, et sa base correspond à
   `git -C <cible> rev-parse --abbrev-ref HEAD` / à la base de fusion avec la
   branche par défaut (le catalogue liste le principal et les worktrees du poste) ;
2. l'arbre contient les fichiers suivis ET non suivis, à leur chemin relatif, et
   aucun fichier ignoré (un répertoire `build/`, par exemple) ;
3. le diff commence par `diff --git`, porte `--- /dev/null` et un hunk `@@ -0,0 +1,N @@`
   pour un fichier non suivi, et chaque ligne ajoutée commence par `+` ;
4. `git -C <cible> status --porcelain` reste identique avant et après la recette, et
   aucun fichier de la cible n'a été modifié.

La CI ne l'exécute **jamais** : ni `.github/workflows/check.yml` ni
`scripts/swift-app.sh` ne posent ces variables, donc le test est rapporté
« skipped ».

## Assembler le bundle `.app`

Depuis la **racine** du dépôt :

```bash
bash scripts/swift-app.sh
```

Le script compile en release, lance la suite en release, écrit le bundle dans
`omp-console/build/OMP Console.app`, y copie l'icône `omp-console/Bundle/AppIcon.icns`
(`Contents/Resources/AppIcon.icns`, nommée par `CFBundleIconFile`), le signe puis
vérifie la signature (`codesign --verify --strict`). Sous une plateforme
autre que macOS, il annonce « non exécuté » et sort en code 2 sans rien compiler.
Sans l'icns, il sort en code 1 avec `✗ icône absente :
omp-console/Bundle/AppIcon.icns (bash scripts/app-icon.sh)`, sans bundle signé.

**Signature : une identité d'équipe, sinon Siri ne répond pas.** Mesuré le
2026-10-14 (macOS 26) : `linkd`, le registre des App Intents, refuse tout processus
dont le bundle n'a pas d'identifiant d'équipe (`Rejecting invalid client due to
requiresValidatedBundle`, `Unable to get teamId from com.omp.console`). Signé ad
hoc, le bundle apparaît dans Raccourcis mais aucun de ses intents ne s'exécute,
ni depuis Siri ni depuis une tuile (`BackgroundShortcutRunner : Failed to load a
definition for com.omp.console`). Le script signe donc mem0-rs puis le bundle avec
l'identité choisie ainsi :

1. `OMP_CODESIGN_IDENTITY`, si elle est posée (nom d'une identité du trousseau, ou
   `-` pour forcer l'ad hoc) ;
2. sinon la première identité « Apple Development: … » ou « Developer ID
   Application: … » listée par `security find-identity -v -p codesigning` (celle
   qu'Xcode a installée pour l'app iOS suffit) ;
3. sinon l'ad hoc (`-`), le cas de la CI.

Ligne de preuve, après `codesign --verify --strict` : avec une identité,
`  ✓ signature vérifiée (codesign --verify --strict ; identité « <nom> », équipe <TeamIdentifier>)`,
le `TeamIdentifier` étant relu par `codesign -dv` (une identité qui n'en porte pas
fait échouer l'assemblage : `✗ signature sans identifiant d'équipe (identité « <nom> »,
codesign -dv : TeamIdentifier=not set) — Siri exige une identité d'équipe`) ; en ad
hoc, `  ✓ signature ad hoc vérifiée (codesign --verify --strict)` suivie de
`  ⚠ signature ad hoc : Siri et Raccourcis n'exécuteront aucun intent de ce bundle
(linkd exige un identifiant d'équipe) — ajoute une identité « Apple Development »
au trousseau ou pose OMP_CODESIGN_IDENTITY`. Un bundle assemblé avant ce
correctif (ou copié dans `/Applications` depuis un tel assemblage) reste muet pour
Siri : réassembler, puis remplacer la copie et relancer l'app.

Le bundle **embarque le service mémoire** : avec ou sans `--no-tests`, le script
compile `mem0-rs` depuis la racine (`cargo build --release --locked --manifest-path
mem0-stack/mem0-rs/Cargo.toml`), prend le binaire dans
`${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}/release/mem0-rs`, exige `arm64`
dans `lipo -archs`, le copie en `Contents/Resources/mem0-rs` (0755) et le signe
LUI-MÊME, par la même identité que le bundle, avant la signature du bundle :
`  ✓ mem0-rs embarqué (Contents/Resources/mem0-rs, arm64)`. Chaque cas d'échec
sort en code 1 sans bundle : `✗ cargo introuvable — installe Rust
(https://rustup.rs)`, `✗ compilation de mem0-rs échouée (cargo build --release)`,
`✗ mem0-rs n'est pas arm64 (lipo : <sortie>)`. Le bundle ne contient ni podman, ni
contexte d'image, ni fichier de pile à conteneurs.

Le bundle **embarque les métadonnées App Intents**, sans lesquelles Siri et
Raccourcis ne voient aucun intent de l'app. Avec ou sans `--no-tests`, le script :

1. vérifie l'outillage Xcode AVANT toute compilation : le processeur
   (`xcrun --find appintentsmetadataprocessor`), la version d'Xcode
   (`xcrun xcodebuild -version`, ligne « Build version ») et le SDK macOS
   (`xcrun --sdk macosx --show-sdk-path`) ;
2. compile avec le moteur `swiftbuild` imposé (`--build-system swiftbuild`) et
   `-Xswiftc -emit-const-values` (`swift build -c release` comme
   `swift test -c release`), qui écrit les valeurs constantes Swift
   (`…/OMPConsole-p.build/…/*.swiftconstvalues`, `…/OMPConsole.build/…` sous
   Swift 6.3) lues par le processeur. Le moteur
   est imposé parce que le moteur `native` (défaut avant Swift 6.4, donc sous
   Xcode 26) n'écrit aucune valeur constante en release, même avec le drapeau ;
3. lance le processeur avec le jeu d'options qu'Xcode passe pour une cible app,
   dans un dossier temporaire ;
4. copie `Metadata.appintents` dans `Contents/Resources/` AVANT la signature du
   bundle, qui le scelle ;
5. contrôle le bundle contre la liste attendue `scripts/app-intents/attendus.json`
   (égalité exacte d'ensembles des intents et des couples intent–phrase, toute
   phrase contenant `${applicationName}`, voir *Liste attendue des intents Siri*) :
   `  ✓ métadonnées App Intents embarquées (Contents/Resources/Metadata.appintents)`
   puis
   `  ✓ intents Siri conformes à scripts/app-intents/attendus.json (bundle Mac : 1 intent, 1 phrase)`.

Chaque échec sort en code 1, sur la sortie d'erreur, retire le bundle (y compris
celui d'un assemblage antérieur) et ne signe rien :

| Cause | Message |
|---|---|
| processeur introuvable (Command Line Tools seuls, licence Xcode non acceptée) | `✗ outillage Xcode introuvable : appintentsmetadataprocessor (xcrun --find appintentsmetadataprocessor) — installe Xcode puis sélectionne-le (sudo xcode-select -s /Applications/Xcode.app/Contents/Developer) ou pose DEVELOPER_DIR` |
| version d'Xcode illisible | `✗ version de Xcode illisible : aucune ligne « Build version » dans xcrun xcodebuild -version` |
| SDK macOS introuvable | `✗ SDK macOS introuvable (xcrun --sdk macosx --show-sdk-path)` |
| aucune valeur constante | `✗ valeurs constantes Swift introuvables sous <dossier de build> (attendu : …/OMPConsole-p.build/…/*.swiftconstvalues, ou …/OMPConsole.build/… avant Swift 6.4, produit par -Xswiftc -emit-const-values sous --build-system swiftbuild)` |
| processeur en erreur (par exemple une phrase sans `\(.applicationName)`) | `✗ extraction des métadonnées App Intents échouée (appintentsmetadataprocessor, code <n>)`, suivi des sorties du processeur |
| rien d'extrait (aucun intent compilé) | `✗ Metadata.appintents absent du bundle : Contents/Resources/Metadata.appintents/extract.actionsdata manque (l'extraction App Intents n'a rien produit)` |
| liste attendue invalide (`<raison>` : `JSON invalide : <msg> (ligne <lineno>, colonne <colno>)`, `clés de premier niveau attendues : ios, mac`, `<bundle>.<Type> : liste de chaînes attendue`, `phrase sans ${applicationName} : « <phrase> » (<bundle>.<Type>)` ou `phrase en double : « <phrase> » (<bundle>)`) | `✗ liste attendue invalide : scripts/app-intents/attendus.json (<raison>)` |
| `extract.actionsdata` illisible (`<raison>` : `fichier absent`, `JSON invalide : <msg> (ligne <lineno>, colonne <colno>)` ou `forme inattendue`) | `✗ extract.actionsdata illisible : <chemin tel que reçu> (<raison>)` |
| intent de la liste absent du bundle | `✗ intent attendu absent du bundle Mac : <Type> introuvable dans extract.actionsdata` |
| phrase de la liste absente du bundle | `✗ phrase attendue absente du bundle Mac : « <phrase> » (intent <Type>) introuvable dans extract.actionsdata` |
| intent du bundle absent de la liste | `✗ intent non listé dans le bundle Mac : <Type> — à ajouter à scripts/app-intents/attendus.json` |
| phrase du bundle absente de la liste | `✗ phrase non listée dans le bundle Mac : « <phrase> » (intent <Type>) — à ajouter à scripts/app-intents/attendus.json` |
| phrase du bundle sans `${applicationName}` | `✗ phrase sans ${applicationName} dans le bundle Mac : « <phrase> » (intent <Type>)` |

Les lignes du contrôle de la liste sont toutes affichées (triées par catégorie),
puis suivies de la ligne finale
`✗ Metadata.appintents non conforme à scripts/app-intents/attendus.json (bundle Mac)`.

Le premier assemblage après l'ajout du drapeau recompile tout `.build-run` et
`.build-app` (mesuré : environ 45 s pour `swift build -c release`, 3 min 30 pour la
compilation de `swift test -c release`).

L'icône est versionnée et ne se redessine qu'à la main, quand son dessin change :

```bash
bash scripts/app-icon.sh
```

Le script dessine l'icône d'OMP Console une seule fois
(`scripts/app-icon/dessin.swift`) et réécrit ses quatre fichiers : l'icns du Mac,
construit depuis la variante claire, et les trois variantes de l'app iOS (claire,
sombre, teintée) dans `omp-console/ios/OMPConsoleIOS/Assets.xcassets/AppIcon.appiconset/`.
Tout est écrit dans un dossier temporaire, puis déplacé ; aucun fichier n'est
remplacé à moitié. Codes de sortie : 0 les quatre fichiers écrits, 1 échec, 2 non
exécuté hors macOS.

### Liste attendue des intents Siri

`scripts/app-intents/attendus.json` est la seule liste des intents Siri attendus
et de leurs phrases d'App Shortcut, pour le bundle Mac et pour l'app iOS. Format :
JSON UTF-8 brut (aucun échappement `\uXXXX`), indenté de 2 espaces, terminé par un
saut de ligne, avec exactement deux clés de premier niveau, `"mac"` puis `"ios"`.
Chacune vaut un objet `{ "<Type d'intent>": [ "<phrase>", … ], … }`, chaque phrase
étant écrite sous sa forme sérialisée (`${applicationName}`) ; un intent sans App
Shortcut vaut `[]`. Invariants, vérifiés à chaque contrôle : clés de premier niveau
= {`ios`, `mac`} exactement ; chaque valeur d'intent est une liste de chaînes ;
chaque phrase contient `${applicationName}` ; aucune phrase n'apparaît deux fois
dans un même bundle. La comparaison porte sur des ensembles : l'ordre des clés et
des phrases est sans effet.

Le comparateur partagé `scripts/app-intents/controle.py <mac|ios>
<extract.actionsdata>` est appelé par `scripts/swift-app.sh` et
`scripts/ios-build.sh` ; python3 est donc requis (celui des Command Line Tools
suffit).

Règle : toute feature qui ajoute, retire ou renomme un intent ou une phrase d'App
Shortcut met à jour `scripts/app-intents/attendus.json` dans le même commit ;
sinon `scripts/swift-app.sh` et `scripts/ios-build.sh` échouent, et avec eux les
jobs CI `macos-app-swift` et `macos-app-ios`.

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

## Recompiler et relancer d'un coup

Pour itérer sur le code de la coque sans payer la suite complète à chaque tour :

```bash
bash scripts/run-console.sh            # compilation release (sans la suite) + relance de l'app
bash scripts/run-console.sh build      # compilation + assemblage du bundle, sans relancer
bash scripts/run-console.sh --tests    # passe par la suite complète (scripts/swift-app.sh)
```

`run-console.sh` compile avec `scripts/swift-app.sh --no-tests` : même assemblage,
même signature que la voie complète, mais dans le dossier de build `.build-run` —
le dossier de test `.build-app` reste intact, car `swift test` doit y rester la
première commande écrite. La relance suit la compilation, jamais l'inverse : en
cas d'échec l'app en cours n'est pas touchée. Sinon l'instance en cours **de ce
bundle** est arrêtée (`pkill` sur le chemin du binaire, TERM puis KILL au bout de
3 s) et le bundle est rouvert avec `open` — une copie de fumée lancée depuis
`/tmp` n'est jamais touchée.

## Les hooks git : recompiler après un pull

```bash
bash scripts/run-console.sh install-hook    # pose .git/hooks/{post-merge,post-rewrite}
```

Après `git pull`, la recompilation se fait toute seule **si** les commits arrivés
touchent une entrée de l'app : un `*.swift` sous `omp-console/Sources/`,
`Package.swift`, `omp-console/Bundle/` ou le crate `mem0-stack/mem0-rs/` (`src/`,
`Cargo.toml`, `Cargo.lock` : le service mémoire, compilé et embarqué dans le
bundle). Un pull qui ne touche que les tests, la documentation ou le reste du
dépôt ne déclenche rien — et ne paie que la lecture du diff. Le déclencheur est
le couple post-merge (fusion, avance rapide) / post-rewrite (`pull.rebase=true`,
le réglage **local** de ce dépôt) ; les deux comparent `ORIG_HEAD`, que git pose
avant le pull, à `HEAD`.

Deux limites assumées : la compilation ne tourne que dans l'**arbre principal**
du dépôt — les worktrees du pipeline fusionnent souvent, et chacun paierait sinon
sa propre compilation ; `MEM0_CONSOLE_HOOK_ALL_WORKTREES=1` force partout. Et les
hooks vivent dans `.git/hooks`, jamais versionnés : après un clone, relancer
`install-hook`. Un hook `post-merge`/`post-rewrite` déjà présent et **étranger**
n'est jamais écrasé : le script refuse et n'écrit rien. `uninstall-hook` retire
les seuls hooks posés par ce script.

## Composants de l'app

L'app possède TOUT ce qui lui sert, sous une racine privée — elle ne consulte ni
`PATH`, ni `~/.bun/bin`, ni `/opt/homebrew/bin`, ni `/usr/local/bin` pour `omp`.
Elle n'installe qu'un composant, **OMP** ; son service mémoire est le `mem0-rs`
embarqué dans le bundle, servi par un agent launchd (voir « Service mémoire »).
Aucune machine virtuelle, aucun conteneur, aucun moteur de conteneurs.

| Quoi | Où | Version |
|---|---|---|
| binaire `omp` (binaire autonome GitHub, aucun `bun` requis) | `~/Library/Application Support/com.omp.console/components/omp/18.6.0/omp` | 18.6.0 (SHA-256 vérifié avant installation) |
| service mémoire `mem0-rs` (signé ad hoc avec le bundle) | `OMP Console.app/Contents/Resources/mem0-rs` | celle du crate `mem0-stack/mem0-rs` |
| base de la mémoire | `…/mem0-rs/mem0-rs.db` (dossier `mem0-rs/` en 0700, répertoire de travail de l'agent) | |
| journal du service mémoire (sortie et erreurs, sans rotation) | `…/mem0-rs/mem0-rs.log` | |
| plist de l'agent (0600 : il porte des jetons) | `~/Library/LaunchAgents/com.omp.console.mem0-rs.plist` | |
| configuration de la mémoire (jamais réécrite par l'app) | `…/stack/env` | |
| jeton d'installation (jamais régénéré) | `…/stack/installation-token` (0600) | |
| ancienne base Qdrant, source de la migration, jamais modifiée | `…/stack/qdrant_storage/` | |
| traces de la migration unique | `…/stack/podman-migration/` (`history.db`, `import-report.json`, `bascule.json`) | |
| appareils appairés | `…/remote/devices.json` (0600) | |

- **Badge du coin inférieur gauche** — le pied de la barre latérale porte l'état
  du composant embarqué (identifiant AX `components.badge`) : « Tout est
  installé » (point vert), ou « OMP manquant » (point orange). La présence se lit
  par le MÊME prédicat que l'installateur — le binaire existe, est exécutable et
  n'est pas un dossier — jamais l'état de marche : aucune version n'est exécutée.
  Deux veilles de fichier (`FileWatcher`, jamais de scrutation) le recalculent
  sans redémarrer l'app, et un changement de permission suffit. Quand OMP manque,
  le badge est un bouton (clic, ou Espace au focus ; aide « Afficher la
  préparation d'OMP Console ») qui rouvre la feuille de préparation, bloquante ;
  « Tout est installé » reste un mot non interactif. Si OMP disparaît pendant que
  l'app tourne, seul le badge change : la feuille bloquante s'impose au clic du
  badge, ou d'elle-même au lancement suivant. Replier la barre latérale masque le
  badge avec elle.
- **Manifeste** — version, URL et empreinte d'OMP sont figées dans
  `ComponentManifest.current` (`Setup/ComponentManifest.swift`). L'installation
  est idempotente (un composant présent à la bonne version n'est ni retéléchargé
  ni réinstallé), vérifie le SHA-256 AVANT de déplacer, puis `omp --version`
  APRÈS ; après succès, les autres versions sous `components/omp/` sont purgées.
  Rien n'est écrit de façon non atomique. Un `components/podman/` laissé par une
  version antérieure n'est jamais touché par l'installateur : la migration s'en
  sert, puis seul le bandeau de nettoyage le supprime.
- **`stack/env`** — clés `QDRANT_API_KEY` (lue par la seule migration),
  `MEM0_HTTP_TOKEN`, `OMLX_BASE_URL`, `OMLX_API_TOKEN`, `OMLX_LLM_MODEL`,
  `OMLX_EMBED_MODEL`, `EMBEDDING_DIMS`. Sans fichier, les défauts de
  `StackConfig.defaults` s'appliquent (oMLX `http://127.0.0.1:8000/v1`,
  `qwen3-8b` / `bge-m3`, 1024 dimensions, jetons vides). Un `OMLX_BASE_URL`
  hérité qui vise `host.containers.internal` est traduit en `127.0.0.1` pour
  l'agent, qui tourne en natif, sans que le fichier soit réécrit.
- **Échappatoires de test** — `OMP_CONSOLE_SUPPORT_ROOT` déplace TOUTE la racine
  (composants ET état) et isole l'agent : son label devient
  `com.omp.console.mem0-rs.<12 premiers hexadécimaux du SHA-256 du chemin de la
  racine>` et son plist vit sous `<racine>/LaunchAgents/`, jamais dans
  `~/Library/LaunchAgents` ; `OMP_CONSOLE_MEM0_PORT` déplace le port de l'agent
  (entier de 1 à 65535 ; toute autre valeur garde 8321) ; `OMP_CONSOLE_OMP_BINARY`
  force le binaire `omp` et devient alors le seul candidat (les recettes s'en
  servent) ; `OMP_CONSOLE_REMOTE_PORT` déplace le port de l'API distante (entier
  de 1 à 65535 ; toute autre valeur garde 8787), pour qu'une instance de recette
  écoute à côté de celle de l'utilisateur. Sous une racine jetable SEULEMENT,
  l'argument de lancement `-setup.recipe <valeur>` (`Setup/SetupRecipe.swift`)
  remplace l'installateur par un script, sans réseau ni mémoire : `progression`
  (téléchargement chiffré de 0 à 100 % en 10 s, puis attente), `indeterminee`
  (téléchargement sans taille, puis attente), `echec` (échec d'installation au
  détail de 41 lignes), `succes` (téléchargement court, puis pose d'exécutables
  factices et préparation terminée). Valeur inconnue ou racine réelle : la chaîne
  réelle, sans message.

### Service mémoire

La mémoire est servie par le `mem0-rs` embarqué, lancé par un **agent launchd**
de l'utilisateur, `gui/<uid>/com.omp.console.mem0-rs` (`Stack/MemoryAgent.swift`) :
`<bundle>/Contents/Resources/mem0-rs --host 127.0.0.1 --port 8321`, `KeepAlive`,
`RunAtLoad`, `ProcessType` `Interactive`, journal `mem0-rs/mem0-rs.log`.
L'environnement du job porte la base (`MEM0_DB_PATH` = `mem0-rs/mem0-rs.db`), les
clés de `stack/env` (oMLX, `EMBEDDING_DIMS`, `MEM0_HTTP_TOKEN`), le jeton
d'installation (`OMP_INSTALLATION_TOKEN`) et le SHA-256 du binaire
(`OMP_CONSOLE_MEM0_RS_SHA256`).

- **Démarrage** (ligne « Service mémoire » : « Démarrage du service mémoire… »,
  puis « Attente de la mémoire… ») — l'état voulu EST le plist : à chaque
  préparation, l'app recalcule le plist attendu et le compare (en dictionnaire) à
  celui du disque. Égal et chargé ⇒ elle attend seulement la santé, sans
  `bootout` ni `bootstrap`. Sinon : garde de port (10 s au plus), écriture
  atomique du plist en 0600, `launchctl bootout` attendu par `launchctl print`
  (10 s au plus), puis `launchctl bootstrap`, repris jusqu'à 3 fois. Santé :
  `GET http://127.0.0.1:8321/health` toutes les 0,5 s pendant 30 s au plus,
  acceptée seulement si `ok` vaut `true` **et** si `installation` égale le jeton
  d'installation.
- **Survit à ⌘Q** — le serveur a launchd pour parent (`ppid` = 1) : le Quitter de
  l'app ne touche ni l'agent ni le plist, et un serveur tué (`kill -9`) est
  relancé par launchd (`KeepAlive`) en 10 s au plus.
- **Rechargé quand il le faut** — un binaire embarqué différent (nouvelle version
  de l'app : autre chemin ou autre SHA-256), un `stack/env` modifié ou un autre
  jeton d'installation donnent un autre plist ⇒ `bootout` puis `bootstrap` : le
  process qui sert le port exécute toujours le binaire de l'app installée.
- **Port occupé** — si un autre programme tient `127.0.0.1:8321` au-delà de la
  garde, l'agent chargé est DÉCHARGÉ (il ne boucle pas sur un port impossible) et
  la feuille dit « Le programme « <nom> » occupe la place réservée à la mémoire :
  celle-ci ne peut pas démarrer. Quittez-le, puis réessayez. » ; « Réessayer »
  démarre l'agent une fois le port libéré. Le diagnostic copié porte le port, le
  pid et le geste `lsof -nP -iTCP:<port> -sTCP:LISTEN`. Le `mem0-rs` embarqué
  (ligne de commande = le chemin du binaire de l'app) n'est jamais un conflit ;
  `lsof` absent n'empêche rien.
- **Pannes lisibles** — binaire absent (« Réinstallez OMP Console. »), plist ou
  `launchctl` en échec, santé muette au bout de 30 s (le diagnostic porte le
  chemin du journal et ses dernières lignes : par exemple une base créée avec un
  autre `EMBEDDING_DIMS`, qui fait sortir `mem0-rs` en boucle). oMLX injoignable
  n'empêche pas le démarrage : `/health` n'appelle pas oMLX, et le bandeau oMLX
  de la section Mémoire le signale.
- **Hors périmètre** — aucune interface pour désinstaller l'agent, et supprimer
  l'app ne le décharge pas. macOS peut notifier « Éléments d'arrière-plan
  ajoutés » au premier chargement.

Gestes de diagnostic, dans un terminal :

```bash
launchctl print gui/$(id -u)/com.omp.console.mem0-rs     # chargé ? pid, dernier code de sortie
tail -n 50 "$HOME/Library/Application Support/com.omp.console/mem0-rs/mem0-rs.log"
curl -s http://127.0.0.1:8321/health                       # ok, mem0, installation
launchctl bootout gui/$(id -u)/com.omp.console.mem0-rs   # décharge l'agent : la mémoire s'arrête
```

Après un `bootout`, relancer l'app (ou « Réessayer » dans la préparation)
recharge l'agent ; à la main :
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.omp.console.mem0-rs.plist`.

### Migration unique de l'ancienne mémoire

Les versions antérieures de l'app servaient la mémoire depuis une machine podman
`omp-console` et deux conteneurs, `omp-console-qdrant` (Qdrant,
`127.0.0.1:6333`, données dans `stack/qdrant_storage/`) et
`omp-console-mem0-http` (`127.0.0.1:8321`). La préparation en reprend les
souvenirs **une seule fois**, avant de démarrer l'agent (`PodmanLegacy.migrate`,
`Stack/PodmanLegacy.swift`, ligne « Migration de la mémoire ») :

1. `stack/podman-migration/bascule.json` existe ⇒ déjà fait : aucune commande,
   aucun fichier touché.
2. Pas de collection `stack/qdrant_storage/collections/omp_memory` ⇒ rien à
   reprendre : `bascule.json` est écrit avec `source: "none"` et l'agent démarre
   sur une base neuve.
3. Sinon (« Démarrage de l'ancienne mémoire… ») : le podman laissé par
   l'ancienne version (`components/podman/6.1.3/bin/podman`) et le `mem0-rs`
   embarqué doivent être exécutables. Chaque commande podman tourne dans
   l'environnement ISOLÉ de l'app (`XDG_CONFIG_HOME=<racine>/config`,
   `XDG_DATA_HOME=<racine>/data`, `TMPDIR=<racine>/tmp`), jamais sur une machine
   podman du système.
4. La machine `omp-console` est démarrée si elle est arrêtée, puis le conteneur
   `omp-console-qdrant` ; l'app attend `GET 127.0.0.1:6333/readyz` (90 s au plus).
5. `podman cp omp-console-mem0-http:/home/mem0/.mem0/history.db` copie
   l'historique dans `stack/podman-migration/history.db`.
6. « Reprise des souvenirs de l'ancienne mémoire… » : `mem0-rs import
   --history-db <copie> --qdrant-url http://127.0.0.1:6333 --collection
   omp_memory --json`, avec la base de l'agent (`MEM0_DB_PATH`), `EMBEDDING_DIMS`
   et `QDRANT_API_KEY` de `stack/env` (600 s au plus). Son rapport (stdout) est
   gardé dans `stack/podman-migration/import-report.json`. L'import est tout ou
   rien et idempotent.
7. Import réussi ⇒ « Arrêt de l'ancienne mémoire… » : `podman stop --ignore
   omp-console-mem0-http omp-console-qdrant`, puis `machine stop omp-console`
   (son échec n'empêche rien), puis `bascule.json` (`version`, `switchedAt`,
   `source: "podman"`, `rejected`, `forced`) — le marqueur « une seule fois ».
   L'agent démarre ensuite.

Invariants : l'import a lieu AVANT tout arrêt ; aucun conteneur n'est arrêté
avant un import réussi ou un choix explicite ; tout échec avant `bascule.json`
laisse la migration rejouable par « Réessayer » ; rien n'est jamais écrit,
supprimé ni renommé sous `stack/qdrant_storage` ni dans les conteneurs (seuls la
copie de l'historique et la lecture HTTP de Qdrant y touchent) ; la migration ne
supprime jamais la machine ni les conteneurs.

**Rejets.** Un import qui laisse des éléments de côté arrête la préparation sur
une décision (AX `sheet.setup.rejected`) : « L'import a laissé de côté
<n> éléments : vecteur absent (k), … » (raisons : vecteur absent, dimension
inattendue, texte absent, champ invalide, historique orphelin), puis « « Basculer
quand même » démarre la nouvelle mémoire sans eux ; l'ancienne reste intacte sur
ce Mac. « Réessayer » relance l'import. » ; le détail repliable liste un élément
par ligne et le diagnostic copié est le rapport brut. Pied : « Basculer quand
même » (`sheet.setup.switchAnyway`, sans raccourci) arrête l'ancienne mémoire,
écrit `bascule.json` (`forced: true`) puis démarre l'agent, SANS refaire
d'import — une écriture reçue par l'ancienne mémoire entre l'import et l'arrêt
n'est pas reprise ; « Réessayer » (`↩`) relance l'import ; « Fermer » (`⎋`)
laisse l'ancienne mémoire en service. La phrase relayée à l'iPhone
(`setupBanner`) est alors « Préparation incomplète. L'import de l'ancienne mémoire
attend votre choix sur le Mac. »

**Échecs.** Chaque échec dit la conséquence puis « Réessayez ; si l'échec
revient, copiez le diagnostic pour le signaler. », sans démarrer l'agent :
ancienne mémoire introuvable (podman de l'ancienne version absent), qui n'a pas
démarré (machine), qui ne répond pas (Qdrant), historique non copié, import en
échec (« l'ancienne reste en place »), arrêt impossible, bascule non
enregistrée. Le diagnostic copié nomme la commande et son détail brut (par
exemple « mem0-rs import a échoué (code <n>) : … »).

**Retour arrière.** L'ancienne mémoire reste intacte sur le Mac tant que le
bandeau de nettoyage n'a pas été confirmé. Pour la consulter à la main (sans son
service `omp-console-mem0-http`, dont le port est tenu par l'agent) :

```bash
R="$HOME/Library/Application Support/com.omp.console"
( export XDG_CONFIG_HOME="$R/config" XDG_DATA_HOME="$R/data" TMPDIR="$R/tmp"
  "$R/components/podman/6.1.3/bin/podman" machine start omp-console
  "$R/components/podman/6.1.3/bin/podman" start omp-console-qdrant )
```

### Nettoyage de l'ancien moteur

Après la bascule (`bascule.json` présent), tant qu'il reste `components/podman`,
`config` ou `data` sous la racine, la section **Mémoire** porte en tête un bandeau
bleu (AX `memory.podmanCleanup`, au-dessus du bandeau oMLX, en liste comme en
graphe) : « L'ancienne mémoire n'est plus utilisée, mais son moteur de conteneurs
occupe encore de la place sur ce Mac. » et « Supprimer l'ancien moteur… »
(`memory.podmanCleanup.remove`). Rien n'est supprimé sans confirmation : le
dialogue « Supprimer l'ancien moteur de conteneurs ? » (« Sa machine virtuelle,
ses images et le moteur installé par OMP Console seront supprimés. Vos souvenirs
restent servis par la mémoire actuelle, et la copie de l'ancienne base est
conservée. ») propose « Supprimer » (destructif, `memory.podmanCleanup.confirm`)
et « Annuler » (`⎋`). Pendant la suppression : « Suppression de l'ancien
moteur… » (`memory.podmanCleanup.progress`), bouton éteint.

- **Ce qui est supprimé**, dans cet ordre (`PodmanLegacy.removeLeftovers`) : la
  machine (`machine rm -f omp-console`, environnement isolé ; une machine déjà
  absente compte comme un succès), puis `components/podman`, `config`, `data` et
  `tmp`. Une machine qui résiste arrête tout avant la moindre suppression ; un
  dossier qui résiste laisse supprimés ceux qui le précèdent.
- **Ce qui est gardé** : tout `stack/` (`qdrant_storage`, `env`,
  `installation-token`, `podman-migration/`), `mem0-rs/`, `remote/`,
  `components/omp`, le plist et l'agent (aucun appel `launchctl`).
- **Succès** : le bandeau disparaît. **Échec** : bandeau orange « La suppression
  de l'ancien moteur a échoué : il occupe toujours de la place. Réessayez ; si
  l'échec revient, copiez le diagnostic pour le signaler. », « Réessayer »
  (`memory.podmanCleanup.retry`, redemande la confirmation) et « Copier le
  diagnostic » (`memory.podmanCleanup.diagnostic` : la commande ou le chemin, et
  le détail brut).

### Recettes gatées de la préparation et du service mémoire

Aucune n'est posée par `scripts/swift-app.sh`, `scripts/check.sh` ni la CI (elles
sont « skipped ») ; chacune échoue explicitement si son prérequis manque, jamais en
silence. Depuis `omp-console/` :

```bash
# Composants : télécharge omp seul dans une racine temporaire, exécute son --version
MEM0_COMPONENTS_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter recetteReelleInstalleLesDeuxComposants -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

# Agent launchd : vrai launchctl sur une racine jetable, port libre (jamais 8321)
MEM0_AGENT_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter recette -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

# Session composant + run terminal : une session servie vit sur le composant de
# l'app, puis un `omp -p` au terminal (sans l'app) dont la session porte un message mem0-recall
MEM0_SESSION_COMPONENT_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter "sessionRunsOnTheAppComponent|terminalRunRecallsMemoryWithoutTheApp" \
  -Xswiftc -plugin-path -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

La recette de l'agent (`Tests/OMPConsoleTests/MemoryAgentRecipeTests.swift`,
fonctions `recetteAgent…`) prend le binaire dans `MEM0_RS_BIN`, sinon
`mem0-stack/mem0-rs/target/release/mem0-rs` (absent ⇒ échec qui nomme `cargo
build --release --locked --manifest-path mem0-stack/mem0-rs/Cargo.toml`), le
copie dans une racine `/tmp/omp-agent-recette-*` (label et plist isolés sous
`<racine>/LaunchAgents`), puis décharge le job et supprime la racine. Elle
prouve : les 9 routes servies avec le jeton et refusées sans lui, la base sous la
racine ; le parent launchd et le retour après `kill -9` ; le remplacement du
process par un binaire re-signé ; un port tenu par `nc` qui bloque sans démarrer
l'agent, puis « Réessayer » une fois libéré. Son test `omp-console-sans-podman/AC-13`
(liste, ajout, recherche et suppression par le client de la section Mémoire) exige
en plus `OMLX_BASE_URL`, `OMLX_API_TOKEN` et `OMLX_EMBED_MODEL` ; sans eux, il est
désactivé.

### Bascule réelle du poste (ancienne mémoire → service mémoire)

La bascule d'un poste qui faisait tourner l'ancienne version se prouve à la main,
avec `scripts/recette/sans-podman-bascule-recette.sh` (jamais lancé par `check.sh` ni la
CI ; sans `MEM0_SANS_PODMAN_REEL=1`, il dit « non exécuté : MEM0_SANS_PODMAN_REEL=1
requis (bascule réelle du poste) » et sort en `2`). Racine =
`OMP_CONSOLE_SUPPORT_ROOT`, sinon `~/Library/Application Support/com.omp.console` ;
port = `OMP_CONSOLE_MEM0_PORT`, sinon 8321. Chaque vérification imprime `✓ …` ou
`✗ …` ; le premier écart sort en `1`, tout vert en `0`. Dans l'ordre :

1. **Avant** — ancienne app, ancienne mémoire en marche :
   `MEM0_SANS_PODMAN_REEL=1 bash scripts/recette/sans-podman-bascule-recette.sh avant`.
   Le script lit la clé `QDRANT_API_KEY` de `stack/env`, fait défiler
   la collection `omp_memory` de Qdrant (`127.0.0.1:6333`) et écrit
   `stack/podman-migration/recette-avant.json` (par `agent_id`, la liste triée
   des couples identifiant–texte) ; il échoue si `bascule.json` existe déjà.
2. **Installer et lancer la nouvelle app** (bundle de `scripts/swift-app.sh`),
   et attendre « Préparation terminée. ».
3. **Après** — `MEM0_SANS_PODMAN_REEL=1 bash scripts/recette/sans-podman-bascule-recette.sh apres`.
   Il exige `bascule.json` de source `podman` ; pour chaque `agent_id`,
   `GET /memory/all?agent_id=` rend les mêmes couples qu'avant (les lignes sans
   `agent_id` sont lues dans `GET /memory/all` sans paramètre), et la liste
   complète sans paramètre est l'union d'avant ; `POST /memory/search` rend au
   moins un résultat (exige oMLX) ; `launchctl print
   gui/<uid>/com.omp.console.mem0-rs` sort en 0 ; la machine ou les conteneurs
   sont arrêtés. Il écrit `stack/podman-migration/recette-apres.json` (SHA-256 et
   date de modification de `bascule.json` et d'`import-report.json`).
4. **Relance** — redémarrer À LA MAIN la machine et le seul conteneur
   `omp-console-qdrant` (geste de « Retour arrière » ci-dessus ; PAS
   `omp-console-mem0-http`, dont le port est tenu par l'agent), relancer l'app,
   puis `MEM0_SANS_PODMAN_REEL=1 bash scripts/recette/sans-podman-bascule-recette.sh relance` :
   `bascule.json` et `import-report.json` sont inchangés (SHA-256 et date) — la
   migration n'a pas été rejouée — et Qdrant rend le même ensemble de couples
   qu'avant — la source n'a pas été modifiée.
5. Ensuite seulement, si on le souhaite : le **bandeau de nettoyage** de la
   section Mémoire (voir « Nettoyage de l'ancien moteur »).

Preuves manuelles de compatibilité des clients, sur le même poste après la
bascule — ni ré-appairage, ni changement de jeton ou de configuration (même port
8321, même `MEM0_HTTP_TOKEN`, même jeton d'installation) :

- **iPhone déjà appairé** : la section Mémoire affiche la liste du projet, puis
  une recherche rend des résultats, sans nouvel appairage.
- **Session `omp` en terminal** sur un dépôt : `/mem0-status` dit le service
  joignable, `mem0_search` rend des souvenirs repris de l'ancienne mémoire, et un
  souvenir écrit par `mem0_add` est relu ensuite (par `mem0_search`, ou dans la
  liste de la section Mémoire).

### Preuves manuelles (AC-3, AC-5, AC-10)

- **AC-3 — l'app n'utilise aucun binaire système** : renommez l'`omp` du système
  (`mv ~/.bun/bin/omp ~/.bun/bin/omp.bak` — sans toucher à la racine de l'app),
  ouvrez l'app : la préparation trouve le composant de l'app
  (`…/com.omp.console/components/omp/18.6.0/omp`) et ne réclame rien ; seul le
  bouton « Lancer OMP » du Terminal tape `omp` dans le shell. Le renommage est
  réversible, et la suppression du composant seul provoque la réinstallation par
  « Réessayer ».
- **AC-5 — la mémoire survit à l'app** : quittez l'app (⌘Q), puis, dans un
  terminal sur un dépôt : `omp -p "résume ce dépôt"`. Le run reçoit le rappel
  mémoire du plugin (`mem0-recall` dans son fichier de session) parce que l'agent
  launchd du service mémoire tourne toujours.
- **AC-10 — la voie manuelle reste intacte** : dans `mem0-stack/`,
  `docker compose up -d` puis `curl` sur son `/health` rend toujours `ok` (sur un
  port libre, `MEM0_RS_PORT` de `mem0-stack/.env`, puisque l'agent de l'app tient
  8321) — aucune variable nouvelle n'est obligatoire, le champ additif
  `installation` n'apparaissant que si `OMP_INSTALLATION_TOKEN` est posée (ce que
  la voie manuelle ne fait pas). L'app ne modifie jamais `mem0-stack/`.

## Le binaire `omp` de l'app

L'app n'utilise qu'UN SEUL binaire `omp` pour ses propres besoins, le composant
qu'elle a installé (`…/components/omp/18.6.0/omp`, S-4) : il sert à la préparation
des composants (sa présence et sa version) — **jamais** à une pipeline, que le
serveur du VPS conduit. `PATH`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` et
l'ancienne préférence `omp.chosenPath` ne sont plus consultés pour ce binaire : la
feuille « OMP est requis » n'existe plus (la préparation la remplace). Le bouton
« Lancer OMP » du terminal, lui, tape `omp` dans le shell, qui le résout par son
`PATH` complété (voir « Section Terminal »).

- **`OMP_CONSOLE_OMP_BINARY`** (échappatoire de test) — posée et non vide, c'est le
  SEUL candidat ; utile aux recettes pour pointer un `omp` de secours ou simuler un
  poste sans composant.
- Si le composant est absent ou non exécutable au lancement, la feuille de
  préparation bloquante s'impose : « Installer » le télécharge, « Réessayer »
  relit sa présence, « Quitter » quitte l'app.

## Section Terminal (terminal intégré)

La section **Terminal** (⌘6) héberge **un seul programme** dans un vrai PTY (le
modèle est à instance unique : jamais un second programme). Fermer la fenêtre
principale tue le shell. Le programme hébergé est
le **shell de connexion** de l'utilisateur (`$SHELL -l` s'il désigne un exécutable
absolu, sinon `/bin/zsh -l`) ; `omp` se lance **à la demande** dans ce shell.

1. **Choisir le répertoire** — bouton « Choisir un répertoire… ». La feuille liste
   **une entrée par worktree de feature du pipeline, plus le dépôt principal** : le
   catalogue est exactement celui de la section **Fichiers** (`git rev-parse
   --git-common-dir` puis `git worktree list --porcelain`). Aucun chemin ne se saisit
   à la main, et rien n'est mémorisé.
2. **Ouvrir** (↩) : le shell démarre dans ce répertoire, dans un PTY dont la taille
   est celle de la zone d'affichage, avec l'environnement de `TerminalEnvironment`
   (`PATH` complété : `omp` y est trouvé même quand l'app est lancée par le Finder).
3. **Lancer OMP** (`terminal.launchOmp`, actif tant qu'un shell vit) tape `omp↩`
   dans le shell ; la frappe part ensuite dans `omp` (flèches, Entrée, Tab, Échap,
   Ctrl-C, Ctrl-D), l'affichage est celui du TUI — couleurs vraies, curseur, plein
   écran — et suit le redimensionnement de la fenêtre.
4. **Fermer la fenêtre principale** (bouton rouge, ⌘W) : le process est tué avec
   **tout son groupe** (SIGTERM, puis SIGKILL après 2 s), sans confirmation.
   **⌘Q** tue de la même façon les terminaux vivants, une fois la sortie confirmée
   si une commande tourne (voir « Confirmation au Quitter ») : aucun shell ni `omp`
   ne survit à la fermeture de l'app.

États affichés : sans projet choisi, « Aucun projet ouvert » — « Choisissez le
projet dans lequel ouvrir un terminal. » — avec le bouton **Choisir un projet…**
(`terminal.chooseProject`, voir la section Fichiers) : le projet choisi, la
feuille « Choisir un répertoire » s'ouvre aussitôt sur ses répertoires. Avec un
projet, « Choisissez un répertoire… » sous « Projet « <nom> » », puis « Recherche
des dossiers de features… » (feuille ouverte ; « Aucun dossier de feature dans ce
projet. » quand seul le dépôt principal existe), « Lancement de l’interpréteur… »,
« L’interpréteur est actif. », « L’interpréteur s’est terminé. Relancez-le pour continuer. » avec
le bouton **Relancer**, et l'erreur explicite en cas d'échec (« Exécutable
introuvable : … », « Répertoire introuvable : … », « Le terminal n'a pas pu
s'ouvrir : le Mac refuse d'en créer un de plus pour l'instant. Fermez des fenêtres
de terminal inutiles, puis relancez. »). Un échec du shell affiche **Copier le
diagnostic** (`terminal.diagnostic.copy`, dans le bandeau `terminal.status` ou
sous le message de `terminal.view`) : il copie le brut
(`TerminalHostError.diagnostic`, par exemple « Pseudo-terminal indisponible (<errno>) :
aucun processus lancé. »). Dans la feuille, un échec de lecture du catalogue montre
« Réessayer » puis **Copier le diagnostic** (`terminal.launch.diagnostic`, jamais
sur ↩) ; « Aucun projet ouvert » n'a rien à copier. Le sous-titre dit « OMP ·
Actif » une fois OMP lancé. Aucun état n'est un rectangle vide.

Le fond, le texte par défaut et le curseur suivent l'apparence claire ou sombre du
système dès qu'elle change, sans relancer le shell ; la réponse OSC 11 suit. Les
16 couleurs ANSI et les couleurs RVB envoyées par un programme restent les mêmes
dans les deux apparences, comme dans Terminal.app. Un programme déjà lancé qui a
sondé le fond (OSC 11), comme le TUI `omp`, n'est pas prévenu de la bascule.

**Limites assumées** (hors périmètre) : pas de défilement arrière (aucun
scrollback : la ligne qui sort de l'écran est perdue), pas de sélection ni de copie,
pas de collage, pas de souris transmise, pas d'IME ni de composition, pas de
protocole clavier kitty/`modifyOtherKeys`, pas d'images (sixel, kitty), pas de
protocole glyphes OSC 66, pas de recherche, pas de titre de fenêtre piloté par
l'application hôte. Un seul terminal à la fois : la fenêtre n'a ni onglets ni
partage de PTY.

### Recette : prouver le terminal de bout en bout

Le harnais réel (`TerminalSmokeTests`) lance le vrai shell de l'utilisateur dans un
PTY 24×80, y tape `omp↩` et fait passer les octets dans l'émulateur (sans `omp`
résoluble, il échoue explicitement) ; il est **désactivé par défaut** :

```bash
cd omp-console
MEM0_TERMINAL_RECIPE=1 swift test --scratch-path .build-tests --no-parallel \
  --filter TerminalSmokeTests \
  -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

La recette graphique, elle, se fait sur le bundle assemblé
(`omp-console/build/OMP Console.app`, voir « Assembler le bundle `.app` »), dans
une session graphique où la fenêtre est réellement peinte et l'app au premier plan
(dans un shell de pipeline sans session graphique, seuls la barre de menus et le
titre des fenêtres sont observables — les gestes à l'intérieur de la fenêtre ne le
sont pas) :

1. Lancer `omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole` depuis la
   racine du dépôt ;
2. menu **Fichier ▸ « Ouvrir un terminal OMP… »**, puis « Choisir un répertoire… »,
   choisir un worktree, « Ouvrir » : le shell démarre ;
3. « Lancer OMP » ; vérifier `pgrep -fl -P <pid de l'app>` : un seul shell, enfant
   direct, et `omp` enfant du shell ;
4. taper un prompt dans la fenêtre : la TUI y répond ; **Ctrl-C** interrompt `omp`
   et l'app reste vivante ;
5. redimensionner la fenêtre : la TUI se réaffiche à la nouvelle taille ;
6. fermer la fenêtre : `pgrep -fl -P <pid de l'app>` ne rend plus rien ;
7. relancer l'app, ouvrir un terminal, puis **⌘Q** : aucun shell ni `omp` ne survit
   (avec `omp` au premier plan, l'alerte « Quitter arrêtera… » le cite d'abord).

## Confirmation au Quitter

Quitter l'app — **⌘Q**, menu « Quitter OMP Console », Dock ▸ Quitter, ou la
fermeture de session, le redémarrage et l'extinction de macOS — passe par UN seul
déroulé (`QuitFlow`, `Sources/OMPConsole/Quit/`). Il demande confirmation par une
alerte « Quitter arrêtera des activités en cours. » (Annuler / Quitter) dès que la
sortie arrêterait une **commande au premier plan** d'un shell du Terminal
(`sleep 600`, `omp`…) : « La commande « sleep » du Terminal s'arrêtera. ». Un shell
au repos sur son invite, une tâche de fond (`sleep 600 &`) ou `exec <commande>` ne
comptent pas. Les pipelines tournent sur le serveur du VPS : quitter l'app ne les
touche pas.

- **Quitter** (Retour) : les accroches de sortie tournent comme avant (shell tué,
  service distant arrêté), les feuilles ouvertes sont fermées, puis l'app quitte.
  Une feuille ouverte (préparation bloquante) ne bloque jamais la sortie.
- **Annuler** (Échap) : rien ne s'arrête, l'app reste ouverte ; le ⌘Q suivant
  redemande. Sur une fermeture de session macOS, Annuler l'interrompt (l'Apple
  Event de quit reçoit `userCanceledErr`, -128) ; sans activité, la fermeture de
  session n'est plus interrompue par l'app.
- Une seule alerte par sortie, aucune option « Ne plus demander ».
- Fermer la fenêtre (⌘W, bouton rouge) ne demande rien : le shell est tué comme
  avant.

## Harnais réel

Les preuves qui lancent un vrai `omp` sont les **recettes gatées** : session
composant et run terminal (`MEM0_SESSION_COMPONENT_RECIPE`, voir « Composants de
l'app ») et terminal (`MEM0_TERMINAL_RECIPE`, voir « Section Terminal »). Chacune
est **désactivée par défaut** — aucun script du dépôt (`scripts/swift-app.sh`,
`bash scripts/check.sh`, `.github/workflows/`) ne pose sa variable — donc la suite
reste verte et aucun octet n'est envoyé à un modèle.

Une recette posée sans son prérequis **échoue explicitement**, jamais en faux
succès ni en skip silencieux : la variable est une demande d'exécution réelle, pas
un filtre. Le harnais du terminal (`TerminalSmokeTests`) suit la même règle, avec sa
propre variable **`MEM0_TERMINAL_RECIPE`** (voir « Section Terminal (terminal
intégré) »).

## Consulter et corriger la mémoire du projet

La section **Mémoire** lit la mémoire du service mémoire (mem0-rs) et l'écrit : la **liste**
montre le sommaire du projet courant et ouvre un souvenir pour en lire le texte
complet ; le **graphe** montre TOUS les projets du service et permet d'écrire.
`Sources/OMPConsole/Memory/` ne se lie jamais au service que par les traits de
`MemoryServing`.

**Deux modes, une bascule.** Le bouton de la barre d'outils nomme le mode à
ATTEINDRE : « Graphe » en liste, « Liste » en graphe. Le mode initial est la liste,
et il ne change pas : sommaire, recherche, fiche et gestes y sont ceux d'avant.
« Sommaire » ne concerne que la liste (désactivé en graphe), « Rafraîchir » (⌘R) agit
sur le mode courant, et chaque mode garde SA requête de recherche.

**Les routes.** Le client construit quatre routes de lecture — `GET /health`,
`GET /memory/all` (avec `?agent_id=<portée>` pour la liste, SANS query pour le
graphe, qui couvre alors toutes les portées), `POST /memory/search` (avec
`agent_id` pour la liste, sans lui pour le graphe) et `GET /memory/graph` — plus les
écritures du mode graphe : `POST /memory/add` (`infer: false` : le texte est stocké
**mot pour mot**, aucun appel LLM), `PUT /memory/{id}` (le texte est écrit tel quel,
`tags` remplace les étiquettes) et `DELETE /memory/{id}`.

**Le service.** L'adresse vient de `MEM0_HTTP_URL` (`http://localhost:8321` par
défaut), le jeton de `MEM0_HTTP_TOKEN` (vide par défaut, envoyé en en-tête
`X-Mem0-Token` seulement s'il est non vide). Le bundle porte
`NSAppTransportSecurity` → `NSAllowsLocalNetworking` : sous macOS 14, ATS refuse par
défaut une connexion HTTP vers une IP littérale. Une variable posée mais **vide**
est traitée comme absente. Les budgets d'inactivité sont ceux du plugin (20 s pour
la recherche et le graphe, 10 s pour les autres), et il n'y a **aucun sondage
périodique** : la sonde part à l'apparition de la section, au bouton « Rafraîchir »
et avant chaque recherche. Quand oMLX est en défaut, un bandeau orange
(`memory.omlxBanner`) le dit sans URL ni code : « oMLX ne répond pas : la recherche
de souvenirs est indisponible. Démarrez oMLX, puis rafraîchissez. » ou « oMLX
refuse la clé d'accès configurée : … », avec « Rafraîchir »
(`memory.omlxBanner.refresh`, refait la sonde) et « Copier le diagnostic »
(`memory.omlxBanner.diagnostic` : URL sondée, code, `OMLX_API_TOKEN`).

**L'identité du service.** `GET /health` reste à la même adresse, avec le même
protocole et les mêmes autres champs ; le service mémoire de l'app (mem0-rs, lancé
avec `OMP_INSTALLATION_TOKEN`) y ajoute un champ **additif** `installation` qui
porte le jeton d'installation de cette installation
(`<racine de support>/stack/installation-token`, 0600). L'app n'accepte comme
« son » service qu'une réponse `200` dont `ok` vaut `true` **et** dont
`installation` égale son jeton : un `200` nu rendu par un autre service est traité
comme étranger (état « Ce n'est pas la pile d'OMP Console »). Le contrat du plugin
mémoire est inchangé — il ne lit que `health.ok` —, et la voie manuelle
`mem0-stack/` (sans `OMP_INSTALLATION_TOKEN`) garde son `/health` identique.

> La route `GET /memory/graph` et l'extension `PUT` (étiquettes) sont **nouvelles
> côté service** : un service construit avant elles répond 404/405. L'iPhone
> affiche alors « Graphe indisponible : serveur mémoire trop ancien » (la fenêtre
> macOS affiche l'erreur du service dans l'état « Mémoire indisponible »).
>
> Le service mémoire de l'app (le `mem0-rs` embarqué) porte ces routes. Il se met
> à jour avec l'app : un binaire embarqué différent recharge l'agent à la
> préparation suivante (voir « Service mémoire »), sans geste manuel. La pile
> MANUELLE de `mem0-stack/` se met à jour par sa propre procédure
> (`mem0-stack/README.md`).

**La portée** est calculée par le même algorithme que `projectId` du plugin mémoire
(`omp-mem0-memory/state.ts`) : override `MEM0_PROJECT_ID`, sinon la racine du dépôt
**principal** — un worktree de feature partage donc la portée du principal —, puis
`package.json`, `pyproject.toml`, `Cargo.toml`, `Package.swift`, puis le premier
`*.xcodeproj`, puis le nom du répertoire. `_global` n'est jamais envoyé : la liste
ne montre que la mémoire du projet. Sans portée calculable (aucun projet ouvert,
`git` en échec), la liste affiche « Aucun projet ouvert » avec le bouton **Choisir
un projet…** (`memory.chooseProject`, voir la section Fichiers) et n'émet aucun
appel de portée — le GRAPHE, lui, n'en dépend pas : il montre toutes les portées du
service.

**La recherche** reproduit `mem0_search` : pool sur-échantillonné
`min(6 × 4, 50) = 24`, seuil de cosinus brut **0,55**, `explain` vrai, puis
`selectRelevant` (cosinus seuls, décroissant, tronqué à 6). Les cosinus viennent de
`score_details.semantic_score` — jamais du `score` renvoyé, que BM25 sature. En mode
GRAPHE, la même sélection s'applique mais **sans la troncature à 6** : le graphe
garde tout le pool et se restreint aux souvenirs trouvés et à leurs liens.

### Le mode graphe

Chaque souvenir du service est un **nœud** (disque teinté par projet), les nœuds
d'un même projet forment une grappe nommée à son centre, et les liens viennent de
trois sources, jamais confondues :

| Lien | Origine | Trait |
|---|---|---|
| dérivé sémantique | `GET /memory/graph` : voisins de cosinus ≥ **0,75**, au plus **8** par souvenir, calculés par le service sur les vecteurs déjà stockés (aucun appel oMLX) | plein, gris |
| dérivé d'étiquette | chaque étiquette portée par ≥ 2 souvenirs AFFICHÉS devient un **nœud-étiquette** (`#étiquette`) relié à eux | plein, gris clair |
| manuel | créé à la main dans la fiche (« Relier à… ») | **discontinu, accentué** |

Le placement (Fruchterman-Reingold local, graine et itérations fixes) est
déterministe et calculé hors du fil principal. Gestes : clic = sélection (fiche à
droite) ou filtre d'étiquette sur un nœud-étiquette, clic dans le vide =
désélection, glisser = déplacement, pincement = zoom centré sur le point du geste
(borné 0,25–3,0), survol = mise en évidence du nœud et de ses liens ; clavier : Tab
donne le focus au canevas, les flèches prennent le nœud le plus proche dans la
direction, Échap désélectionne, ⌘0/⌘+/⌘− recadrent, agrandissent, réduisent. La
barre de contrôles porte les menus « Projet » et « Étiquette » (défaut : tous), le
bandeau de compte (`n souvenirs · p projets · l liens manuels`) et « Nouveau
souvenir ».

**Les écritures** vivent dans la fiche du mode graphe uniquement : « Modifier… »
(texte pré-rempli **verbatim**, étiquettes en champ séparé par des virgules),
« Supprimer… » (confirmation destructive), « Nouveau souvenir » (texte, étiquettes
facultatives, projet choisi) et les liens manuels (« Relier à… », « Détacher »). Une
écriture réussie recharge le graphe ET la liste. Les liens manuels sont un artefact
de la VUE : ils vivent dans `<racine de support>/memory-links.json`
(`{"version":1,"links":[{"a":…,"b":…}]}`, `a < b`, écriture atomique), ne sont
jamais écrits dans mem0, et un lien dont un souvenir disparaît est élagué au
rechargement suivant.

**Les états**, chacun avec son texte (tous dans `MemoryText`) :

| État | Rendu |
|---|---|
| aucune sonde encore | `Chargement de la mémoire du projet…` (liste) / `Chargement du graphe des souvenirs…` (graphe) |
| portée incalculable (liste) | « Aucun projet ouvert » — « Choisissez le projet dont vous voulez consulter la mémoire. » + bouton « Choisir un projet… » : menu des projets connus puis « Choisir un dossier… », ou, sans projet connu, le panneau d'ouverture ; le choix recharge la liste sur place |
| service indisponible | « Mémoire indisponible » + bouton « Réessayer », puis « Copier le diagnostic » (adresse du service et dernière erreur, jamais affichées) — jamais une liste vide, jamais un graphe partiel silencieux |
| adresse tenue par un autre service (liste) | « Ce n'est pas la pile d'OMP Console » — « Cette adresse répond, mais elle est tenue par un autre service : la mémoire du projet n'est pas celle d'OMP Console tant que sa pile n'occupe pas le port. », puis « Copier le diagnostic » (`<adresse>` · `Tenu par <propriétaire>.` · `Geste : <geste>`) |
| écriture refusée (graphe) | « La modification n'a pas été enregistrée : la mémoire n'a pas répondu comme prévu. Réessayez ; si l'échec revient, copiez le diagnostic. », feuille laissée ouverte, et « Copier le diagnostic » (réponse brute du service) |
| sommaire vide | « Aucun souvenir » — « Aucun souvenir dans la mémoire du projet « <portée> ». » |
| sommaire | `<n> souvenirs` (vrai pluriel) puis les lignes, dans l'ordre du service : un titre court sur deux lignes au plus (`MemoryText.title` : début du souvenir jusqu'au premier « : » ou à la première phrase, sans code, chemins réduits à leur dernier composant, 90 caractères au plus), puis une ligne de contexte (date relative · étiquettes `#tag` lues de `metadata.tags`) |
| recherche sans ligne | « Aucun résultat » — « La mémoire du projet ne contient aucun souvenir correspondant. » |
| recherche sans score | « Recherche impossible » — « Ce service de mémoire ne sait pas classer les souvenirs par pertinence. » |
| recherche sous le seuil | « Aucun résultat » — « Aucun souvenir n'est assez proche de cette recherche. » |
| graphe vide | « Aucun souvenir » — « La mémoire du service ne contient aucun souvenir. » |
| graphe, recherche sans résultat | « Aucun résultat » — « Aucun souvenir du service ne correspond à cette recherche. » |
| graphe, filtres sans résultat | même état vide, menus toujours accessibles |
| détail | un titre (`MemoryText.title`), la ligne de contexte, le bouton « Copier » (presse-papiers), le texte **complet** rendu en Markdown et sélectionnable, puis « Détails techniques » repliés : identifiant (monospacé), portée de la ligne, pertinence (en recherche) ; en mode graphe, les actions d'écriture et le bloc « Liens manuels » |

**Identifiants d'accessibilité** : `memoire.summary.button`, `memoire.refresh`,
`memoire.unavailable.diagnostic`, `memoire.foreignOwned.diagnostic`,
`memoire.summary.count`, `memoire.search.results`,
`memoire.list`, `memoire.list.row.<id>`, `memoire.detail`, `memoire.detail.title`,
`memoire.detail.copy`, `memoire.detail.technical` ; mode graphe :
`memoire.graph.toggle`, `memoire.graph.canvas` (libellé = bandeau de compte),
`memoire.graph.project`, `memoire.graph.tag`, `memoire.graph.zoomIn`,
`memoire.graph.zoomOut`, `memoire.graph.recenter`, `memoire.graph.create`,
`memoire.graph.edit`, `memoire.graph.delete`, `memoire.graph.link`,
`memoire.graph.detach.<id>`, `memoire.graph.error` (et `.diagnostic`),
`memoire.graph.unavailable.diagnostic`, `memoire.create.sheet`,
`memoire.edit.sheet`, `memoire.link.sheet` (et `.text`, `.tags`, `.project`,
`.cancel`, `.save`, `.error`, `.error.diagnostic` sur chacune) ; bandeau de
nettoyage de l'ancien moteur : `memory.podmanCleanup` (et `.remove`, `.confirm`,
`.progress`, `.retry`, `.diagnostic`). Clavier : `Tab`/`Maj-Tab` dans l'ordre de
mise en page, `Retour` dans le champ de recherche lance la recherche du mode
courant, le vider (ou sa croix) ramène la liste au sommaire et lève la restriction
du graphe sans requête, les flèches haut/bas déplacent la sélection de la liste, les
flèches du canevas sélectionnent le nœud voisin, `⌘R` rafraîchit, `⌘0`/`⌘+`/`⌘−`
recadrent le graphe, `⎋` annule une feuille (ou désélectionne le canevas), `↩`
valide la feuille active.

**Recette manuelle** (hors CI : aucun script ne pose ses variables) :

```bash
cd omp-console
MEM0_MEMORY_RECIPE=1 MEM0_MEMORY_RECIPE_PROJECT=/chemin/du/projet \
  swift test --filter recetteManuelleRendLaMemoireDuProjet
```

Elle relève sur le VRAI service la portée calculée, l'état, le compte du sommaire et
ses trois premières lignes, puis les résultats d'une recherche — et n'écrit rien
dans le projet. `--filter recetteGraphe` exerce, lui, le cycle complet d'écriture sur
le vrai service (créer, chercher, corriger, relier, détacher, supprimer) dans une
portée dédiée `_graph-recipe`.

## API distante

La coque héberge une **API HTTP locale** pour un appareil du réseau local (un
téléphone, une tablette, une autre machine) : elle sert l'appairage, l'état des
composants du Mac et la mémoire du projet ouvert, et pousse ses changements par un
flux temps réel. Les pipelines n'y passent pas : l'app iOS joint directement le
serveur de pipelines du VPS (voir « Serveur de pipelines »).

- **Routes** : l'API sert exactement **9 routes**, image exacte de
  `ClientRoute.all` (le test de contrat de la coque confronte les deux) —
  `GET /v1/version`, `GET /v1/devices`, `GET /v1/components`,
  `GET /v1/memory/page`, `GET /v1/memory/search`, `GET /v1/memory/graph`,
  `GET /v1/stream`, `POST /v1/pair` et `DELETE /v1/devices/self`.
- **Transport** : HTTP/1.1 en clair, sur la **seule interface du réseau local**.
  Le port par défaut est **8787** (`OMP_CONSOLE_REMOTE_PORT` le déplace, pour une
  instance de recette) et le service est annoncé par **Bonjour** sous le
  type **`_ompconsole._tcp`** (instance « OMP Console », TXT `v` = version du
  protocole, `api` = base des chemins). Une connexion dont la source n'est pas une
  adresse locale (boucle locale, plages privées, lien-local) est coupée sans un octet.
- **Version de protocole** : chaque requête porte `X-Console-Protocol-Version: 3` et
  chaque réponse le renvoie. Un client dont la version diffère est refusé par le code
  partagé `incompatible_protocol`, sans qu'aucune donnée ne soit servie, et l'app
  iOS se verrouille sur « version de protocole incompatible » avec les deux
  numéros, sans double support. La version 3 retire toutes les routes du moteur
  local (magasin, sessions, gestes, audits, statistiques) : une app de version 2
  se verrouille face au Mac.
- **Route graphe et service trop ancien** : `GET /v1/memory/graph` est la SEULE route
  qui rend le code partagé `outdated_service` (statut `503`, enveloppe
  `{"error":{"code":"outdated_service","message":"…"}}`), et uniquement quand
  le service mémoire répond 404 ou 405 sur son propre `/memory/graph` (service sans cette
  route). Le message est celui des autres pannes mémoire ; un client qui ne connaît
  pas ce code lit le `503` comme `unavailable`. La liste, la recherche et les autres
  pannes du graphe (service injoignable, `500`, délai dépassé) gardent `unavailable`.
  Le graphe lit la **seule portée résolue**, par la même règle que la liste (`scope`
  explicite non vide, sinon le projet courant) ; sans portée résolue il rend un graphe
  vide sans lire le service. Sa charge utile porte `scope` (la portée lue) ; il n'a
  plus de borne en nombre de souvenirs, seulement une borne d'octets de **16 Mio**.
- **Page de mémoire** : `GET /v1/memory/page` remplace `GET /v1/memory` et sert la
  liste par pages. Paramètres : `scope` (facultatif, même résolution que le graphe),
  `offset` (entier ≥ 0, défaut 0) et `limit` (1 à 200, défaut 100). Un `offset` ou
  un `limit` hors bornes rend `400 bad_request`, vérifié AVANT toute lecture du
  service. Charge utile `{scope, total, offset, rows, nextOffset}` : `nextOffset` est
  absent sur la dernière page ; une page dépassant 2 Mio est raccourcie, sans jamais
  servir moins d'un souvenir. Sans projet, la page est vide (`scope` nul, `total` 0)
  sans lire le service. La route ne rend jamais `404`.
- **Appairage** : `POST /v1/pair` est la **seule route non authentifiée**. Elle prend
  `{"code":"XXXXXXXX","name":"<appareil>","deviceKey":"<installation>","protocolVersion":3}`
  et rend un jeton d'appareil (`Authorization: Bearer <jeton>` sur toutes les autres
  routes). Le code est généré dans **Réglages… › Appareils** (⌘, ou menu « OMP Console ›
  Appairage… », ⌥⌘A), affiché huit caractères Crockford base32 groupés `XXXX-XXXX`,
  valable **120 secondes** et à **usage unique** ; au-delà de 5 échecs, le code se
  verrouille et seul un code neuf le déverrouille. Le code est accepté **avec ou sans
  tiret ni espaces, en majuscules comme en minuscules** (`ABCD-EFGH`, `ABCD EFGH`,
  `abcd-efgh`), et les sosies de chiffres absents de l'alphabet sont lus comme au
  décodage Crockford : **I et L valent 1, O vaut 0** (U reste refusé). L'app
  iOS/iPadOS, le client et le serveur le normalisent par le même
  `PairingCodeFormat` (ConsoleCore, `lookalikes`).
- **Nom et identité de l'appareil** : l'app iOS/iPadOS transmet le **modèle précis**
  de l'appareil (« iPad Pro 13 pouces (M4) », « iPhone 17e »), jamais son nom
  personnel, et un identifiant d'installation (`deviceKey`, champ optionnel). Un
  **réappairage** du même appareil **remplace sa ligne** et révoque l'ancien jeton ;
  deux appareils distincts du même modèle gardent chacun leur ligne. Les anciennes
  lignes sans `deviceKey` (les « iPhone » d'avant) ne sont ni fusionnées ni
  supprimées : on les révoque à la main.
- **Réglages › Appareils** : le panneau Réglages (scène SwiftUI `Settings`, ⌘, ou
  « OMP Console › Réglages… ») n'a qu'un onglet, « Appareils » ; « OMP Console ›
  Appairage… » (⌥⌘A) ouvre ce même panneau, ou le ramène devant s'il est ouvert —
  une seule fenêtre « Appareils », aucune feuille. L'interrupteur « Accès depuis
  l'iPhone et l'iPad », en tête, est **actif par défaut** et mémorisé
  (`remote.enabled`, relu au lancement) ; le couper arrête le serveur et son annonce
  Bonjour et **annule le code en cours** (rallumé, aucun code actif). Le code ne se
  propose que service actif : coupé, la zone dit seulement « Le service est
  coupé. ». La liste « Appareils appairés » reste **visible et révocable service
  coupé**. Le panneau a une taille fixe (560 × 560 pt de contenu) : interrupteur et
  zone du code ne bougent pas, **seule la liste défile**, jusqu'au dernier appareil.
  Le code affiche « Expire dans mm:ss », puis « Code expiré » à l'échéance ;
  l'adresse du service n'apparaît qu'une fois, et c'est d'abord une adresse privée
  du réseau local (192.168/16, 10/8, 172.16/12), avant une adresse Tailscale
  (100.64/10) puis lien-local. Une adresse Tailscale tapée à la main dans l'app
  iOS/iPadOS fonctionne aussi : son ATS porte `NSAllowsArbitraryLoads` seul
  (`NSAllowsLocalNetworking`, qui ne couvre pas 100.64/10, le ferait ignorer) ;
  chaque ligne
  porte la date complète (« Appairé le 10 oct. 2026 à 21:54 ») et un bouton
  « Révoquer » que VoiceOver annonce « Révoquer <nom> », confirmé par « Révoquer
  <nom> ? » (« Révoquer » / « Annuler »).
- **Oubli par l'appareil** : `DELETE /v1/devices/self` (authentifiée, sans corps)
  révoque l'appareil **porteur du jeton**, et lui seul, exactement comme « Révoquer »
  dans Réglages › Appareils : jeton, ligne de `devices.json`, article du
  trousseau, flux SSE coupés, liste « Appareils appairés » mise à jour. Réponse
  `200 {"accepted":true}` ; `401 unauthorized` pour un jeton absent, inconnu ou déjà
  révoqué (un second appel rend donc `401`). C'est l'appel de « Oublier ce Mac » de
  l'app iOS, tenté au mieux : l'app oublie son jeton même si le Mac ne répond pas.
- **Permission macOS** : la première opération Bonjour d'un bundle lancé depuis le
  Finder déclenche l'alerte « Réseau local » (TN3179) ; l'onglet Appareils explique le refus
  et ouvre les Réglages Système. Un outil lancé depuis le Terminal (`swift test`,
  `bun`) en est exempté — c'est ce qui rend la recette de découverte reproductible.
- **État du Mac** : `GET /v1/components` sert
  `{ompInstalled, ompPath?, setupBanner?, homeDirectory?}` (la présence réelle du
  composant OMP et la phrase de préparation). `homeDirectory` est le dossier
  personnel du Mac ; l'app iOS s'en sert pour abréger les chemins en `~/…` (un Mac
  antérieur ne l'envoie pas : les chemins restent absolus).
- **Flux** : `GET /v1/stream` ouvre un `text/event-stream` (SSE) qui pousse `hello`,
  `devices` et `components`, avec un battement de cœur toutes les 15 secondes. À
  l'abonnement, l'ordre est `hello`, `devices` (la connexion de l'appareil est
  déclarée au registre), puis `components`. La révocation d'un appareil coupe son
  flux immédiatement.

### Sonde CLI

`scripts/omp-console-api.ts` est la sonde manuelle du dépôt (appairage, lecture,
flux) :

```bash
bun scripts/omp-console-api.ts pair --code XXXX-XXXX --name iPhone
bun scripts/omp-console-api.ts status
bun scripts/omp-console-api.ts memory --query "convention de nommage"
bun scripts/omp-console-api.ts watch --seconds 10
bun scripts/omp-console-api.ts forget
```

Le jeton vit au trousseau (service `com.omp.console.remote-api.cli`) et n'est jamais
affiché. Codes de sortie : `0` succès, `1` refus (le code d'erreur partagé et le
message du serveur sont imprimés tels quels), `2` prérequis absent (URL invalide,
serveur injoignable).

### Recettes

```bash
cd omp-console
MEM0_REMOTE_RECIPE=1 swift test --filter AC-20    # CLI ↔ coque réelle : appairage, état, flux
swift test --filter AC-1                          # annonce Bonjour + source locale
```

`AC-1` ne demande que `dns-sd` ; `AC-20` demande `bun` — sans lui, la recette est
**sautée**, jamais verte à tort.

#### Recette des Réglages › Appareils

```bash
bash scripts/swift-app.sh --no-tests              # le bundle à éprouver
bash scripts/recette/mac-appairage-recette.sh             # Mac seul
bash scripts/recette/mac-appairage-recette.sh --ios       # + iOS/iPadOS
bash scripts/recette/mac-appairage-recette.sh --captures-only --bundle <app de la base>   # captures « avant »
```

Elle lance une **instance de recette distincte** en arrière-plan (`open -g -n`), sur
un état jetable : 12 appareils hérités « iPhone » sans `deviceKey`, le port `OMP_CONSOLE_REMOTE_PORT=18787`. Seuls les composants de
l'utilisateur (`components`) sont **liés** ; le reste du support de l'instance
(`stack`, `mem0-rs`, `remote`…) est jetable. La préparation de l'instance écrit
dans `components` (`ComponentInstaller` purge toute version d'omp autre que celle
du bundle). D'où la **garde du manifeste** : avant tout lancement, la version
d'omp épinglée dans le binaire du bundle doit être exactement celle du support
réel — `components/omp/<v>` seul dans son dossier — sinon la recette sort en `2`
sans rien lancer. L'instance démarre son propre service mémoire : sa racine
jetable isole le label et le plist de l'agent (`<racine>/support/LaunchAgents/`),
`OMP_CONSOLE_MEM0_PORT` le place sur un port libre, et la recette décharge en fin
de passe tout plist de ce dossier (`launchctl bootout gui/$(id -u) <plist>`) ;
l'agent de l'utilisateur n'est jamais touché. `caffeinate -d` empêche la veille
d'écran (et le verrouillage qui la suit) pendant la passe.

Chaque ligne du rapport est qualifiée par sa feature. Mac seul :
`reglages-mac-appareils/AC-1` (« Réglages… » ouvre la fenêtre « Appareils », barre
d'onglets `["Appareils"]`), `AC-2` (un 2e « Réglages… » : une seule fenêtre CG
« Appareils »), `AC-6` (12 appareils : interrupteur et « Générer un code » dans la
fenêtre, la liste défile jusqu'à la dernière ligne, révoquée puis confirmée ⇒ 11),
`AC-3` (service actif : interrupteur à 1, code `XXXX-XXXX`, liste présente),
`AC-10` et `AC-11` (Réglages fermés puis « Appairage… » : la fenêtre « Appareils »,
aucune `AXSheet`) ; `mac-feuille-appairage-debordante/AC-6` à `AC-10` (révocation,
libellés « Révoquer <nom> », date complète, adresse unique, décompte puis
échéance). `--ios` ajoute `mac-feuille-appairage-debordante/AC-3`, `AC-4`, `AC-5`,
`AC-6` et `AC-11`. La recette ne touche **jamais** l'interrupteur : AC-4, AC-5 et
AC-9 de reglages-mac-appareils sont prouvés par les tests Swift. Quand la
préparation de l'instance de recette échoue (`sheet.setup.failure` lisible, par
exemple un service mémoire qui ne répond pas), le
service distant ne démarre pas : les contrôles qui l'exigent (`reglages-mac-appareils/AC-3`,
l'adresse unique, la phase `--ios`) sortent en `– … — non évalué (<cause>)`, ni
verts ni rouges, et le bilan les compte. En `--captures-only` sur le bundle de la
base, la feuille de préparation de l'instance est fermée (« Fermer ») si elle
masque la feuille « Appairage ».

La sonde AX `scripts/recette/mac-appairage-sonde.swift` (compilée par `swiftc`) presse et
lit le panneau sans activer l'app ni la redimensionner : l'instance de
l'utilisateur n'est jamais touchée. Son conteneur est la fenêtre qui contient
`settings.devices` (à défaut, pour le bundle de la base, la feuille
`pairing.sheet`). Sous-commandes : `ouvrir` (« Appairage… »), `reglages`
(« Réglages… »), `compter <pid> <titre>` (fenêtres CoreGraphics du pid portant ce
titre), `fermer` (bouton de fermeture des Réglages), `onglets` (titres de la barre
d'onglets), `mesurer`, `defiler`, `presser`, `lire`, `attendre`, `confirmer`,
`fenetre`, `plein-ecran`. Chaque pression de menu relève l'app au premier plan
avant et après : si l'instance de recette y passe, la ligne échoue « focus volé »
et la recette s'arrête (`1`). `--ios` construit une app signée
ad hoc (`omp-console/.build-ios-recette`) et appaire trois simulateurs dédiés
(`appairage-tab-a`, `appairage-tab-b`, `appairage-tel`, conservés d'un passage à
l'autre, jamais désinstallés) en saisissant le code sous ses trois formes.
Sorties (`--out`, défaut `/tmp/mac-appairage-recette-<horodatage>`) : `rapport.txt`
(une ligne `✔`/`✗` par contrôle), mesures JSON et captures PNG
(`apres-reglages-haut.png`, `apres-reglages-bas.png` ; `feuille-haut.png`,
`feuille-bas.png` pour les captures « avant » de la base). En fin de passe, les
appareils appairés par la recette sont révoqués par l'onglet (leurs jetons
quittent le trousseau du Mac) et l'instance reçoit `kill -TERM`. Codes de sortie :
`0` vert sur tous les contrôles évalués, `1` au moins un critère rouge, focus volé
ou capture « avant » manquante, `2` non exécuté (hors macOS, session verrouillée,
Space plein écran d'une autre app, bundle absent, manifeste du bundle différent du
support réel, Accessibilité refusée au terminal).

## Vocabulaire et typographie

Les textes visibles des fichiers `*Text.swift` (ConsoleCore, ConsoleClient, coque
Mac, coque iOS) suivent [`GLOSSAIRE.md`](GLOSSAIRE.md) : un seul terme français par
notion, sauf les termes conservés (« pipeline », « feature », « PR », /req, /specs,
/impl, /review, noms propres), et la typographie française (’, espace insécable
avant ; : ! ? et dans « », …). La garde
`test/console/typographie-et-glossaire-francais.test.ts` le vérifie.

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 26)
├── Sources/OMPConsole/            la coque macOS
│   ├── OMPConsoleApp.swift        la scène, les modèles à l'échelle de l'app, les menus (sections ⌘1…⌘8, Appairage…, Quitter)
│   ├── ConsoleRootView.swift      la barre latérale, ses badges, les feuilles Préparation et Serveur
│   ├── ConsoleModel.swift         la section sélectionnée
│   ├── SectionViews.swift         une vue par section (`ConsoleSectionView`), le routeur `SectionDetail`
│   ├── OmpBinary.swift            le binaire `omp` du composant de l'app, sa présence (`OmpPresenceModel`)
│   ├── OmpEnvironment.swift       l'environnement des process lancés
│   ├── ProcessRunner.swift        l'exécuteur partagé (échéance, SIGTERM puis SIGKILL)
│   ├── ProjectRoot.swift          le projet choisi de l'app (`session.projectRoot`)
│   ├── Server/                    les sections de Pilotage, servies par le serveur de pipelines
│   │   ├── HarnessSectionViews.swift  cadre commun, Accueil, Pipelines, Projet, Audit, Statistiques
│   │   ├── HarnessInboxSections.swift la boîte de l'humain et ses gestes
│   │   └── ServerSheet.swift      la feuille « Serveur » (adresse, jeton, oubli)
│   ├── Files/                     la section Fichiers (git en lecture seule, arbre, diff, veille)
│   ├── Terminal/                  la section Terminal (PTY, émulateur, rendu)
│   ├── Memory/                    la section Mémoire (liste, recherche, graphe, liens)
│   ├── ProjectChooser/            le choix du projet des états vides
│   ├── Setup/                     la préparation : composants, migration, service mémoire
│   ├── Stack/                     le service mémoire (agent launchd), oMLX, ancienne pile
│   ├── Remote/                    l'API distante (serveur HTTP, routeur, flux SSE, appareils)
│   ├── Settings/                  Réglages › Appareils
│   ├── Quit/                      la confirmation au Quitter
│   ├── Intents/                   l'App Intent « Ouvre OMP Console »
│   ├── MenuBar/                   l'ordre des séparateurs du menu principal
│   └── Design/                    surfaces, badge d'état, diagnostic copiable, fenêtre principale
├── Sources/ConsoleClient/         la cible partagée macOS/iOS des clients distants
│   ├── ConsoleClientModel.swift   le client du Mac : découverte, appairage, lectures, flux
│   ├── ClientRoute.swift          le catalogue des 9 routes
│   ├── HarnessModel.swift         le client du serveur de pipelines du VPS
│   ├── HarnessWire.swift          le contrat JSON du serveur de pipelines
│   ├── HarnessTransport.swift     le transport https et le lecteur SSE du serveur
│   └── HarnessDrafts.swift        les brouillons de lancement et de geste
├── Sources/ConsoleCore/           la cible partagée macOS/iOS, sans dépendance
│   ├── Design/                    sections, vocabulaire, contrat de l'API, mots du serveur de pipelines
│   ├── Memory/                    le noyau du graphe de la mémoire
│   ├── Files/MarkdownDocument.swift  le rendu Markdown en blocs
│   ├── Setup/SetupText.swift      les mots de la préparation
│   └── Support/                   JSON, chemins, URL
├── Tests/OMPConsoleTests/         la suite Swift Testing de la coque
├── Tests/ConsoleClientTests/      la suite hermétique des clients distants
├── ios/                           l'app iOS/iPadOS (voir « Coque iOS »)
├── Bundle/Info.plist              le plist du bundle .app (et `Bundle/AppIcon.icns`)
└── build/                         artefacts (bundle .app, captures), ignorés par git
```

## Plateforme

La section `── App Swift` de `scripts/check.sh` ne tourne que sous macOS : elle
compile le paquet, lance ses tests et assemble le bundle. Sous Ubuntu, elle
annonce « non exécuté » sans faire échouer la validation du dépôt ; les tests réels
du harnais y sont eux aussi « skipped », faute de `omp`.

Il en va de même pour la section `── App iOS` : elle exige `xcodebuild`, donc
macOS **et** Xcode utilisable. Partout ailleurs elle annonce « non exécuté » sans
rougir — sauf en CI `macos-latest`, où `MEM0_OMP_REQUIRE_IOS=1` transforme cette
absence en échec.

## Coque iOS

`omp-console/ios/OMPConsoleIOS.xcodeproj` est l'app iOS de la salle de contrôle :
six sections, dérivées du type partagé `ConsoleSection` (Terminal et Fichiers
sont hors périmètre), une seule barre d'onglets native (`TabView`, style
`.sidebarAdaptable`) — sur iPhone, cinq onglets en bas (Accueil, Pipelines,
Projet, Audit, « Plus »), « Plus » étant une liste titrée qui pousse Statistiques
et Mémoire dans sa propre pile ; sur iPad, une barre latérale titrée « OMP
Console », visible dès le lancement, à deux groupes (Pilotage : Accueil,
Pipelines, Projet, Audit, Statistiques ; Consultation : Mémoire), la barre
d'onglets du haut n'apparaissant que lorsqu'on masque la barre latérale. Chaque
onglet garde sa pile et sa position de défilement quand on en change ; passer en
largeur compacte (iPad en Split View) range Statistiques et Mémoire sous « Plus »,
et inversement. Le routage onglet ↔ section est pur (`IOSTabs.swift`, testé par
`IOSTabsTests`).

L'app a deux clients, sans magasin local :

- **Le serveur de pipelines du VPS** pour les cinq sections de Pilotage
  (`IOSHarnessScreens.swift`) : les mêmes écrans que sur le Mac — résumé et boîte de
  l'humain, lancement d'une feature, d'un projet ou d'un audit, statistiques —, sur
  le même `HarnessModel` (voir « Serveur de pipelines »). L'app joint le serveur en
  https, sans passer par le Mac ; la feuille « Serveur » (`IOSServerSheet`, bouton
  `ios.server.open`) relie l'adresse et le jeton. Les listes se tirent pour
  actualiser, et une feature en cours a son menu contextuel « Arrêter la feature ».
- **Le Mac appairé** pour la Mémoire et l'état de connexion (`ConsoleClient`) —
  découverte Bonjour, appairage au trousseau et feuille de connexion. Le Mac
  découvert est joint par son adresse IPv4 ou IPv6, lien-local zoné compris ; une
  adresse s'affiche toujours sans sa zone d'interface (`192.168.1.175:8787`,
  `[fe80::1]:8787`), adresse manuelle comprise (`ClientAddress.display` ; la forme
  enregistrée `ClientAddress.text` garde la zone).

L'onglet Accueil (iPhone) et l'entrée Accueil de la barre latérale (iPad) portent
le badge de ce qui attend l'humain sur le serveur, l'onglet Audit celui des audits
à trier ; VoiceOver lit « Accueil, N en attente ». Le bouton antenne
(« Connexion ») rouvre la feuille de connexion au Mac à tout moment, connecté ou
non, une seule fois par écran : sur iPhone, dans la barre de chaque onglet, de la
liste « Plus » et des écrans qu'elle pousse ; sur iPad, une fois, dans la barre de
la section.

Hors connexion au Mac, la Mémoire suit la même règle sur iPhone comme sur iPad.
Rien encore chargé : la section n'affiche QUE le composant « non connecté » —
« Pas de connexion au Mac », une phrase de cause (non appairé, appairage refusé ou
révoqué, Mac injoignable, ou l'app à mettre à jour) et « Se connecter », qui ouvre
la feuille Connexion — ou, pendant une tentative, le composant « Connexion au
Mac… » avec son indicateur d'attente et aucun bouton. Données déjà chargées :
elles restent affichées, sous le même composant en bandeau, qui disparaît seul à
la reconnexion.

La **feuille Connexion** ne s'ouvre d'elle-même que lorsque l'appareil n'a pas de
jeton d'appairage ou que le Mac refuse le sien — jamais pendant la lecture du
trousseau au lancement, jamais pour un appareil appairé : un Mac injoignable
(veille, autre réseau) laisse la Mémoire sur le composant « non connecté », cause
« Mac injoignable ». Un jeton refusé la rouvre toujours ; `-section` au lancement
(les captures) l'empêche de s'ouvrir d'elle-même.
Elle a quatre modes, décidés par le statut d'appairage du client :

- **lecture de l'appairage** : « Lecture de l'appairage… » et un indicateur ;
- **non appairé** : état, Macs découverts, adresse manuelle, code d'appairage
  (focalisé, clavier levé ; tiret, espaces et casse ignorés, I et L lus 1, O lu 0 ;
  champ déclaré code à usage unique, `.textContentType(.oneTimeCode)`, pour que
  le clavier propose un code reçu) et une ligne d'aide qui indique où trouver le
  code sur le Mac (« menu OMP Console › Appairage… (⌥⌘A), puis « Générer un
  code » »). Un code mal formé affiche « Le code fait 8 caractères : chiffres 0–9
  et lettres A–Z sauf U. ». Après « Appairer » (ou ↩ dans le champ), « Appairage
  en cours… » et un indicateur s'affichent sous le bouton (`connection.code.progress`)
  et « Appairer » reste désactivé jusqu'à la réponse du Mac : une seule requête
  `POST /v1/pair` par appui ; un échec retire l'indicateur et affiche son message
  sous le champ (`connection.code.error`). Quand le Mac a refusé le jeton, le
  message « Le Mac ne reconnaît plus cet appareil. Saisissez un nouveau code
  d'appairage. » s'y ajoute et l'adresse connue est préremplie ;
- **connecté** : « Connecté », l'adresse du Mac une seule fois, « Oublier ce Mac » ;
- **déconnecté** : l'état (« Mac injoignable », « Hors réseau »…), l'adresse une
  fois, « Réessayer », la modification de l'adresse dans le groupe replié
  « Modifier l'adresse » (une nouvelle adresse où le Mac répond reconnecte avec
  le jeton existant, sans code), et « Oublier ce Mac ».

Sur un appareil appairé, aucun champ n'a le focus à l'ouverture. « Oublier ce
Mac » demande confirmation, tente au mieux `DELETE /v1/devices/self` quand le Mac
est joint, puis efface le jeton local dans tous les cas ; la feuille passe alors
en mode non appairé.

Sa recette de design — surfaces, échelle typographique, marges, tons, politique
du verre, états vide et erreur, Dynamic Type — vit dans
`omp-console/ios/DESIGN.md`. Chaque règle y porte un marqueur `[test: …]`,
`[capture: …]` ou `[garde: design-ios/AC-<n>]` : aucune prose non jugeable.

**Largeur de lecture sur iPad.** Quand la fenêtre est large (iPad barre latérale
masquée, iPhone Pro Max en paysage), les écrans du serveur de pipelines posent leur
contenu dans une colonne centrée de 720 pt marges comprises
(`IOSMetrics.readableWidth`), mise à l'échelle par Dynamic Type
(`iosReadableWidth()`) ; le reste de la fenêtre forme deux marges égales. Le
défilement garde toute la largeur. Sous ce plafond (iPhone en portrait, iPad barre
latérale visible en portrait), rien ne change.

### Erreurs du Mac

Toute erreur rendue par le Mac — Mémoire (liste, recherche, graphe) — passe par UN
seul traducteur, `IOSMacErrorText`
(`omp-console/ios/OMPConsoleIOS/IOSMacErrorText.swift`). Il range l'échec en causes
distinguables et affiche la cause puis un remède propre à elle, sans URL, sans
adresse, sans JSON brut et sans code HTTP : « app Mac trop ancienne » (404
`route inconnue`, ou 404/405 hors contrat), « Mac injoignable » (connexion refusée,
Mac non connecté), « délai dépassé » (une lecture de la Mémoire sans réponse à
temps), « service indisponible sur le Mac » (503), « action refusée par le Mac »
(403), « refus du Mac » avec son motif (400, 409 ou 404 métier, tant que le motif
est présentable), la version de protocole incompatible, et le message générique
« le Mac a rencontré une erreur » (500, corps illisible, code inattendu). Le mode
Graphe de la Mémoire ajoute « service mémoire trop ancien » (`outdated_service`).
Un **401** n'affiche aucun message de section : le parcours de jeton révoqué est
inchangé (secret effacé du trousseau, retour à l'appairage). Chaque échec de
chargement propose « Réessayer » (44 pt). La table cause → message est dans
`omp-console/ios/DESIGN.md` (« Erreurs du Mac »). Les écrans du serveur de
pipelines ont leur propre table, `HarnessFailureText` (`ConsoleClient`) : serveur
injoignable, jeton refusé, délai dépassé, refus du serveur avec son motif, réponse
illisible.

### Recette : la feuille Connexion

Recette historique, écrite pour l'ancienne coque : ses contrôles 5 et 7 lisent
l'Accueil « non connecté », que l'Accueil du serveur de pipelines ne montre plus —
ils sont à porter sur la Mémoire avant de la rejouer.
`scripts/recette/ios-connexion-feuille-recette.sh` rejoue les contrôles de la feuille
Connexion sur un iPhone et un iPad **privés**, créés par le script (noms
`omp-connexion-tel-<moment>` / `omp-connexion-tab-<moment>`, sans « iPhone » ni
« iPad ») puis supprimés à la sortie. Il construit l'app **signée** hors dépôt
(DerivedData sous `/tmp`), ne touche à aucun autre simulateur, ni à l'app Mac, ni
au focus du Mac :

```bash
# Relevé « avant » sur la base, puis « après » sur l'arbre de travail.
bash scripts/recette/ios-connexion-feuille-recette.sh --avant <ref> --source <udid appairé>
bash scripts/recette/ios-connexion-feuille-recette.sh --source <udid appairé>
```

- `--avant <ref>` construit depuis `git archive <ref> omp-console` ; sans lui,
  depuis l'arbre de travail. Les valeurs attendues sont toujours lues dans
  `ConnectionText.swift` et `IOSConnectionStateText.swift` (cause « Mac
  injoignable » de l'Accueil) de l'arbre de travail : la base est jugée contre la
  spécification corrigée.
- `--source <udid>` désigne un simulateur déjà appairé au Mac : son trousseau
  (copie `sqlite3 .backup` de `keychain-2-debug.db`) et sa préférence
  `client.deviceId` sont greffés sur les appareils privés. Il n'est que lu. Sans
  `--source`, ou si la coque ne sert pas `127.0.0.1:8787`, les contrôles 5 à 9
  sont « sauté ».
- Sorties dans `omp-console/build/connexion-ios-feuille-intrusive-et-sans/<avant|apres>/` :
  une capture PNG et un relevé `idb ui describe-all` (JSON) par contrôle et par
  appareil, `rapport.txt` (une ligne `ok|échec|sauté <AC> <appareil> <détail>`
  par contrôle), `build.log`. Codes de sortie : 0 tous les contrôles exécutés
  sont « ok », 1 au moins un « échec », 2 non exécuté (hors macOS, Xcode
  inutilisable, idb absent, aucun runtime iOS ≥ 26, app non signée).

Chaque contrôle, sur iPhone et sur iPad, et son attendu observable :

1. **Premier lancement** (AC-3, AC-12) — sans jeton : la feuille s'ouvre d'elle-même
   en « Non appairé », avec le champ du code, et la ligne d'aide sous le code dit
   « Sur le Mac : menu OMP Console › Appairage… (⌥⌘A), puis « Générer un code ». ».
2. **Adresse vide** (AC-14) — « Utiliser cette adresse » est inactif ; après la
   saisie de `1`, il devient actif.
3. **« Effacer »** (AC-15) — lancé avec `-client.manualAddress 127.0.0.1:9` : la
   cible de « Effacer » fait au moins 44 × 44 pt.
4. **Code mal formé** (AC-13) — `UUUUUUUU` puis « Appairer » : « Le code fait 8
   caractères : chiffres 0–9 et lettres A–Z sauf U. », jamais « A–Z, 0–9 » (I, L
   et O sont lus comme des chiffres, U est la seule lettre refusée).
5. **Mac injoignable** (AC-2, AC-5, AC-7) — appairé, adresse `127.0.0.1:9` : aucune
   feuille, l'Accueil montre « Pas de connexion au Mac » et la cause « Mac
   injoignable » (`ios.connexion.cause`, sans adresse). « Se connecter » ouvre
   la feuille : « Mac injoignable », l'adresse une fois, « Réessayer », « Modifier
   l'adresse » (replié), « Oublier ce Mac », aucun champ du code, aucun champ
   focalisé, pas de clavier.
6. **Nouvelle adresse, puis « Réessayer »** (AC-7, AC-8) — déplier « Modifier
   l'adresse », saisir `127.0.0.1:8787` et valider : « Connecté » sans code. Puis,
   vers un port libre injoignable, ouvrir la feuille, démarrer un relais vers 8787
   et toucher « Réessayer » : « Connecté ».
7. **Mac joignable** (AC-1, AC-5, AC-6) — adresse `127.0.0.1:8787` : aucune feuille
   pendant 15 s, l'Accueil s'affiche. La feuille ouverte à la demande montre
   « Connecté », l'adresse une fois et « Oublier ce Mac », sans code, champ
   d'adresse, découverte ni focus. Elle s'ouvre par le bouton antenne quand il est
   affiché ; sinon (base sans la PR #89), depuis l'Accueil « non connecté » de cause
   « Mac injoignable », puis un relais rend le Mac joignable et la feuille passe
   d'elle-même en mode connecté.
8. **Oublier, puis annuler** (AC-9) — « Oublier ce Mac » ouvre la confirmation ;
   l'annuler (toucher hors de la bulle : iOS 27 n'y montre pas « Annuler ») laisse
   « Connecté ». Rien n'est émis vers le Mac.
9. **Oublier hors ligne** (AC-11) — adresse `127.0.0.1:9`, « Oublier ce Mac » puis
   confirmer : la feuille passe en non appairé ; un relancement rouvre la feuille
   non appairée, sans « Oublier ce Mac ». L'adresse est injoignable : le jeton du
   simulateur source n'est pas révoqué.

Deux scénarios révoquent un jeton sur le Mac et exigent un appairage frais : ils se
rejouent **à la main**. Côté code, AC-4 est prouvé par `PairingStatusTests` et
`ConnectionSheetModeTests`, AC-10 par `ForgetTests` et `DeviceForgetTests` :

- **AC-4 — jeton révoqué** : sur le Mac, Réglages › Appareils puis « Révoquer »
  l'appareil ; relancer l'app. Attendu : la feuille s'ouvre avec « Le Mac ne
  reconnaît plus cet appareil. Saisissez un nouveau code d'appairage. », le champ
  du code et l'adresse du Mac préremplie. Relancer sans saisir de code : la
  feuille est en « Non appairé », sans ce message.
- **AC-10 — oublier un Mac joignable** : appareil connecté, « Oublier ce Mac » puis
  confirmer. Attendu : la feuille passe en « Non appairé », et l'appareil disparaît
  de la liste « Appareils appairés » de Réglages › Appareils du Mac.

### Prérequis

- **Xcode 27** installé, et sa licence acceptée : sans cela, toute invocation de
  `xcodebuild` autre que `-version` échoue (« You have not agreed to the Xcode
  license agreements »). Le déblocage est une action de l'utilisateur :

  ```bash
  sudo xcodebuild -license accept
  ```

- Sur un poste équipé des seuls Command Line Tools, `xcodebuild -version` répond
  mais `xcodebuild -showsdks` échoue : c'est cette seconde commande que
  `scripts/ios-build.sh` emploie comme sonde, et il conclut « non exécuté » plutôt
  que d'échouer.

### Ouvrir, compiler, tester

```bash
open omp-console/ios/OMPConsoleIOS.xcodeproj
```

En ligne de commande, `DEVELOPER_DIR` désigne l'installation d'Xcode quand
`xcode-select` pointe les Command Line Tools :

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/ios-build.sh
```

Le script compile l'app en destination générique, choisit un simulateur iOS ≥ 26
et lance la suite Swift Testing de la cible `OMPConsoleIOSTests`. `--no-tests`
s'arrête après la compilation. Après la compilation, dans les deux modes, le
script contrôle `OMPConsoleIOS.app/Metadata.appintents/extract.actionsdata` contre
la même liste que le bundle Mac (voir *Liste attendue des intents Siri*) ; s'il
manque :
`  ✗ Metadata.appintents absent de l'app iOS : omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app/Metadata.appintents/extract.actionsdata manque (l'extraction App Intents n'a rien produit)`,
et s'il s'en écarte :
`  ✗ Metadata.appintents de l'app iOS non conforme à scripts/app-intents/attendus.json`,
tous deux en code 1, sans lancer les tests. Codes de sortie : `0` compilé (et
testé), `1` échec, `2` « non exécuté ».

L'icône de l'app iOS vient du catalogue `OMPConsoleIOS/Assets.xcassets`
(`AppIcon`, variantes claire, sombre et teintée) ; elle est dessinée avec celle du
Mac par `bash scripts/app-icon.sh` (voir « Assembler le bundle `.app` »), jamais
à la main dans Xcode. Le même catalogue porte l'`AccentColor`, égale au bleu
système. Les règles d'identité de l'app sont dans `omp-console/ios/DESIGN.md`.

### Captures des six écrans

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/recette/ios-shots.sh
```

Le script démarre un simulateur iPhone et un iPad, installe l'app, puis l'ouvre
sur chacune des six sections par son argument de lancement et capture l'écran :
**48 PNG** dans `omp-console/build/ios-shots/` (dossier ignoré par git — les
images sont des artefacts de PR, jamais committées) — six écrans × {iPhone
portrait, iPad portrait} × {clair, sombre} à taille de texte par défaut, plus
six écrans × {iPhone, iPad} × {clair, sombre} en Dynamic Type maximum (suffixe
`-ax`). Un SECOND groupe capture le **mode graphe de la Mémoire** via
`-memoire.recipe` : le graphe rendu, un état après pan/zoom et une fiche ouverte
— 3 états × {iPhone, iPad} × {clair, sombre} = **12 PNG**, soit **60** en tout.
Chaque capture est sondée en dimensions (`sips -g pixelWidth -g pixelHeight`) :
toutes PORTRAIT — une capture inattendue ferait échouer le script. Les écrans du
serveur de pipelines sont capturés serveur non relié.

Il n'y a AUCUNE ligne « iPad paysage », pour une raison mesurée le 2026-10-06 sur
le poste de référence : `simctl` n'a aucune sous-commande de rotation,
`Simulator.app` n'y est pas installé, et en mode fenêtré iPadOS refuse
`UIWindowScene.requestGeometryUpdate` (« The current windowing mode does not
allow for programmatic changes to interface orientation. ») ; l'opt-out
`UIRequiresFullScreen` rendrait la demande possible mais coûterait le Split View
et le Slide Over — un choix produit, pas un outil de capture. L'app DÉCLARE
portrait et les deux paysages : elle reste utilisable en paysage sur un vrai
iPad, à vérifier à la main sur l'appareil.

Un crochet de recette se pose en argument de lancement : `-section <rawValue>`
ouvre une section précise (`home`, `kanban`, `project`, `audit`, `stats`,
`memory`) — sur iPad, l'entrée de la barre latérale ; sur iPhone, l'onglet de la
section, et pour `stats` et `memory` l'onglet « Plus » avec l'écran déjà poussé,
le bouton retour ramenant à la liste « Plus » —, `-ios.state error` affiche le
bandeau d'erreur de recette sur la Mémoire, et `-memoire.recipe
<graphe|zoom|fiche>` force le mode graphe de la section Mémoire sur la fixture
partagée `MemoryGraphParity` (`liste` charge la même fixture mais reste en mode
LISTE et y ouvre la fiche d'un souvenir ; `clavier` garde, lui, le mode Liste sans
fiche et branche l'écran sur un lecteur de cette même fixture,
`IOSMemoryRecipeReader`, client `.connected` sans réseau : le sommaire montre ses
huit souvenirs, la recherche les filtre, et chaque lecture du sommaire écrit
`memoire-recipe-read` sur la sortie d'erreur du lancement ; `injoignable` et
`service-ancien` branchent la liste et le graphe sur un lecteur qui échoue
toujours, `IOSMemoryFailureReader` : `injoignable` reste en mode Liste sur le
bandeau « Mac injoignable. », `service-ancien` ouvre le graphe sur le bandeau
« Graphe indisponible : serveur mémoire trop ancien sur le Mac. », et chacun écrit
`memoire-recipe-ready` une fois l'échec affiché). Ce sont des crochets de
recette, pas des fonctionnalités.

Pour ouvrir une section précise sur un simulateur déjà démarré :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -section memory
```

La capture de l'état d'erreur (artefact de PR, hors des 60) :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -section memory -ios.state error
xcrun simctl io <UDID> screenshot omp-console/build/ios-shots/error-memory.png
```

### Recettes historiques

Plusieurs recettes au simulateur ont été écrites pour l'ancienne coque, quand les
sections de Pilotage lisaient le magasin du Mac : `ios-navigation-onglets-recette.sh`
(onglets Accueil, Pipelines, Sessions, Audit), `ios-statistiques-graphe-recette.sh`
(`-stats.recipe`), `ios-finitions-composants-recette.sh` (`-projet.recipe`,
`-pipelines.recipe`), `ios-dynamic-type-recette.sh` (`-home.recipe`,
`-sessions.recipe`) et `ios-connexion-recette.sh` (l'ancienne liste racine
`ios.section.*`), toutes sous `scripts/recette/`. Leurs crochets n'existent plus :
elles ne se rejouent pas telles quelles et sont à porter sur les écrans du serveur
de pipelines avant toute nouvelle preuve. Aucune n'est lancée par `check.sh` ni par
la CI.

### Recette idb : cibles, identifiants et bords

`scripts/recette/ios-recette-ui.sh` relève 6 surfaces de l'app iOS sur un simulateur
iPhone dédié et signale trois classes de défauts sur chaque relevé : une cible
tactile de moins de 44 pt, un identifiant d'accessibilité porté par plusieurs
éléments, un élément collé au bord de l'écran. Elle se lance à la main : ni CI,
ni iPad, ni appairage au Mac.

**Prérequis** : `xcrun` (Xcode), `idb` (`idb ui describe-all`, idb-cli 1.6.6 relevé
ici) et `python3` (bibliothèque standard seule : l'analyseur décode lui-même les PNG).

**Simulateur dédié.** Il doit être neuf (jamais appairé) et son nom ne contient ni
« iPhone » ni « iPad » : `ios-shots.sh` et `ios-build.sh` d'autres worktrees
prendraient sinon cet appareil. La recette ne le crée ni ne le supprime.

```bash
xcrun simctl create recette-ui-tel com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0
bash scripts/recette/ios-recette-ui.sh --sim <UDID> [--exceptions <fichier.json>] [--integrer <branche>]…
```

**Matrice.** 6 surfaces × 3 configurations = **18 relevés** : les six sections
(`home`, `kanban`, `project`, `audit`, `stats`, `memory`), en clair à la taille par
défaut, en sombre à la taille par défaut, puis en clair en AX-XL
(`accessibility-extra-large`). La Mémoire est alimentée par son crochet de recette
(`-memoire.recipe`), sans appairage ; Accueil, Pipelines, Projet, Audit et
Statistiques sont relevés serveur non relié. Un relevé n'est accepté que si deux
lectures consécutives de l'arbre sont identiques **et** que la surface est
reconnue par son marqueur d'accessibilité
(`scripts/recette/ios-recette-ui-analyse.py marqueur`) : jamais la liste « Plus »,
un écran déconnecté ou une autre section. L'ordre des clés du JSON d'idb et celui
de la liste `traits` d'un élément changent d'une lecture à l'autre ; la
comparaison porte donc sur le JSON décodé, `traits` pris comme un ensemble.

**Sortie.** `omp-console/build/ios-recette-ui/base/` (ignoré par git, vidé à chaque
passage) : `<surface>-<apparence>-<taille>.json` (arbre AX) et `.png` (capture sans
masque de coins) pour chacun des 18 relevés, `logs/` (journaux `--stderr` de l'app,
construction) et `rapport.txt`. L'app et le simulateur sont remis à l'état par
défaut à la sortie (apparence claire, taille `large`) ; le simulateur reste allumé.

**Rapport.** Une ligne par signalement, champs séparés par une tabulation :

```
SIGNALÉ	surface=<s>	apparence=<a>	taille=<t>	regle=<r>	source=<ax|capture>	element=<désignation>	cadre=<x>,<y>,<l>x<h>
EXCEPTÉ	surface=<s>	apparence=<a>	taille=<t>	regle=<r>	source=<ax|capture>	element=<désignation>	cadre=<x>,<y>,<l>x<h>	exception=<n>	justification=<texte>
```

Règles : `cible-44` (contrôle interactif dont un côté arrondi à 0,1 pt est < 44),
`id-duplique` (une ligne par élément porteur), `bord` (source `ax` : cadre qui touche
le bord à 0,5 pt près ; source `capture` : colonne de pixels x=0 ou x=largeur−1
différente du fond sur 44 pt ou plus, sections seulement, jamais la feuille). La
désignation d'un élément est `id:<AXUniqueId>`, sinon `libellé:<AXLabel>`, sinon
`type:<type>`. Sans signalement, le fichier est vide. La sortie standard donne le
chemin du rapport, `<N> signalé(s), <M> excepté(s)` et un avertissement `exception
inutilisée : <n>` par entrée qui n'excepte rien.

**Codes de sortie.** `0` : 18 relevés faits et aucun `SIGNALÉ` ; `1` : au moins un
`SIGNALÉ` ; `2` : la recette n'a pas pu conclure (prérequis, exceptions invalides,
relevé non vérifié, construction ou installation impossible).

**Exceptions.** `scripts/recette/ios-recette-ui-exceptions.json` (versionné)
est un tableau d'objets aux clés exactes `surface` (une des 6 clés ou `*`),
`apparence` (`clair`, `sombre`, `*`), `taille` (`defaut`, `ax-xl`, `*`), `regle`,
`source` (`ax` ou `capture`, `capture` seulement avec `bord`), `element`
(`id:…`, `libellé:…` ou `type:…`, strictement égal à la désignation) et
`justification` (non vide : elle nomme la cause lue dans le code). La première
entrée qui correspond excepte le signalement. Le fichier est validé avant tout
relevé ; les familles **protégées** (qui masqueraient les défauts visés par
l'audit) sont celles de l'analyseur.

**Intégration.** `--integrer <branche>` (répétable) relève, au lieu du worktree
courant, une intégration locale jetable : la recette prend `git merge-base HEAD
main`, vérifie chaque branche (`branche introuvable : <b>`, ou `branche sans commit
au-dessus de la base <court> : <b>`, sortie 2), crée un worktree détaché
`omp-console/build/ios-recette-ui/integration-src`, y fusionne les branches dans
l'ordre donné (`merge --no-ff`), construit et installe son app, puis affiche
`intégration : <base> + <b1>@<sha> + …`. Un conflit sur un fichier `.md` garde la
version déjà intégrée ; tout autre conflit annule la fusion et sort en 2
(`conflit hors documentation : <b> : <chemins>`). Le worktree est supprimé à la
sortie, quoi qu'il arrive ; rien n'est poussé, aucune branche n'est créée, et la
branche courante n'entre pas dans l'intégration. Le rapport va dans
`omp-console/build/ios-recette-ui/integration/`. Les exceptions et l'analyseur sont
ceux du worktree courant.

**Nettoyage** d'un simulateur dédié, dans cet ordre :

```bash
xcrun simctl shutdown <UDID>
pgrep -fl <UDID>        # vide, à l'exception de idb_companion
xcrun simctl delete <UDID>
pkill -f "idb_companion --udid <UDID>"
```

idb lance un `idb_companion --udid <UDID>` qui survit à `simctl delete` : sans
`pkill`, il reste.

### Installer sur un appareil réel

Ce geste appartient à l'utilisateur : il n'est pas nécessaire à la validation du
dépôt et ne bloque rien.

1. Brancher l'**appareil** à ce Mac et l'activer (sur l'appareil : *Réglages ▸
   Confidentialité et sécurité ▸ **Mode développeur***, puis redémarrer).
2. Dans Xcode, choisir la cible `OMPConsoleIOS` et l'appareil dans le sélecteur de
   destination.
3. Ouvrir l'onglet *Signing & Capabilities* de la cible, cocher *Automatically
   manage signing*, puis choisir son **compte** (Team). Si l'identifiant de bundle
   du dépôt (`com.omp.console.ios`) est déjà pris, en choisir un **unique**.
4. Lancer (⌘R). L'app s'installe et démarre.
5. À la première exécution, approuver le certificat de développement sur
   l'appareil : *Réglages ▸ Général ▸ VPN et gestion de l'appareil*.
6. Relancer l'app — elle s'ouvre alors normalement.

### Siri : statut de la connexion

L'app iOS déclare un App Intent en lecture seule, **Statut de la connexion**
(`IOSConnectionStatusIntent`, `ios/OMPConsoleIOS/IOSSiriText.swift`), et un App
Shortcut qui le rend atteignable par la voix et depuis l'app Raccourcis. L'intent
n'écrit rien, n'appaire rien et n'ouvre aucune connexion de plus : il lit le
client distant UNIQUE de l'app (`OMPConsoleIOSApp` le crée et l'enregistre pour
les intents par `IOSSharedClient`), attend la fin de la relecture du jeton au
trousseau — jamais la découverte du Mac — puis énonce l'état à cet instant
(`IOSSiriStatus`).

Phrases Siri (en français, toutes avec le nom de l'app) :

- « Statut de OMP Console »
- « Connexion de OMP Console »
- « Vérifier la connexion de OMP Console »

Réponses énoncées :

| État du client | Réponse |
|---|---|
| Aucun jeton, ou jeton refusé par le Mac | « Non appairé » |
| Jeton présent, Mac non joint (recherche, connexion en cours, Mac éteint ou injoignable, hors réseau, version incompatible) | « Appairé, Mac non joint » |
| Flux ouvert vers le Mac | « Connecté à *X* », où *X* est le nom d'instance Bonjour du Mac (« OMP Console », « OMP Console (2) »…), ou `hôte:port` pour une adresse manuelle |

- L'intent **ouvre l'app** au premier plan avant de répondre ; app tuée, Siri la
  lance à froid.
- Il exige un **iPhone déverrouillé** : le jeton est au trousseau en
  `WhenUnlockedThisDeviceOnly`, illisible appareil verrouillé. iPhone verrouillé,
  le système demande d'abord le déverrouillage.
- Dans l'app **Raccourcis**, OMP Console propose la tuile *Statut de la
  connexion* (symbole `macbook.and.iphone`), qui lance le même intent.
- Siri ne répond que s'il est interrogé : l'app n'annonce rien, aucune
  notification.
- La coque macOS doit être ouverte et joignable pour entendre « Connecté à … ».

Le build (`xcodebuild`, `scripts/ios-build.sh`) produit
`OMPConsoleIOS.app/Metadata.appintents/extract.actionsdata`, qui porte l'intent
et ses trois phrases (`${applicationName}`), contrôlé à chaque build contre la liste
attendue (voir *Liste attendue des intents Siri*). La réponse est prouvée par
`ios/OMPConsoleIOSTests/IOSSiriStatusTests.swift` ; la reconnaissance vocale, elle,
ne se prouve qu'à la main, sur appareil réel.

**Preuve manuelle sur iPhone réel** (client-ios-possede-par-la-vue/AC-6, conduite
par l'utilisateur) :

1. Installer l'app sur l'iPhone par Xcode (cible `OMPConsoleIOS`, signature de
   l'équipe du projet), comme dans *Installer sur un appareil réel*.
2. Appairer l'iPhone au Mac ; régler Siri en français ; garder l'iPhone
   déverrouillé.
3. App Mac ouverte : dire « Dis Siri, statut de OMP Console ». Attendu : l'app
   s'ouvre et Siri dit « Connecté à OMP Console » (ou le nom d'instance du Mac).
4. Quitter l'app Mac, puis redire la phrase. Attendu : « Appairé, Mac non joint ».
5. Dans Raccourcis, toucher la tuile *Statut de la connexion* d'OMP Console.
   Attendu : la même réponse qu'à l'étape précédente.

### Lire la mémoire du projet depuis l'iPhone

La section **Mémoire** de l'app affiche le sommaire du projet OUVERT côté Mac — les
mêmes souvenirs que la section Mémoire macOS, dans l'ordre du service —, permet
d'ouvrir un souvenir et de chercher, et dit l'état de la mémoire par une cause
distinguable et son remède (voir « Erreurs du Mac »). Un SECOND mode, le
**graphe**, s'ajoute derrière la bascule « Graphe ⇄ Liste » de la barre d'outils :
la LISTE reste le mode d'OUVERTURE. Le graphe est
calculé CÔTÉ MAC par le MÊME noyau que la fenêtre macOS (nœuds-souvenirs,
nœuds-étiquettes, arêtes de proximité et liens manuels), manipulable au doigt
(pincer, glisser, toucher) sur iPhone comme sur iPad ; toucher un souvenir met
son voisinage en évidence et ouvre sa fiche en lecture seule, toucher un
nœud-étiquette APPLIQUE son filtre (le menu « Étiquette » revient à la vue
entière). VoiceOver parcourt le graphe nœud par nœud : chaque souvenir affiché
annonce son titre et son nombre de liens (les titres liés en « Liés à », rotor
« Plus de contenu »), chaque nœud-étiquette son nombre de souvenirs, et activer
un élément agit comme le toucher. À l'ouverture, aucune étiquette n'en recouvre
une autre : un texte sans place attend le zoom, une capsule devient une pastille.
L'app ne lit que ce que le Mac sert : elle ne calcule aucune portée et
n'émet AUCUNE écriture — le graphe est une lecture (`GET /v1/memory/graph`), et
rien ne se rafraîchit en continu.

Recette PAS À PAS (chaque geste donne l'attendu observable et le mot exact) :

1. **Appairer** l'app au Mac (feuille de connexion), un projet étant choisi sur le
   Mac (Fichiers, Terminal ou Mémoire) : la section affiche l'en-tête « N souvenirs » (le
   total de la portée) puis les lignes de la première page du sommaire, chacune avec
   le texte du souvenir tel qu'il est stocké (aucun rendu Markdown), sur 3 lignes au
   plus (4 sur iPad), terminé par « … » s'il est plus long — le texte intégral est
   dans la feuille (étape 2) —, dans l'ordre du service (les plus récents d'abord).
   En faisant défiler jusqu'en bas, le pied « Chargement des souvenirs suivants… »
   lit la page suivante de lui-même (défilement continu, 100 souvenirs par page),
   jusqu'au dernier souvenir de la portée — chaque souvenir une seule fois, plus de
   ligne de troncature. Si une page suivante échoue, le pied dit pourquoi et offre
   « Réessayer », les lignes déjà lues restent. Aux tailles d'accessibilité, la date
   et les étiquettes d'une ligne s'empilent sous le texte.
2. **Ouvrir un souvenir** — toucher une ligne : la feuille montre la date relative et
   les étiquettes, puis le texte intégral tel qu'il est stocké (un `*` reste un `*`),
   et l'identifiant et la portée sous « Détails techniques » ; se fermer par le geste
   système (aucun bouton « Fermer »).
3. **Chercher** — taper « mémoire du projet » puis valider (retour clavier) :
   l'en-tête devient « Résultats pour « mémoire du projet » » et les lignes sont
   celles de l'outil `mem0_search` (mêmes identifiants, même ordre). Une recherche
   sans candidat au-dessus du plancher dit « Aucun résultat » — jamais le sommaire.
   La frappe seule n'émet aucune requête.
4. **Revenir au sommaire** — vider le champ (croix système) ou toucher « Sommaire » :
   le sommaire DÉJÀ lu revient, sans aucune requête.
5. **La mémoire tombe** — décharger l'agent du service mémoire (`launchctl bootout
   gui/$(id -u)/com.omp.console.mem0-rs`) puis tirer la liste vers le bas : le
   bandeau rouge dit « Service indisponible sur le Mac. » et son remède, sans
   adresse, sans JSON et sans code HTTP (le détail reste sur le Mac, dans la fenêtre
   Mémoire) ; « Réessayer » repasse au sommaire dès que le service répond de
   nouveau (`launchctl bootstrap gui/$(id -u)
   ~/Library/LaunchAgents/com.omp.console.mem0-rs.plist`, ou relance de l'app Mac).
   La liste et la recherche ne disent jamais « serveur
   mémoire trop ancien » : cette cause n'existe que dans le graphe.
6. **Aucun projet ouvert** — fermer le projet côté Mac puis tirer la liste : la carte
   dit « Aucun projet ouvert », sans lire la mémoire.
7. **Mac injoignable** — couper le Mac (ou l'appairage) : le bandeau « Pas de
   connexion au Mac » et sa cause s'affichent au-dessus des souvenirs déjà lus,
   le tirage de la liste ne relit rien, et aucune cause mémoire n'est inventée — jamais
   « Délai dépassé » ; rien de lu, la section n'affiche que le composant
   « non connecté ». Connecté, une lecture qui échoue faute de réseau dit « Mac
   injoignable. » et son remède, sur un bandeau orange avec « Réessayer ».
8. **Délai dépassé** — si le Mac, joint, met trop longtemps à servir une page ou le
   graphe (mémoire très chargée), la section dit « Délai dépassé : le Mac a mis trop
   de temps à répondre. » puis « Réessayez dans un instant. », avec « Réessayer ». Les
   lectures Mémoire (pages et graphe) ont un délai propre, plus long que celui des
   autres lectures ; les autres sections gardent « Mac injoignable. » (le traducteur
   partagé ne distingue le délai dépassé que pour la Mémoire).
9. **App Mac trop ancienne** — face à une app Mac qui précède la lecture par pages
   (route `GET /v1/memory/page` inconnue), la liste dit « Fonction indisponible : app
   Mac trop ancienne. » puis « Mettez à jour OMP Console sur le Mac, puis réessayez. »,
   sans code HTTP ni JSON. Les deux apps se mettent à jour ensemble : aucun mode de
   compatibilité.
10. **Le graphe** — toucher « Graphe » : le panneau commence en haut, sous la barre de
   navigation ; le compte dit « N souvenirs · 1 projet » — le graphe ne montre QUE
   le projet ouvert, tous ses souvenirs, aucun d'une autre portée. Le canevas montre
   les nœuds-souvenirs, les nœuds-étiquettes, les arêtes de proximité (trait plein
   gris) et les liens
   manuels (trait discontinu accentué) ; pincer pour zoomer, glisser pour déplacer,
   toucher un souvenir pour ouvrir sa fiche (texte intégral tel qu'il est stocké, étiquettes, liens),
   toucher un nœud-étiquette pour n'afficher que sa famille, puis « Étiquette ▸
   Toutes les étiquettes » pour revenir. Toucher « Liste » rend le sommaire
   inchangé — c'est le mode d'ouverture.
11. **Graphe et service trop ancien** — avec un service mémoire sans la route
   `/memory/graph` (servi à l'adresse `MEM0_HTTP_URL` de l'app Mac), toucher
   « Graphe » : le bandeau dit « Graphe indisponible : serveur
   mémoire trop ancien sur le Mac. » puis « Mettez à jour OMP Console sur le Mac, puis
   réessayez. », sans nom de service, sans URL, sans JSON et sans code HTTP. Si
   c'est l'app Mac elle-même qui ne connaît pas la route, il dit « Graphe
   indisponible : app Mac trop ancienne. » puis le même remède. Après la mise à jour,
   « Réessayer » affiche le graphe sans relancer l'app.

Recette OUTILLÉE : le test Swift gated `iosMemoireRecipe`
(`omp-console/Tests/OMPConsoleTests/MemoryIOSRecipeTests.swift`, titre
`ios-memoire/AC-1`) exerce contre une coque réelle les parties automatisables —
sommaire relayé identique à celui de la coque macOS, recherche identique à la
sélection de l'outil, panne relayée avec son message, et charge « aucun projet ». Il
est gardé par la variable `MEM0_MEMOIRE_RECIPE` et se lance par :

```bash
MEM0_MEMOIRE_RECIPE=1 swift test --filter iosMemoireRecipe
```

Banc sur la mémoire RÉELLE, sans toucher à l'app Mac : le test Swift gated
`memoryDelayServe` (`omp-console/Tests/OMPConsoleTests/MemoryDelayServeTests.swift`)
monte une coque construite depuis l'arbre de travail, branchée sur le vrai service
mémoire, avec pour projet ouvert la racine `MEM0_MEMOIRE_DELAI_ROOT`. Variables :
`MEM0_MEMOIRE_DELAI_SERVE=1` (sans elle, le test rend la main), `MEM0_MEMOIRE_DELAI_ROOT`
(requise), `MEM0_MEMOIRE_DELAI_MINUTES` (durée de service, défaut 20 ; 0 = contrôles
seuls) et `MEM0_MEMOIRE_DELAI_LATENCE` (secondes ajoutées avant chaque lecture lourde,
défaut 0, pour provoquer un « Délai dépassé »). Il imprime `SCOPE <portée>`, puis, sans
latence, `PAGES <n> LIGNES <n> DOUBLONS <d> TOTAL <total>` (toutes les pages lues par le
client de production : lignes = total, aucun doublon) et `GRAPHE SOUVENIRS <n>
AUTRES-PORTEES <k> TRONQUE <bool>` (un nœud par souvenir de la portée, aucun d'une
autre, non tronqué), enfin `PORT <port>` et un `CODE <code>` d'appairage frais toutes
les 90 s, à saisir dans un simulateur lancé avec `-client.manualAddress
127.0.0.1:<port>`. Lancer sans tube (sous un terminal) : la sortie est tamponnée sinon.

```bash
MEM0_MEMOIRE_DELAI_SERVE=1 MEM0_MEMOIRE_DELAI_ROOT=/chemin/du/depot \
  MEM0_MEMOIRE_DELAI_MINUTES=0 swift test --filter memoryDelayServe
```

### Clavier de l'iPad

Avec un clavier matériel, l'app pose huit commandes dans la **barre des menus de
l'iPad** (Globe-M, ou glissement depuis le haut ; depuis iPadOS 26 elle remplace
la superposition qu'on obtenait en maintenant ⌘). Chaque commande y affiche son
libellé français et son raccourci :

| Raccourci | Commande | Menu | Effet |
|---|---|---|---|
| ⌘1 … ⌘6 | Accueil, Pipelines, Projet, Audit, Statistiques, Mémoire | Présentation | ouvre la section, dans l'ordre affiché par la barre latérale |
| ⌘R | Actualiser | Présentation | relit les données de la Mémoire (la liste ou le graphe affiché) ; inactive ailleurs, où l'on tire la liste pour actualiser |
| ⌘F | Rechercher | Présentation | met le focus dans le champ de recherche (Mémoire en mode Liste) ; inactive ailleurs |

⌘R est inactif hors connexion et pendant une lecture en cours. Sous une feuille,
une alerte ou un `confirmationDialog`, les huit commandes sont sans effet ; ⎋ et ↩
des feuilles (Annuler, valider) restent inchangés, aucune commande ne les prend.
