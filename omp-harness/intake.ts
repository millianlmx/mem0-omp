// Les Demandes : une phrase libre, de n'importe quel client, que l'OS classe (un job léger
// comme les audits, sans dépôt ni mémoire), transforme en plan lisible et crée après UNE
// confirmation, par les chemins existants (intake-create.ts). Rien n'existe avant.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Client } from "./auth.ts";
import { canSeeRepo, repoFilter } from "./auth.ts";
import { isRecord, repoByName, repoDefaults } from "./config.ts";
import type { HarnessConfig, ModelPolicy, RepoConfig } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import { parseCron } from "./cron.ts";
import { INTAKE_STATES } from "./db.ts";
import type {
  IntakeContext,
  IntakeExchange,
  IntakePatch,
  IntakePlan,
  IntakeRow,
  IntakeState,
  RunAutonomy,
  Space,
  Store,
} from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { MAX_INSTRUCTIONS, autonomyField, requireRepo, text } from "./input.ts";
import { spaceRule, strictest } from "./policy.ts";
import { INTAKE_TITLE_MAX, intakePrompt } from "./prompts.ts";
import { shortTitle } from "./proposals.ts";
import type { HostToolResult } from "./rpc.ts";
import { forceStop, hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";
import { DEMANDE_STEP } from "./space-usage.ts";
import { NO_SPACE_HOLDS } from "./spaces.ts";
import type { SpaceHolds } from "./spaces.ts";
import { NAME_MAX } from "./schedules.ts";
import { MAX_INSTRUCTION, stripUrl } from "./workstation.ts";

export const INTAKE_SOURCES = ["console", "ios", "voice", "slack", "cli", "chrome"] as const;
export const INTAKE_KINDS = ["feature", "bug", "audit", "workstation_request", "schedule", "question"] as const;
const PLAN_KINDS = INTAKE_KINDS.filter((kind) => kind !== "question");
const TITLE_MAX = 200;
/** Les bornes du contexte de page d'une Demande, en caractères. */
const CONTEXT_MAX = { url: 2000, title: 300, selection: 4000 } as const;

function isContextKey(key: string): key is keyof typeof CONTEXT_MAX {
  return Object.hasOwn(CONTEXT_MAX, key);
}

/**
 * Le contexte de page d'une Demande (`context`), jugé strictement : un objet, les seules clés `url`,
 * `title` et `selection`, des chaînes bornées (jamais tronquées ici), une adresse http(s). Un champ
 * vide est omis ; sans rien de donné, `null`. L'adresse est gardée sans identifiants, query ni
 * fragment (`stripUrl`) : ils portent des jetons, des recherches, des liens signés.
 */
function pageContext(raw: unknown): IntakeContext | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new HarnessError(400, "context : objet attendu");
  const context: IntakeContext = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isContextKey(key)) throw new HarnessError(400, `context.${key} : champ inconnu (url, title, selection)`);
    if (typeof value !== "string") throw new HarnessError(400, `context.${key} : chaîne attendue`);
    const trimmed = value.trim();
    if (trimmed.length > CONTEXT_MAX[key])
      throw new HarnessError(400, `context.${key} : ${CONTEXT_MAX[key]} caractères au plus`);
    if (trimmed !== "") context[key] = trimmed;
  }
  if (context.url !== undefined) {
    const protocol = URL.canParse(context.url) ? new URL(context.url).protocol : "";
    if (protocol !== "http:" && protocol !== "https:")
      throw new HarnessError(400, "context.url : adresse http ou https attendue");
    context.url = stripUrl(context.url, "context.url");
  }
  return Object.keys(context).length === 0 ? null : context;
}

/** L'objet que la confirmation a créé, par le chemin existant du type de la demande. */
export type Created = { kind: "run" | "audit" | "workstation_request" | "schedule"; id: string };

/**
 * `state` : la section de données « État de l'usine » (brief.ts `factoryStatePrompt`) des dépôts de
 * la portée donnée (`stateScope` : celle de l'auteur, ou le seul dépôt de la demande), ajoutée au
 * prompt du classeur ; absente : le classeur ne connaît pas l'état.
 * `spaces` : la lecture des espaces (`orchestrator.spaces`) ; absente, aucune demande ne porte d'espace.
 */
