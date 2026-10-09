// Le projet /project : modèle, magasin, fonctions pures (plan, document, avancement).
import * as fs from "node:fs";
import * as path from "node:path";
import { isReviewCapReason } from "./chain.ts";
import { realpathOr, toSlug } from "./git.ts";
import { LOT_EDITOR_MAX, isLotBaseSha, lotFeature, lotRepoKey } from "./lot.ts";
import type { Lot } from "./lot.ts";
import { fallbackSlotsField, modelSlotsField } from "./models.ts";
import type { ModelSlots } from "./models.ts";
import type { RelayItem } from "./relay.ts";
import { readJsonFile, writeJsonAtomic } from "./store.ts";



// ---------------------------------------------------------------------------
// Le projet — un plan de segments ordonnés, conduit segment par segment.
// ---------------------------------------------------------------------------
// /project cerne le projet d'un dépôt (but, fonction), fait valider un plan de
// SEGMENTS ordonnés — chaque segment regroupe des features qui se construisent en
// même temps — puis lance chaque segment en pipelines de lot parallèles jusqu'aux
// PR. Le segment suivant ne part que quand toutes les PR du précédent sont
// fusionnées par l'utilisateur. L'état vit dans UN fichier par dépôt
// (`<stateDir>/projects/<repoKey>.json`), écrit par un seul process (celui dont la
// session /project est armée) ; le document lisible, lui, vit sur une branche
// orpheline du dépôt (`omp-project`, fichier `PROJECT.md`).

export type ProjectFeatureStatus = "planned" | "launched" | "pr" | "merged" | "failed" | "removed";

export type ProjectFailureKind = "lot" | "launch" | "pr";

/** L'échec d'une feature : sa cause (lot, lancement, PR), son motif, son instant (discriminant de l'élément relayé). */
export type ProjectFailure = { kind: ProjectFailureKind; reason: string; at: number };

export type ProjectFeature = {
  slug: string;
  intention: string;
  /**
   * Les deux modèles de la feature (S-2), un par groupe de phase ; absents = défaut
   * OMP. Écrits à la création de la feature seulement, transportés tels quels vers
   * le lot par `addToLot`.
   */
  modelReqSpecs?: string;
  modelImplReview?: string;
  /**
   * Les deux replis de la feature (S-1), un par groupe de phase ; absents = aucun
   * repli. Même règle d'écriture que les modèles : jamais `""` ni `null` stockés.
   */
  fallbackReqSpecs?: string | null;
  fallbackImplReview?: string | null;
  status: ProjectFeatureStatus;
  prUrl: string | null;
  /** Non nul ssi `status === "failed"`. */
  failure: ProjectFailure | null;
  /** Non nul ssi `status === "removed"`. */
  removedReason: string | null;
  updatedAt: number;
};

export type ProjectSegment = { name: string; features: ProjectFeature[] };

