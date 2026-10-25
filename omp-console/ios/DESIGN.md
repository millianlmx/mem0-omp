# Recette de design — coque iOS

La recette PROPRE À L'iOS. Elle ne recopie pas les règles macOS : elle les cite
par renvoi, en nommant leur source, puis énonce ce qui est particulier au
tactile. Chaque règle est vérifiable : une puce se termine par au moins un
marqueur `[test: <fonction>]` (une fonction de
`omp-console/ios/OMPConsoleIOSTests/`), `[capture: <motif>]` (un nom produit par
`scripts/recette/ios-shots.sh`) ou `[garde: <slug>/AC-<n>]` (un test Node de
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
- Tout libellé durable affiché vient d'un vocabulaire : celui de `ConsoleCore`
  (`PipelineServerText`, `MemoryText`…), mot pour mot celui de macOS, ou un
  `*Text.swift` de l'app ; un seul message franchement provisoire vit dans
  `omp-console/ios/OMPConsoleIOS/IOSText.swift`. `[garde: design-ios/AC-4]`
  `[garde: design-ios/AC-5]`

## Navigation (feature `ios-navigation-onglets-adaptables`)

- Sur iPhone, la racine est une barre d'onglets native (`TabView`, style
  `.sidebarAdaptable`) de cinq onglets — Accueil, Pipelines, Projet, Audit,
  « Plus » — et chaque onglet ouvre son écran directement, sans bouton retour.
  `[test: compactTabsAreFourSectionsThenPlus]`
- L'onglet « Plus » est une liste titrée « Plus » qui pousse Statistiques et
  Mémoire ; leur bouton retour ramène à la liste. `[test: plusListsTheOtherSections]`
- Sur iPad, la barre latérale est visible dès le lancement, titrée « OMP Console »,
  avec les groupes Pilotage (Accueil, Pipelines, Projet, Audit, Statistiques —
  servis par le serveur de pipelines du VPS) puis Consultation (Mémoire, servie par
  la mémoire du même serveur) ; la barre d'onglets du haut n'apparaît que lorsqu'on masque la
  barre latérale. `[test: groupedSections]`
- Chaque onglet garde son état (écran poussé, position de défilement) quand on
  change d'onglet ; passer de l'iPad plein écran à une largeur compacte range
  Statistiques et Mémoire sous « Plus », et inversement.
  `[test: sizeClassChangeMovesBetweenPlusAndSidebar]`
- `-section <x>` ouvre l'onglet de la section ; sur iPhone, Statistiques et
  Mémoire s'ouvrent déjà poussées dans « Plus ».
  `[test: launchRoutesEachSectionOnIPhone]`
- L'app ne parle qu'au serveur du VPS, jamais à un Mac : les écrans de pilotage
  portent, à gauche, le bouton du serveur de pipelines (`ios.server.open`), et la
  Mémoire ouvre la même feuille par « Relier le serveur ».
  `[garde: serveur-de-pipelines/AC-3]`

## Surfaces (S-1)

- Les surfaces de contenu sont celles de `Design/IOSSurface.swift`, et rien
  d'autre : `iosGroupedList()` pour la liste d'un écran, `iosBareListRow()` pour
  la rangée qui porte sa propre surface, `iosCard()` pour une carte,
  `iosBanner(tone:)` pour un bandeau, `iosPanel()` pour le panneau d'une surface
  hors liste. `[garde: design-ios/AC-1]`
- Un écran en liste — Accueil, Pipelines, Projet, Audit, Statistiques, Mémoire
  (mode Liste) — est une `List` de style `.insetGrouped`, posée par
  `iosGroupedList()` : fond `systemGroupedBackground` jusqu'aux bords de l'écran,
  rangées en `secondarySystemGroupedBackground`, en-têtes de section et
  séparateurs du système, aucun `Divider()` tracé à la main, aucun panneau autour
  des groupes. Les cinq écrans de pilotage partagent un seul cadre,
  `IOSHarnessScreen`. `[garde: design-ios/AC-2]` `[capture: iphone-*-dark]`
- Une carte n'existe que là où le contenu est une carte. C'est la carte élevée,
  `iosCard(raised: true)` : fond `secondarySystemGroupedBackground`, distinct du
  fond groupé de l'écran (`systemGroupedBackground`) en clair comme en sombre ;
  les écrans de pilotage n'en posent aucune : leurs éléments sont des rangées.
  `[test: raisedCardStandsOutOfTheGroupedBackground]`
