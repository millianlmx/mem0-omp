# Recette de design — coque iOS

La recette PROPRE À L'iOS. Elle ne recopie pas les règles macOS : elle les cite
par renvoi, en nommant leur source, puis énonce ce qui est particulier au
tactile. Chaque règle est vérifiable : une puce se termine par au moins un
marqueur `[test: <fonction>]` (une fonction de
`omp-console/ios/OMPConsoleIOSTests/`), `[capture: <motif>]` (un nom produit par
`scripts/ios-shots.sh`) ou `[garde: <slug>/AC-<n>]` (un test Node de
`test/*.test.ts` portant ce titre). Une puce sans marqueur fait échouer la garde.

## Héritage de la coque macOS (par renvoi)

- Le verre (Liquid Glass) est réservé à la couche que le SYSTÈME dessine — barre
  latérale, barre d'onglets, barre de navigation, feuilles ; les contenus restent
  opaques. Règle posée par `omp-console/README.md` §intro et appliquée par
  `omp-console/Sources/OMPConsole/Design/ConsoleSurface.swift`, reprise telle
  quelle par `omp-console/ios/OMPConsoleIOS/Design/IOSSurface.swift` — aucun
  `glassEffect` dans le contenu. `[garde: design-ios/AC-1]`
- Les trois surfaces iOS reprennent les rôles de
  `omp-console/Sources/OMPConsole/Design/ConsoleSurface.swift` (panneau, carte,
  bandeau), avec le rayon du tactile : 12 pt au lieu de 10. `[test: surfacesShareTactileRadius]`
- La pastille d'état reprend `omp-console/Sources/OMPConsole/Design/StatusBadge.swift` :
  un point teinté de 8 pt et le MOT de l'état, sur une capsule teintée à 15 %.
  `[garde: design-ios/AC-2]`
- Les six tons et l'état (`ConsoleTone`, `ConsoleStatus`) viennent de
  `omp-console/Sources/ConsoleCore/Design/ConsoleVocabulary.swift` : le noyau est
  la seule source des tons, l'app n'en déclare aucun. `[test: toneTintsMatchMacOS]`
- Tout libellé durable affiché vient du vocabulaire partagé `ConsoleCore`, mot
  pour mot celui de macOS ; un seul message franchement provisoire vit dans
  `omp-console/ios/OMPConsoleIOS/IOSText.swift`. `[test: emptyStatesUseSharedWords]`

## Navigation (feature `ios-navigation-onglets-adaptables`)

- Sur iPhone, la racine est une barre d'onglets native (`TabView`, style
  `.sidebarAdaptable`) de cinq onglets — Accueil, Pipelines, Sessions, Mémoire,
  « Plus » — et chaque onglet ouvre son écran directement, sans bouton retour.
  `[test: compactTabsAreFourSectionsThenPlus]`
- L'onglet « Plus » est une liste titrée « Plus » qui pousse Projet, Session OMP
  et Statistiques ; leur bouton retour ramène à la liste.
  `[test: plusListsTheThreeOtherSections]`
- Sur iPad, la barre latérale est visible dès le lancement, titrée « OMP Console »,
  avec les groupes Pilotage (Accueil, Pipelines, Projet, Session OMP) puis
  Consultation (Sessions, Mémoire, Statistiques) ; la barre d'onglets du haut
  n'apparaît que lorsqu'on masque la barre latérale. `[test: groupedSections]`
- Chaque onglet garde son état (écran poussé, position de défilement) quand on
  change d'onglet ; passer de l'iPad plein écran à une largeur compacte range
  Projet, Session OMP et Statistiques sous « Plus », et inversement.
  `[test: sizeClassChangeMovesBetweenPlusAndSidebar]`
- `-section <x>` ouvre l'onglet de la section ; sur iPhone, Projet, Session OMP et
  Statistiques s'ouvrent déjà poussés dans « Plus ».
  `[test: launchRoutesEachSectionOnIPhone]`
- Le bouton Connexion (antenne, `connection.open`) figure une seule fois dans la
  barre de chaque écran : les quatre onglets, la liste « Plus », les écrans
  qu'elle pousse et les sept sections de l'iPad. `[capture: iphone-*-light]`

## Surfaces (S-1)

- Les surfaces de contenu sont celles de `Design/IOSSurface.swift`, et rien
  d'autre : `iosGroupedList()` pour la liste d'un écran, `iosBareListRow()` pour
  la rangée qui porte sa propre surface, `iosCard()` pour une carte,
  `iosBanner(tone:)` pour un bandeau, `iosPanel()` pour le panneau d'une surface
  hors liste. `[garde: design-ios/AC-1]`
- Un écran en liste — Accueil, Pipelines en largeur compacte, Sessions, Mémoire
  (mode Liste), Projet, Statistiques — est une `List` de style `.insetGrouped`,
  posée par `iosGroupedList()` : fond `systemGroupedBackground` jusqu'aux bords
  de l'écran, rangées en `secondarySystemGroupedBackground`, en-têtes de section
  et séparateurs du système, aucun `Divider()` tracé à la main, aucun panneau
  autour des groupes. `[capture: iphone-*-dark]`
- Une feuille ouverte depuis ces écrans est un `Form` groupé
  (`.formStyle(.grouped)`) : sections et en-têtes natifs, sans panneau ni carte
  imbriqués. `[capture: iphone-pipelines-fiche-*]`
- Une carte n'existe que là où le contenu est une carte : le bloc « À vous » de
  l'Accueil et les voies du kanban iPad. C'est la carte élevée,
  `iosCard(raised: true)` : fond `secondarySystemGroupedBackground`, distinct du
  fond groupé de l'écran (`systemGroupedBackground`) en clair comme en sombre.
  `[test: raisedCardStandsOutOfTheGroupedBackground]` `[capture: ipad-kanban-dark]`
- Dans une liste, une carte élevée, un bandeau ou l'état de connexion en bandeau
  occupent une rangée nue, `iosBareListRow()` : sans fond ni séparateur du
  système, sans marge latérale, 8 pt entre deux rangées nues consécutives.
  `[capture: iphone-home-dark]`
- `iosPanel()` est réservé aux surfaces hors liste : Session OMP, mode Graphe de
  la Mémoire, feuilles Contrat et Bienvenue, écran générique.
  `[capture: iphone-session-light]`
- Le panneau porte sa MARGE EXTÉRIEURE : `IOSMetrics.margin` (16 pt compact, 24 pt
  régulier), fixe — c'est la marge de l'écran, le rembourrage intérieur seul suit
  Dynamic Type. Aucun panneau ne touche un bord de l'écran, et aucun appelant
  n'ajoute la sienne. `[capture: iphone-*-light]`
- Un seul défilement par écran : la `List` de l'écran (Pipelines compact,
  Sessions, Mémoire Liste, Projet, Statistiques, Accueil) ; le kanban iPad garde
  son défilement vertical et horizontal ; le mode Graphe de la Mémoire, hors de
  tout défilement, garde les gestes de son canevas. `[capture: iphone-kanban-light]`
- Un bandeau est une surface de CONTENU : teinte du ton à 12 % d'opacité, rayon
  12, jamais un fond rouge plein écran. `[test: errorStateBannersAllSeven]`
- La pastille porte l'identifiant d'accessibilité `ios.status` et combine ses
  enfants (le mot se lit, la couleur le double). `[garde: design-ios/AC-2]`