export type Project = {
  version: 1;
  repoKey: string;
  /** realpath du dépôt principal. */
  repoRoot: string;
  /** `path.join(path.resolve(stateDir), "projects", `${repoKey}@${createdAt}`)` — une CLÉ, pas un fichier ; immuable. */
  relayKey: string;
  purpose: string;
  function: string;
  status: "running" | "stopped" | "done";
  /** Au moins un segment. */
  segments: ProjectSegment[];
  /** Index 0-based du segment courant. */
  current: number;
  /** La base récupérée pour le segment courant. */
  base: { segment: number; sha: string } | null;
  /** Le fichier de la session /project qui conduit le projet. */
  hostSession: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Un plan validé par `checkPlan` : textes trimés et bornés, slugs normalisés et uniques. */
export type PlanDraft = {
  purpose: string;
  function: string;
  segments: PlanSegment[];
};

export type PlanSegment = { name: string; features: { slug: string; intention: string }[] };


export const PROJECT_VERSION = 1;

/** La branche orpheline du document du projet (S-5). */
export const PROJECT_DOC_BRANCH = "omp-project";

/** Le seul fichier de la branche du document (S-5). */
export const PROJECT_DOC_FILE = "PROJECT.md";

/** Le sondage des fusions : au plus une fois par minute (S-7). */
export const PROJECT_POLL_MS = 60_000;

/** Bornes du plan (S-3). */
const SEGMENTS_MAX = 20;
const FEATURES_MAX = 8;
const SEGMENT_NAME_MAX = 80;

const FEATURE_STATUSES: Record<ProjectFeatureStatus, true> = {
  planned: true,
  launched: true,
  pr: true,
  merged: true,
  failed: true,
  removed: true,
};

const FAILURE_KINDS: Record<ProjectFailureKind, true> = { lot: true, launch: true, pr: true };

const PROJECT_STATUSES: Record<Project["status"], true> = { running: true, stopped: true, done: true };


// --- le magasin (S-4) --------------------------------------------------------

/** `<stateDir>/projects/<repoKey>.json` : un projet par dépôt. */
export function projectPathFor(stateDir: string, repoKey: string): string {
  return path.join(stateDir, "projects", `${repoKey}.json`);
}


/** `<stateDir>/projects/<repoKey>.doc` : le worktree privé du document (hors des worktrees balayés). */
export function projectDocWorktreePath(stateDir: string, repoKey: string): string {
  return path.join(stateDir, "projects", `${repoKey}.doc`);
}


function asProjectFeature(raw: unknown): ProjectFeature | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.slug !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(f.slug)) return null;
  if (typeof f.intention !== "string") return null;
  if (typeof f.status !== "string" || FEATURE_STATUSES[f.status as ProjectFeatureStatus] !== true) return null;
  const status = f.status as ProjectFeatureStatus;
  if (f.prUrl !== null && typeof f.prUrl !== "string") return null;
  let failure: ProjectFailure | null = null;
  if (f.failure !== null) {
    const r = f.failure;
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    const { kind, reason, at } = r as Record<string, unknown>;
    if (typeof kind !== "string" || FAILURE_KINDS[kind as ProjectFailureKind] !== true) return null;
    if (typeof reason !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
    failure = { kind: kind as ProjectFailureKind, reason, at };
  }
  if (f.removedReason !== null && typeof f.removedReason !== "string") return null;
  // Les invariants du modèle : un échec sans motif, ou un motif sans échec, est un
  // fichier que personne n'a écrit — il se lit comme absent.
  if ((status === "failed") !== (failure !== null)) return null;
  if ((status === "removed") !== (f.removedReason !== null)) return null;
  if (typeof f.updatedAt !== "number" || !Number.isFinite(f.updatedAt)) return null;
  return {
    slug: f.slug,
    intention: f.intention,
    ...(typeof f.modelReqSpecs === "string" && f.modelReqSpecs.trim() !== "" ? { modelReqSpecs: f.modelReqSpecs } : {}),
    ...(typeof f.modelImplReview === "string" && f.modelImplReview.trim() !== ""
      ? { modelImplReview: f.modelImplReview }
      : {}),
    ...(typeof f.fallbackReqSpecs === "string" && f.fallbackReqSpecs.trim() !== ""
      ? { fallbackReqSpecs: f.fallbackReqSpecs }
      : {}),
    ...(typeof f.fallbackImplReview === "string" && f.fallbackImplReview.trim() !== ""
      ? { fallbackImplReview: f.fallbackImplReview }
      : {}),
    status,
    prUrl: f.prUrl as string | null,
    failure,
    removedReason: f.removedReason as string | null,
    updatedAt: f.updatedAt,
  };
}


/**
 * Le projet relu, TOLÉRANT (S-4) : absent, illisible, d'une autre version ou avec
 * un champ obligatoire invalide ⇒ `null` — un cadrage neuf plutôt qu'un projet
 * que personne n'a écrit.
 */
