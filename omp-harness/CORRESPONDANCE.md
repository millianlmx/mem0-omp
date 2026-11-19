# Correspondance des chemins du serveur

Les chemins sont relatifs à `omp-harness/`. Cette table vient de la réorganisation de la base de code : elle donne, pour chaque ancien chemin d'un fichier du serveur, son chemin actuel. Un fichier découpé y a une ligne par morceau, avec la responsabilité du morceau. La carte des dossiers est dans `DEVELOPPEMENT.md`, section « Le serveur, dossier par dossier ».

| Ancien chemin | Nouveau chemin | Responsabilité |
| --- | --- | --- |
| `audits.ts` | `jobs/audits.ts` |  |
| `auth.ts` | `api/auth.ts` |  |
| `autonomy-gates.ts` | `autonomy/autonomy-gates.ts` |  |
| `autonomy-learning.ts` | `autonomy/autonomy-learning.ts` |  |
| `autonomy-rules.ts` | `autonomy/autonomy-rules.ts` |  |
| `backup.ts` | `operations/backup.ts` |  |
| `baseline.ts` | `heavy/baseline.ts` |  |
| `brief.ts` | `reports/brief.ts` |  |
| `briefing.ts` | `human/briefing.ts` |  |
| `build-info.ts` | `operations/build-info.ts` |  |
| `card-reader.ts` | `human/card-reader.ts` |  |
| `card.ts` | `human/card.ts` |  |
| `challenge.ts` | `runs/challenge.ts` |  |
| `check.ts` | `config/check.ts` |  |
| `ci-judge.ts` | `heavy/ci-judge.ts` |  |
| `cli.ts` | `cli.ts` |  |
| `collections.ts` | `runs/collections.ts` |  |
| `config.ts` | `config/config.ts` |  |
| `context.ts` | `runs/context.ts` |  |
| `cron.ts` | `jobs/cron.ts` |  |
| `db.ts` | `db/db.ts` |  |
| `decisions.ts` | `runs/decisions.ts` |  |
| `digest.ts` | `reports/digest.ts` |  |
| `dreams.ts` | `jobs/dreams.ts` |  |
| `errors.ts` | `api/errors.ts` |  |
| `events.ts` | `api/events.ts` |  |
| `forge-github.ts` | `forge/forge-github.ts` |  |
| `forge-gitlab.ts` | `forge/forge-gitlab.ts` |  |
| `forge.ts` | `forge/forge.ts` |  |
| `gestures.ts` | `human/gestures.ts` |  |
| `git.ts` | `forge/git.ts` |  |
| `heavy.ts` | `heavy/heavy.ts` |  |
| `host-tools.ts` | `runs/host-tools.ts` |  |
| `http.ts` | `api/admin-routes.ts` | routes d'administration et d'exploitation du serveur |
| `http.ts` | `api/http-io.ts` | transport |
| `http.ts` | `api/http.ts` | transport |
| `http.ts` | `api/route-table.ts` | table des routes |
| `http.ts` | `api/run-routes.ts` | routes des runs et de l'usine |
| `http.ts` | `api/space-routes.ts` | routes des espaces et des intégrations |
| `http.ts` | `api/workstation-routes.ts` | routes du poste |
| `idempotency.ts` | `api/idempotency.ts` |  |
| `ids.ts` | `runs/ids.ts` |  |
| `input.ts` | `api/input.ts` |  |
| `inspect.ts` | `api/inspect.ts` |  |
| `intake-create.ts` | `intake/intake-create.ts` |  |
| `intake.ts` | `intake/intake.ts` |  |
| `isolation.ts` | `spaces/isolation.ts` |  |
| `issues.ts` | `forge/issues.ts` |  |
| `local-model.ts` | `config/local-model.ts` |  |
| `local-sessions.ts` | `sessions/local-sessions.ts` |  |
| `logger.ts` | `operations/logger.ts` |  |
| `machine.ts` | `runs/machine.ts` |  |
| `main.ts` | `main.ts` |  |
| `mcp.ts` | `api/mcp.ts` |  |
| `merger.ts` | `runs/merger.ts` |  |
| `metrics.ts` | `operations/metrics.ts` |  |
| `monitor.ts` | `operations/monitor.ts` |  |
| `notify.ts` | `notify/notify.ts` |  |
| `oauth.ts` | `config/oauth.ts` |  |
| `observability.ts` | `operations/observability.ts` |  |
| `oracle.ts` | `memory/oracle.ts` |  |
| `orchestrator.ts` | `runs/orchestrator.ts` | assemblage, cycle de vie du service et conduite des runs |
| `orchestrator.ts` | `runs/pause-desk.ts` | pause globale et par espace |
| `orchestrator.ts` | `runs/run-creation.ts` | création des runs et des projets |
| `orchestrator.ts` | `runs/run-queue.ts` | admission équitable et file d'attente |
| `orchestrator.ts` | `runs/run-views.ts` | vues de lecture rendues à l'API |
| `pairing.ts` | `api/pairing.ts` |  |
| `pilot.ts` | `human/pilot.ts` |  |
| `planner.ts` | `runs/planner.ts` |  |
| `policy.ts` | `config/policy.ts` |  |
| `proc.ts` | `runners/proc.ts` |  |
| `prometheus.ts` | `operations/prometheus.ts` |  |
| `prompts.ts` | `runs/prompts.ts` |  |
| `proofs.ts` | `heavy/proofs.ts` |  |
| `proposals.ts` | `human/proposals.ts` |  |
| `providers.ts` | `config/providers.ts` |  |
| `push-alerts.ts` | `notify/push-alerts.ts` |  |
| `push.ts` | `notify/push.ts` |  |
| `queries.ts` | `api/queries.ts` |  |
| `repos.ts` | `config/repos.ts` |  |
| `rpc.ts` | `runners/rpc.ts` |  |
| `runner-session.ts` | `runners/runner-session.ts` |  |
| `runner.ts` | `runners/runner.ts` |  |
| `safefs.ts` | `runs/safefs.ts` |  |
| `scheduler.ts` | `runners/scheduler.ts` |  |
| `schedules.ts` | `jobs/schedules.ts` |  |
| `scope.ts` | `memory/scope.ts` |  |
| `scoreboard.ts` | `reports/scoreboard.ts` |  |
| `session-feed.ts` | `sessions/session-feed.ts` |  |
| `session-graph.ts` | `sessions/session-graph.ts` |  |
| `space-usage.ts` | `reports/space-usage.ts` |  |
| `spaces.ts` | `spaces/spaces.ts` |  |
| `split.ts` | `runs/split.ts` |  |
| `standing-rules.ts` | `human/standing-rules.ts` |  |
| `stats.ts` | `reports/stats.ts` |  |
| `steps.ts` | `runs/steps.ts` |  |
| `tap.ts` | `heavy/tap.ts` |  |
| `test-feed.ts` | `heavy/test-feed.ts` |  |
| `test-report.ts` | `heavy/test-report.ts` |  |
| `tool-view.ts` | `sessions/tool-view.ts` |  |
| `verdict.ts` | `runs/verdict.ts` |  |
| `workstation-agent.ts` | `workstation/workstation-agent.ts` |  |
| `workstation-guards.ts` | `workstation/workstation-guards.ts` |  |
| `workstation.ts` | `workstation/workstation-errands.ts` | meetings, demandes et automatisations |
| `workstation.ts` | `workstation/workstation-input.ts` | formes et validation des entrées du poste |
| `workstation.ts` | `workstation/workstation-presence.ts` | navigateurs, présence et espaces |
| `workstation.ts` | `workstation/workstation-profile.ts` | profil de travail |
| `workstation.ts` | `workstation/workstation.ts` | file d'actions et garde d'envoi |