export type IntakeHooks = {
  /**
   * `autonomy` : le curseur d'autonomie demandé à la confirmation, pour le run d'un plan `feature` ou `bug`.
   * `spaceId` : l'espace de la demande (`null` : hors espace) — une tâche du poste s'y exécute.
   */
  create: (
    plan: IntakePlan,
    client: Client,
    actor: Actor,
    autonomy: RunAutonomy | null | undefined,
    spaceId: string | null,
  ) => Created;
  state?: (scope: IntakeRow["scope"]) => string;
  spaces?: SpaceLookup;
};

/** Ce que les Demandes lisent des espaces : `SpaceDesk.get` et `SpaceDesk.resolve`. */
export type SpaceLookup = {
  get: (id: string) => Space | null;
  resolve: (idOrName: string, repos: readonly string[] | null) => Space;
};

/** Le propriétaire des consommations d'une Demande (monitor.ts `usageSpace`, `recordUsage`). */
function intakeOwner(id: string): string {
  return `intake:${id}`;
}

/** Ce que le classeur apprend de l'espace où la demande est posée : ses dépôts sont les seuls permis, et s'il a un poste. */
function spaceNote(space: Space): string {
  const poste = space.poste
    ? ""
    : " Cet espace n'a pas de poste de travail : ne classe jamais la demande en `workstation_request`.";
  return `\n\nCette demande est posée dans l'espace « ${space.name} » : seuls les dépôts listés plus haut sont les siens.${poste}`;
}

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
  /** La page d'où part la demande (`url`, `title`, `selection`) ; `null` sans page, ou pour un lecteur qui n'en est ni l'auteur ni le propriétaire. */
  context: IntakeContext | null;
  /** L'espace où la demande a été posée ; `null` hors espace, ou si l'espace n'existe plus. */
  space: { id: string; name: string } | null;
  created: Created | null;
  reason: string | null;
  by: string | null;
  createdAt: number;
  updatedAt: number;
};

/**
 * La Demande telle que `reader` la lit (contrat public : jamais la portée de l'auteur). Le contexte
 * de page — l'adresse, le titre et la sélection d'un onglet du poste — n'est rendu qu'à l'auteur de
 * la demande et au propriétaire (client non borné, non pilote) ; tout autre lecteur reçoit `null`.
 * `spaces` : d'où lire le nom de son espace (`orchestrator.spaces`) ; absent, `space` vaut `null`.
 */