export function asProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.version !== PROJECT_VERSION) return null;
  if (typeof p.repoKey !== "string" || p.repoKey === "") return null;
  if (typeof p.repoRoot !== "string" || p.repoRoot === "") return null;
  if (typeof p.relayKey !== "string" || !path.isAbsolute(p.relayKey)) return null;
  if (typeof p.purpose !== "string" || typeof p.function !== "string") return null;
  if (typeof p.status !== "string" || PROJECT_STATUSES[p.status as Project["status"]] !== true) return null;
  if (!Array.isArray(p.segments) || p.segments.length === 0) return null;
  const segments: ProjectSegment[] = [];
  for (const rawSegment of p.segments) {
    if (!rawSegment || typeof rawSegment !== "object") return null;
    const s = rawSegment as Record<string, unknown>;
    if (typeof s.name !== "string" || !Array.isArray(s.features)) return null;
    const features: ProjectFeature[] = [];
    for (const rawFeature of s.features) {
      const feature = asProjectFeature(rawFeature);
      if (feature === null) return null;
      features.push(feature);
    }
    segments.push({ name: s.name, features });
  }
  if (typeof p.current !== "number" || !Number.isInteger(p.current) || p.current < 0 || p.current >= segments.length) {
    return null;
  }
  let base: Project["base"] = null;
  if (p.base !== null) {
    const b = p.base;
    if (!b || typeof b !== "object") return null;
    const { segment, sha } = b as Record<string, unknown>;
    if (typeof segment !== "number" || !Number.isInteger(segment) || !isLotBaseSha(sha)) return null;
    base = { segment, sha };
  }
  if (p.hostSession !== null && typeof p.hostSession !== "string") return null;
  if (typeof p.createdAt !== "number" || typeof p.updatedAt !== "number") return null;
  return {
    version: PROJECT_VERSION,
    repoKey: p.repoKey,
    repoRoot: p.repoRoot,
    relayKey: p.relayKey,
    purpose: p.purpose,
    function: p.function,
    status: p.status as Project["status"],
    segments,
    current: p.current,
    base,
    hostSession: p.hostSession as string | null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}


/** Le projet du dépôt, ou `null`. */
export function readProject(stateDir: string, repoKey: string): Project | null {
  return asProject(readJsonFile(projectPathFor(stateDir, repoKey)));
}


/** Écriture atomique : l'appelant a relu le fichier SANS `await` depuis (un seul écrivain, S-4). */
export function writeProject(stateDir: string, project: Project): void {
  writeJsonAtomic(projectPathFor(stateDir, project.repoKey), { ...project, version: PROJECT_VERSION });
}


/** « Nouveau projet » (S-1) : le fichier du projet est retiré ; un fichier absent n'est pas une erreur. */
export function deleteProject(stateDir: string, repoKey: string): void {
  fs.rmSync(projectPathFor(stateDir, repoKey), { force: true });
}


/** Une feature neuve du plan, `planned`, avec ses deux modèles (S-2) — écrits une seule fois, ici. */
export function newProjectFeature(
  feature: { slug: string; intention: string },
  models: ModelSlots | null,
  now: number,
  fallbacks: ModelSlots | null = null,
): ProjectFeature {
  return {
    slug: feature.slug,
    intention: feature.intention,
    ...modelSlotsField(models === null ? {} : { modelReqSpecs: models.reqSpecs, modelImplReview: models.implReview }),
    ...fallbackSlotsField(
      fallbacks === null ? {} : { fallbackReqSpecs: fallbacks.reqSpecs, fallbackImplReview: fallbacks.implReview },
    ),
    status: "planned",
    prUrl: null,
    failure: null,
    removedReason: null,
    updatedAt: now,
  };
}