- Aucune couleur hors `ConsoleTone` : pas de teinte maison, pas de thème
  clair/sombre maison (le système s'en charge). `[garde: design-ios/AC-1]`

## Échelle typographique (rôle → style)

- Le titre d'un écran est celui de la barre de navigation (`.navigationTitle`),
  jamais répété dans le contenu ; mot d'état vide `.headline`, détail `.callout`,
  pastille `.caption.weight(.medium)`, icône SF `.title3` — des styles
  sémantiques, qui suivent Dynamic Type. `[garde: design-ios/AC-7]`
- Aucune taille de police en points : `.system(size:)` est interdit dans les
  sources de l'app. `[garde: design-ios/AC-7]`
- Aucun `lineLimit` numérique : les textes se replient sur plusieurs lignes.
  Deux exceptions : le texte d'un souvenir dans la liste de la Mémoire, plafonné
  par la fonction nommée `IOSMetrics.memoryRowLines(_:)` (texte intégral dans la
  feuille), et la PLAGE de hauteur d'un champ de saisie vertical
  (`IOSMetrics.needLines`, 3…8 lignes du champ « Besoin ») — rien n'y est
  tronqué, le champ défile. `[garde: design-ios/AC-7]`
- Toute durée (`ConsoleFormat.duration`) s'affiche en chiffres à chasse fixe
  (`.monospacedDigit()`) : Accueil « En cours », carte et fiche Pipelines,
  valeurs des Statistiques. `[garde: ios-finitions-composants/AC-6]`

## Marges et cibles tactiles

- Marge horizontale de 16 pt en largeur compacte, 24 pt en largeur régulière
  (ou inconnue) : `IOSMetrics.margin(_:)` en est l'unique règle.
  `[test: marginFollowsSizeClass]`
- Colonne de lecture : sur une fenêtre large, Accueil, Sessions, Mémoire (mode
  Liste), Projet, Statistiques et Session OMP posent leur contenu dans une
  colonne de 720 pt marges comprises (`IOSMetrics.readableWidth`, surface de
  672 pt), centrée, mise à l'échelle par Dynamic Type (`iosReadableWidth()`) ;
  sous ce plafond, rien ne change. Pipelines et le mode Graphe restent pleine
  largeur. `[test: readableWidthKeepsTheColumnUnder700]`
- Les marges et les rembourrages des surfaces grandissent avec Dynamic Type
  (`@ScaledMetric`), jamais une constante figée seule. `[capture: iphone-*-light-ax]`
- Cible tactile minimale : 44 pt (`IOSMetrics.minimumTarget`), la valeur du HIG
  iOS/iPadOS. Un bouton texte sans style (« Tout afficher », « Lire le
  contrat », « Piloter un projet… ») porte cette cible sur son libellé —
  `.frame(minWidth:minHeight: IOSMetrics.minimumTarget)` puis
  `.contentShape(Rectangle())`, style automatique conservé.
  `[test: minimumTargetIsFortyFour]`
- Aucun contrôle maison : ni `Button`, ni `onTapGesture` dans les sources de
  l'app — les seules cibles sont les lignes de `List` et la barre de navigation
  du système. `[garde: design-ios/AC-8]`
- Clavier de l'iPad : ⌘1…⌘7 ouvrent les sections dans l'ordre affiché par la
  barre latérale (Accueil, Pipelines, Projet, Session OMP, Sessions, Mémoire,
  Statistiques), ⌘R rafraîchit l'écran courant, ⌘N bascule sur Pipelines et
  ouvre « Nouvelle feature… », ⌘F active la recherche de l'écran qui en a une.
  Les dix commandes vivent dans la barre des menus de l'iPad (menus
  Présentation et Fichier) avec leur libellé français, toutes avec ⌘ seul :
  ⎋ et ↩ restent aux feuilles. Sous une feuille, une alerte ou un
  `confirmationDialog`, elles sont sans effet. `[test: keyboardShortcutsFollowTheSidebar]`

## Accessibilité et langue (feature `accessibilite-et-localisation-ios-residu`)

- Un symbole décoratif, toujours doublé d'un texte visible qui porte le sens
  (icône de nature d'une carte d'attention, promesse de la Bienvenue, icône de
  voie), est masqué à VoiceOver par `.accessibilityHidden(true)` sur l'`Image` :
  aucun élément `Image` lu sous un nom de symbole (« Search Document »). Un
  symbole porteur de sens sans texte visible porte un libellé français :
  « Nouvelle feature… » (`NewFeatureText.command`). `[capture: iphone-home-light]`
- L'app est française seulement : `developmentRegion = fr` et
  `knownRegions = (fr, Base)` dans le projet, aucun `.lproj`, `.xcstrings` ni
  `CFBundleLocalizations`. Les libellés fournis par iOS (« Masquer la barre
  latérale », « Coller », bouton retour) restent en français sur un appareil
  réglé en anglais. `[test: appIsFrenchOnly]`
- L'icône est légendée « OMP Console » (`INFOPLIST_KEY_CFBundleDisplayName`, Debug
  et Release de la cible app) ; `PRODUCT_NAME` et le bundle restent inchangés,
  pour ne pas perdre l'appairage. `[test: homeScreenNameIsOMPConsole]`

## Identité de l'app (feature ios-identite-app)

Le nom sous l'icône et la région `fr` sont décrits dans la section précédente ;
cette section porte ce que l'utilisateur voit avant le premier écran.

- L'icône d'OMP Console a un seul dessin, produit par `bash scripts/app-icon.sh`
  (programme `scripts/app-icon/dessin.swift`) : un chevron « › » et un trait « _ »
  sur un fond en dégradé vertical, carré plein cadre, sans texte ni alpha (le
  système arrondit les coins). `Assets.xcassets/AppIcon.appiconset` en déclare
  trois variantes de 1024 px : claire (`AppIcon.png`, motif blanc sur #3D9BFF →
  #0058D6), sombre (`AppIcon-dark.png`, motif #6CB4FF sur #1B3354 → #070D18) et
  teintée (`AppIcon-tinted.png`, niveaux de gris), compilées par
  `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`. Le Mac porte la même icône :
  `omp-console/Bundle/AppIcon.icns`, construit depuis la variante claire et copié
  dans le bundle par `scripts/swift-app.sh` (`CFBundleIconFile = AppIcon`).
  `[test: appIconIsDeclared]`
- L'accent est le bleu système, sans teinte de marque : `AccentColor.colorset`
  déclare les quatre valeurs sRGB de `UIColor.systemBlue` (clair #0088FF, sombre
  #0091FF, contraste élevé #1E6EF4 en clair et #5CB8FF en sombre), jamais la
  référence `systemBlueColor`, qu'actool compile en une couleur fixe sans variante
  sombre. Aucun écran ne change de teinte : ni `.tint(` global, ni
  `Color("AccentColor")` dans les sources. `[test: accentColorIsSystemBlue]`
- Le message de l'alerte « Réseau local » (`NSLocalNetworkUsageDescription` de
  `OMPConsoleIOS-Info.plist`) est exactement « OMP Console se connecte à votre Mac
  sur le réseau local pour afficher et piloter vos pipelines. » : il vouvoie et ne
  dit ni « coque » ni « macOS ». Le simulateur n'affiche jamais cette alerte
  (TN3179) : le texte se prouve dans l'app installée.
  `[test: localNetworkMessageSpeaksToTheUser]`
- L'écran de lancement est celui que génère Xcode
  (`INFOPLIST_KEY_UILaunchScreen_Generation = YES`) : un `UILaunchScreen` vide,
  sans couleur ni image, donc le fond système (#FFFFFF en clair, #000000 en
  sombre), celui du premier écran — aucun éclair d'une autre couleur à
  l'ouverture. Ni storyboard, ni `UIColorName`, ni `UIImageName`.
  `[test: launchScreenUsesSystemBackground]`

## Les six tons

- `neutral` gris, `info` bleu, `attention` orange, `success` vert, `danger`
  rouge, `paused` jaune ; `onTint` vaut noir sur `paused` et blanc sinon —
  exactement le mapping macOS. `[test: toneTintsMatchMacOS]`
- Le mot porte le sens, la couleur ne fait que le doubler. `[garde: design-ios/AC-5]`

## États vide et erreur (S-2, S-3)

- Chaque section affiche son état vide RÉEL, avec le mot partagé du noyau, mot
  pour mot : aucune donnée inventée, aucun état de chargement. `[test: emptyStatesUseSharedWords]`
- Le titre d'un écran vient de `ConsoleSection` (ConsoleCore) ; son icône aussi,
  sauf l'unique surcharge iOS `IOSSection.systemImage(of:)` (Sessions :
  `clock.arrow.circlepath`, pour la distinguer de Session OMP) — le macOS garde
  les icônes de `ConsoleSection`. `[test: titlesAndIconsComeFromConsoleCore]`
- La section Session OMP porte la pastille de l'état partagé « Aucun projet »
  (`ConsoleStatus`, ton `neutral`). `[test: sessionCarriesSharedStatus]`
- En état d'erreur, les SEPT sections portent le bandeau `danger` avec le
  message provisoire de `IOSText`. `[test: errorStateBannersAllSeven]`
- L'état d'erreur vient d'un chemin RÉEL : le crochet de recette
  `-ios.state error` — jamais une capture fabriquée. `[garde: design-ios/AC-4]`
- Un repli silencieux (section inconnue ⇒ Accueil, sans message) reste
  silencieux ; une valeur inconnue ne devient jamais une erreur.
  `[test: resolveScreenState]`
- Une section hors périmètre (Terminal, Fichiers) n'a aucun contenu d'écran.
  `[test: outOfScopeSectionsHaveNoContent]`

## États de connexion (feature `etats-non-connecte-heterogenes-ios`)

- Un seul composant, `IOSConnectionStateView` (Design/), dit l'état de connexion
  dans les sept sections ; ses mots vivent dans `IOSConnectionStateText` et ses
  identifiants, tous préfixés `ios.connexion.`, dans
  `IOSConnectionStateAccessibility`. `[test: connectionIdentifiersAreUniqueAndPrefixed]`
- Le statut présenté est une fonction pure de l'état du client
  (`IOSConnectionStatus.resolve`) : une tentative fraîche est « Connexion au
  Mac… » ; dès qu'une tentative a échoué, l'écran dit « Pas de connexion au Mac »
  et le reste pendant les relances automatiques. `[test: resolvesEveryClientState]`
  `[test: retryAfterFailureStaysDisconnected]`
- « Pas de connexion au Mac » porte une phrase par cause — non appairé, appairage
  refusé ou révoqué, Mac injoignable, app à mettre à jour, Mac à mettre à jour —
  sans numéro de version, chemin ni adresse. `[test: causesHaveDistinctPhrases]`
  `[test: updatePhrasesNameTheAppWithoutVersionNumbers]`
- Deux formes : plein écran (`ContentUnavailableView`, bouton « Se connecter »
  proéminent) quand la section n'a rien chargé ; bandeau `attention` suivi de
  « Se connecter » au-dessus des données conservées. « Connexion au Mac… » est un
  indicateur d'attente sans bouton (plein écran, ou bandeau `info`). « Se
  connecter » ouvre la feuille Connexion de la racine. `[test: resolvePriority]`
