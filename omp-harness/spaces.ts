// Les espaces (clients) : un espace réunit des dépôts déclarés, le poste, des projets Jira, un budget
// journalier et un curseur d'autonomie par défaut. Un dépôt appartient à AU PLUS un espace.
//
// `SpaceDesk` (exposé par `orchestrator.spaces`) en porte le CRUD (admin), la vue des apps
// (`GET /v1/spaces` : chaque espace avec ses compteurs et son budget du jour), le rapport d'un espace
// (`digestOf` borné à ses dépôts) et les trois lectures des autres pièces : `spaceOf` (l'espace d'un
// dépôt), `autonomyOf` (le curseur par défaut d'un run créé sur ce dépôt), `budgetHold` (le plafond
// journalier de l'espace atteint : l'admission retient ses runs).
//
// Un espace est aussi la frontière d'un client : sa politique de modèles (`policy`, croisée au plus
// strict avec celle de chaque dépôt — policy.ts), son étanchéité (`isolation`, calculée à chaque
// lecture — isolation.ts) et son accueil en un geste (`onboard` : l'espace, puis ce qu'il reste à faire).
import { sharedSites, spaceAtlassian } from "./atlassian/desk.ts";
import type { SpaceAtlassian } from "./atlassian/desk.ts";
import { policyDefect } from "./config.ts";
import type { ModelPolicy } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import { RUN_AUTONOMIES } from "./db.ts";
import type { RepoFilter, RunAutonomy, Space, SpacePatch, Store, UsageRow } from "./db.ts";
import { digestParts } from "./digest.ts";
import type { Digest } from "./digest.ts";
import { HarnessError } from "./errors.ts";
import { isolationOf, listed, nextSteps } from "./isolation.ts";
import type { Isolation, IsolationFacts, OnboardStep } from "./isolation.ts";
import { newId } from "./ids.ts";
import { budgetUsd, stringList, text } from "./input.ts";
import { monthStart } from "./space-usage.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const SPACE_NAME_MAX = 60;
/** Le refus d'administrer les espaces à un client restreint à des dépôts (routes et outil MCP). */
export const SPACES_OWNER_ONLY = "les espaces sont administrés par un client qui voit tous les dépôts";
/** Le plus grand nombre de projets Jira d'un espace, et la plus longue clé de l'un d'eux. */
const MAX_JIRA_PROJECTS = 50;
const MAX_JIRA_KEY = 40;
/** Le plus grand nombre d'identités de l'utilisateur dans un espace, et la plus longue de l'une d'elles. */
const MAX_IDENTITIES = 50;
const MAX_IDENTITY = 200;

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
  /** Le coût du mois UTC en cours : ce que `GET /v1/spaces/{id}/usage` détaille par défaut. */
  costMonth: number;
  /** Ce qu'il reste du budget journalier de l'espace ENTIER ; `null` sans budget, ou pour un lecteur borné. */
  budgetLeftToday: number | null;
};

export type SpaceView = Space & {
  /** Les scopes mémoire de ses dépôts (lecture seule). */
  memoryScopes: string[];
  stats: SpaceStats;
  /** Ce qui laisse encore l'espace lire, écrire ou parler hors de sa frontière (isolation.ts) ; calculé, jamais stocké. */
  isolation: Isolation;
  /**
   * La connexion Atlassian de l'espace (`GET|POST /v1/atlassian…?space=`) : branchée ou non, et son site ;
   * `null` quand Atlassian est désactivé sur le serveur, ou pour un lecteur qui ne voit pas l'espace entier.
   */
  atlassian: SpaceAtlassian | null;
};

export type SpaceInput = Pick<Space, "name" | "repos" | "jiraProjects" | "dailyBudgetUsd" | "autonomy"> &
  Partial<Pick<Space, "identities" | "policy">>;

/** Ce que rend l'accueil d'un client : l'espace créé, son étanchéité et ce qu'il reste à faire. */
export type SpaceOnboarding = { space: SpaceView; isolation: Isolation; next: OnboardStep[] };

/**
 * Ce qu'un espace lit et touche hors de lui, donné par l'orchestrateur : sa connexion Atlassian et les
 * réglages de la vigie (son étanchéité), sa pause et la connexion Atlassian par défaut (son retrait).
 */
