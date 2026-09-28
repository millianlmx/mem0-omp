# Projet — mem0-omp

Document tenu par la commande /project (plugin omp-mem0-req) sur la branche `omp-project` : réécrit à chaque changement d'état, ne l'édite pas à la main.

**Statut** : en cours — segment 2/5 « Lire le réel »
**Avancement** : 2/15 feature(s) fusionnée(s)

## But

Une salle de contrôle native macOS (SwiftUI) pour les pipelines mem0-omp : voir d'un coup d'œil — kanban, session d'un run, fichiers et diffs — et conduire de bout en bout des projets, features et runs, de tous les dépôts, sans terminal. Pour millian, qui pilote seul ce dépôt et ses features.

## Fonction

L'app lit le magasin d'état partagé (~/.omp/agent/pipeline/ : running, history, lots, projects, inbox, audit) et les sessions OMP (JSONL), affiche un kanban des features et des runs, la conversation d'un run, les fichiers du worktree et leurs diffs, et agit : livraisons (réponses à une question, texte à un run vivant), commandes au pilote du lot (lancer une feature, arrêter un run, valider un jalon, ajouter ou retirer une feature), hébergement d'une session OMP (mode RPC) pour le cadrage et la conduite d'un projet. Notifications macOS, barre de menus, statistiques par run/feature/projet, mémoire mem0, suivi PR/CI et terminal intégré complètent la salle de contrôle. OMP et l'extension restent la source de vérité et l'unique conducteur des lots : l'app observe, commande et rend, elle ne réimplémente ni la chaîne ni le plan.

## Plan

### Segment 1 — Fondations (fusionné)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `socle-app-swift` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/36 | opencode-go/deepseek-v4.1-flash | Poser la coquille de l'app macOS SwiftUI dans le dépôt, sous un dossier de premier niveau (nom de travail : omp-console) : paquet SwiftPM, cible macOS, fenêtre avec navigation latérale entre les futures vues (Kanban, Sessions, Fichiers, Projet). Un script assemble un bundle .app minimal (Info.plist, identifiant) pour rendre possibles la barre de menus et les notifications des features suivantes, et scripts/check.sh gagne une section « App Swift » exécutée sous macOS seulement — Ubuntu dit « non exécuté » au lieu d'échouer. La réussite se prouve par swift build et swift test verts, l'app lancée à la main qui s'ouvre, et check.sh vert sur macOS comme sur Ubuntu. |
| 2 | `canal-de-commande-extension` | fusionnée | https://github.com/millianlmx/mem0-omp/pull/34 | opencode-go/deepseek-v4.1-flash | Donner à un client externe (l'app) le moyen de faire agir le pilote d'un lot sans passer par le TUI : des fichiers de commande atomiques dans le magasin d'état, consommés par le process propriétaire du lot, pour lancer une feature, arrêter un run, valider un jalon (v/y), répondre à une question en vol, et ajouter ou retirer une feature. Chaque commande porte un identifiant et reçoit un accusé écrit dans le magasin (acceptée, ou refusée avec son motif) ; une commande rejouée n'a pas d'effet double, et un client muet ne bloque jamais le pilote. La réussite se prouve par des tests node --test du format, de la consommation, des refus et de l'idempotence, plus un aller-retour manuel où une commande déposée par un script fait démarrer un maillon réel. |

### Segment 2 — Lire le réel (en cours)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `client-magasin-etat` | PR ouverte | https://github.com/millianlmx/mem0-omp/pull/37 | opencode-go/deepseek-v4.1-flash | La couche de données de l'app : des modèles Swift typés et tolérants du magasin d'état (running, history, lots, projects, inbox, audit) qui ignorent les fichiers temporaires et ne montrent jamais un JSON partiel, la résolution des chemins (MEM0_PIPELINE_STATE_DIR sinon ~/.omp/agent/pipeline), et une veille des répertoires (FSEvents ou DispatchSource) qui pousse les changements au lieu de sonder en boucle. La réussite se prouve par des tests sur des fixtures réelles du dépôt (entrées running et history, lot, projet) et sur les cas dégradés : fichier tronqué, propriétaire mort, répertoire absent. |
| 2 | `lecteur-de-sessions-omp` | lancée | — | opencode-go/deepseek-v4.1-flash | Lire les fichiers de session OMP (JSONL, parfois écrits pendant la lecture) et en tirer un modèle de conversation : messages utilisateur et assistant, pensées, appels d'outil (nom, arguments, résultat, diffs), modèle et usage. La lecture reprend au dernier octet lu pour ne jamais re-parser un fichier entier, reconnaît les sessions de sous-agents et ne casse pas sur une ligne partiellement écrite. La réussite se prouve par des tests sur des sessions réelles du poste, dont une en cours d'écriture, et par un rendu fidèle vérifié sur une session de pipeline. |
| 3 | `client-rpc-omp` | lancée | — | opencode-go/deepseek-v4.1-flash | Héberger une session OMP depuis l'app : lancer omp --mode rpc (et rpc-ui), parler le protocole JSONL (négociation de version, réponses corrélées, événements, dialogues extension_ui_request) et garder le process vivant et réconcilié (arrêt propre, réponses aux dialogues, reconnexion). C'est ce client qui permettra à l'app de conduire un projet et d'ouvrir des sessions sans terminal. La réussite se prouve par un aller-retour réel prompt → événements → dialogue répondu contre un vrai omp --mode rpc, et par les cas d'échec : binaire absent, process tué, frame illisible. |

