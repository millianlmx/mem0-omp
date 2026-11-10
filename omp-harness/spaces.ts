// Les espaces (clients) : un espace réunit des dépôts déclarés, le poste, des projets Jira, un budget
// journalier et un curseur d'autonomie par défaut. Un dépôt appartient à AU PLUS un espace.
//
// `SpaceDesk` (exposé par `orchestrator.spaces`) en porte le CRUD (admin), la vue des apps
// (`GET /v1/spaces` : chaque espace avec ses compteurs et son budget du jour), le rapport d'un espace
// (`digestOf` borné à ses dépôts) et les trois lectures des autres pièces : `spaceOf` (l'espace d'un
// dépôt), `autonomyOf` (le curseur par défaut d'un run créé sur ce dépôt), `budgetHold` (le plafond
// journalier de l'espace atteint : l'admission retient ses runs).
import type { Actor, HarnessContext } from "./context.ts";
import { RUN_AUTONOMIES } from "./db.ts";
import type { RepoFilter, RunAutonomy, Space, SpacePatch, Store } from "./db.ts";
import { digestParts } from "./digest.ts";
import type { Digest } from "./digest.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { budgetUsd, stringList, text } from "./input.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const SPACE_NAME_MAX = 60;
/** Le plus grand nombre de projets Jira d'un espace, et la plus longue clé de l'un d'eux. */
const MAX_JIRA_PROJECTS = 50;
const MAX_JIRA_KEY = 40;

/** La fenêtre par défaut du rapport d'un espace : les 7 derniers jours. */
export const SPACE_REPORT_WINDOW_MS = WEEK_MS;

/** Ce qu'un espace fait en ce moment, ce qu'il a livré sur 7 jours et ce qu'il a coûté. */
export type SpaceStats = {
  /** Les runs au travail (ni en file, ni chez l'humain, ni terminés). */
  working: number;
  /** Les runs qui attendent l'humain (validation ou questions). */
  yours: number;
  queued: number;
  mergedWeek: number;
  failedWeek: number;
  cancelledWeek: number;
  /** Le coût du jour UTC, comme le plafond journalier du serveur. */
  costToday: number;
  costWeek: number;
  /** Ce qu'il reste du budget journalier de l'espace ENTIER ; `null` sans budget, ou pour un lecteur borné. */
  budgetLeftToday: number | null;
};

export type SpaceView = Space & {
  /** Les scopes mémoire de ses dépôts (lecture seule). */
  memoryScopes: string[];
  stats: SpaceStats;
};

export type SpaceInput = Pick<Space, "name" | "repos" | "poste" | "jiraProjects" | "dailyBudgetUsd" | "autonomy">;

export type SpaceReport = Pick<Digest, "since" | "until" | "text" | "counts"> & { space: Space; cost: number };

/** Le plafond journalier d'un espace atteint : son nom, la dépense du jour UTC de ses dépôts et le plafond. */
export type SpaceBudgetHold = { space: string; spent: number; ceiling: number };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Le début du jour UTC de `now` : la même journée que le plafond du serveur (monitor.ts). */
function dayStart(now: number): number {
  return now - (now % DAY_MS);
}

function costSince(store: Store, since: number, repos: readonly string[]): number {
  return round2(store.usageSince(since, repos).reduce((sum, row) => sum + row.cost, 0));
}

function nameInput(body: Record<string, unknown>): string {
  const name = text(body, "name").trim();
  if (name === "" || name.length > SPACE_NAME_MAX)
    throw new HarnessError(400, `name : texte non vide de ${SPACE_NAME_MAX} caractères au plus`);
  return name;
}

function reposInput(body: Record<string, unknown>): string[] {
  const repos = (stringList(body.repos, "repos") ?? []).map((repo) => repo.trim());
  if (repos.some((repo) => repo === "")) throw new HarnessError(400, "repos : un nom de dépôt est vide");
  return [...new Set(repos)];
}

function jiraInput(body: Record<string, unknown>): string[] {
  const keys = [...new Set((stringList(body.jiraProjects, "jiraProjects") ?? []).map((key) => key.trim()))];
  if (keys.length > MAX_JIRA_PROJECTS || keys.some((key) => key === "" || key.length > MAX_JIRA_KEY))
    throw new HarnessError(
      400,
      `jiraProjects : ${MAX_JIRA_PROJECTS} clés au plus, de 1 à ${MAX_JIRA_KEY} caractères chacune`,
    );
  return keys;
}

function autonomyInput(body: Record<string, unknown>): RunAutonomy | null {
  if (body.autonomy === null) return null;
  const level = RUN_AUTONOMIES.find((candidate) => candidate === body.autonomy);
  if (level === undefined) throw new HarnessError(400, `autonomy : ${RUN_AUTONOMIES.join(" | ")} ou null`);
  return level;
}

