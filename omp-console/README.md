# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : **une seule fenêtre**, une barre latérale à dix sections en deux
groupes — **Pilotage** (**Accueil**, **Pipelines**, **Projet**, **Audit**,
**Session OMP**, **Terminal**) et **Consultation** (**Sessions**, **Fichiers**,
**Mémoire**, **Statistiques**), raccourcis ⌘1…⌘9 puis ⌘0 pour la dixième — et un panneau de détail. Rien n'ouvre de
fenêtre annexe : l'app est utilisable entièrement en plein écran (une session
ouverte depuis **Sessions** est poussée dans la section, avec un bouton retour).
Les fenêtres ne se regroupent pas en onglets : Présentation et Fenêtre n'ont
aucune entrée d'onglet, et aucun menu ne montre de séparateur en tête, en fin ou
en double.
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
- **Un service local en marche** pour les sessions : l'app est **cliente** d'une
  API REST locale servie par `omp-mem0-req` (jeton et port dans
  `~/.omp/agent/pipeline/service.json`). L'app n'en lance **aucun** process :
  service absent ⇒ « service arrêté » et un bouton « Réessayer » (voir « Piloter
  le service »).
- **Rien d'autre à installer** : ni `omp`, ni Docker, ni podman, ni conteneur —
  l'app installe son `omp` et démarre son service mémoire au premier lancement
  (voir « Composants de l'app » et « Service mémoire »). Restent hors périmètre,
  mais SIGNALÉS par l'app quand ils manquent : **oMLX** (natif, port 8000),
  **git** et **gh**.

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
     n'interrompt RIEN — la préparation continue et l'Accueil garde un bandeau
     « Reprendre… » ; `↩` déclenche le bouton proéminent.
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
     dans le presse-papiers, et le bandeau de l'Accueil (relayé à l'iPhone) ne
     porte que la conséquence.
   - **Import avec rejets** : la ligne « Migration de la mémoire » dit le nombre
     d'éléments laissés de côté et leurs raisons ; le pied propose « Basculer
     quand même », « Réessayer » (`↩`) et « Fermer » (voir « Migration unique de
     l'ancienne mémoire »).

   À la fin de toute la préparation, la feuille se ferme d'elle-même. Rien ne
   dépend d'un `omp` système.
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
   qu'une racine git), désigné par son **nom de dossier** comme sur iOS
   (`KanbanLaunchRepos.choices` : « nom (parent) » pour les seuls homonymes, jamais
   de chemin ; la valeur lancée reste la racine complète), les deux **modèles**
   (`Modèle /req et /specs` / `Modèle /impl et /review`, chaque liste menée par
   `défaut OMP (aucun modèle)` puis les modèles de `omp models --json` par leur
   **nom lisible** — « nom (fournisseur) », sinon « nom (id) », quand deux modèles
   portent le même nom ; l'identifiant brut à défaut de nom), le titre et le besoin.
   « Lancer » (↩, bouton par défaut) poste une commande `launch` au service, ferme
   la feuille et mène à **Pipelines**, comme sur iOS — depuis toute section, jamais
   à l'Accueil.
4. **Le service** — l'app ne lance **aucun** process `omp` pour les sessions :
   elle lit l'enregistrement `service.json` du service local (jeton, port), crée
   les sessions par l'API et poste les commandes. Un dépôt sans pilote vivant se
   réveille par `POST /v1/repos/{repo}/pilot` : le service crée ou adopte son
   conducteur, un seul par dépôt, et il vit tant que le service vit.
5. **À vous** — les questions de l'agent, les jalons et les pipelines en échec ou
   bloquées arrivent en tête de l'Accueil, en cartes (badge sur « Accueil ») :
   « Répondre… » ouvre la feuille
   « Répondre » — une question `ask` en vol se répond par ses options ou un texte
   libre, une question en **texte** d'un maillon terminé par un texte (commande
   `reply`) ; « Valider les specs » et « Accepter la revue » agissent depuis la
   carte, et « Lire le contrat » (secondaire) ouvre la feuille **Contrat** pour un
   besoin ou des specs à valider. Sous « À vous », l'Accueil range ensuite, chaque
   pipeline dans UNE seule section : « En cours » (réellement en marche, avec sa
   durée), « À reprendre » (en pause) et « Pas commencées » (jamais lancées), ces
   deux dernières masquées quand elles sont vides. La PR livrée apparaît sous « Livrées récemment »
   avec « Ouvrir la PR » et l'état réel de la PR (« PR ouverte », « PR fusionnée »,
   « PR fermée », ou « PR créée » tant que GitHub n'a pas répondu) ; une PR
   fusionnée ou fermée depuis plus de 7 jours en sort.
6. **Reprendre** — une pipeline dont le pilote est mort (service arrêté, session
   fermée) est « En pause » sous « À reprendre » avec « Reprendre », qui poste
   `POST /v1/repos/{repo}/pilot` ; le service réveille un conducteur qui adopte le
   lot. Une feature de lot en échec ou bloquée est une carte « En échec » /
   « Bloquée » de « À vous », qui nomme l'étape arrêtée (« L'étape
   « Implémentation » s'est arrêtée en échec. ») sans aucun texte d'erreur brut ;
   son « Reprendre » poste la commande `relaunch`, le service reprend le maillon
   arrêté et la carte passe sous « En cours » à l'instantané suivant. Les runs
   d'historique et les échecs de projet sans feature de lot restent dans
   Pipelines › Arrêtées.

**La mémoire survit à ⌘Q** : le service mémoire est un agent launchd
(`com.omp.console.mem0-rs`), pas un process de l'app — le Quitter de l'app ne le
touche pas. Fermer l'app (ou la voir plantée) ne coupe donc pas la mémoire : une
session `omp` au terminal, ou un `omp -p`, sur un dépôt reçoit toujours son rappel
par `http://localhost:8321` (le défaut du plugin `omp-mem0-memory`).

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
| Terminal | « Choisir… » (`terminal.choose`), « Relancer » (`terminal.relaunch`), « Lancer OMP » (`terminal.launchOmp`) — trois groupes séparés |
| Session OMP | l'état en pilule Liquid Glass teintée (`session.status` : « Prête », « Active »…), menu du projet (nom du dossier, « Choisir un dossier… » ⌘O), puis UNE action selon l'état : « Lancer la session » (`session.launch`, ⌘R), « Relancer » (`session.relaunch`, ⌘R) ou « Arrêter la session » (`session.stop`, ⌘.) ; « Détails techniques » (`session.details`) ; quand le service est arrêté, la fenêtre affiche « service arrêté » avec un bouton « Réessayer » |
| Projet | la pilule d'état de la session (`projet.sessionStatus`), « Arrêter le pilotage » (`projet.close`, inactif hors démarrage et pilotage actif), « Détails techniques » (`projet.details`), seulement pendant un pilotage |
| Audit | « Lancer un audit… » (`audit.start`) |
| Statistiques | sélecteur « Projet » (`stats.project`), quand le tableau ou l'état « Aucune donnée » est affiché |
| Sessions, session ouverte | bouton retour vers la liste ; l'état du fil en pilule Liquid Glass teintée de sa couleur (`viewer.status` : « En direct » vert, « Démarrage » bleu, « Erreur de lecture » rouge) ; aucune pilule quand le run de la session est fini (« Terminé » reste porté par la ligne de la liste) ; hors du direct, le bouton « Revenir au direct » (`viewer.returnToLive`) à sa place |

Identifiants de l'Accueil et des feuilles : `home.loading`, `home.firstRun`
(bouton `home.firstRun.start`), `home.ompMissing.background` (fond « OMP Console
prépare ses composants »), `home.setupBanner` (bandeau « Reprendre… »),
`home.dashboard`,
`home.notificationsBanner` (`home.notifications.openSettings`,
`home.notifications.ignore`), `home.launchBanner`, `home.attention.<carte>`
(boutons `home.attention.<carte>.action` et `home.attention.<carte>.contract`),
`home.running.<carte>`, `home.paused.<carte>` (bouton `home.resume.<carte>`),
`home.notStarted.<carte>`, `home.delivered.open.<carte>`, `home.allPipelines` ;
feuille « Préparation d'OMP Console » `sheet.setup` (`sheet.setup.install`,
`sheet.setup.retry`, `sheet.setup.switchAnyway`, `sheet.setup.quit`,
`sheet.setup.close`, `sheet.setup.ompMissing`, `sheet.setup.retryMissed`, lignes
`sheet.setup.row.<components|migration|service|prerequisites>`, bloc de
progression `sheet.setup.progress` avec `sheet.setup.progress.label` et
`sheet.setup.progress.bar`, échec `sheet.setup.failure`, rejets de l'import
`sheet.setup.rejected` (choix `sheet.setup.rejected.choice`),
`sheet.setup.detail.toggle`, `sheet.setup.detail`, `sheet.setup.diagnostic`) ;
feuille Bienvenue `welcome.sheet` (`welcome.continue`) ;
feuille « Répondre » `answer.sheet` (`answer.question`,
`kanban.actions.options`, `answer.text`, `answer.submit`, `answer.cancel`) ; feuille
**Contrat** `contract.sheet` (corps `contract.sheet.body`, fermeture
`contract.sheet.close` ; contrat absent ou illisible : une phrase sans chemin, puis
« Copier le diagnostic » `contract.sheet.diagnostic`, qui emporte le chemin lu et la
taille ou la raison du système) ; feuille
« Nouvelle feature » `launch.sheet`,
`launch.repo`, `launch.chooseFolder`, `launch.repoError`, `launch.title`,
`launch.description`, `launch.cancel`, `launch.submit` ; les deux sélecteurs de
modèle `models.reqSpecs` / `models.implReview` (`models.loading`,
`models.failure`, `models.retry`) ; feuille d'édition des modèles `models.sheet`
(`models.cancel`, `models.apply`). Une seule feuille à la
fois, dans l'ordre : Préparation d'OMP Console, Contrat, Bienvenue, Nouvelle feature,
répondre (`MainSheetPolicy`).

Les symboles purement décoratifs de l'Accueil et de la feuille Bienvenue (pastille
de nature d'une carte d'attente, symbole d'étape d'une ligne « En cours », « À
reprendre » ou « Pas commencées », flèche d'une ligne livrée, cloche du bandeau des
notifications, symboles des promesses)
sont muets pour VoiceOver (`.accessibilityHidden(true)`) : les sous-arbres
`home.dashboard`, `home.firstRun`, `home.ompMissing.background` et `welcome.sheet`
n'exposent aucun `AXImage`, et le texte voisin reste annoncé.

Le badge d'état des composants embarqués, au pied de la barre latérale, est
`components.badge` (mot + point teinté) ; son état ne dépend que de la présence
des deux binaires sous la racine de l'app. Quand un composant manque, c'est un
bouton (AXButton) qui rouvre la feuille de préparation.

Lancer le bundle depuis un dépôt l'ouvre comme projet ; pour une capture sur un
magasin de démonstration, sans écrire de préférence :

```bash
cd <dépôt> && MEM0_PIPELINE_STATE_DIR=/tmp/demo/state \
  "<chemin>/omp-console/build/OMP Console.app/Contents/MacOS/OMPConsole" -home.welcomeSeen YES
```

(`-home.welcomeSeen NO` remontre la bienvenue sur un magasin vide.)

Le crochet de recette `-home.recipe <dashboard|menuBar|pausedOnly>` pose l'ardoise
de la fixture partagée `HomeParity` dans l'Accueil ET dans l'item de barre de
menus, sans abonnement au magasin ni notification : `dashboard` = 5 « À vous »,
2 « En cours », 1 « À reprendre », 1 « Pas commencées », 2 livraisons ;
`menuBar` = 1 « À vous » et 2 « En cours » ; `pausedOnly` = une pause et une
feature pas commencée seulement. Il n'agit que si `OMP_CONSOLE_SUPPORT_ROOT` est
posée et non vide, jamais sur la racine réelle :

```bash
open -g -n "<chemin>/omp-console/build/OMP Console.app" \
  --env OMP_CONSOLE_SUPPORT_ROOT=/tmp/recette/support \
  --env MEM0_PIPELINE_STATE_DIR=/tmp/recette/state \
  --args -home.recipe dashboard -home.welcomeSeen YES
```

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
  pures du magasin d'état, le vocabulaire figé des sections, le socle du
  contrat de l'API distante et la politique vocale (`Voice/`, voir « Politique
  vocale (App Intents) »). Aucune dépendance (ni interne, ni externe) : elle se
  compile seule (`swift build --target ConsoleCore`) et n'importe ni AppKit ni
  UIKit — la section « Noyau partagé » de `scripts/check.sh` le tient.
  `Voice/VoiceGestureIntent.swift` est le seul fichier du noyau qui importe
  AppIntents (framework système, pas une dépendance de paquet).

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

### Recette : interface Mac automatisée

`bash scripts/recette/mac-recette-ui.sh` (sans argument) ouvre une à une les **24
surfaces** de l'app — les 10 sections de la barre latérale, puis 14 feuilles
(bienvenue, préparation, nouvelle pipeline, réponse, contrat, fiche de
carte, modèles, lancement et question de projet, question de session, ouverture
du Terminal, création, édition et lien d'un souvenir) — **à la taille minimale de
la fenêtre**, capture chacune et sonde son arbre AX. Le catalogue est
`scripts/recette/mac-recette-ui/catalogue.ts` ; fenêtres (dont Réglages › Appareils),
alertes, menus, popovers, inspecteurs et
item de barre de menus sont hors périmètre. Le script n'est appelé ni par
`scripts/check.sh` ni par la CI : il lui faut une session graphique.

Prérequis, vérifiés **avant tout lancement** par `sonde etat-ecran` (rien n'est
lancé ni activé, aucune invite système) :

- session déverrouillée ;
- écran sur le **Bureau** : sur un Space plein écran d'une autre app, l'instance
  de recette ouvrirait ses fenêtres sur le Space Bureau, illisibles et non
  capturables ; le script refuse alors (« Revenez sur le Bureau ») ;
- le terminal qui lance la recette autorisé en **Accessibilité** et en
  **Enregistrement de l'écran** (Réglages Système ▸ Confidentialité et sécurité).

Pendant le passage (**8 à 12 min**, construction comprise), ne changez pas d'app
au premier plan : le constat d'isolation la compare avant/après.

Codes de sortie, la dernière ligne de stdout portant le verdict :

| code | issue | dernière ligne |
|---|---|---|
| 0 | vert | `✓ recette Mac : vert — 24 surfaces couvertes, <e> signalement(s) excepté(s). Rapport : …` |
| 1 | défauts trouvés | `✗ recette Mac : défauts trouvés — <s> signalement(s) non excepté(s), <n> surface(s) non couverte(s), <i> exception(s) invalide(s)[, isolation rompue]. Rapport : …` |
| 2 | non exécutable | `· recette Mac non exécutable : <raison>` (macOS absent, sonde non compilée, écran refusé, recette déjà en cours, app non construite, jeu fictif non démarré, interruption) |

Sorties dans `omp-console/build/mac-recette-ui/sortie/` (vidé à chaque passage) :
`captures/<id>.png`, `releves/<id>.json` (arbre AX : rôle, identifiant, libellés,
cadre, actions), `parcours.json`, `rapport.json` (déterministe : deux passages sur
le même code le rendent identique octet pour octet) et `rapport.md` (lisible, avec
les cadres, les tailles de fenêtre et la section Isolation). La sonde compilée
(`scripts/recette/mac-recette-ui/sonde.swift`) est mise en cache sous
`omp-console/build/mac-recette-ui/` et ne se recompile que si sa source change.

Règles (seuil HIG macOS) : un élément **hors de la zone visible** de la surface
(hors zone défilante, plus d'1 pt de débord), un **identifiant d'accessibilité
dupliqué**, une **cible cliquable de moins de 20 × 20 pt** (20 × 20 exact passe).
Une surface qui ne s'ouvre pas est **non couverte**, avec sa raison, et le verdict
n'est jamais vert.

**Isolation.** Chaque surface tourne dans une instance NEUVE d'une copie du bundle
rebaptisée `com.omp.console.recette` (`/tmp/omp-console-recette-ui`), marquée app
accessoire (`LSUIElement` : sans icône dans le Dock, le Dock ne la passe pas au
premier plan quand sa fenêtre paraît), lancée par `open -g -n -F` avec le crochet
`-surface.recipe <id>` (`SurfaceRecipe.swift`, inerte sans
`OMP_CONSOLE_SUPPORT_ROOT`), un magasin, un support, un dossier
d'alertes et des préférences jetables, et un jeu de données fictif fixe servi sur
`127.0.0.1` (service OMP, service mémoire, oMLX ; `gh` coupé). Votre instance
`com.omp.console` n'est jamais relancée, activée ni visée ; ses pids, l'app au
premier plan et l'empreinte de `defaults export com.omp.console` sont relevés
avant et après, et toute activation d'OMP Console pendant le passage est
consignée : une isolation rompue rend le verdict « défauts trouvés ». Le
nettoyage (toujours, y compris sur ⌃C) retire la racine, le domaine
`com.omp.console.recette` et son inscription LaunchServices.

**Exceptions.** `scripts/recette/mac-recette-ui/exceptions.json` :

```json
{"version":1,"exceptions":[{"surface":"<id du catalogue>|*","regle":"hors-ecran|identifiant-duplique|cible-trop-petite","element":"<clé du rapport>","justification":"faux positif : … | défaut connu, à corriger hors de cette feature : …"}]}
```

Une entrée sans justification, de surface ou de règle inconnue, ou en doublon est
**invalide** (le verdict n'est pas vert) ; une entrée qui n'excepte plus rien est
listée « sans objet » sans changer le verdict. `"surface": "*"` n'est admis que
si la même règle et la même clé sont signalées sur toutes les sections. Une
surface non couverte ne s'excepte pas.

**Passage réel (2026-10-11).** Sur le Bureau du poste de référence, deux passages
consécutifs sont verts (sortie 0, environ 3 min chacun, construction en cache)
avec des `rapport.json` identiques (`cmp`) : 23 surfaces couvertes, 67
signalements exceptés par les 53 entrées de `exceptions.json`. Les faux positifs
sont des contrôles système à leur taille AppKit (en-têtes de section, triangles
de divulgation, zones « page suivante » des barres de défilement) et des
identifiants internes (`ListColumn`, `NSOutlineViewDisclosureButtonKey`).
Restent, en défauts connus :

- à la taille minimale, Session OMP (920 pt), Fichiers (981 pt) et Mémoire
  (1021 pt) débordent la fenêtre de 760 pt et sont rognés des deux côtés
  (`session.send` hors de la fenêtre) ;
- deux cibles de 16 pt de haut : « Tout afficher » de l'Accueil et l'en-tête
  « Livrées » de l'ardoise ;
- des identifiants dupliqués : `models.reqSpecs` et `models.implReview` (sélecteur
  et libellé), `stats.chart` (les deux graphiques et leurs titres).

Le premier passage avait aussi trouvé trois défauts de l'app, corrigés depuis :
plantage de « Projet » en pilotage dans une fenêtre basse, trames SSE du service
jamais délivrées tant que le flux reste ouvert (question de Session OMP absente),
badge des composants figé sur « manquants » après l'installation. Il avait aussi
mis en évidence le vol de focus par le Dock au lancement, qui a disparu avec la
copie accessoire. Pour un nouveau signalement : l'inspecter dans `rapport.md` avec
sa capture et son relevé, puis le corriger ou ajouter son entrée justifiée.

## Lire le magasin d'état

`Sources/OMPConsole/Store/` est la **couche de lecture** du magasin d'état partagé
(`~/.omp/agent/pipeline/`, ou `MEM0_PIPELINE_STATE_DIR`) : les huit répertoires
`running`, `history`, `lots`, `projects`, `inbox`, `audit`, `audits` et `journal`
sont rendus en modèles Swift typés, en parité avec le lecteur TypeScript de
`omp-mem0-req` (`omp-mem0-req/store.ts`, `lot.ts`, `project.ts`,
`auditRecord.ts`, `context.ts`).

- `StoreReader` lit une racine et une horloge injectables ; une entrée au schéma
  incomplet est **écartée et nommée** (`discardedEntries` : le fichier
  `<store>/<nom>` et la raison — `JSON illisible` ou `schéma incomplet ou
  inconnu`), jamais rendue partielle ; `availability` distingue « magasin absent »
  de « magasin vide » pour chaque store, et `StoreSnapshot.root` porte la
  disponibilité de la **racine** elle-même.
- `StoreWatcher` veille un store par **notification du système de fichiers**
  (source vnode sur le répertoire, jamais de scrutation) et pousse un instantané
  typé à ses abonnés (`AsyncStream`, multicast) ; `StoreHub` les agrège en un
  flux global. L'émission n'a lieu que si l'instantané a changé.
- `audits/` (un `<id>.json` par audit lancé depuis la section Audit) et
  `journal/` (un `<repoKey>.jsonl` par dépôt) forment UNE enveloppe,
  `StoreSnapshot.audits` : les audits, puis les décisions de l'arbitre prises
  dans le contexte d'un audit (`context` = sa clé, source contexte ou
  arbitrage). Une ligne ajoutée à un journal existant ne réveille pas la veille
  de son répertoire : `StoreHub` relit donc l'enveloppe aussi à chaque écriture
  de `lots/`, que toute décision de l'arbitre suit. `ConsoleCore/Audit/` en
  dérive l'ardoise partagée Mac et iPhone (`AuditBoard.of`), sur la fixture
  `AuditParity`.
- La couche est un **lecteur** : aucune API d'écriture n'est appelée, jamais — un
  propriétaire mort est marqué (`isStale`), ni retiré ni déplacé vers `history/`.

`commands/` ne fait pas partie du périmètre **lu** par la couche `Store/`. La
section **Kanban** consomme le flux global en lecture, et c'est la couche
`Actions/` (voir « Agir depuis Pipelines ») qui écrit — et seulement deux
familles : les livraisons d'un run (dans `<stateDir>/inbox/`) et les commandes
postées au service (`POST /v1/repos/{repo}/commands`).

### Liste des attentes

`ConsoleCore/Pending/PendingRequests.swift` dérive, en fonction **pure** (ni E/S,
ni horloge), la liste de toutes les demandes qui posent une question à
l'utilisateur : `PendingRequests.list(PendingSources)`. Le Mac et l'iPhone la
calculent des mêmes données transportées et obtiennent la même liste. Quatre
sources y entrent :

- **l'ardoise** (`KanbanBoardState`) : les cartes des colonnes « question en vol »
  (question `ask` du run, sinon question en texte `waitPrompt`), « jalon specs » et
  « jalon revue ». Les cartes en échec ou bloquées n'y entrent jamais, même
  relançables. Une carte au pilote arrêté (« En pause ») y figure, marquée
  `paused`, avec la reprise pour geste ;
- **les dialogues de la conduite de projet** (`GET /v1/conduite`) ;
- **les dialogues de la session hébergée** (`GET /v1/session`) ;
- **les escalades d'audit** (`AuditBoard.of(snapshot)`).

Deux exclusions évitent de compter une question deux fois ou trop tôt. Une carte
dont la feature est en arbitrage (`arbitration`) est écartée, car l'arbitre décide.
Une carte dont l'escalade figure déjà comme escalade d'un audit du magasin est
aussi écartée : elle n'est listée qu'une fois, comme escalade.

Chaque attente porte sa nature, sa question, ses options verbatim et son geste de
réponse (`PendingReply`). Ce geste est une donnée, la route à appeler : rien n'est
exécuté ici. L'identité est stable d'une lecture à l'autre et unique par question.
Elle est préfixée par la nature : `ask:<carte>:<toolCallId>`,
`reply|specs|review:<carte>:<sinceAt>`, `conduite|session:<dlg-N>:<at>` et
`audit:<audit>:<clé>`. Une nouvelle question sur la même carte, un nouveau
dialogue ou une nouvelle escalade reçoivent donc une nouvelle identité.

L'ancienneté (ms epoch) vient elle aussi des données transportées. C'est
`updatedAt` du run pour une question en vol, `sinceAt` de la feature pour une
question en texte ou un jalon, `at` du dialogue (0 quand le service ne l'a pas
posé) et `at` de l'escalade. La liste va de la plus ancienne à la plus récente ;
à ancienneté égale, l'identité comparée octet par octet (UTF-8) départage.
Fixtures et tests : `Tests/OMPConsoleTests/PendingFixtures.swift` et
`PendingRequestsTests.swift`. Le calcul local du Mac
(`Sources/OMPConsole/Pending/LocalPendingRequests.swift`) et celui de l'iPhone
(voir « API distante ») sont confrontés sur la vraie pile par
`PendingRequestsParityTests.swift`.

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

Les treize colonnes de l'ardoise (`KanbanColumn`, parité avec `/pipelines`) restent
le modèle, mais l'écran les regroupe en **voies** (`KanbanLane`) qui suivent le
cours d'une feature, de même largeur, sur toute la largeur de la fenêtre (elles
ne défilent horizontalement que sous 240 pt par voie) :

| Voie (`kanban.lane.<rawValue>`) | Colonnes |
|---|---|
| Pas commencées (`pas-commencees`) | `en-attente` |
| En cours (`en-cours`) | `en-cours`, et toute carte que « Reprendre » peut relancer (en pause) |
| À vous (`a-vous`) | `question-en-vol`, `jalon-specs`, `jalon-review` |
| Livrées (`livrees`) | `pr-ouverte`, `pr-creee`, `fusionne`, `pr-fermee`, `terminee-sans-pr` |
| Arrêtées (`arretees`) | `echec`, `bloquee`, `annulee-retiree` |

Dans une voie, les cartes suivent l'ordre des colonnes (question, puis specs, puis
revue), puis l'ordre de l'ardoise.

