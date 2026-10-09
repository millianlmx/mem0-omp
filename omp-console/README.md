# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : **une seule fenêtre**, une barre latérale à neuf sections en deux
groupes — **Pilotage** (**Accueil**, **Pipelines**, **Projet**, **Session OMP**,
**Terminal**) et **Consultation** (**Sessions**, **Fichiers**, **Mémoire**,
**Statistiques**), raccourcis ⌘1…⌘9 — et un panneau de détail. Rien n'ouvre de
fenêtre annexe : l'app est utilisable entièrement en plein écran (une session
ouverte depuis **Sessions** est poussée dans la section, avec un bouton retour).
L'app s'ouvre sur l'**Accueil** (voir « Premiers pas ») ; **Pipelines** affiche
le tableau des pipelines (voir « Section Kanban ») avec sa zone d'action (voir
« Agir depuis Pipelines »), **Projet** le pilotage de projet (voir « Section
Projet (pilotage) »), **Session OMP** la session servie par l'API locale (voir
« Piloter le service »), **Terminal** le terminal intégré (voir « Section Terminal »),
**Sessions** le sélecteur de sessions (voir « Visionneuse de session »),
**Fichiers** la visionneuse de fichiers et de diffs (voir « Lire les fichiers et
les diffs d'une cible »), **Mémoire** la mémoire du projet en lecture seule (voir
« Consulter la mémoire du projet ») et **Statistiques** la consommation des
exécutions (voir « Section Statistiques »). Liquid Glass est réservé à la
couche fonctionnelle que le système dessine (barre latérale, barres d'outils,
feuilles, et la pilule d'état d'une session ouverte) ; le contenu emploie des
surfaces opaques et les boutons standard `.bordered`/`.borderedProminent` (HIG
Materials : « Don't use Liquid Glass in the content layer »).
Cible minimale : macOS 26.

## Prérequis

- macOS 26 ou plus récent, sur **Apple Silicon (arm64)** : l'app installe son
  `omp` et son podman pour cette architecture, et refuse les autres.
- Les Command Line Tools d'Apple : `swift --version` doit répondre.
- **`xcodebuild` n'est ni requis ni utilisable** sur un poste sans Xcode : sur un
  poste équipé des seuls Command Line Tools, il refuse de tourner (« requires
  Xcode, but active developer directory is a CommandLineTools instance »). Tout
  passe par SwiftPM (`swift build`, `swift test`) et par l'assemblage du bundle
  décrit ci-dessous.
- **Un service local en marche** pour les sessions : l'app est **cliente** d'une
  API REST locale servie par `omp-mem0-req` (jeton et port dans
  `~/.omp/agent/pipeline/service.json`). L'app n'en lance **aucun** process :
  service absent ⇒ « service arrêté » et un bouton « Réessayer » (voir « Piloter
  le service »).
- **Rien d'autre à installer** : ni `omp`, ni podman/Docker, ni la pile mémoire —
  l'app installe et démarre tout ce qui lui manque au premier lancement (voir
  « Composants de l'app »). Restent hors périmètre, mais SIGNALÉS par l'app quand
  ils manquent : **oMLX** (natif, port 8000), **git** et **gh**.

## Premiers pas

Tout se fait depuis l'app, sans terminal :

1. **La préparation** — au premier lancement, l'app installe ses composants (OMP
   18.6.0, podman 6.1.3), migre la base mémoire existante si elle en trouve une,
   monte sa pile mémoire et sonde oMLX. La feuille « Préparation d'OMP Console »
   montre une ligne par étape (Composants, Migration de la mémoire, Pile mémoire,
   Prérequis) avec son état et son détail ; « Fermer » (Échap) n'interrompt RIEN —
   la préparation continue et l'Accueil garde un bandeau « Reprendre… » ; `↩`
   déclenche le bouton proéminent. « Réessayer » n'apparaît qu'en cas d'échec,
   proéminent, avec la cause en toutes lettres (« Pas de réseau : … », « empreinte
   SHA-256 différente », « Ce Mac n'est pas pris en charge (arm64 requis) », …). En
   cas de succès, la feuille se ferme d'elle-même. Rien ne dépend d'un `omp`
   système.
2. **Bienvenue** — au premier lancement d'une installation neuve (magasin vide ou
   absent), une feuille présente l'app (son icône) en trois promesses ; son seul
   bouton « Continuer » (↩ ou Échap) la ferme. Elle n'est montrée qu'une
   fois (préférence `home.welcomeSeen`) ; Aide ▸ « Bienvenue dans OMP Console » la
   rouvre. Sans historique, l'Accueil propose « Nouvelle feature… » au lieu d'un
   tableau vide. Notifications refusées ⇒ un bandeau neutre en tête de l'Accueil,
   « Ouvrir les Réglages » ou « Ignorer » (préférence
   `home.notificationsBannerDismissed`).
3. **Nouvelle feature** (barre d'outils, menu Fichier ou ⌘N) — une feuille : le
   dépôt (dépôts connus du tableau, ou « Choisir un dossier… », qui n'accepte
   qu'une racine git), les deux **modèles** (`Modèle req+specs` / `Modèle
   impl+review`, chaque liste menée par `défaut OMP (aucun modèle)` puis les
   sélecteurs de `omp models --json`), le titre (il devient la branche
   `feat/<titre>`) et le besoin.
   « Lancer » (↩, bouton par défaut) poste une commande `launch` au service et revient à
   l'Accueil, dont le bandeau suit l'accusé.
4. **Le service** — l'app ne lance **aucun** process `omp` pour les sessions :
   elle lit l'enregistrement `service.json` du service local (jeton, port), crée
   les sessions par l'API et poste les commandes. Un dépôt sans pilote vivant se
   réveille par `POST /v1/repos/{repo}/pilot` : le service crée ou adopte son
   conducteur, un seul par dépôt, et il vit tant que le service vit.
5. **À vous** — les questions de l'agent et les jalons arrivent en tête de
   l'Accueil, en cartes (badge sur « Accueil ») : « Répondre… » ouvre la feuille
   « Répondre » — une question `ask` en vol se répond par ses options ou un texte
   libre, une question en **texte** d'un maillon terminé par un texte (commande
   `reply`) ; « Valider les specs » et « Accepter la revue » agissent depuis la
   carte, et « Lire le contrat » (secondaire) ouvre la feuille **Contrat** pour un
   besoin ou des specs à valider. La PR livrée apparaît sous « Livrées récemment »
   avec « Ouvrir la PR ».
6. **Reprendre** — une pipeline dont le pilote est mort (service arrêté, session
   fermée) est « En pause » sous « En cours » avec « Reprendre », qui poste
   `POST /v1/repos/{repo}/pilot` ; le service réveille un conducteur qui adopte le
   lot.

**La pile mémoire survit à ⌘Q** : l'app ne possède aucun site d'arrêt — les
processus de la machine (`krunkit`, `gvproxy`) sont lancés par des invocations
podman courtes, les conteneurs sont `--restart unless-stopped`. Fermer l'app (ou
la voir plantée) ne coupe donc pas la mémoire : une session `omp` au terminal, ou
un `omp -p`, sur un dépôt reçoit toujours son rappel par `http://localhost:8321`
(le défaut du plugin `omp-mem0-memory`).

Un geste de carte **poste** sa commande au service (`POST /v1/repos/{repo}/commands`)
et affiche l'accusé rendu par la **réponse** : `state:"taken"` (le service l'a prise)
ou `state:"refused"` avec le motif exact du service, verbatim dans « Activité
récente » (Pipelines). Aucun fichier d'accusé, aucune relecture périodique : sans
service joignable, l'app affiche « service arrêté ». Prérequis : le service local
doit tourner et porter le canal de commande **et** la commande `reply`
(`ls -la ~/.omp/plugins/node_modules/omp-mem0-req` dit quelle copie est chargée ;
`omp plugin link <chemin>/omp-mem0-req` charge une copie de travail, `omp plugin
upgrade omp-mem0-req@mem0-omp` revient à la version publiée).

### Recette : une commande prise par le service

La preuve qu'une commande postée par l'app est prise en charge exige le service
local en marche : son enregistrement `~/.omp/agent/pipeline/service.json` porte le
jeton et le port. L'app ne lance **aucun** `omp` — c'est le service qui possède les
sessions et les conducteurs ; la commande part à l'API par
`POST /v1/repos/{repo}/commands`, avec le jeton dans l'en-tête `X-OMP-Service-Token`.

1. Vérifier que le service répond (le port et le jeton viennent du `service.json`) :

   ```bash
   read -r PORT TOKEN <<<"$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["port"], d["token"])' \
     ~/.omp/agent/pipeline/service.json)"
   curl -sS -H "X-OMP-Service-Token: $TOKEN" "http://127.0.0.1:$PORT/v1/health"
   ```

   Une réponse porte `{"pid":…}` ; un service absent fait échouer la connexion — c'est
   l'état « service arrêté » que l'app affiche avec son bouton **Réessayer**.

2. Depuis une carte « À vous », appliquer un geste (par exemple « Valider les specs ») :
   la ligne de « Activité récente » passe de « envoyé au pilote » à « prise en charge »,
   et la réponse du service porte `{"ack":{"state":"taken",…}}`.
3. Provoquer un refus (dépôt non git, plugin absent, conduite déjà vivante) : le journal
   affiche « refusée : <motif> », le motif exact de la réponse, jamais recomposé.

### Barres d'outils

| Section | Barre d'outils (en plus de « Nouvelle feature… », `toolbar.newFeature`, inactif avec l'infobulle « OMP Console prépare ses composants » sans composant OMP) |
|---|---|
| Terminal | « Choisir… » (`terminal.choose`), « Relancer » (`terminal.relaunch`), « Lancer omp » (`terminal.launchOmp`) — trois groupes séparés |
| Session OMP | l'état en pilule Liquid Glass teintée (`session.status` : « Prête », « Active »…), menu du projet (nom du dossier, « Choisir un dossier… » ⌘O), puis UNE action selon l'état : « Lancer la session » (`session.launch`, ⌘R), « Relancer » (`session.relaunch`, ⌘R) ou « Arrêter la session » (`session.stop`, ⌘.) ; « Détails techniques » (`session.details`) ; quand le service est arrêté, la fenêtre affiche « service arrêté » avec un bouton « Réessayer » |
| Statistiques | sélecteur « Projet » (`stats.project`), quand le tableau est affiché |
| Sessions, session ouverte | bouton retour vers la liste ; l'état du fil en pilule Liquid Glass teintée de sa couleur (`viewer.status` : « En direct » vert, « Démarrage » bleu, « Erreur de lecture » rouge) ; hors du direct, le bouton « Revenir au direct » (`viewer.returnToLive`) à sa place |

Identifiants de l'Accueil et des feuilles : `home.loading`, `home.firstRun`
(bouton `home.firstRun.start`), `home.ompMissing.background` (fond « OMP Console
prépare ses composants »), `home.setupBanner` (bandeau « Reprendre… »),
`home.dashboard`,
`home.notificationsBanner` (`home.notifications.openSettings`,
`home.notifications.ignore`), `home.launchBanner`, `home.attention.<carte>`
(boutons `home.attention.<carte>.action` et `home.attention.<carte>.contract`),
`home.running.<carte>`,
`home.resume.<carte>`, `home.delivered.open.<carte>`, `home.allPipelines` ;
feuille « Préparation d'OMP Console » `sheet.setup` (`sheet.setup.retry`,
`sheet.setup.close`) ; feuille Bienvenue `welcome.sheet` (`welcome.continue`) ;
feuille « Répondre » `answer.sheet` (`answer.question`,
`kanban.actions.options`, `answer.text`, `answer.submit`, `answer.cancel`) ; feuille
**Contrat** `contract.sheet` (corps `contract.sheet.body`, fermeture
`contract.sheet.close`) ; feuille
« Nouvelle feature » `launch.sheet`,
`launch.repo`, `launch.chooseFolder`, `launch.repoError`, `launch.title`,
`launch.description`, `launch.cancel`, `launch.submit` ; les deux sélecteurs de
modèle `models.reqSpecs` / `models.implReview` (`models.loading`,
`models.failure`, `models.retry`) ; feuille d'édition des modèles `models.sheet`
(`models.cancel`, `models.apply`). Une seule feuille à la
fois, dans l'ordre : Préparation d'OMP Console, Contrat, Bienvenue, Nouvelle feature,
répondre (`MainSheetPolicy`).

Le badge d'état des composants embarqués, au pied de la barre latérale, est
`components.badge` (mot + point teinté, aucune interaction) ; son état ne dépend
que de la présence des deux binaires sous la racine de l'app.

Lancer le bundle depuis un dépôt l'ouvre comme projet ; pour une capture sur un
magasin de démonstration, sans écrire de préférence :

```bash
cd <dépôt> && MEM0_PIPELINE_STATE_DIR=/tmp/demo/state \
  "<chemin>/omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" -home.welcomeSeen YES
```

(`-home.welcomeSeen NO` remontre la bienvenue sur un magasin vide.)

## Cibles

Le paquet déclare ces cibles (une ligne par cible, `omp-console/Package.swift`) :

- **OMPConsole** — la coque macOS : les vues, les modèles d'écran et les
  adaptateurs au système (AppKit, SwiftUI, PTY, réseau). Cible exécutable ;
  dépend de `ConsoleCore`.
- **OMPConsoleTests** — la suite Swift Testing de la coque ; dépend de
  `OMPConsole`, de `ConsoleCore` et de `ConsoleClient` (son test de contrat
  confronte le catalogue du client aux routes servies).
- **ConsoleClient** — la **cible partagée macOS/iOS du client distant** : le
  client typé du contrat d'API, la découverte Bonjour, le transport HTTP, le flux
  SSE, le trousseau et le modèle observable unique. Dépendance unique :
  `ConsoleCore` ; ni AppKit ni UIKit.
- **ConsoleClientTests** — la suite Swift Testing hermétique de la couche
  cliente (doublures de transport, de trousseau et de découverte : aucun Mac
  réel) ; dépend de `ConsoleClient` et de `ConsoleCore`.
- **ConsoleCore** — la **cible partagée macOS/iOS** : les modèles et constantes
  pures du magasin d'état, le vocabulaire figé des sections et le socle du
  contrat de l'API distante. Aucune dépendance (ni interne, ni externe) : elle se
  compile seule (`swift build --target ConsoleCore`) et n'importe ni AppKit ni
  UIKit — la section « Noyau partagé » de `scripts/check.sh` le tient.

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
# principal (modèles Kanban et Files) et des tests de vue ; en parallèle elle
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

`commands/` ne fait pas partie du périmètre **lu** par la couche `Store/`. La
section **Kanban** consomme le flux global en lecture, et c'est la couche
`Actions/` (voir « Agir depuis Pipelines ») qui écrit — et seulement deux
familles : les livraisons d'un run (dans `<stateDir>/inbox/`) et les commandes
postées au service (`POST /v1/repos/{repo}/commands`).