- Pipelines, Sessions et Mémoire (liste et graphe) suivent la même règle : rien
  de reçu hors connexion ⇒ le composant seul, hors de la liste (et du panneau du
  graphe) ; données reçues ⇒ elles restent, sous le bandeau, et la Mémoire relit
  au retour du Mac. `[test: unavailableWithoutList]` `[test: listKeptOffline]`
  `[test: offlineWithoutDataIsTheConnectionComponent]` `[test: offlineKeepsTheLastData]`
- Projet, Statistiques et Session OMP suivent la même règle, le titre de section
  étant celui de la barre : rien de reçu hors connexion ⇒ le composant seul, hors
  de la liste de Projet et de Statistiques ou du panneau de Session OMP ; une
  conduite, un relevé ou un état de session reçu ⇒ il reste, sous le bandeau, et
  l'erreur conservée est tue ; les Statistiques relisent au retour du Mac.
  `[test: projectUnavailableWithoutConduite]`
  `[test: projectKeepsConduiteOffline]` `[test: statsUnavailableWithoutPayload]`
  `[test: statsKeepsBoardOffline]` `[test: sessionOmpUnavailableWithoutHosted]`
  `[test: sessionOmpKeepsHostedOffline]`
- Les actions qui exigent le Mac (« + » de Pipelines, répondre, valider, reprendre,
  lancer, arrêter, fusionner, rafraîchir, éditer, écrire dans la Session OMP…)
  restent visibles mais grisées hors connexion, connexion en cours comprise, et se
  rouvrent dès la connexion, sans relancer l'app. À l'Accueil, seul « Voir dans
  Pipelines » reste tapable parmi les gestes d'attente ; les feuilles de dialogue
  ne s'ouvrent qu'une fois connecté, et une confirmation restée ouverte n'envoie
  rien. Le champ de recherche de la Mémoire, que `.disabled` ne grise pas en
  placement `.automatic`, est rendu inerte. `[test: gesturesOnlyWhenConnected]`
  `[test: attentionNeedsMacExceptOpenInPipelines]` `[test: gesturesReopenOnConnection]`

## Dynamic Type maximum (S-7)

- À `accessibility-extra-extra-extra-large`, aucun texte n'est tronqué ni
  chevauché : aucune hauteur fixe, aucune largeur figée, aucune troncature —
  sauf le texte d'un souvenir dans la liste de la Mémoire, plafonné par
  `IOSMetrics.memoryRowLines(_:)` et intégral dans la feuille.
  `[capture: iphone-*-dark-ax]`
- L'iPad tient la même taille maximale, barre latérale à deux groupes comprise.
  `[capture: ipad-*-light-ax]`
- Les captures en taille maximale existent pour iPhone ET iPad, sur les deux
  apparences. `[capture: ipad-*-dark-ax]`

## Orientations (S-5)

- L'app déclare portrait et les deux paysages
  (`INFOPLIST_KEY_UISupportedInterfaceOrientations`, sur les deux
  configurations) : elle reste pleinement utilisable en paysage sur un vrai
  iPad. `[garde: design-ios/AC-6]`
- L'app ne DEMANDE jamais la rotation : `simctl` n'a aucune sous-commande pour
  tourner un appareil, `Simulator.app` n'est pas installé sur le poste de
  référence, et en mode fenêtré iPadOS refuse `requestGeometryUpdate` (« The
  current windowing mode does not allow for programmatic changes to interface
  orientation. »). L'opt-out `UIRequiresFullScreen` — qui rendrait la demande
  possible — coûterait le Split View et le Slide Over : c'est un choix PRODUIT,
  qu'on ne prend pas pour un outil de capture. `[garde: design-ios/AC-6]`
- Vérification du paysage : à la main, sur un iPad réel (ou dès que
  `Simulator.app` est restauré sur le poste, la ligne « iPad paysage » pourra
  revenir avec ses quatorze captures). `[garde: design-ios/AC-6]`

## Preuve visuelle (S-6)

- Cinquante-six captures : 7 écrans × {iPhone portrait, iPad portrait} ×
  {clair, sombre} à taille de texte par défaut, plus 7 écrans × {iPhone, iPad} ×
  {clair, sombre} en Dynamic Type maximum. `[garde: design-ios/AC-6]`
- Chaque capture est sondée en dimensions (`sips`) : toutes PORTRAIT — une
  capture inattendue ferait échouer le script. `[capture: iphone-*-light]`
- Les images restent des artefacts de PR : elles vivent sous
  `omp-console/build/ios-shots/`, ignoré par git. `[garde: design-ios/AC-6]`
- Les deux apparences et les deux appareils sont couverts pour chaque écran.
  `[capture: ipad-*-dark]`

## Ce que la recette refuse

- Aucun libellé durable en dur hors du vocabulaire partagé `ConsoleCore`.
  `[garde: design-ios/AC-5]`
- Aucun composant orphelin : chaque composant livré est employé par un écran.
  `[garde: design-ios/AC-2]`
- Aucun changement visible côté coque macOS : mots et apparence identiques,
  `ConsoleCore` modifié par ajout seulement. `[garde: design-ios/AC-10]`

## Pipelines (feature `ios-pipelines`)

- L'écran Pipelines rend l'ardoise PARTAGÉE de `ConsoleCore` (`KanbanBoard`), la
  même dérivation que macOS : les cinq voies de `KanbanLane`, leurs cartes et
  leurs états viennent du magasin, jamais d'un calcul propre à l'app.
  `[garde: design-ios/AC-3]`
- En largeur COMPACTE (iPhone portrait), chaque voie est une section de la liste
  groupée de l'écran — son en-tête, puis une rangée par carte ; en largeur
  RÉGULIÈRE (iPad), les voies sont côte à côte, leurs cartes élevées sur le fond
  groupé, dans un défilement horizontal posé dans le défilement vertical du
  kanban — toutes les voies montrées et toutes leurs cartes restent atteignables.
  `[capture: iphone-kanban-light]`
- En largeur COMPACTE, une voie sans carte n'est pas montrée — « Pas commencées »
  comprise — et sans aucune voie à montrer l'écran affiche le mot partagé
  `KanbanText.noPipeline`. `[test: compactHidesEveryEmptyLane]`
