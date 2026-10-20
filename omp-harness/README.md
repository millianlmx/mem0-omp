# omp-harness — le Pipeline Service sur VPS

Un process Node, une base SQLite, une API REST + SSE. Le service conduit chaque
feature de bout en bout (/req → /specs → /impl → /review ⇄ fix → merge) avec des
runners OMP enfants. Il décide seul de ce qui est réversible. Il batche ce qui ne
l'est pas pour l'humain du matin.

Il est indépendant des deux plugins. Ni `omp-mem0-req` ni la coque macOS n'en
dépendent, et le service du Mac (launchd) reste tel quel.

## L'architecture, case par case

| Case du schéma | Où | Ce qui le garantit |
|---|---|---|
| **Clients** : HTTPS + SSE, auth, point d'entrée unique | `http.ts` | Jeton Bearer comparé en temps constant. Écoute sur `127.0.0.1` ; Tailscale ou un reverse proxy TLS publie l'API. Le flux SSE se rejoue depuis `Last-Event-ID`. |
| **SQLite** : source de vérité, un seul écrivain | `db.ts` | Runs, étapes, décisions (checkpoints), escalades, artefacts, journal d'événements, cache heavy et tests lancés. Seul le service ouvre la base. Runners et jobs heavy passent par lui. |
| **Pipeline Service** : machine à états, reprise au checkpoint | `machine.ts`, `orchestrator.ts` | Machine pure. Une boucle async par run actif. Au redémarrage, chaque run `running` revient à son dernier commit (checkpoint) et repart avec un nouveau runner. |
| **Scheduler** : 5 runners, 2 heavy, jetons par fournisseur, MemAvailable | `scheduler.ts` | Un slot runner par run vivant. Un slot heavy par `run_tests`. Un seau à jetons par fournisseur (un jeton par prompt) avec bascule. Admission seulement si `MemAvailable − enveloppe ≥ réserve`. |
| **/project** : modules, parallèle si disjoint, rebase, merge immédiat | `planner.ts`, `orchestrator.ts` | Modules déclarés, sinon lus dans l'oracle, puis précisés par la section `## Modules` des specs. Chevauchement par préfixe de chemin, et un ensemble inconnu chevauche tout. Rebase sur `main` avant /review. En cas de conflit, le service fusionne `main` et le runner résout les marqueurs dans les fichiers, sans git. Merge squash dès la validation. |
| **Runners OMP** : 1 par étape, 1 Go, profil pipeline | `runner.ts`, `rpc.ts` | `omp --mode rpc --no-ui --no-lsp --profile pipeline` dans une scope `MemoryMax=1G` sous `choom -n 300`. Le runner de la revue reste vivant pendant review ⇄ fix (cache de prompt). Les autres meurent en fin d'étape ou à l'escalade. |
| **Politique de décision** | `decisions.ts` | Outil hôte `decision`. Une décision réversible devient un commit WIP `decision: … → …` (trailer `Harness-Decision: run/N`, remappé après rebase). Le schéma de données, l'API publique et les suppressions partent en escalade, batchée en fin d'étape. Le service durcit une catégorie, il ne l'adoucit jamais. |
| **Heavy** : systemd, 4 Go, 300 %, user dédié, sans réseau ni clé, cache, OOM | `heavy.ts` | Le runner attend, bloqué sur `run_tests`. Le cache est lu avant tout lancement, par clé tree hash du répertoire de travail + commande + env. Un OOM donne un échec structuré et 2 relances, sans entrée de cache. |
| **Worktrees** : 1 par run, artefacts, WIP, petites PR, caches de build | `git.ts` | Branche `harness/<slug>`. Artefacts dans `.harness/` (exclu de git, versés dans la base). `CARGO_TARGET_DIR` par worktree, sccache et store pnpm partagés. Un diff de plus de 300 lignes interdit l'auto-merge. |
| **Oracle** : mem0-rs, scope projet | `oracle.ts` | Lu par /req, /specs et /project. En écriture : les comptes rendus de besoins, chaque feature mergée (knowledge-updater) et chaque correction humaine **avec sa raison**. Injoignable, il dégrade sans bloquer. |
| **Backends LLM** : rapide et lourd, multi-provider | `config.ts` (`models`), `orchestrator.ts` | `models.fast` pour /req et /specs, `models.heavy` pour /impl, /review et fix. Sur un 429, `set_model` fait passer le **même** runner au fournisseur suivant. |
| **Sortie /review** : verdict structuré, auto-merge | `verdict.ts` | Outil hôte `review_verdict`. Bas risque + suite complète **verte sur l'arbre exact** (cache heavy, jamais l'avis du runner) + diff ≤ 300 lignes : auto-merge. Sinon l'humain lit le verdict, et le code seulement si le verdict est faible. |
| **Système** : zram, oomd, budget 14 Go | `deploy/` | `omp-harness.slice` 16G ⊃ runners 5G + heavy 8G + service 1G. OOM : heavy (800), puis runners (300), jamais le service (-900, `ManagedOOMPreference=omit`). zram 8 Go. |
| **Boucle humaine** | `orchestrator.ts`, `http.ts` | Relire, accepter, renverser une décision. Le renversement fait un retour dur au checkpoint N, applique l'option choisie, écrit la raison dans l'oracle et reprend à l'étape du checkpoint. Un run déjà mergé ouvre un run de suite. |