- Dans une liste, un bandeau ou l'état de connexion en bandeau occupent une
  rangée nue, `iosBareListRow()` : sans fond ni séparateur du système, sans marge
  latérale, 8 pt entre deux rangées nues consécutives. `[capture: iphone-home-dark]`
- `iosPanel()` est réservé aux surfaces hors liste : le mode Graphe de la
  Mémoire. `[capture: iphone-memoire-graphe-*]`
- Le panneau porte sa MARGE EXTÉRIEURE : `IOSMetrics.margin` (16 pt compact, 24 pt
  régulier), fixe — c'est la marge de l'écran, le rembourrage intérieur seul suit
  Dynamic Type. Aucun panneau ne touche un bord de l'écran, et aucun appelant
  n'ajoute la sienne. `[capture: iphone-*-light]`
- Un seul défilement par écran : la `List` de l'écran ; le mode Graphe de la
  Mémoire, hors de tout défilement, garde les gestes de son canevas.
  `[capture: iphone-kanban-light]`
- Un bandeau est une surface de CONTENU : teinte du ton à 12 % d'opacité, rayon
  12, jamais un fond rouge plein écran. L'échec du dernier échange avec le serveur
  de pipelines s'affiche ainsi en tête de liste. `[garde: design-ios/AC-2]`
- La pastille porte l'identifiant d'accessibilité `ios.status` et combine ses
  enfants (le mot se lit, la couleur le double) ; l'état d'une feature en est
  une. `[garde: design-ios/AC-2]`
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
  Une exception : le texte d'un souvenir dans la liste de la Mémoire, plafonné
  par la fonction nommée `IOSMetrics.memoryRowLines(_:)` (texte intégral dans la
  feuille). `[garde: design-ios/AC-7]`
- Toute durée (`ConsoleFormat.duration`, `PipelineServerText.duration`) s'affiche
  en chiffres à chasse fixe (`.monospacedDigit()`) : délai de livraison et
  médianes par étape des Statistiques. `[garde: ios-finitions-composants/AC-6]`

## Marges et cibles tactiles

- Marge horizontale de 16 pt en largeur compacte, 24 pt en largeur régulière
  (ou inconnue) : `IOSMetrics.margin(_:)` en est l'unique règle.
  `[test: marginFollowsSizeClass]`
- Colonne de lecture : sur une fenêtre large, chaque écran en liste pose son
  contenu dans une colonne de 720 pt marges comprises (`IOSMetrics.readableWidth`,
  surface de 672 pt), centrée, mise à l'échelle par Dynamic Type
  (`iosReadableWidth()`, posé par `iosGroupedList()`) ; sous ce plafond, rien ne
  change. Le mode Graphe reste pleine largeur.
  `[test: readableWidthKeepsTheColumnUnder700]`
- Les marges et les rembourrages des surfaces grandissent avec Dynamic Type
  (`@ScaledMetric`), jamais une constante figée seule. `[capture: iphone-*-light-ax]`
- Cible tactile minimale : 44 pt (`IOSMetrics.minimumTarget`), la valeur du HIG
  iOS/iPadOS. Un bouton texte sans style porte cette cible sur son libellé —
  `.frame(minWidth:minHeight: IOSMetrics.minimumTarget)` puis
  `.contentShape(Rectangle())`, style automatique conservé.
  `[test: minimumTargetIsFortyFour]`
- Aucun contrôle maison : ni `Button`, ni `onTapGesture` dans les sources de
  l'app — les seules cibles sont les lignes de `List` et la barre de navigation
  du système. `[garde: design-ios/AC-8]`
- Clavier de l'iPad : ⌘1…⌘6 ouvrent les sections dans l'ordre affiché par la
  barre latérale (Accueil, Pipelines, Projet, Audit, Statistiques, Mémoire), ⌘R
  relit l'écran courant, ⌘F active la recherche de l'écran qui en a une. Les huit
  commandes vivent dans la barre des menus de l'iPad (menu Présentation) avec
  leur libellé français, toutes avec ⌘ seul : ⎋ et ↩ restent aux feuilles. Sous une feuille, une alerte ou un
  `confirmationDialog`, elles sont sans effet. `[test: keyboardShortcutsFollowTheSidebar]`

## Accessibilité et langue (feature `accessibilite-et-localisation-ios-residu`)

