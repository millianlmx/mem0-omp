# Recette de design — coque iOS

La recette PROPRE À L'iOS. Elle ne recopie pas les règles macOS : elle les cite
par renvoi, en nommant leur source, puis énonce ce qui est particulier au
tactile. Chaque règle est vérifiable : une puce se termine par au moins un
marqueur `[test: <fonction>]` (une fonction de
`omp-console/ios/OMPConsoleIOSTests/`), `[capture: <motif>]` (un nom produit par
`scripts/ios-shots.sh`) ou `[garde: design-ios/AC-<n>]` (un test de
`test/design-ios.test.ts`). Une puce sans marqueur fait échouer la garde.

## Héritage de la coque macOS (par renvoi)

- Le verre (Liquid Glass) est réservé à la couche que le SYSTÈME dessine — barre
  latérale, barre de navigation, feuilles ; les contenus restent opaques. Règle
  posée par `omp-console/README.md` §intro et appliquée par
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

## Surfaces (S-1)

- Trois surfaces seulement, et rien d'autre : `iosPanel()` pour le panneau d'un
  écran, `iosCard()` pour la carte d'un état vide, `iosBanner(tone:)` pour un
  bandeau. `[garde: design-ios/AC-1]`
- Chaque écran des sept sections pose son contenu sur `iosPanel()`. `[capture: iphone-*-light]`
- Le panneau porte sa MARGE EXTÉRIEURE : `IOSMetrics.margin` (16 pt compact, 24 pt
  régulier), fixe — c'est la marge de l'écran, le rembourrage intérieur seul suit
  Dynamic Type. Aucun panneau ne touche un bord de l'écran, et aucun appelant
  n'ajoute la sienne. `[capture: iphone-*-light]`
- Un seul défilement VERTICAL par écran : Pipelines, Sessions et Mémoire (Liste)
  posent leur panneau dans un `ScrollView(.vertical)` et n'emploient aucune
  `List` ; le panneau prend la hauteur de son contenu. Le mode Graphe de la
  Mémoire fait exception : son canevas garde ses gestes, hors de tout
  défilement. `[capture: iphone-kanban-light]`
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
  Seule exception : la PLAGE de hauteur d'un champ de saisie vertical
  (`IOSMetrics.needLines`, 3…8 lignes du champ « Besoin ») — rien n'y est
  tronqué, le champ défile. `[garde: design-ios/AC-7]`

## Marges et cibles tactiles

- Marge horizontale de 16 pt en largeur compacte, 24 pt en largeur régulière
  (ou inconnue) : `IOSMetrics.margin(_:)` en est l'unique règle.
  `[test: marginFollowsSizeClass]`
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

## Dynamic Type maximum (S-7)

- À `accessibility-extra-extra-extra-large`, aucun texte n'est tronqué ni
  chevauché : aucune hauteur fixe, aucune largeur figée, aucune troncature.
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
- En largeur COMPACTE (iPhone portrait), les voies s'empilent verticalement dans
  le défilement de l'écran ; en largeur RÉGULIÈRE (iPad), elles sont côte à côte
  dans un défilement horizontal posé dans ce défilement vertical — toutes les
  voies montrées et toutes leurs cartes restent atteignables.
  `[capture: iphone-kanban-light]`
- En largeur COMPACTE, une voie sans carte n'est pas montrée — « Pas commencées »
  comprise — et sans aucune voie à montrer l'écran affiche le mot partagé
  `KanbanText.noPipeline`. `[test: compactHidesEveryEmptyLane]`