/** Le projet né d'un plan validé (S-3 §5) : en cours, au premier segment, sans base encore. */
export function newProject(
  plan: PlanDraft,
  models: ReadonlyMap<string, ModelSlots>,
  input: { stateDir: string; repoRoot: string; hostSession: string | null; now: number },
  fallbacks: ReadonlyMap<string, ModelSlots> = new Map(),
): Project {
  const repoRoot = realpathOr(input.repoRoot);
  const repoKey = lotRepoKey(repoRoot);
  return {
    version: PROJECT_VERSION,
    repoKey,
    repoRoot,
    relayKey: path.join(path.resolve(input.stateDir), "projects", `${repoKey}@${input.now}`),
    purpose: plan.purpose,
    function: plan.function,
    status: "running",
    segments: plan.segments.map((segment) => ({
      name: segment.name,
      features: segment.features.map((feature) => newProjectFeature(feature, models.get(feature.slug) ?? null, input.now, fallbacks.get(feature.slug) ?? null)),
    })),
    current: 0,
    base: null,
    hostSession: input.hostSession,
    createdAt: input.now,
    updatedAt: input.now,
  };
}


// --- le plan : validation, texte éditable (S-3) ------------------------------

/** « Sur une ligne » : retours à la ligne remplacés par une espace, blancs consécutifs réduits à une espace. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}


/**
 * Les segments d'un plan (S-3 §4), première erreur rendue, PURE : `min` vaut 1
 * pour un plan, 0 pour un amendement (S-9). Noms de segment trimés et coupés à 80
 * caractères, intentions trimées et coupées à `LOT_EDITOR_MAX`, slugs uniques.
 */
export function checkSegments(
  raw: unknown,
  min: 0 | 1,
): { ok: true; segments: PlanSegment[] } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!Array.isArray(raw) || raw.length < min || raw.length > SEGMENTS_MAX) {
    return fail(`Error: segments must list ${min} to ${SEGMENTS_MAX} items`);
  }
  const seen = new Set<string>();
  const segments: PlanSegment[] = [];
  for (const [index, rawSegment] of raw.entries()) {
    const i = index + 1;
    const s =
      rawSegment && typeof rawSegment === "object" && !Array.isArray(rawSegment)
        ? (rawSegment as Record<string, unknown>)
        : {};
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (name === "") return fail(`Error: segment ${i} has no name`);
    if (!Array.isArray(s.features) || s.features.length < 1 || s.features.length > FEATURES_MAX) {
      return fail(`Error: segment ${i} must list 1 to ${FEATURES_MAX} features`);
    }
    const features: PlanSegment["features"] = [];
    for (const [featureIndex, rawFeature] of s.features.entries()) {
      const f =
        rawFeature && typeof rawFeature === "object" && !Array.isArray(rawFeature)
          ? (rawFeature as Record<string, unknown>)
          : {};
      const slug = typeof f.name === "string" ? toSlug(f.name) : null;
      if (slug === null) return fail(`Error: feature ${i}.${featureIndex + 1} has an invalid name`);
      if (seen.has(slug)) return fail(`Error: duplicate feature « ${slug} »`);
      seen.add(slug);
      const intention = typeof f.intention === "string" ? f.intention.trim() : "";
      if (intention === "") return fail(`Error: feature « ${slug} » has no intention`);
      features.push({ slug, intention: intention.slice(0, LOT_EDITOR_MAX) });
    }
    segments.push({ name: name.slice(0, SEGMENT_NAME_MAX), features });
  }
  return { ok: true, segments };
}


/**
 * La validation d'un plan `project_plan` (S-3) : PURE, sans exception, première
 * erreur rendue, dans l'ordre du contrat.
 */
export function checkPlan(input: unknown): { ok: true; plan: PlanDraft } | { ok: false; error: string } {
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const purpose = typeof record.purpose === "string" ? record.purpose.trim() : "";
  if (purpose === "") return { ok: false, error: "Error: purpose is empty" };
  const fn = typeof record.function === "string" ? record.function.trim() : "";
  if (fn === "") return { ok: false, error: "Error: function is empty" };
  const checked = checkSegments(record.segments, 1);
  if (!checked.ok) return checked;
  return {
    ok: true,
    plan: { purpose: purpose.slice(0, LOT_EDITOR_MAX), function: fn.slice(0, LOT_EDITOR_MAX), segments: checked.segments },
  };
}


