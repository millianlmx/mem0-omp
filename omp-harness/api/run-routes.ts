// Les routes des runs et de l'usine : les runs, les projets, les audits, les décisions, les escalades, la boîte, le
// brief, le rapport, les propositions, les règles, l'autonomie, les rêves, les planifications, l'état, les chiffres
// et MCP.

import { repoFilter } from "./auth.ts";
import type { DecisionStatus, RepoFilter, RunRow } from "../db/db.ts";
import { HarnessError } from "./errors.ts";
import {
  alwaysInput,
  autonomyField,
  autonomyLevelInput,
  autonomyRuleInput,
  budgetInput,
  cancelMotive,
  escalationAnswers,
  instructionsInput,
  integer,
  modulesInput,
  newRunInput,
  priorityInput,
  requireRepo,
  standingRuleInput,
  standingRulePatch,
  stringList,
  text,
} from "./input.ts";
import type { RunState } from "../runs/machine.ts";
import { LIVE_RUN_STATES } from "../runs/machine.ts";
import { PROOF_MIMES } from "../heavy/proofs.ts";
import { autonomyValidations, escalationBatches, projectsOf } from "./queries.ts";
import { computeStats } from "../reports/stats.ts";
import { autonomyProposals } from "../autonomy/autonomy-learning.ts";
import { HARNESS_COMMIT } from "../operations/build-info.ts";
import { DIGEST_WINDOW_MS, digestOf } from "../reports/digest.ts";
import { scheduleEdit, scheduleInput } from "../jobs/schedules.ts";
import { scoreboardDays, scoreboardOf } from "../reports/scoreboard.ts";
import { handleMcp } from "./mcp.ts";
import { readerOf } from "../human/proposals.ts";
import { HARNESS_VERSION, readBody, readJson, send } from "./http-io.ts";
import type { Call, RouteKit } from "./route-table.ts";

const DECISION_STATUSES: readonly DecisionStatus[] = ["auto", "auto_timeout", "accepted", "reversed", "superseded"];

function isDecisionStatus(value: string): value is DecisionStatus {
  return DECISION_STATUSES.some((status) => status === value);
}

/** L'âge maximal des statistiques servies (`GET /v1/stats`) : leur calcul balaie toute la base, synchrone. */
export const STATS_TTL_MS = 30_000;

/**
 * Les statistiques déjà calculées, par lecteur (ses dépôts). Fraîches (`ttlMs`), elles sont rendues telles
 * quelles ; plus vieilles, elles sont rendues QUAND MÊME et recalculées juste après, hors de la requête
 * (`defer`) : les apps les lisent à chaque ouverture, et un calcul complet bloque la boucle du service
 * pendant que leurs autres lectures attendent. Seule la toute première lecture d'un lecteur (après un
 * démarrage) calcule sous ses yeux.
 */
export class StatsCache {
  readonly #entries = new Map<string, { at: number; value: Record<string, unknown> }>();
  readonly #refreshing = new Set<string>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #defer: (fn: () => void) => void;
  constructor(
    ttlMs = STATS_TTL_MS,
    now: () => number = Date.now,
    defer: (fn: () => void) => void = (fn) => void setTimeout(fn, 0),
  ) {
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#defer = defer;
  }
  read(repos: RepoFilter, compute: () => Record<string, unknown>): Record<string, unknown> {
    const key = repos === null ? "*" : [...repos].sort().join("\n");
    const hit = this.#entries.get(key);
    if (!hit) return this.#compute(key, compute);
    if (this.#now() - hit.at >= this.#ttlMs && !this.#refreshing.has(key)) {
      this.#refreshing.add(key);
      this.#defer(() => {
        try {
          this.#compute(key, compute);
        } catch {
          // Un recalcul en échec (base fermée à l'arrêt) garde les chiffres d'avant.
        } finally {
          this.#refreshing.delete(key);
        }
      });
    }
    return hit.value;
  }
  #compute(key: string, compute: () => Record<string, unknown>): Record<string, unknown> {
    const value = compute();
    this.#entries.set(key, { at: this.#now(), value });
    return value;
  }
}