export function intakeView(row: IntakeRow, reader: Client, spaces?: Pick<SpaceLookup, "get">): IntakeView {
  const readsContext = row.createdBy === reader.name || (reader.repos === "*" && !reader.pilot);
  const space = row.spaceId === null ? null : (spaces?.get(row.spaceId) ?? null);
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
    context: readsContext ? row.context : null,
    space: space === null ? null : { id: space.id, name: space.name },
    created: row.targetKind && row.targetId ? { kind: row.targetKind as Created["kind"], id: row.targetId } : null,
    reason: row.reason,
    by: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * La règle de lecture : le dépôt de la demande, sinon son auteur ou un client qui voit tous les dépôts.
 * `space` : la lecture est bornée à cet espace (`?space=`) — la demande doit en être, par son dépôt ou,
 * sans dépôt, par l'espace où elle a été posée.
 */
function visible(client: Client, row: IntakeRow, space: Space | null): boolean {
  if (space !== null && !(row.repo !== "" ? space.repos.includes(row.repo) : row.spaceId === space.id)) return false;
  return row.repo !== "" ? canSeeRepo(client, row.repo) : client.repos === "*" || row.createdBy === client.name;
}

/** Une demande lisible par `client` (dans `space` s'il est donné) ; 404 sinon (absente ou invisible : on ne dit pas laquelle). */
export function visibleIntake(store: Store, client: Client, id: string, space: Space | null = null): IntakeRow {
  const row = store.getIntake(id);
  if (!row || !visible(client, row, space)) throw new HarnessError(404, `demande inconnue : ${id}`);
  return row;
}

/**
 * La portée de la section « État de l'usine » du classement : celle de l'auteur ; pour une demande qui
 * porte un dépôt, ce seul dépôt (s'il est dans sa portée). La réponse se lit par tout client qui voit
 * ce dépôt : elle ne doit rien dire des autres.
 */
function stateScope(row: IntakeRow): IntakeRow["scope"] {
  if (row.repo === "") return row.scope;
  return row.scope === "*" || row.scope.includes(row.repo) ? [row.repo] : [];
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
 * chaînes du serveur. Jamais `memory`, `gh` ni `git` du dépôt. Chaque dépôt compte avec la
 * politique de son espace, et la Demande suit aussi — au plus strict (policy.ts `strictest` :
 * `local-only`, liste blanche `providers`, chaînes `models`) — la politique de l'espace où elle est
 * posée (`spaceId`) et de CHAQUE espace dont l'auteur voit un dépôt : l'« État de l'usine » de son
 * prompt cite leurs runs. Deux espaces aux listes blanches disjointes ne laissent aucun fournisseur :
 * le classement est refusé (échec fermé) — la Demande se pose alors dans un espace. Sans espace
 * (`spaces` vide), rien ne change.
 */
export function intakePolicy(config: HarnessConfig, row: IntakeRow, spaces: readonly Space[] = []): ModelPolicy {
  const bound = (repo: RepoConfig) => strictest(repo, spaceRule(spaces, repo.name)?.policy ?? null);
  if (row.requestedRepo !== null) {
    const repo = repoByName(config, row.requestedRepo);
    if (!repo) throw new HarnessError(404, `dépôt inconnu : ${row.requestedRepo}`);
    const { models, providers, privacy } = bound(repo);
    return {
      ...(models ? { models } : {}),
      ...(providers ? { providers } : {}),
      ...(privacy ? { privacy } : {}),
    };
  }
  const names = visibleRepos(config, row.scope);
  const own: ModelPolicy = config.repos.some(
    (repo) => names.includes(repo.name) && bound(repo).privacy === "local-only",
  )
    ? { privacy: "local-only" }
    : {};
  return spaces
    .filter((space) => space.id === row.spaceId || space.repos.some((repo) => names.includes(repo)))
    .reduce((policy, space) => strictest(policy, space.policy), own);
}

/**
 * Le dépôt synthétique du classeur : aucun clone, aucun worktree, aucune mémoire. Sa scope
 * est propre à la demande (jamais relue), son cwd a la forme `<dépôt>/<_x>` du lanceur root.
 */
export function intakeTarget(
  config: HarnessConfig,
  row: IntakeRow,
  spaces: readonly Space[] = [],
): { repo: RepoConfig; cwd: string; memory: false } {
  return {
    repo: {
      ...repoDefaults({ name: "intake", path: path.join(config.dataDir, "intake"), scope: `intake-${row.id}` }),
      ...intakePolicy(config, row, spaces),
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

/**
 * Juge le rendu de `intake_classify` : un `IntakePatch` (clarification, réponse, plan ou échec). Pure.
 * `poste: false` : la demande est posée dans un espace sans poste de travail, une tâche du poste y est refusée.
 */
export function interpretClassification(
  raw: Record<string, unknown>,
  ctx: { declared: string[]; scope: IntakeRow["scope"]; requestedRepo: string | null; poste?: boolean },
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
  if (kind === "workstation_request" && ctx.poste === false) return failed(NO_POSTE);
  const judged = judge(
    {
      kind,
      // Le titre du classeur est borné à la source (une liste le montre entier) ; celui que l'humain
      // corrige à la confirmation reste le sien.
      title: shortTitle(field("title"), INTAKE_TITLE_MAX),
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

/** Le refus d'une tâche du poste dans un espace qui n'a pas de poste de travail. */
const NO_POSTE = "cet espace n'a pas de poste de travail : la demande ne peut pas devenir une tâche du poste";

/** Les états d'où une demande s'annule : tout sauf `confirmed` et `cancelled`. */
const CANCELLABLE: readonly IntakeState[] = ["classifying", "clarifying", "planned", "answered", "failed"];

export class Intaker {
  readonly #ctx: HarnessContext;
  readonly #hooks: IntakeHooks;
  readonly #live = new Map<string, LiveIntake>();
  /** Les demandes dont `reason` dit ce qui retient leur espace (pause, budget) : effacée quand elles partent. */
  readonly #held = new Set<string>();

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

  /**
   * L'espace où une demande est posée : `body.space` (identifiant ou nom), sinon celui de la requête
   * (`?space=`), sinon le seul espace d'un client borné à UN espace ; `null` : hors espace. 404 pour un
   * espace inconnu ou dont le client ne voit aucun dépôt.
   */
  #spaceAt(body: Record<string, unknown>, client: Client, requested: Space | null): Space | null {
    const { spaces } = this.#hooks;
    const ref = body.space;
    if (ref !== undefined && ref !== null) {
      if (typeof ref !== "string") throw new HarnessError(400, "space : identifiant ou nom d'espace attendu");
      if (!spaces) throw new HarnessError(404, `espace inconnu : ${ref}`);
      const named = spaces.resolve(ref, repoFilter(client));
      if (requested !== null && requested.id !== named.id)
        throw new HarnessError(400, "space : le corps et `?space=` désignent deux espaces différents");
      return named;
    }
    if (requested !== null) return requested;
    const own = client.spaces?.length === 1 ? client.spaces[0] : undefined;
    if (own === undefined || !spaces || client.repos === "*" || client.repos.length === 0) return null;
    return spaces.get(own) === null ? null : spaces.resolve(own, client.repos);
  }

  /**
   * L'espace d'une demande déjà posée, tel que `client` le voit (ses dépôts : ceux de l'espace que le
   * client voit) ; `null` hors espace. Un espace disparu depuis la pose : 409, rien n'est créé hors de lui.
   */
  #spaceOf(row: IntakeRow, client: Client): Space | null {
    if (row.spaceId === null) return null;
    const space = this.#hooks.spaces?.get(row.spaceId) ?? null;
    if (space === null) throw new HarnessError(409, "l'espace de cette demande n'existe plus : rien n'est créé");
    return { ...space, repos: space.repos.filter((repo) => canSeeRepo(client, repo)) };
  }

  /** `requested` : l'espace de la requête (`?space=`, `call.space`). */
  create(body: Record<string, unknown>, client: Client, actor: Actor, requested: Space | null = null): IntakeRow {
    const { store } = this.#ctx;
    const demande = this.#text(body);
    const source = typeof body.source === "string" ? body.source : "";
    if (!(INTAKE_SOURCES as readonly string[]).includes(source))
      throw new HarnessError(400, "source : console, ios, voice, slack, cli ou chrome attendu");
    const space = this.#spaceAt(body, client, requested);
    const repo = text(body, "repo", false).trim();
    if (repo !== "") {
      requireRepo(client, repo);
      this.#ctx.repo(repo);
      if (space !== null && !space.repos.includes(repo))
        throw new HarnessError(400, `repo : le dépôt ${repo} n'est pas dans l'espace « ${space.name} »`);
    }
    const context = pageContext(body.context);
    return store.transaction(() => {
      const row = store.createIntake({
        id: newId("i"),
        text: demande,
        source,
        repo,
        requestedRepo: repo || null,
        // Dans un espace, la portée du classeur est celle de l'espace que voit l'auteur (`resolve` l'a déjà réduit).
        scope: space === null ? client.repos : [...space.repos],
        context,
        spaceId: space?.id ?? null,
        createdBy: actor.by,
      });
      this.#event(row, actor.by ? { by: actor.by } : {});
      return row;
    });
  }

  /**
   * Les demandes en classement que le scheduler admet. `holds` : la Demande d'un espace en pause, ou
   * au budget du jour atteint — celui où elle a été posée, sinon celui du dépôt qu'elle impose —,
   * attend en classement, sa cause écrite dans `reason` (une fois) ; les autres partent.
   */
  tick(holds: SpaceHolds = NO_SPACE_HOLDS): void {
    const { store } = this.#ctx;
    for (const row of store.listIntakes({ states: ["classifying"] })) {
      if (this.#live.has(row.id)) continue;
      const hold = row.spaceId !== null ? holds.ofSpace(row.spaceId) : row.repo !== "" ? holds.ofRepo(row.repo) : null;
      if (hold !== null) {
        if (row.reason !== hold.text) {
          const waiting = store.updateIntakeIf(row.id, ["classifying"], { reason: hold.text });
          if (waiting) this.#event(waiting, { held: hold.cause });
        }
        this.#held.add(row.id);
        continue;
      }
      if (this.#ctx.monitor.dailyBudgetDue()) return;
      const slot = this.#ctx.scheduler.tryAcquire("runner", row.id);
      if ("refused" in slot) return;
      // Plus rien ne la retient : la cause d'attente s'efface avant le classement.
      if (this.#held.delete(row.id)) {
        const freed = store.updateIntakeIf(row.id, ["classifying"], { reason: null });
        if (freed) this.#event(freed);
      }
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
      // L'espace de la demande, relu : disparu depuis la pose, le classement échoue plutôt que de sortir de lui.
      const space = row.spaceId === null ? null : (this.#hooks.spaces?.get(row.spaceId) ?? null);
      if (row.spaceId !== null && space === null) throw new Error("l'espace de la demande n'existe plus");
      const target = intakeTarget(config, row, this.#ctx.store.listSpaces());
      fs.mkdirSync(target.repo.path, { recursive: true });
      fs.mkdirSync(target.cwd, { recursive: true });
      // Hors espace, rien n'est relevé, comme avant ; dans un espace, chaque message lui est imputé (`usage.space_id`).
      if (space !== null) this.#ctx.monitor.usageSpace(intakeOwner(row.id), space.id);
      const session = new RunnerSession(this.#ctx, target, {
        onHostTool: (name, args) => this.#hostTool(row, live, name, args),
        event: (type, payload) => this.#ctx.event(type, null, { intakeId: row.id, ...payload }, row.repo || null),
        ...(space === null
          ? {}
          : {
              frame: (frame: Record<string, unknown>) =>
                this.#ctx.monitor.recordFrame(intakeOwner(row.id), DEMANDE_STEP, frame),
            }),
      });
      live.session = session;
      const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
      await session.open(config.intake.tier, runnerUnit(row.id, 0), live.abort.signal);
      await session.setHostTools(hostToolsFor("intake"));
      let result = await session.prompt(
        `${intakePrompt({
          text: row.text,
          source: row.source,
          visibleRepos: visibleRepos(config, row.scope),
          requestedRepo: row.requestedRepo,
          exchanges: row.exchanges,
          context: row.context,
        })}${space === null ? "" : spaceNote(space)}${this.#hooks.state?.(stateScope(row)) ?? ""}`,
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
              ...(space === null ? {} : { poste: space.poste }),
            });
    } catch (err) {
      patch = {
        state: "failed",
        reason: `le classement a échoué : ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      this.#ctx.monitor.usageSpace(intakeOwner(row.id), null);
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
   * portée de celui qui confirme (`scope` : ses dépôts, ceux de l'espace de la demande qu'il voit
   * quand elle en porte un) ; chaque refus est un 400.
   */
  #corrected(plan: IntakePlan, raw: unknown, scope: IntakeRow["scope"]): IntakePlan {
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
      scope,
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
    const space = this.#spaceOf(row, client);
    const plan =
      body.plan === undefined ? row.plan : this.#corrected(row.plan, body.plan, space?.repos ?? client.repos);
    // Le plan d'une demande posée dans un espace n'en sort pas : son dépôt en est encore, une tâche du poste y a son poste.
    if (space !== null && plan.repo !== null && !space.repos.includes(plan.repo))
      throw new HarnessError(400, `le dépôt « ${plan.repo} » n'est pas dans l'espace « ${space.name} » de la demande`);
    if (space !== null && plan.kind === "workstation_request" && !space.poste) throw new HarnessError(400, NO_POSTE);
    const autonomy = autonomyField(body);
    return store.transaction(() => {
      const reserved = store.updateIntakeIf(id, ["planned"], {
        state: "confirmed",
        plan,
        kind: plan.kind,
        repo: plan.repo ?? "",
      });
      if (!reserved) throw notPlanned(store.getIntake(id)?.state ?? "inconnu");
      const created = this.#hooks.create(plan, client, actor, autonomy, row.spaceId);
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