- En largeur COMPACTE, « Livrées » et « Arrêtées » s'ouvrent repliées à chaque
  visite : leur en-tête, un bouton de 44 pt (`pipelines.lane.<voie>.header`,
  valeur d'accessibilité « replié »/« déplié »), les déplie et les replie ;
  l'état n'est pas mémorisé d'une visite à l'autre. `[test: compactFoldsTerminalLanes]`
- En largeur RÉGULIÈRE (iPad), voies permanentes même vides et voies terminales
  dépliées ; chaque voie a la même largeur, `IOSMetrics.laneWidth` (280 pt) mise à
  l'échelle par Dynamic Type et plafonnée à la largeur visible moins la marge de
  fin ; voies alignées en haut ; le défilement horizontal finit sur une marge
  `IOSMetrics.margin`. `[test: laneWidthNeverExceedsTheViewport]` `[test: regularKeepsLanesUnchanged]`
- L'en-tête d'une voie (symbole, titre, compteur) s'empile aux tailles
  d'accessibilité, sur iPad comme sur iPhone, et son titre n'est jamais tronqué.
  `[test: laneHeaderStacksAtAccessibilitySizes]`
- L'écran ne fabrique aucune donnée : Mac non connecté sans instantané, il rend
  seul le composant d'état de connexion en plein écran ; une ardoise reçue
  (même vide, mot partagé `KanbanText.noPipeline`) reste affichée hors
  connexion, sous le bandeau du composant. `[test: unavailableWithoutSnapshot]`
  `[test: snapshotKeptOffline]`
- La feuille d'une carte offre les gestes de la carte via la règle d'aiguillage de
  `KanbanActionPresentation` ; une carte d'historique n'offre aucun geste et le
  dit. `[test: historyCardOffersNothing]`
- « Fusionner » demande une confirmation AVANT tout effet et la ligne de PR
  servie porte le `headOid` exigé par la route de fusion.
  `[garde: design-ios/AC-8]`
- La cible tactile minimale des cartes, des options de question et des boutons de
  geste est celle du HIG (44 pt). `[test: minimumTargetIsFortyFour]`
- Une carte n'a de ligne d'action que si elle porte une adresse de PR ouvrable :
  un espace sous le corps, puis « Ouvrir la PR » sur toute la largeur, haut
  d'au moins 44 pt ; une carte sans PR n'a ni ligne ni espace réservé. Une carte
  est rigide en hauteur : dans la voie la plus haute de l'iPad (« Livrées »), son
  titre passe à la ligne comme ailleurs, sans « … ». `[test: minimumTargetIsFortyFour]`
- Une carte ne montre jamais de marque brute (« Marques : mort ») : ses marques
  se lisent par la phrase partagée `KanbanText.marksSentence` (« Elle s'est
  arrêtée de façon inattendue. »…), en `.caption` secondaire, sur autant de
  lignes qu'il faut ; une carte saine n'a aucune ligne. L'ardoise qui porte une
  carte au pilote arrêté se capture par `-pipelines.board marques`, sans
  appairage. `[test: boardRecipeMarquesShowsSentences]`
- Pipelines se relit quand on tire la liste (iPhone) ou le kanban (iPad) vers le
  bas : l'ardoise, puis l'état des PR sur GitHub si aucune relecture n'est déjà
  en cours ; un échec est silencieux. Au clavier de l'iPad, ⌘R « Actualiser »
  fait la même relecture et n'est actif que connecté. La barre ne porte aucun
  bouton ↻ ; aucun message : le retour visible est l'indicateur système puis le
  libellé des cartes. `[test: refreshAvailability]`
  `[test: pipelinesRefreshRereadsTheBoardThenThePullRequests]`
- Sur l'ardoise iOS, les clôtures d'étape d'une feature de lot ne font aucune
  carte à part, et une feature réduite à ses clôtures fait une seule carte
  « Terminée ». `[test: historyClosuresJoinTheirFeatureOnIOS]`
- Dans la feuille « Nouvelle feature », le sélecteur de dépôt montre le NOM du
  dossier (jamais un chemin absolu), complété par les derniers segments du
  parent pour les seuls homonymes ; la valeur lancée reste la racine complète.
  `[test: repoChoicesUseFolderNames]`
- Le dépôt se choisit dans un `Picker` natif, rangée « Dépôt » (le mot n'apparaît
  qu'une fois) ; sans dépôt choisi, il affiche l'invite « Choisir un dépôt »,
  inactive dans le menu, et « Lancer » est inactif.
  `[capture: iphone-nouvelle-feature-vide-light]` `[garde: ios-finitions-composants/AC-8]`
- Les champs titre et besoin portent les libellés VoiceOver « Titre » et
  « Besoin », sans libellé visible ajouté.
  `[capture: iphone-nouvelle-feature-choisi-light]`
- Le champ besoin montre 3 lignes à vide, grandit jusqu'à 8 lignes puis défile
  dans le champ, sans second défilement de feuille.
  `[capture: iphone-nouvelle-feature-rempli-light]`
- Sous le champ titre, aucune ligne : la feuille ne cite ni branche ni « feat/ ».
  `[garde: ios-redaction-vouvoiement/AC-3]`
- Les deux sélecteurs de modèle s'appellent « Modèle /req et /specs » et « Modèle
  /impl et /review ». `[garde: ios-redaction-vouvoiement/AC-7]`
- La feuille se capture par le crochet de recette `-pipelines.recipe`
  (`vide`, `choisi`, `rempli`), sans appairage. `[test: pipelinesRecipeResolves]`
- La fiche d'une carte affiche son titre complet une seule fois, dans le corps, sur
  autant de lignes qu'il faut ; la barre porte « Pipelines » et « Fermer » (44 pt).
  `[capture: iphone-pipelines-fiche-*]`
- « Reprendre » et « Arrêter… » sont des rangées de bouton système ; « Arrêter… »
  porte le rôle destructif (texte rouge, sans capsule ni contour) et passe par sa
  confirmation. `[capture: iphone-pipelines-fiche-actions-*]`
- Le modèle s'affiche par son nom lisible du catalogue servi par le Mac, l'identifiant
  brut sinon. `[test: modelNameFromCatalog]`
- Chaque élément de la fiche porte son propre identifiant `pipelines.card.sheet.*`.
  `[test: sheetIdentifiersAreDistinct]`

## L'Accueil (S-10, S-11)

- L'écran porte le titre de navigation `ConsoleSection.home.title`, en grand titre
  par défaut comme les autres sections, dans ses cinq états : aucune bande vide
  sous la barre, et la barre titrée reste en place, bouton Connexion compris,
  quand le tableau de bord défile. `[capture: iphone-home-light]`
- L'Accueil iOS montre un seul de ses cinq états : indisponible (le composant
  d'état de connexion en plein écran, hors connexion et sans ardoise reçue),
  « OMP absent sur le Mac », chargement, premiers pas, tableau de bord — dans cet
  ordre de priorité. Hors connexion, une ardoise déjà reçue reste affichée sous
  le bandeau du composant. `[test: resolvePriority]`
- Les faits du tableau de bord viennent de la MÊME dérivation que macOS, depuis
  la fixture partagée `HomeParity` : mêmes cartes, mêmes natures, mêmes
  libellés. `[test: parityFacts]`
- Le tableau de bord range chaque carte dans UNE section, dans cet ordre :
  « À vous », « En cours » (seules les pipelines réellement en marche, avec leur
  durée, sans puce), « À reprendre » (les pipelines en pause, puce « En pause » et
  « Reprendre »), « Pas commencées » (titre et sous-titre seuls), « Livrées
  récemment » ; « À reprendre » et « Pas commencées » disparaissent quand elles
  sont vides. Mêmes listes et mêmes identifiants que le Mac, préfixés `ios.`
  (`ios.home.paused.<id>`, `ios.home.notStarted.<id>`). `[test: sectionsMatchTheMac]`
- Une pipeline en échec ou bloquée (feature de lot relançable seulement) est une
  carte « À vous » « En échec » (`xmark.octagon.fill`) ou « Bloquée »
  (`exclamationmark.triangle.fill`), qui nomme l'étape où elle s'est arrêtée,
  sans texte d'erreur brut, et porte « Reprendre » ; elle n'est dans aucune autre
  section. `[test: failedAndBlockedAreAttentionOnly]`
- Ce « Reprendre » emprunte la route de reprise de la carte, que le Mac traduit en
  relance : envoi en cours, puis refus du Mac sur la carte (« La pipeline n'a pas
  repris. » et sa cause) ; relancée, la carte passe sous « En cours ».
  `[test: relaunchCardSendsResumeOfItsCard]`
- L'onglet Accueil (iPhone) et l'entrée Accueil de la barre latérale (iPad)
  portent le badge du nombre d'attentes (`HomePresentation.attentionCount`), et
  rien quand il vaut zéro. `[test: badgeCounts]`
- Chaque onglet de section est UN élément d'accessibilité (`ios.tab.<section>`)
  dont le libellé est le titre, suivi de « , N en attente » quand le badge est
  visible — la même valeur alimente le badge et le libellé.
  `[test: sectionRowLabelFollowsShownBadge]`
- Le badge ne dépend pas de l'onglet affiché : l'onglet Accueil le montre depuis
  n'importe quel onglet, et aucun autre onglet n'en porte.
  `[test: homeRowCarriesPositiveCount]`
- La bienvenue ne s'affiche qu'à la première ouverture de l'Accueil (préférence
  `home.welcomeSeen`) ; « Continuer » pousse la Connexion dans la même feuille
  (« Plus tard » à la place de « Fermer ») sauf pour un appareil appairé.
  `[test: welcomeDue]` `[test: welcomeContinueShowsConnectionUnlessPaired]`
- Après la fermeture de la bienvenue, la Connexion ne s'ouvre plus d'elle-même
  pendant le lancement, sauf jeton refusé. `[test: deferredUnpairedStaysClosed]`
  `[test: deferredRefusedStillOpens]`
- Bienvenue au style Apple : grand titre centré, promesses à grande icône,
  « Continuer » pleine largeur ancré en bas, sans panneau.
  `[test: welcomeContinueShowsConnectionUnlessPaired]`
- La feuille « Répondre » aiguille les deux zones partagées (`pendingQuestion`,
  `textQuestion`) ; une option sélectionnée prime sur le champ libre. `[test: answerZones]`
- La feuille Contrat découpe le markdown par les fonctions partagées
  (`ContractDocument`) et rend chaque section en Markdown, bloc par bloc, par
  `IOSMarkdownView`, sans sa ligne « ## Titre » (l'en-tête de la feuille suffit) ;
  une section absente ou vide a son message, sans syntaxe Markdown brute.
  `[test: contractSectionsDropTheirHeading]`
- Sa barre dit « Contrat » en ligne ; le nom complet de la feature est en tête du
  panneau, en en-tête, et passe à la ligne au lieu d'être tronqué.
  `[test: longRecipeNamesTheWholeFeature]`
- Une livraison récente ouvre sa PR par son seul bouton « Ouvrir la PR », par
  `openURL`, seulement quand l'URL est exploitable ; le titre et la puce ne sont
  pas des cibles. `[test: deliveredLinks]`
- « Livrées récemment » et la voie « Livrées » portent l'état réel de la PR
  (« PR ouverte », « PR fusionnée », « PR fermée », « PR créée » tant qu'il est
  inconnu), les mêmes libellés que le Mac (`ConsoleStatus.of(card:)`) ; une
  livraison close depuis plus de 7 jours en sort, et les clôtures d'étape d'une
  feature ne font jamais de carte à part. `[test: deliveredReadsThePullRequestState]`
- Le lien « Tout afficher » sélectionne la section Pipelines. `[test: allPipelinesSection]`
- Le bandeau de préparation vient du Mac (`components.setupBanner`), jamais
  inventé ; l'Accueil ne porte AUCUN bouton dessus. `[test: setupBanner]`
- « OMP absent sur le Mac » n'est conclu que sur réponse du Mac, jamais quand la
  réponse manque. `[test: macMissingRequiresComponents]`
- Avant le premier instantané, l'Accueil affiche l'indicateur de chargement natif
  seul, sans texte — jamais un vide muet. `[test: loadingBeforeFirstSnapshot]`
  `[garde: ios-redaction-vouvoiement/AC-5]`
- L'état de l'Accueil suit l'ardoise publiée sans geste de l'utilisateur.
  `[test: liveUpdates]`
- Une feature dont les specs attendent une validation porte « Spécifications à
  valider », en statut comme en attente ; seul le bouton dit « Valider les specs ».
  `[test: specsAwaitingValidationReadTheSameEverywhere]`
- Aucun bandeau de notifications, et l'app ne demande jamais l'autorisation
  d'en afficher. `[test: noNotificationsBanner]`
- Les cinq états et les trois feuilles se capturent par le crochet de recette
  `-home.recipe`, sans écran fabriqué. `[capture: iphone-home-light]`
- L'Accueil reste lisible en Dynamic Type maximum, comme le reste de la coque.
  `[capture: iphone-home-dark-ax]`
- Une rangée « titre | puce | bouton » tient sur une ligne quand tout y tient ;
  sinon le titre passe sur sa ligne et la puce et le bouton sur la suivante ;
  s'ils ne tiennent pas ensemble, chacun a sa ligne — quelle que soit la taille
  de texte, sur iPhone comme sur iPad. `[test: longTitleSplitsAboveItsControls]`
- Aucune taille de texte n'est plafonnée : rangées, puces et boutons suivent la
  taille système jusqu'à `accessibility-extra-extra-extra-large` ; seul un mot
  plus large que la ligne peut être coupé. `[garde: ios-dynamic-type-ax-residuel/AC-2]`
- Un geste de carte montre son envoi en cours et n'envoie rien de plus jusqu'à la
  réponse du Mac : bouton désactivé, indicateur devant le libellé, valeur
  d'accessibilité « Envoi en cours ». `[test: resumeIgnoresSecondTapWhileInFlight]`
- « Valider les specs » demande une confirmation, « Reprendre » et « Accepter la
  revue » partent aussitôt. `[test: specsTapAsksConfirmationWithoutSending]`
- L'échec d'un geste s'affiche sur sa carte, en français, sans détail technique ;
  le succès n'a pas de message, la carte suit l'ardoise.
  `[test: failureLandsOnItsCardWithoutRawDetail]`
- Le nom d'une feature passe par `IOSHomeText.featureName(_:)` : il se replie en
  entier et la coupure tombe AVANT un tiret, jamais après.
  `[test: featureNameNeverEndsALineWithAHyphen]`

## Mémoire (feature `ios-memoire`)

- L'écran Mémoire montre le sommaire du projet ouvert, dans l'ordre servi par le
  Mac — les mêmes souvenirs que la section macOS, aucun tri local, et « Aucun projet
  ouvert » quand la portée est nulle. `[test: memoryFollowsTheClientTheScopeAndTheLoad]`
- La liste se lit PAR PAGES bornées de la seule portée du projet (`GET /v1/memory/page`,
  100 souvenirs par page) : arrivé en bas, le pied « Chargement des souvenirs
  suivants… » lit la page suivante de lui-même (défilement continu), jusqu'au dernier
  souvenir, chaque souvenir une seule fois. Plus de troncature ni de ligne de
  troncature. L'échec d'une page suivante s'affiche dans le pied, avec « Réessayer »,
  et garde les lignes déjà lues. `[test: scrollingToTheEndLoadsEveryRowOnce]`
- Un délai dépassé n'est PAS un Mac injoignable : dans la Mémoire seulement (entrée
  `IOSMacFailure.ofMemoryRead` du traducteur partagé), « Délai dépassé : le Mac a mis
  trop de temps à répondre. » puis « Réessayez dans un instant. » et « Mac injoignable. »
  et son remède sont deux bandeaux distincts, chacun avec « Réessayer ». Les autres
  sections gardent « Mac injoignable. ». `[test: listTimeoutSaysDelayExceeded]`