## Section Kanban

`Sources/OMPConsole/Kanban/` est le **tableau des pipelines** : une ardoise unique
mêlant **tous** les dépôts, peuplée depuis le seul magasin d'état partagé — les
features de projet (`projects`), les features de lot (`lots`), les runs hors lot
(`running`) et les vingt clôtures les plus récentes (`history`, même borne que
`/pipelines`). Elle ne fait qu'afficher : aucune API d'écriture n'est appelée, un
propriétaire mort n'est ni déplacé vers `history/` ni retiré (à la différence du
panneau `/pipelines`, qui réconcilie). Elle **n'écrit rien** : les gestes offerts
depuis une carte passent par la couche `Actions/` (voir « Agir depuis Pipelines »),
jamais par le tableau lui-même.

### Les cinq voies

Les onze colonnes de l'ardoise (`KanbanColumn`, parité avec `/pipelines`) restent
le modèle, mais l'écran les regroupe en **voies** (`KanbanLane`) qui suivent le
cours d'une feature, de même largeur, sur toute la largeur de la fenêtre (elles
ne défilent horizontalement que sous 240 pt par voie) :

| Voie (`kanban.lane.<rawValue>`) | Colonnes |
|---|---|
| Pas commencées (`pas-commencees`) | `en-attente` |
| En cours (`en-cours`) | `en-cours`, et toute carte que « Reprendre » peut relancer (en pause) |
| À vous (`a-vous`) | `question-en-vol`, `jalon-specs`, `jalon-review` |
| Livrées (`livrees`) | `pr-ouverte`, `fusionne`, `terminee-sans-pr` |
| Arrêtées (`arretees`, montrée seulement si elle a des cartes) | `echec`, `bloquee`, `annulee-retiree` |

Dans une voie, les cartes suivent l'ordre des colonnes (question, puis specs, puis
revue), puis l'ordre de l'ardoise. Une voie vide le dit en une phrase.

Une carte montre son titre (sans le préfixe « dépôt/ » des runs hors lot), son
dépôt (seulement quand l'ardoise mêle plusieurs dépôts), ses deux **modèles**
(`req+specs <A>` puis `impl+review <B>`, la valeur ou `défaut OMP`, une ligne par
groupe renseigné, coupées au milieu), un badge quand la voie ne
dit pas déjà son état (« Question », « Specs à valider », « En pause », « PR
ouverte »…), la question de l'agent en aperçu, puis — pour une feature en cours ou
qui vous attend — sa barre d'avancement en cinq segments, son étape et sa durée à
la minute. Les cartes sont des surfaces opaques (`consoleCard`), jamais du verre.

### Les messages d'état

| Situation | Message |
|---|---|
| aucun instantané reçu encore | `Chargement des pipelines…` |
| la racine `<stateDir>` n'existe pas, ou aucune carte ni anomalie | `Aucune pipeline pour l'instant.` |

L'emplacement du magasin est un détail technique : il n'est jamais affiché.

Un magasin qui ne contient que des fichiers illisibles rend le **tableau** (voies
vides + bouton « n problème(s) », au vrai pluriel), jamais « vide » : les anomalies
ne sont jamais tues. Le bouton `kanban.diagnosticButton` de la barre d'outils
ouvre une bulle « Problèmes détectés » (`kanban.diagnostic`) qui les dit en
phrases (« cache-sessions s'est arrêtée de façon inattendue. ») ; le fichier et le
pid ne sont que dans son pli **Détails techniques**, replié par défaut. Le bouton
« Activité » (`kanban.activityButton`) ouvre le journal des gestes dans une bulle.
La section n'a plus de barre basse.

### La feuille de détail

L'inspecteur latéral a été retiré (refusé à la recette) : le tableau prend toute la
largeur. Double-clic sur une carte, `↩` sur la carte sélectionnée ou le menu
contextuel « Afficher les détails » ouvrent une **feuille** qui décrit la carte :
en-tête (titre, « dépôt · étape », badge d'état), une **frise d'avancement**
(Besoins, Specs, Implémentation, Revue, PR — fait, en cours, à venir ou en échec,
`PipelineProgress`), **Action** (la zone d'action, voir « Agir depuis Pipelines » —
elle porte aussi « Lire le contrat » quand la carte attend un besoin ou des specs à
valider : depuis cette feuille, le geste ferme d'abord le détail, puis la feuille
**Contrat** s'ouvre), **Informations** (étape, durée, les deux modèles `req+specs` /
`impl+review` avec un bouton **Modifier…**, lien de PR) et un pli **Détails
techniques** replié. En bas : « Arrêter… » (destructif, confirmé) à gauche,
« Fermer » (Échap) à droite. Le menu contextuel d'une carte expose aussi ses
gestes (Afficher les détails, Lire le contrat, **Modifier les modèles…**, Répondre…,
Valider les specs, Accepter la revue, Reprendre, Ouvrir la PR, Arrêter…). Le bouton
**Modifier…** et l'entrée « Modifier les modèles… » ouvrent la feuille
d'édition `models.sheet` (titre `Modèles de <slug>`, les deux sélecteurs
pré-positionnés sur les valeurs courantes, `Annuler` / `Appliquer`).

### Identifiants d'accessibilité

| Identifiant | Surface |
|---|---|
| `kanban.board` | la zone des **voies** (focus clavier et flèches) |
| `kanban.lane.<rawValue>` | une voie |
| `kanban.card.<id>` | une carte (`feature:<clé>:<slug>`, `project:<clé>:<slug>`, `run:<id>`, `history:<id>`) |
| `kanban.activityButton` | le bouton « Activité » de la barre d'outils |
| `kanban.diagnosticButton` | le bouton « n problème(s) » de la barre d'outils (absent sans anomalie) |
| `kanban.diagnostic` | la bulle « Problèmes détectés » |
| `kanban.anomaly.<i>` | une ligne d'anomalie dans la bulle |
| `kanban.diagnostic.technical` | le pli « Détails techniques » de la bulle |
| `kanban.detail` | la feuille de détail (carte sélectionnée) |
| `kanban.detail.close` | le bouton « Fermer » de la feuille |
| `kanban.detail.technical` | le pli « Détails techniques » de la feuille |
| `kanban.empty` | le message « Aucune pipeline pour l'instant. » |
| `kanban.loading` | le message de chargement |

Clavier : les flèches `↓`/`↑` (carte suivante/précédente, d'une voie à la
suivante) et `→`/`←` (première carte de la voie suivante/précédente non vide) sont
attachées à la **zone des voies** (`kanban.board`), comme `↩` qui ouvre la feuille
de détail. Clic simple sur une carte : sélection (contour à la couleur
d'accentuation). Sélectionner une carte ne change **jamais** de section : la barre
latérale reste sur Pipelines, et Sessions, Fichiers et Projet gardent leur propre
contenu.

### Parité avec `/pipelines`

Sur le même magasin, toute entité lue par `/pipelines` a sa carte au même état :

| `/pipelines` | Tableau Kanban |
|---|---|
| rang de feature du lot | carte `feature:<clé>:<slug>`, dans la colonne de son état |
| rang `running` non apparié | carte `run:<id>` |
| rang `history` (20 plus récents) | carte `history:<id>` |
| run apparié à une feature | **fusionné** : une feature = une carte |
| colonne de droite `/phase · état · temps` | étape, état et durée de la feuille de détail |
| rang `PR : <url>` (feature `done`) | lien « Ouvrir la PR » de la feuille de détail |
| en-tête « pilote : … mort » | marque `mort` + ligne du diagnostic |
| avis « N fichier(s) d'état illisible(s) » | une ligne du diagnostic par fichier |

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
4. après avoir déposé un fichier tronqué dans le magasin, presser
   `kanban.diagnosticButton` et relever `kanban.anomaly.<i>` dans `kanban.diagnostic`.

Le magasin jetable est **obligatoire** : la recette ne touche jamais
`~/.omp/agent/pipeline` de la machine.

### Recette : parité avec `/pipelines`

Sur le **même** magasin, ouvrir `/pipelines` dans une session OMP puis comparer rang
par rang selon la table ci-dessus (dépôt, entités, colonnes, anomalies). Pour un
propriétaire mort, laisser `/pipelines` réconcilier d'abord : le tableau voit alors
l'entrée d'historique et la parité tient. Consigner les relevés dans la section
`## Revue` du contrat.

## Agir depuis Pipelines

`Sources/OMPConsole/Actions/` est la **seule** couche qui écrit depuis l'app. Elle
n'écrit jamais l'état du lot : ses écritures sont les livraisons d'un run
(`<stateDir>/inbox/<boîte>/`) et les commandes **postées** au service
(`POST /v1/repos/{repo}/commands`). Tout geste est tracé dans le pli **Activité
récente** en bas de la section (une ligne par geste : symbole d'état, libellé,
heure) : l'accusé affiché est celui de la **réponse** du service — `state:"taken"`
(prise en charge) ou `state:"refused"` avec son motif, affiché verbatim. Aucun
fichier d'accusé, aucune relecture périodique. « Reprendre » poste
`POST /v1/repos/{repo}/pilot`.

| Geste | Où | Écrit |
|---|---|---|
| Répondre à une question de l'agent (option ou texte libre) | section « Action » de la feuille de détail, menu contextuel « Répondre… » de la carte, ou feuille « Répondre » de l'Accueil | une livraison `ask` dans la boîte publiée du run |
| Envoyer un message à l'agent (exécution vivante sans question) | section « Action » de la feuille de détail | une livraison `text` dans la boîte publiée du run |
| Valider les specs | feuille de détail, menu contextuel ou carte « À vous » de l'Accueil (feature en attente specs) | `POST /v1/repos/{repo}/commands` — `{kind:"verdict", verdict:"v"}` |
| Lire le contrat (besoin ou specs à valider) | carte « À vous » de l'Accueil (secondaire), zone d'action de la feuille de détail, menu contextuel de la carte | rien : la console lit `<worktree>/.omp/pipeline/contract.md` et ouvre la feuille Contrat |
| Accepter la revue | feuille de détail, menu contextuel ou carte « À vous » (feature en attente revue) | `POST /v1/repos/{repo}/commands` — `{kind:"verdict", verdict:"y"}` |
| Répondre à une question en texte d'un maillon terminé | feuille de détail ou feuille « Répondre » (feature en attente de réponse, sans question en vol) | `POST /v1/repos/{repo}/commands` — `{kind:"reply", slug, text}` |
| Reprendre | feuille de détail, menu contextuel ou ligne « En cours » de l'Accueil (carte marquée `mort`, feature vivante) | rien de plus : `POST /v1/repos/{repo}/pilot` réveille le conducteur du service |
| Arrêter… | feuille de détail ou menu contextuel (carte portant un lot), après confirmation | `POST /v1/repos/{repo}/commands` — `{kind:"stop", repo}` |
| Lancer une feature | feuille « Nouvelle feature » (barre d'outils, ⌘N) | `POST /v1/repos/{repo}/commands` — `{kind:"launch", title, description, repo}` |

Règles d'aiguillage : une carte qui porte une **question en vol** offre la réponse
(option **ou** texte libre, jamais les deux ensemble) ; un run vivant **sans**
question offre l'envoi de texte ; une carte qui n'offre rien dit pourquoi (run non
armé, ou aucun geste possible). Le dépôt de la feuille de lancement est **choisi**
parmi les dépôts connus des cartes, le projet ouvert et un dossier choisi à la main
(racine git seulement) ; le slug est dérivé par le dépôt, jamais par l'app.

Deux invariants durables de cette couche :

- **Boîte confinée** : une livraison n'est publiée que dans `<stateDir>/inbox/` ou
  sous lui. Un chemin hors zone — chemin absolu ailleurs, traversée `..`, lien
  symbolique sortant, préfixe de nom (`<stateDir>/inbox-2`) — est refusé AVANT toute
  création : ni dossier ni fichier, et le journal des gestes porte
  `chemin refusé (<chemin>) : hors de <stateDir>/inbox`. La lecture, elle, ne juge
  pas : l'entrée du run reste visible avec son `inbox` tel quel.
- **Publication exclusive** : le contenu est écrit dans un temporaire créé en
  `O_EXCL`, puis publié par `link(2)` — un nom déjà pris reçoit le nom suivant
  (jamais d'écrasement), un lecteur ne voit jamais un fichier partiel, et un `EINTR`
  est retenté.

### Identifiants d'accessibilité de l'action

| Identifiant | Surface |
|---|---|
| `kanban.actions` | la zone d'action (section « Action » de la feuille de détail) |
| `kanban.actions.motif` | le motif quand la carte n'offre aucun geste |
| `kanban.actions.option.<i>` | une option de la question en vol |
| `kanban.actions.answerField`, `.answer` | le champ libre et le bouton « Répondre » |
| `kanban.actions.steerField`, `.send` | le champ et le bouton d'envoi de texte |
| `kanban.actions.reply.prompt`, `.reply.text`, `.reply.submit` | la question en texte, son champ et « Répondre » |
| `kanban.actions.validate`, `.accept` | les boutons de jalon |
| `kanban.actions.resume` | le bouton « Reprendre » |
| `kanban.actions.stop` | le bouton « Arrêter… » (confirmation avant l'arrêt) |
| `kanban.actions.contract` | le bouton « Lire le contrat » (carte attendant un besoin ou des specs à valider) |
| `kanban.actions.editModels` | le bouton « Modifier… » d'un modèle et l'entrée « Modifier les modèles… » du menu contextuel |
| `kanban.journal`, `kanban.journal.empty` | la bulle « Activité » |

### Recette : agir depuis la carte

Même bundle et même magasin jetable que la recette de vivacité (une sonde AX
jetable : `AXUIElementCreateApplication(pid)` + parcours de `kAXChildrenAttribute`,
plus des clics et des frappes réels par `CGEvent`).

1. ouvrir la feuille de détail d'une carte de feature en attente specs (double
   clic, ou clic puis `↩`) ⇒ la zone d'action expose `kanban.actions`,
   `kanban.actions.validate`, `kanban.actions.option.<i>`, `kanban.actions.answer`,
   `kanban.actions.answerField`, et le pied de la feuille `kanban.actions.stop` ;
2. cliquer « Valider les specs » ⇒ **un** fichier apparaît dans
   `<magasin>/commands/` (`{"version":1,"id":"console-…","repo":"…","kind":"verdict",
   "slug":"…","verdict":"v","sentAt":…}`) et, bulle « Activité » ouverte,
   `kanban.journal.empty` disparaît de l'arbre (une ligne s'est ajoutée au journal) ;
3. focaliser `kanban.actions.answerField`, y saisir un texte et presser `→` puis
   `←` ⇒ la sélection du champ passe de `(0,0)` à `(1,0)` puis revient à `(0,0)`
   alors que `kanban.actions.validate` reste présent : la voie n'a pas bougé (le
   tableau garde ses flèches hors des champs) ;
4. déplacer la sélection au clavier jusqu'à une carte de run sans boîte ⇒
   `kanban.actions.motif` porte le texte du run non armé.

Le magasin jetable est **obligatoire** : la recette ne touche jamais
`~/.omp/agent/pipeline` de la machine.

## Lire les fichiers et les diffs d'une cible

La section **Fichiers** est une visionneuse **strictement en lecture** de l'arbre
d'une cible git — le dépôt principal ou l'un des worktrees `feat/*` connus, une
seule cible à la fois.

1. **Choisir la cible** — le sélecteur « Cible » de l'en-tête. La cible par défaut
   est celle du projet ouvert (la préférence partagée `session.projectRoot` avec la
   section « Session OMP ») ; à défaut, le dépôt principal. Chaque cible affiche sa
   base de comparaison : `HEAD` pour le principal, ou `base <sha7>` — la base
   enregistrée de la feature dans le magasin d'état, à défaut la base de fusion avec
   la branche par défaut du principal.
2. **Parcourir l'arbre** — colonne de gauche : fichiers **suivis** et **non suivis**
   de la cible, `.gitignore` appliqué. Un fichier suivi supprimé sur disque y reste,
   avec le badge « supprimé » ; un fichier ignoré par git (le contrat de la
   pipeline, par exemple) n'y figure jamais.
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
4. **Les deux documents de pilotage, hors arbre** — les boutons **Contrat**
   (`.omp/pipeline/contract.md` de la cible active, que git ignore donc qui ne peut
   pas figurer dans l'arbre) et **PROJECT.md** (à la racine de la cible). Absents,
   ils l'annoncent au lieu d'afficher un contenu vide ou celui d'une autre cible.
5. **Suivre les changements** — la cible active est surveillée par **FSEvents** (un
   seul descripteur récursif sur sa racine) : un fichier ajouté ou modifié met
   l'arbre et le document à jour sans geste, au plus un rechargement par 300 ms
   d'accalmie. Pas de scrutation périodique. **⌘R** (ou « Rafraîchir ») force un
   rechargement immédiat.

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
échéance de commande `git` ou `gh` escalade désormais `SIGTERM` → 2 s de grâce →
`SIGKILL` par l'exécuteur partagé `ProcessRunner`, et l'appel ne rend la main
qu'une fois l'enfant mort et récolté.

Les gestes à l'écran (choisir une cible dans le sélecteur, déplier l'arbre, voir le
diff coloré, ⌘R) restent une **vérification manuelle du poste** : dans un shell de
pipeline sans session d'affichage, le bundle se lance et son état est vivant —
l'application est bien au premier plan (`OMP Console` dans la barre de menus) et son
arbre d'accessibilité expose sa fenêtre et ses cinq sections — mais la fenêtre
n'est peinte sur aucun écran, donc une capture d'écran ne la montre pas.
fichiers, projet) consommeront ces flux dans les features suivantes : aucune n'est
branchée ici.
## Visionneuse de session