- En largeur COMPACTE, « Livrées » et « Arrêtées » s'ouvrent repliées à chaque
  visite : leur en-tête, un bouton de 44 pt (`pipelines.lane.<voie>.header`,
  valeur d'accessibilité « replié »/« déplié »), les déplie et les replie ;
  l'état n'est pas mémorisé d'une visite à l'autre. `[test: compactFoldsTerminalLanes]`
- En largeur RÉGULIÈRE (iPad), l'ardoise est inchangée : voies permanentes même
  vides, voies terminales dépliées. `[test: regularKeepsLanesUnchanged]`
- L'écran ne fabrique aucune donnée : Mac injoignable sans instantané, il affiche
  un état déconnecté explicite (`PipelinesText.noSnapshot`) ; un magasin vide
  affiche le mot partagé `KanbanText.noPipeline`. `[test: noSnapshotWordIsNotTheStoreWord]`
- La feuille d'une carte offre les gestes de la carte via la règle d'aiguillage de
  `KanbanActionPresentation` ; une carte d'historique n'offre aucun geste et le
  dit. `[test: historyCardOffersNothing]`
- « Fusionner » demande une confirmation AVANT tout effet et la ligne de PR
  servie porte le `headOid` exigé par la route de fusion.
  `[garde: design-ios/AC-8]`
- La cible tactile minimale des cartes, des options de question et des boutons de
  geste est celle du HIG (44 pt). `[test: minimumTargetIsFortyFour]`
- Le bouton « Rafraîchir » (`pipelines.refresh`, ⌘R au clavier de l'iPad), placé
  avant « Nouvelle feature », demande au Mac de relire l'état des PR sur GitHub ;
  il n'est actif que connecté et hors relecture, et montre un indicateur
  d'activité pendant la relecture. Aucun message : le retour visible est le
  libellé des cartes. `[test: refreshAvailability]`
- Sur l'ardoise iOS, les clôtures d'étape d'une feature de lot ne font aucune
  carte à part, et une feature réduite à ses clôtures fait une seule carte
  « Terminée ». `[test: historyClosuresJoinTheirFeatureOnIOS]`
- Dans la feuille « Nouvelle feature », le sélecteur de dépôt montre le NOM du
  dossier (jamais un chemin absolu), complété par les derniers segments du
  parent pour les seuls homonymes ; la valeur lancée reste la racine complète.
  `[test: repoChoicesUseFolderNames]`
- Le mot « Dépôt » n'apparaît qu'une fois ; sans dépôt choisi, le sélecteur
  affiche l'invite « Choisir un dépôt » et « Lancer » est inactif.
  `[capture: iphone-nouvelle-feature-vide-light]`
- Les champs titre et besoin portent les libellés VoiceOver « Titre » et
  « Besoin », sans libellé visible ajouté.
  `[capture: iphone-nouvelle-feature-choisi-light]`
- Le champ besoin montre 3 lignes à vide, grandit jusqu'à 8 lignes puis défile
  dans le champ, sans second défilement de feuille.
  `[capture: iphone-nouvelle-feature-rempli-light]`
- La feuille se capture par le crochet de recette `-pipelines.recipe`
  (`vide`, `choisi`, `rempli`), sans appairage. `[test: pipelinesRecipeResolves]`
- La fiche d'une carte affiche son titre complet une seule fois, dans le corps, sur
  autant de lignes qu'il faut ; la barre porte « Pipelines » et « Fermer » (44 pt).
  `[capture: iphone-pipelines-fiche-*]`
- « Reprendre » est l'action principale (bouton plein, accent) ; « Arrêter… » est
  secondaire, rouge à contour, et passe par sa confirmation.
  `[capture: iphone-pipelines-fiche-actions-*]`
- Le modèle s'affiche par son nom lisible du catalogue servi par le Mac, l'identifiant
  brut sinon. `[test: modelNameFromCatalog]`
- Chaque élément de la fiche porte son propre identifiant `pipelines.card.sheet.*`.
  `[test: sheetIdentifiersAreDistinct]`

## L'Accueil (S-10, S-11)

- L'écran porte le titre de navigation `ConsoleSection.home.title`, en grand titre
  par défaut comme les autres sections, dans ses cinq états : aucune bande vide
  sous la barre, et le bouton retour reste dans la barre titrée quand le tableau
  de bord défile. `[capture: iphone-home-light]`
- L'Accueil iOS montre un seul de ses cinq états : déconnecté, « OMP absent sur
  le Mac », chargement, premiers pas, tableau de bord — dans cet ordre de
  priorité. `[test: resolvePriority]`
- Les faits du tableau de bord viennent de la MÊME dérivation que macOS, depuis
  la fixture partagée `HomeParity` : mêmes cartes, mêmes natures, mêmes
  libellés. `[test: parityFacts]`
- La ligne « Accueil » porte le badge du nombre d'attentes (la fonction partagée
  `HomePresentation.attentionCount`), et rien quand il vaut zéro. `[test: badgeCounts]`
- Chaque ligne de la liste racine est UN bouton d'accessibilité (`ios.section.<section>`)
  dont le libellé est le titre de la section, suivi de « , N en attente » quand le
  badge est visible — la même valeur alimente le badge et le libellé.
  `[test: sectionRowLabelFollowsShownBadge]`
- Le badge ne dépend pas de la section affichée : la liste racine de l'iPhone le
  montre au retour de n'importe quel écran, la barre latérale de l'iPad aussi
  quand une autre section est sélectionnée ; aucune autre ligne n'en porte.
  `[test: homeRowCarriesPositiveCount]`
- La feuille de bienvenue ne s'affiche qu'à la première ouverture de l'Accueil
  (préférence `home.welcomeSeen`), avant la feuille de connexion. `[test: welcomeDue]`
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
- Une livraison récente ouvre sa PR par `openURL` seulement quand l'URL est
  exploitable. `[test: deliveredLinks]`
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
- Avant le premier instantané, l'Accueil affiche un chargement explicite, jamais
  un vide muet. `[test: loadingBeforeFirstSnapshot]`
- L'état de l'Accueil suit l'ardoise publiée sans geste de l'utilisateur.
  `[test: liveUpdates]`
- Aucun bandeau de notifications, et l'app ne demande jamais l'autorisation
  d'en afficher. `[test: noNotificationsBanner]`
- Les cinq états et les trois feuilles se capturent par le crochet de recette
  `-home.recipe`, sans écran fabriqué. `[capture: iphone-home-light]`
- L'Accueil reste lisible en Dynamic Type maximum, comme le reste de la coque.
  `[capture: iphone-home-dark-ax]`
- Les rangées « En cours » et « Livrées récemment » restent sur une ligne aux
  tailles standard et s'empilent (titre, puce, bouton) aux tailles
  d'accessibilité ; leurs boutons sont bornés à `accessibility3` et leur texte à
  `accessibility4` (au-delà, un mot comme « Implémentation » est coupé en deux).
  `[test: rowsStackFromTheFirstAccessibilitySize]`
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
  trop de temps à répondre. » puis « Réessaie dans un instant. » et « Mac injoignable. »
  et son remède sont deux bandeaux distincts, chacun avec « Réessayer ». Les autres
  sections gardent « Mac injoignable. ». `[test: listTimeoutSaysDelayExceeded]`
- Face à une app Mac antérieure (qui ignore la route de page), la liste dit
  « Fonction indisponible : app Mac trop ancienne. » puis « Mets à jour OMP Console sur
  le Mac, puis réessaie. », sans code HTTP ni JSON ; aucun code de compatibilité.
  `[test: listOnOlderMacSaysMacOutdated]`
- Le détail d'un souvenir ouvre une feuille : la ligne de contexte (date relative,
  étiquettes), le texte intégral tel qu'il est stocké, identifiant et portée sous
  « Détails techniques » — jamais de bouton d'écriture. `[test: detailRendersTheFiveFacts]`
