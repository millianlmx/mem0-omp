// /project : la commande, le cadrage, le plan, et le relais des pipelines du projet.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTRACT_PATH, saysFin } from "./contract.ts";
import { branchFor, branchTaken, resolveFeatureRoot } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { AUDIT_RELAY_STALE_MS, LOT_EDITOR_MAX, lotFeature, lotRepoKey, readLot } from "./lot.ts";
import type { LotController } from "./lotController.ts";
import { modelDialogChoice, modelDialogOptions, modelQuestionTitle } from "./models.ts";
import type { ModelSlots } from "./models.ts";
import {
  PROJECT_DOC_BRANCH,
  PROJECT_DOC_FILE,
  checkPlan,
  checkSegments,
  deleteProject,
  githubRemoteOf,
  newProject,
  newProjectFeature,
  parsePlanText,
  planDialogTitle,
  projectFailureItems,
  readProject,
  renderPlanText,
  renderProjectDoc,
  writeProject,
} from "./project.ts";
import type { PlanDraft, PlanSegment, Project, ProjectSegment } from "./project.ts";
import { createProjectDriver, projectState } from "./projectDriver.ts";
import type { ProjectDriver } from "./projectDriver.ts";
import { sessionFileOf } from "./publish.ts";
import { createRelay, relayToolText as toolText } from "./relay.ts";
import type { Relay, RelayCore, RelayEscalation, RelayItem, RelayState, RelayToolResult } from "./relay.ts";
import { buildProjectResumeSeed, buildProjectSeed } from "./seeds.ts";
import { pidAlive, readAuditRelay } from "./store.ts";
import type { PipelineCtx } from "./store.ts";



// ---------------------------------------------------------------------------
// /project — le cadrage, le plan, puis le relais des pipelines du projet.
// ---------------------------------------------------------------------------
// `/project` ouvre une session de CADRAGE (but, fonction du projet), où l'agent
// soumet son plan par `project_plan` : l'outil le fait corriger et valider, fait
// choisir le modèle de chaque feature, écrit le projet et lance le premier
// segment. La même session devient alors le RELAIS des pipelines du projet — le
// relais générique (`relay.ts`) avec le profil /project : questions, jalons et
// ÉCHECS des features lui sont injectés en messages `[project]`, et le pilote du
// projet (`projectDriver.ts`) tourne à chacun de ses balayages. Relancer /project
// dans le dépôt reprend le projet (plan et avancement), sans refaire le cadrage.

/** L'état du relais /project du process (même patron que `auditState`). */
export const projectRelayState: RelayState = (() => {
  const key = Symbol.for("omp-mem0-req.projectRelayState");
  const host = globalThis as unknown as Record<symbol, RelayState | undefined>;
  const existing = host[key];
  if (existing) return existing;
  const created: RelayState = {
    tools: false,
    created: new Set(),
    sessionFile: null,
    repoRoot: null,
    relayed: new Map(),
    stopTimer: null,
    dialogs: Promise.resolve(),
    foreignWarned: false,
    ctx: null,
  };
  host[key] = created;
  return created;
})();


export type ProjectRelayDeps = {
  pi: ExtensionAPI;
  stateDir: () => string;
  controllerFor: (ctx: ExtensionContext) => LotController;
  notify: (text: string) => void;
  /** git local (10 s). */
  runGit: GitRunner;
  /** git réseau (60 s) : fetch et push vers l'URL HTTPS du dépôt. */
  runGitNet: GitRunner;
  runGh: (args: string[], cwd: string) => Promise<GitResult>;
  now?: () => number;
};


export type ProjectRelay = Relay & {
  /** La passe du pilote du projet armé — résolue sans rien faire quand le relais n'est pas armé. */
  tick(): Promise<void>;
  /** `/project [contexte]` (S-1, S-2, S-4). */
  runProjectCommand(args: string, ctx: ExtensionCommandContext): Promise<void>;
  /** Le « fin » du cadrage, lu dans `before_agent_start` (S-2 §4). */
  onProjectPrompt(prompt: string, ctx: ExtensionContext): void;
};


const EDIT_TITLE =
  "Corrige le plan — « ## <segment> » ouvre un segment, « - <nom> — <intention> » ajoute une feature ; l'ordre des lignes est l'ordre du plan.";