Comme sur iPhone (règle partagée `KanbanLaneRows.rows(…, layout: .condensed, …)` de
ConsoleCore ; l'iPad garde `.full`, toutes les voies dépliées), une voie **sans
carte n'est pas rendue** et la largeur égale se partage entre les voies affichées ;
« Livrées » et « Arrêtées » s'ouvrent **repliées** — en-tête, compteur et chevron,
sans carte. Leur en-tête (`kanban.lane.<rawValue>.header`, porté aussi par les
voies non repliables) est un bouton : un clic, ou Espace / ↩ au clavier, les
déplie ; VoiceOver lit « replié » / « déplié ». Le repli est **remis à chaque
visite** de Pipelines (quitter la section le réinitialise ; une feuille ouverte
par-dessus, non). Les flèches ne parcourent que les cartes visibles, et
sélectionner une carte d'une voie repliée (notification comprise) la déplie.
Une ardoise sans aucune carte affiche la vue vide `kanban.empty`.

Une carte livrée avec PR (feature de lot `done` portant une `prUrl`, feature de
projet `pr` ou `merged`) porte l'**état réel** de sa PR lu sur GitHub par le Mac :
« PR ouverte », « PR fusionnée » ou « PR fermée ». Tant que cet état est inconnu
(hors ligne, `gh` absent, échec de lecture), elle porte « PR créée » — jamais « PR
ouverte » par défaut ; seule une feature de projet que le magasin dit déjà `merged`
reste « PR fusionnée » sans fait GitHub. L'état GitHub prime toujours sur le statut
du magasin.

Le Mac lit cet état par `gh pr view --json state,mergedAt,closedAt -- <url>` (20 s
au plus par appel, quatre `gh` simultanés au plus), et le tient dans un registre
unique en mémoire (`PullRequestStateBook`) : toutes les URLs au premier instantané
du magasin, puis chaque URL nouvelle une fois, puis à chaque rafraîchissement
manuel — qui relit tout sauf les PR déjà fusionnées (état terminal). Aucune
minuterie, aucune écriture sur disque. Une lecture en échec retire le fait : la
carte repasse en « PR créée ». Sans `gh` (`OMP_CONSOLE_GH_BINARY` compris), rien
n'est lu. Le rafraîchissement manuel est le bouton **Rafraîchir** de la barre
d'outils (`kanban.refresh`, ⌘R), désactivé pendant une relecture ; aucun message
d'erreur ni de confirmation, le retour visible est le libellé des cartes. L'app
iOS reçoit les mêmes faits par la trame `pull-request-states` et dérive la même
ardoise ; elle demande une relecture à chaque ouverture du flux (lancement,
reconnexion) et quand on tire l'écran Pipelines vers le bas (« tirer pour
actualiser », qui relit aussi l'ardoise) ou tape ⌘R « Actualiser » au clavier de
l'iPad (actif seulement connecté) ; la barre de l'écran ne porte aucun bouton ↻.

« Livrées » est bornée à **7 jours** pour les seules livraisons closes (PR
fusionnée, PR fermée, livraison sans PR) : une carte close depuis plus de 7 jours
(`KanbanBoard.deliveredWindowMs`) quitte l'ardoise, Accueil compris. La date de
référence est la date de fusion ou de fermeture lue sur GitHub, sinon la fin de la
pipeline, sinon la date de la feature de projet ; une carte « PR ouverte » ou « PR
créée » reste quel que soit son âge.

Les clôtures de `history/` (omp-mem0-req en écrit une par maillon) ne font pas de
carte à part : une clôture dont le `cwd` réel est le worktree d'une feature de lot
devient une **source** de la carte de cette feature. Les autres sont groupées par
`cwd` réel, et chaque groupe fait UNE carte, celle de la clôture la plus récente
(« Terminée », ou « Échec » si elle a échoué).

Recette sur le magasin RÉEL (manuelle, gatée par `MEM0_LIVREES_RECIPE`) : la pile
Mac de test (`RemoteStack`, même `KanbanModel` que l'app, lecteur `gh` réel) sert une
COPIE du magasin et imprime `PORT`, un `CODE` d'appairage toutes les 90 s, puis
chaque carte de « Livrées » (`<id>\t<titre>\t<pastille>`) après la première relecture
et à chaque changement des faits. `MEM0_LIVREES_OFFLINE=1` résout `gh` sur
`/nonexistent` (tout en « PR créée ») ; `MEM0_LIVREES_STORE` change la copie servie,
`MEM0_LIVREES_SECONDS` la durée (1800 s). Lancer sous un pty (sortie tamponnée dans
un tube), puis appairer un simulateur privé lancé avec
`-client.manualAddress 127.0.0.1:<PORT>` :

```bash
cp -R ~/.omp/agent/pipeline /tmp/livrees-store
cd omp-console && MEM0_LIVREES_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
  --filter recetteLivreesServeLeMagasinReel -Xswiftc -plugin-path \
  -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
```

Une carte montre son titre (sans le préfixe « dépôt/ » des runs hors lot), son
dépôt (seulement quand l'ardoise mêle plusieurs dépôts), ses deux **modèles**
(`Modèle /req et /specs : <A>` puis `Modèle /impl et /review : <B>`, le nom lisible
du catalogue, l'identifiant brut à défaut, ou `défaut OMP`, une ligne par
groupe, coupées au milieu), un badge quand la voie ne
dit pas déjà son état (« Question », « Spécifications à valider », « En pause », « PR
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
ouvre une bulle « Problèmes détectés » (`kanban.diagnostic`) qui dit chacune par
une phrase de conséquence (« mem0-omp/cache-sessions s'est arrêtée de façon
inattendue et n'avance plus. »), suivie d'un geste : le bouton « Reprendre »
quand le pilote d'un lot est mort et qu'une de ses cartes offre la reprise
(la première par identifiant), sinon une consigne écrite (« Relancez-la depuis
OMP, dans son dépôt. »). Le fichier et le pid ne sont jamais affichés : le bouton
**Copier le diagnostic** (`kanban.diagnostic.copy`) met dans le presse-papiers le
détail brut de chaque anomalie, une par ligne (« propriétaire mort —
running/<id>.json : pid 1234 »). Le bouton
« Activité » (`kanban.activityButton`) ouvre le journal des gestes dans une bulle ;
« Rafraîchir » (`kanban.refresh`, ⌘R) relit l'état des PR sur GitHub.
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
**Contrat** s'ouvre), **Informations** (étape, durée, les deux modèles `Modèle /req
et /specs` / `Modèle /impl et /review` par leur nom lisible, l'identifiant brut à
défaut, avec un bouton **Modifier…**, lien de PR) et un pli **Détails
techniques** replié. En bas : « Arrêter… » (destructif, confirmé) à gauche,
« Fermer » (Échap) à droite. Le menu contextuel d'une carte expose aussi ses
gestes (Afficher les détails, Lire le contrat, **Modifier les modèles…**, Répondre…,
Valider les specs, Accepter la revue, Reprendre, Ouvrir la PR, Arrêter…). Le bouton
**Modifier…** et l'entrée « Modifier les modèles… » ouvrent la feuille
d'édition `models.sheet` (titre `Modèles de <slug>`, les deux sélecteurs
pré-positionnés sur les valeurs courantes et libellés comme ceux de la feuille
Nouvelle feature, `Annuler` / `Appliquer`).

### Identifiants d'accessibilité

| Identifiant | Surface |
|---|---|
| `kanban.board` | la zone des **voies** (focus clavier et flèches) |
| `kanban.lane.<rawValue>` | une voie |
| `kanban.lane.<rawValue>.header` | l'en-tête d'une voie (bouton qui replie / déplie « Livrées » et « Arrêtées ») |
| `kanban.card.<id>` | une carte (`feature:<clé>:<slug>`, `project:<clé>:<slug>`, `run:<id>`, `history:<id>`) |
| `kanban.activityButton` | le bouton « Activité » de la barre d'outils |
| `kanban.refresh` | le bouton « Rafraîchir » de la barre d'outils (⌘R, relit l'état des PR) |
| `kanban.diagnosticButton` | le bouton « n problème(s) » de la barre d'outils (absent sans anomalie) |
| `kanban.diagnostic` | la bulle « Problèmes détectés » |
| `kanban.anomaly.<i>` | la phrase d'une ligne d'anomalie dans la bulle |
| `kanban.anomaly.<i>.resume` | le bouton « Reprendre » d'une ligne (lot mort reprenable) |
| `kanban.anomaly.<i>.instruction` | la consigne d'une ligne (aucune action de l'app ne règle le cas) |
| `kanban.diagnostic.copy` | le bouton « Copier le diagnostic » de la bulle (détail brut, pid compris) |
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
`POST /v1/repos/{repo}/pilot` sur une pipeline en pause, et la commande `relaunch`
sur une carte « En échec » / « Bloquée » de l'Accueil.

| Geste | Où | Écrit |
|---|---|---|
| Répondre à une question de l'agent (option ou texte libre) | section « Action » de la feuille de détail, menu contextuel « Répondre… » de la carte, ou feuille « Répondre » de l'Accueil | une livraison `ask` dans la boîte publiée du run |
| Envoyer un message à l'agent (exécution vivante sans question) | section « Action » de la feuille de détail | une livraison `text` dans la boîte publiée du run |
| Valider les specs | feuille de détail, menu contextuel ou carte « À vous » de l'Accueil (feature en attente specs) | `POST /v1/repos/{repo}/commands` — `{kind:"verdict", verdict:"v"}` |
| Lire le contrat (besoin ou specs à valider) | carte « À vous » de l'Accueil (secondaire), zone d'action de la feuille de détail, menu contextuel de la carte | rien : la console lit `<worktree>/.omp/pipeline/contract.md` et ouvre la feuille Contrat |
| Accepter la revue | feuille de détail, menu contextuel ou carte « À vous » (feature en attente revue) | `POST /v1/repos/{repo}/commands` — `{kind:"verdict", verdict:"y"}` |
| Répondre à une question en texte d'un maillon terminé | feuille de détail ou feuille « Répondre » (feature en attente de réponse, sans question en vol) | `POST /v1/repos/{repo}/commands` — `{kind:"reply", slug, text}` |
| Reprendre | feuille de détail, menu contextuel ou ligne « À reprendre » de l'Accueil (carte marquée `mort`, feature vivante) | rien de plus : `POST /v1/repos/{repo}/pilot` réveille le conducteur du service |
| Reprendre une pipeline en échec ou bloquée | carte « En échec » / « Bloquée » de « À vous » (feature de lot `failed` ou `blocked`) | `POST /v1/repos/{repo}/commands` — `{kind:"relaunch", slug}` |
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

**Sans projet choisi** (la préférence `session.projectRoot` absente ou vers un
dossier disparu), la section affiche « Aucun projet ouvert » — « Choisissez le
projet dont vous voulez parcourir les fichiers. » — et un bouton **Choisir un
projet…** (`files.chooseProject`). Le même bouton porte l'état vide de
**Mémoire** et du **Terminal** : quand l'app connaît des projets (les dépôts des
lots et des projets du magasin, la liste même de `GET /v1/repos`), il ouvre un
menu d'une entrée par projet — nommée par son dossier, « nom — dossier parent »
quand deux projets portent le même nom —, puis « Choisir un dossier… » ; quand
elle n'en connaît aucun, c'est un bouton simple qui ouvre directement le panneau
de **Session OMP** (« Choisissez le dossier du projet à héberger. »). Le choix
devient le projet de l'app, exactement comme un choix fait dans Session OMP, et
remplit l'écran courant sans changer de section. Un panneau annulé, ou un projet
dont le dossier a disparu entre-temps (il sort alors du menu), laisse l'état vide
tel quel.

1. **Choisir la cible** — le sélecteur « Dossier » de l'en-tête. La cible par défaut
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
  croix rouge (erreur). Un appel d'outil resté sans résultat dans une session finie
  affiche « Interrompu » (icône fixe) au lieu de l'indicateur d'activité
  (`ToolCallStatus.of(_:sessionEnded:)` du noyau, dans tous les fils : visionneuse,
  Session OMP et Projet sur Mac, feuille Sessions et Session OMP sur iOS).
  Déplié, il montre arguments, résultat et diff dans un bloc
  opaque ; les longues lignes défilent en largeur, le fil seulement en hauteur.
- **Les arguments d'un appel se lisent en clé/valeur** (`ToolArgumentsView`, sur la
  lecture partagée `ToolArguments` de `ConsoleCore`), jamais en JSON brut : une
  ligne « libellé : valeur » par membre, les objets et listes imbriqués en
  hiérarchie indentée (éléments de liste numérotés dès 1), les booléens rendus
  « oui »/« non », les clés dans l'ordre de l'appel tel que le fichier l'écrit
  (`ToolCall.argumentsText`, relu par `OrderedJSON`). Les clés de read, write,
  edit, bash, grep et glob portent un libellé français (« Fichier », « Commande »,
  « Motif »…) ; tout autre outil, et toute clé sans libellé, garde son nom brut.
  Le code (commande bash, contenu écrit, ancien/nouveau texte d'un edit, motif
  grep/glob) est à chasse fixe, le reste en police système. Une valeur de plus de
  4 lignes ou 280 caractères montre un extrait et **« Afficher plus »**. Un appel
  sans argument dit « Aucun argument », des arguments qui ne sont pas un objet
  JSON « Arguments illisibles » ; le JSON brut reste consultable, replié, derrière
  **« Afficher le détail brut »**. Le résultat de l'appel est rendu comme avant.
- **Diffs colorés par contenu** : tout diff unifié reçu d'un outil est détecté dans
  le texte du résultat, et le diff d'un appel d'édition d'OMP (`details.diff`) est
  classé ligne à ligne. Ajout, suppression, contexte et en-têtes sont distingués —
  par la couleur ET par la valeur d'accessibilité de chaque ligne (« ligne
  ajoutée », « ligne supprimée », « contexte », « en-tête de différences »).
- **Une question `ask` est mise en évidence, et ne se répond pas ici** : la
  visionneuse affiche la question et ses options, sans aucun geste pour y répondre.
- **Suivi automatique** : la vue ouvre le fil par la fin, puis suit les faits
  nouveaux en relisant **seulement les octets neufs** (le lecteur tient un curseur
  d'octets ; la veille est une source vnode sur le fichier, jamais une scrutation).
  Un geste vers le haut suspend le suivi — le mot `viewer.status` « En direct »
  disparaît et le bouton **« Revenir au direct »** apparaît ; l'activer reprend le
  suivi. Une session dont le run est fini (clos, ou absent du magasin) n'affiche
  jamais « En direct » ni « Démarrage », sur macOS comme sur iOS : la règle
  (`ConversationText.status(…, runEnded:)`, `RunChoice.hasEnded`) vit dans le noyau,
  et un run qui se termine pendant l'affichage fait disparaître le mot sans
  réouverture.
- **États explicites** : « En attente des premiers échanges » tant que le fichier
  n'existe pas, un bandeau rouge « Session illisible : … Nouvelle tentative
  automatique. » (`viewer.unreadable`) s'il n'est pas lisible, « Session vide » s'il
  est vide (`viewer.placeholder`). Sous le fil, `viewer.notes` dit le nombre
  d'entrées ignorées et « Fichier réécrit — affichage reconstruit » le cas échéant.
- **Une réponse déjà montrée n'est pas remontrée.** Depuis le dernier message de
  l'utilisateur, un texte de l'agent déjà affiché ne l'est plus — ni en entier, ni
  quand il revient en fin d'un message, juste après une fin de ligne (la copie
  qu'ajoute un tour automatique : l'avis `[pipeline]` est silencieux pour le
  lecteur, l'agent répond « préambule » + sa réponse précédente) : seul le préambule
  reste, les appels d'outil aussi. Un vrai message de l'utilisateur rouvre
  l'affichage. Même règle sur iOS (le constructeur de lignes est partagé) ; le
  fichier de session n'est jamais modifié.
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
`omp-console/build/OMP Console.app`, y copie l'icône `omp-console/Bundle/AppIcon.icns`
(`Contents/Resources/AppIcon.icns`, nommée par `CFBundleIconFile`), le signe en ad
hoc puis vérifie la signature (`codesign --verify --strict`). Sous une plateforme
autre que macOS, il annonce « non exécuté » et sort en code 2 sans rien compiler.
Sans l'icns, il sort en code 1 avec `✗ icône absente :
omp-console/Bundle/AppIcon.icns (bash scripts/app-icon.sh)`, sans bundle signé.

Le bundle **embarque le service mémoire** : avec ou sans `--no-tests`, le script
compile `mem0-rs` depuis la racine (`cargo build --release --locked --manifest-path
mem0-stack/mem0-rs/Cargo.toml`), prend le binaire dans
`${CARGO_TARGET_DIR:-mem0-stack/mem0-rs/target}/release/mem0-rs`, exige `arm64`
dans `lipo -archs`, le copie en `Contents/Resources/mem0-rs` (0755) et le signe en
ad hoc LUI-MÊME (`codesign --force --sign -`) avant la signature du bundle :
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
   (`…/OMPConsole-p.build/…/*.swiftconstvalues`) lues par le processeur. Le moteur
   est imposé parce que le moteur `native` (défaut avant Swift 6.4, donc sous
   Xcode 26) n'écrit aucune valeur constante en release, même avec le drapeau ;
3. lance le processeur avec le jeu d'options qu'Xcode passe pour une cible app,
   dans un dossier temporaire ;
4. copie `Metadata.appintents` dans `Contents/Resources/` AVANT la signature ad hoc,
   qui le scelle ;
5. contrôle le bundle : `extract.actionsdata` doit porter l'intent sonde
   `OpenConsoleIntent` (`Sources/OMPConsole/Intents/OpenConsoleIntent.swift`, qui
   ramène la fenêtre principale) et son App Shortcut, phrase « Ouvre
   ${applicationName} » (« Ouvre OMP Console ») :
   `  ✓ métadonnées App Intents embarquées (Contents/Resources/Metadata.appintents : OpenConsoleIntent, « Ouvre ${applicationName} »)` ;
6. contrôle ensuite les deux intents vocaux (voir *Siri sur le Mac*) : `extract.actionsdata`
   doit déclarer `MacPendingIntent` et son App Shortcut « Qu’est-ce qui m’attend dans
   ${applicationName} », puis `MacAnswerIntent` et son App Shortcut « Réponds dans
   ${applicationName} » :
   `  ✓ intents vocaux embarqués (MacPendingIntent « Qu’est-ce qui m’attend dans ${applicationName} », MacAnswerIntent « Réponds dans ${applicationName} »)`.

Chaque échec sort en code 1, sur la sortie d'erreur, retire le bundle (y compris
celui d'un assemblage antérieur) et ne signe rien :

| Cause | Message |
|---|---|
| processeur introuvable (Command Line Tools seuls, licence Xcode non acceptée) | `✗ outillage Xcode introuvable : appintentsmetadataprocessor (xcrun --find appintentsmetadataprocessor) — installe Xcode puis sélectionne-le (sudo xcode-select -s /Applications/Xcode.app/Contents/Developer) ou pose DEVELOPER_DIR` |
| version d'Xcode illisible | `✗ version de Xcode illisible : aucune ligne « Build version » dans xcrun xcodebuild -version` |
| SDK macOS introuvable | `✗ SDK macOS introuvable (xcrun --sdk macosx --show-sdk-path)` |
| aucune valeur constante | `✗ valeurs constantes Swift introuvables sous <dossier de build> (attendu : …/OMPConsole-p.build/…/*.swiftconstvalues, produit par -Xswiftc -emit-const-values sous --build-system swiftbuild)` |
| processeur en erreur (par exemple une phrase sans `\(.applicationName)`) | `✗ extraction des métadonnées App Intents échouée (appintentsmetadataprocessor, code <n>)`, suivi des sorties du processeur |
| rien d'extrait (aucun intent compilé) | `✗ Metadata.appintents absent du bundle : Contents/Resources/Metadata.appintents/extract.actionsdata manque (l'extraction App Intents n'a rien produit)` |
| intent sonde absent | `✗ intent sonde absent de Metadata.appintents : OpenConsoleIntent introuvable dans extract.actionsdata` |
| App Shortcut absent | `✗ App Shortcut de l'intent sonde absent de Metadata.appintents : phrase « Ouvre ${applicationName} » introuvable dans extract.actionsdata` |
| intent vocal absent (`<Type>` = `MacPendingIntent`, puis `MacAnswerIntent`) | `✗ intent vocal absent de Metadata.appintents : <Type> introuvable dans extract.actionsdata` |
| App Shortcut vocale absente | `✗ App Shortcut de l'intent vocal <Type> absent de Metadata.appintents : phrase « <phrase> » introuvable dans extract.actionsdata`, où `<phrase>` est « Qu’est-ce qui m’attend dans ${applicationName} » ou « Réponds dans ${applicationName} » |

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
laisse l'ancienne mémoire en service. L'Accueil (et l'iPhone) portent alors
« Préparation incomplète. L'import de l'ancienne mémoire attend votre choix sur
le Mac. »

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
  ouvrez l'app et chargez le catalogue de modèles (feuille « Nouvelle feature ») :
  il est lu par le composant de l'app (`…/com.omp.console/components/omp/18.6.0/omp`),
  et l'app ne lance **aucun** process pour les sessions (elles sont servies par le
  service). Le renommage est réversible, et la suppression du composant seul
  provoque la réinstallation par « Réessayer ».
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

## Piloter le service

La section **Session OMP** (⌘5, ou Fichier ▸ « Nouvelle session OMP » ⌥⌘N) ne
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
**Session** (projet, état lisible — « En marche », « En attente » ou « Arrêtée » —,
identifiant de session, statut détaillé (`session.statusNotice`), puis « Copier le diagnostic »,
`session.diagnostic.copy`) et **Journal** (les messages absorbés par l'app :
ouverture de session, coupures, erreurs). Le pid du service n'est jamais affiché :
il ne vit que dans le diagnostic copié (cinq lignes : pid, état brut, identifiant
de session, projet, fichier de session ; une valeur inconnue s'y dit « absent »).
L'inspecteur de la section **Projet** suit le même patron (`projet.diagnostic.copy`).
Aucune trame de protocole brute n'est affichée. Un prompt n'est jamais
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
« Lancer OMP » du terminal, lui, tape `omp` dans le shell, qui le résout par son
`PATH` complété (voir « Section Terminal »).

- **`OMP_CONSOLE_OMP_BINARY`** (échappatoire de test) — posée et non vide, c'est le
  SEUL candidat ; utile aux recettes pour pointer un `omp` de secours ou simuler un
  poste sans composant.
- Si le composant est absent ou non exécutable au lancement, la feuille de
  préparation bloquante s'impose : « Installer » le télécharge, « Réessayer »
  relit sa présence, « Quitter » quitte l'app ; `omp models --json` retombe
  alors sur l'option « défaut OMP (aucun modèle) ».

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

Le terminal et la section **Session OMP** (session servie par l'API locale) vivent
**en même temps**, sans exclusivité : ouvrir l'un ne perturbe pas l'autre, dans les
deux sens, et ils peuvent même viser le même répertoire.

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
sortie arrêterait quelque chose :

- une **Session OMP** lancée ou en cours de lancement : « La session OMP de « nom »
  s'arrêtera. » (la session est fermée par `DELETE`) ;
- une **commande au premier plan** d'un shell du Terminal (`sleep 600`, `omp`…) :
  « La commande « sleep » du Terminal s'arrêtera. ». Un shell au repos sur son
  invite, une tâche de fond (`sleep 600 &`) ou `exec <commande>` ne comptent pas.

Quand l'alerte s'affiche, elle cite EN PLUS ce qui **continue dans OMP** : le
pilotage (« Le pilotage de « nom » continue dans OMP : vous le retrouverez en
pilotant de nouveau ce projet. ») et les pipelines en cours (« 2 pipelines en cours
continuent dans OMP. »). Un pilotage ou des pipelines seuls font quitter **sans**
alerte : quitter ne les arrête pas.

- **Quitter** (Retour) : les accroches de sortie tournent comme avant (session
  fermée, pilotage détaché, shell tué, service distant arrêté), les feuilles
  ouvertes sont fermées, puis l'app quitte. Une feuille ouverte (Bienvenue,
  préparation bloquante) ne bloque jamais la sortie ; la Bienvenue fermée ainsi
  reparaîtra au prochain lancement.
- **Annuler** (Échap) : rien ne s'arrête, l'app reste ouverte ; le ⌘Q suivant
  redemande. Sur une fermeture de session macOS, Annuler l'interrompt (l'Apple
  Event de quit reçoit `userCanceledErr`, -128) ; sans activité, la fermeture de
  session n'est plus interrompue par l'app.
- Une seule alerte par sortie, aucune option « Ne plus demander ».
- Fermer la fenêtre (⌘W, bouton rouge) ne demande rien : le shell est tué comme
  avant.

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
   sa question en attente attend la réouverture. Un pilotage seul ne fait pas
   poser l'alerte du Quitter ; elle le cite quand une session ou une commande du
   Terminal la fait poser.

**Ce que l'app n'écrit jamais** : ni `<stateDir>/projects/<clé>.json`, ni le
worktree `.doc`, ni le lot. Elle ne réimplémente non plus aucune règle du pilote
(plan, segments, jalons, PR) : elle affiche ce que le magasin porte et renvoie les
réponses dans la session `purpose:"project"` (`POST /v1/sessions/{id}/dialogs/{dialogId}`).

Aucune reprise automatique : relancer l'app n'ouvre **aucune** session et n'arme
**aucun** `/project` ; c'est toujours un geste de l'utilisateur.

### PR et intégration continue du projet

Le volet **PR et intégration continue** de la vue **Projet** affiche les PR ouvertes par le projet
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

2. Ouvrir la vue **Projet** : le volet **PR et intégration continue** liste la PR, avec ses trois
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
   disparaît du volet **PR et intégration continue** et le volet **Plan** passe le segment suivant
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

## Section Audit (pilotage)

La section **Audit** (⌘4, juste après **Projet**) lance et suit les audits du
service : une analyse d'un dépôt selon une orientation libre, des propositions à
cocher, puis des pipelines lancées et suivies jusqu'à leur PR. À gauche, la liste
des audits (`audit.row.<id>` : nom du dépôt, orientation sur deux lignes au plus,
statut, badge du nombre de questions en attente) ; à droite, le détail de l'audit
sélectionné. La barre d'outils porte « Lancer un audit… » (`audit.start`).

1. **Vide** — sans audit, la section affiche « Aucun audit. » et « Lancez un audit
   pour analyser un dépôt selon l’orientation de votre choix. », avec le bouton
   « Lancer un audit… ».
2. **Lancer** — la feuille « Lancer un audit » propose le dépôt (prérempli par le
   projet ouvert, `ProjectRoot.resolve`, et « Choisir… » par `NSOpenPanel`) et
   l'orientation (`TextEditor`). « Lancer l’audit » n'est actif que si le dossier
   contient `.git` et si l'orientation, rognée, compte de 1 à 2 000 caractères. L'app
   poste `POST /v1/audits {repo, orientation}` ; au succès, l'audit créé est
   sélectionné et son en-tête montre l'orientation saisie. Pendant l'analyse, le
   détail affiche « Analyse en cours… ».
3. **Cocher** — un audit `proposed` montre une case par proposition, sous
   « Faiblesses » et « Features proposées » (`audit.proposal.<slug>`), avec le
   compteur des cases cochées. Une proposition déjà prise par une pipeline a sa
   case désactivée (« Déjà dans le lot des pipelines »). Les cases vivent en
   mémoire de l'app, par audit : rien n'est envoyé au simple clic.
4. **Relire le brief** — « Relire le brief… » (actif dès qu'une case est cochée)
   ouvre la feuille « Brief de l’audit » : le brief proposé par l'analyse,
   éditable. Une rubrique manquante est signalée dans la feuille, avant tout
   envoi. « Valider et lancer » poste les propositions cochées et le texte du brief
   (`POST /v1/audits/{id}/launch`) ; « Annuler », Échap ou la fermeture de la
   feuille ne postent rien.
5. **Suivre** — un audit lancé (ou arrêté) montre « Avancement » : une rangée par
   feature (slug, phase, attente, bouton « Ouvrir la PR » quand la PR existe), et
   les propositions non lancées avec leur motif.
6. **Répondre** — « Questions en attente » liste les escalades que l'arbitre n'a
   pas tranchées : « <slug> · <phase> », la question, le motif de l'arbitre, puis
   un bouton par option, un champ « Autre réponse » et « Répondre » — ou, pour un
   jalon de specs ou de revue, ses deux boutons. Une réponse acceptée retire
   l'escalade au relevé suivant ; une question déjà répondue affiche « Cette
   question a déjà reçu une réponse. ».
7. **Décisions de l’arbitre** — une rangée par décision (feature, phase, question,
   réponse, et « Déjà tranchée » ou « Tranchée par l’arbitre »), la plus récente en
   tête ; « Aucune décision pour l’instant. » sinon.
8. **Arrêter** — « Arrêter l’audit… » demande confirmation (« Arrêter cet audit ? »)
   puis poste `DELETE /v1/audits/{id}` : les pipelines non livrées de cet audit sont
   annulées, leurs dossiers et branches conservés, les PR déjà créées restent
   ouvertes, les autres audits ne sont pas touchés. Le bouton disparaît pour un
   audit arrêté.

Chaque échec (démarrage, lancement, réponse, arrêt, analyse) s'affiche en bandeau
lisible dans le détail, avec « Copier le diagnostic » ; service arrêté, la section
affiche « service arrêté » et « Réessayer », comme **Projet**, et la lecture du
magasin reste affichée.

**Survie** : quitter l'app n'appelle aucune route d'audit. Les audits vivent dans
le service ; à la réouverture, la section relit le magasin — audits, escalades (y
compris celles posées pendant l'absence) et décisions.

## Section Statistiques

Une section **en lecture seule** (⌘0),
qui compte ce que les runs d'un projet ont consommé : tokens d'entrée et de sortie,
durée murale (attente d'une réponse utilisateur comprise) et nombre de tours (un
tour = un cycle complet prompt → réponse finale), par run puis agrégés par feature
et par projet. **Aucun montant en dollars** n'y apparaît — le domaine `Stats` ne
lit jamais `usage.cost`.

Le tableau de bord est celui du **projet affiché**, que nomme le sélecteur `Projet`
de la barre d'outils (aucun sous-titre ne le répète) : quatre tuiles (« Tokens envoyés »,
« Tokens reçus », « Temps passé », « Tours ») totalisent le projet ; le graphique
« Tokens par feature » montre, par feature listée, deux barres empilées
(envoyés, reçus) ; le tableau « Runs » liste un run par ligne en sept colonnes
(Feature, Étape, Modèle, Durée, Tours, Tokens, État), triable par un clic sur un
en-tête (re-clic inverse ; sans tri, l'ordre est features puis runs). La colonne
Modèle nomme le modèle d'un run par son **nom lisible** (cherché par
`fournisseur/id` du tour assistant, `ModelCatalog.sessionModelName`), l'id nu à
défaut de nom ou de catalogue, « — » sans modèle. Une feature
du plan n'est **listée** que si elle porte au moins un run **lisible** ; les autres
sont **masquées** et comptées en pied (`<n> feature(s) du plan sans run lisible`,
absent à 0).

Le tableau de bord **défile** verticalement, à toute taille de fenêtre (minimum
760 × 480) : chaque graphique est borné à 240 pt de haut (au-delà de 7 features, les
barres s'amincissent), et la table prend la hauteur de **toutes** ses lignes, sans
défilement vertical interne ; la molette au-dessus d'elle fait défiler le tableau de
bord, et sa dernière ligne s'atteint en bas. Ses hauteurs (en-tête 28 pt, ligne
27 pt imposée par la pastille d'état, barre horizontale 19 pt) sont MESURÉES sur
macOS 27.2 et revérifiées par la recette AX (`StatsLayout`, StatsView.swift).

### Les cinq états

| État | Condition | Texte exact | AX |
|---|---|---|---|
| Chargement | aucun instantané reçu | `Chargement des statistiques…` | `stats.state` |
| Magasin absent | racine `.absent` | `Aucune pipeline pour l'instant.` | `stats.state` |
| Aucun projet | racine présente, aucun `projects/*.json` | `Les statistiques apparaîtront dès qu'un projet sera piloté.` | `stats.state` |
| Aucune donnée | projet affiché, features vides ; le sélecteur reste dans la barre d'outils | `Aucune donnée pour ce projet` | `stats.empty` |
| Tableau | projet affiché avec ≥ 1 feature listée | voir ci-dessous | — |

Le texte du magasin absent est **repris mot pour mot** de `KanbanBoardState` (une
seule formulation par situation dans l'app) ; celui du chargement dit ce qu'il
charge (`StatsPresentation.loading`, partagé avec l'app iOS).

### Identifiants d'accessibilité

| Élément | Identifiant |
|---|---|
| Sélecteur de projet | `stats.project` |
| Tuiles du projet | `stats.aggregate` |
| Tableau de bord défilant (`ScrollView`) | `stats.board` |
| Graphique « Tokens par feature » | `stats.chart` |
| Compte des features masquées | `stats.hidden` |
| Feature d'une ligne du tableau | `stats.run.<tag>` (`tag` = `sessionTag(forSessionFile:)`) |
| Durée d'une ligne du tableau | `stats.duration.<tag>` |

### Forme d'une ligne

Durées et tokens passent par les formateurs de Foundation en français
(`ConsoleFormat` : « 14 min et 12 s », « 1,2 k ») ; une durée inconnue s'écrit
`—`. Un run **illisible** garde sa ligne avec l'état « Illisible », son motif en
infobulle (« session introuvable », « session illisible : <message OS> »), et reste
exclu des sommes.

### Mise à jour en direct

Aucun geste n'est nécessaire : le magasin et la veille du fichier de session de
chaque run **vivant** font monter seuls les tokens et les tours. Un run est
**vivant** si le pid de son entrée `running` vit — jamais d'après le badge
`isStale` du magasin (`publishRunning` n'écrit rien quand seul `updatedAt`
change, donc un run vivant au repos est marqué périmé).

L'horloge de rendu (`TimelineView`, une seconde) ne fait avancer que les durées
des runs vivants, lisibles et horodatés (`statsLiveStarts`) : la cellule
« Durée » de chacun et la tuile « Temps passé ». Le reste du tableau de bord —
tuiles, graphiques, table, défilement — n'est reconstruit que quand le modèle
publie (magasin, session vivante écrite, projet choisi, tri) ; les tics ne
déplacent donc pas le défilement. Sans run vivant, aucune horloge n'existe et
rien ne se redessine à la seconde. Le tri par « Durée » s'appuie sur la durée de
la dernière publication : un run vivant peut y être classé avec quelques
secondes de retard.

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
fenêtre visible et au premier plan. Le titre de l'item est **un seul chiffre**, le
nombre de lignes « À vous » de l'Accueil, et l'icône seule (`square.grid.2x2`)
quand ce nombre est nul. Son info-bulle et sa description VoiceOver disent toutes
deux **« N à vous · M en cours »** (point médian U+00B7, zéros écrits ; « 0 à vous ·
0 en cours » tant que rien n'est connu). Un menu déroulant n'est **pas** posé, un
menu demanderait deux clics là où un seul doit ramener la fenêtre.

### Les notifications

Une notification macOS est émise quand un évènement du magasin survient, **au plus
une fois par évènement** (déduplication persistée), et **seulement si la fenêtre de
l'app n'est pas au premier plan** (mesuré par `NSApplication.isActive`). Les quatre
besoins et leurs six familles :

| Évènement | Source | Titre · corps |
|---|---|---|
| attend une réponse | `running/<id>.json`, `pendingAsk` en vol et propriétaire vivant | « Question » · nom affiché de la carte (repli : `<label>`) |
| attend une validation (specs) | feature de lot `waiting` avec `waitKind = specs` | « Spécifications à valider » · nom affiché de la carte (repli : `<slug>`) |
| attend une validation (revue) | idem avec `waitKind = review` | « Revue à accepter » · nom affiché de la carte (repli : `<slug>`) |
| échoué (feature de lot) | feature de lot `failed` | « Échec » · nom affiché de la carte (repli : `<slug>`) |
| échoué (run clos) | `history/<id>.json`, `finalState = failed` | « Échec » · nom affiché de la carte (repli : `<label>`) |
| PR fusionnée | feature de projet `status = merged` dans `projects/<clé>.json` | « PR fusionnée » · nom affiché de la carte (repli : `<slug>`) |

Le titre est le libellé d'état que l'Accueil affiche pour la carte, tiré des mêmes
fonctions (`HomeText.natureText`, `ConsoleStatus.of(column:)`) ; un échec reste
« Échec » même quand l'Accueil le montre « En pause ». Le corps est le nom affiché
par l'Accueil (`KanbanCard.title` : le slug d'une feature, le `label` d'un run, que
le dépôt écrit lui-même) — une question posée par le run d'une feature porte le slug
de la feature. Le repli ne sert que si la carte n'est pas sur l'ardoise du même
instantané. Une PR absente de `projects/` n'émet
rien (une PR non suivie), et une feature de **lot** `done` avec `prUrl` (colonne
« PR ouverte », « PR créée » ou « PR fusionnée » du Kanban selon l'état GitHub)
n'est pas une fusion. Les sources sont bornées comme le
magasin : 200 entrées `running`, 20 rangs `history`, un lot et un projet par dépôt.

### Cliquer une notification

Chaque notification porte, dans son `userInfo`, sa famille et l'identifiant de sa
carte (`["kind": …, "cardID": …]`, chaînes seulement). Un clic sur la bannière ou
sur son entrée du Centre de notifications ramène **toujours** la fenêtre principale
au premier plan, puis ouvre :

| Famille | Destination |
|---|---|
| Question | feuille **Répondre** de la carte |
| Spécifications à valider | feuille **Contrat** de la carte |
| Revue à accepter | **fiche** de la carte (elle porte « Accepter la revue ») |
| Échec (lot ou run) | **fiche** de la carte |
| PR fusionnée | **fiche** de la carte |

- **Notification périmée** (question déjà répondue, jalon déjà validé, carte sortie
  de l'état notifié) : la **fiche** de la carte si elle existe encore, l'**Accueil**
  si elle a disparu — sans feuille ni message d'erreur. Une notification sans
  `userInfo` (livrée par une version antérieure, ou perte d'un port par le
  service mémoire de l'app, qui ne concerne aucune carte) ou illisible mène à
  l'Accueil.
- **Fenêtre fermée**, l'app vivante dans la barre des menus : la fenêtre se rouvre,
  puis la destination s'applique. Si l'ardoise n'est pas encore chargée, l'ouverture
  attend sa première publication (seule la plus récente est gardée). Le lancement à
  froid d'une app quittée n'est pas couvert.
- **Feuille déjà ouverte** dans la fenêtre (Répondre avec une saisie en cours, Contrat,
  fiche, dialogue…) : elle n'est **jamais** remplacée ni fermée ; seule la fenêtre
  revient au premier plan.

La destination est une fonction pure (`AlertRoute.destination`, Alerts/AlertRouter.swift)
appliquée par `AlertRouter` ; le clic lui parvient par `AlertOpenReceiver` (délégué du
centre, retenu par le livreur système) → `AlertsModel.onOpen` → `AppDelegate.openAlert`.

### Notifications refusées

Quand l'autorisation de notification est **refusée** (et seulement alors), l'Accueil
montre en tête un bandeau neutre (`home.notificationsBanner`) :
« Les notifications sont désactivées. », « Ouvrir les Réglages » (Réglages Système ▸
Notifications) et « Ignorer », qui le masque pour de bon (préférence
`home.notificationsBannerDismissed`). La fenêtre n'affiche plus de compteurs : ils
vivent dans l'item de la barre des menus.

Dans l'item de barre, N et M sont les tailles des listes « À vous » et « En cours »
de l'Accueil (`HomePresentation.counts`, mêmes règles que `HomePresentation.dashboard`) :
les pipelines en pause (« À reprendre ») et les features jamais lancées (« Pas
commencées ») ne comptent **jamais**, et une pipeline en échec ou bloquée relançable
compte dans « À vous ». Le chiffre, l'info-bulle et la description changent au même
instantané que les sections de l'Accueil.

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

1. Accorder le dialogue d'autorisation ; vérifier l'item de barre à l'icône seule
   (sonde AX : `AXTitle` vide, `AXDescription` = `AXHelp` = « 0 à vous · 0 en cours »).
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
7. Cliquer chaque bannière (ou son entrée du Centre de notifications), fenêtre
   ouverte puis fermée, et constater la destination de « Cliquer une notification » :
   Répondre, Contrat, fiche, ou Accueil pour une carte disparue ; puis cliquer avec
   une feuille Répondre ouverte et du texte saisi ⇒ la feuille et son texte restent.
   Cette étape reste **manuelle** : un clic sur une notification active l'app et
   vole le focus, ce qu'aucune recette automatisée ne doit faire.

### Trois pièges mesurés

1. **Hors bundle, pas de centre de notifications.** `UNUserNotificationCenter.current()`
   dans un binaire nu (ou un processus de `swift test`) tue le process sur une
   exception Objective-C non rattrapable (`bundleProxyForCurrentProcess is nil`). La
   garde d'instanciation est donc `Bundle.main.bundleURL.pathExtension == "app"`, et
   **aucun** appel UserNotifications ne vit ailleurs que dans `AlertDelivery.swift` —
   le récepteur de clics (`AlertOpenReceiver`, posé en `delegate` du centre) compris :
   les tests passent par l'enregistreur (`RecorderAlertDeliverer.simulateOpen`).
2. **`NSStatusBar` interdit dans la suite.** `NSStatusBar.system.statusItem(withLength:)`
   tue un processus de test (signal 6, pile `-[NSStatusBar _statusItemWithLength:withPriority:]`).
   `StatusItemController` n'y est donc jamais construit : son titre et son résumé
   sont des fonctions pures (`StatusItemTitle.text`, `.summary`) qu'il se borne à
   recopier dans `title`, `toolTip` (`AXHelp`) et `setAccessibilityLabel`
   (`AXDescription`) ; ce câblage AppKit est prouvé par la recette.
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
| portée incalculable (liste) | « Aucun projet ouvert » — « Choisissez le projet dont vous voulez consulter la mémoire. » + bouton « Choisir un projet… » : menu des projets connus puis « Choisir un dossier… », ou, sans projet connu, le panneau de Session OMP ; le choix recharge la liste sur place |
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
téléphone, une autre machine) : elle sert le magasin d'état, les sessions, les
statistiques, la mémoire, et les gestes du tableau — et pousse ses changements par
un flux temps réel.

- **Transport** : HTTP/1.1 en clair, sur la **seule interface du réseau local**.
  Le port par défaut est **8787** (`OMP_CONSOLE_REMOTE_PORT` le déplace, pour une
  instance de recette) et le service est annoncé par **Bonjour** sous le
  type **`_ompconsole._tcp`** (instance « OMP Console », TXT `v` = version du
  protocole, `api` = base des chemins). Une connexion dont la source n'est pas une
  adresse locale (boucle locale, plages privées, lien-local) est coupée sans un octet.
- **Version de protocole** : chaque requête porte `X-Console-Protocol-Version: 2` et
  chaque réponse le renvoie. Un client dont la version diffère est refusé par le code
  partagé `incompatible_protocol`, sans qu'aucune donnée ne soit servie. La version 2
  rend `toolCallId` obligatoire sur la réponse à une carte : une app de version 1 se
  verrouille sur « Version de protocole incompatible (app 1, Mac 2) », sans double
  support.
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
  `{"code":"XXXXXXXX","name":"<appareil>","deviceKey":"<installation>","protocolVersion":2}`
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
  (100.64/10) puis lien-local : l'app iOS/iPadOS n'atteint en HTTP que le réseau
  local (ATS), et une adresse Tailscale tapée à la main y échoue ; chaque ligne
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
- **Documents de projet** : `GET /v1/projects/{repoKey}/documents` sert `PROJECT.md`
  (du magasin) et `contract.md` (de la racine du projet), chacun avec son état
  (`text`, `missing`, `binary`, `unreadable`).
- **État du Mac pour l'Accueil** : `GET /v1/components` sert
  `{ompInstalled, ompPath?, setupBanner?, homeDirectory?}` (la présence réelle du
  composant OMP et le bandeau de préparation). `homeDirectory` est le dossier
  personnel du Mac ; l'app iOS s'en sert pour abréger les chemins en `~/…` (un Mac
  antérieur ne l'envoie pas : les chemins restent absolus). `GET /v1/journal` sert les 20 derniers gestes
  (`{entries:[…]}`, le plus récent en tête) ; `GET /v1/cards/{id}/contract` sert le
  contrat d'une carte sous `{document: {name, state, content, reason}}` — `404`
  carte inconnue, `409` carte sans contrat (moment ou worktree absent).
- **Réponse à une carte** : `POST /v1/cards/{id}/answer` exige `toolCallId`,
  l'identifiant de la question affichée (`pendingAsk.toolCallId` de la trame
  `store`), avec `{"toolCallId","kind":"selected"|"custom","label"?,"text"?}`. Un
  corps absent ou illisible est d'abord un `400` ; un corps dont la forme ne se
  convertit pas (`kind` inconnu, `label` ou `text` absent) est un `400` « kind
  inconnu », « libellé absent » ou « texte absent » avant tout contrôle d'état,
  sauf si l'identifiant manque : « identifiant de question manquant » prime alors.
  Les refus du geste typé `RemoteActions.answer` se contrôlent ensuite dans cet
  ordre, le premier gagne et AUCUN ne livre quoi que ce soit à la pipeline : `404`
  « carte inconnue », `409` « carte sans geste », `409` « aucune question en vol »,
  `400` « identifiant de question manquant » (blanc), `409` « la question a changé
  depuis la demande » (identifiant d'une question qui n'est plus en vol, contrôlé
  AVANT le libellé), puis `400` « libellé hors des options de la question » ou
  « texte vide ». La réponse livrée rend `202 {"accepted":true}`.
- **Faits de PR de l'ardoise** : `POST /v1/pull-request-states/refresh` (sans corps)
  relance la lecture des états de PR sur GitHub sans l'attendre et répond `202
  {"accepted":true}`, même quand `gh` est absent ; le résultat arrive par la trame
  `pull-request-states` (`{facts:[{url, state, closedAtMs?}], refreshing}`, faits
  triés par URL), rediffusée à chaque fait publié et à chaque bascule de relecture.
  Le client (`ConsoleClientModel`) envoie cette requête, tolérante, à chaque
  ouverture du flux et sur `refreshPullRequestStates()` ; il publie la trame dans
  `pullRequestStates` et en dérive `board` (`prFacts`). Un Mac plus ancien répond
  404 : les cartes restent « PR créée ».
- **Audits** : quatre routes servent depuis l'iPhone les gestes de la section Audit du
  Mac, par le MÊME modèle (`AuditConsoleModel`) — les requêtes envoyées au service OMP
  sont donc celles du Mac. `POST /v1/audits` `{repoKey, orientation}` rend `{id}` ; la
  clé est celle de `GET /v1/repos` (`404` « dépôt inconnu » sinon), le client ne
  calcule jamais de chemin. `POST /v1/audits/{id}/launch` `{selected, brief}` rend
  `{launches:[{slug, launched, reason, state, phase, prUrl}]}`.
  `POST /v1/audits/{id}/escalations` `{slug, key, answer?, decision?}` (`decision` =
  `approve` ou `abandon` pour un jalon) rend `202 {"accepted":true}`.
  `DELETE /v1/audits/{id}` rend `{cancelled, kept, refused:[{slug, reason}]}`. Un
  identifiant hors forme (16 hexadécimaux) est un `404` « audit inconnu » sans appel
  au service ; les refus du service se recopient (`400`, `404`, `409`, dont « question
  déjà répondue ou périmée ») et un service arrêté ou injoignable rend `503`. Aucune
  route de lecture : audits, escalades et décisions arrivent par la trame `store`.
  L'API sert ainsi **43 routes**, image exacte de `ClientRoute.all`.
- **Gestes typés** : chaque geste de `RemoteActions` est une méthode Swift typée
  (`throws(GestureRefusal)`, sauf `stopHostedSession` et `refreshPullRequestStates`
  qui ne refusent jamais), appelable par du code Swift du Mac sans corps
  HTTP : gestes de carte (`answer`, `reply`, `text`, `verdict`, `resume`, `stop`),
  lancement de feature (`launch`), conduite (`startConduite`, `closeConduite`,
  `answerDialog`), session hébergée (`prompt`, `launchHostedSession`,
  `relaunchHostedSession`, `stopHostedSession`, `answerHostedDialog`), audits
  (`startAudit`, `launchAudit`, `answerAudit`, `stopAudit`) et PR (`pullRequests`,
  `merge`, `refreshPullRequestStates`). Chacune applique seule les règles du geste
  et lève une cause typée `GestureRefusal` (un cas par règle : carte inconnue,
  identifiant de question manquant, question périmée, libellé hors options, texte
  vide, jalon non attendu, dialogue
  périmé, dépôt inconnu, échec relu au journal…). Le routeur ne fait que décoder
  le corps (un corps absent ou illisible est un `400` AVANT tout contrôle d'état,
  même sur une carte, un dépôt ou un audit inconnus), convertir la forme et
  appeler la méthode ; `GestureRefusal.apiError` est la seule table qui traduit un
  refus vers l'enveloppe `{"error":{"code","message"}}` habituelle. Un échec
  d'écriture du canal relu en tête du journal rend `409 conflict` à son motif
  (« écriture impossible (Permission denied) ») — il était `500`. Une invite
  blanche à la session hébergée rend « texte vide ».
- **Liste des attentes** : aucune route dédiée. L'iPhone calcule la liste des
  attentes depuis `/v1/store`, `/v1/conduite` et `/v1/session`
  (`ConsoleClientModel.pendingRequests()`, lues dans cet ordre, l'une après
  l'autre), avec la même fonction que le Mac (`LocalPendingRequests` côté coque) :
  mêmes identités, même ordre. Une source en échec ⇒ `PendingRequestsUnavailable`
  (`source` = `store`, `conduite` ou `session`, `cause` = l'erreur du client),
  jamais une liste partielle. Les escalades d'audit arrivent avec `/v1/store`.
- **Flux** : `GET /v1/stream` ouvre un `text/event-stream` (SSE) qui pousse `hello`,
  `store`, `conduite`, `devices`, `components`, `journal`, `pull-request-states`,
  `sessions` et `hosted`, avec un battement de cœur toutes les 15 secondes. À
  l'abonnement, l'ordre est `hello`, `store`, `conduite`, `devices`, `components`,
  `journal`, `pull-request-states`. La révocation d'un appareil coupe son flux
  immédiatement.

### Sonde CLI

`scripts/omp-console-api.ts` est la sonde manuelle du dépôt (lecture, gestes, flux) :

```bash
bun scripts/omp-console-api.ts pair --code XXXX-XXXX --name iPhone
bun scripts/omp-console-api.ts snapshot
bun scripts/omp-console-api.ts sessions
bun scripts/omp-console-api.ts watch --seconds 10
bun scripts/omp-console-api.ts resume feature:<repoKey>:<slug>
bun scripts/omp-console-api.ts answer feature:<repoKey>:<slug> --question <toolCallId> --option <libellé>
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

#### Recette des Réglages › Appareils

```bash
bash scripts/swift-app.sh --no-tests              # le bundle à éprouver
bash scripts/recette/mac-appairage-recette.sh             # Mac seul
bash scripts/recette/mac-appairage-recette.sh --ios       # + iOS/iPadOS
bash scripts/recette/mac-appairage-recette.sh --captures-only --bundle <app de la base>   # captures « avant »
```

Elle lance une **instance de recette distincte** en arrière-plan (`open -g -n`), sur
un état jetable : 12 appareils hérités « iPhone » sans `deviceKey`, un magasin de
pipeline vide, le port `OMP_CONSOLE_REMOTE_PORT=18787`. Seuls les composants de
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

## Politique vocale (App Intents)

Les gestes exécutés par Siri ou Raccourcis, sur l'iPhone comme sur le Mac, suivent
une table pure de ConsoleCore (`Sources/ConsoleCore/Voice/`). Elle ne régit que les
App Intents : les gestes tactiles des écrans gardent leurs confirmations (sur
l'Accueil iOS, seul « Valider les specs » confirme).

| geste (`VoiceGesture`) | confirmation iPhone | déverrouillage iPhone | confirmation Mac | déverrouillage Mac |
|---|---|---|---|---|
| `stopFeature`, `validateSpecs`, `acceptReview`, `launchPipeline` | oui | oui | oui | oui |
| `answerOption`, `answerText`, `answerProjectDialog`, `answerHostedDialog`, `answerAuditEscalation`, `resume`, `consult` | non | oui | non | non |

Sur iPhone, tout intent exige le déverrouillage : le jeton est au trousseau en
`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. La table
(`VoiceGesturePolicy.rule(for:on:)`) classe les gestes par un `switch` sans
`default` : un geste ajouté sans ligne ne compile pas, et
`Tests/OMPConsoleTests/VoiceGesturePolicyTests.swift` échoue sur tout geste absent de
ses listes écrites à la main.

Écrire un intent vocal :

- il se conforme à `VoiceGestureIntent` et déclare son geste,
  `static let voiceGesture: VoiceGesture = .stopFeature` ;
- il écrit sa politique en **littéral**,
  `static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication`
  si la table exige le déverrouillage sur sa plateforme, `.alwaysAllowed` sinon ;
- `perform()` appelle `applyVoicePolicy(target:send:)` avec la cible nommée (le slug
  de la feature, le nom de la pipeline) et la closure qui émet le geste par les
  modèles existants ; la porte demande la confirmation à Siri
  (« Arrêter la feature login-oauth ? ») et n'appelle `send` qu'après un oui ;
- il traduit l'issue : `.sent` → son propre dialogue de succès ; `.cancelled(let d)` et
  `.misconfigured(let d)` → `.result(dialog: IntentDialog(LocalizedStringResource(stringLiteral: d)))`.
  Un refus, une absence de réponse ou une cible vide n'émettent rien ; une erreur de
  `send` remonte telle quelle.

Un intent qui émet **plusieurs** gestes — celui qui répond aux demandes en attente,
dont la source n'est connue qu'à l'exécution — se conforme à `VoiceAnswerIntent` au
lieu de `VoiceGestureIntent` :

- il déclare la liste de ses gestes,
  `static let voiceGestures: [VoiceGesture] = [.answerOption, .answerText, .answerProjectDialog, .answerHostedDialog, .answerAuditEscalation]`,
  et UN littéral `authenticationPolicy`, valable pour chacun d'eux ;
- à chaque envoi, `applyVoicePolicy(_:target:send:)` reçoit le geste de la demande
  visée : un geste absent de `voiceGestures`, ou dont la ligne de la table diverge du
  littéral, rend `.misconfigured` sans appeler `send` ; sinon la porte est la même que
  pour `VoiceGestureIntent` (confirmation au besoin, puis `send`).

`MacPendingIntent` et `MacAnswerIntent` (*Siri sur le Mac*) en sont les deux
conformités ; `Tests/OMPConsoleTests/MacVoiceIntentTests.swift`
(`siri-mac-questions-en-attente/AC-12`) confronte leurs littéraux à la table geste par
geste.

Piège du littéral : `appintentsmetadataprocessor` exige que `authenticationPolicy`
soit initialisée par un littéral (« 'IntentAuthenticationPolicy' must be initialized
with a literal value ») ; une valeur calculée depuis la table fait échouer TOUT
l'export des métadonnées App Intents. La table ne peut donc pas fournir la valeur :
`applyVoicePolicy` confronte le littéral à `VoiceGesturePolicy.authenticationPolicy(for:on:)`
à chaque exécution, et une divergence rend `.misconfigured` sans rien émettre.

Phrases vocales : quatre fonctions pures de `Sources/ConsoleCore/Voice/`, sans
AppIntents ni framework d'interface, calculent ce que Siri prononce, à l'identique sur
l'iPhone et sur le Mac. `VoiceFeatureSearch.find` retrouve une feature non terminée par
son titre prononcé (casse, accents et tirets ignorés ; dès deux titres qui
correspondent, une précision est demandée). `VoiceAnswerMatcher.match` fait
correspondre une réponse dite à une option (libellé, chiffre, « la deuxième », « la
dernière »), sinon au texte libre si l'appelant l'accepte, sinon rappelle les choix
possibles. `VoicePendingSummary.phrase(for:)` dit la liste des attentes : le total,
les 3 plus récentes, puis « et N autres ». `VoiceIssue.phrase` dit l'issue d'un geste :
succès qui nomme le geste et sa cible, annulation, refus du Mac, cause de connexion.
Toutes leurs phrases vivent dans `VoiceSpeechText`. Preuves :
`Tests/OMPConsoleTests/VoiceSpeechTests.swift` et `test/console/noyau-vocal-partage.test.ts`.

## Vocabulaire et typographie

Les textes visibles des fichiers `*Text.swift` (ConsoleCore, coque Mac, coque iOS)
suivent [`GLOSSAIRE.md`](GLOSSAIRE.md) : un seul terme français par notion, sauf les
termes conservés (« pipeline », « feature », « PR », /req, /specs, /impl, /review, noms
propres), et la typographie française (’, espace insécable avant ; : ! ? et dans « »,
…). La garde `test/console/typographie-et-glossaire-francais.test.ts` le vérifie.

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 26, deux cibles)
├── Sources/OMPConsole/
│   ├── OMPConsoleApp.swift        point d'entrée (@main), scènes et menu
│   ├── ConsoleRootView.swift      fenêtre, barre latérale groupée, barre d'outils, feuille unique
│   ├── SectionViews.swift         les dix vues de section (Sessions : liste + visionneuse poussée)
│   ├── ConsoleSection.swift       les dix sections, leurs libellés et leurs groupes
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
│   │   ├── HomeRecipe.swift       crochet de recette `-home.recipe` (ardoises de `HomeParity`)
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
│   │   ├── AppPaths.swift         la racine privée de l'app (composants, mémoire, agent, migration)
│   │   ├── CommandRunner.swift    l'exécution d'une commande externe, injectable
│   │   ├── ComponentManifest.swift les versions, URL et empreintes des composants
│   │   ├── ComponentInstaller.swift téléchargement d'OMP, SHA-256, `--version`, purge
│   │   ├── ComponentPresence.swift présence des composants : lecture et veille (badge)
│   │   ├── ComponentBadge.swift   le badge d'état, au pied de la barre latérale
│   │   ├── SetupModel.swift       la chaîne composants → migration → service mémoire → oMLX
│   │   ├── SetupRecipe.swift      crochet de recette `-setup.recipe` (racine jetable)
│   │   ├── SetupText.swift        tous les textes de la préparation, en un endroit
│   │   └── SetupView.swift        la feuille : lignes, progression, échec, pied bloquant ou fermable
│   ├── Stack/                     le service mémoire de l'app et la reprise de l'ancienne mémoire
│   │   ├── MemoryAgent.swift      l'agent launchd `com.omp.console.mem0-rs` : plist, launchctl, santé
│   │   ├── PodmanLegacy.swift     migration unique de l'ancienne mémoire, puis nettoyage de son moteur
│   │   ├── PodmanCommand.swift    argv purs et environnement isolé d'une commande podman
│   │   ├── StackConfig.swift      la config `stack/env` (oMLX, jetons, dimensions)
│   │   ├── InstallationToken.swift le jeton d'installation (0600) et sa sonde identitaire
│   │   ├── StackOwnership.swift   qui tient un port : lsof, classification, geste exact
│   │   ├── StackOwnershipModel.swift le superviseur d'ownership et son évènement d'alerte
│   │   └── OMLXProbe.swift        la sonde oMLX (budget 5 s, jamais bruyante)
│   ├── Terminal/                  la fenêtre de terminal : un shell de connexion dans un PTY
│   │   ├── TerminalHost.swift     le PTY : forkpty, fermeture des descripteurs
│   │   │                          hérités ≥ 3, écriture,
│   │   │                          escalade SIGTERM/SIGKILL du groupe, récolte
│   │   ├── TerminalShell.swift    le shell lancé ($SHELL -l, sinon /bin/zsh) et « Lancer OMP »
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
│   │   ├── ProjectPRPane.swift    le volet « PR et intégration continue » et ses lignes
│   │   ├── ProjectConsoleView.swift la fenêtre (en-tête d'informations, barre d'outils, PR, plan, document, conversation, feuille, inspecteur)
│   │   ├── ProjectView.swift      la section « Projet » (même surface)
│   │   └── ProjectLaunchSheet.swift la feuille « Piloter un projet… »
│   ├── Audit/                     la section « Audit » (liste, détail, feuilles de lancement et du brief, escalades, décisions)
│   ├── Store/                     la couche de lecture du magasin d'état
│   │   ├── PipelineStore.swift    racine du magasin et noms des huit stores
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
│   │   ├── MemoryOwnership.swift  le propriétaire de l'adresse (étranger) et son geste
│   │   ├── MemoryGraph.swift      la dérivation pure du graphe : nœuds, liens, visibilité
│   │   ├── MemoryGraphLayout.swift placement (Fruchterman-Reingold), vue écran, clic, scène
│   │   ├── MemoryLinkStore.swift  les liens manuels, dans `<racine de support>/memory-links.json`
│   │   ├── MemoryGraphModel.swift l'état du MODE GRAPHE : chargement, filtres, recherche, écritures
│   │   ├── MemoryGraphView.swift  le graphe : contrôles, canevas, fiche, feuilles d'écriture
│   │   ├── PodmanCleanupModel.swift le bandeau de nettoyage de l'ancien moteur : offre, confirmation, échec
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
│   │   ├── AlertDelivery.swift    livreur réel/no-op, autorisation, récepteur de clics (SEUL import UserNotifications)
│   │   ├── AlertLedger.swift      registre persisté des clés, lecture tolérante
│   │   ├── AlertsModel.swift      abonnement, décision, compteurs, autorisation, clic
│   │   └── AlertRouter.swift      clic d'une notification : payload, destination pure, routeur
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
│   │   ├── GestureRefusal.swift   la cause typée d'un refus de geste et sa traduction HTTP
│   │   ├── RemoteRouter.swift     la table des routes, un seul point de réponse
│   │   ├── RemoteStream.swift     le flux SSE : sources, battement, révocation
│   │   ├── RemoteServiceModel.swift l'interrupteur persistant et la composition du service
│   │   └── DevicesSettingsView.swift l'onglet Appareils des Réglages, ses états et ses textes
│   ├── Settings/                  le panneau Réglages (⌘,)
│   │   └── ConsoleSettingsView.swift la scène à un seul onglet « Appareils »
│   ├── Pending/                   la liste des attentes calculée sur le Mac
│   │   └── LocalPendingRequests.swift magasin, ardoise locale et files de dialogues → liste
│   └── MenuBar/                   l'item de barre de menus, ses comptes, les séparateurs des menus
│       ├── AlertsStatus.swift     l'état publié : comptes « À vous » / « En cours » de l'Accueil
│       ├── MainMenuSeparators.swift masque les séparateurs de tête, de fin et doubles de la barre des menus
│       └── StatusItem.swift       titre pur + contrôleur AppKit de l'item
├── Sources/ConsoleCore/           la cible partagée macOS/iOS (extrait)
│   ├── Session/RpcDialog.swift    la demande de dialogue du service OMP, type unique Mac/iPhone
│   └── Pending/                   la liste des attentes
│       └── PendingRequests.swift  toutes les demandes qui posent une question (fonction pure)
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
huit sections, dérivées du type partagé `ConsoleSection` (Terminal et Fichiers
sont hors périmètre), une seule barre d'onglets native (`TabView`, style
`.sidebarAdaptable`) — sur iPhone, cinq onglets en bas (Accueil, Pipelines,
Sessions, Mémoire, « Plus »), « Plus » étant une liste titrée qui pousse Projet,
Audit, Session OMP et Statistiques dans sa propre pile ; sur iPad, une barre latérale
titrée « OMP Console », visible dès le lancement, à deux groupes (Pilotage :
Accueil, Pipelines, Projet, Audit, Session OMP ; Consultation : Sessions, Mémoire,
Statistiques), la barre d'onglets du haut n'apparaissant que lorsqu'on masque la
barre latérale — et, pour chaque section, son écran avec son état vide RÉEL.
Chaque onglet garde sa pile et sa position de défilement quand on en change ;
passer en largeur compacte (iPad en Split View) range Projet, Audit, Session OMP et
Statistiques sous « Plus », et inversement. Le routage onglet ↔ section est pur
(`IOSTabs.swift`, testé par `IOSTabsTests`). Elle n'a ni magasin local, ni
écriture du magasin : son seul accès
réseau est le client distant (`ConsoleClient`) — découverte Bonjour, appairage au
trousseau et feuille de connexion. Le Mac découvert est joint par son adresse
IPv4 ou IPv6, lien-local zoné compris ; une adresse s'affiche toujours sans sa
zone d'interface (`192.168.1.175:8787`, `[fe80::1]:8787`), adresse manuelle
comprise (`ClientAddress.display` ; la forme enregistrée `ClientAddress.text`
garde la zone).
Le bouton antenne (« Connexion ») rouvre la feuille de connexion à tout moment,
connecté ou non, une seule fois par écran : sur iPhone, dans la barre de chaque
onglet, de la liste « Plus » et des écrans qu'elle pousse ; sur iPad, une fois,
dans la barre de la section. La recette historique
`scripts/recette/ios-connexion-recette.sh --connected <UDID> --unpaired <UDID>
--ipad <UDID>` l'a prouvé au simulateur avec `idb` sur l'ancienne coque (captures
sous `omp-console/build/ios-connexion/`). Elle compile elle-même une app signée
(`scripts/ios-build.sh` compile sans signature, et le trousseau du simulateur
refuse alors d'écrire le jeton d'appairage : l'état connecté serait
inatteignable) et veut des simulateurs dédiés, que les autres runs
(`ios-shots.sh`) ne pilotent pas. Elle et `scripts/recette/ios-accessibilite-localisation-recette.sh`
naviguent par l'ancienne liste racine (`ios.section.*`) et ne s'appliquent plus à
la coque à onglets : celle-ci se prouve par `scripts/recette/ios-navigation-onglets-recette.sh`
(voir plus bas).

Hors connexion, les huit sections suivent la même règle, sur iPhone comme sur
iPad. Rien encore chargé : la section n'affiche QUE le composant « non connecté »
— « Pas de connexion au Mac », une phrase de cause (non appairé, appairage refusé
ou révoqué, Mac injoignable, ou l'app à mettre à jour) et « Se connecter », qui
ouvre la feuille Connexion — ou, pendant une tentative, le composant « Connexion
au Mac… » avec son indicateur d'attente et aucun bouton. Données déjà chargées :
elles restent affichées, sous le même composant en bandeau, qui disparaît seul à
la reconnexion. Tant que le Mac n'est pas connecté, les gestes qui l'exigent
restent visibles mais grisés. L'**Accueil** est ensuite un écran à quatre états :
« OMP absent sur le Mac », chargement,
premiers pas, et tableau de bord. Le tableau de bord montre le bandeau de
préparation, l'accusé de commande, puis cinq sections où chaque carte n'apparaît
qu'une fois : « À vous » (cartes d'attente avec « Répondre… », « Valider les
specs », « Accepter la revue », « Lire le contrat », et les pipelines « En échec »
ou « Bloquée » avec l'étape où elles se sont arrêtées et « Reprendre »), « En
cours » (pipelines réellement en marche, avec leur durée), « À reprendre »
(pipelines en pause, puce « En pause » et « Reprendre »), « Pas commencées »
(features jamais lancées) — ces deux-là masquées quand elles sont vides — et
« Livrées récemment » (bouton « Ouvrir la PR » ; PR ouvertes, créées, fusionnées
ou fermées, closes depuis 7 jours au plus) — les MÊMES listes que l'Accueil macOS,
dérivées du noyau partagé `ConsoleCore` (`HomePresentation.dashboard`). Le
« Reprendre » d'une carte en échec ou bloquée part par la même route que celui
d'une pause (`POST v1/cards/:id/resume`) ; le Mac y reconnaît une pipeline
relançable et poste la commande `relaunch`, et un refus s'affiche sur la carte
(« La pipeline n'a pas repris. » et sa cause). Une rangée tient sur une ligne
quand le nom, la puce et le bouton y tiennent ; sinon le nom passe sur sa ligne,
puis la puce et le bouton côte à côte sur la suivante ; s'ils ne tiennent pas
ensemble, chacun a sa ligne. La règle ne regarde que la place mesurée, quelle que
soit la taille de texte, sur iPhone comme sur iPad, et aucune taille de texte n'est
plafonnée. Les gestes de carte suivent l'envoi : « Valider les
specs » demande une confirmation (elle lance l'implémentation sur le Mac),
« Reprendre » et « Accepter la revue » partent aussitôt ; pendant l'envoi, le
bouton est désactivé et montre « Envoi en cours » jusqu'à la réponse du Mac, sans
second envoi possible ; un échec s'affiche sur la carte concernée, en français et
sans détail technique, et le succès n'a pas de message (la carte suit l'ardoise).
L'onglet Accueil (iPhone) et l'entrée Accueil de la barre latérale (iPad) portent
le badge du nombre d'attentes quel que soit l'onglet affiché (aucun autre onglet
n'en porte, et rien à zéro) ; VoiceOver lit « Accueil, N en attente ». Trois
feuilles s'ouvrent depuis l'écran : « Répondre » (options d'un ask ou texte
libre), Contrat (sections rendues en Markdown, bloc par bloc) et Bienvenue (première ouverture d'une
installation neuve ; « Continuer » y pousse la Connexion dans la même feuille). Le crochet de recette
`-home.recipe <dashboard|degraded|firstRun|loading|ompMissing|answer|contract|contractLong|longTitles|slowMac>`
force un état depuis la fixture partagée `HomeParity` pour les captures
(`longTitles` : le tableau de bord dont les rangées « En cours », « À reprendre »,
« Pas commencées » et « Livrées récemment » portent un titre de 40 caractères ;
`slowMac` : le tableau de bord dont l'envoi des gestes de carte ne répond jamais,
pour capturer « Envoi en cours ») ; il nourrit aussi le badge de la ligne Accueil
(5 pour
dashboard/answer/contract/contractLong/degraded/longTitles/slowMac, 0 pour
loading/firstRun/ompMissing). Le crochet `-home.row <n>` amène la rangée
d'index `n` du tableau de bord en haut de l'écran (captures des rangées en
Dynamic Type).

La **feuille Connexion** ne s'ouvre d'elle-même que lorsque l'appareil n'a pas de
jeton d'appairage ou que le Mac refuse le sien — jamais pendant la lecture du
trousseau au lancement, jamais pour un appareil appairé : un Mac injoignable
(veille, autre réseau) laisse l'Accueil sur le composant « non connecté », cause
« Mac injoignable ». Après la fermeture de la bienvenue (qui contient déjà la
Connexion), elle ne s'ouvre plus d'elle-même sans jeton pendant le lancement ;
un jeton refusé la rouvre toujours.
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
masquée, iPhone Pro Max en paysage), Accueil, Sessions, Mémoire en mode Liste,
Projet, Statistiques et Session OMP posent leur contenu dans une colonne centrée
de 720 pt marges comprises (`IOSMetrics.readableWidth`, soit une surface de
672 pt), mise à l'échelle par Dynamic Type (`iosReadableWidth()`) ; le reste de la
fenêtre forme deux marges égales. Le défilement garde toute la largeur : un
glissement dans une marge fait défiler l'écran. Sous ce plafond (iPhone en
portrait, iPad barre latérale visible en portrait), rien ne change. Le tableau
Pipelines et le mode Graphe de la Mémoire restent pleine largeur.

### Erreurs du Mac

Toute erreur rendue par le Mac — Mémoire (liste, recherche, graphe), Sessions,
Statistiques, Pipelines — passe par UN seul traducteur, `IOSMacErrorText`
(`omp-console/ios/OMPConsoleIOS/IOSMacErrorText.swift`). Il range l'échec en sept
causes distinguables et affiche la cause puis un remède propre à elle, sans URL,
sans adresse, sans JSON brut et sans code HTTP : « app Mac trop ancienne » (404
`route inconnue`, ou 404/405 hors contrat), « Mac injoignable » (connexion refusée,
délai dépassé, Mac non connecté), « service indisponible sur le Mac » (503),
« action refusée par le Mac » (403), « refus du Mac » avec son motif (400, 409 ou
404 métier, tant que le motif est présentable), la version de protocole
incompatible, et le message générique « le Mac a rencontré une erreur » (500,
corps illisible, code inattendu). Le mode Graphe de la Mémoire ajoute une huitième
formulation, « service mémoire trop ancien » (`outdated_service`), que la liste et
la recherche n'ont pas. Un **401** n'affiche aucun message de section : le parcours
de jeton révoqué est inchangé (secret effacé du trousseau, retour à l'appairage).
Seul le message exact « route inconnue » vaut « app Mac trop ancienne » ; tout
autre 404 est un refus métier. Chaque échec de chargement propose « Réessayer »
(44 pt) ; un geste d'écriture n'en propose pas. La table cause → message est dans
`omp-console/ios/DESIGN.md` (« Erreurs du Mac »).

### Section Pipelines

La section Pipelines affiche l'ardoise des features et des runs de tous les
dépôts — les cinq voies et leurs cartes — dérivée du magasin que le Mac sert par
la trame `store`, sans jamais inventer de donnée. La carte d'une feature offre
les gestes de la coque macOS : répondre à une question (option ou texte libre),
valider un jalon (specs ou revue), lancer une feature jamais en route, l'arrêter
(avec confirmation), la reprendre, ouvrir la PR dans le navigateur et la
fusionner (avec confirmation, après lecture fraîche du `headOid`). La feuille
« Nouvelle feature… » propose un dépôt (parmi les dépôts réels de l'ardoise),
deux modèles (« Modèle /req et /specs », « Modèle /impl et /review », mêmes libellés
que sur le Mac et sur la fiche d'une carte), un titre et un besoin, et crée la feature
sans aucune action sur le Mac. Le sélecteur de dépôt affiche le NOM du dossier
(jamais un chemin absolu ; pour les seuls homonymes, il y ajoute les derniers
segments du dossier parent, p. ex. « mem0-omp (Projets) »), ou l'invite « Choisir
un dépôt » tant qu'aucun n'est choisi — « Lancer » reste alors inactif ; la
valeur lancée est toujours le chemin complet. Les champs titre et besoin portent
les libellés VoiceOver « Titre » et « Besoin » ; le besoin est une zone
multiligne de 3 lignes à vide, qui grandit jusqu'à 8 lignes puis défile dans le
champ.

Sur iPhone (largeur compacte), les voies sans carte sont masquées et « Livrées » et « Arrêtées » s'ouvrent repliées — seul leur en-tête et leur compte sont visibles ; un toucher sur l'en-tête les déplie, et l'écran les replie à chaque nouvelle visite. Sur iPad, toutes les voies ont la même largeur, qui grandit avec la taille de texte, et s'alignent en haut ; quand elles ne tiennent pas à l'écran, elles défilent horizontalement jusqu'à une marge de fin, après la dernière voie. Le titre d'une carte passe à la ligne et n'est jamais tronqué, dans toutes les voies.

Une carte ne montre jamais de marque brute (« Marques : mort ») : une carte dont
le pilote s'est arrêté dit « Elle s'est arrêtée de façon inattendue. », une carte
dont une source est illisible « Une partie de ses données est illisible. », une
carte décrite deux fois « Deux sources la décrivent. » (phrases partagées
`KanbanText.marksSentence`, dans l'ordre des marques) ; une carte saine n'a
aucune ligne. L'iOS n'a pas de « Copier le diagnostic » : le détail technique
reste sur le Mac.

Deux routes étendent la surface distante pour cette section : `GET /v1/models`
(le catalogue de `omp models --json`, qu'aucune route n'exposait ; il rend aussi
`names`, sélecteur → nom lisible, absent d'un Mac antérieur) et le champ
additif `headOid` de la ligne de PR (sans lui, la fusion est impossible). La
recette de bout en bout (dépôt jetable, iPad, Mac en service) est un test gated
par `MEM0_PIPELINES_RECIPE` ; le scénario iPad reste manuel et vit dans le
contrat de la feature. La recette de design iOS fait autorité et vit dans
`omp-console/ios/DESIGN.md`.

### Section Sessions

La section Sessions liste les runs du magasin d'état — ceux de tous les dépôts et
de tous les processus OMP du Mac, y compris une session lancée par un `omp` en
terminal hors coque — groupés par jour sous les mêmes en-têtes que la coque macOS
(« Aujourd'hui », « Hier », puis la date). Un menu filtre la liste par projet :
son libellé visible est la valeur choisie, entière à toute taille de texte, et
VoiceOver l'annonce « Projet, <valeur> » ; choisir « Tous les projets » la
restitue entière et les en-têtes de jour se recalculent. Chaque ligne a une marge
verticale qui grandit avec la taille du texte ; aux tailles d'accessibilité,
l'icône d'étape, les textes et la puce d'état s'empilent au lieu d'être coupés.
La liste vient de la dérivation partagée `ConsoleCore` (`SessionList`,
`SessionDays`), alimentée par l'instantané que la trame `store` publie — aucune
route n'est appelée pour lister.

Ouvrir une ligne pousse une **visionneuse en LECTURE SEULE** : elle rend le fil
d'une session par le même modèle de lignes que macOS (`SessionRowBuilder`),
messages et rôles, pensées repliables, appels d'outil et leurs résultats, diffs
colorés et libellés par `SessionDiffText`, question `ask` mise en évidence et
dépliée d'emblée — sans aucun moyen de répondre ni d'écrire dans la session. Les
arguments d'un appel déplié s'y lisent en clé/valeur comme sur macOS
(`IOSToolArgumentsView`, même lecture `ToolArguments`) : hiérarchie indentée,
libellés français des six outils courants, code à chasse fixe, extrait et
« Afficher plus » pour une valeur longue, « Aucun argument » / « Arguments
illisibles », JSON brut replié derrière « Afficher le détail brut ». Un
run vivant s'ajoute en direct (une seule lecture, puis le flux de cette session),
en préservant la position et l'état replié/déplié, et le fil reste collé au bas
tant que l'utilisateur n'a pas remonté. Le fil s'ouvre sur sa fin (pile `VStack`
non paresseuse et ancre initiale
`defaultScrollAnchor(.bottom, for: .initialOffset)`), précédé de « Chargement de
la session… » tant que la lecture n'est pas finie ; le fil de Session OMP se lit
et s'abonne dès que l'écran le monte. Les composants du fil (modèle, vue, ligne,
arguments, feuille) sont réutilisables par la section Session OMP : leur seul
contrat d'entrée est une référence de session et une source.

L'en-tête de la feuille porte l'état du RUN (`IOSSessionThreadModel.runStatus` :
« En cours », « À vous », « Terminé » ou « Échec ») ; le fil porte, lui, sa puce
`ios.session.thread.status` (« En direct », « Démarrage »). Quand le run de la
feuille est fini — clos, ou absent de l'instantané — la feuille montre « Terminé »
dans son en-tête, une seule fois, et AUCUN « En direct » : la puce du fil
disparaît, y compris si le run se termine pendant que la feuille est ouverte
(`refreshRunStatus()`, à chaque trame `store`). Le fil de la session hébergée
(section Session OMP, `tracksRun: false`) n'est pas un run du magasin : il garde
« En direct » tant qu'il suit le bas. La preuve visuelle vient des recettes
`visionneuse` (« Terminé » une fois, aucun « En direct ») et `en-direct` (« En
cours » et « En direct »).

### Recette : la section Sessions

Le crochet `-sessions.recipe` force un état RÉEL de l'écran depuis la fixture
partagée `SessionParity`, sans écran fabriqué ; la DERNIÈRE paire reconnue gagne,
et une valeur inconnue est ignorée :

```
-sessions.recipe <liste|vide|visionneuse|illisible|erreur|en-direct|phases|longue|chargement|fil-vide|suivi>
```

- `liste` — la liste peuplée de la session de la fixture ;
- `vide` — l'état vide réel de l'écran ;
- `visionneuse` — la feuille du fil ouverte sur la session ;
- `illisible` — le cas d'une session illisible ;
- `erreur` — la feuille d'un run vivant dont la lecture échoue (statut 500) : la
  bannière d'erreur de la visionneuse et « Réessayer », qui relit et retombe dans
  la même erreur ;
- `en-direct` — le fil d'un run vivant ;
- `phases` — une session terminée par étape de pipeline (mêmes titre, dépôt et
  heure) : les icônes d'étape diffèrent, les titres doivent rester alignés ;
- `longue` — une liste de 24 sessions terminées, d'identités distinctes, assez
  longue pour défiler sur iPhone (preuve de la position de défilement conservée
  au changement d'onglet) ;
- `chargement` — la feuille ouverte sur une lecture qui ne se termine jamais :
  « Chargement de la session… » reste affiché sous l'en-tête ;
- `fil-vide` — la feuille ouverte sur la fixture sans aucune entrée : l'état vide
  « Session vide » ;
- `suivi` — la feuille d'un run vivant, puis trois messages « Message de suivi
  n° 1…3 » ajoutés par le flux à +8 s, +12 s et +16 s après l'ouverture : au bas,
  ils s'affichent sans geste ; remonté, la position ne bouge pas et « Revenir au
  direct » apparaît.

Un appel d'outil resté sans résultat dans une session finie affiche « Interrompu »
(icône fixe) au lieu de l'indicateur d'activité : la recette `visionneuse` le
montre sur l'appel `ask` et l'appel de mémorisation de la fixture, la recette
`en-direct` garde leur indicateur « en cours ».

Les preuves Swift de la section vivent dans
`omp-console/ios/OMPConsoleIOSTests/IOSSessionTests.swift` (motif de parité
compris), `omp-console/ios/OMPConsoleIOSTests/IOSRowAccessibilityTests.swift`
(rangées lues par VoiceOver) et `omp-console/Tests/OMPConsoleTests/SessionParityTests.swift`
côté macOS ; la garde textuelle est `test/console/ios-sessions.test.ts`. La recette de
design iOS fait autorité et vit dans `omp-console/ios/DESIGN.md`.

### Recette : la feuille Connexion

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

### Les feuilles

Les feuilles de l'app iOS ont toutes leur titre EN LIGNE dans la barre, lu en
entier (jamais « … »), sur iPhone comme sur iPad — sauf la page de bienvenue, sans
barre, dont le grand titre est dans le contenu. Sur iPhone, leur taille ne
change pas (pleine hauteur, pleine largeur) ; sur iPad, elles suivent deux
familles :

| Feuille | Titre de barre | Boutons de barre | Taille iPad |
|---|---|---|---|
| Bienvenue | aucune barre sur la page de bienvenue (grand titre centré dans le contenu) ; Connexion poussée : « Connexion » | page de bienvenue : aucun (« Continuer » ancré en bas) ; Connexion poussée : retour ‹ et « Plus tard » | par défaut |
| Répondre | « Répondre » (le titre de la carte ouvre le contenu) | ✕ / ✓ | par défaut |
| Contrat | « Contrat » | « Fermer » | page |
| Connexion | « Connexion » | « Fermer » | par défaut |
| Piloter un projet | « Piloter un projet » | ✕ / ✓ | ajustée |
| OMP vous demande | « OMP vous demande » | ✕ / ✓ (✕ seul pour une confirmation) | par défaut |
| Lancer une session OMP | « Lancer une session OMP » | ✕ / ✓ | ajustée |
| Session (visionneuse) | « Session » (le titre de la feature ouvre l'en-tête) | « Fermer » | page |
| Nouvelle feature | « Nouvelle feature » | ✕ / ✓ | par défaut |
| Souvenir (fiche) | « Souvenir » | « Fermer » | page |

- **page** : quasi pleine largeur, pour un contenu long ; **ajustée** : la largeur
  du formulaire (580 pt) et une hauteur qui suit le contenu, y compris quand il
  change après l'ouverture (chargement, puis liste ou erreur).
- Deux boutons TEXTE ne laissent pas la place d'un titre en ligne sur un iPhone de
  390 pt : « Annuler » et le bouton de validation sont donc des icônes ✕ / ✓ de
  44 pt (`IOSSheetIconButton`), à la même place. VoiceOver lit le texte de
  l'ancien bouton (« Annuler », « Piloter », « Lancer la session »…) ; le ✓ est
  gris quand il est inactif, de la couleur d'accent sinon. Les feuilles à un seul
  bouton gardent « Fermer » en texte.
- La Bienvenue (style Apple : grand titre centré, trois promesses à grande icône
  sans panneau, « Continuer » pleine largeur ancré en bas, au-dessus duquel le
  contenu défile aux grandes tailles de texte) est une feuille unique :
  « Continuer » l'enregistre comme vue puis pousse l'écran Connexion DANS la même
  feuille (retour ‹ vers la bienvenue, « Plus tard » ou Échap pour fermer, aucun
  « Fermer ») ; un appareil déjà appairé voit la feuille se fermer. Un appairage
  réussi depuis cet écran ferme la feuille. Toute fermeture — « Plus tard »,
  balayage vers le bas, appairage, « Continuer » d'un appareil appairé —
  l'enregistre comme vue (elle ne réapparaît pas au lancement suivant) et reporte
  l'ouverture automatique de la Connexion pour le lancement : l'Accueil montre
  « Pas de connexion au Mac » et « Se connecter », qui ouvre la feuille Connexion
  autonome ; seul un jeton refusé la rouvre d'elle-même. Ses icônes occupent une
  colonne de largeur fixe, à l'échelle du texte : titres et détails des trois
  promesses commencent au même x.
- Dans « Piloter un projet » et « Lancer une session OMP », un dépôt est désigné
  par son nom de dossier, suivi du parent entre parenthèses s'il a un homonyme ;
  le dépôt choisi porte une coche, et VoiceOver annonce son nom et l'état
  « sélectionné ». Les chemins du Mac encore affichés (en-tête de l'écran Projet,
  cibles d'outil du fil de session) s'abrègent en `~/…` grâce au dossier personnel
  publié par le Mac (`homeDirectory` de `GET /v1/components`).

Les règles jugeables vivent dans `omp-console/ios/DESIGN.md` (« Les feuilles »).

### Recette : les feuilles

`scripts/recette/ios-feuilles-recette.sh` capture les neuf feuilles (Répondre, Contrat,
Connexion, Piloter un projet, OMP vous demande, Lancer une session OMP, Session,
Nouvelle feature, Souvenir) sur un iPhone 17e et un iPad Pro 11" (M5)
**privés** (`feuilles-recette-tel`, `feuilles-recette-tab`, iOS 27, apparence
claire, taille de texte `large`), créés par le script et supprimés à la sortie.
Il construit l'app **signée** depuis l'arbre de travail (DerivedData sous
`/tmp`) et ne touche ni à un autre simulateur, ni à l'app Mac, ni au focus du
Mac. Lancé à la main depuis la racine du dépôt, jamais par `check.sh` ni la CI :

```bash
# Relevé « avant » (avant toute retouche visuelle), puis « après » en fin de feature.
bash scripts/recette/ios-feuilles-recette.sh avant [--source <udid appairé>]
bash scripts/recette/ios-feuilles-recette.sh apres [--source <udid appairé>]
```

- Les feuilles s'ouvrent par les crochets de recette (`-home.recipe`,
  `-projet.recipe`, `-sessionomp.recipe`, `-sessions.recipe visionneuse`,
  `-pipelines.recipe choisi`, `-memoire.recipe liste`), sans écriture vers le Mac.
- `--source <udid>` désigne un simulateur DÉJÀ appairé au Mac : son trousseau et
  `com.omp.console.ios.plist` sont greffés sur l'iPad privé ; il n'est que lu.
  L'iPhone privé n'est jamais appairé.
- Sorties dans `omp-console/build/feuilles-ios-presentation-et-depots/<avant|apres>/`
  (ignoré par git, vidé au début du run) : `<feuille>-<tel|tab>.png` et `.json`
  (`idb ui describe-all`), `rapport.txt` (une ligne `ok|échec|sauté <AC>
  <tel|tab> <feuille> <détail>` par contrôle) et `build.log`.
- La ligne de provenance du rapport dit d'où viennent les captures iPad :
  `provenance ipad appairé` quand l'iPad greffé affiche « Connecté à » dans les
  60 s, sinon `provenance ipad recette <raison>` — `--source absent`, ou
  `greffe : pas de « Connecté à » en 60 s` — et les feuilles s'ouvrent alors sur
  les seules données de recette.
- Contrôles : largeur « page » (AC-1), hauteur ajustée (AC-2), iPhone inchangé
  par rapport au relevé `avant` (AC-3), titre exposé et place suffisante entre les
  boutons de barre (AC-4), libellés des dépôts sans chemin ni bleu lien (AC-5),
  rangée choisie `Selected` avec coche visible et non lue (AC-6), barre et marges
  de la fiche d'un souvenir (AC-10). La Bienvenue (ses anciens AC-8 et AC-9 :
  colonne d'icônes, absence après balayage puis relance) est passée à la recette
  suivante, qui juge sa nouvelle mise en page et son flux en une feuille.
- Codes de sortie : en `avant`, 0 dès que les 18 captures sont écrites (les
  échecs y sont attendus et seulement consignés) ; en `apres`, 0 si tout est
  `ok`, 1 sur tout `échec` (ou build, appareil, feuille non ouverte en défaut),
  2 non exécuté (hors macOS, Xcode inutilisable, idb ou Python 3 + Pillow absents,
  aucun runtime iOS ≥ 26, app non signée).

### Recette : bienvenue et Connexion en une feuille

`scripts/recette/ios-onboarding-recette.sh` prouve la feature ios-onboarding-et-connexion
sur un iPhone 18 Pro et un iPad Pro 11" (M5) **privés** (`onb-tel`, `onb-tab`,
iOS 27.0, apparence claire), créés à chaque passe, démarrés sans Simulator.app et
supprimés à la sortie (un appareil de même nom laissé par une passe interrompue
est supprimé d'abord ; `pgrep -fl <UDID>` est relevé avant `simctl delete`, et un
simulateur non supprimé rend la sortie 2). L'app est construite **signée ad hoc**
(sinon le trousseau du simulateur refuse le jeton d'appairage). Lancée à la main
depuis la racine du dépôt, jamais par `check.sh` ni la CI :

```bash
# Base fixe 8659c30 (worktree détaché temporaire), puis arbre de travail.
bash scripts/recette/ios-onboarding-recette.sh --avant
bash scripts/recette/ios-onboarding-recette.sh [--sans-mac] [--bundle <OMP Console.app>]
```

Contrôles, une ligne `✔|✗|–  <AC>  <tel|tab>  <détail>` chacun dans
`rapport.txt` :

- **AC-1** (tel, tab ; taille `large`) — premier lancement sans argument de
  bienvenue : titre `HomeText.welcomeTitle` centré sur l'écran (± 1 pt) et haut
  d'au moins 34 pt, les 6 textes des promesses, les 3 titres au même x (± 1 pt),
  « Continuer » centré, haut d'au moins 44 pt, sous les promesses, à ≤ 40 pt des
  bords de l'écran (iPhone) ou de la feuille (iPad, bords lus dans les pixels de
  la capture : `idb` n'expose pas le cadre de la feuille).
- **AC-2** (tel, tab ; `accessibility-extra-large`) — captures haut et bas
  (défilement) : « Continuer » entièrement dans l'écran sur les deux, titre et
  6 textes vus en entier entre le haut de la feuille (arête lue dans la capture)
  et la barre de « Continuer ».
- **AC-3** (tel) — « Continuer » sous enregistrement vidéo (`simctl io
  recordVideo`, 3 s ; images à 10/s extraites par un outil AVFoundation compilé
  par `swiftc`, sans ffmpeg ; planche `tel-continuer-planche.png`) : en ≤ 4 s,
  `connection.sheet` et `connection.later` présents, `connection.close` absent.
  « Plus tard » est lu par `idb ui describe-point` au centre droit de la barre
  (une barre de vue poussée n'est qu'un `Group` dans `describe-all`).
- **AC-4** (tel) — « Plus tard » : feuille fermée en ≤ 3 s, Accueil « Pas de
  connexion au Mac » dont « Se connecter » ouvre la Connexion (avec « Fermer ») ;
  bienvenue absente 8 s après la relance. Même contrôle par le balayage vers le
  bas de la page de bienvenue.
- **AC-8** (tel) — écouteur TCP muet de la recette sur `127.0.0.1:18788`, lancement
  `-home.welcomeSeen YES -client.manualAddress 127.0.0.1:18788`, saisie HID de
  `ABCD-EFGH` (disposition AZERTY/QWERTY détectée), deux appuis à 1 s (↩ dans le
  champ, le clavier couvrant « Appairer », puis un toucher) : « Appairage en
  cours… » visible, « Appairer » inactif, une seule requête `/pair` reçue ; puis,
  en ≤ 70 s, l'indicateur disparaît et le message d'erreur s'affiche.
- **AC-5, AC-7** (tel) — instance Mac de RECETTE (`--bundle`, défaut
  `omp-console/build/OMP Console.app` : `bash scripts/swift-app.sh --no-tests`),
  lancée par `open -g -n` sur une racine jetable au port 18787 et pilotée par la
  sonde AX de `scripts/recette/mac-appairage-sonde.swift`, sans activation, avec les
  pré-contrôles de `scripts/recette/mac-appairage-recette.sh` (session verrouillée,
  manifeste du bundle, port, Accessibilité, Space plein écran). Depuis la
  bienvenue (`-client.manualAddress 127.0.0.1:18787`, « Continuer ») : un code
  frais du Mac (retiré jusqu'à contenir 0 ou 1), saisi en minuscules avec une
  espace, 0 → o et 1 → l ; AC-7 vert si une ligne d'appareil neuve apparaît sur
  le Mac en ≤ 10 s, AC-5 vert si, en ≤ 30 s, la feuille est fermée et l'Accueil
  connecté. Chaque appareil appairé par la passe est révoqué au nettoyage (le
  jeton Mac va au trousseau réel). Un pré-contrôle manquant, ou la préparation de
  l'instance en échec (par exemple « Une autre app occupe la place réservée à la
  mémoire » quand OMP Console est ouverte), rend ces deux lignes « – » avec la
  cause. `--sans-mac` ne lance aucune instance : « – » aussi, la preuve restant
  `successfulPairingFinishesTheFlow` (AC-5) et les tests de format (AC-7).

- Sorties dans `omp-console/build/ios-onboarding/<avant|apres>/` (`--out` pour
  un autre dossier ; vidé au début) : `rapport.txt`, captures PNG et relevés
  `describe-all` JSON de chaque contrôle, `xcodebuild.log`.
- Codes de sortie : 0 tout vert (« – » admis sur AC-5/AC-7 seulement), 1 au moins
  un ✗ (ou build, simulateur en défaut), 2 non exécuté (hors macOS, outil ou
  Pillow absent, Xcode inutilisable, runtime iOS 27.0 absent, app non signée,
  port 18788 tenu, simulateur ou worktree non retiré). En `--avant`, les rouges
  sont attendus : 0 dès que les 11 captures existent.
- Durée mesurée le 2026-10-11 (DerivedData déjà rempli) : 6 min 09 s en `--avant`,
  6 min 27 s en `--sans-mac`.

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
   dépôts connus du Mac, chacun par son seul nom de dossier (parent entre
   parenthèses s'il a un homonyme). Aucun chemin, aucune saisie de chemin.
   Sélectionner un dépôt (il porte une coche), puis ✓ (« Lancer la session »).
3. **Voir la session démarrer** — l'écran montre « Lancement de la session… », puis
   l'en-tête du dépôt avec la pastille « Session active » et le fil. Sur le Mac, la
   fenêtre « Session OMP » affiche la MÊME session, ouverte.
4. **Envoyer un prompt** — saisir un texte dans le composeur et « Envoyer » : le
   message apparaît dans le fil, puis la réponse de la session s'y ajoute sans
   geste. Le champ se vide après un envoi réussi.
5. **Répondre à un dialogue** — quand la session pose une question, la feuille
   « OMP vous demande » s'ouvre : choisir une option (ou saisir un texte, ou
   éditer un plan prérempli), puis ✓ (« Répondre ») ; pour une confirmation,
   « Confirmer » ou « Refuser » ; ✕ (« Annuler ») annule le dialogue. La feuille se ferme et la
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
`test/console/ios-session-omp.test.ts`.

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

L'icône de l'app iOS vient du catalogue `OMPConsoleIOS/Assets.xcassets`
(`AppIcon`, variantes claire, sombre et teintée) ; elle est dessinée avec celle du
Mac par `bash scripts/app-icon.sh` (voir « Assembler le bundle `.app` »), jamais
à la main dans Xcode. Le même catalogue porte l'`AccentColor`, égale au bleu
système. Les règles d'identité de l'app sont dans `omp-console/ios/DESIGN.md`.

### Captures des huit écrans

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/recette/ios-shots.sh
```

Le script démarre un simulateur iPhone et un iPad, installe l'app, puis l'ouvre
sur chacune des huit sections par son argument de lancement et capture l'écran :
**64 PNG** dans `omp-console/build/ios-shots/` (dossier ignoré par git — les
images sont des artefacts de PR, jamais committées) — huit écrans × {iPhone
portrait, iPad portrait} × {clair, sombre} à taille de texte par défaut, plus
huit écrans × {iPhone, iPad} × {clair, sombre} en Dynamic Type maximum (suffixe
`-ax`). Un SECOND groupe capture l'**Accueil** (feature `ios-accueil`) : ses cinq
états de recette (`dashboard`, `degraded`, `firstRun`, `loading`, `ompMissing`) et
ses feuilles « Répondre » et « Contrat » via `-home.recipe`, plus la feuille
Bienvenue — 8 états × {iPhone, iPad} × {clair, sombre} = **32 PNG**. Un
TROISIÈME groupe capture le **mode graphe de la Mémoire** (feature
`ios-memoire-graphe`) via `-memoire.recipe` : le graphe rendu, un état après
pan/zoom et une fiche ouverte — 3 états × {iPhone, iPad} × {clair, sombre} =
**12 PNG**. Un QUATRIÈME groupe capture les **rangées de l'Accueil en Dynamic
Type** (feature `ios-accueil-dynamic-type-casse`) via `-home.row <n>`, qui amène la
rangée d'index `n` (« En cours », « À reprendre », « Pas commencées », puis
« Livrées récemment ») en haut du tableau de
bord — 4 rangées × 3 tailles (`large`, `accessibility-extra-large`,
`accessibility-extra-extra-extra-large`), iPhone clair seulement = **12 PNG**
(`iphone-home-row<n>-<taille>.png`). Un CINQUIÈME groupe capture la feuille
**« Nouvelle feature »** (feature `ios-nouvelle-feature-formulaire`) via
`-pipelines.recipe <vide|choisi|rempli>` — aucun dépôt choisi, un dépôt et un
besoin court, un besoin de douze lignes — 3 recettes × {iPhone, iPad} × {clair,
sombre} = **12 PNG**, sans appairage. Un SIXIÈME groupe capture la **fiche d'une
carte Pipelines** (feature `ios-fiche-carte-pipelines`) via `-pipelines.recipe
<fiche|actions|arret>` : la vraie feuille ouverte sur une carte de fixture dérivée
de `HomeParity`, sans réseau — iPhone clair × {taille par défaut, AX-XL, maximum}
× {`fiche`, `actions`}, la confirmation d'arrêt (`arret`) à la taille par défaut,
et la fiche sur iPad = **8 PNG** `*-pipelines-fiche*.png`. Le script contrôle 132
captures avant ce groupe (64 + 32 + 12 + 12 + 12), refuse un groupe de fiche qui
n'en compte pas 8 et annonce le total réellement produit (**140**). Chaque capture
est sondée en dimensions (`sips -g pixelWidth -g pixelHeight`) : toutes PORTRAIT —
une capture inattendue ferait échouer le script.

La feuille Contrat a sa propre recette idb, pour les preuves avant/après de la
feature `contrat-ios-markdown-brut` : `bash scripts/recette/ios-contrat-recette.sh
<avant|apres>` ouvre la feuille sur un contrat long (`-home.recipe contractLong`)
dans deux simulateurs PRIVÉS, `omp-contrat-telephone` et `omp-contrat-tablette`
(créés au besoin sur le runtime iOS ≥ 26 le plus récent, jamais désinstallés ni
effacés), la fait défiler page par page et écrit captures, relevés
d'accessibilité et `rapport.txt` dans
`omp-console/build/contrat-ios-markdown-brut/<avant|apres>/` (ignoré par git).
Codes de sortie : 0 relevé écrit (en mode `apres`, toutes les lignes `ok`), 1
app absente, appareil en échec ou, en mode `apres`, un critère en `échec`, 2 non
exécuté (idb ou runtime absent). Elle n'entre pas dans le compte des 140 captures.

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
`memory`, `stats`) — sur iPad, l'entrée de la barre latérale ; sur iPhone,
l'onglet de la section, et pour `project`, `session` et `stats` l'onglet « Plus »
avec l'écran déjà poussé, le bouton retour ramenant à la liste « Plus » —,
`-ios.state error` affiche le bandeau d'erreur sur les
sept écrans, `-memoire.recipe <graphe|zoom|fiche>` force le mode graphe de la
section Mémoire sur la fixture partagée `MemoryGraphParity` (`liste` charge la
même fixture mais reste en mode LISTE et y ouvre la fiche d'un souvenir ;
`clavier` garde, lui, le mode Liste sans fiche et branche l'écran sur un lecteur
de cette même fixture, `IOSMemoryRecipeReader`, client `.connected` sans réseau :
le sommaire montre ses huit souvenirs, la recherche les filtre, et chaque lecture
du sommaire écrit `memoire-recipe-read` sur la sortie d'erreur du lancement ;
`injoignable` et `service-ancien` branchent la liste et le graphe sur un lecteur
qui échoue toujours, `IOSMemoryFailureReader` : `injoignable` reste en mode Liste
sur le bandeau « Mac injoignable. », `service-ancien` ouvre le graphe sur le
bandeau « Graphe indisponible : serveur mémoire trop ancien sur le Mac. », et
chacun écrit `memoire-recipe-ready` une fois l'échec affiché), et
`-pipelines.recipe` accepte deux familles de valeurs. `<vide|choisi|rempli>` ouvre
l'écran Pipelines sur la feuille « Nouvelle feature » avec des dépôts, un titre et
un besoin forcés (le reste est le chemin réel de la feuille) ; `<fiche|actions|arret>`
ouvre, avec `-section kanban`, la fiche de la carte de fixture (`actions` la défile
jusqu'aux gestes, `arret` y ouvre la confirmation d'arrêt) et l'app écrit
`pipelines-recipe-ready` sur la sortie d'erreur une fois l'état atteint.
`-projet.recipe lancement` ouvre « Piloter un projet » sur trois dépôts de fixture
(deux homonymes `mem0-omp`, un `site-vitrine`) avec `mem0-omp (Projets)`
présélectionné ; `-projet.recipe dialogue` présente « OMP vous demande » sur un
choix simple, qu'une réponse ou une annulation ferme sans réseau ;
`-projet.recipe saisie` présente la même feuille en forme éditeur (réponse libre,
sans texte prérempli), fermée de même sans réseau ;
`-projet.recipe plan` rend l'écran Projet vif sur la fixture `IOSProjectPlanRecipe`
(conduite `plan-recette`, six étapes dont la troisième courante, plus haut qu'un
écran en AX-XL), la connexion restant celle du client — gestes désactivés, aucun
appel réseau ; `-sessionomp.recipe lancement` ouvre « Lancer une session OMP » sur
la même fixture de dépôts. Ce sont des crochets de recette, pas des fonctionnalités.

`-stats.recipe <vide|chargement|bascule|pleine>` ouvre la section Statistiques sur son
modèle et son écran réels, nourris par une lecture en mémoire (projets
`recette-vide` et `recette-pleine`) et un client forcé connecté, sans appairage :
`vide` sert `recette-vide` (choisir `recette-pleine` dans le sélecteur sert son
tableau), `chargement` garde le premier relevé en cours, `bascule` sert
`recette-pleine` puis choisit `recette-vide`, dont le relevé reste en cours,
`pleine` sert `recette-pleine` pour toute clé, donc le tableau dès le lancement. La
DERNIÈRE paire reconnue gagne, une valeur inconnue est ignorée ; à lancer avec
`-section stats -home.welcomeSeen YES`. Ce sont des crochets de recette, pas des
fonctionnalités.

`-pipelines.board pleine` rend sur l'écran Pipelines l'ardoise de la fixture
partagée `KanbanBoardParity` (ConsoleCore) à la place de celle du Mac : une voie
« Pas commencées » vide, trois cartes « En cours » dont un titre long, une voie
« Livrées » de 100 cartes (98 avec une PR, 2 sans), deux dépôts dont un nom
long. Le bandeau de connexion n'est pas affiché, tout le reste est le chemin
réel ; au premier affichage l'app écrit `pipelines-board-ready` sur sa sortie
d'erreur. Les deux crochets `-pipelines.*` se combinent.

`-pipelines.board marques` rend à la place l'ardoise DÉRIVÉE de la fixture
`HomeParity` (la même que `-pipelines.recipe`, horloge fixe), qui porte la carte
« reprise » du lot `beta` au pilote arrêté : elle montre la phrase de ses marques
sans appairage, avec le même signal `pipelines-board-ready`.

La recette des voies et des cartes de Pipelines (feature
`pipelines-ipad-voies-sans-largeur`) s'appuie sur ce crochet :

```bash
bash scripts/recette/ios-pipelines-voies-recette.sh --phase avant|apres --source reel|fixture \
  --ipad13 <UDID> --ipad11 <UDID> --iphone <UDID>
```

Elle compile l'app SIGNÉE, l'installe par-dessus sur les trois simulateurs
passés (privés, déjà démarrés ; en source `reel`, appairés au Mac), puis capture
l'écran Pipelines en {large, accessibility-extra-large,
accessibility-extra-extra-extra-large} × {clair, sombre}, plus le défilement
horizontal au bout (iPad), la voie « Livrées » dépliée (iPhone) et, en fixture,
une carte livrée sans PR. Captures, relevés `describe-all` et `pixels.json` vont
dans `omp-console/build/pipelines-voies/<phase>/<source>/`. Elle imprime une ligne
`AC-<n> <appareil> <taille> <apparence> : <mesure> — ok|ÉCHEC` par constat (largeur
et haut des voies, marge de fin, actions des cartes, contraste carte/panneau en
sombre, rendu clair inchangé par rapport à la phase avant) et sort en 0 (tout
passe), 1 (au moins un ÉCHEC) ou 2 (non exécutée). Jamais lancée par check.sh ni
par la CI.

Pour ouvrir une section précise sur un simulateur déjà démarré :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -section memory
```

La capture de l'état d'erreur (artefact de PR, hors des 56) :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -section session -ios.state error
xcrun simctl io <UDID> screenshot omp-console/build/ios-shots/error-session.png
```

### Recette de la navigation à onglets

```bash
bash scripts/recette/ios-navigation-onglets-recette.sh --avant [<ref>]
bash scripts/recette/ios-navigation-onglets-recette.sh
```

La recette de la feature `ios-navigation-onglets-adaptables` prouve la coque à
onglets avant (`--avant`, par défaut `origin/main` après une mise à jour tentée
par HTTPS — l'URL SSH de `origin` est réécrite, sans invite ; un échec est noté
dans le rapport —, compilé depuis un worktree détaché) et après (le worktree
courant).
Elle crée ses propres simulateurs privés `zz-onglets-tel` (iPhone) et
`zz-onglets-tab` (iPad) sur iOS 27.0, les démarre, y installe l'app compilée
sans signature, puis les supprime en fin de course — elle ne touche à aucun
autre simulateur, n'ouvre pas `Simulator.app`, ne lance ni n'arrête l'app Mac et
n'appaire rien. Captures, relevés `idb` et rapports vont dans
`omp-console/build/ios-navigation-onglets-adaptables/{avant,apres}/` (non
versionné) ; `rapport.txt` porte une ligne `AC-<n> ✓|✗|– <tel|tab> <détail>` par
contrôle (en mode avant, des lignes `CONSTAT-<x>` sur l'ancienne coque), et le
mode après écrit `preuve.md` (commits mesurés, captures par section et appareil,
verdicts). Elle sort en 0 (aucun ✗), 1 (au moins un ✗) ou 2 (non conclu, par
exemple un simulateur non supprimé). Jamais lancée par check.sh ni par la CI.

### Recette des listes groupées natives

```bash
bash scripts/recette/ios-listes-groupees-recette.sh --avant <ref>
bash scripts/recette/ios-listes-groupees-recette.sh
```

La recette de la feature `ios-listes-groupees-natives` capture, avant (`--avant
<ref>`, compilé depuis un worktree détaché retiré à la sortie) et après (le
worktree courant), les six sections en liste groupée (`accueil`, `sessions`,
`memoire`, `pipelines`, `projet`, `statistiques`) sur iPhone en clair, sombre et
AX-XL et sur iPad en clair et sombre, et les six feuilles ouvertes depuis ces
sections sur iPhone (clair, sombre, AX-XL) : 48 captures par moment, chacune
avec son relevé `idb ui describe-all`. Elle compile l'app SIGNÉE ad hoc
(`CODE_SIGN_IDENTITY=-`, contrôle `codesign -dv`), crée ses simulateurs privés
`zz-listes-tel` et `zz-listes-tab` sur iOS 27.0 et les supprime en fin de
course ; elle ne touche à aucun autre simulateur, n'ouvre pas `Simulator.app`,
ne lance ni n'arrête l'app Mac et n'appaire rien. Sur iPad, la barre latérale
est masquée avant chaque capture (elle assombrit le contenu en portrait).
En mode après, `rapport.txt` porte une ligne `AC-<n> ✓|✗ <tel|tab> <détail>`
par contrôle (en-têtes natifs, chevauchements en AX-XL, titre unique,
défilement du plan jusqu'à sa dernière étape, cartes élevées distinctes du fond
au pixel) ; en mode avant, les mêmes mesures sortent en `CONSTAT-<n>`.
Sorties dans `omp-console/build/ios-listes-groupees-natives/{avant,apres}/`
(non versionné) et, en mode après, `preuve.md` (tableau avant/après des 48
captures, lignes AC). Codes : 0 (aucun ✗), 1 (au moins un ✗), 2 (non conclu,
par exemple un simulateur non supprimé). Jamais lancée par check.sh ni par la CI.

### Recette des Statistiques et du graphe accessibles

```bash
bash scripts/recette/ios-statistiques-graphe-recette.sh --avant <ref>
bash scripts/recette/ios-statistiques-graphe-recette.sh
```

La recette de la feature `ios-statistiques-et-graphe-accessibles` capture, avant
(`--avant <ref>`, compilé depuis un worktree détaché retiré à la sortie) et après
(le worktree courant), les Statistiques (`-stats.recipe pleine` et `vide`) et le
graphe de la Mémoire (`-memoire.recipe graphe` et `zoom`) : sur iPhone en clair,
en sombre et en clair avec le contraste accru (`simctl ui increase_contrast`,
remis à `disabled` après chaque capture), sur iPad en clair, soit 10 captures par
moment, plus les relevés `idb ui describe-all` des Statistiques pleines, vides et
du graphe (celui des Statistiques complété par balayages jusqu'à « Total du
projet », celui du graphe par `idb ui describe-point` sur le cadre du canevas :
`describe-all` ne rend pas les enfants `.accessibilityChildren`). Elle compile
l'app SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`, contrôle `codesign -dv`), crée ses
simulateurs privés `zz-statgraphe-tel` (iPhone 18 Pro)
et `zz-statgraphe-tab` (iPad Pro 13-inch (M5)) et les supprime en fin de course ;
elle ne touche à aucun autre simulateur, n'ouvre pas `Simulator.app` et ne lance
ni n'arrête l'app Mac. `rapport.txt` porte une ligne `ok|échec AC-<n> : …` par
contrôle (titres des deux graphiques et valeurs dessous, aucun graphique sans
donnée, 9 souvenirs et 2 étiquettes exposés à VoiceOver, présence des captures) :
bloquants en mode après, seulement consignés en mode avant. Sorties dans
`omp-console/build/ios-statistiques-et-graphe-accessibles/{avant,apres}/` (non
versionné) et `preuve.md` (tableau avant/après des 10 captures, et relecture
visuelle reprise de `relecture.md`, écrit à la main à côté pour survivre à une
nouvelle exécution). Jamais lancée par check.sh ni par la CI.

### Recette des gestes et retours natifs

```bash
bash scripts/recette/ios-gestes-retours-recette.sh --avant <ref>
bash scripts/recette/ios-gestes-retours-recette.sh
```

La recette de la feature `ios-gestes-et-retours-natifs` capture, avant
(`--avant <ref>`, compilé depuis un worktree détaché retiré à la sortie ; la
base mesurée est `f08bd37`) et après (le worktree courant) : les barres de
Pipelines (`-pipelines.board marques`) et de la Mémoire en Liste et en Graphe,
sur iPhone et iPad ; en après, le tirage pris à mi-geste et le compteur de
relecture `memoire-recipe-read` incrémenté par le tirage et, sur iPad, par ⌘R
« Actualiser » ; le toucher de « Sommaire » en mode Graphe (plus aucune bulle) ;
un menu contextuel ouvert par appui long sur une carte Pipelines, une carte
« À vous », une rangée Sessions et une rangée Mémoire ; la sélection de texte
de la visionneuse, du contrat et de la fiche d'un souvenir ; les vidages
d'accessibilité de l'Accueil, de la visionneuse, du fil vide et de
« Répondre ». Chaque capture a son relevé `idb ui describe-all`. Elle compile
l'app SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`, contrôle `codesign -dv`), crée ses
simulateurs privés `zz-gestes-tel` (iPhone 18 Pro) et `zz-gestes-tab` (iPad
Pro 13-inch M5) sur iOS 27.0, pilote l'app par `simctl launch` et `idb`
seulement, et supprime les deux simulateurs en fin de course ; elle ne touche
à aucun autre simulateur, n'ouvre pas `Simulator.app`, ne lance ni n'arrête
l'app Mac et n'appaire rien. En mode après, `rapport.txt` porte une ligne
`AC-<n> ✓|✗ <tel|tab> <détail>` par contrôle (AC-2, AC-3, AC-4, AC-5, AC-9,
AC-12, AC-13) ; en mode avant, les constats de l'audit sortent en
`CONSTAT-<n>`. Sorties dans `omp-console/build/ios-gestes-et-retours-natifs/{avant,apres}/`
(non versionné) : captures PNG, relevés JSON, `rapport.txt`, `commit.txt`,
`logs/` et, en mode après, `preuve.md`. Le retour haptique (que le simulateur
ne joue pas) et le survol d'iPad (qu'`idb` ne simule pas) se prouvent par les
tests Swift et la garde `test/console/ios-gestes-et-retours-natifs.test.ts`. Codes : 0
(aucun ✗), 1 (au moins un ✗), 2 (non conclu, par exemple un simulateur non
supprimé ou une erreur d'outil). Jamais lancée par check.sh ni par la CI.

### Recette des finitions de composants

```bash
bash scripts/recette/ios-finitions-composants-recette.sh --avant df08c50
bash scripts/recette/ios-finitions-composants-recette.sh
```

La recette de la feature `ios-finitions-composants` capture, avant (`--avant
<ref>`) et après (le worktree courant), dix cibles sur iPhone et sur iPad en
clair : `coche-dialogue` (« OMP vous demande », option choisie),
`saisie-vide`, `saisie-grandi` et `saisie-max` (réponse libre, `-projet.recipe
saisie`), `duree-carte`, `duree-fiche` et `duree-stats` (durées), puis
`depot-vide`, `depot-menu` et `depot-choisi` (dépôt de « Nouvelle feature ») :
20 captures par moment, chacune avec son relevé `idb ui describe-all`. L'avant
est compilé depuis un worktree détaché sur `<ref>`, retiré à la sortie, sur
lequel sont greffés les trois fichiers du crochet `-projet.recipe saisie`
(`IOSLaunchRecipe.swift`, `IOSLaunchRecipeText.swift`, `IOSProjectScreen.swift`,
aucun fichier de rendu) : sans eux, la base n'ouvre pas la forme éditeur. L'app
est compilée SIGNÉE ad hoc (`CODE_SIGN_IDENTITY=-`, contrôle `codesign -dv`) ;
les simulateurs privés `zz-finitions-tel` et `zz-finitions-tab` (iOS 27.0) sont
créés par le script et supprimés en fin de course, avec leur `idb_companion` ;
aucun autre simulateur n'est touché, `Simulator.app` n'est pas ouvert, l'app
Mac n'est ni lancée ni arrêtée, rien n'est appairé. La saisie passe par codes
HID (`idb ui key-sequence`, clavier AZERTY) par lots de 10 « qqqq␠ », et la
hauteur de `ios.projet.dialog.input` est relevée après chaque lot.
En mode après, `rapport.txt` porte une ligne `AC-<n> ✓|✗ <tel|tab> <détail>`
par contrôle : AC-2 (option choisie, aucun « ✓ » dans les libellés), AC-5 (H0 ≤
120 pt, hauteurs croissantes, plateau sur 2 lots), AC-6 (repères des trois
durées atteints, durée de la fiche lue), AC-8 (le menu propose les trois dépôts
et l'invite, la rangée montre le dépôt choisi) ; en mode avant, les mêmes
mesures sortent en `CONSTAT-<n>`. Compter une vingtaine de minutes par moment
sur un poste chargé (le premier relevé idb d'un simulateur neuf peut attendre
plusieurs minutes). Sorties dans
`omp-console/build/ios-finitions-composants/{avant,apres}/` (non versionné) et,
en mode après, `preuve.md` (tableau avant/après des 20 captures, contrôles).
Codes : 0 (aucun ✗), 1 (au moins un ✗), 2 (non conclu, par exemple un
simulateur non supprimé). Jamais lancée par check.sh ni par la CI.

### Recette Dynamic Type sans plafond

```bash
bash scripts/recette/ios-dynamic-type-recette.sh --avant <ref>
bash scripts/recette/ios-dynamic-type-recette.sh
```

La recette de la feature `ios-dynamic-type-ax-residuel` capture, avant
(`--avant <ref>`, compilé depuis un worktree détaché retiré à la sortie) et
après (le worktree courant), 27 cibles — Accueil (tableau de bord, titres
longs, réponse, contrat court et long, rangée « Reprendre »), Sessions, la
visionneuse (fil, en direct, illisible, `-sessions.recipe erreur`), Mémoire
(liste, graphe, fiche, souvenir, injoignable), Pipelines (tableau, ardoise,
fiche, nouvelle feature), Projet (plan, lancement, dialogue), Statistiques et
Session OMP — sur iPhone en `large`, `accessibility-extra-large` et
`accessibility-extra-extra-extra-large`, et sur iPad en `large` et
`accessibility-extra-large`, avec trois captures défilées par cible longue sur
iPhone aux deux tailles d'accessibilité. Chaque capture est prise au signal de
sa recette (`memoire-recipe-ready`, `memoire-recipe-read` pour `clavier`,
`pipelines-board-ready`, `pipelines-recipe-ready`) ou, à défaut, 7 s après le
lancement, avec son relevé
`idb ui describe-all`. Elle compile l'app SIGNÉE ad hoc
(`CODE_SIGN_IDENTITY=-`, contrôle `codesign -dv`), crée ses simulateurs privés
`zz-dtax-tel` et `zz-dtax-tab` sur iOS 27.0 et les supprime en fin de course
(companion `idb` tué, aucun processus restant) ; elle ne touche à aucun autre
simulateur, n'ouvre pas `Simulator.app`, ne lance ni n'arrête l'app Mac et
n'appaire rien. Sur iPad, la barre latérale est masquée avant chaque capture.
`rapport.txt` porte une ligne `AC-<n> ✓|✗|– tel <détail>` par contrôle : AC-3
(bouton « Reprendre » et titre de sa rangée plus hauts en AX-XXXL qu'en
AX-XL), AC-4 (« Valider les specs » plus large que haut, dans l'écran, seul sur
sa ligne), AC-6 (pastille du fil sans chevauchement avec « Mémorisation »),
AC-10 (bannière `ios.session.error` présente) et AC-11 (filtre
`ios.sessions.filter` dans la largeur de l'écran) ; en mode avant ces lignes
sont informatives et la recette `erreur`, inconnue de la base, est marquée
« sans objet ». Sorties dans
`omp-console/build/ios-dynamic-type/{avant,apres}/` (non versionné) : `png/`,
`logs/`, `rapport.txt` et, en mode après, `preuve.md` (table des constats de
l'audit, contrôles, et une ligne de relecture par paire avant/après, dont les
colonnes déjà remplies sont reprises quand la passe après est relancée).
Codes : 0 (aucun ✗ en mode après), 1 (au moins un ✗ en mode après), 2 (non
conclu, par exemple un simulateur non supprimé). Jamais lancée par check.sh ni
par la CI.

### Recette idb de la fiche d'une carte

```bash
IOS_RECETTE_IPHONE=<UDID> IOS_RECETTE_IPAD=<UDID> bash scripts/recette/ios-fiche-carte-recette.sh
```

Le script compile l'app, l'installe sur un iPhone et un iPad du simulateur, lance
`-pipelines.recipe` et lit l'arbre d'accessibilité (`idb ui describe-all`) : titre
unique, identifiants distincts, lignes de modèle, hauteurs ≥ 44 pt de « Reprendre »,
« Arrêter… » et « Fermer » (aux trois tailles de Dynamic Type), confirmation d'arrêt
puis annulation, fermeture de la fiche, fiche iPad. Une ligne `AC-<n> ✓ …` par
constat, `AC-<n> ✗ … (<valeur observée>)` sinon. `IOS_RECETTE_IPHONE` et
`IOS_RECETTE_IPAD` désignent les simulateurs à employer ; sans eux, le script prend
le premier iPhone et le premier iPad du runtime iOS ≥ 26 le plus récent — des
appareils PARTAGÉS avec les autres lancements, donc à éviter pendant un constat.
`content_size` est remis à `large` à la sortie. Codes de sortie : `0` tout passe,
`1` un constat (ou le build) échoue, `2` « non exécuté » (macOS, Xcode, idb ou
runtime iOS ≥ 26 absents). Sur iOS 27, la confirmation d'arrêt est une bulle
ancrée qui n'a pas de bouton « Annuler » : le script la referme en touchant à côté.

### Recette : cibles tactiles de 44 pt

Les trois boutons texte relevés à 20 pt par l'audit idb du 2026-10-09 — « Tout afficher »
et « Lire le contrat » de l'Accueil, « Piloter un projet… » de l'écran Projet — doivent
offrir une cible d'au moins 44 × 44 pt (`IOSMetrics.minimumTarget`) SANS changer
d'apparence. La recette rejoue la preuve sur de vrais simulateurs, par la lecture
d'accessibilité d'idb :

```bash
bash scripts/recette/ios-cibles-tactiles-recette.sh --iphone <UDID> --ipad <UDID> [--avant]
```

Préconditions, jamais satisfaites par le script (il n'appaire pas) : `idb`, Xcode 27,
`python3` avec Pillow ; les DEUX simulateurs iOS 27 démarrés ; l'app déjà APPAIRÉE au Mac
sur chacun (jeton au trousseau du simulateur — l'écran Projet n'offre « Piloter un
projet… » qu'une fois connecté) ; l'app Mac OMP Console en service sur `127.0.0.1:8787`.
Le script compile lui-même une app SIGNÉE dans
`omp-console/build/ios-cibles-tactiles-derived` (`scripts/ios-build.sh` compile sans
signature : le trousseau du simulateur refuserait le jeton) et l'installe sur les deux
appareils.

Simulateurs PRIVÉS, nommés SANS « iPhone » ni « iPad » (par exemple `cible44-tel` et
`cible44-tab`) : `ios-shots.sh` et `ios-build.sh` des autres worktrees s'emparent des
appareils dont le nom contient ces mots, y réinstallent l'app et changent la taille de
texte en plein relevé. Un simulateur appairé se clone — `xcrun simctl shutdown <src> &&
xcrun simctl clone <src> <nom> && xcrun simctl boot <src>`, puis `boot` du clone — et le
jeton suit le clone ; à supprimer ensuite (`simctl shutdown` puis `simctl delete`, après
avoir vérifié que `pgrep -fl <UDID>` ne rend rien).

Deux passes, dans cet ordre :

1. `--avant`, AVANT toute correction Swift : relevé de référence dans
   `omp-console/build/ios-cibles-tactiles-sous-44pt/avant/` (ignoré par git, vidé au
   début de la passe ; l'autre dossier n'est jamais touché). Aucune vérification ;
   sortie 0 quand toutes les captures et lectures existent.
2. Sans option, sur l'app corrigée : relevé dans `.../apres/` puis les vérifications,
   une ligne par contrôle — `AC-<n> <appareil> <écran> <taille> <identifiant> — ok` ou
   `— ÉCHEC (<détail>)` —, `bilan : <n> ok, <m> échec`, et la liste des PNG à LIRE
   (libellés entiers, sans « … », sans chevauchement aux grandes tailles de texte et sur
   iPad). Le rapport est aussi écrit dans `apres/rapport.txt`.

La matrice : iPhone = Accueil (`-home.recipe dashboard`) et Projet × les trois tailles
(`large`, `accessibility-extra-large`, `accessibility-extra-extra-extra-large`) ; iPad =
Accueil × `large` seulement (l'écran Projet n'offre « Piloter un projet… » qu'appairé au Mac,
et le code d'appairage exige un Mac déverrouillé : tant qu'aucun iPad simulateur n'est
appairé, « Piloter un projet… » n'est prouvé que sur iPhone). Chaque case produit `<appareil>-<écran>-<taille>.json` (la
lecture brute de `idb ui describe-all`) et `.png` ; un contrôle hors de l'écran (taille
maximum) est amené par `idb ui swipe` (au plus 8), chaque défilement qui en découvre un de
plus ajoutant `-defil<k>.json` et `-defil<k>.png`. Les vérifications : AC-1 cadres ≥ 44 ×
44 pt (iPhone, `large`) ; AC-2 identifiant propre, non vide et distinct par contrôle
(`ios.home.allPipelines`, `ios.home.attention.<id>.contract`, `ios.projet.start` — et plus
`ios.screen.project`) ; AC-3 tap à `(x + w/2, y + 3)` du cadre, l'app relancée avant
chaque tap ; AC-4 apparence inchangée à `large` (la bande de texte de chaque contrôle est
comparée pixel à pixel à `avant/`, à ±6 px de décalage vertical, et les lignes situées à
2 pt des bords du cadre doivent rester unies : aucune bordure, capsule ni fond ajouté) ;
AC-5 la même chose aux deux grandes tailles de texte ; AC-6 la même chose sur iPad. Sans
capture homologue dans `avant/`, la ligne de comparaison vaut `— sans objet` et ne compte
ni comme ok ni comme échec.

Codes de sortie : **0** aucune ligne ÉCHEC ; **1** au moins un ÉCHEC ; **2** non lancé ou
interrompu (argument manquant, outil absent, simulateur non démarré, build ou installation
en échec, app non connectée au Mac, capture absente ou uniforme, relevé instable).

Limite connue : le tap d'AC-3 ne distingue PAS l'avant de l'après. Le « touch slop »
d'UIKit déclenche déjà un bouton de 20 pt jusqu'à environ 19 à 25 pt au-dessus du centre
du texte ; seul le cadre AX (AC-1, AC-5, AC-6) prouve la taille de la cible. La garde
textuelle de la correction est `test/console/ios-cibles-tactiles-sous-44pt.test.ts`.
### Recette idb : cibles, identifiants et bords

`scripts/recette/ios-recette-ui.sh` relève 9 surfaces de l'app iOS sur un simulateur
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

**Matrice.** 9 surfaces × 3 configurations = **27 relevés** : les huit sections
(`home`, `kanban`, `project`, `audit` (via `-audit.recipe liste`), `session`, `sessions`, `memory`, `stats`) plus la
feuille d'une carte Pipelines (`kanban-fiche`), en clair à la taille par défaut,
en sombre à la taille par défaut, puis en clair en AX-XL (`accessibility-extra-large`).
Les écrans sont alimentés par les crochets de recette existants (`-home.recipe
dashboard`, `-sessions.recipe liste`, `-memoire.recipe graphe`, `-pipelines.recipe
fiche`) ; Projet, Session OMP, Statistiques et le tableau Pipelines sont relevés
dans leur état non appairé. Un relevé n'est accepté que si deux lectures
consécutives de l'arbre sont identiques **et** que la surface est reconnue par ses
marqueurs d'accessibilité : jamais la liste « Plus », l'Accueil déconnecté ou une
autre section. L'ordre des clés du JSON d'idb et celui de la liste `traits` d'un
élément changent d'une lecture à l'autre ; la comparaison porte donc sur le JSON
décodé, `traits` pris comme un ensemble.

**Sortie.** `omp-console/build/ios-recette-ui/base/` (ignoré par git, vidé à chaque
passage) : `<surface>-<apparence>-<taille>.json` (arbre AX) et `.png` (capture sans
masque de coins) pour chacun des 27 relevés, `logs/` (journaux `--stderr` de l'app,
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

**Codes de sortie.** `0` : 27 relevés faits et aucun `SIGNALÉ` ; `1` : au moins un
`SIGNALÉ` ; `2` : la recette n'a pas pu conclure (prérequis, exceptions invalides,
relevé non vérifié, construction ou installation impossible).

**Exceptions.** `scripts/recette/ios-recette-ui-exceptions.json` (versionné)
est un tableau d'objets aux clés exactes `surface` (une des 8 clés ou `*`),
`apparence` (`clair`, `sombre`, `*`), `taille` (`defaut`, `ax-xl`, `*`), `regle`,
`source` (`ax` ou `capture`, `capture` seulement avec `bord`), `element`
(`id:…`, `libellé:…` ou `type:…`, strictement égal à la désignation) et
`justification` (non vide : elle nomme la cause lue dans le code). La première
entrée qui correspond excepte le signalement. Le fichier est validé avant tout
relevé. Ces familles sont **protégées**, car elles masqueraient les défauts visés
par l'audit : `cible-44` sur « Tout afficher », « Lire le contrat » et « Piloter un
projet… » (`ios.home.allPipelines`, `ios.home.attention.*.contract`,
`ios.projet.start`), sur « Ouvrir la PR » de l'Accueil (`ios.home.delivered.open.*`),
« Se connecter » (`ios.connexion.connect`), « Réessayer » de la Mémoire
(`ios.memoire.retry`) et le menu d'étiquettes du graphe
(`ios.memoire.graphe.etiquette`) ; `id-duplique` sur `pipelines.card.sheet.title` et
`ios.memoire.screen` ; `bord` en source `capture` sur `kanban`, `sessions`, `memory`
ou `*`.

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

Preuve (2026-10-09, simulateur dédié) avec `feat/ios-panneau-sans-marge-scroll-imbrique`,
`feat/ios-cibles-tactiles-sous-44pt` et `feat/ios-fiche-carte-pipelines` : 53
signalements, tous exceptés par une entrée justifiée (la liste versionnée), sortie 0,
et aucune ligne du rapport ne relève de « Tout afficher » / « Lire le contrat » /
« Piloter un projet… », de `pipelines.card.sheet.title` ni d'un `bord` en source
`capture` sur Pipelines, Sessions ou Mémoire. La même commande avec une copie de la
liste privée de l'entrée du filtre de Sessions sort en 1 et nomme ce signalement
(`SIGNALÉ … id:ios.sessions.filter`). Une exception est une dette : elle disparaît
avec le correctif qui la justifie, et une entrée devenue inutile est signalée
(`exception inutilisée : <n>`).

État au 2026-10-10 (feature `accessibilite-et-localisation-ios-residu`, simulateur
privé `recette-ui-tel` jamais appairé, sans `--integrer`) : **22 exceptions**,
`0 signalé(s), 41 excepté(s)`, sortie 0. Les entrées de « Ouvrir la PR » de l'Accueil
et de `ios.memoire.screen` ont disparu avec leurs correctifs ; les barres de
navigation système des sections (`id:Accueil`, `id:Projet`, `id:Session OMP`,
`id:Sessions`, `id:Statistiques`, comme `id:Pipelines` et `id:Mémoire`) et les deux
rangées « livrée » de l'Accueil (42,7 pt) restent exceptées.

**Nettoyage** d'un simulateur dédié, dans cet ordre :

```bash
xcrun simctl shutdown <UDID>
pgrep -fl <UDID>        # vide, à l'exception de idb_companion
xcrun simctl delete <UDID>
pkill -f "idb_companion --udid <UDID>"
```

idb lance un `idb_companion --udid <UDID>` qui survit à `simctl delete` : sans
`pkill`, il reste.

### Recette des rangées et des gestes de l'Accueil

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/recette/ios-accueil-rangees-recette.sh
```

Le script compile l'app sans signature, crée un iPhone 18 Pro et un iPad (A16)
dédiés sous iOS 27.0 (ou reprend `IOS_RECETTE_IPHONE` / `IOS_RECETTE_IPAD`, en
refusant le simulateur appairé), et vérifie l'Accueil à l'écran par `idb`. Il
contrôle les rangées en deux lignes sur iPhone (`-home.recipe longTitles`), sur une
ligne sur iPad, empilées à `accessibility-extra-large`, puis vérifie que seul
« Ouvrir la PR » ouvre Safari, la confirmation de « Valider les specs », l'échec
affiché sur la carte et l'état « Envoi en cours » (`-home.recipe slowMac`). Il
écrit une ligne `AC-n ✓` ou `AC-n ✗ <raison>` par critère, de AC-1 à AC-10,
et dépose ses captures dans `omp-console/build/accueil-rangees/`. Codes de sortie
: `0` tout est ✓, `1` au moins un ✗, `2` outillage manquant. Les simulateurs
créés sont supprimés à la sortie.

### Recette des sections de l'Accueil et de l'item de barre de menus

`bash scripts/recette/accueil-sections-recette.sh [--avant]` : `--avant` capture l'Accueil
iOS de la base `8079e6e` (worktree détaché temporaire) et lit en AX l'item de
l'instance OMP Console de l'utilisateur, sans l'activer ; sans option, il capture
l'Accueil iOS (iPhone, iPad) et Mac (2e instance `-home.recipe dashboard`, racine
jetable, port 8797), lit l'item sous `dashboard`, `menuBar` et `pausedOnly`, et écrit
une ligne `AC-n ✓|✗` pour AC-1, AC-2, AC-3, AC-5, AC-6, AC-8 et AC-9 ; captures et
arbres AX dans `omp-console/build/accueil-sections/{avant,apres}/`. Codes de sortie
: `0`, `1` au moins un ✗, `2` outillage, autorisation d'accessibilité manquante ou
simulateur appairé refusé. Une capture d'item noire (Space plein écran) est une
limite consignée, la preuve restant la lecture AX.

### Recette : états non connecté

```bash
bash scripts/recette/ios-etats-connexion-recette.sh [--avant <ref>] --source <UDID appairé>
```

La recette prouve, sur un iPhone 17 Pro puis un iPad Pro 13 pouces privés, les deux
composants de connexion des sept sections et le grisage des gestes qui exigent le
Mac (feature etats-non-connecte-heterogenes-ios, AC-1 à AC-10).

Prérequis : macOS, Xcode (`DEVELOPER_DIR`), `idb`, `python3`, `sqlite3`, `curl` ; la
coque macOS sert `127.0.0.1:8787` ; `--source` désigne un simulateur démarré, appairé
au Mac et portant l'app, dont le trousseau et la préférence `client.deviceId` sont
copiés (lecture seule) sur les appareils privés. Le script compile lui-même une app
SIGNÉE sous `/tmp`, crée les deux simulateurs, les démarre l'un après l'autre et les
supprime à la sortie avec leur `idb_companion` ; il ne touche aucun autre simulateur
et aucun geste n'écrit sur le Mac. Les mots attendus sont lus dans
`IOSConnectionStateText.swift` de l'arbre de travail, y compris avec `--avant`.

Contrôles, dans les sept sections (lancement `-section <raw>`), par appareil :

1. jamais appairé : « non connecté » plein écran, cause « non appairé », aucune
   ancienne forme (« Non appairé », « Mac absent — … », `pipelines.banner`…) ;
2. « Se connecter » ouvre la feuille Connexion (six sections hors Accueil) ;
4. appairage greffé, port fermé : cause « Mac injoignable » ; « + » de Pipelines
   grisé, sans feuille au toucher ;
5. serveur muet : « Connexion au Mac… » seul, sans « Se connecter » ; « + » grisé ;
6. le serveur muet répond une erreur à 8 s : « non connecté » remplace « connexion
   en cours » ;
7. relais vers le Mac, données chargées, puis coupure : bandeau au-dessus des
   données conservées, gestes grisés, sans feuille au toucher (le point touché est
   relu dans le relevé d'après la coupure, le bandeau décalant le contenu) ; en
   Mémoire, le champ de recherche touché puis saisi par `idb ui text` garde sa
   requête ;
8. relais rétabli : bandeau parti, les mêmes gestes de nouveau actifs, sans
   relancer l'app ; en Mémoire, la même saisie passe, témoin du contrôle 7 ;
3. joué en dernier (il efface le jeton de l'appareil privé) : réponse 401, cause
   « refusé ou révoqué » ; puis les trois phrases relevées doivent être distinctes.

Sorties dans `omp-console/build/etats-non-connecte-heterogenes-ios/<avant|apres>/`
(vidé au début du relevé) : `<ctrl>-<section>-<appareil>.png` et `.json`
(`idb ui describe-all`), `rapport.txt` (une ligne `ok|échec|sauté <AC> <appareil>
<section> <détail>` par contrôle, puis `bilan : …`), `build.log`. Codes de sortie :
**0** tout « ok » (les « sauté » motivés sont tolérés) ; **1** au moins un échec, ou
build, simulateur ou argument en défaut ; **2** non exécuté. Une passe dure ~12 min.

### Recette : accessibilité et langue

`scripts/recette/ios-accessibilite-localisation-recette.sh` prouve à l'exécution, avant et
après, les neuf critères de la feature `accessibilite-et-localisation-ios-residu`
(symboles décoratifs muets, identifiants de conteneur non propagés, un identifiant
par carte, cibles de 44 pt, app française seulement, nom sous l'icône, titre et
chevrons de la liste racine) :

```bash
bash scripts/recette/ios-accessibilite-localisation-recette.sh               # arbre de travail
bash scripts/recette/ios-accessibilite-localisation-recette.sh --avant 032a0df
```

- **Construction** non signée par `scripts/ios-build.sh --no-tests` (aucun
  appairage). Avec `--avant <ref>`, dans un worktree détaché temporaire
  (`omp-console/build/ios-accessibilite-localisation/avant-src`), supprimé à la sortie.
- **Simulateurs privés** `loc-acces-tel` (iPhone 18 Pro) et `loc-acces-tab` (iPad Pro
  13-inch (M5)), iOS 27.0, créés par le script et supprimés à la sortie avec leur
  `idb_companion`, quel que soit le code. Leur nom se range APRÈS « iPhone 18 Pro »
  et « iPad Pro 13-inch (M5) » : `scripts/ios-build.sh` lance ses tests sur le
  PREMIER appareil du runtime (rangement par type puis par nom), et un nom en
  « a… » a vu un `xcodebuild test` d'un autre worktree y installer sa build en cours
  de recette. Si l'app installée change malgré tout (empreinte de l'exécutable, du
  `.debug.dylib` et de l'Info.plist), l'étape est rejouée après réinstallation.
- **Déroulé** : écran d'accueil d'iOS (AC-7) ; en langue par défaut, Accueil de
  recette, Accueil non appairé, Bienvenue, ardoise Pipelines
  (`-pipelines.recipe ardoise`, voie « Livrées » dépliée), Projet et graphe de la
  Mémoire (AC-1 à AC-5) ; liste racine et capture (AC-8, AC-9 : pixels d'une bande à
  droite de chaque rangée, chevron attendu sur iPhone seulement) ; puis passage des
  deux appareils en anglais (`AppleLanguages=(en)`, `AppleLocale=en_US`, redémarrage)
  et AC-6 : bouton de barre latérale (iPad), bouton retour et menu d'édition du champ
  titre de « Nouvelle feature… » (iPhone).
- **Sortie** : une ligne `AC-<n> <✓|✗|–> <appareil> <détail>` par mesure, recopiée
  dans `omp-console/build/ios-accessibilite-localisation/<apres|avant>/rapport.txt`
  avec un JSON `describe-all` et une capture PNG par mesure. `–` marque une mesure
  non faite : sur la base, celles qui demandent le crochet `ardoise` ; partout, la
  fiche « Ouvrir la PR », le lien du plan Projet et les « Réessayer » de la Mémoire,
  inatteignables sans appairage ni panne (leur forme est gardée par
  `test/console/accessibilite-et-localisation-ios-residu.test.ts`).
- **Codes de sortie** : 0 tout est ✓ ; 1 au moins un ✗ ; 2 rien n'a pu être conclu
  (outil manquant, Xcode inutilisable, construction impossible, signal absent, arbre
  instable, menu d'édition introuvable après 3 essais, simulateur non supprimé).

Preuve (2026-10-10) : sur l'arbre de travail, 45 ✓, 0 ✗, sortie 0 ; sur 032a0df,
sortie 1, avec ✗ pour AC-1 (Accueil, Bienvenue), AC-3 (`ios.memoire.screen` porté
6 fois), AC-5, AC-6 (« Hide Sidebar », « Back », « Paste »), AC-7, AC-8 et AC-9
(iPhone).

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
et ses trois phrases (`${applicationName}`). La réponse est prouvée par
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

### Siri sur le Mac

Contrepartie macOS de la section précédente : la **coque macOS** déclare deux App Intents qui
parcourent à la voix la liste unifiée des attentes du Mac (voir *Liste des
attentes*) et y répondent : `MacPendingIntent` (« Ce qui m’attend ») et
`MacAnswerIntent` (« Répondre aux demandes »), dans
`Sources/OMPConsole/Intents/PendingVoiceIntents.swift`. L'enchaînement est le moteur
pur `VoiceConversation` de ConsoleCore (`Sources/ConsoleCore/Voice/`), le même que
celui de l'iPhone ; la réponse part UNIQUEMENT par les méthodes typées de
`RemoteActions`, celles que sert aussi l'API distante — aucune seconde voie
d'écriture, aucun corps HTTP fabriqué.

Phrases Siri (en français, toutes avec le nom de l'app ; tuiles de l'app
Raccourcis entre parenthèses) :

- *Ce qui m’attend* (`tray.full`) : « Qu’est-ce qui m’attend dans OMP Console »,
  « Ce qui m’attend dans OMP Console », « Demandes en attente dans OMP Console »,
  « Questions en attente dans OMP Console » ;
- *Répondre* (`text.bubble`) : « Réponds dans OMP Console », « Répondre dans OMP
  Console », « Répondre aux questions de OMP Console ».

Enchaînement :

1. *Ce qui m’attend* annonce le nombre (« 3 demandes en attente. La première : … ») ;
   *Répondre* commence sans l'annoncer. Sans aucune demande : « Aucune demande ne
   vous attend. », et rien n'est demandé.
2. Siri prend la plus ancienne demande, lit son sujet, sa nature et sa question,
   puis ses choix dans leur ordre (« Choix possibles : … »). Si la question admet
   un texte libre, il ajoute « Vous pouvez aussi dire « autre réponse ». » ; une
   question en texte d'une feature en attente, sans options, demande « Dictez votre
   réponse. ».
3. La réponse dite est confiée à `VoiceAnswerMatcher` : libellé, chiffre, « la
   deuxième », « la dernière », ou « autre réponse » suivie du texte dicté. Une
   réponse non reconnue n'envoie rien et relit les choix ; après trois questions
   sans envoi pour une même demande, Siri dit « Je n’ai pas compris votre réponse,
   rien n’a été envoyé. » et s'arrête.
4. Juste avant l'envoi, la liste est relue : si la question de la demande a changé,
   rien n'est envoyé et Siri relit la nouvelle question puis redemande ; si la
   demande a disparu, il passe à la suivante. Une question en vol porte le
   `toolCallId` lu, contrôlé par le geste.
5. Siri dit l'issue : succès, ou refus du Mac avec le motif exact que rend la route
   HTTP du même geste — la demande refusée n'est plus reproposée dans la même
   session. Puis « La suivante : … », jusqu'à « Il n’en reste aucune. ».
6. Annuler (« Annuler » à Siri) n'envoie rien : « D’accord, cette demande reste en
   attente. ».

Sources répondues à la voix : question en vol d'un run, question en texte d'une
feature en attente, dialogue de conduite de projet, dialogue de la session OMP
hébergée, escalade d'audit. Les autres demandes de la liste — dialogue « editor »,
jalons specs et revue, décisions d'audit specs et revue, carte en pause à reprendre
— sont comptées dans le nombre annoncé et lues, puis signalées « À traiter dans
l’app. », sans réponse demandée, et Siri passe à la suivante. Valider, accepter,
reprendre, arrêter ou lancer à la voix ne font pas partie de ces intents.

**App fermée.** Les deux intents tournent en arrière-plan
(`supportedModes = .background`) : Siri lance l'app sans la passer au premier
plan, sans `MainWindow.reveal()` ni activation. Un lancement à froid n'a aucune
vue, donc aucun `onAppear` : `MacVoiceContext` (installé par `OMPConsoleApp.init()`)
démarre l'ardoise et attend **au plus 5 s** (`MacVoiceContext.readinessTimeout`,
la borne de l'iPhone) qu'elle ait lu le magasin. Au-delà, Siri dit « OMP Console
n’a pas pu lire l’état du Mac à temps, rien n’a été envoyé. Réessayez dans un
instant. », et aucun geste n'est appelé.

**Limite après un lancement à froid.** Les files des dialogues de conduite et de la
session OMP hébergée appartiennent au processus de l'app : tant qu'elle n'a ni
démarré ni adopté de conduite ou de session, elles sont vides, et ces dialogues
n'apparaissent pas dans la liste vocale. Les questions de runs, les questions en
texte et les escalades d'audit, lues dans le magasin, sont toujours là.

Politique vocale : les deux intents se conforment à `VoiceAnswerIntent` (voir
*Politique vocale (App Intents)*), littéral `authenticationPolicy = .alwaysAllowed`,
aucune confirmation pour les cinq gestes de réponse sur le Mac. Les métadonnées des
deux intents sont contrôlées dans le bundle par `scripts/swift-app.sh` (*Assembler
le bundle `.app`*, ligne `✓ intents vocaux embarqués`). Preuves :
`Tests/OMPConsoleTests/MacVoiceIntentTests.swift` (`siri-mac-questions-en-attente/AC-2`
à `AC-12`, sur une pile `RemoteStack` réelle), `VoiceConversationTests.swift` (moteur
pur) et `test/outillage/check.test.ts` (`siri-mac-questions-en-attente/AC-1`). La
reconnaissance vocale ne se prouve qu'à la main.

**Recette manuelle sur le Mac réel** (`siri-mac-questions-en-attente/AC-13`, et le
volet « sans fenêtre au premier plan » d'AC-7 ; conduite par l'utilisateur, Siri
réglé en français) :

1. `bash scripts/swift-app.sh` depuis la racine du dépôt.
2. Ouvrir une fois `omp-console/build/OMP Console.app` (enregistrement auprès du
   système), puis la quitter (⌘Q).
3. Lancer une pipeline qui s'arrête sur une question `ask` (carte « Question en
   vol »).
4. Ouvrir Raccourcis → *OMP Console*. Attendu : les tuiles *Ce qui m’attend* et
   *Répondre* (actions « Ce qui m’attend » et « Répondre aux demandes »).
5. Dire « Dis Siri, qu’est-ce qui m’attend dans OMP Console ». Attendu : l'app
   démarre sans passer au premier plan (aucune fenêtre devant les autres, l'app de
   premier plan inchangée), Siri annonce le nombre puis lit la question et ses
   choix.
6. Dicter une des options. Attendu : Siri dit l'issue, la carte quitte « Question
   en vol » et le run reprend avec la réponse dictée.

Résultat consigné par l'utilisateur.

### Conduire un projet depuis l'iPad

La section **Projet** de l'app conduit un projet de bout en bout : elle lit le
plan et `PROJECT.md` servis par la coque, suit les PR et leurs trois statuts
requis, répond aux escalades et démarre/arrête la conduite. L'app ne calcule
jamais de clé de dépôt et n'écrit rien sur l'appareil : tout vient du flux.

Recette PAS À PAS (chacun des gestes donne l'attendu observable et le mot exact) :

1. **Appairer** l'app au Mac (feuille de connexion) : la zone d'état affiche
   « Connecté ». La section Projet affiche alors « Aucun projet piloté. » et
   le bouton « Piloter un projet… ». *(hors connexion, la section affiche le
   composant « Pas de connexion au Mac » avec sa cause et « Se connecter », en
   bandeau au-dessus de la conduite déjà reçue ; ses gestes sont grisés)*
2. **Piloter un projet** — toucher « Piloter un projet… » : la feuille liste les
   dépôts connus de la coque (« Dépôt »), chacun par son seul nom de dossier
   (parent entre parenthèses s'il a un homonyme, aucun chemin), y compris un
   dépôt jamais cadré. Choisir un dépôt (il porte une coche), le nom se
   préremplit, puis ✓ (« Piloter »). La feuille se ferme et l'en-tête du projet
   apparaît (nom, chemin du dépôt abrégé en `~/…`, pastille « Démarrage… » puis « Active »).
3. **Répondre au cadrage** — quand la feuille « OMP vous demande » s'ouvre
   (compteur « Question n sur m »), choisir une option ou saisir le texte, puis
   ✓ (« Répondre ») : l'escalade quitte la file d'attente.
4. **Valider le plan** — à l'escalade de revue, « Corriger le plan » ouvre une
   feuille **préremplie avec le plan courant** ; éditer puis ✓ (« Répondre »)
   renvoie le texte corrigé, ou ✕ (« Annuler ») refuse.
5. **Suivre la PR** — dans le volet « PR et intégration continue », chaque PR affiche
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

### Auditer depuis l’iPhone

La section **Audit** (dans « Plus » sur iPhone, juste après Projet) liste les
audits et pousse le détail de celui qu’on touche. « Lancer un audit… » ouvre une
feuille : un dépôt parmi les dépôts connus du Mac, une orientation sur plusieurs
lignes ; « Lancer l’audit » n’est actif que si l’orientation rognée fait de 1 à
2 000 caractères.

Le détail montre les propositions en rangées-boutons cochables (« Cochée » ou
« Non cochée » pour VoiceOver) ; une proposition déjà dans le lot est désactivée.
« Relire le brief… » ouvre l’éditeur du brief : « Valider et lancer » poste la
sélection et le brief, « Annuler » n’envoie rien. Suivent l’avancement (phase,
attente, « Ouvrir la PR »), les questions en attente — options, « Autre réponse »
et « Répondre », ou « Valider les specs » / « Accepter la revue et livrer (PR) »
et « Abandonner la feature » —, les décisions de l’arbitre et « Arrêter
l’audit… », qui demande confirmation.

Hors ligne, le contenu reçu reste visible et les gestes sont coupés. Une réponse
donnée sur le Mac disparaît de l’iPhone à la trame `store` suivante. Capture :
`-section audit -audit.recipe liste|propositions|suivi`.

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

1. **Appairer** l'app au Mac (feuille de connexion), un projet étant ouvert dans la
   fenêtre « Session OMP » du Mac : la section affiche l'en-tête « N souvenirs » (le
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


### Statistiques depuis l'iPad

La section **Statistiques** de l'app est en **lecture seule** : elle affiche la
consommation des runs du projet choisi, par feature — slug, modèle, durée, tours,
tokens envoyés (entrée hors cache + cache lu + cache écrit) et tokens reçus — puis la ligne « Total du projet », somme des
features LISTÉES. En tête, deux graphiques en barres, « Durée par feature » et
« Tokens par feature » (envoyés et reçus empilés), reprennent ces nombres et se
lisent à VoiceOver ; sans donnée, aucun graphique n'est affiché. Aucun montant,
aucun geste de pilotage d'un run. Les mots
affichés (« Tokens envoyés », « Temps passé », « Tours », « Total du projet ») sont
ceux de la fenêtre macOS : ils viennent du noyau partagé `ConsoleCore`.

Recette PAS À PAS (chacun des gestes donne l'attendu observable et le mot exact) :

1. **Appairer** l'app au Mac (feuille de connexion) : la zone d'état affiche
   « Connecté », et la section Statistiques montre un bref « Chargement des
   statistiques… » puis son tableau. *(hors connexion, la section affiche le
   composant « Pas de connexion au Mac » avec sa cause, en bandeau au-dessus du
   dernier relevé s'il y en a un, et n'émet aucun relevé)*
2. **Choisir un projet** — le sélecteur en haut de la section propose les projets
   connus du Mac, dans l'ordre de la coque (le libellé du dépôt, jamais une clé) ;
   il nomme le projet choisi, au-dessus du tableau comme au-dessus de l'état
   « Aucune donnée pour ce projet ». Choisir un autre projet : le sélecteur le
   nomme aussitôt, au-dessus de « Chargement des statistiques… », puis le tableau
   (ou l'état vide) de ce projet s'affiche. Un projet sans données ne retient donc
   jamais l'écran : on en choisit un autre depuis l'état vide.
3. **Comparer avec le Mac** — ouvrir la fenêtre **Statistiques** macOS sur le même
   projet : chaque feature de l'app porte les MÊMES tokens reçus, le même modèle,
   la même durée et le même nombre de tours ; ses tokens envoyés, eux, ajoutent le
   cache lu et le cache écrit à l'entrée que la tuile macOS affiche seule. La ligne
   « Total du projet » somme les features listées.
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
   portant le message TRADUIT de la cause (« Service indisponible sur le Mac. » puis
   son remède — voir « Erreurs du Mac »), sans URL, sans JSON et sans code HTTP, et
   un bouton « Réessayer » qui relance le relevé.

Recette OUTILLÉE : le test Swift gated `iosStatistiquesRecipe`
(`omp-console/Tests/OMPConsoleTests/IOSStatistiquesRecipeTests.swift`) exerce
contre une coque réelle les parties automatisables — relevé du projet, parité avec
le tableau publié par la fenêtre macOS, masquage d'une feature sans run lisible,
avancement d'une durée vivante et absence de montant dans la charge utile. Il est
gardé par la variable `MEM0_REMOTE_RECIPE` et se lance par :

```bash
MEM0_REMOTE_RECIPE=1 swift test --filter iosStatistiquesRecipe
```

### Clavier de l'iPad

Avec un clavier matériel, l'app pose onze commandes dans la **barre des menus de
l'iPad** (Globe-M, ou glissement depuis le haut ; depuis iPadOS 26 elle remplace
la superposition qu'on obtenait en maintenant ⌘). Chaque commande y affiche son
libellé français et son raccourci :

| Raccourci | Commande | Menu | Effet |
|---|---|---|---|
| ⌘1 … ⌘8 | Accueil, Pipelines, Projet, Audit, Session OMP, Sessions, Mémoire, Statistiques | Présentation | ouvre la section, dans l'ordre affiché par la barre latérale |
| ⌘R | Actualiser | Présentation | relit les données de l'écran courant, sans changer de section (sur Pipelines : la même relecture que le tirage de la liste, l'ardoise puis l'état des PR ; sur la Mémoire : la liste ou le graphe affiché) |
| ⌘F | Rechercher | Présentation | met le focus dans le champ de recherche (Mémoire en mode Liste) ; inactive ailleurs |
| ⌘N | Nouvelle feature… | Fichier | bascule sur Pipelines et ouvre la feuille « Nouvelle feature » (comme le bouton « + », rien ne s'ouvre hors connexion) |

⌘R est inactif hors connexion et pendant une lecture en cours. ⌘N remplace
« Nouvelle fenêtre » : l'app garde une seule fenêtre. Sous une feuille, une
alerte ou un `confirmationDialog`, les onze commandes sont sans effet ; ⎋ et ↩
des feuilles (Annuler, valider) restent inchangés, aucune commande ne les prend.

### Recette : clavier et largeur de lecture

`scripts/recette/ios-clavier-largeur-recette.sh` prouve la colonne de lecture et le
clavier de l'iPad par captures et par touches `idb`, sur deux simulateurs DÉDIÉS
dont le nom ne contient ni « iPhone » ni « iPad » (un iPad Pro 13-inch et un
iPhone) :

```bash
IOS_RECETTE_IPAD=<UDID iPad> IOS_RECETTE_IPHONE=<UDID iPhone> \
  bash scripts/recette/ios-clavier-largeur-recette.sh --phase avant|apres [--source fixture|reel]
```

- `--phase avant`, sur l'arbre d'avant la feature, capture et mesure les huit
  écrans iPad et les six écrans iPhone (`mesures.json`) ; `--phase apres` vérifie
  la largeur (≤ 700 pt et marges égales sur iPad, Pipelines pleine largeur,
  iPhone identique à l'avant) puis ⌘1…⌘8, ⌘R (un signal `memoire-recipe-read`
  de plus sous `-memoire.recipe clavier`), ⌘N et la garde sous la feuille, ⌘F
  (champ `IsEditing`, frappe reçue) et ⌘F sans effet sur Sessions et sur le mode
  Graphe.
- `--source reel` ajoute `IOS_RECETTE_IPAD_APPAIRE` (un iPad appairé au Mac) :
  ⌘R sur les huit écrans connectés et ⎋ sur la feuille « Lancer une session
  OMP ».
- Sortie : `omp-console/build/ipad-clavier-et-largeur-de-lecture/<phase>/<source>/`
  (PNG, arbre AX JSON de chaque capture, `rapport.txt` à une ligne
  `ok|échec|sauté AC-n …` par contrôle). Codes : 0 tout est ok, 1 au moins un
  échec, 2 non exécutée (outil, simulateur ou mesure avant manquants).
- La recette compile une app signée, ne désinstalle rien et ne prend jamais le
  focus du Mac. Les boutons de barre et le champ de recherche se lisent par
  `idb ui describe-point` : `describe-all` ne rend pas le contenu des barres de
  navigation.

### Recette : identité de l'app

`scripts/recette/ios-identite-recette.sh` prouve au simulateur, avant et après, les
critères de la feature `ios-identite-app` (icône claire et sombre sous « OMP
Console », catalogue de l'AppIcon, accent égal au bleu système, nom et région,
message « Réseau local », écran de lancement, icône du Mac) et relit les constats
de l'audit sur l'app de la base :

```bash
bash scripts/recette/ios-identite-recette.sh                 # arbre de travail
bash scripts/recette/ios-identite-recette.sh --avant f3fbfe6
```

- **Construction** signée ad hoc (`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES
  CODE_SIGNING_REQUIRED=NO`), contrôlée par `codesign -dv`
  (`Identifier=com.omp.console.ios`). Avec `--avant <ref>`, l'app de `<ref>` est
  construite dans un worktree détaché temporaire, retiré à la sortie. Le volet Mac
  assemble seulement `omp-console/build/OMP Console.app` par
  `bash scripts/swift-app.sh --no-tests`, sans l'ouvrir. Le programme de mesure des
  images, `scripts/recette/ios-identite-recette/images.swift`, est compilé par `swiftc`
  dans `omp-console/build/ios-identite-app/`. Prérequis : Xcode 27, `idb`, `python3`
  avec PIL.
- **Simulateurs privés** `identite-tel` (iPhone 18 Pro, sinon iPhone 17 Pro) et,
  sans `--avant`, `identite-tab` (iPad Pro 13-inch (M5), sinon (M4)), qui ne sert
  qu'à AC-8 ; sur iOS 27.0, sinon le runtime le plus récent ≥ 26. Ils sont
  supprimés s'ils existent déjà, créés, puis
  supprimés à la sortie quel que soit le code. La recette n'ouvre jamais
  Simulator.app, n'emploie ni AppleScript ni `open -a`, ne vole pas le focus du Mac
  et ne touche pas l'instance d'OMP Console de l'utilisateur.
- **Déroulé** avec `--avant <ref>` : la section « constats » relit par PlistBuddy,
  sur l'app de `<ref>`, une ligne par constat de l'audit (`CFBundleIcons`,
  `CFBundleDisplayName`, `CFBundleDevelopmentRegion`, `NSAccentColorName`,
  `NSLocalNetworkUsageDescription`, `UILaunchScreen`) ; puis l'écran d'accueil
  d'iOS est capturé en clair et en sombre, ainsi que les six écrans de l'accent en
  clair et en sombre (`-home.welcomeSeen YES` puis `-section home -home.recipe
  dashboard`, `-section sessions -sessions.recipe liste`, `-section memory
  -memoire.recipe graphe`, `-section kanban -pipelines.recipe actions`, `-section
  stats -stats.recipe bascule`, `-section project -projet.recipe lancement`).
- **Déroulé** sans option : AC-1 et AC-2, le bouton « OMP Console » de l'écran
  d'accueil (HOME, puis jusqu'à 4 pages balayées) et la zone de l'icône mesurée
  dans la capture, claire puis sombre — le style d'icônes de l'écran d'accueil est
  réglé sur « Sombre », l'apparence sombre seule laissant les icônes claires ;
  AC-3, le catalogue et la teintée en gris pur (R = G = B) ; AC-4, les douze
  paires avant/après comparées par leur bleu le plus fréquent ; AC-5 et AC-6,
  PlistBuddy sur l'app construite ; AC-7, le message lu dans l'app installée après
  une installation neuve, avec la capture du premier lancement (l'alerte « Réseau
  local » n'est pas affichée par le simulateur, TN3179) ; AC-8, la vidéo d'un
  lancement à froid sur iPhone et iPad, en clair et en sombre, image par image
  (bords rognés de 4 % pour écarter la barre d'état et le liseré de la fenêtre
  iPad, puis réduction à 32 × 32) ;
  AC-1 Mac, l'icns du bundle assemblé identique à `omp-console/Bundle/AppIcon.icns`
  et `CFBundleIconFile = AppIcon`.
- **Sortie** : `omp-console/build/ios-identite-app/<avant|apres>/`, avec
  `rapport.txt` (une ligne `AC-n – <appareil> ✓|✗ <mesure>` par contrôle), `logs/`
  et les PNG. Sans captures avant, chaque ligne AC-4 est en ✗ « captures avant
  absentes (bash scripts/recette/ios-identite-recette.sh --avant f3fbfe6) ».
- **Codes de sortie** : 0 toutes les lignes sont ✓ ; 1 au moins un ✗, ou un
  prérequis manque (`✗ PIL absent : python3 -m pip install pillow`) ; 2 un
  simulateur ou le worktree temporaire n'a pas pu être retiré.

Preuve (2026-10-11) : sur l'arbre de travail, 23 ✓, 0 ✗, sortie 0 (AC-7, AC-1,
AC-2, AC-3, 12 × AC-4, AC-5, AC-6, 4 × AC-8, AC-1 Mac) ; sur f3fbfe6, sortie 0,
14 captures et le style d'icônes « Sombre » sélectionné, et les constats
`CFBundleIcons` absent, `NSAccentColorName` absent,
`NSLocalNetworkUsageDescription` « … à la coque macOS … » confirmés,
`CFBundleDisplayName = OMP Console`, `CFBundleDevelopmentRegion = fr` et
`UILaunchScreen = {}` écartés.