- Un symbole décoratif, toujours doublé d'un texte visible qui porte le sens
  (icône du serveur non relié, symbole d'un état vide), est masqué à VoiceOver
  par `.accessibilityHidden(true)` sur l'`Image` : aucun élément `Image` lu sous
  un nom de symbole (« Search Document »). Un symbole porteur de sens sans texte
  visible porte un libellé français (le bouton du serveur, `Label` de
  `PipelineServerText.open`). `[capture: iphone-home-light]`
- L'app parle français, sa langue de développement, et anglais sur un appareil
  (ou une langue d'app, Réglages › OMP Console) réglé en anglais — décision du
  2026-10-25, qui remplace « française seulement » (feature `localisation-apps`).
  Le projet garde `developmentRegion = fr` et déclare `knownRegions = (fr, en,
  Base)` ; l'app et son widget déclarent `CFBundleLocalizations` (fr, en). Les
  libellés fournis par iOS (« Masquer la barre latérale », « Coller », bouton
  retour) suivent la même langue. `[test: appIsLocalizedInEnglish]`
  `[garde: localisation-apps/AC-4]`
- Chaque libellé passe par `L10n` (`ConsoleCore/Design/L10n.swift`) : sa clé est
  la phrase française du `*Text.swift`, sa traduction vit dans la table anglaise
  unique `ConsoleCore/Resources/en.lproj/Localizable.strings`, embarquée dans
  l'app avec le bundle de ressources de `ConsoleCore`. Restent en français à
  dessein : les phrases Siri et le titre de l'intent (littéraux App Intents figés
  par `scripts/app-intents/attendus.json`) et les identifiants d'accessibilité
  `ios.…`. `[test: englishTableIsEmbedded]` `[garde: localisation-apps/AC-1]`
  `[garde: localisation-apps/AC-3]`
- Les tests de l'app tournent en français quel que soit le simulateur :
  `scripts/ios-build.sh` passe `-testLanguage fr -testRegion FR` et la
  TestAction du schéma fixe `language = "fr"`. Les recettes simulateur de
  `scripts/recette/` lancent l'app avec `-AppleLanguages (fr)`.
  `[garde: localisation-apps/AC-6]`
- L'icône est légendée « OMP Console » (`INFOPLIST_KEY_CFBundleDisplayName`, Debug
  et Release de la cible app) ; `PRODUCT_NAME` et le bundle restent inchangés,
  pour ne pas perdre l'appairage. `[test: homeScreenNameIsOMPConsole]`

## Identité de l'app (feature ios-identite-app)

Le nom sous l'icône et les langues de l'app sont décrits dans la section précédente ;
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
  `OMPConsoleIOS-Info.plist`) est exactement « OMP Console joint votre serveur de
  pipelines et vos souvenirs quand ils sont sur votre réseau local. » : il vouvoie
  et ne nomme ni le Mac, ni « coque », ni « macOS ». L'app ne déclare aucun service
  Bonjour. Le simulateur n'affiche jamais cette alerte (TN3179) : le texte se prouve
  dans l'app installée.
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
  pour mot celui de macOS (`PipelineServerText.nothingPending`, `.noRun`,
  `.noProject`, `.noAudit`, `.noStats`, `MemoryText.noProjectTitle`) : aucune
  donnée inventée. `[garde: design-ios/AC-3]`
- Le titre d'un écran vient de `ConsoleSection` (ConsoleCore), posé par la barre
  de navigation ; son icône aussi, par `IOSSection.systemImage(of:)`.
  `[garde: ios-finitions-titres-icones/AC-4]`
- Sans serveur relié, les écrans de pilotage disent « Aucun serveur relié » et
  offrent « Relier le serveur… », qui ouvre la feuille du serveur.
  `[capture: iphone-home-light]`
- Un échec du serveur de pipelines s'affiche en bandeau en tête de liste, par la
  phrase de `HarnessFailure.message` (cause, puis remède), jamais le détail brut.
  `[garde: ios-erreurs-serveur-lisibles/AC-8]`
- L'état d'erreur vient d'un chemin RÉEL : le crochet de recette
  `-ios.state error` — jamais une capture fabriquée. `[garde: design-ios/AC-4]`
- Un repli silencieux (section inconnue ⇒ Accueil, sans message) reste
  silencieux ; une valeur inconnue ne devient jamais une erreur.
  `[test: resolveScreenState]`

## États de la mémoire (feature `etats-non-connecte-heterogenes-ios`)

La Mémoire lit la mémoire du serveur du VPS, dont l'adresse et le jeton viennent du
code d'appairage collé dans la feuille Serveur. Aucun Mac sur le chemin.