export type SpaceSurroundings = {
  atlassian: (spaceId: string) => IsolationFacts["atlassian"];
  vigie: () => IsolationFacts["vigie"];
  /** L'espace est-il en pause (`POST /v1/pause {space}`) ? Un espace en pause ne se retire pas. */
  paused: (spaceId: string) => boolean;
  /** La connexion Atlassian par défaut (hors espace) est-elle vivante ? Les dépôts d'un espace retiré la liraient. */
  defaultAtlassian: () => boolean;
  /** L'espace vient d'être retiré : le réglage de sa pause et sa connexion Atlassian s'oublient. */
  removed: (spaceId: string) => void;
};

/** Ce que rend le retrait d'un espace : ce que deviennent ses dépôts, dit en clair. */
export type SpaceRemoval = {
  /** Ses dépôts, redevenus hors espace. */
  repos: string[];
  /** Ceux de ses dépôts `atlassian: true` qui lisent désormais la connexion Atlassian par défaut (vide si elle n'est pas branchée). */
  defaultAtlassian: string[];
  /** La même chose en une phrase, pour l'humain. */
  text: string;
};

export type SpaceReport = Pick<Digest, "since" | "until" | "text" | "counts"> & { space: Space; cost: number };

/** Le plafond journalier d'un espace atteint : son nom, la dépense du jour UTC de ses dépôts et le plafond. */
export type SpaceBudgetHold = { space: string; spent: number; ceiling: number };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Ce qui retient tout ce qui appartient à un espace : sa pause, ou son budget du jour atteint ; `text` le dit à l'humain. */
export type SpaceHold = { cause: "paused" | "space_budget"; text: string };
/**
 * Ce que l'orchestrateur donne à chaque tour aux planifications, audits, Demandes, rêves et jobs du
 * poste : ce qui retient l'espace d'un dépôt (`ofRepo`) ou un espace par son identifiant (`ofSpace`).
 * `null` : rien ne le retient — toujours, hors de tout espace.
 */
export type SpaceHolds = {
  ofRepo: (repo: string) => SpaceHold | null;
  ofSpace: (spaceId: string | null) => SpaceHold | null;
};
/** Aucune retenue : un serveur sans espace, ou un appelant qui n'en donne pas. */
export const NO_SPACE_HOLDS: SpaceHolds = { ofRepo: () => null, ofSpace: () => null };

/** Le début du jour UTC de `now` : la même journée que le plafond du serveur (monitor.ts). */
function dayStart(now: number): number {
  return now - (now % DAY_MS);
}

/**
 * Ce que ces dépôts ont coûté depuis `since` ; `spaceId` : plus ce qui est imputé à l'espace sans passer
 * par un dépôt (`usage.space_id` : Demande, poste).
 */