- Face à une app Mac antérieure (qui ignore la route de page), la liste dit
  « Fonction indisponible : app Mac trop ancienne. » puis « Mettez à jour OMP Console sur
  le Mac, puis réessayez. », sans code HTTP ni JSON ; aucun code de compatibilité.
  `[test: listOnOlderMacSaysMacOutdated]`
- Le détail d'un souvenir ouvre une feuille : la ligne de contexte (date relative,
  étiquettes), le texte intégral tel qu'il est stocké, identifiant et portée sous
  « Détails techniques » — jamais de bouton d'écriture. `[test: detailRendersTheFiveFacts]`
- Le texte d'un souvenir s'affiche TEL QU'IL EST STOCKÉ (`Text(verbatim:)`), dans la
  liste, la feuille et la fiche du graphe : aucun rendu Markdown, aucun titre raccourci
  — un `*` reste un `*`. Seuls les autres contenus (documents projet, contrat, réponses) passent
  par `IOSMarkdownView`. `[test: listDetailAndGraphSheetShowTheStoredText]`
- Le texte d'un souvenir tient en 3 lignes au plus en largeur compacte et 4 en
  largeur régulière, terminé par « … », quelle que soit la taille de texte ; la
  feuille montre le texte intégral. `[test: memoryRowLinesFollowTheWidth]`
- Chaque rangée a la même marge verticale que les Sessions ; la date et les
  étiquettes tiennent sur une ligne, jointes par « · », aux tailles standard et
  s'empilent (date, puis étiquettes) aux tailles d'accessibilité.
  `[test: memoryRowContextSplitsIntoSegments]`
- « Sommaire » reste toujours visible ; indisponible (mode Graphe, sommaire déjà
  affiché, recherche en cours), c'est un bouton désactivé du système, sans teinte
  ni bulle. `[test: summaryAvailability]` `[garde: ios-gestes-et-retours-natifs/AC-13]`
- L'écran reste lisible en Dynamic Type maximum, comme le reste de la coque.
  `[capture: iphone-memory-light.png]`

## Le mode graphe de la Mémoire (feature `ios-memoire-graphe`)

- La section Mémoire s'OUVRE sur la LISTE, inchangée : le graphe s'ajoute derrière
  une bascule `Graphe ⇄ Liste` de la barre d'outils. `[test: theListIsTheOpeningMode]`
- Le graphe est manipulable au doigt sur iPhone ET iPad (pincer, glisser,
  toucher), et un nœud reste touchable après la manipulation.
  `[capture: iphone-memoire-graphe-zoom-*]`