- Un seul composant, `IOSConnectionStateView` (Design/), dit l'état de la mémoire ;
  ses mots vivent dans `IOSConnectionStateText` et ses identifiants, tous
  préfixés `ios.connexion.`, dans `IOSConnectionStateAccessibility`.
  `[test: connectionIdentifiersAreUniqueAndPrefixed]`
- Le statut présenté est une fonction pure de l'accès (`IOSConnectionStatus.resolve`) :
  « Lecture des réglages… » le temps de lire le trousseau, puis la mémoire reliée,
  ou « Mémoire non reliée ». `[test: statusFollowsTheAccess]`
- « Mémoire non reliée » dit le geste qui relie (coller le code d'appairage dans la
  feuille Serveur), sans nommer de Mac, de version ni d'adresse, et « Relier le
  serveur » ouvre cette feuille. `[test: causeNamesThePairingCode]`
- La Mémoire (liste et graphe) : rien de reçu sans mémoire reliée ⇒ le composant
  seul, hors de la liste (et du panneau du graphe) ; données reçues ⇒ elles restent,
  sous le bandeau, et la Mémoire relit dès qu'un code est collé.
  `[test: offlineWithoutDataIsTheConnectionComponent]` `[test: offlineKeepsTheLastData]`
- Les gestes qui lisent la mémoire (recherche, relecture, choix du projet) restent
  visibles mais inertes tant qu'elle n'est pas reliée. Le champ de recherche, que
  `.disabled` ne grise pas en placement `.automatic`, est rendu inerte.
  `[test: gesturesNeedTheMemory]`

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

- Quarante-huit captures d'écran : 6 sections × {iPhone portrait, iPad portrait} ×
  {clair, sombre} à taille de texte par défaut, plus 6 sections × {iPhone, iPad} ×
  {clair, sombre} en Dynamic Type maximum ; douze de plus pour le mode Graphe de
  la Mémoire. `[garde: design-ios/AC-6]`
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

## Pilotage (serveur de pipelines du VPS)

- Accueil, Pipelines, Projet, Audit et Statistiques lisent le serveur de pipelines
  (omp-harness) directement, par `HarnessModel` : un seul modèle pour l'app, tenu
  à jour par le flux d'événements du serveur, relu en tirant la liste.
  `[garde: design-ios/AC-1]`
- L'Accueil ouvre sur le tableau de bord (`IOSDashboardSections`) : des tuiles
  de KPI (`IOSDashboardKPI`, cartes élevées), puis quatre sections tracées —
  ce qui vous attend par projet, le débit, le coût des agents, la santé —
  teintées par `IOSDataPalette`, chaque graphique en `minHeight`.
  `[garde: accueil-tableau-de-bord/AC-3]`
- L'Accueil est la boîte de l'humain : specs à valider (rendues par
  `IOSMarkdownView`), verdicts, questions en lot, décisions renversables, audits
  à trier, puis les features en cours. `[garde: ios-souvenir-markdown-altere/AC-4]`