function costSince(store: Store, since: number, repos: readonly string[], spaceId: string | null = null): number {
  return round2(
    store.spaceUsage(repos, spaceId, since, Number.MAX_SAFE_INTEGER).reduce((sum, row) => sum + row.cost, 0),
  );
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

/** Les identités de l'utilisateur chez ce client (adresses, pseudos) : la garde d'envoi des navigateurs de l'espace. */
function identitiesInput(body: Record<string, unknown>): string[] {
  const entries = [...new Set((stringList(body.identities, "identities") ?? []).map((entry) => entry.trim()))];
  if (entries.length > MAX_IDENTITIES || entries.some((entry) => entry === "" || entry.length > MAX_IDENTITY))
    throw new HarnessError(
      400,
      `identities : ${MAX_IDENTITIES} identités au plus, de 1 à ${MAX_IDENTITY} caractères chacune`,
    );
  return entries;
}

/** La politique de modèles d'un espace, validée comme celle d'un dépôt (config.ts) ; `null` : plus de politique. */
function policyInput(body: Record<string, unknown>): ModelPolicy | null {
  if (body.policy === null) return null;
  const defect = policyDefect("policy", body.policy);
  if (defect !== null) throw new HarnessError(400, defect);
  const { models, providers, privacy } = body.policy as ModelPolicy;
  return {
    ...(models !== undefined ? { models } : {}),
    ...(providers !== undefined ? { providers } : {}),
    ...(privacy !== undefined ? { privacy } : {}),
  };
}

/**
 * Une modification (`PUT /v1/spaces/{id}`) : seuls les champs présents changent. `poste` est accepté
 * (un booléen, comme avant) mais IGNORÉ : il se déduit des navigateurs rattachés à l'espace.
 */
export function spaceEdit(body: Record<string, unknown>): SpacePatch {
  const { poste, dailyBudgetUsd } = body;
  if (poste !== undefined && typeof poste !== "boolean") throw new HarnessError(400, "poste : booléen attendu");
  return {
    ...(body.name !== undefined ? { name: nameInput(body) } : {}),
    ...(body.repos !== undefined ? { repos: reposInput(body) } : {}),
    ...(body.identities !== undefined ? { identities: identitiesInput(body) } : {}),
    ...(body.jiraProjects !== undefined ? { jiraProjects: jiraInput(body) } : {}),
    // Un montant en dollars, ou `null` : plus de budget.
    ...(dailyBudgetUsd !== undefined
      ? { dailyBudgetUsd: dailyBudgetUsd === null ? null : (budgetUsd(dailyBudgetUsd, "dailyBudgetUsd") ?? null) }
      : {}),
    ...(body.autonomy !== undefined ? { autonomy: autonomyInput(body) } : {}),
    ...(body.policy !== undefined ? { policy: policyInput(body) } : {}),
  };
}

/** Un espace à créer (`POST /v1/spaces`) : un nom, et les défauts de ce qui n'est pas donné. */
export function spaceInput(body: Record<string, unknown>): SpaceInput {
  return {
    repos: [],
    jiraProjects: [],
    dailyBudgetUsd: null,
    autonomy: null,
    ...spaceEdit(body),
    name: nameInput(body),
  };
}

/**
 * Un client à accueillir (`POST /v1/spaces/onboard`) : comme un espace à créer, avec la liste de ses
 * dépôts (elle peut être vide : un client sans dépôt encore).
 */
export function onboardInput(body: Record<string, unknown>): SpaceInput {
  if (!Array.isArray(body.repos)) throw new HarnessError(400, "repos : la liste des dépôts du client attendue");
  return spaceInput(body);
}

export class SpaceDesk {
  readonly #ctx: HarnessContext;
  readonly #around: SpaceSurroundings;

  constructor(ctx: HarnessContext, around: SpaceSurroundings) {
    this.#ctx = ctx;
    this.#around = around;
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
   * jour de TOUS les dépôts de l'espace, et de ce qui lui est imputé sans dépôt — Demande, poste —,
   * ≥ `dailyBudgetUsd`), sinon `null` : l'admission retient le run.
   */
  budgetHold(repo: string, now: number): SpaceBudgetHold | null {
    const space = this.spaceOf(repo);
    return space === null ? null : this.budgetHoldOf(space, now);
  }

  /** Le budget journalier de CET espace s'il est atteint sur le jour UTC de `now` (`budgetHold`), sinon `null`. */
  budgetHoldOf(space: Space, now: number): SpaceBudgetHold | null {
    if (space.dailyBudgetUsd === null) return null;
    const spent = costSince(this.#ctx.store, dayStart(now), space.repos, space.id);
    return spent >= space.dailyBudgetUsd ? { space: space.name, spent, ceiling: space.dailyBudgetUsd } : null;
  }

  /** Les dépôts d'une liste d'espaces (leurs identifiants) : ce que voit un client borné à ces espaces (auth.ts `useSpaces`). */
  reposOf(ids: readonly string[]): string[] {
    const spaces = this.#ctx.store.listSpaces().filter((space) => ids.includes(space.id));
    return [...new Set(spaces.flatMap((space) => space.repos))];
  }

  // -- lectures -------------------------------------------------------------------

  /**
   * L'espace tel que le lecteur le voit : entier pour qui voit tous les dépôts (l'objet lui-même :
   * `list` s'y fie pour dire toute son étanchéité) ; réduit à ses dépôts pour un client borné — sans
   * le poste ni les projets Jira, qui sont au propriétaire, ni sa politique de modèles, ni le budget
   * journalier et son auteur (`dailyBudgetUsd`, `by` : `null`) : le budget restant de l'espace entier
   * laisserait déduire la dépense des dépôts qu'il ne voit pas ; `null` s'il n'en voit aucun.
   */
  #reduced(space: Space, repos: RepoFilter): Space | null {
    if (repos === null) return space;
    const own = space.repos.filter((repo) => repos.includes(repo));
    return own.length === 0
      ? null
      : {
          ...space,
          repos: own,
          poste: false,
          identities: [],
          jiraProjects: [],
          dailyBudgetUsd: null,
          policy: null,
          by: null,
        };
  }

  /** Un espace que le lecteur voit ; 404 sinon, comme s'il n'existait pas. */
  visible(id: string, repos: RepoFilter): Space {
    const space = this.#ctx.store.getSpace(id);
    const seen = space ? this.#reduced(space, repos) : null;
    if (seen === null) throw new HarnessError(404, `espace inconnu : ${id}`);
    return seen;
  }

  /** L'espace entier, tel qu'il est en base (lecture interne : jamais rendu tel quel à un client borné), ou `null`. */
  get(id: string): Space | null {
    return this.#ctx.store.getSpace(id);
  }

  /**
   * L'espace que désigne `?space=` ou `body.space` — son identifiant, sinon son nom (sans casse) — tel
   * que le lecteur le voit (`#reduced` : ses dépôts sont déjà l'intersection avec ceux du lecteur) ; 404
   * s'il est inconnu ou si le lecteur n'y voit aucun dépôt : on ne révèle pas son existence.
   */
  resolve(idOrName: string, repos: RepoFilter): Space {
    const wanted = idOrName.trim();
    const spaces = this.#ctx.store.listSpaces();
    const space =
      spaces.find((candidate) => candidate.id === wanted) ??
      spaces.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
    const seen = space && wanted !== "" ? this.#reduced(space, repos) : null;
    if (seen === null) throw new HarnessError(404, `espace inconnu : ${idOrName}`);
    return seen;
  }

  /**
   * Pour chaque espace dont la connexion Atlassian lit un site qu'une autre connexion vivante lit aussi
   * (même `cloudId`) : le nom de ces autres connexions. Vide sans espace.
   */
  #sharedSites(spaces: readonly Space[] = this.#ctx.store.listSpaces()): Map<string, string[]> {
    const shared = sharedSites(
      this.#ctx.config,
      spaces.map((space) => space.id),
    );
    const named = (other: string | null): string =>
      other === null
        ? "la connexion par défaut (hors espace)"
        : `l'espace « ${spaces.find((space) => space.id === other)?.name ?? other} »`;
    return new Map([...shared].map(([id, others]) => [id, others.map(named)]));
  }

  /**
   * `GET /v1/status` (au seul lecteur qui voit tout) : un avertissement par espace dont la connexion
   * Atlassian partage son site avec une autre connexion vivante. Vide sans espace : aucune lecture.
   */
  sharedSiteWarnings(): string[] {
    const spaces = this.#ctx.store.listSpaces();
    if (spaces.length === 0) return [];
    const shared = this.#sharedSites(spaces);
    return spaces.flatMap((space) => {
      const others = shared.get(space.id);
      return others === undefined
        ? []
        : [
            `espace « ${space.name} » : sa connexion Atlassian lit le même site que ${listed(others)} — chacune y lit les tickets et les pages de l'autre : branche un site par client, ou borne chaque espace à ses projets (\`jiraProjects\`)`,
          ];
    });
  }

  /** Ce que l'étanchéité de cet espace lit autour de lui (isolation.ts) : la configuration, sa connexion Atlassian, ses navigateurs, la vigie. */
  #facts(space: Space, shared: Map<string, string[]> = this.#sharedSites()): IsolationFacts {
    const { store, config } = this.#ctx;
    const atlassian = this.#around.atlassian(space.id);
    return {
      repos: config.repos,
      atlassian: atlassian === null ? null : { ...atlassian, sharedWith: shared.get(space.id) ?? [] },
      browsers: store.workstationBrowsersOf(space.id).length,
      workstation: config.workstation.enabled,
      vigie: this.#around.vigie(),
    };
  }

  /** `GET /v1/spaces` : les espaces que voit le lecteur, chacun avec ses scopes mémoire, ses compteurs et son étanchéité. */
  list(repos: RepoFilter, now: number): SpaceView[] {
    const { store, config } = this.#ctx;
    const views: SpaceView[] = [];
    const spaces = store.listSpaces();
    const shared = this.#sharedSites(spaces);
    for (const whole of spaces) {
      const space = this.#reduced(whole, repos);
      if (space === null) continue;
      const scopes = config.repos.filter((repo) => space.repos.includes(repo.name)).map((repo) => repo.scope);
      views.push({
        ...space,
        memoryScopes: [...new Set(scopes.filter((scope) => scope !== ""))],
        // Ce qui est imputé à l'espace sans dépôt (Demande, poste) ne se compte que pour qui le voit entier.
        stats: this.#stats(space, now, space === whole ? whole.id : null),
        // Entière pour qui voit l'espace entier ; pour un client borné, les seules lacunes de ses dépôts.
        isolation: isolationOf(whole, this.#facts(whole, shared), space === whole ? null : space.repos),
        atlassian: space === whole ? spaceAtlassian(config, whole.id) : null,
      });
    }
    return views;
  }

  /** `GET /v1/spaces/{id}` : un espace que voit le lecteur, comme dans la liste ; 404 sinon, comme s'il n'existait pas. */
  view(id: string, repos: RepoFilter, now: number): SpaceView {
    const view = this.list(repos, now).find((space) => space.id === id);
    if (view === undefined) throw new HarnessError(404, `espace inconnu : ${id}`);
    return view;
  }

  /**
   * Les compteurs de l'espace tel que le lecteur le voit (`#reduced`) : ses dépôts visibles ; le budget
   * restant se compte sur l'espace entier, donc seulement pour qui le voit entier (un espace réduit
   * n'a plus de budget). `imputed` : l'espace, pour qui le voit entier — ses coûts comptent aussi ce qui
   * lui est imputé sans dépôt.
   */
  #stats(space: Space, now: number, imputed: string | null): SpaceStats {
    const { store } = this.#ctx;
    const { repos } = space;
    const today = costSince(store, dayStart(now), repos, imputed);
    const stats: SpaceStats = {
      working: 0,
      yours: 0,
      queued: 0,
      mergedWeek: 0,
      failedWeek: 0,
      cancelledWeek: 0,
      costToday: today,
      costWeek: costSince(store, now - WEEK_MS, repos, imputed),
      costMonth: costSince(store, monthStart(now), repos, imputed),
      budgetLeftToday: space.dailyBudgetUsd === null ? null : Math.max(0, round2(space.dailyBudgetUsd - today)),
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

  /**
   * `GET /v1/spaces/{id}/usage` : les consommations de l'espace sur [since, until[, telles que le lecteur
   * les voit — celles de ses dépôts visibles ; celles qui lui sont imputées sans dépôt (Demande, poste)
   * seulement pour qui voit l'espace entier. Le détail (jours, dépôts, modèles, CSV) : space-usage.ts.
   */
  usage(id: string, since: number, until: number, repos: RepoFilter): { space: Space; rows: UsageRow[] } {
    const space = this.visible(id, repos);
    return { space, rows: this.#ctx.store.spaceUsage(space.repos, repos === null ? space.id : null, since, until) };
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

  /** La politique de modèles d'un espace est un geste d'humain : un pilote (un agent) ne la pose, ne la change ni ne la lève. */
  #policyByHuman(edit: SpacePatch, actor: Actor): void {
    if (edit.policy !== undefined && actor.pilot)
      throw new HarnessError(
        403,
        "geste réservé à l'humain — un pilote ne règle pas la politique de modèles d'un espace",
      );
  }

  create(input: SpaceInput, actor: Actor): Space {
    const { store } = this.#ctx;
    return store.transaction(() => {
      this.#policyByHuman(input, actor);
      this.#check(input, null);
      const space = store.insertSpace({ id: newId("e"), ...input, by: actor.by });
      this.#ctx.event("space", null, { id: space.id, action: "created" });
      return space;
    });
  }

  /**
   * `POST /v1/spaces/onboard` : accueille un client en un geste — crée son espace (mêmes gardes que
   * `create` : nom libre, dépôts déclarés et libres), puis rend sa vue, son étanchéité et ce qu'il
   * reste à faire (isolation.ts `nextSteps`). Un geste d'humain : un pilote est refusé.
   */
  onboard(input: SpaceInput, actor: Actor, now: number): SpaceOnboarding {
    if (actor.pilot) throw new HarnessError(403, "geste réservé à l'humain — un pilote n'accueille pas de client");
    const created = this.create(input, actor);
    const space = this.view(created.id, null, now);
    return { space, isolation: space.isolation, next: nextSteps(created, space.isolation, this.#facts(created)) };
  }

  update(id: string, edit: SpacePatch, actor: Actor): Space {
    const { store } = this.#ctx;
    return store.transaction(() => {
      this.#current(id, actor);
      this.#policyByHuman(edit, actor);
      this.#check(edit, id);
      const space = store.updateSpace(id, edit) as Space;
      this.#ctx.event("space", null, { id, action: "updated" });
      return space;
    });
  }

  /**
   * Retire un espace. Ses dépôts et leurs runs restent, redevenus HORS ESPACE : ni sa pause, ni son
   * budget, ni sa politique de modèles, ni ses consignes ne les couvrent plus, et ceux qui sont branchés
   * sur Atlassian (`atlassian: true`) lisent désormais la connexion par défaut — la réponse le dit.
   *
   * - Un espace EN PAUSE ne se retire pas (409) : le retirer libérerait d'un coup tout ce que la pause retient.
   * - Quand la connexion Atlassian par défaut est vivante et que l'espace avait la sienne, ou des dépôts
   *   `atlassian: true`, le retrait exige `confirmed` (`DELETE …?confirm=1`) : sans lui, 409 qui dit ce
   *   que ses dépôts liraient.
   * - Ce qui n'était qu'à lui part avec lui : ses consignes, son profil du poste, le réglage de sa pause
   *   et sa connexion Atlassian (`removed`).
   */
  delete(id: string, actor: Actor, confirmed = false): SpaceRemoval {
    const { store, config } = this.#ctx;
    const removal = store.transaction(() => {
      const space = this.#current(id, actor);
      if (this.#around.paused(id))
        throw new HarnessError(
          409,
          `l'espace « ${space.name} » est en pause : reprenez-le d'abord (\`POST /v1/pause {"paused": false, "space": "${id}"}\`) — le retirer libérerait ses runs et ses jobs`,
        );
      const wired = config.repos
        .filter((repo) => space.repos.includes(repo.name) && repo.atlassian === true)
        .map((repo) => repo.name);
      const fallback = this.#around.defaultAtlassian();
      const own = spaceAtlassian(config, id)?.connected === true;
      if (fallback && (own || wired.length > 0) && !confirmed)
        throw new HarnessError(
          409,
          `retirer l'espace « ${space.name} » rend ses dépôts hors espace : ${wired.length > 0 ? `${listed(wired)} ${wired.length > 1 ? "liraient" : "lirait"} aussitôt la connexion Atlassian par défaut` : "ils retrouveraient la connexion Atlassian par défaut"}, et la sienne est oubliée — confirme le retrait (\`DELETE /v1/spaces/${id}?confirm=1\`)`,
        );
      store.deleteSpace(id);
      // Ce qui n'était qu'à lui part avec lui : ses consignes permanentes, et les jetons de sa connexion Atlassian.
      store.deleteStandingRulesOfSpace(id);
      // Ses navigateurs du poste redeviennent hors espace (ils restent appairés) ; son profil part avec lui.
      for (const browser of store.detachWorkstationBrowsers(id))
        this.#ctx.event("workstation_browser", null, { id: browser.id, label: browser.label, space: null }, null);
      store.deleteWorkstationSpaceProfiles(id);
      this.#ctx.event("space", null, { id, action: "removed" });
      const atlassian =
        wired.length === 0
          ? ""
          : fallback
            ? ` ${listed(wired)} ${wired.length > 1 ? "lisent" : "lit"} désormais la connexion Atlassian par défaut.`
            : ` ${listed(wired)} n'${wired.length > 1 ? "ont" : "a"} plus de connexion Atlassian tant que la connexion par défaut n'est pas branchée.`;
      return {
        repos: space.repos,
        defaultAtlassian: fallback ? wired : [],
        text: `${space.repos.length === 0 ? "L'espace n'avait aucun dépôt." : `Ses dépôts (${listed(space.repos)}) sont de nouveau hors espace : sa pause, son budget, sa politique de modèles et ses consignes ne les couvrent plus.`}${atlassian}`,
      };
    });
    this.#around.removed(id);
    return removal;
  }
}