const COMPLETE = "Tout est bon, c'est complet.";
const PLAN_VALIDATE = "Valider le plan";
const PLAN_FIX = "Corriger le plan";
const PLAN_ABANDON = "Abandonner";
const PLAN_INTERRUPTED = "Plan non validé : dialogue interrompu — rien n'est écrit ni lancé.";
const PLAN_RUNNING = "Error: le plan du projet est déjà validé — pour le modifier, appelle project_amend";
const NO_PROJECT = "Error: aucun projet en cours dans ce dépôt";
const AMEND_APPLY = "Appliquer la modification";
const AMEND_FIX = "Corriger la modification";
const AMEND_REJECT = "Rejeter la modification";
const AMEND_INTERRUPTED = "Modification non appliquée : dialogue interrompu — le plan est inchangé.";
const FAILURE_RELAUNCH = "Relancer la feature";
const FAILURE_REMOVE = "Retirer la feature du plan";
const FAILURE_STOP = "Arrêter le projet";
const RESUME = "Reprendre le projet";
const RESTART_STOPPED = "Nouveau projet (le plan actuel est abandonné)";
const RESTART_DONE = "Nouveau projet (nouveau cadrage)";
const CANCEL = "Annuler";
/** Les préfixes de nos propres notices : jamais une entrée de l'utilisateur (S-2 §4). */
const NOTICE_PREFIXES = ["[req]", "[pipeline]", "[project]", "[audit]"];


/**
 * Le refus « conduite déjà tenue » (S-7) : le texte EXACT d'aujourd'hui, écrit
 * une seule fois — la commande `/project` le dit dans une session, l'API du
 * service le rend en 409 (`servicePilot.startConduite`), et les deux doivent
 * rester mot pour mot.
 */
export function conduiteBusyRefusal(repo: string, pid: number): string {
  return `[project] le projet de ${repo} est conduit par une autre session vivante (pid ${pid}) — continue dans celle-ci, ou ferme-la puis relance /project.`;
}


/** Les slugs d'une liste de segments, dans l'ordre du plan. */
function slugsOf(segments: readonly PlanSegment[]): string[] {
  return segments.flatMap((segment) => segment.features.map((feature) => feature.slug));
}


/** L'index et le segment qui portent `slug`, ou `null`. */
function segmentOf(project: Project, slug: string): { index: number; segment: ProjectSegment } | null {
  const index = project.segments.findIndex((segment) => segment.features.some((feature) => feature.slug === slug));
  return index === -1 ? null : { index, segment: project.segments[index] as ProjectSegment };
}