- Chaque question de l'Accueil (escalade, décision prise seule, specs, verdict)
  est située par `IOSQuestionPlaceView` (dépôt › feature › étape, demande
  d'origine repliée), sa situation rendue par `IOSContextView`, ses options par
  `IOSChoiceRow` avec leur impact. `[garde: questions-en-contexte/AC-7]`
- Une feature se lit en une rangée : son titre, puis la pastille de son état et
  de son étape (`IOSStatusChip`, ton qui double le mot). `[garde: design-ios/AC-2]`
- Un lancement (feature, projet, audit) choisit son dépôt dans un `Picker`
  natif, parmi les dépôts que le serveur déclare.
  `[garde: ios-finitions-composants/AC-8]`
- Une proposition d'audit retenue porte la coche du symbole système, et le trait
  « sélectionné » pour VoiceOver ; aucun caractère « ✓ ».
  `[garde: ios-finitions-composants/AC-2]`
- « Session en direct » (menu contextuel d'une feature, bouton d'un audit) ouvre une
  feuille « page » à onglets segmentés — Direct, Fichiers, Tests, Frise — dans une
  liste groupée native ; les différences d'un fichier se poussent dans la pile de la
  feuille. Tous ses mots viennent de `MonitoringText` et `PipelineServerText`.
  `[garde: design-ios/AC-5]`
- Les alertes de la veille du serveur sont en tête de l'Accueil, en orange, et chaque
  rangée de feature porte son coût et ses alertes ; Statistiques ajoute la
  consommation, les modèles, les tests instables et la santé du serveur. Toute durée
  y garde ses chiffres à chasse fixe. `[garde: ios-finitions-composants/AC-6]`
- « Suivre sur l'écran verrouillé » démarre la Live Activity de la feature
  (extension `OMPConsoleWidgets`, troisième cible du projet) : écran verrouillé et
  Dynamic Island, symbole et teinte doublés par le texte de l'état.
  `[garde: coque-ios/AC-1]`
- Le widget d'écran d'accueil « Boîte du serveur » (même extension) reprend le badge
  de l'Accueil en grand chiffre à chasse fixe, puis les features vivantes, celles qui
  attendent l'humain d'abord, en orange ; sa date de lecture se lit en bas. Un
  toucher ouvre l'Accueil. `[garde: coque-ios/AC-1]`

## Mémoire (feature `ios-memoire`)

- L'écran Mémoire montre le sommaire d'un projet de la mémoire du serveur, dans
  l'ordre servi — les mêmes souvenirs que la section macOS quand le Mac est relié
  au même serveur, aucun tri local, et « Aucun projet » quand la mémoire n'a encore
  aucun souvenir. Le menu « Choisir le projet » liste les portées, la plus
  récemment écrite en tête ; sans choix, c'est elle qui est lue.
  `[test: memoryFollowsTheClientTheScopeAndTheLoad]`
- La liste se lit PAR PAGES bornées de la seule portée du projet (`MemoryReader`,
  100 souvenirs par page) : arrivé en bas, le pied « Chargement des souvenirs
  suivants… » lit la page suivante de lui-même (défilement continu), jusqu'au dernier
  souvenir, chaque souvenir une seule fois. Plus de troncature ni de ligne de
  troncature. L'échec d'une page suivante s'affiche dans le pied, avec « Réessayer »,
  et garde les lignes déjà lues. `[test: scrollingToTheEndLoadsEveryRowOnce]`
- Un délai dépassé n'est PAS un serveur injoignable : « Délai dépassé : la mémoire a
  mis trop de temps à répondre. » puis « Réessayez dans un instant. », et « Mémoire du
  serveur injoignable. » et son remède, sont deux bandeaux distincts, chacun avec
  « Réessayer ». `[test: listTimeoutSaysDelayExceeded]` `[test: unreachableNeverSaysDelay]`
- Le détail d'un souvenir ouvre une feuille : la ligne de contexte (date relative,
  étiquettes), le texte intégral tel qu'il est stocké, identifiant et portée sous
  « Détails techniques » — jamais de bouton d'écriture. `[test: detailRendersTheFiveFacts]`
- Le texte d'un souvenir s'affiche TEL QU'IL EST STOCKÉ (`Text(verbatim:)`), dans la
  liste, la feuille et la fiche du graphe : aucun rendu Markdown, aucun titre raccourci
  — un `*` reste un `*`. Seuls les autres contenus (les specs d'une feature) passent
  par `IOSMarkdownView`. `[test: listDetailAndGraphSheetShowTheStoredText]`
- Le texte d'un souvenir tient en 3 lignes au plus en largeur compacte et 4 en
  largeur régulière, terminé par « … », quelle que soit la taille de texte ; la
  feuille montre le texte intégral. `[test: memoryRowLinesFollowTheWidth]`
- Chaque rangée a une marge verticale constante ; la date et les
  étiquettes tiennent sur une ligne, jointes par « · », aux tailles standard et
  s'empilent (date, puis étiquettes) aux tailles d'accessibilité.
  `[test: memoryRowContextSplitsIntoSegments]`
- « Sommaire » reste toujours visible ; indisponible (mode Graphe, sommaire déjà
  affiché, recherche en cours), c'est un bouton désactivé du système, sans teinte
  ni bulle.  `[garde: ios-gestes-et-retours-natifs/AC-13]`
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
- Le graphe ne montre que la portée du PROJET CHOISI — la même que la liste —, tous
  ses souvenirs, sans borne en nombre. Sans projet, il dit « Aucun projet » et ne
  dessine aucun canevas. `[test: graphWithoutProjectSaysNoProject]`
- Un graphe qui dépasse son délai dit « Délai dépassé : la mémoire a mis trop de temps
  à répondre. » puis « Réessayez dans un instant. » avec « Réessayer », jamais
  « injoignable » ;
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

## Les feuilles (feature `feuilles-ios-presentation-et-depots`)

- La feuille du serveur de pipelines (`IOSServerSheet`) est un `Form` groupé : le
  code d'appairage (ou l'adresse et le jeton), « Relier », « Oublier ce serveur », et
  l'échec du dernier échange en bandeau, par `HarnessFailure.message`. Un code
  accepté relie aussi la mémoire du serveur.
  `[garde: ios-erreurs-serveur-lisibles/AC-8]`