- Le texte d'un souvenir s'affiche TEL QU'IL EST STOCKÉ (`Text(verbatim:)`), dans la
  liste, la feuille et la fiche du graphe : aucun rendu Markdown, aucun titre raccourci
  — un `*` reste un `*`. Seuls les autres contenus (documents projet, contrat, réponses) passent
  par `IOSMarkdownView`. `[test: listDetailAndGraphSheetShowTheStoredText]`
- « Sommaire » reste toujours visible ; indisponible, il est grisé et un toucher
  montre la raison dans une bulle — jamais un bouton masqué ni muet.
  `[test: summaryReasonNamesEachUnavailableCase]`
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
- Le canevas fait EXCEPTION à « aucune couleur hors `ConsoleTone` » : sa palette est
  celle du noyau PARTAGÉ (`MemoryGraphStyle.hue(for:)`, `Color.accentColor`,
  `.secondary`, `.primary`), exactement comme la coque macOS — une seule peinture,
  deux coques. `[capture: iphone-memoire-graphe-light.png]`
- Le graphe ne montre que la portée du PROJET OUVERT — la même que la liste, résolue
  par le Mac —, tous ses souvenirs, sans borne en nombre (seule une charge au-delà de
  16 Mio est retirée et annoncée « Graphe partiel »). Sans projet ouvert, il dit
  « Aucun projet ouvert » et ne dessine aucun canevas. `[test: graphWithoutProjectSaysNoProject]`