- Toucher un nœud-étiquette APPLIQUE son filtre (la famille de l'étiquette), avec un
  menu pour revenir à la vue entière ; toucher un souvenir met son voisinage en
  évidence et ouvre sa fiche en lecture seule.
  `[capture: ipad-memoire-graphe-fiche-*]`
- Une ligne de lien de la fiche dit sa nature en clair : une proximité s'écrit
  « Très proche » (score ≥ 0,90), « Proche » (≥ 0,80) ou « Assez proche », jamais un
  nombre ; « Étiquette » et « Manuel » restent. `[test: proximityReadsAsPlainWords]`
- Le canevas fait EXCEPTION à « aucune couleur hors `ConsoleTone` » : il peint les
  portées avec `IOSDataPalette` — des couleurs système adaptatives, chacune avec ses
  variantes clair, sombre et contraste accru, choisie par `IOSDataPalette.scope(hue:)`
  depuis la teinte du noyau partagé — plus `Color.accentColor`, `.secondary` et
  `.primary` ; aucune teinte HSB fixe. La coque macOS garde `MemoryGraphStyle.hue(for:)`
  en HSB. `[test: paletteAdaptsToAppearanceAndContrast]`
- Le graphe ne montre que la portée du PROJET OUVERT — la même que la liste, résolue
  par le Mac —, tous ses souvenirs, sans borne en nombre (seule une charge au-delà de
  16 Mio est retirée et annoncée « Graphe partiel »). Sans projet ouvert, il dit
  « Aucun projet ouvert » et ne dessine aucun canevas. `[test: graphWithoutProjectSaysNoProject]`
- Un graphe qui dépasse son délai dit « Délai dépassé : le Mac a mis trop de temps à
  répondre. » puis « Réessayez dans un instant. » avec « Réessayer », jamais « Mac injoignable » ;
  le panneau commence en haut, sous la barre de navigation, dans tous les états.
  `[test: graphTimeoutSaysDelayExceeded]`
- VoiceOver parcourt le graphe : un élément par souvenir affiché (« <titre>, N liens »,
  les titres liés en contenu « Liés à ») et un par nœud-étiquette affiché
  (« #<étiquette>, étiquette, N souvenirs »), jamais dessinés ; les éléments suivent le
  filtre, le zoom et le déplacement. `[test: voiceOverExposesOneElementPerShownNode]`
- Activer l'élément d'un souvenir l'ouvre comme au toucher : même voie d'action, fiche
  en lecture seule. `[test: voiceOverActivatingAMemoryOpensItsSheet]`
- Activer l'élément d'une étiquette applique son filtre comme au toucher ; les éléments
  se réduisent à la famille, et « Toutes les étiquettes » revient au graphe entier.
  `[test: voiceOverActivatingATagFiltersAndOffersTheWholeGraph]`
- Aucune étiquette visible n'en recouvre une autre à l'échelle d'ouverture, sur iPhone
  comme sur iPad : les noms de grappe passent d'abord, puis les capsules d'étiquette,
  puis les titres de souvenir ; un texte sans place est masqué jusqu'au zoom, et une
  capsule sans place devient une pastille. `[test: graphLabelsNeverOverlapAtOpeningScale]`

## La section Statistiques (feature `ios-statistiques`)

- En tête du tableau, deux graphiques Swift Charts en barres horizontales : « Durée
  par feature » et « Tokens par feature » (envoyés et reçus empilés, avec légende), une
  barre par feature LISTÉE, dans l'ordre et avec les nombres des sections dessous,
  qui restent inchangées. `[test: statsChartsFollowTheListedFeatures]`
- Chaque graphique porte un descripteur d'accessibilité (`AXChartDescriptor`) : titre
  en français, axes nommés, un point exact par feature — une série pour la durée, deux
  pour les tokens. `[test: statsChartsDescribeStackedTokens]`
- Aucun graphique vide : sans feature listée ou aux valeurs toutes nulles, le
  graphique n'est pas monté ; chargement, bascule et erreur n'en montrent aucun.
  `[test: statsChartsHideWithoutData]`
- La hauteur des barres suit Dynamic Type (`@ScaledMetric`), et les graphiques vivent
  dans `IOSStatsCharts.swift`, montés avant les sections des features.
  `[garde: ios-statistiques-et-graphe-accessibles/AC-2]`
- Une section par feature LISTÉE, dans l'ordre du plan : le slug en en-tête, puis une ligne par
  grandeur (modèle, temps passé, tours, tokens envoyés, tokens reçus). `[test: statsCardsSumTheListedFeatures]`
- « Tokens envoyés » compte TOUT ce qui part vers le modèle : entrée hors cache + cache lu + cache écrit, sur chaque section et sur la ligne « Total du projet » ; « Tokens reçus » reste la sortie. La fenêtre macOS, elle, garde l'entrée hors cache. `[test: statsSentTokensCountTheCache]`
- La ligne « Total du projet » somme les features LISTÉES — ni les features
  masquées, ni un autre projet — et rien d'autre n'y entre. `[test: statsTotalSumsOnlyListedFeatures]`
- Le sélecteur de projet, la ligne de total et la mention des features masquées
  sont visibles des deux appareils, aux deux apparences. `[capture: ipad-stats-dark]`
- Les durées et les totaux se recalculent à l'instant de RENDU
  (`TimelineView(.periodic(from:by:))`) : un run vivant fait avancer sa durée d'un
  milliseconde par milliseconde et par run vivant, sans un octet de trafic.
  `[test: statsDurationsAdvanceWithLiveRuns]`
- Sept états à part entière, jamais un écran vide : non connecté (le composant
  d'état de connexion partagé, en plein écran sans relevé, en bandeau au-dessus du
  dernier relevé conservé), chargement (« Chargement des statistiques… »), erreur
  (bandeau `danger` + « Réessayer »), aucun projet, bascule vers un autre projet,
  projet sans feature listée, tableau. `[test: statsSurfacesCoverEveryState]`
  `[test: statsKeepsBoardOffline]`
- Le sélecteur de projet nomme le projet CHOISI et se tient en tête des états
  tableau, vide et bascule — pendant la lecture d'un autre projet, il reste
  au-dessus du chargement ; le premier chargement, le non connecté, l'erreur et
  « Aucun projet » n'en ont pas. `[test: statsProjectSwitchKeepsHeaderAboveLoading]`
- Depuis l'état « Aucune donnée pour ce projet », on change de projet : le
  sélecteur est au-dessus de la rangée vide, et choisir un projet qui a des données
  affiche son tableau. `[test: statsEmptyProjectOffersTheSwitch]`
- Un relevé est relancé par quatre déclencheurs seulement — apparition, changement
  de projet, nouvel état du magasin, mise à jour de session — et JAMAIS tant que le
  client n'est pas connecté : aucune minuterie de scrutation.
  `[test: statsReloadsOnlyWhenConnected]`
- L'écran reste lisible en Dynamic Type maximum, comme le reste de la coque.
  `[capture: iphone-stats-dark-ax]`

## Sessions (S-1…S-11)

- La section Sessions rend la liste PARTAGÉE de `ConsoleCore` (`SessionList`) et
  son groupement par jour (`SessionDays`) : mêmes runs, mêmes en-têtes que macOS,
  rendus en en-têtes de section natifs de la liste groupée, y compris pour une
  session lancée hors coque. `[test: listGroupsByDay]`
- Un menu de projet restreint la liste AVANT le groupement, donc les
  en-têtes de jour se recalculent ; « Tous les projets » la restitue entière.
  `[test: projectFilter]`
- Le fil de la visionneuse vient du modèle de lignes PARTAGÉ
  (`SessionRowBuilder`) : mêmes lignes que macOS, prouvées sur la fixture
  `SessionParity`. `[test: parityRows]`
- Une session illisible ou tronquée affiche son motif (bandeau `danger`
  au-dessus du fil) ou la note de réécriture — jamais un écran vide muet.
  `[test: unreadableAndTruncated]`
- Les bannières de la visionneuse (erreur, session illisible) montrent leur
  texte entier à toute taille ; le fil prend la place restante.
  `[test: errorRecipeShowsTheErrorBanner]`
- L'écran de section est capturé tel quel, sans écran fabriqué.
  `[capture: iphone-sessions-light]`
- Les plis d'une ligne (réflexion, appel) sont INDÉPENDANTS, et une ligne de diff
  porte son ton en plus de sa couleur par `SessionDiffText.toneLabel`.
  `[test: foldsAndDiffs]`
- Une question `ask` est mise en évidence et DÉPLIÉE d'emblée ; la visionneuse
  n'offre AUCUN geste de réponse — lire, plier/déplier, faire défiler seulement.
  `[test: askHighlighted]`
- Les arguments d'un appel déplié se lisent en clé/valeur (`IOSToolArgumentsView`,
  lecture partagée `ToolArguments`), jamais en JSON brut : hiérarchie indentée
  (retrait `@ScaledMetric`), éléments de liste numérotés dès 1, booléens « oui »/« non »,
  clés dans l'ordre de l'appel, libellés français pour read, write, edit, bash,
  grep et glob, valeurs « code » à chasse fixe, le reste en police système.
  « Aucun argument » / « Arguments illisibles » ; le JSON brut reste replié derrière
  « Afficher le détail brut ». Une valeur longue montre un EXTRAIT de 4 lignes ou
  280 caractères suivi de « Afficher plus » : c'est une troncature de CONTENU
  voulue, faite par le noyau, sans aucun `lineLimit`. `[test: toolArgumentsAreFields]`
- Un ajout d'un run vivant s'ajoute sans relire la session : une seule lecture
  initiale, puis le flux de cette session. `[test: additionsDoNotReload]`
- Le fil ne colle au bas que tant que l'utilisateur n'a pas remonté, et le
  bouton « Revenir au direct » recolle sans geste. `[test: followPolicy]`
- Sous l'en-tête : « Chargement de la session… » jusqu'à la fin de la lecture, et
  pendant une reconstruction, puis le fil, ouvert sur sa FIN, ou l'état vide —
  jamais une zone muette. `[test: threadShowsLoadingUntilRead]`
- Une session sans message affiche « Session vide », jamais un chargement sans
  fin. `[test: emptySessionIsExplicit]`
- La recette `suivi` fait arriver trois messages : au bas, ils s'affichent sans
  geste ; remonté, la position ne bouge pas. `[test: followRecipeKeepsFollowPolicy]`
- L'état du run passe de vivant à terminé sans rouvrir la session, par la
  fonction partagée `ConsoleStatus.of(run:)`. `[test: runStatusTransition]`
- Le fil est monté hors de la section Sessions depuis une simple source : le
  même composant rend le même fil, preuve qu'il est réutilisable.
  `[test: componentIsReusable]`
- Aucune taille de police en points ni `lineLimit` numérique dans le fil : les
  lignes se replient, comme les blocs de code d'`IOSMarkdownView`.
  `[garde: design-ios/AC-7]`
- Le libellé d'accessibilité d'une ligne dit ce qu'elle affiche, dans son ordre :
  feature, état, étape, dépôt, heure — un morceau absent de l'écran est absent du
  libellé. `[test: sessionRowLabelSaysWhatRowShows]`
- Le symbole d'étape occupe une colonne de largeur fixe (`IOSMetrics.phaseIconWidth`,
  mise à l'échelle par `@ScaledMetric`) : les titres des lignes partagent la même
  abscisse à toute taille de texte. `[test: phasesRecipeShowsEveryPhase]`
- Chaque rangée a une marge verticale `IOSMetrics.rowVerticalPadding` mise à
  l'échelle (`@ScaledMetric`) et s'empile (icône et textes, puis puce) quand
  elle ne tient pas sur une ligne. `[test: longTitleSplitsAboveItsControls]`
- Le filtre de projet est un menu dont le libellé visible est la valeur choisie,
  entière à toute taille de texte (repliée, jamais tronquée) ; VoiceOver annonce
  « Projet, <valeur> ». `[test: sessionFilterSaysProjectThenItsValue]`

## Session OMP (feature `ios-session-omp`)

- L'écran porte le titre de navigation `ConsoleSection.session.title` et pose tout
  son contenu sur `iosPanel()`, ancré en haut sous le titre dans ses huit états
  servis (jamais centré verticalement) — seul le composant d'état de connexion
  plein écran est hors du panneau ; le seul défilement est celui du fil de
  conversation. `[capture: iphone-session-light]`
- L'écran couvre NEUF états : non connecté (le composant d'état de connexion
  partagé, en plein écran sans état servi, en bandeau au-dessus du dernier état
  conservé), chargement, aucune session, lancement, arrêt en cours, session vive,
  arrêtée, interrompue, échec — décidés par la fonction pure
  `IOSSessionOmpModel.surface(connection:hosted:)`. `[test: surfaceFollowsClientAndHosted]`
  `[test: sessionOmpKeepsHostedOffline]`