/**
 * Le texte éditable d'un plan (S-3) : un bloc par segment, séparés par une ligne
 * vide — `## <nom>` puis une ligne `- <slug> — <intention sur une ligne>` par
 * feature. `parsePlanText` le relit à l'identique.
 */
export function renderPlanText(segments: readonly PlanSegment[]): string {
  return segments
    .map((segment) =>
      [
        `## ${oneLine(segment.name)}`,
        ...segment.features.map((feature) => `- ${feature.slug} — ${oneLine(feature.intention)}`),
      ].join("\n"),
    )
    .join("\n\n");
}


/**
 * Le texte corrigé par l'utilisateur, relu en plan (S-3) : PURE. Une ligne vide
 * est ignorée, `## <nom>` ouvre un segment, `- <nom> — <intention>` (ou `--`, ou
 * `:`) ajoute une feature au segment courant ; le résultat passe par `checkPlan`.
 */
export function parsePlanText(
  text: string,
  purpose: string,
  fn: string,
): { ok: true; plan: PlanDraft } | { ok: false; error: string } {
  const segments: { name: string; features: { name: string; intention: string }[] }[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const n = index + 1;
    const line = raw.trim();
    if (line === "") continue;
    const segment = /^##\s+(.+)$/.exec(line);
    if (segment) {
      segments.push({ name: (segment[1] as string).trim(), features: [] });
      continue;
    }
    const feature = /^-\s+(\S+)\s+(?:—|--|:)\s+(\S.*)$/.exec(line);
    if (feature) {
      const current = segments.at(-1);
      if (current === undefined) {
        return { ok: false, error: `ligne ${n} : feature hors segment — commence par « ## <nom du segment> »` };
      }
      current.features.push({ name: feature[1] as string, intention: feature[2] as string });
      continue;
    }
    return {
      ok: false,
      error: `ligne ${n} illisible : « ${line.slice(0, 80)} » — attendu « ## <segment> » ou « - <nom> — <intention> »`,
    };
  }
  return checkPlan({ purpose, function: fn, segments });
}


/** Le titre de la revue du plan (S-3 §2). */
export function planDialogTitle(plan: PlanDraft): string {
  const features = plan.segments.reduce((count, segment) => count + segment.features.length, 0);
  return (
    `Plan du projet — ${plan.segments.length} segment(s), ${features} feature(s)\n` +
    `But : ${oneLine(plan.purpose)}\nFonction : ${oneLine(plan.function)}\n\n` +
    renderPlanText(plan.segments)
  );
}


// --- le document PROJECT.md (S-5) --------------------------------------------

/** Le statut du projet, tel que le document le dit (S-5). */
export function projectStatusLine(project: Project): string {
  if (project.status === "done") return "terminé";
  const segment = project.segments[project.current] as ProjectSegment;
  const where = `segment ${project.current + 1}/${project.segments.length} « ${oneLine(segment.name)} »`;
  return project.status === "running" ? `en cours — ${where}` : `arrêté — ${where}`;
}


/** Une cellule de table : sur une ligne, `|` échappé. */
function cell(text: string): string {
  return oneLine(text).replace(/\|/g, "\\|");
}


function featureStateLabel(feature: ProjectFeature): string {
  switch (feature.status) {
    case "planned":
      return "à venir";
    case "launched":
      return "lancée";
    case "pr":
      return "PR ouverte";
    case "merged":
      return "fusionnée";
    case "failed":
      return `en échec — ${feature.failure?.reason ?? ""}`;
    case "removed":
      return "retirée";
  }
}


/**
 * Le document du projet (S-5) : PURE et déterministe — aucune date ni heure, le
 * journal est l'historique git de la branche `omp-project`. Les features retirées
 * sortent des tables des segments (leur numérotation les saute) et sont listées à
 * part.
 */