- Un graphe qui dépasse son délai dit « Délai dépassé : le Mac a mis trop de temps à
  répondre. » puis « Réessaie dans un instant. » avec « Réessayer », jamais « Mac injoignable » ;
  le panneau commence en haut, sous la barre de navigation, dans tous les états.
  `[test: graphTimeoutSaysDelayExceeded]`

## La section Statistiques (feature `ios-statistiques`)

- Une carte par feature LISTÉE, dans l'ordre du plan : le slug, puis une ligne par
  grandeur (modèle, temps passé, tours, tokens envoyés, tokens reçus). `[test: statsCardsSumTheListedFeatures]`
- « Tokens envoyés » compte TOUT ce qui part vers le modèle : entrée hors cache + cache lu + cache écrit, sur chaque carte et sur la ligne « Total du projet » ; « Tokens reçus » reste la sortie. La fenêtre macOS, elle, garde l'entrée hors cache. `[test: statsSentTokensCountTheCache]`
- La ligne « Total du projet » somme les features LISTÉES — ni les features
  masquées, ni un autre projet — et rien d'autre n'y entre. `[test: statsTotalSumsOnlyListedFeatures]`
- Le sélecteur de projet, la ligne de total et la mention des features masquées
  sont visibles des deux appareils, aux deux apparences. `[capture: ipad-stats-dark]`
- Les durées et les totaux se recalculent à l'instant de RENDU
  (`TimelineView(.periodic(from:by:))`) : un run vivant fait avancer sa durée d'un
  milliseconde par milliseconde et par run vivant, sans un octet de trafic.
  `[test: statsDurationsAdvanceWithLiveRuns]`
- Sept états à part entière, jamais un écran vide : chargement (« Chargement des
  statistiques… »), dégradé (hors `.connected`, bandeau `attention`), erreur
  (bandeau `danger` + « Réessayer »), aucun projet, bascule vers un autre projet,
  projet sans feature listée, tableau. `[test: statsSurfacesCoverEveryState]`
- Le sélecteur de projet nomme le projet CHOISI et se tient en tête des états
  tableau, vide et bascule — pendant la lecture d'un autre projet, il reste
  au-dessus du chargement ; le premier chargement, le dégradé, l'erreur et
  « Aucun projet » n'en ont pas. `[test: statsProjectSwitchKeepsHeaderAboveLoading]`
- Depuis l'état « Aucune donnée pour ce projet », on change de projet : le
  sélecteur est au-dessus de la carte vide, et choisir un projet qui a des données
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
  y compris une session lancée hors coque. `[test: listGroupsByDay]`