/** Le relais /project (S-6), sa commande (S-1) et ses outils (S-3, S-8, S-9). */
export function createProjectRelay(deps: ProjectRelayDeps): ProjectRelay {
  const { pi } = deps;
  const state = projectRelayState;
  const now = () => (deps.now ?? Date.now)();
  const drivers = new Map<string, ProjectDriver>();

  /** Le pilote du projet d'un dépôt : un par dépôt et par process, comme le pilote de lot. */
  function driverFor(repoRoot: string): ProjectDriver {
    let driver = drivers.get(repoRoot);
    if (driver === undefined) {
      driver = createProjectDriver({
        stateDir: deps.stateDir,
        repoRoot,
        // Le pilote de lot se lit sur le contexte ARMÉ : ses actions n'ont lieu que
        // quand le relais du projet est armé.
        controller: () => deps.controllerFor(state.ctx as ExtensionContext),
        runGit: deps.runGit,
        runGitNet: deps.runGitNet,
        runGh: deps.runGh,
        notify: deps.notify,
        now: deps.now,
      });
      drivers.set(repoRoot, driver);
    }
    return driver;
  }

  const projectOf = (repoRoot: string): Project | null => readProject(deps.stateDir(), lotRepoKey(repoRoot));

  /** Le prédicat d'armement (S-6 §2) : la session de cadrage, ou la session hôte d'un projet en cours. */
  function armedFor(sessionFile: string, repoRoot: string): boolean {
    if (projectState.cadrage?.sessionFile === sessionFile) return true;
    const project = projectOf(repoRoot);
    return project !== null && project.status === "running" && project.hostSession === sessionFile;
  }

  /** Le message injecté pour un élément, mot pour mot (S-6 §4). */
  function message(item: RelayItem): string {
    const contract = path.join(item.worktree, CONTRACT_PATH);
    switch (item.kind) {
      case "ask":
      case "question": {
        const lines = [
          `[project] Question de /${item.phase} — feature ${item.slug}`,
          `Élément : ${item.key}`,
          item.question ?? "(question sans texte)",
        ];
        if (item.options.length > 0) {
          lines.push("Options :");
          item.options.forEach((option, index) => {
            lines.push(`- (${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`);
          });
        }
        lines.push(
          `Contrat de la feature : ${contract}`,
          "Réponds toi-même avec project_reply (élément, réponse = libellé exact d'une option ou texte libre) si le cadrage, le plan et le contrat te donnent la réponse ; sinon project_escalate (élément).",
        );
        return lines.join("\n");
      }
      case "specs":
        return [
          `[project] Jalon « specs validées » — feature ${item.slug}`,
          `Élément : ${item.key}`,
          `À examiner : ${contract}, sections ## Spécifications et ## Lots.`,
          "Valide avec project_approve (élément) si elles servent l'intention de la feature dans le plan ; en cas de doute, project_escalate (élément).",
        ].join("\n");
      case "review":
        return [
          `[project] Jalon « revue propre » — feature ${item.slug}`,
          `Élément : ${item.key}`,
          `À examiner : ${contract}, section ## Revue.`,
          "Accepte avec project_approve (élément) — la livraison ouvrira la PR ; en cas de doute, project_escalate (élément).",
        ].join("\n");
      // Le plafond n'est pas un élément de ce relais (il devient un échec) : il
      // partage le message d'un échec s'il en devenait un.
      case "cap":
      case "failure": {
        const project = state.repoRoot === null ? null : projectOf(state.repoRoot);
        const found = project === null ? null : segmentOf(project, item.slug);
        const where = found === null ? "" : ` (segment ${found.index + 1} « ${found.segment.name} »)`;
        return [
          `[project] Échec — feature ${item.slug}${where}`,
          `Élément : ${item.key}`,
          item.stopReason ?? "",
          "Aucun segment suivant ne démarre avant la décision de l'utilisateur : appelle project_escalate (élément), sans trancher.",
        ].join("\n");
      }
    }
  }

  /** L'escalade d'un échec (S-8 §2) : relancer, retirer ou arrêter — la décision de l'utilisateur. */
  async function escalateFailure(
    ctx: ExtensionContext,
    item: RelayItem,
    signal: AbortSignal | undefined,
  ): Promise<RelayEscalation> {
    const repoRoot = state.repoRoot as string;
    const project = projectOf(repoRoot);
    const found = project === null ? null : segmentOf(project, item.slug);
    const k = (found?.index ?? project?.current ?? 0) + 1;
    const name = found?.segment.name ?? "";
    const answer = await ctx.ui.select(
      `Échec de la feature ${item.slug} (segment ${k} « ${name} ») : ${item.stopReason ?? ""}\nAucun segment suivant ne démarre avant ta décision.`,
      [FAILURE_RELAUNCH, FAILURE_REMOVE, FAILURE_STOP],
      { signal },
    );
    const driver = driverFor(repoRoot);
    switch (answer) {
      case FAILURE_RELAUNCH:
        return {
          answer,
          act: () => driver.relaunch(item.slug),
          done: `Feature ${item.slug} relancée à la demande de l'utilisateur.`,
        };
      case FAILURE_REMOVE:
        return {
          answer,
          act: () => driver.remove(item.slug),
          done: `Feature ${item.slug} retirée du plan à la demande de l'utilisateur — le segment ${k} peut s'achever sans elle.`,
        };
      case FAILURE_STOP:
        return {
          answer,
          act: () => driver.stop(),
          done: "Projet arrêté à la demande de l'utilisateur : aucune pipeline ne sera plus lancée. Les pipelines en cours continuent sous /pipelines ; relance /project pour reprendre le projet.",
        };
      default:
        return { answer: undefined };
    }
  }

  /**
   * La disponibilité des slugs, dans l'ordre (S-3) : une feature de même slug dans
   * le lot du dépôt, ou une branche `feat/<slug>` déjà prise, est la première
   * indisponibilité rendue.
   */
  async function planAvailability(repoRoot: string, slugs: readonly string[]): Promise<string | null> {
    const lot = readLot(deps.stateDir(), lotRepoKey(repoRoot));
    for (const slug of slugs) {
      if (lot !== null && lotFeature(lot, slug) !== undefined) {
        return `Error: « ${slug} » est déjà dans le lot — renomme la feature`;
      }
      if (await branchTaken(deps.runGit, repoRoot, branchFor(slug))) {
        return `Error: la branche feat/${slug} existe déjà — renomme la feature « ${slug} »`;
      }
    }
    return null;
  }

  /**
   * Un amendement admissible (S-9) : aucun slug d'un segment déjà démarré (retirées
   * comprises), et les slugs NOUVEAUX disponibles.
   */
  async function amendAvailability(
    repoRoot: string,
    project: Project,
    segments: readonly PlanSegment[],
  ): Promise<string | null> {
    const started = new Set(slugsOf(project.segments.slice(0, project.current + 1)));
    const upcoming = new Set(slugsOf(project.segments.slice(project.current + 1)));
    const slugs = slugsOf(segments);
    const taken = slugs.find((slug) => started.has(slug));
    if (taken !== undefined) return `Error: « ${taken} » appartient à un segment déjà démarré — choisis un autre nom`;
    return planAvailability(
      repoRoot,
      slugs.filter((slug) => !upcoming.has(slug)),
    );
  }

  /**
   * L'éditeur du plan (S-3 §2) : le texte corrigé relu, rouvert avec l'erreur en
   * tête de titre tant qu'il est illisible ou indisponible. `null` : retour à la
   * revue, plan inchangé (texte vide, Échap, signal).
   */
  async function editPlan(
    ctx: ExtensionContext,
    prefill: string,
    purpose: string,
    fn: string,
    signal: AbortSignal | undefined,
    check: (plan: PlanDraft) => Promise<string | null>,
  ): Promise<PlanDraft | null> {
    let title = EDIT_TITLE;
    let text = prefill;
    for (;;) {
      const typed = await ctx.ui.editor(title, text, { signal });
      if (signal?.aborted === true || typed === undefined || typed.trim() === "") return null;
      const parsed = parsePlanText(typed, purpose, fn);
      if (!parsed.ok) {
        title = `Plan illisible — ${parsed.error}\n${EDIT_TITLE}`;
        text = typed;
        continue;
      }
      const refusal = await check(parsed.plan);
      if (refusal !== null) {
        title = `Plan refusé — ${refusal.replace(/^Error: /, "")}\n${EDIT_TITLE}`;
        text = typed;
        continue;
      }
      return parsed.plan;
    }
  }

  /**
   * Les modèles des features (S-2) : DEUX questions par feature quand des modèles
   * sont connus — req+specs puis impl+review, dans cet ordre. Rend les choix, ou le
   * slug de la première question abandonnée.
   */
  async function chooseModels(
    ctx: ExtensionContext,
    slugs: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<{ models: Map<string, ModelSlots> } | { missing: string }> {
    const options = modelDialogOptions(ctx.models?.list?.() ?? []);
    const models = new Map<string, ModelSlots>();
    if (options.length === 0) return { models };
    for (const slug of slugs) {
      const reqChoice = modelDialogChoice(
        await ctx.ui.select(modelQuestionTitle(slug, "modelReqSpecs"), options, { signal }),
      );
      const implChoice =
        reqChoice === null
          ? null
          : modelDialogChoice(
              await ctx.ui.select(modelQuestionTitle(slug, "modelImplReview"), options, { signal }),
            );
      if (reqChoice === null || implChoice === null) return { missing: slug };
      models.set(slug, { reqSpecs: reqChoice.model, implReview: implChoice.model });
    }
    return { models };
  }

  /** `project_plan` à son tour de dialogue (S-3) : complétude, revue, correction, modèles, écriture, lancement. */
  async function validatePlan(
    core: RelayCore,
    ctx: ExtensionContext,
    repoRoot: string,
    sessionFile: string,
    proposed: PlanDraft,
    signal: AbortSignal | undefined,
  ): Promise<RelayToolResult> {
    // Un tour interrompu referme le dialogue ouvert, qui rend `undefined` comme un
    // Échap : seul le signal les distingue.
    const interrupted = (): boolean => signal?.aborted === true;
    if (projectState.cadrage?.fin !== true) {
      const answer = await ctx.ui.select(
        "Le cadrage du projet est-il complet ?",
        [COMPLETE, "Il reste des choses à ajouter.", "Un besoin a changé."],
        { signal },
      );
      if (interrupted()) return toolText(PLAN_INTERRUPTED);
      if (answer !== COMPLETE) {
        return toolText(
          `Cadrage non clos (« ${answer ?? "sans réponse"} ») : continue le cadrage avec l'utilisateur, puis rappelle project_plan.`,
        );
      }
      if (projectState.cadrage !== null) projectState.cadrage.fin = true;
    }
    let plan = proposed;
    for (;;) {
      const verdict = await ctx.ui.select(planDialogTitle(plan), [PLAN_VALIDATE, PLAN_FIX, PLAN_ABANDON], { signal });
      if (interrupted()) return toolText(PLAN_INTERRUPTED);
      if (verdict === PLAN_VALIDATE) break;
      if (verdict !== PLAN_FIX) {
        return toolText(
          "Plan non validé : l'utilisateur a abandonné — rien n'est écrit ni lancé. Reprends le cadrage selon ce qu'il dit, puis rappelle project_plan.",
        );
      }
      const corrected = await editPlan(ctx, renderPlanText(plan.segments), plan.purpose, plan.function, signal, (draft) =>
        planAvailability(repoRoot, slugsOf(draft.segments)),
      );
      if (interrupted()) return toolText(PLAN_INTERRUPTED);
      if (corrected !== null) plan = corrected;
    }
    const chosen = await chooseModels(ctx, slugsOf(plan.segments), signal);
    if (interrupted()) return toolText(PLAN_INTERRUPTED);
    if ("missing" in chosen) {
      return toolText(
        `Plan non validé : modèle non choisi pour « ${chosen.missing} » — rien n'est écrit ni lancé. Rappelle project_plan pour reprendre la validation.`,
      );
    }

    // L'écriture (S-4) : relue, sans `await` entre la lecture et l'écriture.
    if (projectOf(repoRoot)?.status === "running") return toolText(PLAN_RUNNING, true);
    const project = newProject(plan, chosen.models, { stateDir: deps.stateDir(), repoRoot, hostSession: sessionFile, now: now() });
    writeProject(deps.stateDir(), project);
    // Le cadrage est clos : le relais reste armé sur la MÊME session, dont la clé
    // passe de `null` à `relayKey`. La première passe lance le segment 1 ; le
    // balayage qui la suit écrit le battement sur le lot qu'elle a créé, avant la
    // première question ou le premier jalon de ses pipelines.
    projectState.cadrage = null;
    const driver = driverFor(repoRoot);
    driver.syncDoc(["plan validé"]);
    await driver.tick();
    core.scan();

    const after = projectOf(repoRoot) ?? project;
    const first = after.segments[0] as ProjectSegment;
    const waiting = driver.waiting();
    const launchLines =
      waiting !== null && first.features.every((feature) => feature.status === "planned")
        ? [`Segment 1 « ${first.name} » en attente : ${waiting} — nouvel essai toutes les 60 s.`]
        : [
            `Segment 1 « ${first.name} » : ${first.features.filter((f) => f.status !== "planned" && f.status !== "failed").length}/${first.features.length} pipeline(s) lancée(s).`,
            ...first.features.map((feature) =>
              feature.status === "failed" || feature.status === "planned"
                ? `- ${feature.slug} : non lancée — ${feature.failure?.reason ?? "en attente"}`
                : `- ${feature.slug} : lancée (branche feat/${feature.slug})`,
            ),
          ];
    const total = slugsOf(after.segments).length;
    return toolText(
      [
        `Plan validé : ${after.segments.length} segment(s), ${total} feature(s) — document ${PROJECT_DOC_FILE} sur la branche ${PROJECT_DOC_BRANCH}.`,
        ...launchLines,
        "Les questions, jalons et échecs des pipelines te seront relayés par des messages [project].",
      ].join("\n"),
    );
  }

  /** `project_amend` à son tour de dialogue (S-9) : appliquer, corriger ou rejeter — rien sans validation. */
  async function amend(
    ctx: ExtensionContext,
    repoRoot: string,
    proposed: PlanSegment[],
    purpose: string | null,
    fn: string | null,
    signal: AbortSignal | undefined,
  ): Promise<RelayToolResult> {
    projectState.amending = true;
    try {
      const interrupted = (): boolean => signal?.aborted === true;
      const project = projectOf(repoRoot);
      if (project === null || project.status !== "running") return toolText(NO_PROJECT, true);
      const index = project.current;
      const before = project.segments.slice(index + 1);
      const render = (segments: readonly PlanSegment[]) =>
        segments.length === 0 ? "(aucun segment à venir)" : renderPlanText(segments);
      let after = proposed;
      for (;;) {
        const title =
          `Modification du plan — segments après le segment ${index + 1} « ${(project.segments[index] as ProjectSegment).name} »\n` +
          `Avant :\n${render(before)}\nAprès :\n${render(after)}` +
          (purpose !== null && purpose !== project.purpose ? `\nBut : ${purpose}` : "") +
          (fn !== null && fn !== project.function ? `\nFonction : ${fn}` : "");
        const answer = await ctx.ui.select(title, [AMEND_APPLY, AMEND_FIX, AMEND_REJECT], { signal });
        if (interrupted()) return toolText(AMEND_INTERRUPTED);
        if (answer === AMEND_APPLY) break;
        if (answer !== AMEND_FIX) {
          return toolText("Modification non appliquée : l'utilisateur l'a rejetée — le plan est inchangé.");
        }
        const corrected = await editPlan(
          ctx,
          renderPlanText(after),
          purpose ?? project.purpose,
          fn ?? project.function,
          signal,
          (draft) => amendAvailability(repoRoot, project, draft.segments),
        );
        if (interrupted()) return toolText(AMEND_INTERRUPTED);
        if (corrected !== null) after = corrected.segments;
      }
      const upcoming = new Set(slugsOf(before));
      const chosen = await chooseModels(
        ctx,
        slugsOf(after).filter((slug) => !upcoming.has(slug)),
        signal,
      );
      if (interrupted()) return toolText(AMEND_INTERRUPTED);
      if ("missing" in chosen) {
        return toolText(`Modification non appliquée : modèle non choisi pour « ${chosen.missing} » — le plan est inchangé.`);
      }

      // L'écriture : relue, sans `await` entre la lecture et l'écriture. Le segment
      // courant et les précédents ne changent jamais par cet outil.
      const fresh = projectOf(repoRoot);
      if (fresh === null || fresh.status !== "running" || fresh.current !== index) return toolText(NO_PROJECT, true);
      const at = now();
      const kept = new Map(fresh.segments.slice(index + 1).flatMap((segment) => segment.features).map((f) => [f.slug, f]));
      fresh.segments = [
        ...fresh.segments.slice(0, index + 1),
        ...after.map((segment) => ({
          name: segment.name,
          features: segment.features.map((feature) => {
            const known = kept.get(feature.slug);
            return known === undefined
              ? newProjectFeature(feature, chosen.models.get(feature.slug) ?? null, at)
              : { ...known, intention: feature.intention, updatedAt: at };
          }),
        })),
      ];
      if (purpose !== null) fresh.purpose = purpose;
      if (fn !== null) fresh.function = fn;
      fresh.updatedAt = at;
      writeProject(deps.stateDir(), fresh);
      driverFor(repoRoot).syncDoc(["plan modifié"]);
      return toolText(`Plan modifié : ${after.length} segment(s) à venir, ${slugsOf(after).length} feature(s) à venir.`);
    } finally {
      projectState.amending = false;
    }
  }

  /** Les outils propres au profil /project, inscrits au premier armement (S-6 §5). */
  function registerPlanTools(core: RelayCore): void {
    const feature = pi.arktype({ name: "string", intention: "string" });
    const segment = pi.arktype({ name: "string", features: feature.array() });

    pi.registerTool({
      name: "project_plan",
      label: "Projet — plan",
      description:
        "Soumet le plan du projet — but (purpose), fonction (function) et segments ordonnés de features, chacune nommée avec son intention : l'outil fait confirmer la clôture du cadrage si l'utilisateur n'a pas dit « fin », montre le plan, le fait corriger puis valider, fait choisir le modèle de chaque feature, écrit le document PROJECT.md (branche omp-project) et lance le premier segment. Refusé une fois le plan validé : project_amend le modifie.",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ purpose: "string", function: "string", segments: segment.array() }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const checked = checkPlan(params);
        if (!checked.ok) return toolText(checked.error, true);
        if (!core.armedOn(ctx) || ctx === undefined) return toolText(core.notArmed, true);
        if (!ctx.hasUI) return toolText(core.needsUi, true);
        const repoRoot = state.repoRoot as string;
        const sessionFile = state.sessionFile as string;
        if (projectOf(repoRoot)?.status === "running") return toolText(PLAN_RUNNING, true);
        const unavailable = await planAvailability(repoRoot, slugsOf(checked.plan.segments));
        if (unavailable !== null) return toolText(unavailable, true);
        return core.inDialogTurn(
          signal,
          () => validatePlan(core, ctx, repoRoot, sessionFile, checked.plan, signal),
          () => toolText(PLAN_INTERRUPTED),
        );
      },
    });

    pi.registerTool({
      name: "project_amend",
      label: "Projet — modifier le plan",
      description:
        "Propose une modification du plan : la NOUVELLE liste complète des segments pas encore démarrés (vide : le projet s'achèvera avec le segment courant), et au besoin un nouveau but ou une nouvelle fonction. L'utilisateur l'applique, la corrige ou la rejette : rien n'est appliqué sans sa validation.",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ "purpose?": "string", "function?": "string", segments: segment.array() }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        if (!core.armedOn(ctx) || ctx === undefined) return toolText(core.notArmed, true);
        if (!ctx.hasUI) return toolText(core.needsUi, true);
        const repoRoot = state.repoRoot as string;
        const project = projectOf(repoRoot);
        if (project === null || project.status === "done") return toolText(NO_PROJECT, true);
        const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const checked = checkSegments(record.segments, 0);
        if (!checked.ok) return toolText(checked.error, true);
        const unavailable = await amendAvailability(repoRoot, project, checked.segments);
        if (unavailable !== null) return toolText(unavailable, true);
        const text = (value: unknown) =>
          typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, LOT_EDITOR_MAX) : null;
        return core.inDialogTurn(
          signal,
          () => amend(ctx, repoRoot, checked.segments, text(record.purpose), text(record.function), signal),
          () => toolText(AMEND_INTERRUPTED),
        );
      },
    });
  }

  const relay = createRelay(
    {
      name: "project",
      state,
      armed: armedFor,
      stillArmed: () => state.sessionFile !== null && state.repoRoot !== null && armedFor(state.sessionFile, state.repoRoot),
      keyOf: () => (state.repoRoot === null ? null : (projectOf(state.repoRoot)?.relayKey ?? null)),
      cap: false,
      extraItems: (lot) => {
        const project = state.repoRoot === null ? null : projectOf(state.repoRoot);
        return project !== null && project.status === "running" ? projectFailureItems(project, lot) : [];
      },
      message,
      tools: {
        reply: {
          label: "Projet — répondre",
          description:
            "Répond à la place de l'utilisateur à une question relayée par un message [project] (élément = son identifiant ; réponse = libellé exact d'une option ou texte libre), seulement quand le cadrage, le plan et le contrat de la feature donnent la réponse.",
        },
        approve: {
          label: "Projet — valider",
          description:
            "Valide un jalon relayé par un message [project] : « specs validées » (reprend sur /impl) ou « revue propre » (livre et ouvre la PR).",
        },
        escalate: {
          label: "Projet — demander à l'utilisateur",
          description:
            "Remonte à l'utilisateur, dans cette session, un élément relayé que /project ne tranche pas : la question d'origine et ses options, un jalon en doute, ou l'échec d'une feature (relancer, retirer ou arrêter le projet). La réponse de l'utilisateur est transmise mot pour mot.",
        },
      },
      escalate: escalateFailure,
      registerTools: registerPlanTools,
      // Le pilote du projet tourne à chaque balayage (S-7) ; ses passes sont
      // sérialisées, et une passe qui échoue n'arrête pas le relais.
      onScan: () => {
        if (state.repoRoot !== null) void driverFor(state.repoRoot).tick().catch(() => undefined);
      },
      // Une session armée à nouveau sonde tout de suite, réessaie tout de suite, et
      // redit ce qui ne va pas.
      onArm: () => {
        projectState.warned.clear();
        projectState.lastPollAt = null;
        projectState.lastLaunchAttemptAt = null;
      },
    },
    deps,
  );

  /** Une session neuve pour le cadrage ou la reprise ; sinon la session courante, avec sa notice (S-2 §1). */
  async function openSession(ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle?.();
    let failure: string | null = null;
    if (typeof ctx.newSession === "function") {
      try {
        await ctx.newSession();
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    } else {
      failure = "nouvelle session indisponible";
    }
    if (failure !== null) deps.notify(`[project] nouvelle session impossible (${failure}) — projet dans la session courante.`);
  }

  /** Le cadrage neuf (S-2 §1). */
  async function openCadrage(ctx: ExtensionCommandContext, repoRoot: string, extra: string): Promise<void> {
    await openSession(ctx);
    const sessionFile = sessionFileOf(ctx as PipelineCtx);
    if (sessionFile !== null) {
      projectState.cadrage = { sessionFile, fin: false };
      relay.sync(ctx);
    }
    pi.sendUserMessage(buildProjectSeed(repoRoot, extra));
  }

  /** La reprise d'un projet en cours (S-4) : session neuve, hôte réécrit, relais armé, document en amorce. */
  async function resume(ctx: ExtensionCommandContext, repoRoot: string, extra: string): Promise<void> {
    await openSession(ctx);
    const sessionFile = sessionFileOf(ctx as PipelineCtx);
    const stateDir = deps.stateDir();
    const project = projectOf(repoRoot);
    if (project === null) return;
    if (sessionFile !== null) {
      project.hostSession = sessionFile;
      project.updatedAt = now();
      writeProject(stateDir, project);
    }
    relay.sync(ctx);
    pi.sendUserMessage(
      buildProjectResumeSeed(repoRoot, extra, renderProjectDoc(project, path.basename(project.repoRoot))),
    );
  }

  async function runProjectCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const refuse = (text: string) => ctx.ui?.notify?.(text, "warning");
    if (!ctx.hasUI) {
      refuse("[project] indisponible hors session interactive");
      return;
    }
    const root = resolveFeatureRoot(ctx.cwd);
    if (root.primary) {
      refuse(
        `[project] déjà dans le worktree d'une feature (${root.dir}) — /project s'ouvre depuis le dépôt principal (${root.primary})`,
      );
      return;
    }
    if (!fs.existsSync(path.join(root.dir, ".git"))) {
      refuse(
        `[project] ${root.dir} n'est pas un dépôt git — crée-le (git init) et son dépôt distant GitHub, puis relance /project. Rien n'a été créé.`,
      );
      return;
    }
    const remotes = await deps.runGit(["remote", "-v"], root.dir);
    if (remotes.code !== 0 || githubRemoteOf(remotes.stdout) === null) {
      refuse(
        `[project] ${root.dir} n'a aucun dépôt distant GitHub (git remote -v) — ajoute-le (git remote add origin <URL du dépôt GitHub>), puis relance /project. Rien n'a été créé.`,
      );
      return;
    }
    const repoRoot = root.dir;
    const repo = path.basename(repoRoot);
    const extra = args.trim();
    const stateDir = deps.stateDir();
    const project = projectOf(repoRoot);
    if (project === null) {
      await openCadrage(ctx, repoRoot, extra);
      return;
    }
    if (project.status === "running") {
      if (state.sessionFile !== null && state.sessionFile === sessionFileOf(ctx as PipelineCtx)) {
        refuse(`[project] cette session conduit déjà le projet de ${repo} — avancement dans PROJECT.md (branche omp-project) et /pipelines.`);
        return;
      }
      const beat = readAuditRelay(stateDir, project.relayKey);
      if (beat !== null && beat.pid !== process.pid && pidAlive(beat.pid) && now() - beat.heartbeatAt <= AUDIT_RELAY_STALE_MS) {
        refuse(conduiteBusyRefusal(repo, beat.pid));
        return;
      }
      await resume(ctx, repoRoot, extra);
      return;
    }
    const segment = project.segments[project.current] as ProjectSegment;
    if (project.status === "stopped") {
      const choice = await ctx.ui.select(
        `Le projet de ${repo} est arrêté (segment ${project.current + 1}/${project.segments.length} « ${segment.name} »).`,
        [RESUME, RESTART_STOPPED, CANCEL],
      );
      if (choice === RESUME) {
        const fresh = projectOf(repoRoot);
        if (fresh === null || fresh.status !== "stopped") return;
        fresh.status = "running";
        fresh.updatedAt = now();
        writeProject(stateDir, fresh);
        driverFor(repoRoot).syncDoc(["projet repris"]);
        await resume(ctx, repoRoot, extra);
      } else if (choice === RESTART_STOPPED) {
        deleteProject(stateDir, project.repoKey);
        await openCadrage(ctx, repoRoot, extra);
      }
      return;
    }
    const merged = project.segments.flatMap((s) => s.features).filter((f) => f.status === "merged").length;
    const choice = await ctx.ui.select(
      `Le projet de ${repo} est terminé (${project.segments.length} segment(s), ${merged} feature(s) fusionnée(s)).`,
      [RESTART_DONE, CANCEL],
    );
    if (choice === RESTART_DONE) {
      deleteProject(stateDir, project.repoKey);
      await openCadrage(ctx, repoRoot, extra);
    }
  }

  function onProjectPrompt(prompt: string, ctx: ExtensionContext): void {
    const cadrage = projectState.cadrage;
    if (cadrage === null || sessionFileOf(ctx as PipelineCtx) !== cadrage.sessionFile) return;
    const text = prompt.trim();
    if (NOTICE_PREFIXES.some((prefix) => text.startsWith(prefix))) return;
    if (saysFin(text)) cadrage.fin = true;
  }

  return {
    ...relay,
    tick() {
      if (state.sessionFile === null || state.repoRoot === null) return Promise.resolve();
      return driverFor(state.repoRoot).tick();
    },
    runProjectCommand,
    onProjectPrompt,
  };
}
