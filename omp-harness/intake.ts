// Les Demandes : une phrase libre, de n'importe quel client, que l'OS classe (un job léger
// comme les audits, sans dépôt ni mémoire), transforme en plan lisible et crée après UNE
// confirmation, par les chemins existants (intake-create.ts). Rien n'existe avant.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client } from "./auth.ts";
import { canSeeRepo } from "./auth.ts";
import { isRecord, repoByName, repoDefaults } from "./config.ts";
import type { HarnessConfig, ModelPolicy, RepoConfig } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import { parseCron } from "./cron.ts";
import { INTAKE_STATES } from "./db.ts";
import type { IntakeExchange, IntakePatch, IntakePlan, IntakeRow, IntakeState, Store } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { MAX_INSTRUCTIONS, requireRepo, text } from "./input.ts";
import { intakePrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import { forceStop, hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";
import { NAME_MAX } from "./schedules.ts";
import { MAX_INSTRUCTION } from "./workstation.ts";

export const INTAKE_SOURCES = ["console", "ios", "voice", "slack", "cli", "chrome"] as const;
export const INTAKE_KINDS = ["feature", "bug", "audit", "workstation_request", "schedule", "question"] as const;
const PLAN_KINDS = INTAKE_KINDS.filter((kind) => kind !== "question");
const TITLE_MAX = 200;

/** L'objet que la confirmation a créé, par le chemin existant du type de la demande. */
export type Created = { kind: "run" | "audit" | "workstation_request" | "schedule"; id: string };

export type IntakeHooks = { create: (plan: IntakePlan, client: Client, actor: Actor) => Created };

type LiveIntake = {
  abort: AbortController;
  session: RunnerSession | null;
  /** Les arguments de `intake_classify`, jugés après la session (rien n'est validé avant). */
  raw: Record<string, unknown> | null;
  done: Promise<void>;
};

/** Ce que la confirmation du plan créera, rédigé par le serveur (jamais par le modèle). */
function creates(plan: IntakePlan): string {
  const repo = plan.repo ?? "";
  switch (plan.kind) {
    case "feature":
    case "bug":
      return `Un run « ${plan.title} » sur ${repo}`;
    case "audit":
      return `Un audit de ${repo}${plan.focus ? ` (${plan.focus})` : ""}`;
    case "workstation_request":
      return `Une demande au poste : « ${plan.title} »`;
    case "schedule": {
      const schedule = plan.schedule as NonNullable<IntakePlan["schedule"]>;
      const target =
        schedule.target === "run"
          ? `un run sur ${repo}`
          : schedule.target === "audit"
            ? `un audit de ${repo}`
            : `la correction des issues de ${repo}${schedule.label ? ` (label ${schedule.label})` : ""}`;
      return `Une planification « ${plan.title} » (${schedule.cron}) qui lance ${target}`;
    }
  }
}

/** La Demande telle que le contrat public de `/v1/intake` la rend. */
export type IntakeView = {
  id: string;
  text: string;
  source: string;
  repo: string | null;
  requestedRepo: string | null;
  state: IntakeState;
  kind: IntakeRow["kind"];
  plan: (IntakePlan & { creates: string }) | null;
  question: string | null;
  answer: string | null;
  exchanges: IntakeExchange[];
  /** Le texte d'origine suivi des réponses de clarification. */
  statement: string;
  created: Created | null;
  reason: string | null;
  by: string | null;
  createdAt: number;
  updatedAt: number;
};

/** La Demande telle que les clients la lisent (contrat public : jamais la portée de l'auteur). */
export function intakeView(row: IntakeRow): IntakeView {
  return {
    id: row.id,
    text: row.text,
    source: row.source,
    repo: row.repo || null,
    requestedRepo: row.requestedRepo,
    state: row.state,
    kind: row.kind,
    plan: row.plan ? { ...row.plan, creates: creates(row.plan) } : null,
    question: row.question,
    answer: row.answer,
    exchanges: row.exchanges,
    statement: [row.text, ...row.exchanges.map((exchange) => exchange.answer)].join("\n\n"),
    created: row.targetKind && row.targetId ? { kind: row.targetKind as Created["kind"], id: row.targetId } : null,
    reason: row.reason,
    by: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** La règle de lecture : le dépôt de la demande, sinon son auteur ou un client qui voit tous les dépôts. */
function visible(client: Client, row: IntakeRow): boolean {
  return row.repo !== "" ? canSeeRepo(client, row.repo) : client.repos === "*" || row.createdBy === client.name;
}

/** Une demande lisible par `client` ; 404 sinon (absente ou invisible : on ne dit pas laquelle). */
export function visibleIntake(store: Store, client: Client, id: string): IntakeRow {
  const row = store.getIntake(id);
  if (!row || !visible(client, row)) throw new HarnessError(404, `demande inconnue : ${id}`);
  return row;
}

/** `?state=a,b` : des états connus, ou 400. */
export function parseIntakeStates(raw: string | null): IntakeState[] {
  if (raw === null || raw === "") return [];
  const states = raw.split(",").map((state) => state.trim());
  if (!states.every((state) => (INTAKE_STATES as readonly string[]).includes(state)))
    throw new HarnessError(400, `state : états attendus parmi ${INTAKE_STATES.join(", ")}`);
  return states as IntakeState[];
}

/** Les dépôts déclarés que la portée de l'auteur voit. */
function visibleRepos(config: HarnessConfig, scope: IntakeRow["scope"]): string[] {
  return config.repos.map((repo) => repo.name).filter((name) => scope === "*" || scope.includes(name));
}

/**
 * La politique de modèles du classement : celle du dépôt imposé à la pose ; sinon `local-only`
 * dès qu'un dépôt visible de l'auteur l'est (le texte libre peut le nommer) ; sinon les
 * chaînes du serveur. Jamais `memory`, `gh` ni `git` du dépôt.
 */
export function intakePolicy(config: HarnessConfig, row: IntakeRow): ModelPolicy {
  if (row.requestedRepo !== null) {
    const repo = repoByName(config, row.requestedRepo);
    if (!repo) throw new HarnessError(404, `dépôt inconnu : ${row.requestedRepo}`);
    return {
      ...(repo.models ? { models: repo.models } : {}),
      ...(repo.providers ? { providers: repo.providers } : {}),
      ...(repo.privacy ? { privacy: repo.privacy } : {}),
    };
  }
  const names = visibleRepos(config, row.scope);
  return config.repos.some((repo) => names.includes(repo.name) && repo.privacy === "local-only")
    ? { privacy: "local-only" }
    : {};
}

/**
 * Le dépôt synthétique du classeur : aucun clone, aucun worktree, aucune mémoire. Sa scope
 * est propre à la demande (jamais relue), son cwd a la forme `<dépôt>/<_x>` du lanceur root.
 */
export function intakeTarget(config: HarnessConfig, row: IntakeRow): { repo: RepoConfig; cwd: string; memory: false } {
  return {
    repo: {
      ...repoDefaults({ name: "intake", path: path.join(config.dataDir, "intake"), scope: `intake-${row.id}` }),
      ...intakePolicy(config, row),
    },
    cwd: path.join(config.worktreesDir, "intake", "_demande"),
    memory: false,
  };
}

type Fields = {
  kind: string;
  title: string;
  statement: string;
  repo: string;
  focus: string;
  cron: string;
  target: string;
  label: string;
};
type Judged = { plan: IntakePlan } | { reason: string };

/** Les règles d'un plan (S-4, règles 4 à 8), communes au classement et à la correction à la confirmation. */
function judge(fields: Fields, scope: IntakeRow["scope"], declared: string[]): Judged {
  const { kind, repo, focus, cron, target, label } = fields;
  if (fields.title === "") return { reason: "le plan n'a pas de titre" };
  if (fields.statement === "") return { reason: "le plan n'a pas d'énoncé" };
  const title = fields.title.slice(0, kind === "schedule" ? NAME_MAX : TITLE_MAX);
  const statement = fields.statement.slice(0, MAX_INSTRUCTION);
  if (kind === "workstation_request") return { plan: { kind, repo: null, title, statement } };
  if (repo === "") return { reason: "le plan ne nomme aucun dépôt" };
  if (!declared.includes(repo)) return { reason: `le dépôt « ${repo} » n'est pas déclaré sur le harness` };
  if (scope !== "*" && !scope.includes(repo))
    return { reason: `le dépôt « ${repo} » est hors de la portée de l'auteur` };
  const plan = { kind, repo, title, statement } as IntakePlan;
  if (kind === "audit" && focus !== "") plan.focus = focus;
  if (kind === "schedule") {
    let source: string;
    try {
      source = parseCron(cron).source;
    } catch (err) {
      return { reason: `cron invalide : ${err instanceof Error ? err.message : String(err)}` };
    }
    if (target !== "run" && target !== "audit" && target !== "issues")
      return { reason: `cible de planification « ${target} » refusée (run, audit ou issues)` };
    plan.schedule = {
      cron: source,
      target,
      ...(target === "audit" && focus !== "" ? { focus } : {}),
      ...(target === "issues" && label !== "" ? { label } : {}),
    };
  }
  return { plan };
}

/** Juge le rendu de `intake_classify` : un `IntakePatch` (clarification, réponse, plan ou échec). Pure. */
export function interpretClassification(
  raw: Record<string, unknown>,
  ctx: { declared: string[]; scope: IntakeRow["scope"]; requestedRepo: string | null },
): IntakePatch {
  const field = (key: string): string => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const failed = (reason: string): IntakePatch => ({ state: "failed", reason });
  const clarification = field("clarification");
  if (clarification !== "")
    return { state: "clarifying", question: clarification.slice(0, 1000), kind: null, plan: null };
  const kind = field("kind");
  if (!(INTAKE_KINDS as readonly string[]).includes(kind))
    return failed(`le classement a rendu un type inconnu : « ${kind} »`);
  if (kind === "question") {
    const answer = field("answer");
    if (answer === "") return failed("la réponse directe est vide");
    return { state: "answered", kind: "question", answer: answer.slice(0, 4000), plan: null };
  }
  const judged = judge(
    {
      kind,
      title: field("title"),
      statement: field("statement"),
      repo: ctx.requestedRepo ?? field("repo"),
      focus: field("focus"),
      cron: field("cron"),
      target: field("target"),
      label: field("label"),
    },
    ctx.scope,
    ctx.declared,
  );
  if ("reason" in judged) return failed(judged.reason);
  const { plan } = judged;
  return { state: "planned", kind: plan.kind, plan, repo: plan.repo ?? "", question: null, reason: null };
}

/** Une chaîne facultative d'une correction : absente = inchangée, `null` = vidée. */
function correction(source: Record<string, unknown>, key: string, current: string): string {
  const value = source[key];
  if (value === undefined) return current;
  if (value === null) return "";
  if (typeof value === "string") return value.trim();
  throw new HarnessError(400, `plan.${key} : chaîne attendue`);
}

/** Les états d'où une demande s'annule : tout sauf `confirmed` et `cancelled`. */
const CANCELLABLE: readonly IntakeState[] = ["classifying", "clarifying", "planned", "answered", "failed"];

export class Intaker {
  readonly #ctx: HarnessContext;
  readonly #hooks: IntakeHooks;
  readonly #live = new Map<string, LiveIntake>();

  constructor(ctx: HarnessContext, hooks: IntakeHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  #event(row: IntakeRow, extra: Record<string, unknown> = {}): void {
    const repo = row.repo || null;
    this.#ctx.event(
      "intake_state",
      null,
      { intakeId: row.id, state: row.state, kind: row.kind, repo, reason: row.reason, ...extra },
      repo,
    );
  }

  /** Le texte d'une demande ou d'une réponse : non vide, au plus MAX_INSTRUCTIONS caractères. */
  #text(body: Record<string, unknown>): string {
    const value = text(body, "text").trim();
    if (value === "") throw new HarnessError(400, "text : la demande est vide");
    if (value.length > MAX_INSTRUCTIONS) throw new HarnessError(400, `text : ${MAX_INSTRUCTIONS} caractères au plus`);
    return value;
  }

  create(body: Record<string, unknown>, client: Client, actor: Actor): IntakeRow {
    const { store } = this.#ctx;
    const demande = this.#text(body);
    const source = typeof body.source === "string" ? body.source : "";
    if (!(INTAKE_SOURCES as readonly string[]).includes(source))
      throw new HarnessError(400, "source : console, ios, voice, slack, cli ou chrome attendu");
    const repo = text(body, "repo", false).trim();
    if (repo !== "") {
      requireRepo(client, repo);
      this.#ctx.repo(repo);
    }
    return store.transaction(() => {
      const row = store.createIntake({
        id: newId("i"),
        text: demande,
        source,
        repo,
        requestedRepo: repo || null,
        scope: client.repos,
        createdBy: actor.by,
      });
      this.#event(row, actor.by ? { by: actor.by } : {});
      return row;
    });
  }

  /** Les demandes en classement que le scheduler admet. */
  tick(): void {
    for (const row of this.#ctx.store.listIntakes({ states: ["classifying"] })) {
      if (this.#live.has(row.id)) continue;
      if (this.#ctx.monitor.dailyBudgetDue()) return;
      const slot = this.#ctx.scheduler.tryAcquire("runner", row.id);
      if ("refused" in slot) return;
      const live: LiveIntake = { abort: new AbortController(), session: null, raw: null, done: Promise.resolve() };
      this.#live.set(row.id, live);
      live.done = this.#drive(row, live).finally(async () => {
        await live.session?.stop();
        slot.release();
        this.#live.delete(row.id);
      });
    }
  }

  /** Ne rejette jamais : toute exception devient un échec lisible, sinon la ligne resterait en classement. */
  async #drive(row: IntakeRow, live: LiveIntake): Promise<void> {
    let patch: IntakePatch;
    try {
      const { config } = this.#ctx;
      const target = intakeTarget(config, row);
      fs.mkdirSync(target.repo.path, { recursive: true });
      fs.mkdirSync(target.cwd, { recursive: true });
      const session = new RunnerSession(this.#ctx, target, {
        onHostTool: (name, args) => this.#hostTool(row, live, name, args),
        event: (type, payload) => this.#ctx.event(type, null, { intakeId: row.id, ...payload }, row.repo || null),
      });
      live.session = session;
      const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
      await session.open(config.intake.tier, runnerUnit(row.id, 0), live.abort.signal);
      await session.setHostTools(hostToolsFor("intake"));
      let result = await session.prompt(
        intakePrompt({
          text: row.text,
          source: row.source,
          visibleRepos: visibleRepos(config, row.scope),
          requestedRepo: row.requestedRepo,
          exchanges: row.exchanges,
        }),
        live.abort.signal,
        deadlineAt,
      );
      if (result.status === "completed" && live.raw === null) {
        result = await session.prompt(
          "L'étape /demande n'est pas terminée : le classement n'a pas été rendu par `intake_classify`. Rends-le maintenant.",
          live.abort.signal,
          deadlineAt,
        );
      }
      if (result.status !== "completed") throw new Error(result.error?.message ?? "erreur du runner");
      patch =
        live.raw === null
          ? { state: "failed", reason: "le classement n'a pas été rendu" }
          : interpretClassification(live.raw, {
              declared: config.repos.map((repo) => repo.name),
              scope: row.scope,
              requestedRepo: row.requestedRepo,
            });
    } catch (err) {
      patch = {
        state: "failed",
        reason: `le classement a échoué : ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (live.abort.signal.aborted) return;
    const { store } = this.#ctx;
    store.transaction(() => {
      const next = store.updateIntakeIf(row.id, ["classifying"], patch);
      if (next) this.#event(next);
    });
    if (patch.state === "failed") {
      this.#ctx.log(`demande ${row.id} en échec : ${patch.reason}`, {
        level: "warn",
        ...(row.repo ? { repo: row.repo } : {}),
      });
    }
  }

  async #hostTool(
    row: IntakeRow,
    live: LiveIntake,
    name: string,
    args: Record<string, unknown>,
  ): Promise<HostToolResult> {
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#ctx.event("progress", null, { intakeId: row.id, message }, row.repo || null);
        return { text: "noté" };
      }
      case "intake_classify":
        if (live.abort.signal.aborted) return { text: "demande annulée", isError: true };
        live.raw = args;
        return { text: "classement reçu. Termine ton tour." };
      default:
        return { text: `outil inconnu : ${name}`, isError: true };
    }
  }

  /**
   * Corrige le plan prêt (champ à champ) et le rejuge avec les règles du classement, contre la
   * portée de celui qui confirme ; chaque refus est un 400.
   */
  #corrected(plan: IntakePlan, raw: unknown, client: Client): IntakePlan {
    if (!isRecord(raw)) throw new HarnessError(400, "plan : objet attendu");
    const schedule = raw.schedule === undefined ? {} : raw.schedule;
    if (!isRecord(schedule)) throw new HarnessError(400, "plan.schedule : objet attendu");
    const kind = correction(raw, "kind", plan.kind);
    if (raw.clarification !== undefined || !(PLAN_KINDS as readonly string[]).includes(kind))
      throw new HarnessError(400, "plan : type inconnu ou sans objet");
    const judged = judge(
      {
        kind,
        title: correction(raw, "title", plan.title),
        statement: correction(raw, "statement", plan.statement),
        repo: correction(raw, "repo", plan.repo ?? ""),
        focus:
          kind === "schedule"
            ? correction(schedule, "focus", plan.schedule?.focus ?? "")
            : correction(raw, "focus", plan.focus ?? ""),
        cron: correction(schedule, "cron", plan.schedule?.cron ?? ""),
        target: correction(schedule, "target", plan.schedule?.target ?? ""),
        label: correction(schedule, "label", plan.schedule?.label ?? ""),
      },
      client.repos,
      this.#ctx.config.repos.map((repo) => repo.name),
    );
    if ("reason" in judged) throw new HarnessError(400, judged.reason);
    return judged.plan;
  }

  /**
   * Confirme le plan : crée l'objet par le chemin existant et lie la demande. SYNCHRONE de la
   * lecture de l'état à l'écriture du lien (aucun `await`) : deux confirmations simultanées
   * ne créent qu'un objet. Un refus du chemin existant annule tout, la demande reste prête.
   */
  confirm(id: string, client: Client, actor: Actor, body: Record<string, unknown>): IntakeRow {
    const { store } = this.#ctx;
    const row = visibleIntake(store, client, id);
    const notPlanned = (state: string): HarnessError =>
      new HarnessError(409, `la demande n'a pas de plan à confirmer (état ${state})`);
    if (row.state !== "planned" || row.plan === null) throw notPlanned(row.state);
    const plan = body.plan === undefined ? row.plan : this.#corrected(row.plan, body.plan, client);
    return store.transaction(() => {
      const reserved = store.updateIntakeIf(id, ["planned"], {
        state: "confirmed",
        plan,
        kind: plan.kind,
        repo: plan.repo ?? "",
      });
      if (!reserved) throw notPlanned(store.getIntake(id)?.state ?? "inconnu");
      const created = this.#hooks.create(plan, client, actor);
      const done = store.updateIntakeIf(id, ["confirmed"], {
        targetKind: created.kind,
        targetId: created.id,
      }) as IntakeRow;
      this.#event(done, { ...(actor.by ? { by: actor.by } : {}), created });
      return done;
    });
  }

  /** Annule une demande non confirmée ; son job, s'il tourne, est arrêté et n'écrit plus rien. */
  async cancel(id: string, client: Client, actor: Actor): Promise<IntakeRow> {
    const { store } = this.#ctx;
    const row = visibleIntake(store, client, id);
    const cancelled = store.updateIntakeIf(id, CANCELLABLE, { state: "cancelled", reason: "annulée par l'humain" });
    if (!cancelled) throw new HarnessError(409, `demande déjà ${row.state}`);
    const live = this.#live.get(id);
    if (live) {
      live.abort.abort();
      await live.session?.stop();
      await live.done;
    }
    this.#event(cancelled, actor.by ? { by: actor.by } : {});
    return cancelled;
  }

  /** Répond à la question de clarification : la même demande repasse en classement. */
  answer(id: string, client: Client, actor: Actor, body: Record<string, unknown>): IntakeRow {
    const { store } = this.#ctx;
    const row = visibleIntake(store, client, id);
    const reply = this.#text(body);
    const waiting = (state: string): HarnessError =>
      new HarnessError(409, `la demande n'attend pas de réponse (état ${state})`);
    if (row.state !== "clarifying") throw waiting(row.state);
    const exchange: IntakeExchange = { question: row.question ?? "", answer: reply, at: Date.now() };
    return store.transaction(() => {
      const next = store.updateIntakeIf(id, ["clarifying"], {
        state: "classifying",
        question: null,
        exchanges: [...row.exchanges, exchange],
      });
      if (!next) throw waiting(store.getIntake(id)?.state ?? "inconnu");
      this.#event(next, { ...(actor.by ? { by: actor.by } : {}), answered: true });
      return next;
    });
  }

  /** Un classement qu'un process mort a laissé en cours repart de zéro (rien n'a été écrit). */
  async recover(): Promise<void> {
    const { store, config, exec } = this.#ctx;
    for (const row of store.listIntakes({ states: ["classifying"] })) {
      await forceStop(config, exec, runnerUnit(row.id, 0));
      const requeued = store.updateIntakeIf(row.id, ["classifying"], {
        reason: "service redémarré — classement relancé",
      });
      if (requeued) this.#event(requeued, { recovered: true });
    }
  }

  isLive(id: string): boolean {
    return this.#live.has(id);
  }

  async stop(): Promise<void> {
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map((live) => live.done));
  }
}
