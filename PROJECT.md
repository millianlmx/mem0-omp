# Projet — mem0-omp

Document tenu par la commande /project (plugin omp-mem0-req) sur la branche `omp-project` : réécrit à chaque changement d'état, ne l'édite pas à la main.

**Statut** : en cours — segment 6/6 « Le graphe, et parler à OMP »
**Avancement** : 11/13 feature(s) fusionnée(s)

## But

Une salle de contrôle de poche : depuis son iPhone et son iPad — au canapé comme en déplacement via son tunnel personnel — Millian voit et conduit les pipelines, les projets et la mémoire de tous ses dépôts sans ouvrir un terminal et sans être devant le Mac. Le Mac reste le moteur : OMP Console y exécute omp, podman, la pile mémoire et les conducteurs ; l'app iOS est son poste de commande à distance.

## Fonction

Une app iOS universelle (iPhone + iPad, iOS 26, SwiftUI et Liquid Glass natif) se couple à la coque macOS — découverte Bonjour sur le réseau local, ou adresse saisie à la main pour un tunnel personnel — après un appairage par code, le secret restant au trousseau des deux côtés. Elle rend les mêmes faits que la coque macOS dans une interface tactile — Accueil des questions et jalons, Pipelines, Projet, Session OMP (discussion comprise), Sessions, Mémoire, Statistiques — et pousse les mêmes gestes (répondre, valider un jalon, lancer ou arrêter un run, lancer une feature, conduire un projet, parler à une session hébergée, ouvrir une PR, fusionner avec confirmation) vers l'API locale de la coque macOS, seule à écrire le magasin et à héberger les process. Tout vit dans ce dépôt : une cible Swift partagée (modèles du magasin, vocabulaire, contrat d'API) et une app Xcode sous omp-console/ios/ ; Terminal, Fichiers et les notifications hors application (aucun relais push) restent hors périmètre.

## Plan

### Segment 1 — Fondations : le noyau partagé (fusionné)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `noyau-partage-console` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/67 | opencode-go/deepseek-v4.1-flash | Extraire de la coque macOS une cible bibliothèque ConsoleCore sans dépendance AppKit ni UIKit : les modèles du magasin (Store/), le vocabulaire et les libellés figés (les *Text.swift), les tons d'état, et le contrat de l'API distante (types Codable, codes d'erreur, numéro de version du protocole). La coque macOS consomme cette cible sans changer de comportement — sa suite Swift reste verte, et les gardes du dépôt (section « App Swift » de scripts/check.sh, tests de docs) connaissent la nouvelle cible. La réussite se prouve par swift build et swift test verts pour macOS et par une cible qui ne compile aucune API AppKit/UIKit. |

### Segment 2 — Le Mac expose, l'app iOS naît (fusionné)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `api-distante-du-console` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/71 | opencode-go/deepseek-v4.1-flash | La coque macOS expose sur le réseau local une API pour un client distant, portée par les couches existantes (Store/, Actions/, ConductorPool, MemoryService) : annonce Bonjour, appairage par code affiché dans l'app avec un secret au trousseau et une liste d'appareils révocables, lecture (instantané du magasin, sessions et leur flux, documents de projet, statistiques, mémoire en relais de mem0-http y compris le graphe) et gestes (répondre à un ask, valider un jalon, lancer/arrêter un run, lancer une feature, conduire un projet, prompt et dialogues d'une session hébergée, PR et fusion confirmée). Un flux pousse les changements du magasin et des sessions vivantes au lieu du sondage, et rien n'est servi sans jeton d'appareil. La réussite se prouve par un client réel qui s'appaire, lit un run vivant et le fait avancer par un geste, et par le refus de toute requête sans jeton. |
| 2 | `coque-ios` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/69 | opencode-go/deepseek-v4.1-flash | L'app iOS naît dans le dépôt : un projet Xcode sous omp-console/ios/ (universel iPhone + iPad, iOS 26, groupes de fichiers synchronisés pour que les features suivantes ajoutent des écrans sans se disputer le .xcodeproj), branché sur ConsoleCore, avec la navigation adaptative de la coque macOS (barre latérale sur iPad, piles sur iPhone) et les sept sections prévues en écrans d'attente nommés. Les gardes et la CI apprennent à la compiler (xcodebuild via DEVELOPER_DIR, destinations simulateur) sans casser la règle CLT-only du macOS, et la documentation dit comment la lancer et l'installer. La réussite se prouve par un build CI vert, l'app lancée au simulateur (captures des sept écrans sur iPhone et iPad) et une installation sur un appareil réel. |

### Segment 3 — L'app iOS parle au Mac (fusionné)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `client-distant-ios` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/72 | opencode-go/deepseek-v4.1-flash | La couche réseau de l'app iOS : découverte Bonjour de la coque macOS, saisie manuelle d'une adresse pour un tunnel personnel, appairage par code avec le secret au trousseau iOS, reconnexion avec repli, et client typé du contrat (lecture, gestes, flux temps réel) monté dans un modèle observable unique. L'écran d'état dit la vérité — Mac absent, hors réseau, jeton révoqué, version d'API incompatible — au lieu de masquer l'échec. La réussite se prouve sur appareil ou simulateur contre la vraie coque macOS : appairage, coupure puis reprise des deux côtés, et état affiché conforme à la réalité. |
| 2 | `design-ios` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/73 | opencode-go/deepseek-v4.1-flash | La couche visuelle iOS : les équivalents des trois surfaces de la coque macOS (panneau, carte, bandeau) adaptés aux HIG tactiles, la typographie et les tons des statuts, les tailles et marges iPhone/iPad, les états vides et d'erreur — pour que l'app ait l'air d'un produit Apple sérieux au lieu d'un portage brut, exigence déjà exprimée pour la coque macOS. Le verre (Liquid Glass) ne sert que là où le système le dessine ; les contenus restent opaques. La réussite se prouve par des captures clair/sombre d'iPhone et d'iPad qui passent la recette esthétique, et par des libellés partagés avec la coque macOS — aucun texte réinventé. |

