// La création des runs et des projets : la voie d'un run neuf, ses specs synthétisés, la déduction de ses modules,
// puis un projet et ses features nés ensemble. Le slug d'un run est libre dans son dépôt.
import type { WorkKind } from "../autonomy/autonomy-rules.ts";
import { raisesAutonomy } from "../human/pilot.ts";
import type { Actor, HarnessContext } from "./context.ts";
import type { RunAutonomy, RunLane, RunRow } from "../db/db.ts";
import { detectIrreversible } from "./decisions.ts";
import { HarnessError } from "../api/errors.ts";
import { newId } from "./ids.ts";
import { budgetUsd } from "../api/input.ts";
import { briefOfReq } from "../memory/oracle.ts";
import { knownModules, modulesViaOracle } from "./planner.ts";
import { SPECS_BASELINE, directSpecs, expressSpecs } from "./steps.ts";
import { waitReason } from "./split.ts";
import type { Orchestrator } from "./orchestrator.ts";

/**
 * `req` : le compte rendu de besoins déjà établi en session interactive (/req local) — le run part de /specs.
 * `lane: "full"` : la voie complète (/req) même si la demande porte ses critères d'acceptation.
 * `budgetUsd` : le budget propre du run, prioritaire sur `monitoring.runBudgetUsd`.
 */
export type NewRunInput = {
  repo: string;
  title: string;
  request: string;
  slug?: string;
  modules?: string[];
  req?: string;
  priority?: number;
  /** `express` : la voie express (`lanes.express`) ; absent : `lanes.default`. */
  lane?: "full" | "express";
  budgetUsd?: number;
  /** Le type de travail et les labels déclarés par le créateur (`POST /v1/runs`), lus par l'autonomie par paliers. */
  kind?: WorkKind;
  labels?: string[];
  /** Le curseur d'autonomie du run (`ask`, `deliver`, `null` : les règles du dépôt) ; absent : celui de l'espace du dépôt. */
  autonomy?: RunAutonomy | null;
};

export type NewProjectInput = {
  repo: string;
  title: string;
  priority?: number;
  /** Le curseur d'autonomie de toutes ses features ; absent : celui de l'espace du dépôt. */
  autonomy?: RunAutonomy | null;
  /** `after` (découpage seulement) : la feature attend le merge du run parent (`afterRun`). */
  features: { title: string; request: string; slug?: string; modules?: string[]; after?: boolean }[];
};

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "feature" : slug;
}

type CreationHost = Pick<Orchestrator, "store" | "spaces" | "createRun">;

type CreationHooks = {
  /** Un tour de scheduling, pour qu'un run créé parte sans attendre l'horloge. */
  kick: () => void;
};

export class RunCreation {
  readonly #ctx: HarnessContext;
  readonly #host: CreationHost;
  readonly #hooks: CreationHooks;
  /** Les runs dont les modules sont en cours de déduction : pas candidats avant. */
  readonly #inferring = new Set<string>();

  constructor(ctx: HarnessContext, host: CreationHost, hooks: CreationHooks) {
    this.#ctx = ctx;
    this.#host = host;
    this.#hooks = hooks;
  }

  /** Les modules de ce run sont-ils en cours de déduction ? L'admission ne le prend pas avant. */
  isInferring(runId: string): boolean {
    return this.#inferring.has(runId);
  }

  #freeSlug(repo: string, wanted: string): string {
    let slug = wanted;
    for (let n = 2; this.#host.store.slugTaken(repo, slug); n++) slug = `${wanted}-${n}`;
    return slug;
  }

