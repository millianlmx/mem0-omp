// Les planifications récurrentes : « chaque lundi, audite X », « chaque nuit, corrige les
// issues omp:fix », « chaque jour à 8 h, relance la veille Y ». Une planification porte une
// expression cron (cron.ts, lue dans le fuseau `schedules.timezone`) et une cible : un run,
// un audit, ou une relève des issues ouvertes d'un label.
//
// Le tour de l'orchestrateur appelle `tick` : chaque planification due est traitée UNE fois.
// - Après un arrêt du service, les échéances passées ne partent pas en rafale : la plus
//   récente est lancée si elle date de moins de `schedules.catchUpMin` minutes, les autres
//   sont comptées (`missed`) ; plus vieilles, rien ne part et l'issue est « manquée ».
// - Le plafond journalier atteint (`monitor.dailyBudgetDue()`), l'échéance est sautée.
// - Pas d'empilement : tant que le run (ou l'audit) lancé par l'échéance précédente n'est pas
//   fini, ou que sa relève d'issues court encore, l'échéance est sautée.
// Chaque échéance traitée écrit `lastOutcome` et un événement `schedule_fired` ou
// `schedule_skipped` (SSE, notifiable par `notify.events`), au dépôt de la cible.
import type { Client } from "./auth.ts";
import { isRecord } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import { SERVICE } from "./context.ts";
import type { Cron } from "./cron.ts";
import { nextOccurrence, parseCron } from "./cron.ts";
import type { AuditRow, RepoFilter, RunRow, ScheduleOutcome, ScheduleRow, ScheduleTarget } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { budgetUsd, integer, requireRepo, text } from "./input.ts";
import type { LabeledOutcome } from "./issues.ts";
import { TERMINAL_STATES } from "./machine.ts";
import type { NewRunInput } from "./orchestrator.ts";

/** Les cibles servies aujourd'hui. */
export const TARGET_KINDS = ["run", "audit", "issues"] as const;

/** Les cibles annoncées mais pas encore servies : refusées avec ce qui manque. */
const RESERVED_KINDS: Readonly<Record<string, string>> = {
  automation:
    "target.kind « automation » : les automatisations du poste Chrome ne sont pas encore planifiables (cible réservée à une version future)",
};

const NAME_MAX = 120;
/** Au-delà, les échéances manquées pendant un arrêt ne sont plus comptées une à une. */
const MISSED_CAP = 1000;
const MINUTE = 60_000;

export type ScheduleInput = { name: string; cron: string; target: ScheduleTarget; enabled: boolean };

export type ScheduleHooks = {
  createRun: (input: NewRunInput, actor: Actor) => RunRow;
  createAudit: (repo: string, focus: string, actor: Actor) => AuditRow;
  fixLabeled: (repo: string, label: string | undefined, actor: Actor) => Promise<LabeledOutcome>;
};