- L'en-tête porte le nom du dépôt servi (`projectName`) et la pastille du mot
  d'état (`stateLabel`) ; un état inconnu du client vaut `idle`, jamais une
  invention. `[test: surfaceFollowsClientAndHosted]`
- Le lancement n'est offert que hors d'une session en marche (ni en lancement, ni
  en arrêt) : l'écran n'ouvre la feuille que sous `model.canLaunch`.
  `[test: launchAvailability]`
- La relance est réservée à `dead`, l'arrêt à `launching|running` — parité avec
  les règles du Mac. `[test: relaunchAndStopAvailability]`
- Le composeur n'est actif qu'en marche, sans dialogue en attente et sur un texte
  non blanc ; le mot de la cause est affiché tel quel.
  `[test: composerAvailability]`
- Un envoi appelle `prompt` une seule fois ; le champ se vide sur succès et reste
  rempli sur échec, le message servi affiché en bandeau.
  `[test: sendPromptCallsOnce]`
- Les quatre formes de dialogue et l'annulation passent par la feuille
  RÉUTILISÉE de Projet : choix simple, confirmation, réponse libre, édition d'un
  texte prérempli. `[test: fourDialogForms]`
- Un choix simple répond `kind:"value"` avec l'option choisie, en un seul appel ;
  le dialogue quitte la file servie, donc la feuille se referme.
  `[test: selectDialogAnswersWithValue]`
- « Annuler » répond `kind:"cancelled"` ; un `hosted` sans dialogue referme la
  feuille. `[test: cancellationAnswersAndClears]`
- À l'apparition, l'écran relit l'état servi ; un dialogue posé pendant la
  déconnexion redevient la tête de la file et donc tranchable.
  `[test: reconnectRestoresDialogs]`
- Le fil est le composant RÉUTILISÉ de la section Sessions
  (`IOSSessionThreadView`), monté sur le fichier servi ; aucun geste d'écriture
  dans le fil. `[test: componentIsReusable]`
- Le fil se lit et s'abonne dès que l'écran le monte, et s'arrête quand il
  disparaît. `[test: hostedThreadStartsWhenSynced]`
- L'arrêt appelle la route une fois et l'état servi passe à `stopped`.
  `[test: stopCallsRouteOnce]`
- L'écran de section est capturé tel quel, en clair et en Dynamic Type maximum.
  `[capture: iphone-session-light]` `[capture: iphone-session-dark-ax]`
- Aucune taille de police en points, aucun `lineLimit` numérique, aucun
  `onTapGesture` : les mêmes gardes typographiques que les autres sections.
  `[garde: design-ios/AC-7]`

## La feuille Connexion (feature `connexion-ios-feuille-intrusive-et-sans`)

- La feuille ne s'ouvre d'elle-même que sans jeton ou quand le Mac refuse le
  jeton (`ConnectionSheetMode.autoPresents`) : jamais pendant la lecture du
  trousseau, jamais pour un appareil appairé, même si le Mac est injoignable —
  l'Accueil reste alors dans son état dégradé « Mac injoignable — … ».
  `[test: pairedConnectedNeverAutoPresents]` `[test: pairedUnreachableStaysClosed]`
- Le mode de la feuille vient du statut d'appairage, pas de l'état de connexion :
  lecture, non appairé (refusé ou non), connecté, déconnecté.
  `[test: noTokenAutoPresentsUnpaired]` `[test: pairedNotConnectedIsDisconnected]`
- Jeton refusé : message « Le Mac ne reconnaît plus cet appareil… », champ du
  code et adresse connue préremplie. `[test: refusedAutoPresentsWithPrefill]`
- Seul le mode non appairé focalise le champ du code ; sur un appareil appairé,
  aucun champ n'a le focus et le clavier ne se lève pas. `[test: pairedModesNeverFocus]`
- L'adresse du Mac ne s'affiche qu'UNE fois : le libellé d'état de la feuille
  (`ConnectionText.sheetState`) n'en porte aucune. `[test: connectedStateWithoutAddress]`
- Aucune adresse affichée ne porte de zone d'interface (`%en0`), adresse
  manuelle comprise : la rangée « Effacer » et le préremplissage du mode refusé
  passent par `ClientAddress.display`, qui délègue à `ClientEndpoint`.
  `[test: zonedMacAddressShownWithoutZone]`
- Déconnecté : « Réessayer » et la modification de l'adresse dans un groupe
  `DisclosureGroup` replié à chaque ouverture ; l'identifiant
  `connection.addressEdit` est posé sur l'étiquette, jamais sur le groupe (il
  écraserait ceux du contenu). `[test: retrySuccessTurnsConnected]`
- « Oublier ce Mac » passe par une confirmation posée SUR le bouton (bulle sur
  iPad), puis la feuille reste ouverte en mode non appairé.
  `[test: forgetConfirmationWords]` `[test: forgottenIsUnpaired]`
- La ligne d'aide nomme le chemin réel du code sur le Mac. `[test: codeHelpNamesTheMacPath]`
- Le code se saisit comme on veut : tiret, espaces et casse ignorés, I et L lus 1,
  O lu 0 (Crockford) ; le message de format nomme les seules lettres refusées
  (U). `[test: lookalikeLettersArmPairing]` `[test: malformedCodeNamesTheRealAlphabet]`
- Pendant l'appairage, « Appairage en cours… » s'affiche sous « Appairer », désactivé
  jusqu'à la réponse ; le champ du code est déclaré code à usage unique
  (`.textContentType(.oneTimeCode)`). `[test: pairingInFlightDisarmsPair]`
- Un appairage réussi se lit dans `ConnectionPairingOutcome` : `.paired` ferme le
  flux de bienvenue, un refus garde le message sous le champ.
  `[test: successfulPairingFinishesTheFlow]` `[test: refusedPairingKeepsTheMessage]`
- « Utiliser cette adresse » est inactif sur un champ vide ou blanc ; « Effacer »
  a une cible d'au moins 44 × 44 pt portée par son étiquette, sans bordure, pour
  que toucher l'adresse n'efface rien. `[test: saveAddressNeedsText]` `[test: minimumTargetIsFortyFour]`

## Les feuilles (feature `feuilles-ios-presentation-et-depots`)

- Sur iPad, une feuille au contenu long (Contrat, feuille de session, fiche d'un
  souvenir) est une feuille « page » (`iosPageSheet()`), plus de 600 pt de contenu ;
  « Piloter un projet » et « Lancer une session OMP » gardent la
  largeur du formulaire (580 pt) et une hauteur qui suit leur contenu
  (`iosFittedSheet(contentHeight:)`), à 64 pt au plus sous le dernier élément ; la
  Bienvenue prend, comme la Connexion, la taille par défaut du formulaire. Sur
  iPhone, rien ne change : feuille pleine hauteur, même haut, pleine largeur, et
  aucun `presentationDetents`. Avant la première mesure, la hauteur idéale est
  absente, jamais nulle : la feuille n'est pas écrasée. `[test: fittedSheetIdealHeight]`
- Dans « Piloter un projet » et « Lancer une session OMP », un dépôt est désigné
  par son seul nom de dossier, suivi de son parent entre parenthèses seulement
  s'il a un homonyme (`KanbanLaunchRepos.choices`, vue partagée `IOSRepoRows`) ;
  aucun chemin, texte de couleur normale (jamais bleu lien). Le dépôt choisi porte
  une coche SF Symbol masquée à VoiceOver, qui annonce le nom et l'état
  « sélectionné », jamais « coche » ni « ✓ ». `[test: repoRowLabels]`
- Un chemin du Mac affiché par l'app iOS s'abrège en `~/…` relativement au
  dossier personnel que le Mac publie (`components.homeDirectory`), jamais deviné
  sur l'appareil ; un chemin hors de ce dossier reste absolu, un Mac antérieur
  laisse les chemins absolus. `[test: threadRowsAbbreviateMacHome]`
- La feuille Souvenir, la fiche d'une carte et le dialogue d'OMP sont des `Form`
  groupés (`.formStyle(.grouped)`), une section par bloc, sans panneau, carte,
  filet ni défilement maison ; la feuille de session pose son seul en-tête en
  section groupée, à la hauteur mesurée de son contenu, au-dessus du fil partagé
  inchangé (`IOSSessionThreadView`). « Piloter un projet » et « Nouvelle
  feature » restent les `Form` qu'ils étaient. `[capture: iphone-pipelines-fiche-*]`
  `[capture: iphone-nouvelle-feature-*]`