export function runRoutes(kit: RouteKit) {
  const { orchestrator, store, route, once, sees, runId, pageOf, ownerOf, READS_SIGNALS, adminOf } = kit;
  const statsCache = new StatsCache();
  /** Une création sous `?space=` : son dépôt, que le client voit déjà, doit être de l'espace (400 sinon). */
  const repoInSpace = (call: Call, repo: string): void => {
    if (call.space !== null && !call.space.repos.includes(repo))
      throw new HarnessError(400, `repo : le dépôt ${repo} n'est pas dans l'espace « ${call.space.name} »`);
  };
  const visibleAudit = (call: Call, id: string) => {
    const audit = store.getAudit(id);
    if (!audit || !sees(call, audit.repo)) throw new HarnessError(404, `audit inconnu : ${id}`);
    return audit;
  };

  const statusRoutes = [
    route("GET", "/v1/status", "viewer", async (call) => {
      const [oracle, memory] = await Promise.all([
        orchestrator.oracleStatus(),
        orchestrator.observability.memoryStatus(),
      ]);
      send(call.res, 200, {
        ...orchestrator.status(call.repos),
        oracle,
        memory,
        backups: orchestrator.observability.backupStatus(),
      });
    }),
  ];

  const runListRoutes = [
    route("GET", "/v1/runs", "viewer", (call) => {
      const state = call.url.searchParams.get("state");
      const repo = call.url.searchParams.get("repo");
      // `since` : la relecture incrémentale d'un client qui a déjà la liste — les runs écrits depuis cet instant
      // (`at` de sa lecture précédente) et ceux en file ; `at` dit d'où reprendre la prochaine fois.
      const sinceParam = call.url.searchParams.get("since");
      const since = sinceParam === null ? undefined : Number(sinceParam);
      if (since !== undefined && !(Number.isInteger(since) && since >= 0))
        throw new HarnessError(400, "since : entier ≥ 0 (epoch ms)");
      // `recent=<n>` : la première lecture d'une app — tous les runs vivants et les `n` terminés les plus récents,
      // `more` s'il en reste de plus anciens ; l'historique entier ne se télécharge plus à chaque ouverture.
      const recentParam = call.url.searchParams.get("recent");
      const recent = recentParam === null ? undefined : Number(recentParam);
      if (recent !== undefined && !(Number.isInteger(recent) && recent >= 1 && recent <= 10_000))
        throw new HarnessError(400, "recent : entier de 1 à 10 000");
      const at = Date.now();
      let more = false;
      let runs: RunRow[];
      if (recent !== undefined && since === undefined && !state && !repo) {
        const ended = store.listEndedRuns(call.repos, recent + 1);
        more = ended.length > recent;
        runs = [...store.listRuns({ state: LIVE_RUN_STATES, repos: call.repos }), ...ended.slice(0, recent)].sort(
          (a, b) => a.projectOrder - b.projectOrder || a.createdAt - b.createdAt,
        );
      } else {
        runs = store.listRuns({
          ...(state ? { state: state.split(",") as RunState[] } : {}),
          ...(repo ? { repo } : {}),
          ...(since !== undefined ? { updatedSince: since } : {}),
          repos: call.repos,
        });
      }
      // En file, la raison d'un run dit ce qui le retient (Orchestrator.withWait).
      send(call.res, 200, {
        runs: runs.map((run) => orchestrator.withWait(run)),
        at,
        ...(since !== undefined ? { since } : {}),
        ...(recent !== undefined && since === undefined ? { more } : {}),
      });
    }),
    route("POST", "/v1/runs", "operator", async (call) => {
      const body = await readBody(call.req);
      const input = newRunInput(body, call.client, { typed: true });
      repoInSpace(call, input.repo);
      await once(call, body, () => {
        const run = orchestrator.createRun(input, call.actor);
        return { status: 201, body: { run }, headers: { ETag: `"${run.rev}"` } };
      });
    }),
    route("GET", "/v1/runs/{id}", "viewer", (call) => {
      const view = orchestrator.runView(call.match[1] as string, call.repos);
      send(call.res, 200, view, { ETag: `"${(view.run as { rev: number }).rev}"` });
    }),
  ];

  const originRoutes = [
    route("GET", "/v1/runs/{id}/origin", "viewer", (call) => {
      const id = runId(call);
      ownerOf(call, READS_SIGNALS);
      send(call.res, 200, { origin: orchestrator.signals.originOf(id) });
    }),
  ];

  const workRoutes = [
    route("GET", "/v1/runs/{id}/timeline", "viewer", (call) =>
      send(call.res, 200, orchestrator.timeline(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/changes", "viewer", async (call) =>
      send(call.res, 200, await orchestrator.changes(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/diff", "viewer", async (call) => {
      const file = call.url.searchParams.get("path");
      if (!file) throw new HarnessError(400, "path manquant");
      send(call.res, 200, await orchestrator.fileDiff(call.match[1] as string, file, call.repos));
    }),
    route("GET", "/v1/runs/{id}/tests/live", "viewer", (call) =>
      send(call.res, 200, orchestrator.liveTests(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/session", "viewer", (call) =>
      send(call.res, 200, orchestrator.sessionView(call.match[1] as string, call.repos, pageOf(call.url))),
    ),
    route("GET", "/v1/runs/{id}/session/{n}", "viewer", (call) =>
      send(call.res, 200, orchestrator.sessionEntryView(call.match[1] as string, Number(call.match[2]), call.repos)),
    ),
    route("GET", "/v1/runs/{id}/graph", "viewer", (call) =>
      send(call.res, 200, orchestrator.graphView(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/proofs", "viewer", (call) =>
      send(call.res, 200, orchestrator.proofsView(call.match[1] as string, call.repos)),
    ),
    // Le contenu brut d'une preuve : le type déclaré, jamais deviné ; le fichier se retrouve par son rang seul.
    route("GET", "/v1/runs/{id}/proofs/{n}", "viewer", (call) => {
      const { proof, data } = orchestrator.proofContent(call.match[1] as string, Number(call.match[2]), call.repos);
      const ext = PROOF_MIMES[proof.kind][proof.mime];
      call.res.writeHead(200, {
        "Content-Type": proof.mime,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="preuve-${proof.n}.${ext}"`,
      });
      call.res.end(data);
    }),
    // L'annulation ; le corps est facultatif : `{cause?, note?}` dit pourquoi (sans corps, l'annulation d'avant).
    route("POST", "/v1/runs/{id}/cancel", "operator", async (call) => {
      const id = runId(call);
      const motive = cancelMotive(await readBody(call.req));
      send(call.res, 200, { run: await orchestrator.cancel(id, call.actor, motive) });
    }),
    // Une consigne au run : injectée dans le prompt en cours de sa session, sinon gardée pour le suivant.
    route("POST", "/v1/runs/{id}/instructions", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, await orchestrator.instruct(runId(call), instructionsInput(body, "text"), call.actor));
    }),
    // Le budget propre du run (`null` : celui de la configuration).
    route("POST", "/v1/runs/{id}/budget", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, await orchestrator.setBudget(runId(call), budgetInput(body), call.actor));
    }),
    route("POST", "/v1/runs/{id}/priority", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, { run: await orchestrator.setPriority(runId(call), priorityInput(body), call.actor) });
    }),
    route("POST", "/v1/runs/{id}/escalations", "operator", async (call) => {
      const body = await readBody(call.req);
      const answers = escalationAnswers(body);
      send(call.res, 200, { run: await orchestrator.answerEscalations(runId(call), answers, call.actor) });
    }),
    // La relance d'un run échoué ou en attente de l'humain : même étape, tout de suite, avec une consigne facultative.
    route("POST", "/v1/runs/{id}/retry", "operator", async (call) => {
      const body = await readBody(call.req);
      const instructions = instructionsInput(body, "instructions", false);
      send(call.res, 200, { run: await orchestrator.retry(runId(call), call.actor, instructions) });
    }),
    // Toutes les décisions prises seules d'un run, acceptées d'un geste.
    route("POST", "/v1/runs/{id}/decisions/accept", "operator", async (call) =>
      send(call.res, 200, await orchestrator.acceptAllDecisions(runId(call), call.actor)),
    ),
    // Le revert d'un run mergé : son commit est défait sur main, un run de suite est ouvert.
    route("POST", "/v1/runs/{id}/revert", "operator", async (call) =>
      send(call.res, 200, { run: await orchestrator.revert(runId(call), call.actor) }),
    ),
    route("POST", "/v1/runs/{id}/decisions/{n}/accept", "operator", async (call) =>
      send(call.res, 200, {
        decision: await orchestrator.acceptDecision(runId(call), Number(call.match[2]), call.actor),
      }),
    ),
    route("POST", "/v1/runs/{id}/decisions/{n}/reverse", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, {
        run: await orchestrator.reverseDecision(
          runId(call),
          Number(call.match[2]),
          text(body, "option"),
          text(body, "reason"),
          call.actor,
        ),
      });
    }),
    route("POST", "/v1/runs/{id}/validate", "operator", async (call) => {
      const body = await readBody(call.req);
      if (typeof body.approve !== "boolean") throw new HarnessError(400, "approve : booléen attendu");
      send(call.res, 200, {
        run: await orchestrator.validate(
          runId(call),
          body.approve,
          text(body, "reason", false),
          call.actor,
          alwaysInput(body),
        ),
      });
    }),
    // Les escalades ouvertes, BATCHÉES par run : l'écran iOS les traite d'un geste.
    route("GET", "/v1/escalations", "viewer", (call) =>
      send(
        call.res,
        200,
        escalationBatches(
          store,
          call.url.searchParams.get("status") === "answered" ? "answered" : "open",
          call.repos,
          orchestrator.config.review.escalationTimeoutSec,
          (run) => orchestrator.withWait(run),
        ),
      ),
    ),
    // La boîte de l'humain, d'un seul appel (apps Mac et iOS) : escalades batchées,
    // verdicts à valider, décisions prises seules, features en cours, et le
    // curseur du journal à partir duquel s'abonner au flux.
    route("GET", "/v1/inbox", "viewer", (call) => send(call.res, 200, orchestrator.inboxView(call.repos))),
    // La relecture du matin : les décisions prises seules (par l'agent, ou à l'échéance d'une escalade), pas encore relues.
    route("GET", "/v1/decisions", "viewer", (call) => {
      const status = (call.url.searchParams.get("status") ?? "auto,auto_timeout").split(",").filter(isDecisionStatus);
      send(call.res, 200, { decisions: store.listDecisions({ status, repos: call.repos }) });
    }),
    // Chaque projet avec le décompte de ses runs par état (la liste des apps).
    route("GET", "/v1/projects", "viewer", (call) => send(call.res, 200, { projects: projectsOf(store, call.repos) })),
    route("POST", "/v1/projects", "operator", async (call) => {
      const body = await readBody(call.req);
      if (!Array.isArray(body.features)) throw new HarnessError(400, "features : liste attendue");
      const features = body.features.map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const modules = stringList(record.modules, "features[].modules");
        const slug = text(record, "slug", false);
        return {
          title: text(record, "title"),
          request: text(record, "request"),
          ...(slug ? { slug } : {}),
          ...(modules ? { modules } : {}),
        };
      });
      const repo = text(body, "repo");
      requireRepo(call.client, repo);
      repoInSpace(call, repo);
      const priority = integer(body.priority, "priority");
      const autonomy = autonomyField(body);
      send(
        call.res,
        201,
        await orchestrator.createProject(
          {
            repo,
            title: text(body, "title"),
            features,
            ...(priority !== undefined ? { priority } : {}),
            ...(autonomy !== undefined ? { autonomy } : {}),
          },
          call.actor,
        ),
      );
    }),
    route("GET", "/v1/projects/{id}", "viewer", (call) => {
      const project = store.getProject(call.match[1] as string);
      if (!project || !sees(call, project.repo)) throw new HarnessError(404, `projet inconnu : ${call.match[1]}`);
      send(call.res, 200, { project, runs: store.listRuns({ projectId: project.id }) });
    }),
    route("GET", "/v1/dreams", "viewer", (call) =>
      send(call.res, 200, { dreams: orchestrator.dreams.list(call.repos) }),
    ),
    // Un rêve demandé : le dépôt est examiné au prochain tour, sans seuil de faits ni attente du repos.
    route("POST", "/v1/dreams", "operator", async (call) => {
      const body = await readBody(call.req);
      const repo = text(body, "repo");
      requireRepo(call.client, repo);
      repoInSpace(call, repo);
      orchestrator.dreams.request(repo, call.actor);
      void orchestrator.tick();
      send(call.res, 202, { repo, requested: true });
    }),
    route("GET", "/v1/audits", "viewer", (call) => send(call.res, 200, { audits: store.listAudits([], call.repos) })),
    route("POST", "/v1/audits", "operator", async (call) => {
      const body = await readBody(call.req);
      const repo = text(body, "repo");
      requireRepo(call.client, repo);
      repoInSpace(call, repo);
      const audit = orchestrator.audits.create(repo, text(body, "focus", false), call.actor);
      void orchestrator.tick();
      send(call.res, 201, { audit });
    }),
    route("GET", "/v1/audits/{id}", "viewer", (call) =>
      send(call.res, 200, { audit: visibleAudit(call, call.match[1] as string) }),
    ),
    route("GET", "/v1/audits/{id}/session", "viewer", (call) =>
      send(
        call.res,
        200,
        orchestrator.auditSessionView(visibleAudit(call, call.match[1] as string).id, pageOf(call.url)),
      ),
    ),
    route("GET", "/v1/audits/{id}/session/{n}", "viewer", (call) =>
      send(
        call.res,
        200,
        orchestrator.auditSessionEntryView(visibleAudit(call, call.match[1] as string).id, Number(call.match[2])),
      ),
    ),
    // Les propositions retenues (index dans `proposals`) partent en projet.
    route("POST", "/v1/audits/{id}/launch", "operator", async (call) => {
      const audit = visibleAudit(call, call.match[1] as string);
      const body = await readBody(call.req);
      if (!Array.isArray(body.items) || body.items.some((item) => !Number.isInteger(item)))
        throw new HarnessError(400, "items : liste d'index attendue");
      send(
        call.res,
        201,
        await orchestrator.audits.launch(audit.id, body.items as number[], text(body, "title", false), call.actor),
      );
    }),
    route("POST", "/v1/audits/{id}/cancel", "operator", async (call) =>
      send(call.res, 200, {
        audit: await orchestrator.audits.cancel(visibleAudit(call, call.match[1] as string).id, call.actor),
      }),
    ),
  ];

  const statsRoutes = [
    route("GET", "/v1/stats", "viewer", (call) =>
      send(call.res, 200, {
        ...statsCache.read(call.repos, () => computeStats(store, Date.now(), call.repos)),
        scheduler: orchestrator.status(call.repos).scheduler,
      }),
    ),
    // L'autonomie par paliers, en lecture seule : les règles de chaque dépôt visible, ce qui a été validé seul
    // (avec sa règle et ses preuves) et les propositions de palier. Une règle s'écrit par `POST /v1/autonomy/rules`.
    route("GET", "/v1/autonomy", "viewer", (call) => {
      const now = Date.now();
      const { config } = orchestrator;
      send(call.res, 200, {
        repos: config.repos
          .filter((repo) => call.repos === null || call.repos.includes(repo.name))
          .map((repo) => ({ repo: repo.name, rules: repo.autonomy?.rules ?? [] })),
        validations: autonomyValidations(store, config.autonomyLearning.windowDays, now, call.repos),
        proposals: autonomyProposals(store, config, now, call.repos),
      });
    }),
    // Le rapport du matin : ce qui s'est fait seul depuis `since` (epoch ms ; défaut : 24 h).
    route("GET", "/v1/digest", "viewer", (call) => {
      const now = Date.now();
      const raw = call.url.searchParams.get("since");
      const since = raw === null ? now - DIGEST_WINDOW_MS : Number(raw);
      if (!Number.isInteger(since) || since < 0) throw new HarnessError(400, "since : instant en ms (epoch) attendu");
      send(
        call.res,
        200,
        digestOf(store, since, now, call.repos, HARNESS_COMMIT, orchestrator.observability.digestHealth()),
      );
    }),
    // Les planifications récurrentes (schedules.ts) : celles des dépôts que le client voit.
    route("GET", "/v1/schedules", "viewer", (call) => send(call.res, 200, orchestrator.schedules.view(call.repos))),
    route("POST", "/v1/schedules", "operator", async (call) => {
      const input = scheduleInput(await readBody(call.req), call.client);
      if (input.target.kind !== "automation") repoInSpace(call, input.target.repo);
      const schedule = orchestrator.schedules.create(input, call.actor);
      send(call.res, 201, { schedule }, { ETag: `"${schedule.rev}"` });
    }),
    route("PUT", "/v1/schedules/{id}", "operator", async (call) => {
      const body = await readBody(call.req);
      const schedule = orchestrator.schedules.update(
        call.match[1] as string,
        scheduleEdit(body, call.client),
        call.actor,
        call.repos,
      );
      send(call.res, 200, { schedule }, { ETag: `"${schedule.rev}"` });
    }),
    route("DELETE", "/v1/schedules/{id}", "operator", (call) => {
      orchestrator.schedules.delete(call.match[1] as string, call.actor, call.repos);
      send(call.res, 200, { deleted: true });
    }),
    // Le déclencheur entrant : une planification (même désactivée) lancée à la demande. `payload` — ce que
    // l'appelant (CI, webhook, script) veut dire au run — rejoint la demande d'un run comme donnée non fiable.
    route("POST", "/v1/schedules/{id}/run", "operator", async (call) => {
      const body = await readBody(call.req);
      const payload = instructionsInput(body, "payload", false);
      await once(call, body, async () => {
        const fired = await orchestrator.schedules.runNow(
          call.match[1] as string,
          call.actor,
          call.repos,
          Date.now(),
          payload,
        );
        void orchestrator.tick();
        return { status: 201, body: fired, headers: { ETag: `"${fired.schedule.rev}"` } };
      });
    }),
  ];

  const amendRoutes = [
    // ── OS agentique : la boucle (corriger, motif d'annulation, modules, pause) ──
    // Corriger un run là où il est, au lieu de l'annuler : specs refaites, correction, relance ou consigne (`via`).
    route("POST", "/v1/runs/{id}/amend", "operator", async (call) => {
      const body = await readBody(call.req);
      const correction = instructionsInput(body, "text");
      send(call.res, 200, await orchestrator.amend(runId(call), correction, call.actor, alwaysInput(body)));
    }),
    // Les modules d'un run, restreints par l'humain : ce qu'il retenait en file peut partir.
    route("POST", "/v1/runs/{id}/modules", "operator", async (call) => {
      const modules = modulesInput(await readBody(call.req));
      send(call.res, 200, { run: await orchestrator.setModules(runId(call), modules, call.actor) });
    }),
  ];

  const autonomyRoutes = [
    // ── OS agentique : l'autonomie (règles, consignes permanentes, curseur) ──
    // Le curseur d'autonomie d'un run : « tout me demander » (`ask`), les règles du dépôt (`null`), « livre et
    // préviens-moi » (`deliver`). Geste d'humain : un pilote ne le monte pas (403), un run terminé est refusé (409).
    route("POST", "/v1/runs/{id}/autonomy", "operator", async (call) => {
      const level = autonomyLevelInput(await readBody(call.req));
      send(call.res, 200, { run: await orchestrator.setAutonomy(runId(call), level, call.actor) });
    }),
    // « Toujours valider seul ce type » : la porte d'un type de travail d'un dépôt, écrite dans la configuration
    // et rechargée à chaud comme `PATCH /v1/repos/{name}` ; invalide, 400 et rien ne change.
    route("POST", "/v1/autonomy/rules", "admin", async (call) => {
      const target = adminOf(call);
      const input = autonomyRuleInput(await readBody(call.req));
      send(call.res, 200, await orchestrator.applyAutonomyRule(target, input, call.actor));
    }),
    // Les consignes permanentes de l'humain (« toujours faire ainsi »), dites dans le prompt de chaque étape,
    // à trois niveaux : un dépôt, un espace (`space`), tous les dépôts. Un client borné lit celles de ses dépôts
    // et des espaces où il en voit ; il n'écrit que pour ses dépôts, ou pour un espace qu'il voit en entier,
    // jamais pour tous ; un pilote n'en écrit pas. `?space=` : celles de l'espace et de ses dépôts seulement.
    route("GET", "/v1/rules", "viewer", (call) =>
      send(call.res, 200, { rules: store.listStandingRules(call.repos, call.space?.id ?? null) }),
    ),
    route("POST", "/v1/rules", "operator", async (call) => {
      const body = standingRuleInput(await readBody(call.req));
      const within = call.space;
      const named = body.space?.trim().toLowerCase() ?? null;
      if (within !== null && body.repo !== null && !within.repos.includes(body.repo))
        throw new HarnessError(400, `repo : le dépôt ${body.repo} n'est pas dans l'espace « ${within.name} »`);
      if (within !== null && named !== null && named !== within.id && named !== within.name.toLowerCase())
        throw new HarnessError(400, "space : un autre espace que celui de `?space=`");
      // Sous `?space=`, une consigne sans dépôt est celle de l'espace.
      const input = within !== null && body.repo === null ? { ...body, space: within.id } : body;
      send(call.res, 201, { rule: orchestrator.standing.create(input, call.actor, repoFilter(call.client)) });
    }),
    route("PUT", "/v1/rules/{id}", "operator", async (call) => {
      const patch = standingRulePatch(await readBody(call.req));
      send(call.res, 200, {
        rule: orchestrator.standing.update(
          call.match[1] as string,
          patch,
          call.actor,
          repoFilter(call.client),
          call.space,
        ),
      });
    }),
    route("DELETE", "/v1/rules/{id}", "operator", (call) => {
      orchestrator.standing.remove(call.match[1] as string, call.actor, repoFilter(call.client), call.space);
      send(call.res, 200, { removed: true });
    }),
  ];

  const briefRoutes = [
    // Le brief « pendant votre absence » (brief.ts) : depuis `since` (epoch ms), sinon depuis la dernière
    // fois que CE client l'a vu (`POST /v1/brief/seen`), sinon sur 24 heures.
    route("GET", "/v1/brief", "viewer", (call) => {
      const raw = call.url.searchParams.get("since");
      const since = raw === null ? null : Number(raw);
      if (since !== null && (!Number.isInteger(since) || since < 0))
        throw new HarnessError(400, "since : instant en ms (epoch) attendu");
      const owner = call.client.repos === "*";
      send(call.res, 200, { brief: orchestrator.briefView(call.client.name, since, call.repos, Date.now(), owner) });
    }),
    route("POST", "/v1/brief/seen", "viewer", (call) =>
      send(call.res, 200, { seenAt: orchestrator.briefSeen(call.client.name) }),
    ),
    // Les chiffres (scoreboard.ts) : mergés sans geste humain, délai médian d'une décision, travail lancé
    // sans l'humain, motifs d'annulation, sur `days` jours (défaut 7, de 1 à 90 sans dépasser la
    // rétention du journal, `events.retentionDays` : les gestes humains s'y lisent).
    route("GET", "/v1/scoreboard", "viewer", (call) => {
      const raw = call.url.searchParams.get("days");
      const days = scoreboardDays(raw === null ? null : Number(raw), orchestrator.config);
      send(call.res, 200, {
        scoreboard: scoreboardOf(store, orchestrator.config, days, Date.now(), call.repos),
      });
    }),
  ];

  const proposalRoutes = [
    // ── OS agentique : les propositions et « refaire » ──
    // Le bac « Propositions » (proposals.ts) : ce que l'usine pourrait faire seule, recalculé de ses causes.
    // Lire : les dépôts visibles, les signalements et le plan Atlassian au propriétaire. Accepter passe par
    // le geste existant de la source, avec ses gardes ; écarter est définitif.
    route("GET", "/v1/proposals", "viewer", (call) =>
      send(call.res, 200, {
        proposals: orchestrator.proposals.list({ ...readerOf(call.client), repos: call.repos }),
      }),
    ),
    route("POST", "/v1/proposals/{id}/accept", "operator", async (call) =>
      send(
        call.res,
        200,
        await orchestrator.proposals.accept(call.match[1] as string, {
          client: call.client,
          actor: call.actor,
          admin: () => adminOf(call),
        }),
      ),
    ),
    route("POST", "/v1/proposals/{id}/dismiss", "operator", (call) =>
      send(
        call.res,
        200,
        orchestrator.proposals.dismiss(call.match[1] as string, { client: call.client, actor: call.actor }),
      ),
    ),
    // « Refaire » : le corps d'un `POST /v1/runs` qui relancerait la feature, à la demande d'origine de son fil.
    route("GET", "/v1/runs/{id}/template", "viewer", (call) =>
      send(call.res, 200, { template: orchestrator.proposals.template(runId(call)) }),
    ),
  ];

  const mcpRoutes = [
    // MCP (« Streamable HTTP », réponses JSON) : un message ou un lot JSON-RPC ; sans requête
    // à rendre (notifications seules), 202. Pas de flux serveur : `GET` reste un 405.
    route("POST", "/v1/mcp", "viewer", async (call) => {
      let body: unknown;
      try {
        body = await readJson(call.req);
      } catch (err) {
        if (!(err instanceof HarnessError) || err.status !== 400) throw err;
        send(call.res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } });
        return;
      }
      const mcp = {
        client: call.client,
        actor: call.actor,
        desk: orchestrator.issues,
        repos: () => orchestrator.config.repos,
        orchestrator,
        visible: call.repos,
        space: call.space,
        version: HARNESS_VERSION,
        admin: () => adminOf(call),
      };
      const replies = await Promise.all(
        (Array.isArray(body) ? body : [body]).map((message) => handleMcp(message, mcp)),
      );
      const answered = replies.filter((reply) => reply !== null);
      if (answered.length === 0) {
        call.res.writeHead(202, { "Cache-Control": "no-store" });
        call.res.end();
        return;
      }
      send(call.res, 200, Array.isArray(body) ? answered : answered[0]);
    }),
  ];

  return {
    statusRoutes,
    runListRoutes,
    originRoutes,
    workRoutes,
    statsRoutes,
    amendRoutes,
    autonomyRoutes,
    briefRoutes,
    proposalRoutes,
    mcpRoutes,
  };
}
