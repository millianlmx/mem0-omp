# Journal des versions

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