La section **Sessions** de la barre latérale liste les runs du magasin d'état
**par jour** (« Aujourd'hui », « Hier », puis la date), le plus récent en tête
(`SessionDays`) : chaque ligne porte le symbole de l'étape, le titre de la feature,
« <dépôt> · <étape> », l'heure de début et l'état en un mot (« En cours », « À
vous », « Interrompu », « Terminé », « Échec ») ; double-clic, `↩` ou « Ouvrir »
du menu contextuel pousse la **conversation de la session de ce run** dans la
section (bouton retour pour revenir à la liste). Sans run : « Aucune session »
(`viewer.selector.empty`) ; des entrées écartées à la lecture sont comptées en
pied de liste (`viewer.selector.footer`).

- **Une session à la fois, dans la fenêtre principale.** En ouvrir une autre
  remplace la première ; changer de section garde la session ouverte
  (`ConsoleModel.sessionsPath`). Le titre de la fenêtre est le nom de la
  feature, son sous-titre « <étape> · <dépôt> ».
- **Une conversation, comme dans Messages** (`ConversationThread`, partagé avec la
  section Session OMP) : les messages de l'utilisateur en bulles à droite, les
  réponses de l'agent en texte pleine largeur (Markdown complet rendu : titres,
  listes, blocs de code colorés, tableaux — `MarkdownBlocksView`), la
  réflexion dans un pli « Réflexion », les marqueurs « Contexte compacté » /
  « Résumé de branche » en séparateurs cliquables. Tout fait du fichier y est, une
  fois, dans l'ordre du fichier.
- **Chaque appel d'outil se plie et se déplie individuellement** (replié par
  défaut ; un appel `ask` entre déplié). Son en-tête le nomme par un verbe
  (« Lecture », « Modification », « Commande »… ; un outil inconnu garde son nom)
  suivi de sa cible, et un statut : sablier (en attente), coche verte (terminé),
  croix rouge (erreur). Déplié, il montre arguments, résultat et diff dans un bloc
  opaque ; les longues lignes défilent en largeur, le fil seulement en hauteur.
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
  Un geste vers le haut suspend le suivi — le mot `viewer.status` « En direct »
  disparaît et le bouton **« Revenir au direct »** apparaît ; l'activer reprend le
  suivi.
- **États explicites** : « En attente des premiers échanges » tant que le fichier
  n'existe pas, un bandeau rouge « Session illisible : … Nouvelle tentative
  automatique. » (`viewer.unreadable`) s'il n'est pas lisible, « Session vide » s'il
  est vide (`viewer.placeholder`). Sous le fil, `viewer.notes` dit le nombre
  d'entrées ignorées et « Fichier réécrit — affichage reconstruit » le cas échéant.
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
   `git -C <cible> rev-parse --abbrev-ref HEAD` / au sha enregistré de la feature
   (le catalogue liste le principal et les worktrees `feat/*` du poste) ;
2. l'arbre contient les fichiers suivis ET non suivis, à leur chemin relatif, et
   aucun fichier ignoré (le contrat, un répertoire `build/`) ;
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
`Package.swift`, `omp-console/Bundle/` ou `mem0-stack/mem0-http/` (embarqué dans
le bundle). Un pull qui ne touche que les tests, la documentation ou le reste du
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
`PATH`, ni `~/.bun/bin`, ni `/opt/homebrew/bin`, ni `/usr/local/bin` pour `omp`
et podman (S-1, S-4) :

| Quoi | Où | Version |
|---|---|---|
| binaire `omp` (binaire autonome GitHub, aucun `bun` requis) | `~/Library/Application Support/com.omp.console/components/omp/18.6.0/omp` | 18.6.0 (SHA-256 vérifié avant installation) |
| podman (pkg extrait par `pkgutil --expand-full`, jamais installé) | `…/components/podman/6.1.3/{bin,lib,share}` | 6.1.3 |
| configuration XDG de la machine podman | `…/config/` (`XDG_CONFIG_HOME`) | |
| disque et cache de la machine podman | `…/data/` (`XDG_DATA_HOME`) | |
| pile mémoire | `…/stack/` (`qdrant_storage/`, `env`, `machine.json`, `migration.json`) | |

- **Badge du coin inférieur gauche** — le pied de la barre latérale porte l'état
  des composants embarqués (identifiant AX `components.badge`) : « Tout est
  installé » (point vert), ou « OMP manquant », « Podman manquant », « OMP et
  Podman manquants » (point orange). La présence se lit par le MÊME prédicat que
  l'installateur — le binaire existe, est exécutable et n'est pas un dossier —
  jamais l'état de marche : aucune version n'est exécutée. Deux veilles de
  fichier (`FileWatcher`, jamais de scrutation) le recalculent sans redémarrer
  l'app, et un changement de permission suffit ; il n'est ni cliquable ni
  focusable, et replier la barre latérale le masque avec elle.
- **Manifeste** — versions, URL et empreintes sont figées dans
  `ComponentManifest.current` (`Setup/ComponentManifest.swift`). L'installation
  est idempotente (un composant présent à la bonne version n'est ni retéléchargé
  ni réinstallé), vérifie le SHA-256 AVANT de déplacer, puis `omp --version` /
  `bin/podman --version` APRÈS ; après succès, les autres versions sous
  `components/omp/` et `components/podman/` sont purgées. Rien n'est écrit de
  façon non atomique.
- **Machine podman dédiée** — `omp-console`, image
  `docker://quay.io/podman/machine-os:6.1`, 4 CPU, 4 Gio, 50 Gio de disque, avec
  `helper_binaries_dir` pointé sur les `bin/` du composant ; sa configuration et
  son disque vivent sous la racine de l'app, donc elle ne voit jamais une machine
  podman système.
- **Conteneurs** — réseau `omp-console-stack`, `omp-console-qdrant`
  (`qdrant/qdrant:v1.19.0`, ports `127.0.0.1:6333/6334`) et
  `omp-console-mem0-http` (image construite depuis le contexte embarqué
  `Contents/Resources/Stack/mem0-http`, port `127.0.0.1:8321`), tous deux
  `--restart unless-stopped`.
- **Migration** (une fois par racine) — l'app découvre l'ancienne pile par l'API
  Docker sur socket Unix (`~/.docker/run/docker.sock`, puis
  `/var/run/docker.sock`), l'arrête (`mem0-qdrant`, `mem0-http`), copie
  `qdrant_storage` (la source reste INTACTE, une base déjà présente n'est JAMAIS
  recouverte), importe le `.env` voisin dans `stack/env` (0600) et écrit
  `stack/migration.json` (informatif).
- **`stack/env`** — mêmes clés que `mem0-stack/.env` : `QDRANT_API_KEY`,
  `MEM0_HTTP_TOKEN`, `OMLX_BASE_URL`, `OMLX_API_TOKEN`, `OMLX_LLM_MODEL`,
  `OMLX_EMBED_MODEL`, `EMBEDDING_DIMS`. Sans fichier, les défauts de
  `mem0-stack/.env.example` s'appliquent.
- **Échappatoires de test** — `OMP_CONSOLE_SUPPORT_ROOT` déplace TOUTE la racine
  (composants ET état) ; `OMP_CONSOLE_OMP_BINARY` force le binaire `omp` et
  devient alors le seul candidat (les recettes s'en servent).

### Recettes gatées de la préparation

Aucune n'est posée par `scripts/swift-app.sh` ni par la CI (elles sont
« skipped ») ; chacune échoue explicitement si son prérequis manque, jamais en
silence. Depuis `omp-console/` :

```bash
# Composants : télécharge omp et podman dans une racine temporaire, exécute leurs --version
MEM0_COMPONENTS_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter recetteReelleInstalleLesDeuxComposants -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

# Pile : machine omp-console + conteneurs + /health, sur une racine de support
MEM0_STACK_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter recetteReelleDeLaPile -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

# Migration : arrête réellement l'ancienne pile, copie dans une racine temporaire
MEM0_MIGRATION_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter recetteMigrationArreteEtCopieLAncienneBase -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"

# Session composant + run terminal : une session servie vit sur le composant de
# l'app, puis un `omp -p` au terminal (sans l'app) dont la session porte un message mem0-recall
MEM0_SESSION_COMPONENT_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter "sessionRunsOnTheAppComponent|terminalRunRecallsMemoryWithoutTheApp" \
  -Xswiftc -plugin-path -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

### Preuves manuelles (AC-3, AC-5)

- **AC-3 — l'app n'utilise aucun binaire système** : renommez l'`omp` du système
  (`mv ~/.bun/bin/omp ~/.bun/bin/omp.bak` — sans toucher à la racine de l'app),
  ouvrez l'app et chargez le catalogue de modèles (feuille « Nouvelle feature ») :
  il est lu par le composant de l'app (`…/com.omp.console/components/omp/18.6.0/omp`),
  et l'app ne lance **aucun** process pour les sessions (elles sont servies par le
  service). Le renommage est réversible, et la suppression du composant seul
  provoque la réinstallation par « Réessayer ».
- **AC-5 — la pile survit à l'app** : quittez l'app (⌘Q), puis, dans un terminal
  sur un dépôt : `omp -p "résume ce dépôt"`. Le run reçoit le rappel mémoire du
  plugin (`mem0-recall` dans son fichier de session) parce que la pile de l'app
  tourne toujours en arrière-plan.

## Piloter le service

La section **Session OMP** (⌘4, ou Fichier ▸ « Nouvelle session OMP » ⌥⌘N) ne
lance **aucun** process `omp` : elle est **cliente** d'une API REST locale servie
par le service. Elle pilote **une seule** session à la fois (le modèle est à
instance unique et refuse un second lancement).

1. **Localiser le service** — l'app lit `~/.omp/agent/pipeline/service.json` (ou
   `MEM0_PIPELINE_STATE_DIR`) : `version=1`, `pid`, `port`, `token` (32
   hexadécimaux), `stateDir`. Le pid doit vivre ; un enregistrement absent,
   illisible, hors schéma ou au pid mort n'est jamais deviné — la fenêtre affiche
   « service arrêté » et un bouton **Réessayer**, et l'app ne lance aucun process.
2. **Choisir le projet** — bouton « Choisir un dossier… » (⌘O). Le dossier choisi
   devient le `cwd` de la session ; il est mémorisé, et il n'est jamais réécrit
   sans un geste de votre part.
3. **Lancer la session** (⌘R) : l'app crée la session par
   `POST /v1/sessions {cwd, purpose:"session"}` puis s'abonne à son flux
   `GET /v1/sessions/{id}/events` (SSE). Écrire dans le composeur du bas (↩ ou le
   bouton ↑) poste `POST /v1/sessions/{id}/prompt {text}` et **lit la
   conversation** : le fichier de session publié par le service est suivi et rendu
   par le même fil que la Visionneuse (bulles, verbes d'outil, statut en mots). Une
   question de l'hôte arrive par le flux et s'ouvre en feuille « OMP vous demande » :
   la réponse part par `POST /v1/sessions/{id}/dialogs/{dialogId}` (⌘. ou Échap
   l'annulent).
4. **Arrêter la session** (⌘.) ou quitter l'app : l'app ferme la session par
   `DELETE /v1/sessions/{id}` et le flux SSE s'arrête. Il n'en reste aucun process
   dans l'app, et le fichier de session `.jsonl` reste sur disque, résumable.

La fenêtre dit son état en mots, dans son sous-titre (« <projet> · Prête »,
« Démarrage… », « Active », « Arrêt… », « Arrêtée », « Interrompue », « Échec ») et
par son contenu : « Aucune session » sans projet, « Prête à démarrer », le
démarrage, « La session n'a pas démarré » avec le motif, puis la conversation ;
une session morte garde sa conversation sous un bandeau « La session s'est
arrêtée. Relancez-la pour reprendre la conversation. » (**Relancer** ouvre une
nouvelle session sur le même `.jsonl`). Les détails techniques vivent dans
l'inspecteur « Détails techniques » (`session.details`), en formulaire groupé :
**Session** (projet, état, pid du service, identifiant de session, statut détaillé)
et **Journal** (les messages absorbés par l'app : ouverture de session, coupures,
erreurs). Aucune trame de protocole brute n'est affichée. Un prompt n'est jamais
relancé tout seul après une mort : la relance est un clic.

L'écriture d'un prompt passe par le service (`POST /v1/sessions/{id}/prompt`) : un
service injoignable échoue proprement, la fenêtre affiche « service arrêté » et
l'état de la session reste celui du flux SSE ; une coupure du flux est retentée
avec un repli borné avant de marquer la session morte et d'offrir **Relancer**.

### Le binaire `omp` de l'app

L'app n'utilise qu'UN SEUL binaire `omp` pour ses propres besoins, le composant
qu'elle a installé (`…/components/omp/18.6.0/omp`, S-4) : il sert à la préparation
des composants et au catalogue `omp models --json` — **jamais** aux sessions, que
le service possède. `PATH`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` et
l'ancienne préférence `omp.chosenPath` ne sont plus consultés pour ce binaire : la
feuille « OMP est requis » n'existe plus (la préparation la remplace). Le bouton
« Lancer omp » du terminal, lui, tape `omp` dans le shell, qui le résout par son
`PATH` complété (voir « Section Terminal »).

