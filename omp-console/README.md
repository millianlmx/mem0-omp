# omp-console — la coque de la salle de contrôle

`omp-console/` est le paquet SwiftPM de l'application macOS de la salle de
contrôle : **une seule fenêtre**, l'**OS agentique** (voir « OS agentique :
l'interface ») — le Radar des agents en haut, la liste des fils à gauche, l'écran
choisi au centre et l'inspecteur « Comprendre » à droite. La liste des fils porte
six entrées fixes, aussi au menu Présentation :

| Entrée | ⌘ | Ce qu'elle montre |
|---|---|---|
| **Maintenant** | ⌘1 | Le brief : ce qui vous attend, ce qui a été livré, ce qui bloque, les agents au travail. |
| **Propositions** | ⌘2 | Le travail que les agents proposent, accepté ou écarté d'un geste. |
| **Automatismes** | ⌘3 | Ce que l'OS lance seul. |
| **Savoir** | ⌘4 | Consignes permanentes, paliers d'autonomie, espaces. |
| **Mémoire** | ⌘5 | La mémoire du projet, locale au Mac. |
| **Système** | ⌘6 | Une grille de tuiles : Poste, Dépôts, Planifications, Autonomie, Vigie, Statistiques et santé, Issues, Administration, Serveur. |

Sous ces entrées, les **fils** : une intention, de la demande au résultat (une
feature, une demande au poste, une session omp locale). Les décisions — questions,
specs et verdicts à valider, envois du poste à approuver, demandes à confirmer — se
tranchent dans leur fil ou dans le tri (⌘T).

Créer passe toujours par une **feuille** (⌘N, ou la palette ⌘K) : jamais un
formulaire en tête d'écran. Rien n'ouvre de fenêtre annexe : l'app est utilisable
entièrement en plein écran. Les fenêtres ne se regroupent pas en onglets :
Présentation et Fenêtre n'ont aucune entrée d'onglet, et aucun menu ne montre de
séparateur en tête, en fin ou en double.