## Écarts assumés au schéma

- **Heavy en service transitoire, pas en `--scope`.** Une scope ne porte ni
  `User=` ni `PrivateNetwork=`. Le job part donc en `systemd-run --wait --pipe` :
  mêmes limites cgroup, plus l'isolation demandée.
- **Les outils du runner sont des outils hôtes RPC.** `run_tests`, `decision`,
  `review_verdict`, `oracle_recall` et `progress` sont déclarés par
  `set_host_tools` et exécutés par le service. Le runner n'a ni accès à la base ni
  jeton d'API, et rien n'est à installer dans son profil.
- **Trois users au lieu d'un.** `omp-harness` tient la base et le jeton,
  `omp-runner` les clés LLM et les worktrees, `omp-heavy` rien. Un runner détourné
  par une injection de prompt ne peut pas s'auto-valider par l'API.
- **Un lanceur root pour systemd.** Autoriser `systemd-run` au service
  reviendrait à lui donner root (`-p User=root`). Le service passe donc par
  `deploy/omp-harness-systemd-run`, appelé par `sudo` sans `SETENV` ni `-E`, ce
  qui remet l'environnement à zéro. Le lanceur valide chaque mot de la ligne :
  - côté heavy, `User=omp-heavy`, `PrivateNetwork=yes`, `ProtectSystem=strict`,
    `PrivateTmp` et `RuntimeMaxSec` sont obligatoires ;
  - les chemins doivent être absolus et rester sous les racines déclarées ;
  - le lanceur ajoute lui-même `ProtectHome` et masque, par `InaccessiblePaths`,
    l'état du service, les logins des runners et les sockets de l'hôte ;
  - côté runner, la commande est épinglée sur `OMP_BIN`, et il est relancé sous
    `omp-runner` avec les clés de `/etc/omp-harness/runner.env`, que root seul lit.

  Il refuse tout le reste (code 64). Sa configuration est lue ligne à ligne,
  jamais exécutée.
- **Git ne fait jamais confiance au worktree.** Un runner peut réécrire le fichier
  `.git` de son worktree. Le service passe donc un `--git-dir` explicite, retrouvé
  dans le dossier d'administration du clone, et force `core.hooksPath=/dev/null` et
  `core.fsmonitor=false`. Le clone est en `core.sharedRepository=0640` : son gitdir
  n'est inscriptible que par le service.
- **Artefacts sans lien.** `.harness/*.md` est lu et écrit en `O_NOFOLLOW`, puis
  vérifié par `/proc/self/fd`. Un lien vers le jeton du service n'est jamais
  ingéré.

## Mémoire du projet

L'oracle **est** la mémoire mem0 du projet, celle que le plugin `omp-mem0-memory` lit
sur ton Mac.

- **Même scope.** Une scope de dépôt non déclarée est calculée au démarrage à partir
  des manifestes de `main` (`package.json`, `pyproject.toml`, `Cargo.toml`,
  `Package.swift`, puis `.xcodeproj`). Le plugin utilise la même table
  (`omp-mem0-memory/state.ts`). `GET /v1/status` l'affiche par dépôt, avec l'état de
  l'oracle.