## Gestes et retours natifs (feature `ios-gestes-et-retours-natifs`)

- « Tirer pour actualiser » remplace tout bouton ↻ de barre : les écrans de
  pilotage et la Mémoire en mode Liste se relisent quand on tire le contenu vers
  le bas (`.refreshable`) ; l'indicateur système reste jusqu'à la fin de la
  relecture. `[garde: ios-gestes-et-retours-natifs/AC-2]`
- La barre de la Mémoire porte trois boutons au plus, dans les deux modes : le menu
  du projet, « Sommaire » et la bascule Graphe/Liste ; le champ de recherche système
  n'en est pas un. `[garde: ios-gestes-et-retours-natifs/AC-4]`
- Un appui long sur une rangée de feature ou une rangée Mémoire ouvre un menu
  contextuel natif qui ne propose que les actions déjà offertes pour cet élément
  dans son état courant ; « Arrêter la feature » est destructif et passe par une
  confirmation. Aucune action par balayage.
  `[garde: ios-gestes-et-retours-natifs/AC-5]`
- Le texte des specs d'une feature, de la fiche d'un souvenir et du direct d'une
  session est sélectionnable (sélection système et « Copier ») ; les libellés de
  boutons ne le sont pas. `[garde: ios-gestes-et-retours-natifs/AC-9]`
- Sur iPad avec pointeur, chaque rangée touchable de la Mémoire montre l'effet de
  survol système `.highlight` (`iosHoverEffect()`).
  `[garde: ios-gestes-et-retours-natifs/AC-10]`
- Un symbole purement décoratif n'est jamais lu par VoiceOver ; l'état qu'il
  portait passe par le contrôle : trait sélectionné pour une proposition d'audit
  retenue. `[garde: ios-gestes-et-retours-natifs/AC-12]`

## Pannes de la mémoire (feature `ios-erreurs-serveur-lisibles`)

- Un SEUL traducteur, `IOSMemoryErrorText` (`OMPConsoleIOS/IOSMemoryErrorText.swift`),
  range toute panne de lecture de la mémoire du serveur en une cause distinguable ;
  la Mémoire (liste, recherche, graphe) l'appelle et ne relit jamais le détail brut.
  Un message = la cause, puis un remède propre à cette cause, au vouvoiement ; jamais
  de nom de service ni de commande, jamais d'URL, d'adresse, de JSON ni de code HTTP.
  `[test: everyReadErrorHasItsCause]` `[test: everyCauseHasItsOwnRemedy]`
  `[test: memoryErrorsSayWhatHappenedThenWhatToDo]`
- Serveur injoignable, délai dépassé, mémoire indisponible (503), jeton refusé
  (401, 403), réponse illisible : cinq causes, cinq remèdes. Un jeton refusé renvoie
  au code d'appairage. `[test: refusedPointsToThePairingCode]` `[test: memoryRefusedTokenSaysSo]`
- Le graphe garde sa distinction : une route graphe absente dit « serveur mémoire
  trop ancien » puis « Mettez à jour le serveur, puis réessayez. » ; la liste et la
  recherche ne le disent jamais. `[test: graphRefusedTokenSaysSo]`
- Chaque échec de CHARGEMENT de la Mémoire propose « Réessayer » (cible de 44 pt),
  qui relance le chargement qui a échoué : liste et graphe. `[test: memoryRetryShowsData]`
  `[test: graphRetryShowsGraph]`
- La Mémoire affiche le message du traducteur. `[test: memoryShowsTranslatedFailure]`
  `[test: graphShowsTranslatedFailure]`
- Tous les textes visibles de l'app et de ConsoleCore vouvoient, y compris hors
  `*Text.swift`. `[garde: ios-redaction-vouvoiement/AC-8]`
- Les deux écrans d'erreur de la Mémoire s'obtiennent sans serveur :
  `-memoire.recipe injoignable` (liste) et `-memoire.recipe service-ancien` (graphe).
  `[test: memoryErrorsSayWhatHappenedThenWhatToDo]`