- Dans « OMP vous demande », l'option choisie porte la coche SF Symbol `checkmark`
  (accent, masquée à VoiceOver, trait « sélectionné »), jamais le caractère « ✓ ».
  `[garde: ios-finitions-composants/AC-2]`
- La réponse libre d'« OMP vous demande » (forme éditeur) est un champ vertical :
  3 lignes à vide, il grandit jusqu'à 8 lignes puis défile dans le champ
  (`IOSMetrics.dialogAnswerLines`), sans hauteur en points.
  `[garde: ios-finitions-composants/AC-5]`

## Gestes et retours natifs (feature `ios-gestes-et-retours-natifs`)

- « Tirer pour actualiser » remplace tout bouton ↻ de barre : la liste de
  Pipelines (iPhone, et ses états chargement, magasin absent, vide), son kanban
  iPad et la Mémoire en mode Liste se relisent quand on tire le contenu vers le
  bas (`.refreshable`) ; l'indicateur système reste jusqu'à la fin de la
  relecture. Hors connexion, rien n'est lu. Accueil, Sessions, Projet, Session
  OMP et Statistiques n'ont pas de tirage (⌘R y reste).
  `[garde: ios-gestes-et-retours-natifs/AC-2]`
- Le graphe de la Mémoire ne se tire pas (canevas pan/zoom) : il se relit à
  chaque passage en mode Graphe ; le graphe, le vide ou l'erreur déjà affichés
  restent jusqu'à la réponse, sans repasser par le chargement.
  `[test: graphRereadsOnEveryPassWithoutLoading]`
- Sur iPad avec clavier, ⌘R « Actualiser » relit l'écran courant ; il figure
  dans la liste des raccourcis (⌘ maintenu) et reste sans effet sous une
  feuille. `[test: refreshCommandIsListedAsActualiser]`
- La barre de la Mémoire porte trois boutons au plus, dans les deux modes :
  « Sommaire », la bascule Graphe/Liste et l'antenne Connexion ; le champ de
  recherche système n'en est pas un. `[garde: ios-gestes-et-retours-natifs/AC-4]`
- Un appui long sur une carte Pipelines, une carte ou rangée de l'Accueil, une
  rangée Sessions ou une rangée Mémoire ouvre un menu contextuel natif qui ne
  propose que les actions déjà offertes ailleurs pour cet élément dans son état
  courant (hors connexion ou geste en vol, les commandes disparaissent), plus
  « Copier » ; « Arrêter… » est destructif, en dernier, et passe par la même
  confirmation que la fiche. Aucune action par balayage.
  `[test: contextMenuOffersOnlyCurrentActions]` `[garde: ios-gestes-et-retours-natifs/AC-5]`
- « Copier » met dans le presse-papiers le lien de la PR s'il existe (http ou
  https), sinon le texte principal de l'élément ; aucune confirmation visible.
  `[test: copyCopiesPullRequestLinkElseMainText]`
- Chaque commande envoyée au Mac joue un retour haptique système à sa RÉPONSE,
  jamais à l'envoi : succès → `.success`, échec (hors connexion compris) →
  `.error`. Un seul point de pose (`RootView`) ; aucun réglage d'app, seul le
  réglage Haptique d'iOS s'applique. `[test: commandOutcomeFollowsTheMacResponse]`
  `[test: outcomeMapsToSystemFeedback]` `[garde: ios-gestes-et-retours-natifs/AC-8]`
- Le texte de la visionneuse de session, du contrat et de la fiche d'un
  souvenir est sélectionnable (sélection système et « Copier ») ; les libellés
  de boutons ne le sont pas. `[garde: ios-gestes-et-retours-natifs/AC-9]`
- Sur iPad avec pointeur, chaque carte ou rangée touchable montre l'effet de
  survol système `.highlight`, à la forme d'une carte (`iosHoverEffect()`).
  `[garde: ios-gestes-et-retours-natifs/AC-10]`
- Quand « Réduire les animations » est actif, un défilement automatique se fait
  d'un saut ; sinon il reste animé (`IOSMotion.scrollAnimation`).
  `[test: scrollJumpsWhenReduceMotionIsOn]` `[garde: ios-gestes-et-retours-natifs/AC-11]`
- Un symbole purement décoratif n'est jamais lu par VoiceOver ; l'état qu'il
  portait passe par le contrôle : « replié »/« déplié » pour les bascules du
  fil, trait sélectionné pour l'option choisie de « Répondre ».
  `[garde: ios-gestes-et-retours-natifs/AC-12]`

## Erreurs du Mac (feature `ios-erreurs-serveur-lisibles`)

- Un SEUL traducteur, `IOSMacErrorText` (`OMPConsoleIOS/IOSMacErrorText.swift`),
  range tout échec d'appel au Mac en une cause distinguable ; Mémoire (liste,
  recherche, graphe), Sessions, Statistiques et Pipelines l'appellent, aucune ne
  relit le détail brut. Un message = la cause, puis un remède propre à cette cause,
  au vouvoiement, en commençant par ce qui s'est passé puis ce qu'il faut faire ;
  jamais de nom de service ni de commande, jamais d'URL, d'adresse, de JSON, de
  `"detail"` ni de code HTTP. `[test: everyCauseHasItsOwnRemedy]`
  `[test: macErrorsSayWhatHappenedThenWhatToDo]`
- 404 « route inconnue » et 404/405 hors contrat : « Fonction indisponible : app Mac
  trop ancienne. » — « Mettez à jour OMP Console sur le Mac, puis réessayez. » Seul le message EXACT
  « route inconnue » vaut cette cause. `[test: macOutdatedOn404And405]`
- Connexion refusée, délai dépassé, Mac non connecté : « Mac injoignable. » — la
  cause les couvre tous, et la raison système (qui peut nommer l'hôte) n'est jamais
  affichée. Seule la Mémoire (liste, recherche, graphe) passe par
  `IOSMacFailure.ofMemoryRead`, qui distingue le délai dépassé (« Délai dépassé : le
  Mac a mis trop de temps à répondre. ») et range tout 404 de ses routes en « app Mac
  trop ancienne ». `[test: refusedConnectionIsMacUnreachable]`
  `[test: otherSectionsKeepTheirTransportWording]`
- 503 : « Service indisponible sur le Mac. » — le texte amont relayé (adresse,
  JSON du service) est écarté. `[test: unavailableHidesRelayDetail]`
- 403 : « Action refusée par le Mac. », distincte du 401 et du 404/405.
  `[test: forbiddenIsRefused]`
- 500, corps illisible, code ou statut inattendu : « Le Mac a rencontré une erreur. »,
  sans aucun détail technique. `[test: serverAndUnreadableAreGeneric]`
- Un refus métier (400, 409, 404 autre que « route inconnue ») affiche le motif
  rédigé par le Mac, sans code HTTP ; un motif vide ou qui contient une URL, un
  JSON ou un nombre à trois chiffres cède au message générique.
  `[test: businessRefusalKeepsTheMacMotive]`
- 401 : AUCUN message de section. Le parcours de jeton révoqué parle seul — secret
  effacé du trousseau, retour à l'appairage, « Jeton révoqué » à l'écran.
  `[test: unauthorizedHasNoMessage]`
- Le graphe de la Mémoire garde sa distinction : `outdated_service` dit « serveur
  mémoire trop ancien sur le Mac » puis « Mettez à jour OMP Console sur le Mac, puis
  réessayez. », sans nom de service ; un 404 dit « app Mac trop ancienne ». La liste
  et la recherche ne l'ont pas : un 503 qui cite une réponse 404/405 de mem0-http
  reste « Service indisponible sur le Mac ». `[test: graphKeepsOutdatedDistinction]`
  `[test: memoryNeverClaimsOutdated]`
- Chaque échec de CHARGEMENT propose « Réessayer » (cible de 44 pt), qui relance le
  chargement qui a échoué : Mémoire, graphe, Statistiques, visionneuse de session,
  catalogue des modèles et lecture des PR d'une carte. Un geste d'écriture (arrêt,
  fusion, réponse) affiche son message sans « Réessayer » : rejouer un POST n'est
  pas un chargement. `[test: memoryRetryShowsData]` `[test: viewerRetryReadsAgain]`
  `[test: statsRetryShowsBoard]` `[test: catalogRetryLoadsModels]`
  `[test: graphRetryShowsGraph]`
- Chaque section affiche le message du traducteur partagé, prouvé par une doublure
  du Mac. `[test: memoryShowsTranslatedFailure]` `[test: viewerShowsTranslatedFailure]`
  `[test: statsShowsTranslatedFailure]` `[test: catalogShowsTranslatedFailure]`
  `[test: graphShowsTranslatedFailure]`
- Tous les textes visibles de l'app et de ConsoleCore vouvoient, y compris hors
  `*Text.swift` ; seules les fixtures de conversation et de contrat simulés en sont
  exemptées. `[garde: ios-redaction-vouvoiement/AC-8]`
- Les deux écrans d'erreur de la Mémoire s'obtiennent sans Mac :
  `-memoire.recipe injoignable` (liste) et `-memoire.recipe service-ancien` (graphe).
  `[test: macErrorsSayWhatHappenedThenWhatToDo]`