- **Runners branchés.** Chaque runner charge le plugin (`runner.extensions`) et
  reçoit `MEM0_PROJECT_ID=<scope>`. Il bénéficie ainsi du rappel automatique à
  chaque tour et des outils `mem0_*`. Il reçoit aussi `MEM0_AUTOSETUP=0` (aucun
  brief écrit dans le dépôt, donc rien dans la PR) et `MEM0_NUDGE=0` (pas de tour
  de relance par étape : le knowledge-updater s'en charge). Derrière le lanceur
  root, ces trois variables sont les seules permises sur la ligne de commande.
  L'adresse et le jeton de mem0 viennent de `runner.env`.
- **mem0-rs sur le VPS.** `install.sh` construit `mem0-rs`, crée le user `omp-mem0`
  et sa base dans `/var/lib/omp-mem0` (0700), puis démarre
  `omp-harness-mem0.service`. Ce service est durci, écoute sur `127.0.0.1:8321` et
  reste hors du budget des runs. Les vecteurs sémantiques et l'extraction viennent
  du homelab via Tailscale (`OMLX_BASE_URL` dans `/etc/omp-harness/mem0.env`). Un
  jeton commun est généré pour mem0-rs, le service et les runners. Les jobs heavy
  ne voient ni la base ni le jeton.
- **Une seule mémoire pour le Mac et le VPS.** Quatre étapes :
  1. Copier `mem0-rs.db` du Mac dans `/var/lib/omp-mem0/`, service arrêté. La
     dimension des vecteurs doit être la même.
  2. Publier mem0 sur le tailnet : `tailscale serve --bg --https=8443 http://127.0.0.1:8321`.
  3. Sur le Mac, faire pointer le plugin vers le VPS :
     `MEM0_HTTP_URL=https://<vps>.<tailnet>.ts.net:8443` et
     `MEM0_HTTP_TOKEN=<jeton de mem0.env>`.
  4. Les sessions du Mac, les runners et l'oracle écrivent alors dans la même base.

## API

`Authorization: Bearer <jeton>` sur toutes les routes, sauf `GET /v1/health`.

| Route | Effet |
|---|---|
| `GET /v1/status` | Compteurs par état, runs vivants, slots, `MemAvailable`, jetons par fournisseur. |
| `GET /v1/runs?state=…&repo=…` · `POST /v1/runs` `{repo, title, request, modules?}` | Lister, créer. `repo` est un **nom** déclaré dans la configuration, jamais un chemin. |
| `GET /v1/runs/{id}` | Run, étapes, décisions, escalades, tests, artefacts. |
| `POST /v1/runs/{id}/escalations` `{answers: [{id, answer}]}` | Répondre au lot. Le run reprend quand tout est répondu. |
| `POST /v1/runs/{id}/decisions/{n}/accept` | Accepter une décision prise seule. |
| `POST /v1/runs/{id}/decisions/{n}/reverse` `{option, reason}` | Renverser : reprise au checkpoint N, raison dans l'oracle. |
| `POST /v1/runs/{id}/validate` `{approve, reason?}` | Valider un verdict, ou le refuser (correction, raison dans l'oracle). |
| `POST /v1/runs/{id}/cancel` | Annuler (la branche reste). |
| `GET /v1/escalations` | Escalades ouvertes, **batchées par run** (écran iOS). |
| `GET /v1/decisions?status=auto` | La relecture du matin. |
| `POST /v1/projects` `{repo, title, features: [{title, request, modules?}]}` · `GET /v1/projects/{id}` | /project. |
| `GET /v1/events?run=…` | SSE. `id:` = curseur du journal. Événements : `run_created`, `run_state`, `step_started`, `step_done`, `decision`, `escalation`, `escalations` (le lot), `review`, `verdict`, `heavy_*`, `rate_limited`, `model_failover`, `rebased`, `merged`, `progress`… |

## Installation (VPS Debian ou Ubuntu, systemd ≥ 250)

```bash
sudo bash omp-harness/deploy/install.sh
sudoedit /etc/omp-harness/config.json        # dépôts, modèles, fournisseurs, oracle
sudo -u omp-harness git clone --bare <url> /var/lib/omp-harness/repos/<nom>
sudo -u omp-runner -H omp --profile pipeline # /login : les comptes LLM des runners
sudo systemctl enable --now omp-harness
tailscale serve --bg --https=443 http://127.0.0.1:8790
```

Pour développer sans systemd, passe `runner.isolation` et `heavy.isolation` à
`none` et `launcher` à `[]`, puis :
`node --experimental-strip-types omp-harness/main.ts --config ma-config.json`.

Les tests (`test/harness/`) font tourner le service complet avec de vrais process,
du vrai git et la vraie base. Les runners y sont un faux `omp` RPC
(`test/support/fake-omp-rpc.ts`).

## Les apps

Les apps Mac et iOS joignent le serveur directement, par le bouton **Serveur** de
la section Pipelines. Il faut l'adresse publiée par Tailscale et le jeton de
`/var/lib/omp-harness/state/token`. Dans la feuille, la boîte de l'humain
(`GET /v1/inbox`) se tient à jour par le flux SSE. On y trouve :
- les escalades, répondues d'un geste par feature ;
- les verdicts, à valider ou à refuser avec une raison ;
- les décisions prises seules, à accepter ou à renverser ;
- les features en cours.

Le client est partagé (`omp-console/Sources/ConsoleClient/Harness*.swift`) ; voir
`omp-console/README.md` § Serveur de pipelines.