export function renderProjectDoc(project: Project, repoName: string): string {
  const all = project.segments.flatMap((segment) => segment.features);
  const planned = all.filter((feature) => feature.status !== "removed");
  const merged = all.filter((feature) => feature.status === "merged").length;
  const lines = [
    `# Projet — ${repoName}`,
    "",
    `Document tenu par la commande /project (plugin omp-mem0-req) sur la branche \`${PROJECT_DOC_BRANCH}\` : réécrit à chaque changement d'état, ne l'édite pas à la main.`,
    "",
    `**Statut** : ${projectStatusLine(project)}`,
    `**Avancement** : ${merged}/${planned.length} feature(s) fusionnée(s)`,
    "",
    "## But",
    "",
    project.purpose,
    "",
    "## Fonction",
    "",
    project.function,
    "",
    "## Plan",
  ];
  for (const [index, segment] of project.segments.entries()) {
    const state =
      index < project.current
        ? "fusionné"
        : index === project.current
          ? project.status === "done"
            ? "terminé"
            : "en cours"
          : "à venir";
    lines.push(
      "",
      `### Segment ${index + 1} — ${oneLine(segment.name)} (${state})`,
      "",
      "| # | Feature | État | PR | Modèle req+specs | Modèle impl+review | Intention |",
      "|---|---|---|---|---|---|---|",
    );
    let row = 0;
    for (const feature of segment.features) {
      if (feature.status === "removed") continue;
      row += 1;
      lines.push(
        `| ${row} | \`${feature.slug}\` | ${cell(featureStateLabel(feature))} | ${cell(feature.prUrl ?? "—")} | ${cell(feature.modelReqSpecs ?? "défaut OMP")} | ${cell(feature.modelImplReview ?? "défaut OMP")} | ${cell(feature.intention)} |`,
      );
    }
  }
  const removed = project.segments.flatMap((segment, index) =>
    segment.features.filter((feature) => feature.status === "removed").map((feature) => ({ feature, index })),
  );
  if (removed.length > 0) {
    lines.push("", "## Features retirées", "", "| Feature | Segment | Motif |", "|---|---|---|");
    for (const { feature, index } of removed) {
      lines.push(`| \`${feature.slug}\` | ${index + 1} | ${cell(feature.removedReason ?? "")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}


// --- l'avancement depuis le lot (S-7) ----------------------------------------

/**
 * Les features du segment courant resynchronisées depuis le lot (S-7 §1) : PURE.
 * Rend le projet mis à jour (copie) et les évènements du document, un par
 * transition — aucun évènement, aucun changement.
 */
export function syncFromLot(project: Project, lot: Lot | null, now: number): { project: Project; events: string[] } {
  const next = structuredClone(project);
  const events: string[] = [];
  const segment = next.segments[next.current] as ProjectSegment;
  for (const feature of segment.features) {
    const lf = lot === null ? undefined : lotFeature(lot, feature.slug);
    const fail = (kind: ProjectFailureKind, reason: string) => {
      feature.status = "failed";
      feature.failure = { kind, reason, at: now };
      feature.updatedAt = now;
      events.push(`${feature.slug} en échec`);
    };
    const toPr = (prUrl: string) => {
      feature.status = "pr";
      feature.prUrl = prUrl;
      feature.failure = null;
      feature.updatedAt = now;
      events.push(`${feature.slug} PR ouverte`);
    };
    if (feature.status === "launched") {
      if (lf === undefined) {
        fail("launch", "absente du lot (lot remplacé ou feature retirée hors de /project)");
        continue;
      }
      switch (lf.state) {
        case "done":
          if (lf.prUrl !== null) toPr(lf.prUrl);
          else fail("lot", "pipeline terminée sans PR");
          break;
        case "failed":
          fail("lot", `pipeline en erreur : ${lf.stopReason ?? "sans motif"}`);
          break;
        case "blocked":
          // Un quota épuisé n'est pas un échec (S-5) : la feature attend la décision
          // de l'utilisateur, groupée par fournisseur (relais ou /pipelines).
          if (lf.quota !== undefined) break;
          if (isReviewCapReason(lf.stopReason)) fail("lot", `plafond de revue atteint : ${lf.stopReason}`);
          else fail("lot", `pipeline bloquée : ${lf.stopReason ?? "sans motif"}`);
          break;
        case "cancelled":
          fail("lot", "pipeline abandonnée");
          break;
        default:
          break;
      }
      continue;
    }
    // Une feature en échec du LOT relancée depuis /pipelines repart dans le projet.
    if (feature.status === "failed" && feature.failure?.kind === "lot" && lf !== undefined) {
      if (lf.state === "pending" || lf.state === "running" || lf.state === "waiting") {
        feature.status = "launched";
        feature.failure = null;
        feature.updatedAt = now;
        events.push(`${feature.slug} relancée`);
      } else if (lf.state === "done" && lf.prUrl !== null) {
        toPr(lf.prUrl);
      }
    }
  }
  if (events.length > 0) next.updatedAt = now;
  return { project: next, events };
}


/** Le segment courant est-il ACHEVÉ — chacune de ses features fusionnée ou retirée (S-7 §3) ? */
export function segmentDone(project: Project): boolean {
  return (project.segments[project.current] as ProjectSegment).features.every(
    (feature) => feature.status === "merged" || feature.status === "removed",
  );
}


/**
 * Les échecs du segment courant, relayés à la session /project (S-6 §3), dans
 * l'ordre du plan. Clé `failure:<slug>:<failure.at>` : un nouvel échec de la même
 * feature est un nouvel élément.
 */
export function projectFailureItems(project: Project, lot: Lot | null): RelayItem[] {
  const segment = project.segments[project.current] as ProjectSegment;
  const items: RelayItem[] = [];
  for (const feature of segment.features) {
    if (feature.status !== "failed" || feature.failure === null) continue;
    const lf = lot === null ? undefined : lotFeature(lot, feature.slug);
    items.push({
      key: `failure:${feature.slug}:${feature.failure.at}`,
      kind: "failure",
      slug: feature.slug,
      phase: lf?.phase ?? "req",
      worktree: lf?.worktree ?? "",
      question: null,
      options: [],
      toolCallId: null,
      inbox: null,
      stopReason: feature.failure.reason,
    });
  }
  return items;
}


// --- le dépôt distant GitHub (S-1) -------------------------------------------

/** Les formes d'URL d'un dépôt GitHub (hôte exact, insensible à la casse ; GitHub Enterprise exclu). */
const GITHUB_URLS = [
  /^https?:\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/[^/\s]+\/[^/\s]+?(?:\.git)?\/?$/i,
  /^ssh:\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/[^/\s]+\/[^/\s]+?(?:\.git)?$/i,
  /^git:\/\/github\.com\/[^/\s]+\/[^/\s]+?(?:\.git)?$/i,
  /^[^@/:\s]+@github\.com:[^/\s]+\/[^/\s]+?(?:\.git)?$/i,
];


/**
 * Le dépôt distant GitHub d'une sortie `git remote -v` (S-1) : PURE. `origin`
 * s'il désigne GitHub, sinon le premier remote GitHub dans l'ordre de sortie.
 */
export function githubRemoteOf(remoteV: string): { name: string; url: string } | null {
  const remotes: { name: string; url: string }[] = [];
  for (const line of remoteV.split("\n")) {
    const match = /^(\S+)\t(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const url = match[2] as string;
    if (GITHUB_URLS.some((pattern) => pattern.test(url))) remotes.push({ name: match[1] as string, url });
  }
  return remotes.find((remote) => remote.name === "origin") ?? remotes[0] ?? null;
}