/** La cible d'une planification, contrôlée comme le corps de la route qu'elle appellera. */
export function targetInput(raw: unknown, client: Client): ScheduleTarget {
  if (!isRecord(raw)) throw new HarnessError(400, "target : objet {kind, repo, …} attendu");
  const kind = raw.kind;
  if (typeof kind === "string" && RESERVED_KINDS[kind] !== undefined) throw new HarnessError(400, RESERVED_KINDS[kind]);
  if (!(TARGET_KINDS as readonly unknown[]).includes(kind))
    throw new HarnessError(400, `target.kind : ${TARGET_KINDS.join(" | ")} attendu`);
  const repo = text(raw, "repo").trim();
  requireRepo(client, repo);
  if (kind === "audit") return { kind, repo, focus: text(raw, "focus", false).trim() };
  if (kind === "issues") {
    const label = text(raw, "label", false).trim();
    return { kind, repo, ...(label ? { label } : {}) };
  }
  const title = text(raw, "title").trim();
  const request = text(raw, "request").trim();
  if (title === "" || request === "") throw new HarnessError(400, "target : title et request sont requis");
  const priority = integer(raw.priority, "priority");
  if (priority !== undefined && Math.abs(priority) > 1000)
    throw new HarnessError(400, "priority : entier entre -1000 et 1000");
  if (raw.lane !== undefined && raw.lane !== "full") throw new HarnessError(400, 'lane : "full" ou absent');
  const budget = budgetUsd(raw.budgetUsd);
  return {
    kind: "run",
    repo,
    title,
    request,
    ...(raw.lane === "full" ? { lane: "full" as const } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(budget !== undefined ? { budgetUsd: budget } : {}),
  };
}

function nameInput(body: Record<string, unknown>): string {
  const name = text(body, "name").trim();
  if (name === "" || name.length > NAME_MAX)
    throw new HarnessError(400, `name : texte non vide de ${NAME_MAX} caractères au plus`);
  return name;
}

function enabledInput(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") throw new HarnessError(400, "enabled : booléen attendu");
  return value;
}

/** Une planification à créer : `POST /v1/schedules` et l'outil MCP `schedule_create`. */
export function scheduleInput(body: Record<string, unknown>, client: Client): ScheduleInput {
  return {
    name: nameInput(body),
    cron: parseCron(text(body, "cron")).source,
    target: targetInput(body.target, client),
    enabled: enabledInput(body.enabled) ?? true,
  };
}

/** Une modification (`PUT /v1/schedules/{id}`) : seuls les champs présents changent. */
export function scheduleEdit(body: Record<string, unknown>, client: Client): Partial<ScheduleInput> {
  const enabled = enabledInput(body.enabled);
  return {
    ...(body.name !== undefined ? { name: nameInput(body) } : {}),
    ...(body.cron !== undefined ? { cron: parseCron(text(body, "cron")).source } : {}),
    ...(body.target !== undefined ? { target: targetInput(body.target, client) } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Ce qu'une échéance a lancé. */
type Launched = { runIds: string[]; auditId: string | null; detail: string };

export class Schedules {
  readonly #ctx: HarnessContext;
  readonly #hooks: ScheduleHooks;
  /** Les lancements en vol (une relève d'issues attend `gh`), par planification. */
  readonly #inflight = new Map<string, Promise<unknown>>();

  constructor(ctx: HarnessContext, hooks: ScheduleHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  get timeZone(): string {
    return this.#ctx.config.schedules.timezone;
  }

  /** L'échéance qui suit `after` ; 400 si l'expression n'en a aucune (un 30 février). */
  #next(cron: Cron, after: number): number {
    const next = nextOccurrence(cron, after, this.timeZone);
    if (next === null) throw new HarnessError(400, `cron « ${cron.source} » : aucune échéance à venir`);
    return next;
  }

  /** `GET /v1/schedules` : les planifications des dépôts que voit le lecteur. */
  view(repos: RepoFilter): { timezone: string; schedules: ScheduleRow[] } {
    return { timezone: this.timeZone, schedules: this.#ctx.store.listSchedules(repos) };
  }

  /** Une planification que le lecteur voit ; 404 sinon, comme si elle n'existait pas. */
  visible(id: string, repos: RepoFilter): ScheduleRow {
    const schedule = this.#ctx.store.getSchedule(id);
    if (!schedule || (repos !== null && !repos.includes(schedule.repo)))
      throw new HarnessError(404, `planification inconnue : ${id}`);
    return schedule;
  }

  /** La révision lue par le client (`If-Match`) ; 412 si la planification a changé depuis. */
  #current(id: string, actor: Actor, repos: RepoFilter): ScheduleRow {
    const schedule = this.visible(id, repos);
    if (actor.rev !== undefined && actor.rev !== schedule.rev)
      throw new HarnessError(
        412,
        `la planification ${id} a changé (rev ${schedule.rev}, lue ${actor.rev}) : relis-la avant d'agir`,
      );
    return schedule;
  }

  create(input: ScheduleInput, actor: Actor = SERVICE, now = Date.now()): ScheduleRow {
    this.#ctx.repo(input.target.repo);
    return this.#ctx.store.createSchedule({
      id: newId("s"),
      name: input.name,
      cron: input.cron,
      target: input.target,
      enabled: input.enabled,
      nextRunAt: this.#next(parseCron(input.cron), now),
      createdBy: actor.by,
    });
  }

  /** Une nouvelle expression, ou une planification réactivée : l'échéance repart de maintenant. */
  update(id: string, edit: Partial<ScheduleInput>, actor: Actor, repos: RepoFilter, now = Date.now()): ScheduleRow {
    const { store } = this.#ctx;
    return store.transaction(() => {
      const current = this.#current(id, actor, repos);
      if (edit.target) this.#ctx.repo(edit.target.repo);
      const cron = edit.cron ?? current.cron;
      const rearm = edit.cron !== undefined || (edit.enabled === true && !current.enabled);
      return store.updateSchedule(id, {
        ...edit,
        cron,
        ...(rearm ? { nextRunAt: this.#next(parseCron(cron), now) } : {}),
      }) as ScheduleRow;
    });
  }

  delete(id: string, actor: Actor, repos: RepoFilter): void {
    const { store } = this.#ctx;
    store.transaction(() => {
      this.#current(id, actor, repos);
      store.deleteSchedule(id);
    });
  }

  /**
   * `POST /v1/schedules/{id}/run` : un déclenchement tout de suite, hors échéance (même
   * désactivée) ; 409 si le lancement précédent n'est pas fini ou le plafond journalier atteint.
   */
  async runNow(
    id: string,
    actor: Actor,
    repos: RepoFilter,
    now = Date.now(),
  ): Promise<{ schedule: ScheduleRow; outcome: ScheduleOutcome }> {
    const schedule = this.#current(id, actor, repos);
    const blocked = this.#blocked(schedule);
    if (blocked) throw new HarnessError(409, blocked.detail);
    const { outcome, error } = await this.#fire(schedule, null, now, 0, actor.by);
    if (error) throw error instanceof HarnessError ? error : new HarnessError(502, message(error));
    return { schedule: this.visible(id, repos), outcome };
  }

  /**
   * Un tour : chaque planification due est traitée une fois et son échéance avance. Rend
   * la fin des lancements partis à ce tour (l'orchestrateur ne l'attend pas).
   */
  tick(now = Date.now()): Promise<void> {
    const started: Promise<unknown>[] = [];
    for (const schedule of this.#ctx.store.dueSchedules(now)) {
      try {
        const fired = this.#handle(schedule, now);
        if (fired) started.push(fired);
      } catch (err) {
        this.#ctx.log(`planification « ${schedule.name} » (${schedule.id}) : ${message(err)}`);
      }
    }
    return Promise.all(started).then(() => undefined);
  }

  /** Attend les lancements en vol (arrêt du service). */
  async stop(): Promise<void> {
    await Promise.allSettled([...this.#inflight.values()]);
  }

  #handle(schedule: ScheduleRow, now: number): Promise<unknown> | null {
    const { store, config } = this.#ctx;
    const tz = this.timeZone;
    const cron = parseCron(schedule.cron);
    const due = schedule.nextRunAt as number;
    const windowStart = now - config.schedules.catchUpMin * MINUTE;
    // Les échéances trop vieilles pour être rattrapées, comptées (bornées) sans rien lancer.
    let late = 0;
    for (let at: number | null = due; at !== null && at < windowStart && late < MISSED_CAP; ) {
      late++;
      at = nextOccurrence(cron, at, tz);
    }
    // Les échéances rattrapables : seule la plus récente part.
    let last: number | null = null;
    let recent = 0;
    for (
      let at: number | null = due >= windowStart ? due : nextOccurrence(cron, windowStart - 1, tz);
      at !== null && at <= now;
      at = nextOccurrence(cron, at, tz)
    ) {
      last = at;
      recent++;
    }
    store.updateSchedule(schedule.id, { nextRunAt: nextOccurrence(cron, now, tz) });
    const base = { at: now, runIds: [], auditId: null };
    if (last === null) {
      this.#record(schedule, {
        ...base,
        status: "missed",
        dueAt: due,
        missed: late,
        detail: `${late >= MISSED_CAP ? `plus de ${MISSED_CAP}` : late} échéance(s) passée(s) pendant un arrêt du service, depuis ${new Date(due).toISOString()} : au-delà de ${config.schedules.catchUpMin} min, rien n'est rattrapé`,
      });
      return null;
    }
    const missed = late + recent - 1;
    const blocked = this.#blocked(schedule);
    if (blocked) {
      this.#record(schedule, { ...base, ...blocked, dueAt: last, missed });
      return null;
    }
    return this.#fire(schedule, last, now, missed, null);
  }

  /** Pourquoi la planification ne peut pas partir maintenant, ou `null`. */
  #blocked(schedule: ScheduleRow): { status: "busy" | "daily_budget"; detail: string } | null {
    const { store, monitor } = this.#ctx;
    const daily = monitor.dailyBudgetDue();
    if (daily)
      return {
        status: "daily_budget",
        detail: `plafond journalier atteint : ${daily.spent.toFixed(2)} $ / ${daily.ceiling.toFixed(2)} $`,
      };
    if (this.#inflight.has(schedule.id))
      return { status: "busy", detail: "le lancement précédent court encore : pas d'empilement" };
    const fired = schedule.lastFired;
    if (fired?.kind === "run")
      for (const id of fired.ids) {
        const run = store.getRun(id);
        if (run && !TERMINAL_STATES.includes(run.state))
          return { status: "busy", detail: `le run précédent ${id} n'est pas fini (${run.state}) : pas d'empilement` };
      }
    if (fired?.kind === "audit")
      for (const id of fired.ids) {
        const audit = store.getAudit(id);
        if (audit && (audit.state === "queued" || audit.state === "analysing"))
          return {
            status: "busy",
            detail: `l'audit précédent ${id} n'est pas fini (${audit.state}) : pas d'empilement`,
          };
      }
    return null;
  }

  /** Lance la cible ; un run ou un audit est créé avant le premier `await`. */
  async #launch(target: ScheduleTarget): Promise<Launched> {
    switch (target.kind) {
      case "run": {
        const input: NewRunInput = {
          repo: target.repo,
          title: target.title,
          request: target.request,
          ...(target.lane ? { lane: target.lane } : {}),
          ...(target.priority !== undefined ? { priority: target.priority } : {}),
          ...(target.budgetUsd !== undefined ? { budgetUsd: target.budgetUsd } : {}),
        };
        const run = this.#hooks.createRun(input, SERVICE);
        return { runIds: [run.id], auditId: null, detail: `run ${run.id} (${run.slug})` };
      }
      case "audit": {
        const audit = this.#hooks.createAudit(target.repo, target.focus, SERVICE);
        return {
          runIds: [],
          auditId: audit.id,
          detail: `audit ${audit.id}${target.focus ? ` (${target.focus})` : ""}`,
        };
      }
      case "issues": {
        const outcome = await this.#hooks.fixLabeled(target.repo, target.label, SERVICE);
        const runIds = outcome.launched.filter((item) => item.status === "launched").map((item) => item.run.id);
        const rest = outcome.remaining.length > 0 ? `, ${outcome.remaining.length} laissée(s) au passage suivant` : "";
        return {
          runIds,
          auditId: null,
          detail: `label « ${outcome.label} » : ${runIds.length} issue(s) lancée(s), ${outcome.skipped.length} déjà portée(s)${rest}`,
        };
      }
    }
  }

  /** Lance la cible et écrit l'issue ; ne lève jamais (l'échec est une issue `failed`). */
  async #fire(
    schedule: ScheduleRow,
    dueAt: number | null,
    now: number,
    missed: number,
    by: string | null,
  ): Promise<{ outcome: ScheduleOutcome; error: unknown }> {
    this.#ctx.store.updateSchedule(schedule.id, { lastRunAt: now });
    const launching = this.#launch(schedule.target);
    this.#inflight.set(schedule.id, launching);
    let outcome: ScheduleOutcome;
    let error: unknown = null;
    try {
      const launched = await launching;
      outcome = { status: "fired", at: now, dueAt, missed, ...launched };
    } catch (err) {
      error = err;
      outcome = { status: "failed", at: now, dueAt, missed, runIds: [], auditId: null, detail: message(err) };
    } finally {
      this.#inflight.delete(schedule.id);
    }
    this.#record(schedule, outcome, by);
    return { outcome, error };
  }

  /** L'issue d'une échéance : `lastOutcome`, le dernier lancement, et l'événement. */
  #record(schedule: ScheduleRow, outcome: ScheduleOutcome, by: string | null = null): void {
    const { store } = this.#ctx;
    const fired =
      outcome.status !== "fired" || schedule.target.kind === "issues"
        ? {}
        : outcome.auditId !== null
          ? { lastFired: { kind: "audit" as const, ids: [outcome.auditId] } }
          : { lastFired: { kind: "run" as const, ids: outcome.runIds } };
    store.transaction(() => {
      store.updateSchedule(schedule.id, { lastOutcome: outcome, ...fired });
      this.#ctx.event(
        outcome.status === "fired" ? "schedule_fired" : "schedule_skipped",
        null,
        {
          scheduleId: schedule.id,
          name: schedule.name,
          repo: schedule.repo,
          kind: schedule.target.kind,
          ...(outcome.status === "fired" ? {} : { reason: outcome.status }),
          ...outcome,
          ...(by ? { by } : {}),
        },
        schedule.repo,
      );
    });
  }
}