- Un `Picker` de projet restreint la liste AVANT le groupement, donc les
  en-têtes de jour se recalculent ; « Tous les projets » la restitue entière.
  `[test: projectFilter]`
- Le fil de la visionneuse vient du modèle de lignes PARTAGÉ
  (`SessionRowBuilder`) : mêmes lignes que macOS, prouvées sur la fixture
  `SessionParity`. `[test: parityRows]`
- Une session illisible ou tronquée affiche son motif (bandeau `danger`
  au-dessus du fil) ou la note de réécriture — jamais un écran vide muet.
  `[test: unreadableAndTruncated]`
- L'écran de section est capturé tel quel, sans écran fabriqué.
  `[capture: iphone-sessions-light]`
- Les plis d'une ligne (réflexion, appel) sont INDÉPENDANTS, et une ligne de diff
  porte son ton en plus de sa couleur par `SessionDiffText.toneLabel`.
  `[test: foldsAndDiffs]`
- Une question `ask` est mise en évidence et DÉPLIÉE d'emblée ; la visionneuse
  n'offre AUCUN geste de réponse — lire, plier/déplier, faire défiler seulement.
  `[test: askHighlighted]`
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

## Session OMP (feature `ios-session-omp`)

- L'écran porte le titre de navigation `ConsoleSection.session.title` et pose tout
  son contenu sur `iosPanel()`, ancré en haut sous le titre dans ses neuf états
  (jamais centré verticalement) ; le seul défilement est celui du fil de
  conversation. `[capture: iphone-session-light]`
- L'écran couvre NEUF états : déconnecté (bandeau `attention`, aucun geste),
  chargement, aucune session, lancement, arrêt en cours, session vive, arrêtée,
  interrompue, échec — décidés par la fonction pure
  `IOSSessionOmpModel.surface(state:hosted:)`. `[test: surfaceFollowsClientAndHosted]`
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
- Déconnecté : « Réessayer » et la modification de l'adresse dans un groupe
  `DisclosureGroup` replié à chaque ouverture ; l'identifiant
  `connection.addressEdit` est posé sur l'étiquette, jamais sur le groupe (il
  écraserait ceux du contenu). `[test: retrySuccessTurnsConnected]`
- « Oublier ce Mac » passe par une confirmation posée SUR le bouton (bulle sur
  iPad), puis la feuille reste ouverte en mode non appairé.
  `[test: forgetConfirmationWords]` `[test: forgottenIsUnpaired]`
- La ligne d'aide nomme le chemin réel du code sur le Mac, et le message de format
  nomme l'alphabet Crockford. `[test: codeHelpNamesTheMacPath]` `[test: malformedCodeNamesTheRealAlphabet]`
- « Utiliser cette adresse » est inactif sur un champ vide ou blanc ; « Effacer »
  a une cible d'au moins 44 × 44 pt portée par son étiquette, sans bordure, pour
  que toucher l'adresse n'efface rien. `[test: saveAddressNeedsText]` `[test: minimumTargetIsFortyFour]`

## Erreurs du Mac (feature `ios-erreurs-serveur-lisibles`)

- Un SEUL traducteur, `IOSMacErrorText` (`OMPConsoleIOS/IOSMacErrorText.swift`),
  range tout échec d'appel au Mac en une cause distinguable ; Mémoire (liste,
  recherche, graphe), Sessions, Statistiques et Pipelines l'appellent, aucune ne
  relit le détail brut. Un message = la cause, puis un remède propre à cette cause,
  en tutoyant ; jamais d'URL, d'adresse, de JSON, de `"detail"` ni de code HTTP.
  `[test: everyCauseHasItsOwnRemedy]`
- 404 « route inconnue » et 404/405 hors contrat : « Fonction indisponible : app Mac
  trop ancienne. » — mets à jour OMP Console sur le Mac. Seul le message EXACT
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
  mémoire trop ancien » (mem0-http), un 404 dit « app Mac trop ancienne ». La liste
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