Tout ce qui n'est pas la Mémoire lit et lance le travail sur le **serveur de
pipelines du VPS** (`omp-harness`, le seul moteur de pipelines, voir « Serveur de
pipelines ») : l'app n'exécute aucune pipeline elle-même. La **Mémoire** reste
locale (voir « Consulter et corriger la mémoire du projet »). Liquid Glass est
réservé à la couche fonctionnelle que le système dessine (barres d'outils,
feuilles) ; le contenu emploie des surfaces opaques, des tuiles, des pastilles et les
contrôles natifs (HIG Materials : « Don't use Liquid Glass in the content layer »).
Cible minimale : macOS 26.

- [Prérequis](#prérequis)
- [Premiers pas](#premiers-pas)
- [Cibles](#cibles)
- [Builder](#builder)
- [Tester](#tester)
- [Serveur de pipelines](#serveur-de-pipelines)
- [Assembler le bundle `.app`](#assembler-le-bundle-app)
- [Ouvrir l'app](#ouvrir-lapp)
- [Recompiler et relancer d'un coup](#recompiler-et-relancer-dun-coup)
- [Les hooks git : recompiler après un pull](#les-hooks-git--recompiler-après-un-pull)
- [Composants de l'app](#composants-de-lapp)
- [Le binaire `omp` de l'app](#le-binaire-omp-de-lapp)
- [Harnais réel](#harnais-réel)
- [Consulter et corriger la mémoire du projet](#consulter-et-corriger-la-mémoire-du-projet)
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
- **Le serveur de pipelines du VPS** pour tout sauf la Mémoire : son code
  d'appairage (`harness.sh pair`), ou son adresse https et son jeton, se collent dans
  la feuille « Serveur » (voir « Serveur de pipelines »). La Mémoire n'en a pas
  besoin.
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
2. **Relier le serveur de pipelines** — la tuile Système › **Serveur** (ou ⌘K ›
   Serveur) ouvre la feuille « Serveur » : l'adresse du serveur et son jeton d'accès
   (voir « Serveur de pipelines »).
3. **Piloter** — « Demander à l'OS… » (⌘L) envoie une demande ; « Maintenant »
   montre ce qui vous attend, ce qui a été livré, ce qui bloque ; un fil s'ouvre au
   centre, « Comprendre » (⌥⌘I) l'explique. ⌘N lance une feature, un projet ou un
   audit, toujours dans une feuille. Le serveur conduit seul chaque feature de /req
   au merge ; l'app ne lance aucun process `omp` pour une pipeline.

**La mémoire survit à ⌘Q** : le service mémoire est un agent launchd
(`com.omp.console.mem0-rs`), pas un process de l'app — le Quitter de l'app ne le
touche pas. Fermer l'app (ou la voir plantée) ne coupe donc pas la mémoire : une
session `omp` au terminal, ou un `omp -p`, sur un dépôt reçoit toujours son rappel
par `http://localhost:8321` (le défaut du plugin `omp-mem0-memory`).

Les commandes `/req`, `/project`, `/audit` et `/pipelines` d'une session OMP passent
par le même serveur (plugin `omp-mem0-req`). Quelle copie de ce plugin OMP charge,
comment en changer (version publiée ou copie de travail) et comment relancer `omp`
ensuite : `PUBLISHING.md` § « Mettre à jour », à la racine du dépôt.

### Barres d'outils et identifiants

Aucun écran ne porte de bouton « Actualiser » ni « Serveur » : Présentation ▸
Actualiser (⌘R) relit ce que l'OS montre (inactif sans serveur relié ou pendant une
lecture), et la feuille du serveur s'ouvre par la tuile Système › Serveur ou par ⌘K.
Système › Planifications porte « + » (`schedules.new`), Système › Dépôts « + »
(ajouter un dépôt par son URL).

Identifiants : tuiles du hub `system.tile.<workstation|repos|schedules|autonomy|vigie|stats|issues|admin|server>` ;
écrans `workstation.harness`, `schedules.harness`, `autonomy.harness`,
`vigie.harness`, `stats.harness`, `issues.harness`, `admin.harness` ; feuille
« Serveur » `server.sheet` (`server.address`, `server.secret`, `server.save`,
`server.forget`, `server.providers`). Feuille « Nouvelle feature »
`pipelines.launch.title`, `pipelines.launch.request`, `pipelines.launch.priority`,
`pipelines.launch.lane`, `pipelines.launch.modules`, `pipelines.launch.req`,
`pipelines.launch.budget`, `pipelines.launch.commit` ; « Nouveau projet »
`project.launch.title`, `project.launch.commit` ; « Nouvel audit »
`audit.launch.focus`, `audit.launch.commit`. Feuille « Préparation d'OMP Console »
`sheet.setup` (`sheet.setup.install`, `sheet.setup.retry`, `sheet.setup.switchAnyway`,
`sheet.setup.quit`, `sheet.setup.close`, `sheet.setup.ompMissing`,
`sheet.setup.retryMissed`, lignes
`sheet.setup.row.<components|migration|service|prerequisites>`, bloc de
progression `sheet.setup.progress` avec `sheet.setup.progress.label` et
`sheet.setup.progress.bar`, échec `sheet.setup.failure`, rejets de l'import
`sheet.setup.rejected` (choix `sheet.setup.rejected.choice`),
`sheet.setup.detail.toggle`, `sheet.setup.detail`, `sheet.setup.diagnostic`).

Le badge d'état des composants embarqués, au pied de la liste des fils, est
`components.badge` ; il n'apparaît que si un composant manque, et c'est alors un
bouton (AXButton) qui rouvre la feuille de préparation.

## Cibles

Le paquet déclare ces cibles (une ligne par cible, `omp-console/Package.swift`) :

- **OMPConsole** — la coque macOS : les vues, les modèles d'écran et les
  adaptateurs au système (AppKit, SwiftUI, PTY, réseau). Cible exécutable ;
  dépend de `ConsoleCore`, de `ConsoleClient` (le client du serveur de
  pipelines, partagé avec l'app iOS) et de `ConsoleUI` (les écrans partagés).
- **OMPConsoleTests** — la suite Swift Testing de la coque ; dépend de
  `OMPConsole`, de `ConsoleCore` et de `ConsoleClient`.
- **ConsoleClient** — la **cible partagée macOS/iOS des clients du serveur du VPS** :
  le client du serveur de pipelines (`Harness*.swift`), le code d'appairage
  (`HarnessPairing`), le lecteur de la mémoire du serveur (`MemoryReader`,
  `MemoryAccess`) et le trousseau. Les deux apps sont indépendantes : aucune ne parle
  à l'autre. Dépendance unique : `ConsoleCore` ; ni AppKit ni UIKit.
- **ConsoleUI** — la **cible partagée macOS/iOS des écrans écrits une seule fois** :
  l'OS agentique (`OS/` : Radar, liste des fils, Maintenant, page d'un fil, cartes de
  décision, tri, « Comprendre », Propositions, Savoir, Automatismes, espaces, hub
  Système `OSSystemHub`), la carte de ce qu'une feature attend (`RunPendingCard`) et
  le menu de ses gestes (`RunMenuItems`), les cartes de décision et la session en
  graphe (`DecisionCardViews`, `SessionGraphViews`), les preuves (`RunProofsSections`),
  le Poste (`WorkstationSections` et ses pages `WorkstationPage`), les écrans du hub
  (`VigieSections`, `SchedulesSections`, `AutonomySections`, `IssuesSections`,
  `AdminSections`, `RepoSettingsList`), les feuilles de création (`CreationSheets`,
  `LaunchViews` : Nouvelle feature ⌘N, Nouveau projet, Nouvel audit, Nouvelle
  planification), la palette ⌘K et la recherche globale ⌘F (`consolePalette`), la
  carte « Services » (`ServicesSection`) et la feuille d'un souvenir
  (`MemoryEditSheet`). SwiftUI et Charts seulement ; ce qui diffère (rendu Markdown,
  direct d'une session, destination demandée) est fourni par chaque app
  (`consoleShell`).
  Dépend de `ConsoleCore` et de `ConsoleClient` ; tout réseau passe par
  `ConsoleClient`.
- **ConsoleClientTests** — la suite Swift Testing hermétique de la couche
  cliente (doublures de transport et de trousseau, aucun réseau) ; dépend de
  `ConsoleClient` et de `ConsoleCore`.
- **ConsoleCore** — la **cible partagée macOS/iOS** : le vocabulaire figé des
  sections (`ConsoleSection`), les mots du serveur de pipelines
  (`PipelineServerText`), la lecture des réponses de la mémoire (`MemoryWire`), le
  noyau du graphe de la mémoire et le rendu Markdown (`MarkdownDocument`), et la
  langue des écrans (`L10n`, avec sa seule ressource : la table anglaise
  `Resources/en.lproj/Localizable.strings`). Aucune
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
# principal et des tests de vue ; en parallèle elle rend des échecs de délai.
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

Les onglets de l'OS agentique et les pages du Système sont servis par le serveur de
pipelines du VPS (`omp-harness`, voir `omp-harness/README.md`), sur le Mac
(`Sources/OMPConsole/Server/`) comme sur l'iPhone et l'iPad
(`ios/OMPConsoleIOS/IOSOSRootView.swift`, `ios/OMPConsoleIOS/IOSSystemScreens.swift`).
C'est le seul moteur de pipelines :
l'app lit son état et lui envoie des gestes, sans jamais exécuter une étape
elle-même.

- **Connexion directe.** L'app joint le serveur en https (Tailscale ou un reverse
  proxy TLS), sans passer par le Mac sur iOS. La feuille « Serveur » (tuile Système ›
  Serveur, ou ⌘K ;
  `Sources/OMPConsole/Server/ServerSheet.swift`
  et `ios/OMPConsoleIOS/IOSServerSheet.swift`) demande deux choses : l'adresse,
  gardée dans les préférences (`harness.address`), et le jeton du serveur
  (`/var/lib/omp-harness/state/token`), gardé dans le trousseau
  (`com.omp.console.harness`). Elles ne sont enregistrées qu'après une boîte
  effectivement lue ; « Oublier ce serveur » les efface de l'appareil. Le code
  d'appairage `omp1:…` (`harness.sh pair`), collé dans le champ de l'adresse, porte
  les deux ; sur le Mac, il est aussi écrit dans `~/.omp/harness.json` et
  `~/.omp/mem0.json`, que lisent les plugins d'omp et la section Mémoire (après une
  relance). Sans serveur enregistré, l'app Mac prend celui de `~/.omp/harness.json`
  (posé par `/pair` dans omp).
- **Le code approbateur** (`harness.sh approver` sur le VPS ; avec Portainer,
  `omp-harness-stack approver` dans la console du conteneur `harness`) est le code ordinaire
  plus une 5e ligne : le jeton du client approbateur, le seul qui approuve, refuse
  ou règle le poste de travail. Collé dans la feuille « Serveur » (Mac et iPhone ;
  « Oublier ce serveur » d'abord si l'app est déjà reliée), il donne à l'app ce
  jeton approbateur pour tous ses appels, gardé au trousseau seulement ; sur le Mac,
  `~/.omp/harness.json` reçoit le jeton **ordinaire** (2e ligne), jamais
  l'approbateur, car toute session omp lit ce fichier. omp `/pair` et l'extension
  Chrome refusent ce code. Sur un serveur systemd ou NixOS,
  `sudo omp-harness-client approver` imprime le jeton approbateur seul : le saisir
  dans le champ du jeton, avec l'adresse. Chaque appel de `approver` invalide le code
  précédent.
- **Appairer un iPhone par QR code.** Sans coller de code : sur le Mac relié à un
  serveur qui annonce la capacité `pairing-ticket` (`GET /v1/health`), avec un jeton
  `admin` qui voit tous les dépôts, la feuille « Serveur » offre « Appairer un
  iPhone… » (`PairDeviceSheet`, `ConsoleUI/PairDeviceViews.swift`). Elle nomme
  l'appareil (« iPhone » par défaut), crée un **ticket à usage unique**
  (`POST /v1/pair/tickets`, 10 minutes, gardé en mémoire par le serveur) et l'affiche
  en QR code (`ConsoleUI/PairQRCode.swift`, CoreImage, correction M, noir sur blanc
  dans les deux modes) avec le temps restant ; « Refaire un code » en crée un autre.
  L'interrupteur « Cet iPhone approuve les envois du poste » n'existe que si l'app
  Mac a elle-même le jeton approbateur (le droit se délègue d'un approbateur à un
  autre). La mémoire du projet est jointe au ticket quand ce Mac en lit une sur un
  serveur (`~/.omp/mem0.json`, `Server/PairMemory.swift`), jamais l'agent local.
  Le QR code porte `ompconsole://pair?u=<adresse du serveur>&t=<ticket>`
  (`HarnessPairLink`, `ConsoleClient/HarnessPairLink.swift`) : l'appareil photo de
  l'iPhone l'ouvre dans l'app, qui demande « Appairer cet appareil avec <adresse> ? »
  (rien n'est échangé avant ce « Appairer » : un lien ne relie jamais l'appareil à un
  serveur que l'humain n'a pas vu), puis échange le ticket SANS jeton
  (`POST /v1/pair/redeem`, `HarnessModel.pair(with:)`) contre le jeton d'un client
  nommé, révocable seul, et relie l'app comme le collage d'un code `omp1:` (adresse,
  jeton au trousseau, mémoire reçue). Un ticket périmé, déjà utilisé ou refusé, un
  serveur injoignable ou trop ancien ont chacun leur phrase. Le Mac ignore un lien
  `pair` ouvert.
- **Fournisseurs et modèles** (jeton `admin` seulement) — dans la feuille
  « Serveur », « Fournisseurs et modèles » (`ProvidersView.swift`,
  `ios/OMPConsoleIOS/IOSProvidersScreen.swift`) déclare les fournisseurs LLM du
  serveur : un fournisseur connu d'omp (Anthropic, OpenAI, OpenRouter, Google
  Gemini, Mistral, xAI) avec sa clé, ou un service compatible OpenAI (l'Ollama du
  VPS, vLLM, un oMLX publié par Tailscale…) avec son adresse, son protocole et ses
  modèles ; puis les **modèles par niveau** (Rapide, Standard, Approfondi), saisis
  `fournisseur/modèle` dans l'ordre de bascule. La clé part vers le serveur
  (`PUT /v1/providers/{name}`) et n'en revient jamais : l'écran n'en montre que les
  quatre derniers caractères. Un champ de clé vide garde la clé déclarée.
  La section **Abonnements** connecte un abonnement sans clé (Claude Pro/Max,
  ChatGPT Plus/Pro, Gemini…, la liste que donne omp, `GET /v1/oauth`) : choisir
  l'abonnement, « Connecter », ouvrir la page de connexion dans le navigateur
  (Safari sur l'iPhone), s'y connecter, puis coller dans l'app le code ou l'adresse
  entière de la page finale (elle pointe vers `localhost`, que le navigateur ne joint
  pas). Le serveur la relaie à omp, qui garde les identifiants chez les agents ;
  l'app relit la connexion chaque seconde jusqu'à son issue, puis les fournisseurs.
  Un abonnement connecté figure dans les fournisseurs (sorte « Abonnement »,
  `oauth`) et se nomme dans les modèles par niveau (`openai-codex/…`). La section se
  cache face à un serveur qui ne connaît pas les abonnements.
- **Un seul client.** Un `HarnessModel` et un `HarnessDrafts` pour toute la
  fenêtre : tous les écrans du serveur partagent la même boîte, le même catalogue et
  les mêmes brouillons. L'échec du dernier échange s'affiche en tête de l'écran, avec
  sa cause puis son remède. Une annulation (changement d'écran, relecture remplacée)
  n'est pas un échec : aucun bandeau « ne répond pas ».
- **Décisions** (`GET /v1/inbox`, `OSDecisions`) — ce qui attend l'humain se tranche
  dans le fil qui l'a posé ou dans le tri (⌘T, par lots de même sorte). Les textes de
  l'agent, les specs et les verdicts sont rendus en Markdown. Les sortes :
  - **Questions** : les escalades d'une feature, répondues en un seul geste
    (`POST /v1/runs/{id}/escalations`) ; chaque réponse part de l'option recommandée
    (`recommended`), une saisie la remplace, une raison facultative l'accompagne. Une
    escalade posée avec sa **carte** (`card`, session en graphe) se lit en trois
    couches : la question (`headline`), l'enjeu (`stake`) et une ligne par option
    (conséquence, réversible ou non, coût, recommandée marquée) ; puis le **schéma de
    la bifurcation** dessiné nativement depuis `card.schema` (établi → ambiguïté →
    options → impacts), dont chaque option se choisit d'un geste ; puis la **carte
    d'exploration** (`GET /v1/runs/{id}/graph`, la question et ses preuves
    surlignées), repliée sur iPhone ; enfin les **Détails** repliés
    (`DecisionCardViews.swift`, `SessionGraphViews.swift`) ;
  - **Specs à valider** : le briefing du run en tête (`briefing`), puis `specs.md` ;
    « Valider » lance /impl, « Refuser » demande une raison, qui rejoint la mémoire
    du projet ;
  - **Verdicts à valider** : verdict, risque, bloquants, points non vérifiés et les
    preuves en mesures ; « Valider et fusionner » ou « Refuser » avec une raison
    (`POST /v1/runs/{id}/validate`) ;
  - **Envois du poste** à approuver (voir « Poste de travail »), **demandes** à
    confirmer ou à préciser (`/v1/intake*`) et **commentaires Jira** proposés ;
  - **Décisions prises seules** : « Garder » ou « Revoir » dans Maintenant
    (`POST /v1/runs/{id}/decisions/accept`) ; revoir fait reprendre la feature à cet
    endroit.
- **Propositions** (`GET /v1/proposals`) — le travail que les agents proposent,
  groupé par source : issues, vigie, audits, **signalements de collègues** (pont
  corpo ↔ usine, au propriétaire seulement), plan Jira, paliers d'autonomie,
  relances, PR, intégration continue. Le geste porte le nom de ce qu'il fait et ouvre
  le fil qu'il crée (`POST …/{id}/accept`) ; « Écarter » (`…/dismiss`). Confirmer un
  signalement ou lancer un item Jira revient à l'appareil approbateur, appliquer un
  palier à l'admin.
- **Fils et « Comprendre »** — un fil s'ouvre au centre (`OSThreadView`) ;
  « Comprendre » (⌥⌘I, `OSUnderstandView`) l'explique à quatre niveaux :
  - **Résumé** : ce que la feature attend de vous, en place (`RunPendingCard`), la
    demande d'origine, les specs et le verdict ;
  - **Récit** : le graphe de session en direct (`GET /v1/runs/{id}/graph`, relu
    quand l'événement `graph` du flux annonce une version plus récente,
    `RunGraphSections`) — une voie par étape, les dossiers touchés dépliables, les
    décisions et questions teintées ; un nœud ouvre le Brut sur son entrée
    (`HarnessGraphLink`). Sans la capacité `session-graph`, la frise du direct ;
  - **Preuves** : les captures (`GET /v1/runs/{id}/proofs`, `RunProofsSections` :
    l'avant et l'après de chaque critère, rapports de tests par critère, tours
    précédents repliés), les fichiers touchés et leurs différences (`/changes`,
    `/diff?path=`) et les tests en direct (`test_output`, `/tests/live`) ;
  - **Brut** : la session OMP de l'agent en temps réel (`GET /v1/runs/{id}/session`
    puis `GET /v1/events?run={id}&live=1`) — paragraphes en Markdown, raisonnement
    replié, chaque outil avec son intention, sa commande, son état et la fin de son
    résultat, les sous-agents en une ligne ; « Détails » ouvre le rendu de l'outil
    (`GET /v1/runs/{id}/session/{seq}`). Une feature finie se rejoue ; le serveur
    masque les secrets reconnus avant d'envoyer.

  La feuille « Session en direct » sert à l'« Analyse en direct » d'un audit
  (`GET /v1/audits/{id}/session`) et aux sessions des jobs du poste.
- **Créer = une feuille.** ⌘N ouvre « Nouvelle feature » (le dépôt parmi ceux que le
  serveur déclare, un titre, la demande et ses options ; `POST /v1/runs`) ; la
  palette ouvre aussi « Nouveau projet » (`POST /v1/projects`) et « Nouvel audit »
  (`POST /v1/audits`).
- **Gestes d'une feature** — le menu d'un fil (`RunMenuItems`) : consigne, budget,
  priorité, PR, relancer (`POST /v1/runs/{id}/retry`, en feuille avec une consigne
  facultative), annuler la fusion (`POST /v1/runs/{id}/revert`, confirmé), arrêter.
  Chaque geste porte la révision lue (`If-Match`).
- **Alertes et coût.** La veille du serveur (agent muet, étape lente, boucle de
  corrections, budget dépassé) et le coût s'affichent sur le fil et dans le Radar
  (`alerts` et `costs` de `GET /v1/inbox`).
- **Système › Statistiques et santé** — quatre graphiques Swift Charts (Mac
  `HarnessStatsCharts.swift`, iOS `IOSStatsCharts.swift`) : **Ce qui vous attend**,
  **Débit**, **Coût des agents**, **Santé** ; puis `GET /v1/stats` (features par
  état, fusions, délais, étapes, tests, capacité du serveur), la consommation des
  agents, la comparaison des modèles, les tests instables et la santé du serveur
  (`GET /v1/metrics`), relue au rythme du serveur tant que l'écran est ouvert. Face à
  un serveur sans séries, les blocs le disent au lieu d'échouer.
- **Live Activity (iPhone).** La Live Activity d'une feature (extension
  `ios/OMPConsoleWidgets`) montre son état, son étape, l'outil du moment, une alerte et
  son coût, sur l'écran verrouillé et dans la Dynamic Island. Elle démarre **seule** :
  dès son lancement, l'app enregistre au serveur son jeton push-to-start
  (`POST /v1/push/activities/start`), et un serveur qui a une clé APNs démarre
  lui-même l'activité d'une feature qui se met au travail ou attend l'humain, app
  fermée ; l'app adopte cette activité et enregistre son jeton de mise à jour
  (`POST /v1/push/activities`). Quand le serveur ne pousse pas (pas de clé, serveur
  antérieur), l'app en démarre une elle-même tant qu'elle est au premier plan : une
  seule à la fois, la plus urgente — la feature qui attend l'humain depuis le plus
  longtemps, sinon celle qui travaille (`HarnessActivityStart`). « Suivre sur l'écran
  verrouillé », dans le menu d'un fil, en démarre ou en arrête une à la main ; une
  activité arrêtée ou écartée ne
  redémarre pas d'office. Un toucher ouvre le fil de la feature
  (`ompconsole://threads/<id>`) ; quand une revue attend, l'activité porte « Ouvrir »
  et « Valider » : valider exige l'appareil déverrouillé et part à la révision que le
  serveur vient de rendre (`OMPRunValidateIntent`, une `LiveActivityIntent` compilée
  dans l'app et dans l'extension, `ios/OMPConsoleShared`), sinon une notification
  « Geste non abouti » le dit. L'app met l'activité à jour tant qu'elle est ouverte ;
  app fermée, le serveur la tient à jour par APNs s'il a une clé (`apns` de sa
  configuration, voir `omp-harness/README.md` § « Les Live Activities app fermée »).
  Une feature terminée clôt son activité. Si iOS refuse le jeton push (capacité
  absente), l'activité démarre quand même, mise à jour par l'app ouverte.
- **Notifications actionnables (iPhone, Mac).** Après l'appairage, l'app demande la
  permission de notifier. Sur l'**iPhone**, elle enregistre alors le jeton APNs de
  l'appareil au serveur (`POST /v1/push/devices`, au nom du client de son jeton ; la
  passerelle `sandbox` ou `production` est lue dans le profil embarqué de l'app), qui
  lui pousse les specs et verdicts à valider, les questions, les envois du poste à
  approuver (seulement au jeton approbateur), les features en échec, l'agent muet, le
  budget dépassé, la vigie muette et les sauvegardes échouées — voir
  `omp-harness/README.md` § « Les alertes push des appareils ». Sur le **Mac**, sans
  APNs, chaque événement du flux qui attend l'humain devient une notification locale
  tant que l'app tourne en arrière-plan. Une question posée avec sa carte n'y porte
  que sa `headline` (titre) et son `stake` (corps, suivi de « · +N autres questions »
  pour un lot), comme l'alerte push du serveur. Les gestes sont les mêmes des deux côtés :
  **Valider** / **Refuser** (specs, verdict ; le refus demande sa raison),
  **Approuver** / **Refuser** (envoi du poste) et **Ouvrir**. Sur l'iPhone, une
  question posée seule avec sa recommandation (catégorie `omp.answer`) se tranche
  depuis la notification : **Prendre la recommandation**, ou **Répondre…** (saisie) ;
  la toucher ouvre le fil de sa feature. Valider, refuser, approuver et répondre
  exigent l'appareil déverrouillé et partent avec la révision que portait la
  notification (`If-Match`) : si la feature ou l'envoi a bougé depuis, rien n'est
  tranché et une notification « Geste non abouti » le dit. Sans le jeton approbateur au
  trousseau, Approuver et Refuser d'un envoi ouvrent l'app sur le Poste. Toucher une
  notification ouvre ce qu'elle désigne : le tri des décisions, le Poste, le fil de
  la feature, ou Système › Vigie (vigie muette, sauvegarde
  échouée). Côté Apple, l'App ID n'a besoin que de la capacité Push
  Notifications, déjà requise par les Live Activities (`aps-environment` de
  `ios/OMPConsoleIOS.entitlements`) ; côté serveur, de la clé `.p8` de `apns`. Le
  routage (catégorie → geste) vit dans `ConsoleClient/HarnessNotifications.swift`, le
  pont vers le système dans `HarnessNotificationCenter.swift`.
- **Widget d'écran d'accueil (iPhone, iPad).** « Boîte du serveur », en petit, moyen
  ou grand format : ce qui attend votre décision, le nombre de features en cours et
  d'alertes, puis les features vivantes (celles qui vous attendent d'abord) avec leur
  étape, leur alerte et leur coût. L'app partage avec l'extension un groupe d'apps
  (`OMP_APP_GROUP`, `group.com.omp.console.ios` par défaut) : elle y dépose
  l'instantané de chaque boîte relue et l'adresse du serveur, et copie le jeton dans
  un article de trousseau du groupe ; le widget relit ainsi la boîte lui-même
  (`GET /v1/inbox`) toutes les 15 minutes, app fermée, et montre le dernier
  instantané, daté, sans réseau. Un toucher ouvre le tri de ce qui attend
  (`ompconsole://decisions`), ou l'accueil quand rien n'attend (`ompconsole://now`) ;
  dans les formats moyen et grand, une feature ouvre son fil
  (`ompconsole://threads/<id>`).
- **Siri, Raccourcis, bouton Action (iPhone, iPad).** Quatre App Intents pilotent le
  serveur sans ouvrir l'app, appareil déverrouillé : **Demander à l'OS** (une phrase
  dictée ou tapée devient une Demande, `POST /v1/intake` de source `voice`), **Tout
  suspendre** (la pause du serveur, après confirmation) et **Reprendre**
  (`POST /v1/pause`), **Décisions en attente** (lecture : le compte et les premières
  décisions). Chacun dit ce qu'il a fait, ou pourquoi il n'a rien fait (aucun serveur
  relié, serveur antérieur à la fonction, jeton sans le droit). Voir « Siri » plus bas.
- **Liens.** `ompconsole://<section>`, `ompconsole://threads/<id>` (le fil d'une
  feature ; `runs/<id>` aussi), `ompconsole://decisions`, `ompconsole://now` et
  `ompconsole://system/<page>` ouvrent l'app à cet endroit (`HarnessWidgetLink`).
- **Mise à jour en direct.** L'app suit le flux SSE du serveur
  (`GET /v1/events`) à partir du curseur de la boîte ; chaque événement relit la
  boîte et, une fois un écran de catalogue ouvert, le catalogue. Une coupure
  garde la dernière boîte reçue, signalée « Hors ligne : dernière boîte reçue ».
  Présentation ▸ Actualiser (⌘R) sur le Mac, ou tirer pour actualiser sur iOS,
  relit à la demande.
- **Badges.** La liste des fils porte sur « Décisions » ce qui attend l'humain (la
  boîte — escalades ouvertes, specs et verdicts à valider — et les envois du poste à
  approuver, qui expirent) et sur « Propositions » ce que les agents proposent ; les
  tuiles du hub Système portent leur état (envois à approuver au Poste, vigie muette,
  planifications actives…). Sur iOS, le retour au premier plan (`scenePhase` active)
  ferme le flux, relit la boîte et le poste, puis rouvre le flux.
- **Code partagé.** Le modèle (`HarnessModel`, qui porte `WorkstationModel`), les
  brouillons (`HarnessDrafts`), le transport (`HarnessTransport`) et le contrat
  (`HarnessWire`, `WorkstationWire`) vivent dans `ConsoleClient` ; les mots vivent
  dans `ConsoleCore` (`PipelineServerText`, `WorkstationText`). La garde
  `test/console/serveur-de-pipelines.test.ts` confronte chaque champ décodé au JSON
  réel du serveur et chaque route appelée à son routeur.

### Poste de travail

La tuile Système › **Poste** montre le poste de travail : l'extension Chrome `omp-chrome`,
qui observe le travail et agit **dans le navigateur seulement**, et l'agent 24/24
du serveur, qui fait de petites actions une fois assez d'heures observées. Tout
passe par le même serveur, le même jeton et le même flux que la boîte
(`server.workstation`, routes `/v1/workstation*`) ; un jeton limité à des dépôts
lit « le poste est réservé au propriétaire », un serveur antérieur « ne connaît
pas encore le poste de travail ».

La **page principale** reste calme (`WorkstationSections`) : un en-tête d'état
(extension en ligne et dernier contact, autonomie appliquée, pause ou arrêt, et le
bouton **Arrêt d'urgence** — « Reprendre le poste » une fois arrêté), les envois à
approuver seulement s'il y en a, « Demander au poste » (un champ, le navigateur,
l'envoi ; les demandes en cours et la plus récente terminée, « Toutes les
demandes »), les cinq dernières décisions (« Tout le journal »), puis une rangée
par sous-page (`WorkstationPage`, `workstation.page.<page>`) : **Réglages**
(autonomie, adresses et pseudos, navigateurs, navigation gardée),
**Automatisations**, **Commander le navigateur**, **Profil**, **Réunions**,
**Journal**, **Sessions** des jobs du poste, **Demandes**. Ce que ces pages montrent :

- **Extension et agent 24/24** (`GET /v1/workstation`) : extension en ligne ou
  hors ligne et son dernier contact, sa version, les heures observées sur le seuil
  (barre de progression), le dernier et le prochain passage de l'agent.
- **Autonomie** : Auto (observe jusqu'au seuil, puis agit), Observer, Proposer
  (chaque action de l'agent attend l'approbation), Agir — `PUT
  /v1/workstation/settings`. Sous le choix, toujours visible : **envoyer un
  message à quelqu'un d'autre que vous demande toujours votre approbation, quel
  que soit le mode** ; sans réponse, l'envoi expire et vaut refus. « Mettre le
  poste en pause » arrête toute action et refuse l'observation.
- **Vos adresses et pseudos** : un message dont tous les destinataires y figurent
  est un message à vous-même et part sans approbation.
- **Envois à approuver** (`GET /v1/workstation/actions?state=awaiting_approval`) :
  le résumé, les destinataires (« Destinataires inconnus » quand l'extension n'a
  pu les lire) et le message en entier ; « Approuver l'envoi »
  (`POST /v1/workstation/actions/{n}/approve`) ou « Refuser » avec une raison
  facultative (`…/refuse`). Les deux gestes portent `If-Match: "<updatedAt>"` de
  l'envoi **affiché** : s'il a changé depuis (autre appareil, brouillon recalculé),
  le serveur répond 412 (428 sans révision), rien n'est approuvé, la liste est
  relue et l'app dit « L'envoi a changé depuis son affichage : relisez-le avant
  d'approuver. ». Une action de l'agent en mode Proposer (sans empreinte d'envoi)
  porte « Action proposée par l'agent 24/24 » : l'approuver n'autorise aucun
  envoi de message. Ils sont aussi des **décisions** de l'OS (tri, badge, tuile du
  Poste), sur le Mac comme sur iOS, pour ne jamais être manqués. Aucun outil d'agent n'approuve :
  seul ce bouton, touché par l'humain, le fait.
- **Le jeton approbateur** : approuver, refuser et régler le poste (autonomie,
  pause, adresses) exigent l'app appairée avec le **code approbateur** (voir
  « Serveur de pipelines »). Appairée avec le code ordinaire, l'app lit tout et
  garde ses boutons — le serveur seul décide —, mais il répond 403 ; l'app le dit
  sur les envois à approuver et sous l'autonomie (`HarnessFailure.approverOnly`) :
  « Seul l'appareil approbateur peut approuver, refuser ou régler le poste :
  appairez cette app avec le code approbateur : harness.sh approver sur le VPS,
  omp-harness-stack approver dans la console du conteneur harness (Portainer), ou
  le jeton de sudo omp-harness-client approver (systemd). ».
- **Profil** (`GET /v1/workstation/profile`) : le résumé, les habitudes, les
  outils, les horaires, les tâches répétitives (automatisables marquées), les
  besoins des clients et les préférences ; « Reconstruire le profil »
  (`POST /v1/workstation/profile/rebuild`). **Activité observée** : les sites les
  plus fréquentés et les heures actives (Swift Charts), les enchaînements récurrents.
- **Journal des décisions** (`GET /v1/workstation/actions`, le plus récent
  d'abord) : la sorte de chaque action en français, sa raison, son origine
  (Session ou Agent 24/24), son état, l'heure, qui l'a approuvée ou refusée,
  l'erreur ou le début du résultat.
- **Réunions** (`GET /v1/workstation/meetings`) : titre, état, heure, nombre de
  segments transcrits, résumé et besoins retenus avec leur citation.

Les événements `workstation_*` du flux de la boîte relisent l'état et les envois à
approuver (et le reste, section ouverte) ; aucun second flux n'est ouvert.
Identifiants (les mêmes sur Mac et iOS, écrans partagés) : `workstation.harness`,
`workstation.online`, `workstation.stop`, `workstation.stopped`,
`workstation.resume`, `workstation.page.<page>`, `workstation.autonomy`,
`workstation.sendGuard`, `workstation.paused`, `workstation.identities`,
`workstation.identities.save`, `workstation.approve.<n>`,
`workstation.refusal.<n>`, feuille de refus `workstation.refusal.reason` et
`workstation.refusal.commit`, `workstation.request.text`,
`workstation.request.send`, `workstation.requests.all`, `workstation.journal.all`,
`workstation.rebuild`.

### Tour de contrôle

Les écrans de l'OS agentique sont écrits une fois dans `ConsoleUI` (Mac et iOS) et
passent par les modèles de `ConsoleClient` portés par `HarnessModel` :
`server.vigie`, `server.schedules`, `server.admin`, `server.issues`, en plus de
`server.workstation`. Poste, Dépôts, Planifications, Autonomie, Vigie, Statistiques,
Issues et Administration sont des tuiles du hub **Système** (`OSSystemHub`,
`OSSystemDestination`, lien `ompconsole://system/<page>`). Un serveur qui ne sert pas
une fonction le dit (« mettez omp-harness à jour »), sans échec. Chaque écran est aussi
dans la palette ⌘K ; « Arrêt d'urgence » y figure.

- **Feature en direct** (`RunControlViews.swift`) : « Envoyer une consigne… »
  (`POST /v1/runs/{id}/instructions {text}`, `If-Match` de la révision) depuis le menu
  d'un fil (Mac et iOS) — l'app dit si l'agent
  l'a reçue dans sa session ou si elle part avec l'étape suivante ; « Modifier le
  budget… » (`POST /v1/runs/{id}/budget {budgetUsd}`, `null` revient au budget du
  serveur) ; la relance s'ouvre en feuille avec une consigne facultative
  (`POST …/retry {instructions?}`). Une feature en file montre en orange ce qui la
  retient (`reason`, `waitCause`).
- **Poste, pages** (`WorkstationControlSections.swift`) : le bouton rouge **Arrêt d'urgence**
  (`POST /v1/workstation/stop`, confirmé, jamais grisé par le rôle ; « Reprendre le
  poste » une fois arrêté, approbateur) ; le détail d'une action du journal (résultat
  entier, données, annulation `POST …/actions/{n}/cancel`, capture JPEG
  `GET …/actions/{n}/capture`) ; la transcription d'une réunion
  (`GET …/meetings/{id}`) ; les sessions des jobs du poste (profil, digest, service :
  `GET /v1/workstation/session?job=&since=`, relue toutes les 2 s dans le même direct
  qu'une feature) ; « Commander le navigateur » (`POST /v1/workstation/actions`,
  `open` ou `navigate` vers un onglet) ; les demandes en langage naturel et les
  automatisations (créer depuis une tâche automatisable du profil, cron facultatif,
  lancer, supprimer) ; les navigateurs (libellé, en ligne, navigateur par défaut) et la
  navigation gardée (hôtes permis, garde anti-exfiltration, retour à la configuration
  du serveur), réglés par le seul approbateur.
- **Vigie** (`ControlTowerSections.swift`) : mode (Coupée, Discrète, Signalement,
  Correction) et plafonds réglables par un admin (`PUT /v1/vigie`), dernier battement,
  état du jour, incidents (`GET /v1/vigie/incidents`, filtre par statut) avec empreinte,
  issue liée et feature de correction. Une vigie muette (`vigie_silent`) met la tuile
  Vigie au rouge et se voit dans le Radar.
- **Planifications** : liste (`GET /v1/schedules`, fuseau du serveur), création
  dans la feuille « Nouvelle planification » ouverte par le « + » de la page (cible
  feature, audit ou relève d'issues, expression cron à cinq champs), activer ou
  désactiver (`PUT`, `If-Match`), « Déclencher maintenant » (`POST …/run`), supprimer
  (confirmé). Le serveur ne rend que la prochaine échéance : elle s'affiche dès la
  création.
- **Autonomie** (`AutonomyViews.swift`, `server.autonomy`) : la page de Système lit les
  règles de chaque dépôt visible, les validations prises seules de la fenêtre
  d'apprentissage et les propositions de palier avec la modification de configuration
  suggérée (`changes`), par `GET /v1/autonomy` (tout lecteur). La seule écriture est une
  règle de palier (`POST /v1/autonomy/rules`, admin) : « Appliquer » sur une proposition
  du Savoir de l'OS agentique, offert aux seuls administrateurs. Un serveur qui ne sert
  pas la route (404) retire la page du hub et de la palette. La feuille « Nouvelle feature »
  envoie le type de travail et les labels (`POST /v1/runs {kind?, labels?}`), et la
  carte d'une décision prise seule par l'autonomie (`decision.autonomy`) montre la
  porte franchie, la règle (rang, `match`, exigences, portes) et chaque preuve avec sa
  valeur, à la place du contexte de l'agent.
- **Dépôts** (`RepoSettingsList`, `RepoSettingsViews.swift`, admin seulement) : la
  liste des dépôts déclarés, l'ajout par URL en feuille (`POST /v1/repos` : la clé de
  déploiement à poser et le lien de la page des clés), le détail réglable — branche
  principale, fusion, forge, parallélisme, identité git, politique, confidentialité,
  fournisseurs et modèles, juge des tests (`GET`/`PATCH /v1/repos/{name}`, chaque
  réglage part dès qu'il change) — et la suppression confirmée
  (`DELETE /v1/repos/{name}?confirm=1`). Les commandes (tests, contrôles, aperçu) se
  lisent sans s'éditer : elles s'exécutent sur le serveur.
- **Administration** (admin seulement, masquée sinon) : clients (`/v1/clients` : créer
  avec rôle et dépôts — le jeton n'est montré qu'une fois —, révoquer, confirmé),
  « Recharger la configuration » (`POST /v1/reload`), erreurs des clients
  (`GET /v1/client-errors`, filtre par source).
- **Issues** : les issues ouvertes d'un dépôt et la feature qui les porte,
  « Corriger » — par le MCP du serveur (`POST /v1/mcp`, outils `issues_list` et
  `issue_fix`, `HarnessModel.callTool`), seule surface des issues.

La garde `test/console/tour-de-controle.test.ts` confronte chaque route de ces écrans
au routeur du serveur (rôle compris), chaque champ décodé au JSON réel, et vérifie
leur câblage dans les deux apps ; `test/console/autonomie-console.test.ts` fait de même
pour l'autonomie.

### OS agentique : l'interface

L'app Mac est l'OS agentique : quatre objets — le **fil** (une intention, de la
demande au résultat), l'**agent** (usine, poste, vigie, session omp locale), la
**décision** (ce qui vous attend), le **savoir** (mémoire, consignes permanentes,
paliers) — plus l'**espace** (un client : ses dépôts, son budget, son autonomie). Les
écrans sont écrits une fois dans `Sources/ConsoleUI/OS/` (Mac et iOS), leurs mots dans
`ConsoleCore/Design/OSText.swift`, `OSWatchText.swift` et `OSSystemText.swift` ; la
coque Mac est `Sources/OMPConsole/OS/OSRootView.swift`, celle de l'iPhone et de l'iPad
`ios/OMPConsoleIOS/IOSOSRootView.swift` (cinq onglets, voir « Coque iOS »). Chaque
partie que le serveur ne sert pas (404) est absente : ni erreur, ni écran vide, ni
bouton mort.

| Écran | Fichier | Ce qu'il montre |
|---|---|---|
| Radar (toujours en haut) | `OSRadar.swift` | une pastille par agent et ce qu'il fait (`OSPulse`) : features vivantes, Poste, Vigie, **Sessions locales** ; le coût du jour, et le reste du budget de l'espace retenu ; « Tout suspendre » = la pause du serveur (« Après l'étape en cours » ou « Tout de suite », confirmée) — en pause la barre devient orange, dit « En pause » et porte « Reprendre » ; sans la capacité `pause`, l'arrêt du poste et des fils |
| Liste des fils | `OSThreadList.swift` | le composeur « Demander à l'OS… » (filtre, ⏎ = Demande) ; l'espace puis le lieu ; les entrées Maintenant, Décisions (n), Propositions (n), Automatismes, Savoir, Mémoire, Système ; les fils par état — une session omp locale en est un (ordinateur portable, « machine · branche · ↳ intention ») ; au pied, le badge des composants s'il en manque un |
| Maintenant | `OSHomeView.swift`, `OSBriefSections.swift`, `OSScoreTiles.swift` | le brief : sa phrase, « depuis … », « Vu » ; le composeur et, dessous, la réponse de l'OS à une question d'état ; les trois chiffres (sept jours, tendance des trois derniers jours) ; les agents au travail ; les sections repliables Vous attend, Livré (« seul »), Bloqué (sa cause), Échecs, Décidé seul (Garder / Revoir), Arrêtés (le motif). Sans la capacité `brief`, l'accueil d'avant |
| Propositions | `OSProposalsView.swift` | le travail que les agents proposent, groupé par source ; le geste porte le nom de ce qu'il fait (Lancer, Corriger, Appliquer, Confirmer, Relancer) et ouvre le fil qu'il crée ; « Écarter ». Appliquer un palier revient à l'admin, confirmer un signalement et lancer un item Jira à l'approbateur |
| Savoir | `OSKnowledgeView.swift`, `OSSpaceViews.swift` | les consignes permanentes (interrupteur, modifier, supprimer, ajouter, dépôt ou partout, origine) ; les paliers d'autonomie par dépôt (règles en phrases, confiance, « Appliquer » pour un admin) ; les espaces (créer, modifier, supprimer pour un admin non borné) |
| Mémoire (Mac) | `OMPConsole/OS/OSMemoryScreen.swift` | la mémoire du projet (voir « Consulter et corriger la mémoire du projet ») ; ⌘F y cherche |
| Système | `OSSystemHub.swift`, `OMPConsole/OS/OSSystemScreens.swift` | une grille de tuiles — symbole, mot, état en pastille ou en compteur : Poste, Dépôts (admin), Planifications, Autonomie (si servie), Vigie, Statistiques et santé, Issues, Administration (admin), Serveur ; une tuile pousse son écran dans une pile au centre (retour natif), Serveur ouvre sa feuille |
| Page d'un espace | `OSSpaceViews.swift` | les chiffres de la semaine, le budget du jour, le rapport hebdomadaire (Markdown rendu), « Copier » et le partage natif |
| Fil, décisions, tri, Comprendre, Automatismes | `OSThreadView.swift`, `OSDecisionCard.swift`, `OSTriageView.swift`, `OSUnderstandView.swift`, `OSAutomationsView.swift` | la page d'un fil et ses cartes, le tri des décisions en feuille, l'inspecteur « Comprendre », ce que l'OS lance seul |

Raccourcis du Mac : ⌘1…⌘6 les entrées fixes (Maintenant, Propositions, Automatismes,
Savoir, Mémoire, Système), ⌘L le composeur, ⌘T le tri, ⌘⇧P suspendre (après
confirmation) ou reprendre, ⌥⌘I l'inspecteur « Comprendre », ⌘N une nouvelle feature,
⌘K la palette, ⌘F la recherche, ⌘R actualiser. Liens et destinations (notification,
palette) passent par `drafts.requestedSection` et `OSMacRoute` :
`ompconsole://runs/<id>` ouvre le fil de la feature, `ompconsole://threads/<id>` un
fil, `ompconsole://decisions` (comme `inbox`) le tri, `ompconsole://now`
« Maintenant », `ompconsole://workstation` l'écran Poste, `ompconsole://memory` la
Mémoire, `ompconsole://system` le hub et `ompconsole://system/<page>` un de ses écrans.

Variables de recette (captures, `scripts/recette/os-shots.sh`) : `OMP_CONSOLE_OS_VIEW`
(`now`, `proposals`, `knowledge`, `automations`, `memory`, `system`, `system:<écran>`,
`space:<identifiant ou nom>`),
`OMP_CONSOLE_OS_SPACE` (l'espace retenu dans la liste, par identifiant ou par nom),
`OMP_CONSOLE_OS_THREAD` (un fil), `OMP_CONSOLE_OS_RUN` (le fil d'une feature),
`OMP_CONSOLE_OS_TRIAGE` (le tri), `OMP_CONSOLE_OS_LEVEL` (le niveau de « Comprendre »),
`OMP_CONSOLE_OS_NEW` (la feuille « Nouvelle feature »).

Tests : `Tests/OMPConsoleTests/OSWatchTests.swift` (tri par espace et par lieu,
regroupement des propositions et qui les accepte, règles de palier en phrases, tendance
d'un chiffre) ; les gardes `test/console/autonomie-console.test.ts` (la seule écriture
de l'autonomie, réservée à l'admin) et `test/console/serveur-de-pipelines.test.ts` (chaque
route de l'OS agentique appelée par le client est servie).

### OS agentique : la couche client

`ConsoleClient` porte les routes de l'OS agentique d'`omp-harness` (capacités `os-loop`,
`pause`, `os-autonomy`, `spaces`, `brief`, `scoreboard`, `proposals`, `local-sessions`,
`push-answer`, `push-start`, `intake-context`). Aucune vue ni aucun texte n'y vit : les
écrans lisent ces modèles. Chacun est paresseux, remis à zéro avec le serveur, relu sur
son événement du flux une fois lu, et se dit `.absent` sur un serveur qui ne sert pas
sa route (404) — rien ne s'affiche alors, sans échec.

| Modèle (`HarnessModel`) | Routes | Événement |
|---|---|---|
| `server.pause` (`HarnessPauseModel`, `setPause(paused:reason:now:)`) | `GET`/`POST /v1/pause` (`now` : interrompre tout de suite) | `pause` |
| `server.rules` (`HarnessStandingRulesModel`) | `GET`/`POST /v1/rules`, `PUT`/`DELETE /v1/rules/{id}` | `standing_rule` |
| `server.autonomy.setRule` | `POST /v1/autonomy/rules` | `autonomy_rule` |
| `server.spaces` (`HarnessSpacesModel`) | `GET`/`POST /v1/spaces`, `PUT` (`If-Match`)/`DELETE /v1/spaces/{id}`, `GET …/report` | `space` |
| `server.brief` (`HarnessBriefModel`) | `GET /v1/brief`, `POST /v1/brief/seen` | `run_state`, `merged`, `decision`, `decision_auto_timeout`, `proposals` |
| `server.scoreboard` (`HarnessScoreboardModel`) | `GET /v1/scoreboard?days=` | — |
| `server.proposals` (`HarnessProposalsModel`) | `GET /v1/proposals`, `POST …/{id}/accept`, `POST …/{id}/dismiss` | `proposals` |
| `server.localSessions` (`HarnessLocalSessionsModel`) | `GET /v1/local-sessions`, `POST …/{id}/handoff`, `DELETE …/{id}` | `local_session` |

- **Gestes d'une feature** (`HarnessModel`, `If-Match` de la révision lue) : `cancel(runId:cause:note:)`
  (motif `HarnessCancelCause` ; sans motif, le corps d'avant), `amend(runId:text:always:)` (corriger au
  lieu d'annuler, rend la voie prise `HarnessAmendVia`), `setModules`, `setAutonomy` (`null` : les règles
  du dépôt), `runTemplate(runId:)` (« refaire » : `GET /v1/runs/{id}/template`, dont `options` relance la
  feature par `launchRun`). `answer(…, always:)`, `validate(…, always:)` et `amend(…, always:)` font de la
  réponse, du refus ou de la correction une consigne permanente. `HarnessLaunchOptions.autonomy`,
  `launchProject(…, autonomy:)` et `intakes.confirm(_, autonomy:)` posent le curseur au lancement.
- **Champs lus** : `HarnessRun.autonomy`, `cancelCause`, `blockedBy` (ce qui retient une feature en
  file), `waitUntil` ; `HarnessEscalation.autoAt` et `autoAnswer` (l'instant où la recommandation
  s'appliquera seule) ; `HarnessStatus.paused` ; `HarnessIntake.context` (page d'origine d'une Demande,
  envoyée par `intakes.submit(…, context:)`).
- **Notifications** : la catégorie `omp.answer` (une seule question ouverte, avec sa recommandation)
  offre « prendre la recommandation » et « répondre » (saisie) ; `HarnessPushAlert.question` porte
  `omp.question {id, recommended, options}`, et `HarnessNotificationRouting.gesture` en fait la réponse à
  l'escalade, envoyée par `HarnessModel.execute` à la révision de la notification.
- **Live Activities** : `registerActivityStart(token:environment:)` enregistre le jeton push-to-start
  (`POST /v1/push/activities/start`) — le serveur démarre lui-même l'activité d'une feature ; le jeton
  suit l'app d'un serveur à l'autre, `unregisterActivityStart()` le retire.
- **Fils** (`OSThreads`, `OSDecisions`, `OSPulse`) : une session omp locale est un fil (origine
  `.local(hôte)`, `OSThread.localSession`) ou rejoint celui de la feature qui a repris son travail ;
  `OSThreads.space(of:spaces:)` range un fil dans l'espace de son dépôt ; `OSDecisions.lots` regroupe
  les décisions de même sorte ; le pouls garde l'activité d'une session locale (`.localSession(id)`).

Tests : `Tests/ConsoleClientTests/` — `HarnessLoopTests`, `HarnessStandingRulesTests`,
`HarnessSpacesTests`, `HarnessProposalsTests`, `HarnessRemoteTests`, `OSThreadsTests`.

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
Il recopie aussi, avant la signature, les textes anglais : le bundle de ressources
SwiftPM `omp-console_ConsoleCore.bundle` rendu à côté du binaire (sa table
`en.lproj/Localizable.strings`), dans `Contents/Resources`, où le cherche
`Bundle.module`, et `omp-console/Bundle/en.lproj` (la description du réseau local
en anglais). Sans ce bundle de ressources, il échoue sans bundle (`✗ bundle de
ressources introuvable`) : l'app planterait au premier texte lu en anglais.

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

### Capture du niveau « Preuves »

```bash
bash scripts/recette/mac-shots.sh
```

Le script construit l'app (`swift-app.sh --no-tests`), démarre un serveur de
démonstration (`scripts/recette/mac-shots-serveur.ts` : le vrai gestionnaire HTTP
d'omp-harness sur un monde de test, avec une feature qui attend la validation de sa
revue et ses preuves sur deux tours), puis ouvre une COPIE de l'app
(`com.omp.console.recette`) sur le fil de cette feature, « Comprendre » au niveau
« Preuves » (`OMP_CONSOLE_OS_RUN`, `OMP_CONSOLE_OS_LEVEL=Preuves`), et capture sa
fenêtre : `omp-console/build/mac-shots/preuves.png` (dossier ignoré par git). La copie
lit un dossier personnel et une racine de support jetables (`CFFIXED_USER_HOME`,
`OMP_CONSOLE_SUPPORT_ROOT`, recette de préparation `succes`) : ni les préférences, ni
le trousseau, ni le `~/.omp` de l'utilisateur ne sont touchés. Codes de sortie :
0 image produite, 1 échec, 2 non exécuté hors macOS.

### Captures des écrans de l'OS

```bash
bash scripts/recette/os-shots.sh
```

Même principe : le script construit l'app, démarre `scripts/recette/os-demo-serveur.ts`
(le vrai gestionnaire HTTP et le vrai orchestrateur d'omp-harness sur un monde de
test : une revue à valider, une question, une feature au travail, une feature retenue
en file, un échec, un arrêt motivé, un audit proposé, deux espaces, des consignes
permanentes, une règle de palier, une session omp locale), puis relance une COPIE de
l'app (`com.omp.console.recette-os`, préférences vides) une fois par écran, ouvert
par les variables `OMP_CONSOLE_OS_*`. Sept images sous `omp-console/build/os-shots/`
(dossier ignoré par git) : `maintenant.png`, `fil.png`, `revue.png` (la revue à
valider d'une feature : preuve en mesures, geste principal), `tri.png`,
`propositions.png`, `savoir.png`, `espace.png`. Codes de sortie : 0 les sept images
produites, 1 échec, 2 non exécuté hors macOS.

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

Sans compiler : chaque release GitHub du dépôt porte `OMP-Console-macOS.zip`.
Quand le dépôt a ses secrets de signature, l'app est signée Developer ID et
notarisée : elle s'ouvre au double-clic. Sinon, le journal du job de release le
signale par un `⚠` et l'app est signée ad hoc : retire la quarantaine avant de
l'ouvrir (`xattr -dr com.apple.quarantine "OMP Console.app"`) ; Siri n'en exécute
alors aucun intent (voir § « Assembler le bundle `.app` »). Le détail, et les
secrets à créer : `PUBLISHING.md` § « Apps jointes aux releases ».

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

- **Badge des composants** — le pied de la liste des fils porte l'état du composant
  embarqué (identifiant AX `components.badge`) quand il manque : « OMP manquant »
  (point orange). La présence se lit par le MÊME prédicat que l'installateur — le
  binaire existe, est exécutable et n'est pas un dossier — jamais l'état de marche :
  aucune version n'est exécutée. Deux veilles de fichier (`FileWatcher`, jamais de
  scrutation) le recalculent sans redémarrer l'app, et un changement de permission
  suffit. Le badge est un bouton (clic, ou Espace au focus ; aide « Afficher la
  préparation d'OMP Console ») qui rouvre la feuille de préparation, bloquante. Si
  OMP disparaît pendant que l'app tourne, seul le badge apparaît : la feuille
  bloquante s'impose à son clic, ou d'elle-même au lancement suivant.
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
  servent). Sous une racine jetable SEULEMENT,
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

- **Session `omp` en terminal** sur un dépôt : `/mem0-status` dit le service
  joignable, `mem0_search` rend des souvenirs repris de l'ancienne mémoire, et un
  souvenir écrit par `mem0_add` est relu ensuite (par `mem0_search`, ou dans la
  Mémoire de l'app).

### Preuves manuelles (AC-3, AC-5, AC-10)

- **AC-3 — l'app n'utilise aucun binaire système** : renommez l'`omp` du système
  (`mv ~/.bun/bin/omp ~/.bun/bin/omp.bak` — sans toucher à la racine de l'app),
  ouvrez l'app : la préparation trouve le composant de l'app
  (`…/com.omp.console/components/omp/18.6.0/omp`) et ne réclame rien. Le renommage
  est réversible, et la suppression du composant seul provoque la réinstallation par
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
feuille « OMP est requis » n'existe plus (la préparation la remplace).

- **`OMP_CONSOLE_OMP_BINARY`** (échappatoire de test) — posée et non vide, c'est le
  SEUL candidat ; utile aux recettes pour pointer un `omp` de secours ou simuler un
  poste sans composant.
- Si le composant est absent ou non exécutable au lancement, la feuille de
  préparation bloquante s'impose : « Installer » le télécharge, « Réessayer »
  relit sa présence, « Quitter » quitte l'app.

## Harnais réel

Les preuves qui lancent un vrai `omp` sont les **recettes gatées** : session
composant et run terminal (`MEM0_SESSION_COMPONENT_RECIPE`, voir « Composants de
l'app »). Chacune est **désactivée par défaut** — aucun script du dépôt
(`scripts/swift-app.sh`, `bash scripts/check.sh`, `.github/workflows/`) ne pose sa
variable — donc la suite reste verte et aucun octet n'est envoyé à un modèle.

Une recette posée sans son prérequis **échoue explicitement**, jamais en faux
succès ni en skip silencieux : la variable est une demande d'exécution réelle, pas
un filtre.

## Consulter et corriger la mémoire du projet

L'entrée **Mémoire** (⌘5) lit la mémoire du service mémoire (mem0-rs) et l'écrit : la **liste**
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

**Le service.** L'adresse vient de `MEM0_HTTP_URL`, sinon de `~/.omp/mem0.json`
(`{ "url", "token" }`, le fichier que lit aussi le plugin mémoire), sinon du service
de l'app (`http://localhost:8321`). Le jeton vient de `MEM0_HTTP_TOKEN`, sinon du
fichier quand l'adresse en vient aussi (vide par défaut, envoyé en en-tête
`X-Mem0-Token` seulement s'il est non vide). Une adresse hors de ce Mac (la mémoire
partagée du serveur de pipelines) est acceptée sans le jeton d'installation, et la
sonde oMLX de ce Mac ne s'y applique pas : ses vecteurs sont calculés sur le serveur. La
préparation n'y démarre pas l'agent mem0-rs de l'app : elle le décharge et retire son
plist (`MemoryAgent.ensureStopped`), la base locale restant sur le disque. Le bundle porte
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
un projet…** (`memory.chooseProject` : un menu des derniers projets choisis,
`projects.recent`, puis « Choisir un dossier… ») et n'émet aucun appel de portée —
le GRAPHE, lui, n'en dépend pas : il montre toutes les portées du service.

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

## Vocabulaire et typographie

Les textes visibles des fichiers `*Text.swift` (ConsoleCore, ConsoleClient, coque
Mac, coque iOS) suivent [`GLOSSAIRE.md`](GLOSSAIRE.md) : un seul terme français par
notion, sauf les termes conservés (« pipeline », « feature », « PR », /req, /specs,
/impl, /review, noms propres), et la typographie française (’, espace insécable
avant ; : ! ? et dans « », …). La garde
`test/console/typographie-et-glossaire-francais.test.ts` le vérifie.

Les deux apps parlent **français**, leur langue de développement, et **anglais**
sur un appareil (ou une langue d'app choisie dans les Réglages) réglé en anglais
(feature `localisation-apps`). Chaque texte d'un `*Text.swift` passe par `L10n`
(`Sources/ConsoleCore/Design/L10n.swift`) : `L10n.text("Tous les projets")`, ou
`L10n.format("Résultats pour « %@ »", query)` pour une phrase à trous (`%@` texte,
`%lld` entier). La clé est la phrase française ; sa traduction vit dans UNE table,
`Sources/ConsoleCore/Resources/en.lproj/Localizable.strings`, ressource de
`ConsoleCore` embarquée par les deux apps (le français n'a pas de table : une clé
se rend telle quelle). Ajouter un texte, c'est écrire sa phrase française derrière
`L10n` et sa ligne anglaise dans la table : la garde
`test/console/localisation-apps.test.ts` rougit sur une clé sans traduction, une
entrée orpheline, un trou perdu ou un texte visible laissé hors de `L10n`.

La langue est décidée une fois par processus : celle que retient le bundle
principal (`preferredLocalizations`) s'il se déclare localisé
(`CFBundleLocalizations` = fr, en dans `Bundle/Info.plist`, le plist de l'app iOS
et celui du widget), le français sinon — un lanceur de tests ne se déclare pas
localisé, et les suites Swift, qui figent des phrases françaises, tournent donc en
français sur toute machine (`scripts/ios-build.sh` passe aussi `-testLanguage fr`).
Durées, dates et nombres suivent la langue (`ConsoleFormat.locale` : `fr_FR` en
français, la locale anglaise de l'appareil ou `en_US` en anglais). Restent en
français à dessein : les phrases Siri et les titres des App Intents (littéraux
extraits au build, figés par `scripts/app-intents/attendus.json`), le détail
technique des diagnostics copiables (joint tel quel à un signalement), les
identifiants d'accessibilité `ios.…` et les noms de commande (/req, /specs…).

## Structure du paquet

```
omp-console/
├── Package.swift                  manifeste SwiftPM (cible macOS 26)
├── Sources/OMPConsole/            la coque macOS
│   ├── OMPConsoleApp.swift        la scène, les modèles à l'échelle de l'app, les menus (écrans ⌘1…⌘6, Actualiser ⌘R, Appairage…, Quitter)
│   ├── ConsoleRootView.swift      la racine : l'OS, les feuilles Préparation et Serveur, les gestes, les liens et notifications
│   ├── OmpBinary.swift            le binaire `omp` du composant de l'app, sa présence (`OmpPresenceModel`)
│   ├── ProcessRunner.swift        l'exécuteur partagé (échéance, SIGTERM puis SIGKILL)
│   ├── ProjectRoot.swift          le projet choisi de l'app (`session.projectRoot`)
│   ├── OS/                        la coque de l'OS agentique
│   │   ├── OSRootView.swift       Radar, liste des fils, centre, « Comprendre », palette, ⌘R ; le routage `OSMacRoute`
│   │   ├── OSSystemScreens.swift  le hub Système et ses écrans (Poste, Dépôts, Planifications, Autonomie, Vigie, Statistiques, Issues, Administration)
│   │   └── OSMemoryScreen.swift   l'écran Mémoire
│   ├── Server/                    ce qui ne sert qu'au Mac du serveur de pipelines
│   │   ├── HarnessSessionView.swift   le direct d'une session (Brut de « Comprendre », feuille des audits et des jobs du poste)
│   │   ├── HarnessMonitoringViews.swift fichiers et différences, tests en direct, frise, alertes, statistiques du monitoring
│   │   ├── HarnessStatsCharts.swift   les graphiques de Système › Statistiques et santé
│   │   ├── ServerBrowserViews.swift   le navigateur du serveur (Poste, approbateur)
│   │   ├── ProvidersView.swift    fournisseurs et modèles (feuille Serveur, admin)
│   │   └── ServerSheet.swift      la feuille « Serveur » (adresse, jeton, oubli, appairage)
│   ├── Memory/                    la Mémoire (liste, recherche, graphe, liens)
│   ├── ProjectChooser/            le choix du projet de la Mémoire
│   ├── Git/                       la racine du dépôt principal (portée de la Mémoire)
│   ├── Setup/                     la préparation : composants, migration, service mémoire
│   ├── Stack/                     le service mémoire (agent launchd), oMLX, ancienne pile
│   ├── Quit/                      la sortie de l'app (`QuitFlow`)
│   ├── Intents/                   l'App Intent « Ouvre OMP Console »
│   ├── MenuBar/                   l'ordre des séparateurs du menu principal
│   └── Design/                    surfaces, Markdown, coloration du code, diagnostic copiable, fenêtre principale
├── Sources/ConsoleClient/         la cible partagée macOS/iOS des clients distants
│   ├── HarnessModel.swift         le client du serveur de pipelines du VPS
│   ├── HarnessPairing.swift       le code d'appairage `omp1:…` et `~/.omp/harness.json`
│   ├── HarnessPairLink.swift      l'appairage par QR code : le lien `ompconsole://pair`, le ticket, son échange sans jeton
│   ├── MemoryReader.swift         la lecture directe de la mémoire du serveur (iOS)
│   ├── MemoryAccess.swift         l'adresse, le jeton et le projet lu de cette mémoire
│   ├── HarnessWire.swift          le contrat JSON du serveur de pipelines
│   ├── HarnessTransport.swift     le transport https et le lecteur SSE du serveur
│   ├── HarnessSession.swift       le direct de la session d'une feature ou d'un audit (entrées, pages, événements)
│   ├── HarnessMonitoring.swift    le contrat du monitoring (coût, alertes, frise, fichiers, tests, santé, modèles)
│   ├── HarnessLiveActivity.swift  l'état d'une Live Activity, la forme exacte que pousse le serveur, et le choix de celle qui démarre seule
│   ├── WorkstationWire.swift      le contrat JSON du poste de travail (`/v1/workstation*`)
│   ├── WorkstationModel.swift     le client du poste de travail, porté par `HarnessModel` (même transport, même flux)
│   ├── HarnessNotifications.swift les notifications : charge du serveur, catégories, routage d'une action vers un geste
│   ├── HarnessNotificationCenter.swift  le pont vers UserNotifications (permission, actions, notifications locales du Mac)
│   └── HarnessDrafts.swift        les brouillons de lancement et de geste
├── Sources/ConsoleUI/             les écrans partagés macOS/iOS (OS agentique, hub Système, Poste, Dépôts, palette)
├── Sources/ConsoleCore/           la cible partagée macOS/iOS, sans dépendance
│   ├── Design/                    sections, vocabulaire, mots du serveur de pipelines, du monitoring et du poste de travail
│   ├── Memory/                    la lecture des réponses de la mémoire et le noyau du graphe
│   ├── Files/MarkdownDocument.swift  le rendu Markdown en blocs
│   ├── Setup/SetupText.swift      les mots de la préparation
│   ├── Support/                   JSON, chemins, URL
│   └── Resources/en.lproj/Localizable.strings  la table anglaise des textes des deux apps (`L10n`)
├── Tests/OMPConsoleTests/         la suite Swift Testing de la coque
├── Tests/ConsoleClientTests/      la suite hermétique des clients distants
├── ios/                           l'app iOS/iPadOS et son extension de widgets (voir « Coque iOS »)
├── Bundle/Info.plist              le plist du bundle .app (et `Bundle/AppIcon.icns`, `Bundle/en.lproj/InfoPlist.strings`)
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

`omp-console/ios/OMPConsoleIOS.xcodeproj` est l'app iOS de la salle de contrôle : l'« OS
agentique » (`IOSOSRootView.swift`), la même interface que celle du Mac (voir « OS
agentique : l'interface »), sur une barre d'onglets native (`TabView`, style
`.sidebarAdaptable` — en bas sur iPhone, en haut ou en barre latérale sur iPad) de cinq
onglets.

- **Maintenant** : le Radar en tête (les agents, le coût du jour, « Tout suspendre » et
  « Reprendre »), puis le brief, les trois chiffres et les agents au travail.
- **Fils** : le composeur « Demander à l'OS… », l'espace et le lieu, puis les fils par
  sections. Toucher un fil pousse sa page dans la pile ; l'appui long ouvre « Comprendre »
  et les gestes de sa feature, dont « Suivre sur l'écran verrouillé »
  (`IOSLiveActivities.swift`, extension `OMPConsoleWidgets`).
- **Décisions** (pastille : ce qui attend l'humain) : le tri, une décision à la fois,
  les décisions de même sorte en lot.
- **Propositions** (pastille) : lancer ou écarter ce que les agents et les collègues
  proposent ; l'onglet n'existe pas sur un serveur qui n'en sert pas.
- **Savoir** : consignes permanentes, paliers d'autonomie, espaces et leur page, puis
  Automatismes et Mémoire.

La **roue** en tête de la barre de chaque onglet (`ios.os.system`) pousse le hub
**Système** dans la pile de l'onglet : la grille de tuiles partagée avec le Mac
(`OSSystemHub`), chaque tuile avec son état en pastille. Une tuile pousse sa page
(`IOSSystemScreens.swift`) : Poste, Dépôts, Planifications, Autonomie, Vigie,
Statistiques, Issues, Administration ; Serveur ouvre la feuille du serveur. Dépôts et
Administration ne se montrent qu'à un administrateur.

« Comprendre » est un inspecteur (une colonne sur iPad, une feuille sur iPhone) ; chaque
barre porte « Demander à l'OS » (`ios.os.ask`), qui ouvre la feuille de la Demande ;
chaque écran se tire pour actualiser (⌘R au clavier). Aucun bouton « Serveur » ni
« Actualiser » dans les barres : la feuille du serveur s'ouvre par Système › Serveur, ou
par « Relier le serveur » (`ios.server.configure`) sans serveur relié. Les liens
`ompconsole://now`, `decisions`, `threads/<id>` et `system/<page>` et une notification
touchée ouvrent leur écran. Sur un serveur qui n'annonce aucune capacité de l'OS, fils,
décisions et composeur passent par les routes d'avant, et ce que le serveur ne sert pas
n'apparaît pas. La logique de la coque est pure (`IOSOSNavigation.swift`, testée par
`IOSOSShellTests`) ; identifiants : `ios.os.tab.<onglet>`, `ios.os.screen.<onglet>`,
`ios.os.screen.thread`, `ios.os.screen.system`, `ios.os.system.<page>`,
`ios.os.understand`, `ios.os.ask`.

L'app est autonome : elle ne parle qu'au serveur du VPS, jamais à un Mac, et n'a
aucun magasin local. Un seul geste la relie : coller le **code d'appairage**
(`omp1:…`, affiché par `harness.sh up` ou `harness.sh pair` sur le VPS) dans la
feuille « Serveur » (`IOSServerSheet`, `ios.server.sheet`). Pour approuver
les envois du poste depuis l'iPhone, c'est le **code approbateur** (`harness.sh
approver`) qu'on y colle, son jeton restant au trousseau (voir « Serveur de
pipelines »). Le code porte deux accès :

- **Le serveur de pipelines** pour les onglets et les pages du Système : les mêmes
  écrans partagés que sur le Mac (`ConsoleUI`), sur le même `HarnessModel` (voir
  « Serveur de pipelines »). Le direct d'une feature se lit dans « Comprendre » ; la
  feuille de session (`IOSSessionSheet.swift`) sert aux audits et aux jobs du poste.
- **La mémoire du serveur** pour la Mémoire (`MemoryAccess`, `MemoryReader`
  dans `ConsoleClient`) : son adresse va aux préférences, son jeton au trousseau.
  Sans elle, la Mémoire affiche « Mémoire non reliée » et « Relier le serveur », qui
  ouvre la même feuille.

Sa recette de design — surfaces, échelle typographique, marges, tons, politique
du verre, états vide et erreur, Dynamic Type — vit dans
`omp-console/ios/DESIGN.md`. Chaque règle y porte un marqueur `[test: …]`,
`[capture: …]` ou `[garde: design-ios/AC-<n>]` : aucune prose non jugeable.

**Largeur de lecture sur iPad.** Quand la fenêtre est large (iPad barre latérale
masquée, iPhone Pro Max en paysage), les pages en liste posent leur contenu dans une
colonne centrée de 720 pt marges comprises (`IOSMetrics.readableWidth`), mise à
l'échelle par Dynamic Type (`iosReadableWidth()`) ; le reste de la fenêtre forme deux
marges égales. Le défilement garde toute la largeur. Sous ce plafond (iPhone en
portrait, iPad barre latérale visible en portrait), rien ne change.

### Pannes de la mémoire

Toute panne de lecture de la mémoire du serveur — liste, recherche, graphe — passe
par UN seul traducteur, `IOSMemoryErrorText`
(`omp-console/ios/OMPConsoleIOS/IOSMemoryErrorText.swift`). Il range la panne en
causes distinguables et affiche la cause puis un remède, sans URL, sans adresse,
sans JSON brut et sans code HTTP : « mémoire du serveur injoignable », « délai
dépassé », « mémoire indisponible sur le serveur » (503), « jeton refusé » (401,
403 : recoller le code d'appairage), et le message générique. Le mode Graphe ajoute
« serveur mémoire trop ancien » (route graphe absente). Chaque échec de chargement
propose « Réessayer » (44 pt). La table cause → message est dans
`omp-console/ios/DESIGN.md` (« Pannes de la mémoire »). Les écrans du serveur de
pipelines ont leur propre table, `HarnessFailureText` (`ConsoleClient`).

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

Le script cherche d'abord un simulateur iOS ≥ 26. S'il en trouve un, il le
démarre en arrière-plan et lance un seul `xcodebuild test`, qui compile l'app et
exécute la suite Swift Testing de la cible `OMPConsoleIOSTests` ; sans simulateur,
ou avec `--no-tests`, il compile seulement, en destination générique. Dans tous
les cas, le script contrôle ensuite
`OMPConsoleIOS.app/Metadata.appintents/extract.actionsdata` de l'app produite
contre la même liste que le bundle Mac (voir *Liste attendue des intents Siri*) ;
s'il manque :
`  ✗ Metadata.appintents absent de l'app iOS : omp-console/.build-ios/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app/Metadata.appintents/extract.actionsdata manque (l'extraction App Intents n'a rien produit)`,
et s'il s'en écarte :
`  ✗ Metadata.appintents de l'app iOS non conforme à scripts/app-intents/attendus.json`,
tous deux en code 1. Codes de sortie : `0` compilé (et testé, sauf `--no-tests`
ou sans simulateur — la ligne `· tests non exécutés : …` le dit), `1` échec,
`2` « non exécuté » (hors macOS, Xcode inutilisable).

L'icône de l'app iOS vient du catalogue `OMPConsoleIOS/Assets.xcassets`
(`AppIcon`, variantes claire, sombre et teintée) ; elle est dessinée avec celle du
Mac par `bash scripts/app-icon.sh` (voir « Assembler le bundle `.app` »), jamais
à la main dans Xcode. Le même catalogue porte l'`AccentColor`, égale au bleu
système. Les règles d'identité de l'app sont dans `omp-console/ios/DESIGN.md`.

### Captures des cinq onglets

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer ./scripts/recette/ios-shots.sh
```

Le script démarre un simulateur iPhone et un iPad, installe l'app, puis l'ouvre
sur chacun des cinq onglets (`now`, `threads`, `decisions`, `proposals`, `knowledge`)
par `-os.view` et capture l'écran : **40 PNG** dans `omp-console/build/ios-shots/`
(dossier ignoré par git — les images sont des artefacts de PR, jamais committées) —
cinq onglets × {iPhone portrait, iPad portrait} × {clair, sombre} à taille de texte
par défaut, plus cinq onglets × {iPhone, iPad} × {clair, sombre} en Dynamic Type
maximum (suffixe `-ax`). Un SECOND groupe capture le **mode graphe de la Mémoire** via
`-memoire.recipe` : le graphe rendu, un état après pan/zoom et une fiche ouverte —
3 états × {iPhone, iPad} × {clair, sombre} = **12 PNG**, soit **52** en tout. Chaque
capture est sondée en dimensions (`sips -g pixelWidth -g pixelHeight`) : toutes
PORTRAIT — une capture inattendue ferait échouer le script. Les onglets sont capturés
serveur non relié ; les écrans reliés sont ceux de `os-ios-shots.sh`.

Il n'y a AUCUNE ligne « iPad paysage », pour une raison mesurée le 2026-10-06 sur
le poste de référence : `simctl` n'a aucune sous-commande de rotation,
`Simulator.app` n'y est pas installé, et en mode fenêtré iPadOS refuse
`UIWindowScene.requestGeometryUpdate` (« The current windowing mode does not
allow for programmatic changes to interface orientation. ») ; l'opt-out
`UIRequiresFullScreen` rendrait la demande possible mais coûterait le Split View
et le Slide Over — un choix produit, pas un outil de capture. L'app DÉCLARE
portrait et les deux paysages : elle reste utilisable en paysage sur un vrai
iPad, à vérifier à la main sur l'appareil.

Les crochets de recette se posent en argument de lancement (`IOSShellLaunch`) :
`-os.view <now|threads|decisions|proposals|knowledge>` ouvre un onglet,
`-os.thread <fil ou feature>` et `-os.space <identifiant ou nom>` un fil ou un espace
dès qu'ils sont connus, `-os.system <page>` une page du Système (`workstation`,
`repos`, `schedules`, `autonomy`, `vigie`, `stats`, `issues`, `admin`) par-dessus le
hub. `-ios.state error` affiche le bandeau d'erreur de recette sur la Mémoire, et
`-memoire.recipe <graphe|zoom|fiche>` force le mode graphe de la Mémoire sur la
fixture partagée `MemoryGraphParity` ; ces deux crochets ouvrent la Mémoire dans le
Savoir. `liste` charge la même fixture mais reste en mode LISTE et y ouvre la fiche
d'un souvenir ; `clavier` garde le mode Liste sans fiche et branche l'écran sur un
lecteur de cette même fixture, `IOSMemoryRecipeReader`, client `.connected` sans
réseau : le sommaire montre ses huit souvenirs, la recherche les filtre, et chaque
lecture du sommaire écrit `memoire-recipe-read` sur la sortie d'erreur du lancement ;
`injoignable` et `service-ancien` branchent la liste et le graphe sur un lecteur qui
échoue toujours, `IOSMemoryFailureReader` : `injoignable` reste en mode Liste sur le
bandeau « Mac injoignable. », `service-ancien` ouvre le graphe sur le bandeau
« Graphe indisponible : serveur mémoire trop ancien sur le Mac. », et chacun écrit
`memoire-recipe-ready` une fois l'échec affiché. Ce sont des crochets de recette, pas
des fonctionnalités.

Pour ouvrir une page précise sur un simulateur déjà démarré :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -os.system stats
```

La capture de l'état d'erreur (artefact de PR, hors des 52) :

```bash
xcrun simctl launch --terminate-running-process <UDID> com.omp.console.ios -ios.state error
xcrun simctl io <UDID> screenshot omp-console/build/ios-shots/error-memory.png
```

### Captures de la nouvelle interface (iOS)

```bash
bash scripts/recette/os-ios-shots.sh
```

Le script compile l'app, démarre `scripts/recette/os-demo-serveur.ts` (le serveur de
démonstration des captures du Mac), puis relance l'app une fois par écran sur un iPhone
et un iPad, reliée à ce serveur par ses arguments de lancement
(`-os.server <adresse> -os.token <jeton>` : rien n'est enregistré dans le simulateur,
l'invite de notification n'est pas posée). Seize images sous
`omp-console/build/os-ios-shots/` (dossier ignoré par git), `iphone-` et `ipad-` :
`maintenant`, `fils`, `decisions`, `propositions`, `savoir`, `fil-au-travail`,
`fil-revue`, `espace`. Codes de sortie : 0 les seize images produites, 1 échec, 2 non
exécuté (pas macOS, Xcode ou Node inutilisable, aucun runtime iOS ≥ 26).

### Recette historique

`scripts/recette/ios-connexion-recette.sh` a été écrite pour l'ancienne coque (la liste
racine `ios.section.*`) : ses crochets n'existent plus, elle ne se rejoue pas telle
quelle. Ni `check.sh` ni la CI ne la lancent.

### Recette idb : cibles, identifiants et bords

`scripts/recette/ios-recette-ui.sh` relève 5 surfaces de l'app iOS sur un simulateur
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

**Matrice.** 5 surfaces × 3 configurations = **15 relevés** : quatre onglets (`now`,
`threads`, `decisions`, `knowledge`, ouverts par `-os.view`) et la Mémoire (`memory`),
en clair à la taille par défaut, en sombre à la taille par défaut, puis en clair en
AX-XL (`accessibility-extra-large`). La Mémoire est alimentée par son crochet de recette
(`-memoire.recipe`, qui l'ouvre dans le Savoir), sans appairage ; les onglets sont
relevés serveur non relié (Fils doit montrer `ios.server.configure`, sinon la recette
refuse un simulateur relié). Propositions n'est pas relevé : l'onglet n'existe pas sans
serveur qui en sert.
Un relevé n'est accepté que si deux
lectures consécutives de l'arbre sont identiques **et** que la surface est
reconnue par son marqueur d'accessibilité
(`scripts/recette/ios-recette-ui-analyse.py marqueur`) : jamais un écran
déconnecté ou un autre onglet. L'ordre des clés du JSON d'idb et celui
de la liste `traits` d'un élément changent d'une lecture à l'autre ; la
comparaison porte donc sur le JSON décodé, `traits` pris comme un ensemble.

**Sortie.** `omp-console/build/ios-recette-ui/base/` (ignoré par git, vidé à chaque
passage) : `<surface>-<apparence>-<taille>.json` (arbre AX) et `.png` (capture sans
masque de coins) pour chacun des 15 relevés, `logs/` (journaux `--stderr` de l'app,
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
différente du fond sur 44 pt ou plus, écrans seulement, jamais la feuille). La
désignation d'un élément est `id:<AXUniqueId>`, sinon `libellé:<AXLabel>`, sinon
`type:<type>`. Sans signalement, le fichier est vide. La sortie standard donne le
chemin du rapport, `<N> signalé(s), <M> excepté(s)` et un avertissement `exception
inutilisée : <n>` par entrée qui n'excepte rien.

**Codes de sortie.** `0` : 15 relevés faits et aucun `SIGNALÉ` ; `1` : au moins un
`SIGNALÉ` ; `2` : la recette n'a pas pu conclure (prérequis, exceptions invalides,
relevé non vérifié, construction ou installation impossible).

**Exceptions.** `scripts/recette/ios-recette-ui-exceptions.json` (versionné)
est un tableau d'objets aux clés exactes `surface` (une des 5 clés ou `*`),
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

Sans Xcode, chaque release GitHub du dépôt porte `OMP-Console-iOS.ipa`, construite
en Release. Quand le dépôt a ses secrets de signature iOS, elle est signée et
s'installe directement sur les appareils inscrits dans ses profils ; sinon elle est
**non signée** et s'installe après re-signature avec ton compte Apple (Sideloadly,
AltStore). Le détail : `PUBLISHING.md` § Apps jointes aux releases. Avec Xcode :

1. Brancher l'**appareil** à ce Mac et l'activer (sur l'appareil : *Réglages ▸
   Confidentialité et sécurité ▸ **Mode développeur***, puis redémarrer).
2. Dans Xcode, choisir la cible `OMPConsoleIOS` et l'appareil dans le sélecteur de
   destination.
3. Ouvrir l'onglet *Signing & Capabilities* de la cible, cocher *Automatically
   manage signing*, puis choisir son **compte** (Team) — un compte du programme
   développeur : l'app déclare un groupe d'apps (widget) et les notifications push
   (Live Activities et alertes), que Xcode enregistre seul. Faire de même pour la cible
   `OMPConsoleWidgets`. Si l'identifiant de bundle du dépôt (`com.omp.console.ios`)
   est déjà pris, en choisir un **unique**, pour les deux cibles
   (`<id>` et `<id>.widgets`), et changer `OMP_APP_GROUP` du projet en
   `group.<id>`.
4. Lancer (⌘R). L'app s'installe et démarre.
5. À la première exécution, approuver le certificat de développement sur
   l'appareil : *Réglages ▸ Général ▸ VPN et gestion de l'appareil*.
6. Relancer l'app — elle s'ouvre alors normalement.

### Siri : statut de la connexion

L'app iOS déclare un App Intent en lecture seule, **Statut de la connexion**
(`IOSConnectionStatusIntent`, `ios/OMPConsoleIOS/IOSSiriText.swift`), et un App
Shortcut qui le rend atteignable par la voix et depuis l'app Raccourcis. L'intent
n'écrit rien : il lit le serveur de pipelines UNIQUE de l'app (`OMPConsoleIOSApp` le
crée et l'enregistre pour les intents par `IOSSharedServer`), relit sa boîte, puis
énonce « Aucun serveur relié », « Serveur relié, injoignable » ou « Relié au
serveur, N en attente » (`IOSSiriStatus`).

### Siri : la télécommande

Quatre autres App Intents du même fichier, chacun avec son App Shortcut (Siri,
Raccourcis, bouton Action), agissent sur le même serveur sans ouvrir l'app ; tous
exigent l'appareil déverrouillé (le jeton est illisible verrouillé). Ce qu'ils font
et répondent est décidé dans `ios/OMPConsoleIOS/IOSSiriRemote.swift` :

| Intent | Phrases | Effet |
|---|---|---|
| **Demander à l'OS** (`IOSAskIntent`) | « Demander à OMP Console », « Nouvelle demande dans OMP Console » | Siri demande la phrase, puis la pose comme Demande (`POST /v1/intake`, source `voice`) : « Demande transmise à l'OS ». |
| **Décisions en attente** (`IOSPendingDecisionsIntent`) | « Décisions en attente dans OMP Console », « Décisions de OMP Console » | Lecture : « 2 décisions vous attendent : une question sur « … », la revue de « … » » (trois au plus, le reste compté), ou « Rien ne vous attend ». |
| **Tout suspendre** (`IOSSuspendAllIntent`) | « Tout suspendre dans OMP Console », « Suspendre OMP Console » | Lit la pause (`GET /v1/pause`), demande confirmation, puis la pose (`POST /v1/pause`) : « Tout est suspendu ». L'étape en cours de chaque agent finit. |
| **Reprendre** (`IOSResumeAllIntent`) | « Reprendre OMP Console », « Reprendre le travail dans OMP Console » | Lève la pause : « Le travail reprend ». |

Un serveur antérieur à la pause répond « Ce serveur ne propose pas la pause » ; un
jeton qui n'y a pas droit, le motif du serveur. `OMPRunValidateIntent` (le bouton
« Valider » d'une Live Activity) n'a pas de phrase et n'apparaît pas dans Raccourcis.

### Lire la mémoire du serveur depuis l'iPhone

La section **Mémoire** affiche le sommaire d'un projet de la mémoire du serveur —
les mêmes souvenirs que la section Mémoire macOS quand le Mac est relié au même
serveur, dans l'ordre du service —, permet d'ouvrir un souvenir et de chercher
(la recherche est celle de l'outil `mem0_search` : pool sur-échantillonné, seuil et
tri par cosinus brut), et dit chaque panne par sa cause et son remède. Le menu
« Choisir le projet » liste les portées de la mémoire, la plus récemment écrite en
tête ; sans choix, c'est elle qui est lue, et le choix est gardé. La liste se lit par
pages de 100 souvenirs, en défilement continu. Un SECOND mode, le **graphe**,
s'ajoute derrière la bascule « Graphe ⇄ Liste » : il est dérivé sur l'iPhone par le
MÊME noyau que la fenêtre macOS (`MemoryGraph`, nœuds-souvenirs, nœuds-étiquettes,
arêtes de proximité) — les liens manuels restent sur le Mac qui les a tracés —,
manipulable au doigt (pincer, glisser, toucher) ; toucher un souvenir ouvre sa fiche
en lecture seule, toucher un nœud-étiquette applique son filtre. Le graphe et la fiche
n'émettent AUCUNE écriture ; seule la liste corrige ou supprime un souvenir (menu de la
rangée, `MemoryWriter`, suppression confirmée), et rien ne se rafraîchit en continu.

Recette pas à pas :

1. Sur le VPS, `harness.sh pair` ; dans l'app, feuille « Serveur », coller le code
   `omp1:…` puis « Relier ». Attendu : Fils et Décisions se remplissent, et la Mémoire
   (Savoir) affiche l'en-tête « N souvenirs » puis la première page du projet le plus
   récent.
2. Toucher un souvenir. Attendu : sa fiche, texte intégral tel qu'il est stocké,
   identifiant et portée sous « Détails techniques », aucun bouton d'écriture.
3. « Choisir le projet », puis un autre projet. Attendu : la liste (et le graphe
   s'il est affiché) relit cette portée ; relancer l'app garde ce choix.
4. Chercher un terme. Attendu : les souvenirs au-dessus du seuil, ou l'un des trois
   « rien trouvé » distincts ; vider le champ revient au sommaire sans requête.
5. Couper le serveur (`harness.sh down`), tirer pour actualiser. Attendu : « Mémoire
   du serveur injoignable. » et son remède, les lignes déjà lues restent, et
   « Réessayer » relit une fois le serveur revenu.

### Clavier de l'iPad

Avec un clavier matériel, l'app pose sept commandes dans la **barre des menus de
l'iPad** (Globe-M, ou glissement depuis le haut ; depuis iPadOS 26 elle remplace
la superposition qu'on obtenait en maintenant ⌘). Chaque commande y affiche son
libellé français et son raccourci :

| Raccourci | Commande | Menu | Effet |
|---|---|---|---|
| ⌘1 … ⌘5 | Maintenant, Fils, Décisions, Propositions, Savoir | Présentation | ouvre l'onglet, dans l'ordre de la barre, à sa racine |
| ⌘R | Actualiser | Présentation | relit les données de l'écran affiché, comme le geste « tirer pour actualiser » |
| ⌘F | Rechercher | Présentation | met le focus dans le champ de recherche de l'écran ; sans champ propre, ouvre la palette en recherche globale |

La palette (⌘K) et « Nouvelle feature » (⌘N) viennent des écrans partagés.

⌘R est inactif hors connexion et pendant une lecture en cours. Sous une feuille,
une alerte ou un `confirmationDialog`, les commandes sont sans effet ; ⎋ et ↩
des feuilles (Annuler, valider) restent inchangés, aucune commande ne les prend.