### Segment 4 — Le pilotage depuis iOS (fusionné)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `ios-accueil` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/76 | opencode-go/deepseek-v4.1-flash | La section Accueil sur iOS : les cartes d'attention (question en vol, jalon à valider, run en cours, « Reprendre », livraisons récentes), la feuille « Répondre » (options d'un ask vivant ou texte libre), la feuille Contrat, et les bandeaux (préparation, accusé de commande). Chaque carte agit par l'API — l'app iOS n'écrit jamais l'état du lot. La réussite se prouve sur un run réel en attente : répondre depuis l'iPhone fait repartir le run, et l'Accueil montre les mêmes faits que la coque macOS au même instant. |
| 2 | `ios-pipelines` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/75 | opencode-go/deepseek-v4.1-flash | La section Pipelines sur iOS : l'ardoise des features et runs de tous les dépôts (les cinq voies, les onze colonnes, les cartes) et ses gestes — répondre, valider un jalon, lancer, arrêter, reprendre, ouvrir la PR, fusionner avec confirmation — plus la feuille « Nouvelle feature… » (dépôt, modèles, titre, besoin). Rien n'est inventé : ce que la carte montre vient du magasin, ce que le geste fait vient de l'API de la coque macOS. La réussite se prouve en lançant une feature depuis l'iPad et en la voyant avancer jusqu'à la PR, sans toucher au Mac. |
| 3 | `ios-projet` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/74 | opencode-go/deepseek-v4.1-flash | La section Projet sur iOS : le plan (segments, features, états), le suivi des PR du projet, les escalades à trancher, et « Piloter un projet… » — démarrer un cadrage, valider le plan, répondre aux questions depuis l'iPhone ou l'iPad. Le document PROJECT.md et les règles du plan restent la vérité, l'app ne les réimplémente pas. La réussite se prouve en conduisant un vrai projet du cadrage à sa première PR depuis l'iPad. |

### Segment 5 — Lire la mémoire et les sessions (fusionné)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `ios-memoire` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/77 | opencode-go/deepseek-v4.1-flash | La section Mémoire sur iOS : recherche dans les souvenirs, sommaire du projet, lecture d'un souvenir, état du service et de la pile — en s'adressant au Mac qui relaie mem0-http, comme la coque macOS. La recherche est filtrée comme en session et l'indisponibilité du service est dite clairement au lieu d'être masquée. La réussite se prouve par une recherche qui ramène les mêmes souvenirs que l'outil en session, et par l'état dégradé affiché sans masquer la cause. |
| 2 | `ios-sessions` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/79 | opencode-go/deepseek-v4.1-flash | La section Sessions sur iOS : le sélecteur de toutes les sessions OMP (par jour, par projet) et la visionneuse — messages, pensées, appels d'outil repliables, diffs colorés, question ask en évidence, suivi d'un run vivant sans recharger le fichier entier. Le rendu de conversation et le suivi direct sont posés ici comme composants iOS réutilisables par la section Session OMP. La réussite se prouve par une session de pipeline réelle affichée avec les mêmes faits que la coque macOS, et une session en cours qui se met à jour en direct. |
| 3 | `ios-statistiques` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/78 | opencode-go/deepseek-v4.1-flash | La section Statistiques sur iOS : la consommation des runs (tokens, modèle, durée, tours) agrégée par feature et par projet, lue par l'API à partir des sessions et du magasin. Les totaux doivent être ceux de la coque macOS pour le même état. La réussite se prouve sur une feature réelle dont les totaux égalent la somme de ses sessions, et sur un agrégat de projet égal à la somme de ses features. |

### Segment 6 — Le graphe, et parler à OMP (en cours)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `ios-memoire-graphe` | à venir | — | opencode-go/deepseek-v4.1-flash | Le mode graphe de la section Mémoire sur iOS : les nœuds-étiquettes et les arêtes de proximité calculés côté Mac (même route que la coque macOS), dessinés en Canvas avec pan, zoom, sélection d'un souvenir et de ses liens — lecture seule. La réussite se prouve par le même graphe que la coque macOS pour la même base, manipulable au doigt sur iPhone et iPad (captures). |
| 2 | `ios-session-omp` | à venir | — | opencode-go/deepseek-v4.1-flash | La section Session OMP sur iOS : choisir un dépôt, lancer ou arrêter une session hébergée par le Mac, envoyer un prompt, répondre à ses dialogues, et lire la conversation en direct (le rendu de la section Sessions est réutilisé). Le process reste hébergé par la coque macOS (SessionHost/ConductorPool), l'app iOS n'exécute rien. La réussite se prouve par une session réelle pilotée depuis l'iPad : un prompt envoyé, un dialogue répondu, la réponse affichée en direct. |