- **`OMP_CONSOLE_OMP_BINARY`** (échappatoire de test) — posée et non vide, c'est le
  SEUL candidat ; utile aux recettes pour pointer un `omp` de secours ou simuler un
  poste sans composant.
- Si le composant est absent ou non exécutable, l'Accueil montre sa préparation et
  « Réessayer » le réinstalle ; `omp models --json` retombe alors sur l'option
  « défaut OMP (aucun modèle) ».

## Section Terminal (terminal intégré)

La section **Terminal** (⌘5) héberge **un seul programme** dans un vrai PTY (le
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
3. **Lancer omp** (`terminal.launchOmp`, actif tant qu'un shell vit) tape `omp↩`
   dans le shell ; la frappe part ensuite dans `omp` (flèches, Entrée, Tab, Échap,
   Ctrl-C, Ctrl-D), l'affichage est celui du TUI — couleurs vraies, curseur, plein
   écran — et suit le redimensionnement de la fenêtre.
4. **Fermer la fenêtre principale** (bouton rouge, ⌘W) : le process est tué avec
   **tout son groupe** (SIGTERM, puis SIGKILL après 2 s), sans confirmation.
   **⌘Q** tue de la même façon les terminaux vivants : aucun shell ni `omp` ne
   survit à la fermeture de l'app.

Le terminal et la section **Session OMP** (session servie par l'API locale) vivent
**en même temps**, sans exclusivité : ouvrir l'un ne perturbe pas l'autre, dans les
deux sens, et ils peuvent même viser le même répertoire.

États affichés : « Choisissez un répertoire… », « Lecture des worktrees… » (feuille
ouverte), « Lancement du shell… », « shell vivant (pid <n>) · <cible> », « Le shell
s'est terminé (code|signal <n>). » avec le bouton **Relancer**, et l'erreur
explicite en cas d'échec (« Exécutable introuvable : … », « Répertoire
introuvable : … », « PTY indisponible (<errno>) : aucun process lancé. »). Aucun
état n'est un
rectangle vide.

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
3. « Lancer omp » ; vérifier `pgrep -fl -P <pid de l'app>` : un seul shell, enfant
   direct, et `omp` enfant du shell ;
4. taper un prompt dans la fenêtre : la TUI y répond ; **Ctrl-C** interrompt `omp`
   et l'app reste vivante ;
5. redimensionner la fenêtre : la TUI se réaffiche à la nouvelle taille ;
6. fermer la fenêtre : `pgrep -fl -P <pid de l'app>` ne rend plus rien ;
7. relancer l'app, ouvrir un terminal, puis **⌘Q** : aucun shell ni `omp` ne survit.

## Section Projet (pilotage)

Menu **Fichier ▸ « Piloter un projet… »** (⇧⌘N) — ou le bouton du même nom dans
la section **Projet** — sélectionne la section et présente la feuille de choix ;
le nom du projet est le sous-titre de la fenêtre. La section héberge le pilotage
d'un projet par le pilote `/project` de l'extension : **un seul projet piloté à
la fois** (un second démarrage est refusé jusqu'à l'arrêt du pilotage en cours).

1. **Choisir le dépôt et le nom** dans la feuille (dossier par `NSOpenPanel`,
   dossiers seulement, nom par défaut = dernier composant du chemin).
2. **Piloter** — l'app poste `POST /v1/projects/{repo}/conduite {name}` : le
   service crée la session `purpose:"project"`, lui envoie `/project <nom>` et
   l'adopte. Aucun terminal n'est ouvert, aucune commande n'est tapée. Le refus —
   dépôt non git, sans distant GitHub — est un **409** dont le texte exact
   (`reason`) s'affiche tel quel ; l'app refuse aussi en amont un second pilotage
   tant que SA fenêtre porte une conduite. Une conduite **déjà vivante** pour ce
   dépôt (le service l'a reprise tout seul après un redémarrage) n'est pas un
   refus : l'app lit `GET /v1/sessions`, s'y rattache et retrouve ses questions en
   attente — l'instantané du flux les rejoue.
3. **Jouer l'utilisateur** — la saisie libre de la fenêtre poste un `prompt` au
   service (`POST /v1/sessions/{id}/prompt`, ↩ ou ⌘↩), et toute demande adressée à
   l'utilisateur (cadrage, validation du plan, escalade de lot) arrive par le flux
   de la session `purpose:"project"` comme un dialogue répondable : `select` (liste
   d'options), `input`/`editor` (texte, avec le `prefill` du plan pour un `editor`),
   `confirm` — la réponse part par `POST /v1/sessions/{id}/dialogs/{dialogId}`. La
   feuille de dialogue affiche « Question n sur m » quand la question se termine par
   « (n/m) ».
4. **Suivre** — le volet **Plan** re-présente le JSON du magasin (segments, état
   de chaque feature, modèle, lien de la PR quand elle existe), et le volet
   **Document** rend `PROJECT.md` avec le rendu Markdown commun de l'app (vrais
   tableaux). Les deux se rafraîchissent sans action : le JSON par la veille du
   magasin, le document par une veille de fichier. La dernière notification du
   pilote (`notify`) s'affiche sous l'en-tête, décodée et rendue en Markdown —
   jamais la trame JSON brute.
5. **Alerter** — quand le projet attend une réponse et que la fenêtre n'est pas au
   premier plan, l'app émet **une** demande d'attention critique (`NSApp`) ; à la
   fin du projet (toutes les features du dernier segment fusionnées ou retirées),
   une demande informative unique. Aucune notification macOS, aucun vol de focus.
6. **Arrêter** — bouton **Arrêter le pilotage**, après confirmation : l'app poste
   `DELETE /v1/projects/{repo}/conduite` et le service ferme la session. Le projet
   reste `running` côté pilote ; la reprise éventuelle est le fait du pilote au
   prochain `/project`. Fermer l'app (⌘Q, bouton rouge) n'envoie **rien** : l'app
   se détache, la conduite reste vivante dans le service, ses segments avancent et
   sa question en attente attend la réouverture.

**Ce que l'app n'écrit jamais** : ni `<stateDir>/projects/<clé>.json`, ni le
worktree `.doc`, ni le lot. Elle ne réimplémente non plus aucune règle du pilote
(plan, segments, jalons, PR) : elle affiche ce que le magasin porte et renvoie les
réponses dans la session `purpose:"project"` (`POST /v1/sessions/{id}/dialogs/{dialogId}`).

Aucune reprise automatique : relancer l'app n'ouvre **aucune** session et n'arme
**aucun** `/project` ; c'est toujours un geste de l'utilisateur.

### PR et CI du projet

Le volet **PR et CI** de la vue **Projet** affiche les PR ouvertes par le projet
conduit — une ligne par feature au statut « PR ouverte » portant une `prUrl`, dans
l'ordre du plan.

- **Les trois statuts requis** — `check (ubuntu-latest)`, `check (macos-latest)`,
  `release-simulation` — sont toujours affichés, chacun avec son état (vert / rouge /
  en cours / ignoré). Un statut rouge affiche le lien « Voir l'échec » vers le
  journal de son exécution.
- **Rafraîchissement automatique** : tant que le volet est visible, l'app relit `gh`
  une première fois puis toutes les 60 s, sans aucun geste de l'utilisateur ; une
  lecture en échec marque la ligne « (périmé) » et affiche « Statuts indisponibles : … »
  jusqu'à la première relecture réussie.
- **Ouvrir la PR** ouvre l'URL de la ligne dans le navigateur par défaut.
- **Fusionner…** n'est disponible que si les trois statuts requis sont verts. Le clic
  relit la PR, puis demande une confirmation qui nomme la PR (numéro et titre) ; la
  fusion est un **squash** borné à la tête relue (`--match-head-commit`).
- **Adresse refusée** : seules les adresses `https://github.com/<propriétaire>/<dépôt>/pull/<numéro>`
  sont employées — hôte `github.com` exact (casse ignorée), numéro entier positif sans zéro
  de tête. Toute autre forme (hôte étranger, `http://`, `/issues/`, espace ou `?` final,
  préfixe `-`) est refusée AVANT tout lancement : `gh` n'est jamais exécuté, et le message
  d'échec existant s'affiche à la place. L'URL passe toujours en argument **positionnel
  derrière `--`**, après toutes les options.
- **Le segment suivant n'est pas lancé par l'app** : c'est le pilote `/project` qui,
  au balayage suivant du relais (≤ 60 s + 2 s), marque la feature `merged` puis passe
  au segment suivant. Le volet **Plan** s'actualise alors sans aucun geste.

L'app n'écrit rien : ni l'état du projet, ni le canal de commande. Elle lit `gh` avec
les candidats d'installation connus (`/opt/homebrew/bin/gh`, `/usr/local/bin/gh`,
`/usr/bin/gh`, ou le chemin imposé par `OMP_CONSOLE_GH_BINARY`), car une app lancée
par le Finder n'hérite pas du `PATH` du shell.

### Recette : suivre les PR et fusionner depuis l'app

Prérequis : un projet conduit dont le segment courant porte une PR (volet **Plan** : au
moins une feature « PR ouverte »).

1. Assembler et lancer le bundle :

   ```bash
   bash scripts/swift-app.sh
   open "omp-console/build/OMP Console.app"
   ```

2. Ouvrir la vue **Projet** : le volet **PR et CI** liste la PR, avec ses trois
   statuts requis et leur état ; un statut rouge affiche « Voir l'échec », lien
   cliquable vers le journal de l'exécution.
3. Cliquer **Ouvrir la PR** : le navigateur par défaut ouvre l'URL de la PR.
4. Attendre que les trois statuts passent verts (le volet se rafraîchit seul, ≤ 60 s
   après la fin de la CI) : **Fusionner…** devient actif.
5. Cliquer **Fusionner…** : l'alerte nomme la PR (numéro et titre) ; confirmer par
   **Fusionner**. L'alerte disparaît et les statuts se relisent.
6. Constater l'état fusionné :

   ```bash
   gh pr view <url> --json state
   ```

7. Laisser passer ≤ 60 s + 2 s : le pilote marque la feature `merged`, la ligne
   disparaît du volet **PR et CI** et le volet **Plan** passe le segment suivant
   « en cours » — sans autre geste.

Consigner dans la section `## Revue` du contrat le numéro de PR, le sha de fusion et
l'horodatage du passage au segment suivant.

### Recette : conduire un projet depuis l'app

1. Supprimer l'état restauré des fenêtres **avant** de lancer le bundle, pour
   partir d'une app fraîche :

   ```bash
   rm -rf ~/Library/Saved\ Application\ State/com.omp.console.savedState
   ```

2. Assembler et lancer le bundle :

   ```bash
   bash scripts/swift-app.sh
   open "omp-console/build/OMP Console.app"
   ```

3. ⇧⌘N, choisir un dépôt GitHub réel, saisir un nom, « Piloter ».
4. Écrire la description du projet puis « fin » dans la barre de saisie : la
   question suivante (validation du plan) s'affiche comme un dialogue.
5. Choisir « Corriger le plan » : l'éditeur s'ouvre **prérempli** du plan ;
   modifier, « Répondre », vérifier que le pilote redemande une revue.
6. Laisser courir jusqu'à la première PR, puis vérifier dans le volet **Plan** le
   segment, l'état « PR ouverte » et le lien cliquable de la PR, et dans le volet
   **Document** le contenu publié de `PROJECT.md`.
7. Mettre la fenêtre en arrière-plan : un dialogue en attente doit lever une
   demande d'attention (icône de l'app dans le Dock qui rebondit).

## Section Statistiques

Une section **en lecture seule** (⌘9),
qui compte ce que les runs d'un projet ont consommé : tokens d'entrée et de sortie,
durée murale (attente d'une réponse utilisateur comprise) et nombre de tours (un
tour = un cycle complet prompt → réponse finale), par run puis agrégés par feature
et par projet. **Aucun montant en dollars** n'y apparaît — le domaine `Stats` ne
lit jamais `usage.cost`.

Le tableau de bord est celui du **projet affiché** (sélecteur `Projet` de la barre
d'outils, nom du projet en sous-titre) : quatre tuiles (« Tokens envoyés »,
« Tokens reçus », « Temps passé », « Tours ») totalisent le projet ; le graphique
« Tokens par feature » montre, par feature listée, deux barres empilées
(envoyés, reçus) ; le tableau « Runs » liste un run par ligne en sept colonnes
(Feature, Étape, Modèle, Durée, Tours, Tokens, État), triable par un clic sur un
en-tête (re-clic inverse ; sans tri, l'ordre est features puis runs). Une feature
du plan n'est **listée** que si elle porte au moins un run **lisible** ; les autres
sont **masquées** et comptées en pied (`<n> feature(s) du plan sans run lisible`,
absent à 0).

### Les cinq états

| État | Condition | Texte exact | AX |
|---|---|---|---|
| Chargement | aucun instantané reçu | `Chargement des pipelines…` | `stats.state` |
| Magasin absent | racine `.absent` | `Aucune pipeline pour l'instant.` | `stats.state` |
| Aucun projet | racine présente, aucun `projects/*.json` | `Les statistiques apparaîtront dès qu'un projet sera piloté.` | `stats.state` |
| Aucune donnée | projet affiché, features vides | `Aucune donnée pour ce projet` | `stats.empty` |
| Tableau | projet affiché avec ≥ 1 feature listée | voir ci-dessous | — |

Les textes du chargement et du magasin absent sont **repris mot pour mot** de
`KanbanBoardState` (une seule formulation par situation dans l'app).

### Identifiants d'accessibilité

| Élément | Identifiant |
|---|---|
| Sélecteur de projet | `stats.project` |
| Tuiles du projet | `stats.aggregate` |
| Graphique « Tokens par feature » | `stats.chart` |
| Compte des features masquées | `stats.hidden` |
| Feature d'une ligne du tableau | `stats.run.<tag>` (`tag` = `sessionTag(forSessionFile:)`) |

### Forme d'une ligne

Durées et tokens passent par les formateurs de Foundation en français
(`ConsoleFormat` : « 14 min et 12 s », « 1,2 k ») ; une durée inconnue s'écrit
`—`. Un run **illisible** garde sa ligne avec l'état « Illisible », son motif en
infobulle (« session introuvable », « session illisible : <message OS> »), et reste
exclu des sommes.

### Mise à jour en direct

Aucun geste n'est nécessaire : le magasin, la veille du fichier de session de
chaque run **vivant** et l'horloge de rendu (`TimelineView`, une seconde) font
monter seuls les tokens, les tours et les durées. Un run est **vivant** si le pid
de son entrée `running` vit — jamais d'après le badge `isStale` du magasin
(`publishRunning` n'écrit rien quand seul `updatedAt` change, donc un run vivant au
repos est marqué périmé).

### Non-objectifs

Pas de colonne `cacheRead`/`cacheWrite`, aucun signe monétaire nulle part, aucun
bouton d'export, de filtre ou de rafraîchissement, aucune ligne
sélectionnable, aucune fenêtre par run ou par feature, aucune mémorisation du
projet choisi entre deux lancements. Aucune écriture dans le magasin.

### Recette : prouver la fenêtre par la sonde AX

Le bundle est lancé **directement** (le cwd porte `.git`), un magasin jetable sous
`/tmp` est posé par `MEM0_PIPELINE_STATE_DIR`, dans le **même** appel shell que la
sonde AX :

1. Construire `/tmp/<état>/` : un `projects/<clé>.json` (deux features au plan), un
   `lots/<clé>.json` (worktree de l'une), une `history/*.json` par run pointant sur
   une **copie** d'un vrai fichier de session, et une entrée `running/*.json` dont
   `owner.pid` est le pid du shell de la sonde (vivant).
2. Lancer `MEM0_PIPELINE_STATE_DIR=/tmp/<état> nohup "omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" &`,
   puis interroger `AXUIElementCreateApplication(pid)` : `stats.project`,
   `stats.aggregate`, `stats.chart`, `stats.hidden`, `stats.run.<tag>`.
3. Vérifier par calcul indépendant (python sur le `.jsonl` copié) que tokens,
   tours et durée de la ligne égalent la session (AC-1), et qu'aucune valeur AX ne
   porte `$` (AC-2).
4. AC-3 : ajouter une entrée assistant avec `usage` à la session copiée ⇒ la ligne
   et l'agrégat montent **sans geste** ; relever la durée du run vivant deux fois à
   3 s d'intervalle ⇒ elle a augmenté alors qu'aucun octet n'a été écrit.
5. AC-6 : écrire un second `projects/<autre clé>.json` avec sa propre feature,
   choisir chaque projet dans `stats.project` ⇒ seules les features du projet
   choisi sont présentes dans l'arbre AX.

## Harnais réel

L'ancien harnais de sessions hébergées (`SessionHarnessTests`) a disparu avec
l'hôte `omp` de l'app : ses quatre tests réels (aller-retour prompt → événements →
dialogue `ask` répondu → fin de tour, mort et relance du même `.jsonl`, fermeture
sans orphelin) exerçaient des sessions que l'app lançait elle-même. Les sessions
sont désormais servies par le service, et l'app ne lance **aucun** process `omp`
pour elles : plus aucun test ne pilote un `omp` hébergé par l'app.

Les preuves qui lancent encore un vrai `omp` sont les **recettes gatées** : session
composant et run terminal (`MEM0_SESSION_COMPONENT_RECIPE`, voir « Composants de
l'app »), terminal (`MEM0_TERMINAL_RECIPE`, voir « Section Terminal »), lecture
d'une vraie session (`MEM0_SESSION_RECIPE`, `MEM0_VIEWER_RECIPE`). Chacune est
**désactivée par défaut** — aucun script du dépôt (`scripts/swift-app.sh`,
`bash scripts/check.sh`, `.github/workflows/`) ne pose sa variable — donc la suite
reste verte et aucun octet n'est envoyé à un modèle.

Une recette posée sans son prérequis **échoue explicitement**, jamais en faux
succès ni en skip silencieux : la variable est une demande d'exécution réelle, pas
un filtre. Le harnais du terminal (`TerminalSmokeTests`) suit la même règle, avec sa
propre variable **`MEM0_TERMINAL_RECIPE`** (voir « Section Terminal (terminal
intégré) »).

## Notifications et barre de menus

L'app est une **app de barre de menus** : fermer la fenêtre ne la quitte pas (seul
**⌘Q** quitte), l'item de barre reste présent, et un clic sur cet item ramène la
fenêtre visible et au premier plan. Le titre de l'item suit les compteurs —
`<occupés>·<en attente>` (point médian U+00B7) dès que l'un des deux est non nul,
l'icône seule sinon (`square.grid.2x2`) ; un menu déroulant n'est **pas** posé, un
menu demanderait deux clics là où un seul doit ramener la fenêtre.

### Les notifications

Une notification macOS est émise quand un évènement du magasin survient, **au plus
une fois par évènement** (déduplication persistée), et **seulement si la fenêtre de
l'app n'est pas au premier plan** (mesuré par `NSApplication.isActive`). Les quatre
besoins et leurs six familles :

| Évènement | Source | Titre · corps |
|---|---|---|
| attend une réponse | `running/<id>.json`, `pendingAsk` en vol et propriétaire vivant | `<label> attend une réponse` · « Une question attend votre réponse. » |
| attend une validation (specs) | feature de lot `waiting` avec `waitKind = specs` | `<name> attend une validation` · « Jalon specs : validez le contrat pour continuer. » |
| attend une validation (revue) | idem avec `waitKind = review` | `<name> attend une validation` · « Jalon revue : validez la livraison pour continuer. » |
| échoué (feature de lot) | feature de lot `failed` | `<name> a échoué` · « La feature `<slug>` a échoué. » |
| échoué (run clos) | `history/<id>.json`, `finalState = failed` | `<label> a échoué` · « Le run a échoué. » |
| PR fusionnée | feature de projet `status = merged` dans `projects/<clé>.json` | `PR fusionnée : <slug>` · « La PR de `<slug>` est fusionnée. » |

`<name>` est le `name` de la feature s'il n'est pas blanc, sinon son `slug` ; le
`label` est celui que le dépôt écrit lui-même. Une PR absente de `projects/` n'émet
rien (une PR non suivie), et une feature de **lot** `done` avec `prUrl` (colonne
« PR ouverte » du Kanban) n'est pas une fusion. Les sources sont bornées comme le
magasin : 200 entrées `running`, 20 rangs `history`, un lot et un projet par dépôt.

### Notifications refusées

Quand l'autorisation de notification est **refusée** (et seulement alors), l'Accueil
montre en tête un bandeau neutre (`home.notificationsBanner`) :
« Les notifications sont désactivées. », « Ouvrir les Réglages » (Réglages Système ▸
Notifications) et « Ignorer », qui le masque pour de bon (préférence
`home.notificationsBannerDismissed`). La fenêtre n'affiche plus de compteurs : ils
vivent dans l'item de la barre des menus.

Dans l'item de barre, « occupés » compte les cartes de la colonne **En cours** ; « en attente » les cartes
« À vous », « Specs à valider » et « Revues à accepter » — deux catégories
**exclusives**, calculées sur l'ardoise que la fenêtre affiche. La colonne « Pas
commencées » de Pipelines (features `pending`, non lancées) n'est **pas** ce compteur.

### Le registre persisté

Les clés déjà notifiées vivent dans un fichier JSON :
`{"version":1,"notified":{"<clé>":<millisecondes epoch>}}`.

- Emplacement par défaut : `~/Library/Application Support/com.omp.console/notified-alerts.json`.
- Surcharge : la variable **`MEM0_CONSOLE_ALERTS_DIR`** (chemin absolu retenu, `~`
  développé ; un chemin relatif est ignoré).
- Fichier absent, illisible, non JSON, d'une autre version ou au champ `notified`
  mal typé ⇒ registre **vide**, jamais d'exception ; seules les clés font foi.
- L'écriture précède la livraison, et a lieu **même fenêtre au premier plan**
  (l'évènement est consommé : une relance ne le renotifiera pas). Aucune purge,
  aucun TTL.

### Recette manuelle

Le paquet ne vend aucun produit exécutable : la livraison réelle d'une notification
(bannière macOS) se prouve sur le **bundle** et une autorisation accordée. Aucun
processus de test ne peut ni construire un `NSStatusItem` ni appeler
`UNUserNotificationCenter` hors bundle (voir les trois pièges ci-dessous), donc le
test `AlertsRecipeTests` (désactivé par défaut) s'arrête à un livreur enregistreur.

```bash
bash scripts/swift-app.sh                       # depuis la racine du dépôt
MEM0_PIPELINE_STATE_DIR=/tmp/magasin-alertes \
  MEM0_CONSOLE_ALERTS_DIR=/tmp/ledger-alertes \
  nohup "omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" >/tmp/omp-console.log 2>&1 &
```

1. Accorder le dialogue d'autorisation ; vérifier l'item de barre à l'icône seule.
2. Mettre une autre app au premier plan, puis produire un **vrai** évènement par une
   **session servie réelle** (une session du service sur le magasin jetable, avec
   un prompt demandant une question à choix multiples) : une bannière apparaît, nomme le run,
   et aucune seconde ne suit tant que la question est en vol. Relancer l'app avec le
   même `MEM0_CONSOLE_ALERTS_DIR` ⇒ aucune bannière ; `notified-alerts.json` porte la
   clé `answer:<id>:<toolCallId>`.
3. Répéter fenêtre **au premier plan** ⇒ aucune bannière, mais la clé est enregistrée.
4. Sur un pipeline réel, observer un jalon (`waitKind = specs|review`,
   `state = waiting`) et une fusion (`projects/<clé>.json`, `status = merged`) : une
   bannière par évènement, jamais deux.
5. Refuser l'autorisation dans Réglages Système ▸ Notifications ▸ OMP Console,
   rouvrir la fenêtre ⇒ l'Accueil montre `home.notificationsBanner` ; la réaccorder ⇒
   le bandeau disparaît (statut relu à l'activation de l'app).
6. Fermer la fenêtre (bouton rouge) ⇒ l'app reste vivante, l'item de barre est là,
   ⌘Q quitte ; presser l'item (sonde AX `AXPress`) ⇒ la fenêtre redevient visible et
   au premier plan.

### Trois pièges mesurés

1. **Hors bundle, pas de centre de notifications.** `UNUserNotificationCenter.current()`
   dans un binaire nu (ou un processus de `swift test`) tue le process sur une
   exception Objective-C non rattrapable (`bundleProxyForCurrentProcess is nil`). La
   garde d'instanciation est donc `Bundle.main.bundleURL.pathExtension == "app"`, et
   **aucun** appel UserNotifications ne vit ailleurs que dans `AlertDelivery.swift`.
2. **`NSStatusBar` interdit dans la suite.** `NSStatusBar.system.statusItem(withLength:)`
   tue un processus de test (signal 6, pile `-[NSStatusBar _statusItemWithLength:withPriority:]`).
   `StatusItemController` n'y est donc jamais construit : sa logique de titre est une
   fonction pure (`StatusItemTitle`), et son câblage AppKit est prouvé par la recette.
3. **`activate()` coopératif est refusé.** Sans intention utilisateur,
   `NSApplication.activate()` rend la fenêtre visible mais pas clé ni principale ;
   seule `activate(ignoringOtherApps: true)` (dépréciée avec le SDK du poste, assumé)
   rétablit fenêtre clé/principale et app active.

### Relevés mesurés (poste de référence, 2026-09-29)

- `swift test` (suite complète, `--no-parallel`) : **375 tests verts**, la recette
  `AlertsRecipeTests` rapportée « skipped » (aucun script de CI ne pose ses variables).
- Recette en suite, lancée une fois à la main
  (`MEM0_ALERTS_RECIPE_DIR=/tmp/alerts-recipe/magasin`,
  `MEM0_ALERTS_RECIPE_OUT=/tmp/alerts-recipe/journal.txt`) : un process réel écrit
  `running/00000000000000a1.json` (état `waiting` + `pendingAsk`), le vrai modèle
  notifie **une** fois — clé `answer:00000000000000a1:call-1`, titre
  `recette/attente attend une réponse`, corps `Une question attend votre réponse.`,
  résultat `delivered` — et `notified-alerts.json` porte la clé. Le journal rappelle
  qu'aucun `add` réel n'est prouvé hors bundle.
- Les bannières réelles et le clic sur l'item de barre se consignent dans la section
  `## Revue` du contrat : cette recette exige le bundle et une autorisation accordée.

## Consulter et corriger la mémoire du projet

La section **Mémoire** lit la mémoire du service mem0-http et l'écrit : la **liste**
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
et avant chaque recherche.

> La route `GET /memory/graph` et l'extension `PUT` (étiquettes) sont **nouvelles
> côté service** : une pile construite avant cette version répond 404/405. Il faut
> reconstruire l'image — `compose build mem0-http && compose up -d` (l'app affiche
> sinon l'erreur du service dans l'état « Mémoire indisponible »).

**La portée** est calculée par le même algorithme que `projectId` du plugin mémoire
(`omp-mem0-memory/state.ts`) : override `MEM0_PROJECT_ID`, sinon la racine du dépôt
**principal** — un worktree de feature partage donc la portée du principal —, puis
`package.json`, `pyproject.toml`, `Cargo.toml`, `Package.swift`, puis le premier
`*.xcodeproj`, puis le nom du répertoire. `_global` n'est jamais envoyé : la liste
ne montre que la mémoire du projet. Sans portée calculable (aucun projet ouvert,
`git` en échec), la liste affiche « Aucun projet ouvert » et n'émet aucun appel de
portée — le GRAPHE, lui, n'en dépend pas : il montre toutes les portées du service.

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
| portée incalculable (liste) | « Aucun projet ouvert » + renvoi vers « Session OMP » (⌥⌘N) |
| service indisponible | « Mémoire indisponible » + bouton « Réessayer », l'adresse et la dernière erreur en détail secondaire — jamais une liste vide, jamais un graphe partiel silencieux |
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
`memoire.unavailable.detail`, `memoire.summary.count`, `memoire.search.results`,
`memoire.list`, `memoire.list.row.<id>`, `memoire.detail`, `memoire.detail.title`,
`memoire.detail.copy`, `memoire.detail.technical` ; mode graphe :
`memoire.graph.toggle`, `memoire.graph.canvas` (libellé = bandeau de compte),
`memoire.graph.project`, `memoire.graph.tag`, `memoire.graph.zoomIn`,
`memoire.graph.zoomOut`, `memoire.graph.recenter`, `memoire.graph.create`,
`memoire.graph.edit`, `memoire.graph.delete`, `memoire.graph.link`,
`memoire.graph.detach.<id>`, `memoire.graph.error`, `memoire.create.sheet`,
`memoire.edit.sheet`, `memoire.link.sheet` (et `.text`, `.tags`, `.project`,
`.cancel`, `.save`, `.error` sur chacune). Clavier : `Tab`/`Maj-Tab` dans l'ordre de
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
téléphone, une autre machine) : elle sert le magasin d'état, les sessions, les
statistiques, la mémoire, et les gestes du tableau — et pousse ses changements par
un flux temps réel.

- **Transport** : HTTP/1.1 en clair, sur la **seule interface du réseau local**.
  Le port par défaut est **8787** et le service est annoncé par **Bonjour** sous le
  type **`_ompconsole._tcp`** (instance « OMP Console », TXT `v` = version du
  protocole, `api` = base des chemins). Une connexion dont la source n'est pas une
  adresse locale (boucle locale, plages privées, lien-local) est coupée sans un octet.
- **Version de protocole** : chaque requête porte `X-Console-Protocol-Version: 1` et
  chaque réponse le renvoie. Un client dont la version diffère est refusé par le code
  partagé `incompatible_protocol`, sans qu'aucune donnée ne soit servie.
- **Appairage** : `POST /v1/pair` est la **seule route non authentifiée**. Elle prend
  `{"code":"XXXXXXXX","name":"<appareil>","protocolVersion":1}` et rend un jeton
  d'appareil (`Authorization: Bearer <jeton>` sur toutes les autres routes). Le code
  est généré depuis la feuille « Appairage… » (menu de l'app, ⌥⌘A), affiché huit
  caractères Crockford base32 groupés `XXXX-XXXX`, valable **120 secondes** et à
  **usage unique** ; au-delà de 5 échecs, le code se verrouille et seul un code neuf
  le déverrouille. Un code expiré disparaît de la feuille.
- **Interrupteur** : « Service d'API distante », en tête de la feuille, est **actif
  par défaut** et mémorisé (`remote.enabled`) ; le couper arrête le serveur et son
  annonce Bonjour.
- **Permission macOS** : la première opération Bonjour d'un bundle lancé depuis le
  Finder déclenche l'alerte « Réseau local » (TN3179) ; la feuille explique le refus
  et ouvre les Réglages Système. Un outil lancé depuis le Terminal (`swift test`,
  `bun`) en est exempté — c'est ce qui rend la recette de découverte reproductible.
- **Documents de projet** : `GET /v1/projects/{repoKey}/documents` sert `PROJECT.md`
  (du magasin) et `contract.md` (de la racine du projet), chacun avec son état
  (`text`, `missing`, `binary`, `unreadable`).
- **État du Mac pour l'Accueil** : `GET /v1/components` sert
  `{ompInstalled, ompPath?, setupBanner?}` (la présence réelle du composant OMP et
  le bandeau de préparation) ; `GET /v1/journal` sert les 20 derniers gestes
  (`{entries:[…]}`, le plus récent en tête) ; `GET /v1/cards/{id}/contract` sert le
  contrat d'une carte sous `{document: {name, state, content, reason}}` — `404`
  carte inconnue, `409` carte sans contrat (moment ou worktree absent).
- **Flux** : `GET /v1/stream` ouvre un `text/event-stream` (SSE) qui pousse `hello`,
  `store`, `devices`, `components`, `journal`, `sessions` et `hosted`, avec un
  battement de cœur toutes les 15 secondes. À l'abonnement, l'ordre est `hello`,
  `store`, `devices`, `components`, `journal`. La révocation d'un appareil coupe son
  flux immédiatement.

### Sonde CLI

`scripts/omp-console-api.ts` est la sonde manuelle du dépôt (lecture, gestes, flux) :

```bash
bun scripts/omp-console-api.ts pair --code XXXX-XXXX --name iPhone
bun scripts/omp-console-api.ts snapshot
bun scripts/omp-console-api.ts sessions
bun scripts/omp-console-api.ts watch --seconds 10
bun scripts/omp-console-api.ts resume feature:<repoKey>:<slug>
bun scripts/omp-console-api.ts forget
```

Le jeton vit au trousseau (service `com.omp.console.remote-api.cli`) et n'est jamais
affiché. Codes de sortie : `0` succès, `1` refus (le code d'erreur partagé et le
message du serveur sont imprimés tels quels), `2` prérequis absent (URL invalide,
serveur injoignable).

### Recettes

```bash
cd omp-console
MEM0_REMOTE_RECIPE=1 swift test --filter AC-20    # CLI ↔ coque réelle, run vivant
swift test --filter AC-1                          # annonce Bonjour + source locale
```

`AC-1` ne demande que `dns-sd` ; `AC-20` demande `omp` et `bun` — sans eux, la
recette est **sautée**, jamais verte à tort.

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 26, deux cibles)
├── Sources/OMPConsole/
│   ├── OMPConsoleApp.swift        point d'entrée (@main), scènes et menu
│   ├── ConsoleRootView.swift      fenêtre, barre latérale groupée, barre d'outils, feuille unique
│   ├── SectionViews.swift         les neuf vues de section (Sessions : liste + visionneuse poussée)
│   ├── ConsoleSection.swift       les neuf sections, leurs libellés et leurs groupes
│   ├── ConsoleModel.swift         l'état : la section courante, la session ouverte dans Sessions
│   ├── ProjectRoot.swift          le projet ouvert, résolu en UN endroit (clé partagée)
│   ├── SessionConsoleView.swift   section « Session OMP » : conversation, composeur, inspecteur
│   ├── SessionConsoleModel.swift  projet, prompt, dialogue, conversation, statut, actions
│   ├── ProcessRunner.swift        l'exécuteur partagé : lancement, drainage, lignes,
│   │                              escalade SIGTERM/SIGKILL
│   ├── OmpBinary.swift            résolution du binaire `omp` de l'app (composant)
│   ├── OmpEnvironment.swift       l'environnement d'un `omp` lancé par l'app (PATH)
│   ├── Design/
│   │   ├── ConsoleSurface.swift   surfaces du contenu : carte, bandeau, bouton proéminent (aucun verre)
│   │   ├── ConsoleVocabulary.swift états en mots, étapes, formateurs (fonctions pures)
│   │   ├── StatusBadge.swift      l'état en un mot : badge du contenu, pilule Liquid Glass d'une session
│   │   └── MarkdownBlocksView.swift un Markdown rendu en blocs (Fichiers, conversation, Mémoire, Projet)
│   ├── Home/                      la section Accueil et ses feuilles
│   │   ├── HomeModel.swift        disponibilité du composant OMP, bienvenue, réponse, bandeau
│   │   ├── HomePresentation.swift état de l'écran, listes, geste d'une carte (purs)
│   │   ├── HomeText.swift         tous les textes de l'Accueil
│   │   ├── HomeView.swift         les quatre états, dont le fond « prépare ses composants »
│   │   ├── MainSheet.swift        la feuille due, une seule à la fois (politique pure)
│   │   ├── WelcomeSheet.swift     la feuille « Bienvenue »
│   │   └── AnswerSheet.swift      la feuille « Répondre »
│   ├── Contract/                  la feuille Contrat : lire le contrat d'une feature
│   │   ├── ContractDocument.swift moment de validation, sections verbatim, chemin, lecture (purs)
│   │   ├── ContractText.swift     tous les textes de la feuille
│   │   ├── ContractModel.swift    chaque ouverture relit le fichier ; feuille affichée
│   │   └── ContractSheetView.swift la feuille (sections, états, « Fermer »)
│   ├── Launch/                    la feuille « Nouvelle feature »
│   │   ├── LaunchRepo.swift       dépôts proposés, garde « racine git » (purs)
│   │   └── NewFeatureSheet.swift  la feuille
│   ├── Service/                   le client de l'API REST locale (aucun process lancé)
│   │   ├── ServiceLocator.swift   lit `<état>/service.json`, vérifie le pid, rend l'URL et le jeton
│   │   ├── ServiceClient.swift    le client HTTP 127.0.0.1 : sessions, commandes, pilot, dialogues
│   │   ├── ServiceEvents.swift    le flux SSE d'une session, reconnexion bornée
│   │   ├── ServiceSessionModel.swift session servie : création, prompt, dialogues, arrêt (DELETE)
│   │   ├── ServiceError.swift     la table d'erreurs du service (« service arrêté », 409 exact…)
│   │   ├── ServiceProtocol.swift  les valeurs de fil : dialogues, trames, accusés (pur)
│   │   └── DialogPane.swift       le volet de dialogue partagé (Session OMP, Projet)
│   ├── Setup/                     la préparation du premier lancement (S-1, S-5)
│   │   ├── AppPaths.swift         la racine privée de l'app (composants, XDG, pile)
│   │   ├── CommandRunner.swift    l'exécution d'une commande externe, injectable
│   │   ├── ComponentManifest.swift les versions, URL et empreintes des composants
│   │   ├── ComponentInstaller.swift téléchargement, SHA-256, pkgutil, `--version`, purge
│   │   ├── ComponentPresence.swift présence des composants : lecture et veille (badge)
│   │   ├── ComponentBadge.swift   le badge d'état, au pied de la barre latérale
│   │   ├── SetupModel.swift       la chaîne composants → migration → pile → oMLX
│   │   ├── SetupText.swift        tous les textes de la préparation, en un endroit
│   │   └── SetupView.swift        la feuille : quatre lignes, états, boutons
│   ├── Stack/                     la pile mémoire de l'app (S-2, S-3, S-6)
│   │   ├── PodmanCommand.swift    argv purs et environnement XDG d'une commande podman
│   │   ├── StackConfig.swift      la config `stack/env` (mêmes clés que mem0-stack)
│   │   ├── MemoryStack.swift      machine `omp-console`, conteneurs, attentes, `/health`
│   │   ├── DockerSocket.swift     l'API Docker sur socket Unix (curl), décodage tolérant
│   │   ├── StackMigration.swift   arrêt de l'ancienne pile, copie gardée, import `.env`
│   │   └── OMLXProbe.swift        la sonde oMLX (budget 5 s, jamais bruyante)
│   ├── Terminal/                  la fenêtre de terminal : un shell de connexion dans un PTY
│   │   ├── TerminalHost.swift     le PTY : forkpty, fermeture des descripteurs
│   │   │                          hérités ≥ 3, écriture,
│   │   │                          escalade SIGTERM/SIGKILL du groupe, récolte
│   │   ├── TerminalShell.swift    le shell lancé ($SHELL -l, sinon /bin/zsh) et « Lancer omp »
│   │   ├── TerminalHostError.swift les échecs du PTY et leur seule table de texte
│   │   ├── TerminalEnvironment.swift l'environnement de l'enfant (TERM, COLORTERM ; PATH par OmpEnvironment)
│   │   ├── TerminalScreen.swift   la grille : cellules, attributs, marges, largeur UAX #11
│   │   ├── TerminalEmulator.swift l'émulateur VT : CSI, SGR, chaînes, sondes, réponses
│   │   ├── TerminalPalette.swift  palette 16/256/direct, défauts, réponse OSC 11
│   │   ├── TerminalViewText.swift tous les textes de la fenêtre Terminal
│   │   ├── TerminalRenderView.swift la zone de rendu (CoreText), le curseur, le clavier
│   │   ├── TerminalConsoleModel.swift l'état : cible, cibles, process, fermeture, palette
│   │   ├── TerminalConsoleView.swift la fenêtre (barre d'outils, bandeau, zone de rendu, états)
│   │   └── TerminalLaunchSheet.swift la feuille « Choisir un répertoire »
│   ├── Session/                   le lecteur de sessions (aucune vue, aucune E/S d'écriture)
│   │   ├── SessionModel.swift     le modèle de conversation : des valeurs
│   │   ├── SessionReader.swift    lecture incrémentale tirée par l'appelant
│   │   ├── SessionRendering.swift le rendu texte du modèle (fonctions pures)
│   │   └── SessionConsoleText.swift les textes de la fenêtre Session OMP
│   ├── Project/                   la conduite d'un projet depuis l'app
│   │   ├── ProjectConduite.swift  identité, état et refus d'une conduite
│   │   ├── ProjectConsoleModel.swift le modèle : armement, refus, clôture, dialogues, veille
│   │   ├── ProjectPaths.swift     la clé de dépôt et le chemin de PROJECT.md
│   │   ├── ProjectPlan.swift      le plan (segments, états, PR) : fonctions pures
│   │   ├── ProjectAttention.swift décision d'attention (pure) et adaptateur NSApp
│   │   ├── ProjectWindowPresence.swift présence de la fenêtre + WindowAccessor
│   │   ├── ProjectViewText.swift  tous les textes de la vue Projet
│   │   ├── GhCLI.swift            binaires, argv purs et exécution de `gh` (seule surface GitHub)
│   │   ├── PullRequests.swift     statuts requis, lignes et décodage : fonctions pures
│   │   ├── PRService.swift        lecture et fusion d'une PR (protocole + service `gh`)
│   │   ├── URLOpening.swift       ouvreur d'URL (NSWorkspace)
│   │   ├── ProjectPRPane.swift    le volet « PR et CI » et ses lignes
│   │   ├── ProjectConsoleView.swift la fenêtre (en-tête, PR, plan, document, conversation, feuille, inspecteur)
│   │   ├── ProjectView.swift      la section « Projet » (même surface)
│   │   └── ProjectLaunchSheet.swift la feuille « Piloter un projet… »
│   ├── Store/                     la couche de lecture du magasin d'état
│   │   ├── PipelineStore.swift    racine du magasin et noms des six stores
│   │   ├── StoreModels.swift      modèles typés et validation champ par champ
│   │   ├── StoreSnapshot.swift    enveloppes d'un instantané
│   │   ├── StoreReader.swift      balayage, filtrage, entrées écartées nommées
│   │   ├── StoreRuns.swift        l'appariement run ↔ sessionFile, source UNIQUE
│   │   ├── StoreWatcher.swift     veille vnode d'un store et flux d'abonnés
│   │   └── StoreHub.swift         le flux global, agrégat des six
│   ├── Kanban/                    le tableau des pipelines (lecture seule)
│   │   ├── KanbanModels.swift     colonnes, cartes, sources, marques, clé de dépôt
│   │   ├── KanbanLanes.swift      les cinq voies de l'écran et ce qu'une carte montre (pur)
│   │   ├── KanbanBoard.swift      construction pure de l'ardoise, textes de parité
│   │   ├── KanbanAnomalies.swift  illisible, mort, doublon : diagnostic et marques
│   │   ├── KanbanModel.swift      abonnement au flux, sélection, clavier, feuille de détail
│   │   ├── KanbanText.swift       textes de la feuille de détail, d'Activité et des problèmes
│   │   ├── PipelineProgress.swift l'avancement d'une carte en cinq étapes (pur)
│   │   ├── PipelineProgressViews.swift barre d'avancement des cartes, frise de la feuille
│   │   ├── KanbanView.swift       la section : voies, clavier, boutons de barre d'outils, feuille de détail
│   │   ├── KanbanCardView.swift   une carte (sélection, double-clic, menu contextuel)
│   │   └── KanbanDetailView.swift la feuille de détail d'une carte
│   ├── Actions/                   les gestes : la SEULE couche qui écrit
│   │   ├── PipelineCommand.swift  livraisons et commandes, objets JSON exacts
│   │   ├── PipelineWriter.swift   publication exclusive (link) et boîte confinée
│   │   ├── ActionsText.swift      tous les textes et les lignes de journal
│   │   ├── KanbanActionPresentation.swift  aiguillage pur et dépôts lançables
│   │   ├── ActionsModel.swift     journal borné, émissions, accusés, feuille, pilote
│   │   └── KanbanActionViews.swift  zone d'action, options de question, journal
│   ├── Files/                     la visionneuse de fichiers et de diffs (lecture seule)
│   │   ├── GitCLI.swift           binaires, argv purs et exécution : la SEULE surface git
│   │   ├── FilesTarget.swift      catalogue des cibles et base de comparaison
│   │   ├── FilesTree.swift        l'arbre d'une cible (suivis, non suivis, supprimés)
│   │   ├── FilesReader.swift      le contenu d'un fichier, exactement
│   │   ├── FilesDiff.swift        le diff unifié découpé en lignes typées
│   │   ├── TreeWatcher.swift      veille FSEvents récursive de la cible active
│   │   ├── FilesModel.swift       l'état de la section : cible, arbre, document, veille
│   │   ├── FilesText.swift        tous les textes de la section, en un endroit
│   │   ├── MarkdownDocument.swift un Markdown en blocs complets (pur)
│   │   ├── CodeHighlighter.swift  langue d'un fichier et coloration lexicale (pure)
│   │   └── FilesView.swift        la section : en-tête, arbre, document rendu ou code, diff
│   ├── Memory/                    la mémoire du projet : liste (lecture) et graphe (écriture)
│   │   ├── MemoryScope.swift      la portée mem0 du projet (miroir du plugin)
│   │   ├── MemoryService.swift    config, routes, lignes, étiquettes, erreurs, client HTTP
│   │   ├── MemorySearch.swift     la sélection de pertinence (portée du plugin)
│   │   ├── MemoryText.swift       tous les textes de la section, en un endroit
│   │   ├── MemoryModel.swift      l'état de la LISTE : portée, sommaire, recherche, sélection
│   │   ├── MemoryGraph.swift      la dérivation pure du graphe : nœuds, liens, visibilité
│   │   ├── MemoryGraphLayout.swift placement (Fruchterman-Reingold), vue écran, clic, scène
│   │   ├── MemoryLinkStore.swift  les liens manuels, dans `<racine de support>/memory-links.json`
│   │   ├── MemoryGraphModel.swift l'état du MODE GRAPHE : chargement, filtres, recherche, écritures
│   │   ├── MemoryGraphView.swift  le graphe : contrôles, canevas, fiche, feuilles d'écriture
│   │   └── MemoryView.swift       la section : bascule liste ⇄ graphe, liste, détail, états
│   ├── Viewer/                    la visionneuse de session (aucune écriture)
│   │   ├── ViewerTarget.swift     la session poussée dans Sessions, et son titre
│   │   ├── SessionSelectorModel.swift  les runs choisissables, depuis le magasin
│   │   ├── SessionSelectorView.swift   la section « Sessions » : la liste par jour
│   │   ├── SessionDays.swift      le regroupement des runs par jour (pur)
│   │   ├── SessionRows.swift      faits affichables, en-tête d'appel, question `ask`
│   │   ├── SessionDiffLines.swift diffs : classification et découpe des corps
│   │   ├── FileWatcher.swift      veille vnode d'UN fichier quelconque
│   │   ├── SessionViewerModel.swift  lignes, plis, suivi, états, journal d'octets
│   │   ├── SessionViewerView.swift   la visionneuse poussée : fil, pilule d'état, « Revenir au direct »
│   │   ├── ConversationThread.swift  le fil de conversation partagé (suivi, états)
│   │   ├── ConversationText.swift    textes du fil et verbes d'outil
│   │   ├── SessionRowView.swift      le rendu d'un fait (dont les lignes de diff)
│   │   └── ScrollBottomObserver.swift la géométrie du défilement et ses gestes
│   ├── Alerts/                    les notifications macOS
│   │   ├── AlertEvents.swift      dérivation des six familles, clés et textes purs
│   │   ├── AlertDelivery.swift    livreur réel/no-op, autorisation (SEUL import UserNotifications)
│   │   ├── AlertLedger.swift      registre persisté des clés, lecture tolérante
│   │   └── AlertsModel.swift      abonnement, décision, compteurs, autorisation
│   ├── Stats/                     la section « Statistiques » (lecture seule)
│   │   ├── StatsMetrics.swift     les métriques d'une session (fonctions pures)
│   │   ├── StatsModels.swift      types du tableau et textes exacts de la vue
│   │   ├── StatsBoard.swift       construction du tableau et totaux (fonctions pures)
│   │   ├── StatsPresentation.swift barres et lignes du tableau de bord (purs)
│   │   ├── StatsModel.swift       abonnement, lecteurs, veilles, sélection, tri
│   │   └── StatsView.swift        la fenêtre : tuiles, graphique, tableau triable
│   ├── Remote/                    l'API distante du réseau local (S-1 … S-15)
│   │   ├── HTTPMessage.swift      parseur incrémental HTTP/1.1 et sérialiseur de réponse
│   │   ├── HTTPStatus.swift       table des statuts d'erreur et corps JSON
│   │   ├── RemoteAddressPolicy.swift la garde d'acceptation : source locale seulement
│   │   ├── RemoteServer.swift     `NWListener`, Bonjour, une requête par connexion
│   │   ├── RemoteServiceState.swift l'état publié du service (coupé, actif, refusé, échec)
│   │   ├── RemoteClock.swift      l'horloge injectable du service
│   │   ├── PairingCode.swift      code Crockford, expiration, seuil d'échecs
│   │   ├── DeviceRegistry.swift   les appareils appairés et la révocation
│   │   ├── DeviceTokenStore.swift jetons au trousseau (session), doublure en mémoire
│   │   ├── ConstantTime.swift     comparaison de secret à temps constant
│   │   ├── RemoteGuard.swift      version de protocole puis jeton, dans cet ordre
│   │   ├── Payloads.swift         charges utiles des routes et corps de requête
│   │   ├── RemoteReads.swift      lectures : magasin, sessions, documents, stats, mémoire
│   │   ├── RemoteActions.swift    gestes : cartes, feature, conduite, session, PR
│   │   ├── RemoteRouter.swift     la table des routes, un seul point de réponse
│   │   ├── RemoteStream.swift     le flux SSE : sources, battement, révocation
│   │   ├── RemoteServiceModel.swift l'interrupteur persistant et la composition du service
│   │   └── PairingSheet.swift     la feuille d'appairage, ses états et ses textes
│   └── MenuBar/                   l'item de barre de menus et ses compteurs
│       ├── RunCounters.swift      occupés / en attente et l'état publié
│       └── StatusItem.swift       titre pur + contrôleur AppKit de l'item
├── Tests/OMPConsoleTests/         la suite Swift Testing (Service/ : ServiceClientTests,
│                                  ServiceSessionModelTests, ServiceActionsTests ;
│                                  ScriptedServiceTransport, le transport HTTP scripté)
├── Bundle/Info.plist              le plist du bundle .app
└── build/                         artefacts (bundle .app), ignorés par git
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
sept sections, dérivées du type partagé `ConsoleSection` (Terminal et Fichiers
sont hors périmètre), une seule navigation adaptative — barre latérale à deux
groupes sur iPad, pile sur iPhone — et, pour chaque section, son écran avec son
état vide RÉEL. Elle n'a ni magasin local, ni écriture du magasin : son seul accès
réseau est le client distant (`ConsoleClient`) — découverte Bonjour, appairage au
trousseau et feuille de connexion.

L'**Accueil** est un écran à cinq états : déconnecté (état dégradé explicite,
aucun geste), « OMP absent sur le Mac » (distinct de la déconnexion), chargement,
premiers pas, et tableau de bord. Le tableau de bord montre le bandeau de
préparation, l'accusé de commande, « À vous » (cartes d'attente avec « Répondre… »,
« Valider les specs », « Accepter la revue », « Lire le contrat »), « En cours »
(« Reprendre » ou la durée) et « Livrées récemment » (tap = ouverture de la PR) —
les MÊMES faits que l'Accueil macOS, dérivés du noyau partagé `ConsoleCore`. La
ligne « Accueil » de la barre latérale porte le badge du nombre d'attentes, et
trois feuilles s'ouvrent depuis l'écran : « Répondre » (options d'un ask ou texte
libre), Contrat (sections verbatim) et Bienvenue (première ouverture d'une
installation neuve, avant la feuille de connexion). Le crochet de recette
`-home.recipe <dashboard|degraded|firstRun|loading|ompMissing|answer|contract>`
force un état depuis la fixture partagée `HomeParity` pour les captures.

Sa recette de design — surfaces, échelle typographique, marges, tons, politique
du verre, états vide et erreur, Dynamic Type — vit dans
`omp-console/ios/DESIGN.md`. Chaque règle y porte un marqueur `[test: …]`,
`[capture: …]` ou `[garde: design-ios/AC-<n>]` : aucune prose non jugeable.

### Section Pipelines

La section Pipelines affiche l'ardoise des features et des runs de tous les
dépôts — les cinq voies et leurs cartes — dérivée du magasin que le Mac sert par
la trame `store`, sans jamais inventer de donnée. La carte d'une feature offre
les gestes de la coque macOS : répondre à une question (option ou texte libre),
valider un jalon (specs ou revue), lancer une feature jamais en route, l'arrêter
(avec confirmation), la reprendre, ouvrir la PR dans le navigateur et la
fusionner (avec confirmation, après lecture fraîche du `headOid`). La feuille
« Nouvelle feature… » propose un dépôt (parmi les dépôts réels de l'ardoise),
deux modèles (req+specs, impl+review), un titre et un besoin, et crée la feature
sans aucune action sur le Mac.

Deux routes étendent la surface distante pour cette section : `GET /v1/models`
(le catalogue de `omp models --json`, qu'aucune route n'exposait) et le champ
additif `headOid` de la ligne de PR (sans lui, la fusion est impossible). La
recette de bout en bout (dépôt jetable, iPad, Mac en service) est un test gated
par `MEM0_PIPELINES_RECIPE` ; le scénario iPad reste manuel et vit dans le
contrat de la feature. La recette de design iOS fait autorité et vit dans
`omp-console/ios/DESIGN.md`.

### Section Sessions

La section Sessions liste les runs du magasin d'état — ceux de tous les dépôts et
de tous les processus OMP du Mac, y compris une session lancée par un `omp` en
terminal hors coque — groupés par jour sous les mêmes en-têtes que la coque macOS
(« Aujourd'hui », « Hier », puis la date). Un `Picker` filtre la liste par projet ;
choisir « Tous les projets » la restitue entière et les en-têtes de jour se
recalculent. La liste vient de la dérivation partagée `ConsoleCore` (`SessionList`,
`SessionDays`), alimentée par l'instantané que la trame `store` publie — aucune
route n'est appelée pour lister.

Ouvrir une ligne pousse une **visionneuse en LECTURE SEULE** : elle rend le fil
d'une session par le même modèle de lignes que macOS (`SessionRowBuilder`),
messages et rôles, pensées repliables, appels d'outil et leurs résultats, diffs
colorés et libellés par `SessionDiffText`, question `ask` mise en évidence et
dépliée d'emblée — sans aucun moyen de répondre ni d'écrire dans la session. Un
run vivant s'ajoute en direct (une seule lecture, puis le flux de cette session),
en préservant la position et l'état replié/déplié, et le fil reste collé au bas
tant que l'utilisateur n'a pas remonté. Les composants du fil (modèle, vue, ligne,
feuille) sont réutilisables par la section Session OMP : leur seul contrat
d'entrée est une référence de session et une source.

### Recette : la section Sessions

Le crochet `-sessions.recipe` force un état RÉEL de l'écran depuis la fixture
partagée `SessionParity`, sans écran fabriqué ; la DERNIÈRE paire reconnue gagne,
et une valeur inconnue est ignorée :

```
-sessions.recipe <liste|vide|visionneuse|illisible|en-direct>
```

- `liste` — la liste peuplée de la session de la fixture ;
- `vide` — l'état vide réel de l'écran ;
- `visionneuse` — la feuille du fil ouverte sur la session ;
- `illisible` — le cas d'une session illisible ;
- `en-direct` — le fil d'un run vivant.

Les preuves Swift de la section vivent dans
`omp-console/ios/OMPConsoleIOSTests/IOSSessionTests.swift` (motif de parité
compris) et dans `omp-console/Tests/OMPConsoleTests/SessionParityTests.swift`
côté macOS ; la garde textuelle est `test/ios-sessions.test.ts`. La recette de
design iOS fait autorité et vit dans `omp-console/ios/DESIGN.md`.

### Section Session OMP

La section Session OMP pilote, depuis l'iPad, l'**UNIQUE** session hébergée du
Mac — la MÊME que la fenêtre « Session OMP » de la coque macOS. Lancer une
session depuis l'iPad la fait apparaître sur le Mac, et inversement : il n'y a
qu'un seul hôte, jamais deux. L'écran couvre neuf états (déconnecté, chargement,
aucune session, lancement, arrêt en cours, session vive, arrêtée, interrompue,
échec) ; l'en-tête porte le nom du dépôt et la pastille de l'état.

Lancer choisit le dépôt dans la liste des dépôts **connus du Mac**
(`GET /v1/repos`) — jamais un chemin, jamais un nom calculé par l'app. Le
lancement est indisponible tant qu'une session tourne : l'écran n'offre aucun
geste dans les états de marche, et la route refuse un second lancement (409).
Une session `dead` se relance par « Relancer » (elle reprend le même fichier) ;
une session en marche s'arrête par « Arrêter la session » (confirmation, puis
la séquence d'arrêt du Mac). Le fil réutilise le composant de la section Sessions
(`IOSSessionThreadView`) sur le fichier de session servi : mêmes faits que sur le
Mac, une seule lecture puis le flux de CE fichier. Les dialogues de la session
(quatre formes de la feuille d'escalade, plus « Annuler ») sont tranchables depuis
l'iPad. Rien n'est persisté sur l'appareil.

### Recette : piloter la session OMP depuis l'iPad

Prérequis : l'iPad appairé au Mac (voir « Ouvrir, compiler, tester »), et une
coque macOS en service. Chaque geste et son attendu observable :

1. **Ouvrir la section Session OMP** — sans session lancée, l'écran affiche
   « Aucune session » (ou « Prête à démarrer » si un dossier est déjà mémorisé sur
   le Mac) et le bouton « Lancer la session ».
2. **Choisir un dépôt** — « Lancer la session » ouvre la feuille : la liste des
   dépôts connus du Mac, chacun avec son nom et son chemin. Aucune saisie de
   chemin. Sélectionner un dépôt (marque « ✓ »), puis « Lancer la session ».
3. **Voir la session démarrer** — l'écran montre « Lancement de la session… », puis
   l'en-tête du dépôt avec la pastille « Session active » et le fil. Sur le Mac, la
   fenêtre « Session OMP » affiche la MÊME session, ouverte.
4. **Envoyer un prompt** — saisir un texte dans le composeur et « Envoyer » : le
   message apparaît dans le fil, puis la réponse de la session s'y ajoute sans
   geste. Le champ se vide après un envoi réussi.
5. **Répondre à un dialogue** — quand la session pose une question, la feuille
   « OMP vous demande » s'ouvre : choisir une option (ou saisir un texte, ou
   éditer un plan prérempli), « Répondre » ; pour une confirmation, « Confirmer »
   ou « Refuser » ; « Annuler » annule le dialogue. La feuille se ferme et la
   session reprend.
6. **Reconnecter** — fermer puis rouvrir l'app : la section retrouve la session
   dans le même état, et un dialogue posé pendant la déconnexion reste tranchable.
7. **Arrêter** — « Arrêter la session » (confirmation « Arrêter la session ? ») :
   l'état passe à « Session arrêtée » sur l'iPad comme sur le Mac, la conversation
   reste affichée, et « Lancer la session » redevient disponible.

La recette OUTILLÉE de bout en bout (routes réelles, flux SSE réel, client de
production) est gatée par `MEM0_REMOTE_RECIPE` :
`MEM0_REMOTE_RECIPE=1 swift test --filter iosSessionOmpRecipe`. Comme pour
`iosProjetRecipe`, elle ne prouve pas le Mac réel : la recette pas à pas ci-dessus
est la preuve d'appareil. La garde textuelle de la feature est
`test/ios-session-omp.test.ts`.

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
s'arrête après la compilation. Codes de sortie : `0` compilé (et testé), `1`
échec, `2` « non exécuté ».

### Captures des sept écrans

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/ios-shots.sh
```

Le script démarre un simulateur iPhone et un iPad, installe l'app, puis l'ouvre
sur chacune des sept sections par son argument de lancement et capture l'écran :
**56 PNG** dans `omp-console/build/ios-shots/` (dossier ignoré par git — les
images sont des artefacts de PR, jamais committées) — sept écrans × {iPhone
portrait, iPad portrait} × {clair, sombre} à taille de texte par défaut, plus
sept écrans × {iPhone, iPad} × {clair, sombre} en Dynamic Type maximum (suffixe
`-ax`). Un SECOND groupe capture l'**Accueil** (feature `ios-accueil`) : ses cinq
états de recette (`dashboard`, `degraded`, `firstRun`, `loading`, `ompMissing`) et
ses feuilles « Répondre » et « Contrat » via `-home.recipe`, plus la feuille
Bienvenue — 8 états × {iPhone, iPad} × {clair, sombre} = **32 PNG**. Un
TROISIÈME groupe capture le **mode graphe de la Mémoire** (feature
`ios-memoire-graphe`) via `-memoire.recipe` : le graphe rendu, un état après
pan/zoom et une fiche ouverte — 3 états × {iPhone, iPad} × {clair, sombre} =
**12 PNG**. Le total attendu est **100** (56 + 32 + 12). Chaque capture est
sondée en dimensions (`sips -g pixelWidth -g pixelHeight`) : toutes PORTRAIT —
une capture inattendue ferait échouer le script.

Il n'y a AUCUNE ligne « iPad paysage », pour une raison mesurée le 2026-10-06 sur
le poste de référence : `simctl` n'a aucune sous-commande de rotation,
`Simulator.app` n'y est pas installé, et en mode fenêtré iPadOS refuse
`UIWindowScene.requestGeometryUpdate` (« The current windowing mode does not
allow for programmatic changes to interface orientation. ») ; l'opt-out
`UIRequiresFullScreen` rendrait la demande possible mais coûterait le Split View
et le Slide Over — un choix produit, pas un outil de capture. L'app DÉCLARE
portrait et les deux paysages : elle reste utilisable en paysage sur un vrai
iPad, à vérifier à la main sur l'appareil. Dès que `Simulator.app` est restauré
sur le poste, la ligne pourra revenir avec ses quatorze captures.

Un crochet de recette se pose en argument de lancement : `-section <rawValue>`
ouvre une section précise (`home`, `kanban`, `project`, `session`, `sessions`,
`memory`, `stats`), `-ios.state error` affiche le bandeau d'erreur sur les
sept écrans, et `-memoire.recipe <graphe|zoom|fiche>` force le mode graphe de la
section Mémoire sur la fixture partagée `MemoryGraphParity` — un crochet de
recette, pas une fonctionnalité.

Pour ouvrir une section précise sur un simulateur déjà démarré :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -section memory
```

La capture de l'état d'erreur (artefact de PR, hors des 56) :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -section session -ios.state error
xcrun simctl io <UDID> screenshot omp-console/build/ios-shots/error-session.png
```

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

### Conduire un projet depuis l'iPad

La section **Projet** de l'app conduit un projet de bout en bout : elle lit le
plan et `PROJECT.md` servis par la coque, suit les PR et leurs trois statuts
requis, répond aux escalades et démarre/arrête la conduite. L'app ne calcule
jamais de clé de dépôt et n'écrit rien sur l'appareil : tout vient du flux.

Recette PAS À PAS (chacun des gestes donne l'attendu observable et le mot exact) :

1. **Appairer** l'app au Mac (feuille de connexion) : la zone d'état affiche
   « Connecté à … ». La section Projet affiche alors « Aucun projet piloté. » et
   le bouton « Piloter un projet… ». *(hors appairage, la section affiche le
   bandeau d'attente « Non appairé » / « Mac absent — … » et aucun geste actif)*
2. **Piloter un projet** — toucher « Piloter un projet… » : la feuille liste les
   dépôts connus de la coque (« Dépôt », chacun avec son nom et son chemin),
   y compris un dépôt jamais cadré. Choisir un dépôt (il porte la marque ✓), le
   nom se préremplit, puis « Piloter ». La feuille se ferme et l'en-tête du projet
   apparaît (nom, chemin du dépôt, pastille « Démarrage… » puis « Active »).
3. **Répondre au cadrage** — quand la feuille « OMP vous demande » s'ouvre
   (compteur « Question n sur m »), choisir une option ou saisir le texte, puis
   « Répondre » : l'escalade quitte la file d'attente.
4. **Valider le plan** — à l'escalade de revue, « Corriger le plan » ouvre une
   feuille **préremplie avec le plan courant** ; éditer puis « Répondre » renvoie
   le texte corrigé, ou « Annuler » refuse.
5. **Suivre la PR** — dans le volet « PR et CI », chaque PR affiche
   « PR #<n> — <titre> » et l'état des trois contrôles requis (« check
   (ubuntu-latest) », « check (macos-latest) », « release-simulation »), chacun en
   mots (vert / rouge / en cours / ignoré). « Relire les statuts » rafraîchit. Le
   volet ne porte AUCUN bouton de fusion (la fusion est le geste de la section
   Pipelines).
6. **Arrêter le pilotage** — « Arrêter le pilotage » demande confirmation
   (« Arrêter le pilotage de ce projet ? ») ; confirmé, l'app revient à l'état
   vide « Aucun projet piloté. ».

Recette OUTILLÉE : le test Swift gated `iosProjetRecipe`
(`omp-console/Tests/OMPConsoleTests/ProjectIOSRecipeTests.swift`, titre
`ios-projet/AC-12`) exerce contre une coque réelle les parties automatisables —
`GET /v1/repos`, démarrage sur un dépôt jamais cadré, lecture de la conduite,
réponse à une escalade, arrêt. Il est gardé par la variable `MEM0_REMOTE_RECIPE`
et se lance par :

```bash
MEM0_REMOTE_RECIPE=1 swift test --filter iosProjetRecipe
```

### Lire la mémoire du projet depuis l'iPhone

La section **Mémoire** de l'app affiche le sommaire du projet OUVERT côté Mac — les
mêmes souvenirs que la section Mémoire macOS, dans l'ordre du service —, permet
d'ouvrir un souvenir et de chercher, et dit l'état de la mémoire sans masquer sa
cause. Un SECOND mode, le **graphe**, s'ajoute derrière la bascule « Graphe ⇄
Liste » de la barre d'outils : la LISTE reste le mode d'OUVERTURE. Le graphe est
calculé CÔTÉ MAC par le MÊME noyau que la fenêtre macOS (nœuds-souvenirs,
nœuds-étiquettes, arêtes de proximité et liens manuels), manipulable au doigt
(pincer, glisser, toucher) sur iPhone comme sur iPad ; toucher un souvenir met
son voisinage en évidence et ouvre sa fiche en lecture seule, toucher un
nœud-étiquette APPLIQUE son filtre (le menu « Étiquette » revient à la vue
entière). L'app ne lit que ce que le Mac sert : elle ne calcule aucune portée et
n'émet AUCUNE écriture — le graphe est une lecture (`GET /v1/memory/graph`), et
rien ne se rafraîchit en continu.

Recette PAS À PAS (chaque geste donne l'attendu observable et le mot exact) :

1. **Appairer** l'app au Mac (feuille de connexion), un projet étant ouvert dans la
   fenêtre « Session OMP » du Mac : la section affiche l'en-tête « N souvenirs »
   puis les lignes du sommaire, chacune avec le texte COMPLET du souvenir tel qu'il
   est stocké (aucun rendu Markdown), dans l'ordre du service (les plus récents
   d'abord), et la ligne de troncature si la liste a été bornée.
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
5. **La mémoire tombe** — arrêter le conteneur (`podman stop omp-console-mem0-http`)
   puis toucher « Rafraîchir » : le bandeau rouge « Mémoire indisponible » nomme
   l'adresse sondée et le dernier message d'erreur ; « Réessayer » repasse au
   sommaire dès que la pile répond de nouveau.
6. **Aucun projet ouvert** — fermer le projet côté Mac puis « Rafraîchir » : la carte
   dit « Aucun projet ouvert », sans lire la mémoire.
7. **Mac injoignable** — couper le Mac (ou l'appairage) : le bandeau de connexion
   s'affiche, et aucune cause mémoire n'est inventée.
8. **Le graphe** — toucher « Graphe » : le canevas montre les nœuds-souvenirs, les
   nœuds-étiquettes, les arêtes de proximité (trait plein gris) et les liens
   manuels (trait discontinu accentué) ; pincer pour zoomer, glisser pour déplacer,
   toucher un souvenir pour ouvrir sa fiche (texte intégral tel qu'il est stocké, étiquettes, liens),
   toucher un nœud-étiquette pour n'afficher que sa famille, puis « Étiquette ▸
   Toutes les étiquettes » pour revenir. Toucher « Liste » rend le sommaire
   inchangé — c'est le mode d'ouverture.

Recette OUTILLÉE : le test Swift gated `iosMemoireRecipe`
(`omp-console/Tests/OMPConsoleTests/MemoryIOSRecipeTests.swift`, titre
`ios-memoire/AC-1`) exerce contre une coque réelle les parties automatisables —
sommaire relayé identique à celui de la coque macOS, recherche identique à la
sélection de l'outil, panne relayée avec son message, et charge « aucun projet ». Il
est gardé par la variable `MEM0_MEMOIRE_RECIPE` et se lance par :

```bash
MEM0_MEMOIRE_RECIPE=1 swift test --filter iosMemoireRecipe
```


### Statistiques depuis l'iPad

La section **Statistiques** de l'app est en **lecture seule** : elle affiche la
consommation des runs du projet choisi, par feature — slug, modèle, durée, tours,
tokens envoyés et tokens reçus — puis la ligne « Total du projet », somme des
features LISTÉES. Aucun montant, aucun geste de pilotage d'un run. Les mots
affichés (« Tokens envoyés », « Temps passé », « Tours », « Total du projet ») sont
ceux de la fenêtre macOS : ils viennent du noyau partagé `ConsoleCore`.

Recette PAS À PAS (chacun des gestes donne l'attendu observable et le mot exact) :

1. **Appairer** l'app au Mac (feuille de connexion) : la zone d'état affiche
   « Connecté à … », et la section Statistiques montre un bref indicateur
   d'activité puis son tableau. *(hors appairage, la section affiche le bandeau
   d'attente « Non appairé » / « Mac absent — … » et n'émet aucun relevé)*
2. **Choisir un projet** — le sélecteur en haut de la section propose les projets
   connus du Mac, dans l'ordre de la coque (le libellé du dépôt, jamais une clé) ;
   il affiche celui que le Mac sert. Choisir un autre projet : quelques secondes
   plus tard le tableau devient celui de ce projet.
3. **Comparer avec le Mac** — ouvrir la fenêtre **Statistiques** macOS sur le même
   projet : chaque feature de l'app porte les MÊMES tokens d'entrée et de sortie,
   le même modèle, la même durée et le même nombre de tours ; la ligne « Total du
   projet » égale la somme des tuiles macOS.
4. **Vérifier le masquage** — une feature du plan sans run lisible n'apparaît pas
   comme une ligne à zéro : elle est comptée en pied, « N feature(s) du plan sans
   données », exactement comme sur macOS.
5. **Observer un run vivant, sans aucun geste** — pendant qu'une feature tourne
   sur le Mac, rester sur la section : sa durée (et le total du projet) avancent à
   la seconde, sans toucher à l'écran et sans que le Mac reçoive une requête par
   seconde (le client ne relit qu'à l'apparition, au changement de projet, à un
   nouvel état du magasin et à une mise à jour de session).
6. **Vérifier l'absence de geste** — aucune ligne de feature n'est cliquable :
   démarrer, reprendre ou arrêter un run reste le geste des sections Pipelines et
   Projet. Aucun montant en argent n'est affiché nulle part.
7. **État dégradé** — couper le Mac (ou l'interrupteur du service d'API) : la
   section passe au bandeau `attention` portant l'état de la connexion et son
   affichage cesse d'avancer ; un échec de relevé affiche un bandeau `danger`
   portant le message servi et un bouton « Réessayer ».

Recette OUTILLÉE : le test Swift gated `iosStatistiquesRecipe`
(`omp-console/Tests/OMPConsoleTests/IOSStatistiquesRecipeTests.swift`) exerce
contre une coque réelle les parties automatisables — relevé du projet, parité avec
le tableau publié par la fenêtre macOS, masquage d'une feature sans run lisible,
avancement d'une durée vivante et absence de montant dans la charge utile. Il est
gardé par la variable `MEM0_REMOTE_RECIPE` et se lance par :

```bash
MEM0_REMOTE_RECIPE=1 swift test --filter iosStatistiquesRecipe
```