  /**
   * Un run sans `modules` : ils sont déduits par l'oracle (comme pour un projet) avant
   * l'admission — sinon le run chevaucherait tout le dépôt jusqu'à ses specs. La
   * déduction est asynchrone ; le run est créé tout de suite et n'est pas candidat
   * tant qu'elle court. `afterRun` : le parent d'une feature découpée, dont elle attend
   * le merge en file (split.ts). `inheritAutonomy` : le curseur du run dont celui-ci descend
   * (découpage, run de suite) — hérité tel quel, ce n'est pas l'acteur qui le monte.
   */
  createRun(
    input: NewRunInput & {
      projectId?: string;
      projectOrder?: number;
      inferModules?: boolean;
      afterRun?: Pick<RunRow, "id" | "title">;
      inheritAutonomy?: RunAutonomy | null;
    },
    actor: Actor,
  ): RunRow {
    const repo = this.#ctx.repo(input.repo);
    if (input.title.trim() === "" || input.request.trim() === "")
      throw new HarnessError(400, "title et request sont requis");
    const req = input.req?.trim() ?? "";
    // Le curseur d'autonomie : celui qu'on demande, sinon celui du run dont on descend, sinon celui de l'espace.
    const fallback =
      input.inheritAutonomy === undefined ? this.#host.spaces.autonomyOf(input.repo) : input.inheritAutonomy;
    const autonomy = input.autonomy === undefined ? fallback : input.autonomy;
    if (actor.pilot && raisesAutonomy(fallback, autonomy))
      throw new HarnessError(403, "geste réservé à l'humain — un pilote ne monte pas l'autonomie d'un run");
    const { lane, specs, refused } = this.#laneOf(input, req, autonomy);
    if (req !== "" && !/^##\s+Besoins/m.test(req)) throw new HarnessError(400, "req : la section `## Besoins` manque");
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || Math.abs(priority) > 1000)
      throw new HarnessError(400, "priority : entier entre -1000 et 1000");
    const budget = budgetUsd(input.budgetUsd);
    const { store } = this.#ctx;
    const run = store.transaction(() => {
      const slug = this.#freeSlug(input.repo, slugify(input.slug ?? input.title));
      const created = store.createRun({
        id: newId("r"),
        repo: input.repo,
        slug,
        title: input.title.trim(),
        request: input.request.trim(),
        branch: `harness/${slug}`,
        modules: input.modules ?? [],
        priority,
        createdBy: actor.by,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        autonomy,
        lane,
        ...(req !== "" ? { step: "specs" as const } : specs !== null ? { step: "impl" as const } : {}),
        ...(input.projectId ? { projectId: input.projectId, projectOrder: input.projectOrder ?? 0 } : {}),
        ...(input.afterRun ? { afterRun: input.afterRun.id, reason: waitReason(input.afterRun) } : {}),
      });
      if (req !== "") store.putArtifact(created.id, "req.md", `${req}\n`, null);
      if (budget !== undefined) this.#ctx.monitor.setRunBudget(created.id, budget, actor.by);
      // Voie directe : les specs synthétisées sont aussi les specs gelées sur lesquelles la revue juge.
      if (specs !== null) {
        store.putArtifact(created.id, "specs.md", specs, null);
        store.putArtifact(created.id, SPECS_BASELINE, specs, null);
      }
      this.#ctx.event("run_created", created.id, {
        repo: created.repo,
        slug: created.slug,
        title: created.title,
        modules: created.modules,
        projectId: created.projectId,
        priority,
        ...(created.autonomy !== null ? { autonomy: created.autonomy } : {}),
        ...(budget !== undefined ? { budgetUsd: budget } : {}),
        lane,
        ...(refused !== null ? { laneRefused: refused } : {}),
        ...(input.afterRun ? { afterRun: input.afterRun.id } : {}),
        ...(actor.by ? { by: actor.by } : {}),
      });
      return created;
    });
    // Seuls les titres de besoins (`B-n`) entrent dans l'oracle : un souvenir court, qui se rappelle bien.
    const brief = req !== "" ? briefOfReq(req) : "";
    if (brief !== "")
      void this.#ctx.oracle.retain(repo.scope, `Compte rendu de besoins — « ${run.title} » :\n${brief}`, [
        "harness",
        "besoins",
      ]);
    if (input.inferModules !== false && (input.modules ?? []).length === 0) void this.#inferModules(run);
    else this.#hooks.kick();
    return run;
  }

  /**
   * La voie d'un run neuf et son specs.md synthétisé (`null` : voie complète, /req écrira les besoins). Un `req`
   * fourni part de /specs (voie complète). La voie express (`lane: "express"`, ou `lanes.default: "express"`
   * sans `lane`) naît à /impl avec `expressSpecs` ; refusée (`#expressRefused`), le run prend la voie que la
   * demande aurait eue sans elle, et `refused` dit pourquoi (événement `run_created`, `laneRefused`).
   */
  #laneOf(
    input: NewRunInput & { projectId?: string; projectOrder?: number },
    req: string,
    autonomy: RunAutonomy | null,
  ): { lane: RunLane; specs: string | null; refused: string | null } {
    if (req !== "") return { lane: "full", specs: null, refused: null };
    const wanted = input.lane ?? (this.#ctx.config.lanes.default === "express" ? "express" : undefined);
    const refused = wanted === "express" ? this.#expressRefused(input, autonomy) : null;
    if (wanted === "express" && refused === null)
      return { lane: "express", specs: expressSpecs(input.title, input.request), refused: null };
    const specs = autonomy !== "ask" ? this.#directSpecs(input) : null;
    return { lane: specs !== null ? "direct" : "full", specs, refused };
  }

  /** Pourquoi la voie express est refusée à cette demande, ou `null` : elle part en express. */
  #expressRefused(input: NewRunInput, autonomy: RunAutonomy | null): string | null {
    const { config } = this.#ctx;
    if (!config.lanes.express) return "voie express coupée (`lanes.express: false`)";
    if (autonomy === "ask") return "autonomie « tout me demander » : la voie complète";
    if (config.review.specsGate === true) return "porte des specs toujours posée (`review.specsGate: true`)";
    const irreversible = detectIrreversible(`${input.title}\n${input.request}`);
    return irreversible === null
      ? null
      : `geste irréversible (${irreversible}) : la voie complète le soumet à l'humain`;
  }

  /**
   * Le specs.md de la voie directe (`directSpecs`), ou `null` : voie complète. Une demande
   * à critères passe quand même par /req si le client le demande (`lane: "full"`), si
   * `lanes.direct` est coupé, ou si la porte des specs l'aurait arrêtée : toujours
   * (`specsGate: true`), ou en `"auto"` sur l'irréversible et la première feature d'un
   * projet. Les modules vides ne comptent pas : l'oracle les déduit comme pour tout run créé sans.
   */
  #directSpecs(input: NewRunInput & { projectId?: string; projectOrder?: number }): string | null {
    const { config } = this.#ctx;
    if (input.lane === "full" || !config.lanes.direct || config.review.specsGate === true) return null;
    const specs = directSpecs(input.title, input.request);
    if (specs === null || config.review.specsGate === false) return specs;
    const firstOfProject = Boolean(input.projectId) && (input.projectOrder ?? 0) === 0;
    return detectIrreversible(specs) !== null || firstOfProject ? null : specs;
  }

  /** Les modules d'un run créé sans : l'oracle, puis `modules` posés s'ils ne l'ont pas été entre-temps (`set_modules`). */
  async #inferModules(run: RunRow): Promise<void> {
    const { store, oracle, git } = this.#ctx;
    this.#inferring.add(run.id);
    try {
      const repo = this.#ctx.repo(run.repo);
      const known = knownModules(await git.listFiles(repo.path, repo.mainBranch));
      const { modules } = await modulesViaOracle(oracle, repo.scope, `${run.title}\n${run.request}`, known);
      const current = store.getRun(run.id);
      if (modules.length > 0 && current && current.modules.length === 0 && current.state === "queued") {
        store.updateRun(run.id, { modules });
        this.#ctx.event("modules", run.id, { modules, source: "oracle" });
      }
    } catch (err) {
      this.#ctx.log(`run ${run.id} : modules non déduits — ${err instanceof Error ? err.message : String(err)}`, {
        level: "warn",
        runId: run.id,
        repo: run.repo,
      });
    } finally {
      this.#inferring.delete(run.id);
      this.#hooks.kick();
    }
  }

  /** /project : les modules de chaque feature (déclarés, sinon via l'oracle), puis une file planifiée. */
  async createProject(input: NewProjectInput, actor: Actor): Promise<{ projectId: string; runs: RunRow[] }> {
    const { oracle, git } = this.#ctx;
    const repo = this.#ctx.repo(input.repo);
    if (input.features.length === 0) throw new HarnessError(400, "un projet a au moins une feature");
    const known = knownModules(await git.listFiles(repo.path, repo.mainBranch));
    const modules: string[][] = [];
    for (const feature of input.features) {
      modules.push(
        feature.modules && feature.modules.length > 0
          ? feature.modules
          : (await modulesViaOracle(oracle, repo.scope, `${feature.title}\n${feature.request}`, known)).modules,
      );
    }
    return this.openProject(
      { ...input, features: input.features.map((feature, order) => ({ ...feature, modules: modules[order] ?? [] })) },
      actor,
      // Déjà demandés à l'oracle ci-dessus : une liste vide le reste.
      { inferModules: false },
    );
  }

  /**
   * Le projet et ses runs, nés ensemble : un client ne voit jamais un projet à moitié créé.
   * `inferModules` : les features sans modules les demandent à l'oracle après coup (un
   * découpage, qui naît dans la transaction d'une transition, ne l'attend pas) ;
   * `afterRun` : le run découpé ; seules ses features marquées `after` attendent son merge, les autres
   * sont des runs normaux, admis tout de suite (le planificateur départage par modules).
   */
  openProject(
    input: NewProjectInput,
    actor: Actor,
    options: { inferModules?: boolean; afterRun?: RunRow },
  ): { projectId: string; runs: RunRow[] } {
    const { store } = this.#ctx;
    const repo = this.#ctx.repo(input.repo);
    // Une feature découpée hérite du curseur de son parent ; sinon celui du projet, s'il en donne un.
    const inherit: { inheritAutonomy?: RunAutonomy | null; autonomy?: RunAutonomy | null } = options.afterRun
      ? { inheritAutonomy: options.afterRun.autonomy }
      : input.autonomy !== undefined
        ? { autonomy: input.autonomy }
        : {};
    return store.transaction(() => {
      const project = store.createProject({ id: newId("p"), repo: repo.name, title: input.title });
      const runs = input.features.map(({ after, ...feature }, order) =>
        this.#host.createRun(
          {
            ...feature,
            repo: repo.name,
            modules: feature.modules ?? [],
            projectId: project.id,
            projectOrder: order,
            ...(options.inferModules === false ? { inferModules: false } : {}),
            ...(options.afterRun && after === true ? { afterRun: options.afterRun } : {}),
            ...inherit,
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          },
          actor,
        ),
      );
      this.#ctx.event(
        "project_created",
        null,
        {
          projectId: project.id,
          repo: repo.name,
          runs: runs.map((run) => ({ id: run.id, modules: run.modules })),
          ...(options.afterRun && input.features.some((feature) => feature.after === true)
            ? { afterRun: options.afterRun.id }
            : {}),
          ...(actor.by ? { by: actor.by } : {}),
        },
        repo.name,
      );
      return { projectId: project.id, runs };
    });
  }

  /** Un run de suite hérite du curseur du run dont il descend : ce n'est pas l'acteur (un pilote compris) qui le monte. */
  followUp({ autonomy, ...input }: NewRunInput, actor: Actor): RunRow {
    return this.#host.createRun({ ...input, ...(autonomy !== undefined ? { inheritAutonomy: autonomy } : {}) }, actor);
  }
}