### Segment 3 — Les vues (à venir)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `kanban-des-pipelines` | à venir | — | opencode-go/deepseek-v4.1-flash | La vue principale : les features des lots et les runs de tous les dépôts en colonnes par état (en attente, en cours, question en vol, PR ouverte, fusionné, échec), chaque carte montrant dépôt, maillon, modèle, durée écoulée et URL de PR, avec sélection vers la session et les fichiers. La réussite se prouve par une comparaison avec /pipelines sur le même état (mêmes features, mêmes états) et par le traitement des cas dégradés : lot illisible, propriétaire mort, entrées en double — dits au lieu d'être inventés. |
| 2 | `visionneuse-de-session` | à venir | — | opencode-go/deepseek-v4.1-flash | Rendre la conversation d'un run comme la vue de session du panneau : messages, appels d'outil repliables, diffs colorés, question ask en évidence, et suivi d'un run vivant en relisant seulement les octets neufs. La lecture vient du lecteur de sessions ; la vue ne réécrit jamais la session. La réussite se prouve par une session de pipeline réelle affichée fidèlement (mêmes faits que le TUI) et par une session en cours qui se met à jour sans recharger tout le fichier. |
| 3 | `visionneuse-de-fichiers-et-diffs` | à venir | — | opencode-go/deepseek-v4.1-flash | Parcourir les fichiers d'un worktree de feature (et du dépôt principal) et voir le diff git du travail en cours, plus la lecture du contrat .omp/pipeline/contract.md et du document PROJECT.md. L'arbre vient de git (fichiers suivis et non suivis), le diff est celui du worktree contre sa base, et rien n'est modifié par cette vue. La réussite se prouve par le diff d'une feature réelle affiché à l'identique de git diff, et par un arbre qui correspond au contenu du worktree sur disque. |

### Segment 4 — Les gestes (à venir)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `reponses-et-jalons` | à venir | — | opencode-go/deepseek-v4.1-flash | Répondre et agir depuis l'app : répondre à une question en vol (choisir une option ou écrire un texte libre) par les livraisons du magasin, envoyer un texte à un run vivant, valider ou refuser un jalon (v/y), lancer une feature, arrêter un run — chaque geste passant par le canal de commande et son accusé affiché. L'app n'écrit jamais l'état du lot : elle commande, et montre ce que le pilote a répondu. La réussite se prouve par un run réel en attente débloqué depuis l'app et un jalon validé depuis l'app qui fait avancer la chaîne sans toucher au TUI. |
| 2 | `notifications-et-barre-de-menus` | à venir | — | opencode-go/deepseek-v4.1-flash | Prévenir sans regarder : notifications macOS (une question attend une réponse, un jalon est à valider, une feature a échoué, une PR du projet est fusionnée) déclenchées au plus une fois par évènement, et une barre de menus affichant les compteurs (runs en cours, runs en attente) qui ouvre la fenêtre. La réussite se prouve par des notifications déclenchées sur de vrais évènements du magasin et un compteur qui correspond à l'état affiché. |
| 3 | `conduite-de-projet` | à venir | — | opencode-go/deepseek-v4.1-flash | Conduire un projet entier depuis l'app, sans session OMP ouverte à la main : héberger une session /project (client RPC) et y jouer le rôle de l'utilisateur — dire « fin » au cadrage, valider ou corriger le plan, répondre aux escalades, donner les jalons — puis suivre les segments, les PR et les fusions jusqu'à la fin du projet. Le pilote reste dans l'extension et PROJECT.md reste le document de vérité, lisible dans l'app ; l'app ne réimplémente ni les règles du plan ni la conduite des lots. La réussite se prouve par un projet réel conduit du cadrage à la première PR sans ouvrir un terminal, et par une question de maillon qui arrive bien dans l'app. |

### Segment 5 — Les extras (à venir)

| # | Feature | État | PR | Modèle | Intention |
|---|---|---|---|---|---|
| 1 | `statistiques` | à venir | — | opencode-go/deepseek-v4.1-flash | Montrer ce que ça coûte et ce que ça dure : tokens d'entrée et de sortie, modèle, durée et nombre de tours par run, agrégés par feature et par projet, lus dans les sessions et le magasin. La réussite se prouve par les totaux d'une feature réelle qui correspondent à ses sessions et un agrégat de projet égal à la somme de ses features. |
| 2 | `memoire-mem0` | à venir | — | opencode-go/deepseek-v4.1-flash | La mémoire du projet dans l'app : rechercher les souvenirs, voir le sommaire du projet et l'état du service, en s'adressant au service mem0-http comme le fait le plugin mémoire. La réussite se prouve par une recherche qui ramène les mêmes souvenirs que l'outil en session, et par l'indisponibilité du service dite clairement au lieu d'être masquée. |
| 3 | `suivi-pr-ci` | à venir | — | opencode-go/deepseek-v4.1-flash | Suivre les PR jusqu'au vert : statuts des checks (check ubuntu-latest, check macos-latest, release-simulation), ouverture de la PR dans le navigateur, et fusion depuis l'app avec confirmation — le geste de l'utilisateur, jamais automatique. La réussite se prouve par des statuts conformes à gh pr checks sur une PR réelle et par une fusion depuis l'app qui fait avancer le segment suivant d'un projet. |
| 4 | `terminal-integre` | à venir | — | opencode-go/deepseek-v4.1-flash | Un terminal dans l'app pour reprendre la main : ouvrir une session OMP interactive (PTY) dans une fenêtre, éventuellement sur le worktree d'une feature, la lire et y écrire. La réussite se prouve par une session OMP interactive réelle ouverte, qui répond et se ferme proprement depuis l'app. |
