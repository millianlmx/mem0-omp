# Journal des versions

## omp-harness 1.35.1 — 2026-11-09

- fix(harness): config.json monté en écriture dans la pile, pour les routes d'administration de l'API (#436) (158218d)

## omp-harness 1.35.0 — 2026-11-09

- feat(harness): usine autonome — file débloquée, pilote pour tous les runs, juge des tests par l'API (#432) (670ae98)
- feat(harness): Moli remplace Obscura comme navigateur de la pile, derrière une porte CDP à jeton (#433) (daafa0b)

## omp-chrome 0.8.0 — 2026-11-09

- feat(harness): Moli remplace Obscura comme navigateur de la pile, derrière une porte CDP à jeton (#433) (daafa0b)

## omp-harness 1.34.0 — 2026-11-09

- feat(poste): mirroir continu du profil Chrome vers obscura-poste, fin des connecteurs (#430) (9913310)

## omp-chrome 0.7.0 — 2026-11-09

- feat(poste): mirroir continu du profil Chrome vers obscura-poste, fin des connecteurs (#430) (9913310)

## omp-harness 1.33.0 — 2026-11-09

- fix(harness): la vigie rend les traces des runners à leur run et ne réserve que des fichiers précis (#425) (281a139)
- feat(harness): réponses au collègue — brouillons, approbation par le poste, état de l'origine (#421) (665d1ae)
- feat(harness): session en graphe (serveur) et carte de décision (#417) (7bda257)

## omp-chrome 0.6.0 — 2026-11-09

- feat(console,chrome): session en graphe dans les apps — carte de question, briefing, onglet Carte et popup (#419) (13b775b)

## omp-harness 1.32.0 — 2026-11-09

- feat(harness): la CI de la forge comme juge de la suite complète (tests.judge: ci) (#415) (9dc6e53)

## omp-harness 1.31.0 — 2026-11-09

- feat(harness): Obscura conteneurisé sur le VPS (socle, agent corpo, QA de /review) (#411) (b402ad3)
- fix(harness): alerte « étape lente » par dépôt, sans durée figée (#408) (86b4901)
- fix(harness): set_modules refuse les artefacts .harness/ (#407) (3efa9e7)
- feat(harness,chrome,console): validation et envoi des réponses proposées (écarter, modifier, valider, envoi par omp-chrome sous empreinte) (#406) (4fb3727)
- fix(harness): reconnaître et prévenir le runner tué faute de mémoire (code 137) (#409) (9d20539)

## omp-chrome 0.5.0 — 2026-11-09

- feat(harness): Obscura conteneurisé sur le VPS (socle, agent corpo, QA de /review) (#411) (b402ad3)
- feat(harness,chrome,console): validation et envoi des réponses proposées (écarter, modifier, valider, envoi par omp-chrome sous empreinte) (#406) (4fb3727)

## omp-harness 1.30.0 — 2026-11-09

- feat(harness,console): veille proactive du poste (job poste-veille, À traiter, notifications) (#404) (85fc129)

## omp-harness 1.29.0 — 2026-11-09

- feat(harness,console): graphe des personnes du poste (GET et PATCH /v1/workstation/people, page Personnes) (#401) (38806f0)

## omp-mem0-req 2.6.0 — 2026-11-09

- feat(req): /demande et outil harness_intake pour la Demande du harness (#393) (bb77448)

## omp-harness 1.28.0 — 2026-11-09

- feat(harness): rouge de base — un échec de la suite complète ne bloque que s'il est nouveau par rapport à main (#398) (c00d360)
- feat(harness): lecture des canaux Gmail, Agenda et Slack par API (#396) (aa20e6d)
- feat(harness): demande, point d'entrée unique en langage naturel (#389) (83877f1)
- feat(harness): socle serveur des canaux Gmail, Agenda et Slack (#388) (f0297b3)

## omp-chrome 0.4.0 — 2026-11-09

- feat(chrome): Demande dans le popup via le service worker (#391) (cffe270)

## omp-harness 1.27.0 — 2026-11-09

- feat(harness): autonomie par paliers par dépôt et type de travail (79201ca)

## omp-harness 1.26.0 — 2026-11-09

- feat(harness): pont corpo ↔ usine, du signalement à l'issue liée (61b0f68)

## omp-harness 1.25.0 — 2026-11-08

- feat(harness,console): preuves de revue, API et rapport de tests (3195d77)

## omp-harness 1.24.0 — 2026-11-08

- feat(console): refonte des apps Mac et iOS — À traiter, une page par feature, hub Système (#372) (ad790d9)

## omp-harness 1.23.0 — 2026-11-08

- feat(harness,console): notifications iOS et Mac actionnables (valider, approuver, ouvrir) (#354) (856b8c1)

## omp-harness 1.22.0 — 2026-11-08

- feat(harness): la vigie — surveillance 24/24, issues caviardées et pipelines de correction pilotés (#343) (9b812d6)
- feat(harness): forges configurables — GitHub, GitLab (glab) ou aucune (#350) (23162b2)
- fix(harness): un découpage attend la validation et le merge de son parent (#339) (cd7cbfb)

## omp-harness 1.21.0 — 2026-11-08

- feat(harness,mem0-rs): observabilité — journaux JSON, /metrics Prometheus, erreurs des clients, sauvegardes distantes (#345) (63a202b)

## omp-mem0-req 2.5.0 — 2026-11-08

- feat(harness,req): planifications récurrentes (runs, audits, issues) (#342) (250d462)
- feat(chrome): gestes de confiance (CDP), iframes et shadow DOM, select/hover/upload/download/navigation (#352) (4968c35)
- feat(harness,chrome,req): demandes et automatisations du poste, plusieurs navigateurs (#349) (2789e0d)

## omp-harness 1.20.0 — 2026-11-08

- feat(harness,req): planifications récurrentes (runs, audits, issues) (#342) (250d462)
- feat(chrome): gestes de confiance (CDP), iframes et shadow DOM, select/hover/upload/download/navigation (#352) (4968c35)
- feat(harness,chrome,req): demandes et automatisations du poste, plusieurs navigateurs (#349) (2789e0d)

## omp-chrome 0.3.0 — 2026-11-08

- feat(chrome): gestes de confiance (CDP), iframes et shadow DOM, select/hover/upload/download/navigation (#352) (4968c35)
- feat(harness,chrome,req): demandes et automatisations du poste, plusieurs navigateurs (#349) (2789e0d)

## omp-mem0-req 2.4.0 — 2026-11-08

- feat(chrome,harness): poste cantonné à sa fenêtre, arrêt d'urgence, contenu des pages non fiable, session et captures visibles (#341) (701a92d)

## omp-harness 1.19.0 — 2026-11-08

- feat(chrome,harness): poste cantonné à sa fenêtre, arrêt d'urgence, contenu des pages non fiable, session et captures visibles (#341) (701a92d)

## omp-chrome 0.2.0 — 2026-11-08

- feat(chrome,harness): poste cantonné à sa fenêtre, arrêt d'urgence, contenu des pages non fiable, session et captures visibles (#341) (701a92d)

## omp-harness 1.18.1 — 2026-11-08

- fix(release): une release se recalcule quand main bouge ; déploiement continu par la branche deploy et commit exposé (#346) (8726ccb)

## omp-harness 1.18.0 — 2026-11-08

- feat(harness,mem0-rs): politique par dépôt — modèles, fournisseurs, identité, compte gh et mémoire cloisonnée (#340) (ec4985b)

## omp-mem0-req 2.3.0 — 2026-11-08

- feat(harness,req): consignes à un run en cours, budget par run, dépôts et rechargement par l'API (#338) (87c1642)

## omp-harness 1.17.0 — 2026-11-08

- feat(harness,req): consignes à un run en cours, budget par run, dépôts et rechargement par l'API (#338) (87c1642)
- chore(deps): actions v7, Rust 1.98, digest 0.11 (sha2, md-5) (#336) (ca0031a)
- chore(deps): bump the compose-mineures group across 2 directories with 1 update (#316) (199bf13)

## omp-harness 1.16.0 — 2026-11-07

- feat(harness): rapport du matin (GET /v1/digest, outil MCP digest, envoi quotidien) (#332) (8ed8018)
- feat(harness): relève automatique des issues du label omp:fix (#329) (1f0a43b)

## omp-harness 1.15.2 — 2026-11-07

- feat(harness): voie directe vers /impl quand la demande porte ses critères d'acceptation (#331) (e424823)
- feat(harness): commit squash conventionnel rédigé par la revue, jamais de commit vide (#330) (e8c4e66)
- fix(harness): un `## Reste` de /impl est repris sur la même branche (#328) (18dd1e9)

## omp-harness 1.15.1 — 2026-11-06

- fix(harness,console): code approbateur pour la pile Portainer (omp-harness-stack approver) (#325) (487dc33)
- Issue #323 : feat(mcp): les gestes qui débloquent un run (validate, retry, revert, décisions, escalades, inbox) (#324) (d65616c)

## omp-harness 1.15.0 — 2026-11-04

- feat(harness): pilotage des runs en MCP, GH_TOKEN de la pile jusqu'au service (#321) (c7e3a3b)

## omp-harness 1.14.1 — 2026-11-03

- fix(harness,stack,mem0-rs): rêve sans 404, écritures mémoire retentées, index.lock géré (#315) (8e3922f)

## omp-harness 1.14.0 — 2026-11-03

- feat(harness): serveur MCP des issues GitHub qui lance les corrections, une clé de déploiement par dépôt (#317) (e489cab)

## omp-harness 1.13.1 — 2026-10-30

- fix(harness,console): l'audit pilote ses features, /impl sans diff passe en revue, le merge ne rejoue plus un conflit résolu (#310) (7e9dc12)

## omp-chrome 0.1.1 — 2026-10-30

- fix(chrome): la base OpenAI d'oMLX (…/v1) acceptée, oMLX vérifié avant tout meeting (#308) (37445fc)

## omp-mem0-req 2.2.0 — 2026-10-29

- feat(harness,chrome,req,console): le poste de travail — extension Chrome, agent 24/24, profil et journal des décisions (#306) (95bdf42)

## omp-harness 1.13.0 — 2026-10-29

- feat(harness,chrome,req,console): le poste de travail — extension Chrome, agent 24/24, profil et journal des décisions (#306) (95bdf42)

## omp-chrome 0.1.0 — 2026-10-29

- feat(harness,chrome,req,console): le poste de travail — extension Chrome, agent 24/24, profil et journal des décisions (#306) (95bdf42)

## omp-harness 1.12.2 — 2026-10-27

- fix(harness,console): étapes qui se closent, questions qui s'envoient, mem0_add dans chaque runner (#304) (092b397)

## omp-harness 1.12.1 — 2026-10-26

- fix(mem0-rs,console): migration v4 en temps linéaire, et pas d'agent mem0-rs local quand la mémoire est celle du serveur (#302) (052b858)

## omp-mem0-memory 4.3.0 — 2026-10-26

- feat(memory,stack,harness): mémoire liée et rêve de la mémoire, inspirés de Hindsight (#299) (be59fa3)

## omp-harness 1.12.0 — 2026-10-26

- feat(memory,stack,harness): mémoire liée et rêve de la mémoire, inspirés de Hindsight (#299) (be59fa3)

## omp-harness 1.11.0 — 2026-10-26

- feat(harness,console): une session OMP se lit comme dans OMP — rendu des outils, sous-agents en direct, JSON brut replié (#298) (af14c18)

## omp-harness 1.10.0 — 2026-10-26

- feat(harness,console): détail d'une session en cours — commandes, arguments et sorties complets (#296) (b37d70c)

## omp-harness 1.9.0 — 2026-10-25

- feat(harness,console): l'Accueil devient un tableau de bord — KPIs et graphiques (#293) (c8a0683)

## omp-mem0-req 2.1.0 — 2026-10-25

- feat(harness,console): questions situées — contexte, impacts et Markdown rendu (#292) (1db5015)

## omp-harness 1.8.0 — 2026-10-25

- feat(harness,console): questions situées — contexte, impacts et Markdown rendu (#292) (1db5015)

## omp-mem0-memory 4.2.0 — 2026-10-25

- feat(memory): rappel borné en caractères, souvenirs longs rognés en le disant (#289) (4ec8b4c)

## omp-harness 1.7.1 — 2026-10-25

- fix(harness): les fichiers d'un run fusionné se lisent dans son commit, jamais dans le worktree en cours de retrait (#286) (4613318)
- refactor(harness): découper db.ts en un fichier par domaine (#282) (11468d8)

## omp-harness 1.7.0 — 2026-10-24

- feat(harness): runners systemd confinés à leur worktree, plafonds de dépense en cours d'étape et par jour, API durcie (#267) (4c56ce7)

## omp-mem0-memory 4.1.0 — 2026-10-24

- feat(memory,stack): dédup sensible aux valeurs, rappel avec disjoncteur, secrets masqués par le serveur, instantanés de mem0-rs (#268) (2487c3a)

## omp-harness 1.6.0 — 2026-10-24

- feat(harness): sauvegardes de la base, santé réelle, flux SSE bornés, process tués par groupe (#266) (1661f23)

## omp-harness 1.5.0 — 2026-10-24

- feat(harness): contradicteur aux portes de /req et /specs, specs gelées pour l'auto-merge, revue chez un autre fournisseur (#264) (521b12d)

## omp-harness 1.4.0 — 2026-10-24

- feat(harness,console): monitoring des features — session OMP en direct, coût, alertes, frise, fichiers, tests, santé, Live Activities et widget iOS (#262) (1c948e4)

## omp-harness 1.3.1 — 2026-10-23

- fix(harness): la connexion d'un abonnement démarre omp sans clé, et un refus d'omp nomme sa cause (#260) (4e906e2)

## omp-harness 1.3.0 — 2026-10-23

- feat(harness,ci): ports du tailnet réglables pour `pairing`, apps Mac et iOS jointes à chaque release (#258) (477afda)

## omp-harness 1.2.0 — 2026-10-23

- feat(harness,console): connecter les abonnements des fournisseurs depuis les apps Mac et iOS (#255) (b252bab)

## omp-harness 1.1.0 — 2026-10-23

- feat(harness): README d'accueil et déploiement du serveur depuis Portainer (#254) (7ccd276)

## omp-mem0-memory 4.0.0 — 2026-10-22

- feat(harness,req,memory,console)!: harness autonome — relances différées, auto-décision à l'échéance, auto-merge par critères, pilotage depuis omp ; CI par diff (#251) (4256521)

## omp-mem0-req 2.0.0 — 2026-10-22

- feat(harness,req,memory,console)!: harness autonome — relances différées, auto-décision à l'échéance, auto-merge par critères, pilotage depuis omp ; CI par diff (#251) (4256521)

## omp-harness 1.0.0 — 2026-10-22

- feat(harness,req,memory,console)!: harness autonome — relances différées, auto-décision à l'échéance, auto-merge par critères, pilotage depuis omp ; CI par diff (#251) (4256521)

## omp-mem0-memory 3.0.0 — 2026-10-22

- feat(harness)!: un seul moteur de pipelines — le harness du VPS (brouillon) (#248) (31f2a5e)

## omp-mem0-req 1.0.0 — 2026-10-22

- feat(harness)!: un seul moteur de pipelines — le harness du VPS (brouillon) (#248) (31f2a5e)

## omp-harness 0.2.0 — 2026-10-22

- feat(harness)!: un seul moteur de pipelines — le harness du VPS (brouillon) (#248) (31f2a5e)

## omp-mem0-req 0.34.0 — 2026-10-20

- ci(release): préparer le linter épinglé avant check.sh dans release et release-simulation, documenter la section lint (no-ts-lint-formatter) (#234) (28ca102)
- feat(req,docs,test): écart de version du service signalé par /service status et au démarrage de session (#236) (97c4b78)
- fix(req): magasin d'état du pipeline privé — dossiers en 0700, fichiers en 0600, existant resserré (#227) (a5c2c0a)
- fix(pilote,console): fins de run ignorées après stop, accusé cancel `already`, rang de lot /impl avancé sur échec commité (#240) (9f94326)
- refactor(req): repoRootOf vit dans git.ts, les recopies du mappage worktree → dépôt l'appellent (#232) (5ed05d5)
- refactor(req): sortir les bornes du lot de lot.ts vers lotLimits.ts (#231) (fbcbe89)
- chore(tsconfig,req,test): type-check strict sur le code mort — noUnusedLocals, noUnusedParameters et noFallthroughCasesInSwitch actifs, 51 diagnostics nettoyés (#224) (e7546ba)
- fix(req): service.json créé directement en 0600 — plus de fenêtre 0644 sur le jeton du service (#222) (0c62522)
- fix(req): jeton X-OMP-Service-Token comparé en temps constant (#220) (d20a0f7)

## omp-mem0-req 0.33.0 — 2026-10-18

- feat(req,console): sélecteur de modèle et de réflexion dans la Session OMP — affichage permanent, changement sans relance, défaut OMP du projet (Mac, iPhone, iPad) (#217) (1eb498a)

## omp-mem0-req 0.32.0 — 2026-10-18

- feat(arbitre,lot,console): l'arbitre tranche les jalons et se voit travailler — revue attestée par critère, refus corrigé dans le tour, modèle par contexte, alerte à l'escalade seule (#215) (4287e13)

## omp-mem0-req 0.31.2 — 2026-10-16

- fix(contract): les têtes SP-<n> et SPEC-<n> sont des spécifications pour la couverture des AC (#213) (e191064)

## omp-mem0-req 0.31.1 — 2026-10-16

- fix(runner): le pilote de lot ne rouvre sa session que sur un modèle de départ différent, pas sur un repli différent (#211) (814159a)

## omp-mem0-req 0.31.0 — 2026-10-16

- feat(arbitre): pilote de lot persistant — une session d'arbitre par lot, un tour par élément (#208) (4ec7cbd)

## omp-mem0-req 0.30.0 — 2026-10-15

- feat(pipeline): pertinence et rapidité — arbitre justifié, verdict croisé, extraits de contrat, compaction en fin de tour, blocages arbitrés, tests par diff (#206) (02dadac)

## omp-mem0-req 0.29.0 — 2026-10-15

- feat(req,pilotTools,commands,lotController,serviceClient,runs,context,contract,readme): outils de pilotage du modèle et kinds arbitrage et avance (#204) (107d110)

## omp-mem0-req 0.28.0 — 2026-10-14

- feat(arbitre,lot,relais,audit,project,runs,seeds,panneau,contexte,readme): l'arbitre juge le cap, l'échec et le quota échu, avec relances bornées à 2 (#196) (5097bca)
- feat(arbitre,audit,project,contexte,lot,seeds,readme): l'arbitre juge sur le rapport persisté, lit le dépôt et justifie ses décisions (#191) (690a7f2)
- feat(req,service,panel,seeds,test,docs): borne de contexte active sur les runs et sessions parentes hébergés (#194) (cca58cc)
- feat(req,quota,models,runs,panel,docs): modèle du groupe appliqué en session interactive par setModel, run de conversation sur le modèle de départ avec repli (#195) (89337b3)
- fix(req,test,docs): verdict de revue robuste — parseur fidèle au champ BLOQUANTS, contrat protégé, textes de maillon sans commande (#192) (42277b6)
- fix(runner,pilote,chaine,panneau,test,docs): un run en échec ou sans diff ne passe plus pour un succès (#193) (8824624)
- feat(req,console,docs): revue sur le groupe de modèles fort, arbitre épinglé, libellés cadrage+revue / exécution (#190) (f413cf1)

## omp-mem0-req 0.27.0 — 2026-10-14

- feat(req,console,ios,test): liste unique des attentes dans ConsoleCore — ardoise, dialogues de conduite et de session, escalades d'audit, même liste sur Mac et iPhone (#163) (0b304c9)

## omp-mem0-req 0.26.0 — 2026-10-13

- feat(req,console,ios,scripts,test,docs): section Audit sur Mac et iPhone — audit orienté, propositions à cocher, brief validé, pipelines pilotées par l'arbitre (#159) (dddf0b2)

## omp-mem0-req 0.25.1 — 2026-10-12

- fix(req,test): le service libère l'état des sessions qu'il ferme — fuite mémoire de ~45 Mo par maillon (#144) (4939755)

## omp-mem0-req 0.25.0 — 2026-10-09

- feat(req,service,panel,relay,test,docs): repli de modèle et quota, brief/journal/arbitre déportés, contexte par run sous 120k (#84) (2e2ad5a)

## omp-mem0-req 0.24.0 — 2026-10-08

- feat(req,console,test,docs): service OMP unique — un process pilote et exécute les pipelines, l'app en devient cliente (#80) (e34825e)

## omp-mem0-req 0.23.0 — 2026-10-04

- feat(req,console): deux modèles d'orchestration par feature — req+specs et impl+review (#59) (b959057)

## omp-mem0-req 0.22.0 — 2026-10-02

- feat(console,req,test,docs): OMP Console — refonte des écrans (une seule fenêtre) et commande reply du canal (f677513)

## omp-mem0-req 0.21.0 — 2026-09-28

- feat(req): canal de commande — piloter un lot depuis un process externe (aucun bump) (#34) (1ea8910)

## omp-mem0-req 0.20.0 — 2026-09-28

- feat(req): /project — cadrage, plan de segments, PROJECT.md et relais des pipelines jusqu'aux PR (aucun bump) (#32) (47ece8b)

## omp-mem0-memory 2.11.0 — 2026-09-27

- feat(memory): /mem0-purge-procedures — inventorier et supprimer les souvenirs procéduraux (aucun bump) (#29) (927c63b)

## omp-mem0-memory 2.10.1 — 2026-09-27

- fix(http,memory): une procédure est stockée mot pour mot, sans réécriture LLM (aucun bump) (bf8c1db)

## omp-mem0-req 0.19.1 — 2026-09-27

- fix(req): la fin d'un sous-agent ne désarme plus le relais /audit ni la pompe de boîte (ed2fd30)

## omp-mem0-memory 2.10.0 — 2026-09-27

- feat(memory): masquage des secrets élargi (Anthropic, OpenAI projet, GitHub PAT, Slack, PEM entier, identifiants d'URL) (da6e8f8)

## omp-mem0-req 0.19.0 — 2026-09-27

- feat(release,ci): la release passe par une PR auto-mergée — bump unique par le job, CHANGELOG et rattrapage (e68b3fb)

## omp-mem0-memory 2.9.7 — 2026-09-23

- fix(req,memory): audit de la salle de contrôle — boucle de revue fiable, panneau supervisable, runs sans orphelins (req 0.15.0 / memory 2.9.7 / catalogue 2.9.7) (10c2f83)

## omp-mem0-memory 2.9.6 — 2026-09-21

- fix(stack,memory,req): durcissement général — stack non privilégiée, écritures atomiques, contrôles élargis (memory 2.9.6 / req 0.8.2 / catalogue 2.9.6) (d803ec1)

## omp-mem0-memory 2.9.5 — 2026-09-18

- fix(memory,stack): le rappel et mem0_search filtrent le cosinus brut (v2.9.5 / catalogue 2.9.10) (5662959)

## omp-mem0-memory 2.9.4 — 2026-09-18

- feat(req,memory): isolation des features en worktree git + balayage (v0.6.0 / v2.9.4) (be6de1d)

## omp-mem0-memory 2.9.3 — 2026-09-16

- fix(req,memory): /req réparé, boucle session_stop supprimée, fin de phase + nudge fusionnés (df1306d)

## omp-mem0-memory 2.9.2 — 2026-09-08

- fix(memory): plancher SEARCH_THRESHOLD=0.4 sur mem0_search (v2.9.2) (14f7f8a)

## omp-mem0-memory 2.9.1 — 2026-09-06

- fix(review): scope /review on git diff, drop phantom review command (3d63083)

## omp-mem0-memory 2.9.0 — 2026-09-04

- feat: add /review command and phase to complete pipeline (cc97a22)

## omp-mem0-memory 2.8.0 — 2026-09-04

- omp-mem0-memory 2.8.0 : redesign phase + fixes checkpoint/recall + tests (ed93ba6)

## omp-mem0-memory 2.7.0 — 2026-09-04

- feat: phase trigger — registry, management commands, and session_stop execution (36e7515)

## omp-mem0-memory 2.6.0 — 2026-09-04

- feat: req extension + checkpoint exploration in memory (8815f61)
- feat: req extension + checkpoint exploration in memory (20baa58)

## omp-mem0-memory 2.5.0 — 2026-09-03

- feat: bloc de rappel visuel par défaut (2.5.0) (481eb1f)

## omp-mem0-memory 2.4.0 — 2026-09-03

- feat: v2.4.0 — aperçu vérifiable de /mem0-dedupe (a9075b6)

## omp-mem0-memory 2.3.0 — 2026-09-03

- chore: v2.3.0 — corrige la régression de version (0.1.0 publié alors que 2.2.0 était installé) (3102e11)

## omp-mem0-memory 0.2.0 — 2026-09-03

- mem0 v0.2.0 : rappel filtré, sommaire exhaustif, agrafage, écriture par l'agent (24c4730)

## omp-mem0-memory 0.1.0 — 2026-09-02

- mem0 2.x: migration breaking API, diagnostic stack, brief mémoire (ef3bf4c)

## omp-mem0-memory 2.2.0 — 2026-09-02

- feat: mémoire mem0 par projet pour oh-my-pi (68021a9)

## omp-mem0-req 0.18.0 — 2026-09-27

- feat(req): /audit — sélection multiple des éléments à lancer, en parallèle et dans l'ordre des dépendances (req 0.18.0) (caafe13)

## omp-mem0-req 0.17.0 — 2026-09-26

- feat(req): choix du modèle des pipelines — une valeur par feature, portée par tous ses runs (req 0.17.0) (3bfe19f)

## omp-mem0-req 0.16.0 — 2026-09-26

- feat(req): commande /audit — audit du dépôt, pipeline de la feature choisie et relais des questions et jalons (req 0.16.0) (b5e9648)

## omp-mem0-req 0.15.0 — 2026-09-23

- fix(req,memory): audit de la salle de contrôle — boucle de revue fiable, panneau supervisable, runs sans orphelins (req 0.15.0 / memory 2.9.7 / catalogue 2.9.7) (10c2f83)
- refactor(req): extension.ts découpée en 18 modules (13e6d6e)

## omp-mem0-req 0.14.0 — 2026-09-23

- fix(req): réponse à un ask d'un seul Entrée, repli intégral du texte et panneau pleine largeur (req 0.14.0) (95725f0)

## omp-mem0-req 0.13.0 — 2026-09-23

- feat(req): panneau et vue de session rendus par les composants de l'hôte (req 0.13.0) (d329102)

## omp-mem0-req 0.12.0 — 2026-09-22

- feat(req): vue de conversation fidèle et écriture dans un run vivant (req 0.12.0) (1cbdc8c)

## omp-mem0-req 0.11.0 — 2026-09-22

- feat(req): vue de session écrivable, file du lot et repli des lignes (req 0.11.0) (4db6ceb)

## omp-mem0-req 0.10.0 — 2026-09-22

- feat(req): panneau /pipelines plein écran, vue de session en lecture seule et une ligne par feature (req 0.10.0) (204ab44)

## omp-mem0-req 0.9.0 — 2026-09-22

- feat(req): lot de features — chaîne req→specs→impl→review pilotée depuis /pipelines (req 0.9.0 / catalogue 2.9.6) (bac1842)

## omp-mem0-req 0.8.2 — 2026-09-21

- fix(stack,memory,req): durcissement général — stack non privilégiée, écritures atomiques, contrôles élargis (memory 2.9.6 / req 0.8.2 / catalogue 2.9.6) (d803ec1)

## omp-mem0-req 0.8.1 — 2026-09-19

- fix(req): rejoindre depuis le panneau la session d'une entrée d'un autre répertoire (v0.8.1 / catalogue 2.9.13) (dd92511)

## omp-mem0-req 0.8.0 — 2026-09-18

- feat(req): panneau des pipelines en cours, tous processus OMP et tous dépôts (v0.8.0 / catalogue 2.9.12) (1a4006f)

## omp-mem0-req 0.7.0 — 2026-09-18

- feat(req): la commande de la suite est annoncée à chaque fin de maillon (v0.7.0 / catalogue 2.9.11) (76c5cda)

## omp-mem0-req 0.6.0 — 2026-09-18

- feat(req,memory): isolation des features en worktree git + balayage (v0.6.0 / v2.9.4) (be6de1d)

## omp-mem0-req 0.5.0 — 2026-09-17

- feat(req): pipeline piloté par le critère d'acceptation (v0.5.0) (3edfb89)

## omp-mem0-req 0.4.5 — 2026-09-16

- fix(req,memory): /req réparé, boucle session_stop supprimée, fin de phase + nudge fusionnés (df1306d)

## omp-mem0-req 0.4.4 — 2026-09-07

- fix(req): infinite loop de notices au clic sur « fin » (v0.4.4) (1cd29ce)

## omp-mem0-req 0.4.3 — 2026-09-07

- fix(req): /req s'auto-clôturait avant collecte — WELCOME auto-match fin (0b2dce6)

## omp-mem0-req 0.4.2 — 2026-09-07

- specs: rassembler la documentation externe dans le contrat (db10405)

## omp-mem0-req 0.4.1 — 2026-09-07

- omp-mem0-req v0.4.1 : contrat fichier + boucle revue→correction (c612449)

## omp-mem0-req 0.3.1 — 2026-09-06

- fix(review): scope /review on git diff, drop phantom review command (3d63083)

## omp-mem0-req 0.3.0 — 2026-09-04

- feat: add /review command and phase to complete pipeline (cc97a22)

## omp-mem0-req 0.1.1 — 2026-09-04

- bump(omp-mem0-req): 0.1.0 -> 0.1.1 (registerCommand fix) (2aad393)
- fix(req): registerCommand doit passer { description, handler } (06e03ee)

## omp-mem0-req 0.1.0 — 2026-09-04

- feat: req extension + checkpoint exploration in memory (20baa58)