/** Une modification (`PUT /v1/spaces/{id}`) : seuls les champs présents changent. */
export function spaceEdit(body: Record<string, unknown>): SpacePatch {
  const { poste, dailyBudgetUsd } = body;
  if (poste !== undefined && typeof poste !== "boolean") throw new HarnessError(400, "poste : booléen attendu");
  return {
    ...(body.name !== undefined ? { name: nameInput(body) } : {}),
    ...(body.repos !== undefined ? { repos: reposInput(body) } : {}),
    ...(poste !== undefined ? { poste } : {}),
    ...(body.jiraProjects !== undefined ? { jiraProjects: jiraInput(body) } : {}),
    // Un montant en dollars, ou `null` : plus de budget.
    ...(dailyBudgetUsd !== undefined
      ? { dailyBudgetUsd: dailyBudgetUsd === null ? null : (budgetUsd(dailyBudgetUsd, "dailyBudgetUsd") ?? null) }
      : {}),
    ...(body.autonomy !== undefined ? { autonomy: autonomyInput(body) } : {}),
  };
}

/** Un espace à créer (`POST /v1/spaces`) : un nom, et les défauts de ce qui n'est pas donné. */
export function spaceInput(body: Record<string, unknown>): SpaceInput {
  return {
    repos: [],
    poste: false,
    jiraProjects: [],
    dailyBudgetUsd: null,
    autonomy: null,
    ...spaceEdit(body),
    name: nameInput(body),
  };
}

export class SpaceDesk {
  readonly #ctx: HarnessContext;

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  // -- ce que lisent l'admission et la création d'un run ------------------------

  /** L'espace auquel appartient ce dépôt, ou `null`. */
  spaceOf(repo: string): Space | null {
    return this.#ctx.store.listSpaces().find((space) => space.repos.includes(repo)) ?? null;
  }

  /** Le curseur d'autonomie par défaut d'un run créé sur ce dépôt : celui de son espace. */
  autonomyOf(repo: string): RunAutonomy | null {
    return this.spaceOf(repo)?.autonomy ?? null;
  }

  /**
   * Le budget journalier de l'espace du dépôt s'il est atteint sur le jour UTC de `now` (le coût du
   * jour de TOUS les dépôts de l'espace ≥ `dailyBudgetUsd`), sinon `null` : l'admission retient le run.
   */
  budgetHold(repo: string, now: number): SpaceBudgetHold | null {
    const space = this.spaceOf(repo);
    if (space === null || space.dailyBudgetUsd === null) return null;
    const spent = costSince(this.#ctx.store, dayStart(now), space.repos);
    return spent >= space.dailyBudgetUsd ? { space: space.name, spent, ceiling: space.dailyBudgetUsd } : null;
  }

  // -- lectures -------------------------------------------------------------------

  /**
   * L'espace tel que le lecteur le voit : entier pour qui voit tous les dépôts ; réduit à ses dépôts
   * pour un client borné — sans le poste ni les projets Jira, qui sont au propriétaire, ni le budget
   * journalier et son auteur (`dailyBudgetUsd`, `by` : `null`) : le budget restant de l'espace entier
   * laisserait déduire la dépense des dépôts qu'il ne voit pas ; `null` s'il n'en voit aucun.
   */
  #reduced(space: Space, repos: RepoFilter): Space | null {
    if (repos === null) return space;
    const own = space.repos.filter((repo) => repos.includes(repo));
    return own.length === 0
      ? null
      : { ...space, repos: own, poste: false, jiraProjects: [], dailyBudgetUsd: null, by: null };
  }

  /** Un espace que le lecteur voit ; 404 sinon, comme s'il n'existait pas. */
  visible(id: string, repos: RepoFilter): Space {
    const space = this.#ctx.store.getSpace(id);
    const seen = space ? this.#reduced(space, repos) : null;
    if (seen === null) throw new HarnessError(404, `espace inconnu : ${id}`);
    return seen;
  }

  /** `GET /v1/spaces` : les espaces que voit le lecteur, chacun avec ses scopes mémoire et ses compteurs. */
  list(repos: RepoFilter, now: number): SpaceView[] {
    const { store, config } = this.#ctx;
    const views: SpaceView[] = [];
    for (const whole of store.listSpaces()) {
      const space = this.#reduced(whole, repos);
      if (space === null) continue;
      const scopes = config.repos.filter((repo) => space.repos.includes(repo.name)).map((repo) => repo.scope);
      views.push({
        ...space,
        memoryScopes: [...new Set(scopes.filter((scope) => scope !== ""))],
        stats: this.#stats(space, now),
      });
    }
    return views;
  }

  /**
   * Les compteurs de l'espace tel que le lecteur le voit (`#reduced`) : ses dépôts visibles ; le budget
   * restant se compte sur l'espace entier, donc seulement pour qui le voit entier (un espace réduit
   * n'a plus de budget).
   */
  #stats(space: Space, now: number): SpaceStats {
    const { store } = this.#ctx;
    const { repos } = space;
    const stats: SpaceStats = {
      working: 0,
      yours: 0,
      queued: 0,
      mergedWeek: 0,
      failedWeek: 0,
      cancelledWeek: 0,
      costToday: costSince(store, dayStart(now), repos),
      costWeek: costSince(store, now - WEEK_MS, repos),
      budgetLeftToday:
        space.dailyBudgetUsd === null
          ? null
          : Math.max(0, round2(space.dailyBudgetUsd - costSince(store, dayStart(now), repos))),
    };
    for (const run of store.listRuns({ repos })) {
      const recent = now - run.updatedAt <= WEEK_MS;
      if (run.state === "merged") stats.mergedWeek += recent ? 1 : 0;
      else if (run.state === "failed") stats.failedWeek += recent ? 1 : 0;
      else if (run.state === "cancelled") stats.cancelledWeek += recent ? 1 : 0;
      else if (run.state === "queued") stats.queued += 1;
      else if (run.state === "awaiting_human" || run.state === "escalated") stats.yours += 1;
      else stats.working += 1;
    }
    return stats;
  }

  /**
   * `GET /v1/spaces/{id}/report` : le rapport (`digestOf`) borné aux dépôts de l'espace que voit le
   * lecteur, sur [since, now], sans la santé ni le commit du service, et le coût de la fenêtre.
   */
  report(id: string, since: number, now: number, repos: RepoFilter): SpaceReport {
    const space = this.visible(id, repos);
    const { store } = this.#ctx;
    const digest = digestParts(store, since, now, space.repos);
    const cost = round2(
      store
        .usageSince(since, space.repos)
        .filter((row) => row.at <= now)
        .reduce((sum, row) => sum + row.cost, 0),
    );
    return { space, since, until: now, text: digest.parts.join("\n\n"), counts: digest.counts, cost };
  }

  // -- écritures (admin) -----------------------------------------------------------

  /** Le nom est libre (409 sinon), chaque dépôt est déclaré (400) et n'appartient à aucun autre espace (409). */
  #check(edit: SpacePatch, except: string | null): void {
    const others = this.#ctx.store.listSpaces().filter((space) => space.id !== except);
    const { name } = edit;
    if (name !== undefined && others.some((space) => space.name.toLowerCase() === name.toLowerCase()))
      throw new HarnessError(409, `un espace porte déjà le nom « ${name} »`);
    for (const repo of edit.repos ?? []) {
      if (!this.#ctx.config.repos.some((declared) => declared.name === repo))
        throw new HarnessError(400, `repos : le dépôt « ${repo} » n'est pas déclaré sur le harness`);
      const owner = others.find((space) => space.repos.includes(repo));
      if (owner) throw new HarnessError(409, `le dépôt « ${repo} » appartient déjà à l'espace « ${owner.name} »`);
    }
  }

  /** L'espace à la révision lue par le client (`If-Match`) ; 412 s'il a changé depuis. */
  #current(id: string, actor: Actor): Space {
    const space = this.visible(id, null);
    if (actor.rev !== undefined && actor.rev !== space.rev)
      throw new HarnessError(
        412,
        `l'espace ${id} a changé (rev ${space.rev}, lue ${actor.rev}) : relis-le avant d'agir`,
      );
    return space;
  }

  create(input: SpaceInput, actor: Actor): Space {
    const { store } = this.#ctx;
    return store.transaction(() => {
      this.#check(input, null);
      const space = store.insertSpace({ id: newId("e"), ...input, by: actor.by });
      this.#ctx.event("space", null, { id: space.id, action: "created" });
      return space;
    });
  }

  update(id: string, edit: SpacePatch, actor: Actor): Space {
    const { store } = this.#ctx;
    return store.transaction(() => {
      this.#current(id, actor);
      this.#check(edit, id);
      const space = store.updateSpace(id, edit) as Space;
      this.#ctx.event("space", null, { id, action: "updated" });
      return space;
    });
  }

  delete(id: string, actor: Actor): void {
    const { store } = this.#ctx;
    store.transaction(() => {
      this.#current(id, actor);
      store.deleteSpace(id);
      this.#ctx.event("space", null, { id, action: "removed" });
    });
  }
}
