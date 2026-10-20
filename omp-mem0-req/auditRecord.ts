// Les audits lancés depuis la section Audit d'OMP Console (S-1 à S-4) : un
// enregistrement `<stateDir>/audits/<id>.json` par audit, écrit par le SEUL
// service OMP, jamais supprimé. Sa clé de contexte `<stateDir>/audits/<id>` (une
// clé absolue, pas un fichier, sur le patron de `project.relayKey`) est portée
// par `LotFeature.auditSession` des features lancées : elle isole le brief, le
// journal et l'arbitrage. Le relais `/audit` du terminal n'y prend aucune part.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BriefInput } from "./context.ts";
import { BRIEF_SECTIONS, renderBrief } from "./context.ts";
import type { PipelinePhase } from "./contract.ts";
import type { LotFeatureState } from "./lot.ts";
import { asLotFeatureState } from "./lot.ts";
import { PIPELINE_PHASES, readJsonFile, writeJsonAtomic, writeStateFileAtomic } from "./store.ts";

export type AuditStatus = "analysing" | "proposed" | "launched" | "stopped" | "failed";

export type AuditProposalElement = { kind: "weakness" | "feature"; slug: string; intention: string; deps: string[] };

export type AuditLaunchOutcome = {
  slug: string;
  launched: boolean;
  /** Le motif quand `launched` vaut `false`. */
  reason: string | null;
  /** Le dernier état connu de la feature (S-2 « suivi »). */
  state: LotFeatureState | null;
  phase: PipelinePhase | null;
  prUrl: string | null;
};

export type AuditRecord = {
  version: 1;
  /** 16 hexadécimaux. */
  id: string;
  /** Le realpath du dépôt principal. */
  repoRoot: string;
  /** `lotRepoKey(repoRoot)`. */
  repoKey: string;
  /** `${stateDir}/audits/${id}` : la clé de contexte. */
  key: string;
  /** Rognée, 1 à 2000 caractères. */
  orientation: string;
  status: AuditStatus;
  /** ms epoch. */
  createdAt: number;
  updatedAt: number;
  proposal: { elements: AuditProposalElement[]; briefDraft: string } | null;
  /** `[]` avant le lancement. */
  launches: AuditLaunchOutcome[];
  /** Texte brut, seulement pour `status: "failed"`. */
  failure: string | null;
};

export const AUDIT_VERSION = 1;

/** Les rubriques d'un brief d'audit de l'app : celles du gabarit, puis « Orientation » et « Constats ». */
export const AUDIT_BRIEF_SECTIONS = [...BRIEF_SECTIONS, "Orientation", "Constats"] as const;

const AUDIT_STATUSES: Record<AuditStatus, true> = {
  analysing: true,
  proposed: true,
  launched: true,
  stopped: true,
  failed: true,
};

/** Les transitions permises : toute autre est refusée. */
const AUDIT_TRANSITIONS: Record<AuditStatus, readonly AuditStatus[]> = {
  analysing: ["proposed", "failed", "stopped"],
  proposed: ["launched", "stopped"],
  launched: ["stopped"],
  failed: ["stopped"],
  stopped: [],
};

// --- le magasin --------------------------------------------------------------

/** `<stateDir>/audits` : un fichier par audit. */
export function auditsDirOf(stateDir: string): string {
  return path.join(stateDir, "audits");
}

/** `<stateDir>/audits/<id>.json`. */
export function auditPathFor(stateDir: string, id: string): string {
  return path.join(auditsDirOf(stateDir), `${id}.json`);
}

/** `<stateDir>/audits/<id>` : la clé de contexte de l'audit, absolue — pas un fichier. */
export function auditKeyOf(stateDir: string, id: string): string {
  return `${stateDir}/audits/${id}`;
}

/** Un identifiant neuf : 8 octets aléatoires, 16 hexadécimaux. */
export function newAuditId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function asProposalElement(raw: unknown): AuditProposalElement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (e.kind !== "weakness" && e.kind !== "feature") return null;
  if (typeof e.slug !== "string" || e.slug === "" || typeof e.intention !== "string") return null;
  if (!Array.isArray(e.deps) || e.deps.some((dep) => typeof dep !== "string")) return null;
  return { kind: e.kind, slug: e.slug, intention: e.intention, deps: [...(e.deps as string[])] };
}

function asLaunchOutcome(raw: unknown): AuditLaunchOutcome | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.slug !== "string" || o.slug === "" || typeof o.launched !== "boolean") return null;
  if (o.reason !== null && typeof o.reason !== "string") return null;
  if (o.prUrl !== null && typeof o.prUrl !== "string") return null;
  const state = o.state === null ? null : asLotFeatureState(o.state);
  if (o.state !== null && state === null) return null;
  const phase =
    o.phase === null
      ? null
      : PIPELINE_PHASES.includes(o.phase as PipelinePhase)
        ? (o.phase as PipelinePhase)
        : undefined;
  if (phase === undefined) return null;
  return {
    slug: o.slug,
    launched: o.launched,
    reason: o.reason as string | null,
    state,
    phase,
    prUrl: o.prUrl as string | null,
  };
}

/**
 * L'audit relu, TOLÉRANT : d'une autre version ou avec un champ obligatoire
 * invalide ⇒ `null` — un fichier que personne n'a écrit se lit comme absent.
 */
export function asAudit(raw: unknown): AuditRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (a.version !== AUDIT_VERSION) return null;
  if (typeof a.id !== "string" || !/^[0-9a-f]{16}$/.test(a.id)) return null;
  if (typeof a.repoRoot !== "string" || a.repoRoot === "") return null;
  if (typeof a.repoKey !== "string" || a.repoKey === "") return null;
  if (typeof a.key !== "string" || !path.isAbsolute(a.key)) return null;
  if (typeof a.orientation !== "string") return null;
  if (typeof a.status !== "string" || AUDIT_STATUSES[a.status as AuditStatus] !== true) return null;
  if (typeof a.createdAt !== "number" || !Number.isFinite(a.createdAt)) return null;
  if (typeof a.updatedAt !== "number" || !Number.isFinite(a.updatedAt)) return null;
  let proposal: AuditRecord["proposal"] = null;
  if (a.proposal !== null) {
    const p = a.proposal;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const { elements: rawElements, briefDraft } = p as Record<string, unknown>;
    if (!Array.isArray(rawElements) || typeof briefDraft !== "string") return null;
    const elements: AuditProposalElement[] = [];
    for (const rawElement of rawElements) {
      const element = asProposalElement(rawElement);
      if (element === null) return null;
      elements.push(element);
    }
    proposal = { elements, briefDraft };
  }
  if (!Array.isArray(a.launches)) return null;
  const launches: AuditLaunchOutcome[] = [];
  for (const rawLaunch of a.launches) {
    const launch = asLaunchOutcome(rawLaunch);
    if (launch === null) return null;
    launches.push(launch);
  }
  if (a.failure !== null && typeof a.failure !== "string") return null;
  return {
    version: AUDIT_VERSION,
    id: a.id,
    repoRoot: a.repoRoot,
    repoKey: a.repoKey,
    key: a.key,
    orientation: a.orientation,
    status: a.status as AuditStatus,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    proposal,
    launches,
    failure: a.failure as string | null,
  };
}

/** L'audit `id`, ou `null` (absent ou illisible). */
export function readAudit(stateDir: string, id: string): AuditRecord | null {
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  return asAudit(readJsonFile(auditPathFor(stateDir, id)));
}

/** Tous les audits lisibles du magasin, du plus ancien au plus récent (`createdAt`, puis id). */
export function listAudits(stateDir: string): AuditRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(auditsDirOf(stateDir));
  } catch {
    return [];
  }
  const audits: AuditRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const audit = readAudit(stateDir, name.slice(0, -".json".length));
    if (audit !== null) audits.push(audit);
  }
  return audits.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Écriture atomique : l'appelant a relu le fichier SANS `await` depuis (un seul écrivain, le service). */
export function writeAudit(stateDir: string, audit: AuditRecord): void {
  writeJsonAtomic(auditPathFor(stateDir, audit.id), { ...audit, version: AUDIT_VERSION });
}

/** `<stateDir>/audits/<id>.report.md` : le rapport de l'analyse, en attente du lancement (`listAudits` ne lit que `*.json`). */
export function auditReportDraftPathFor(stateDir: string, id: string): string {
  return path.join(auditsDirOf(stateDir), `${id}.report.md`);
}

/** Écrit le brouillon du rapport TEL QUEL, atomiquement ; lève si l'écriture échoue. */
export function writeAuditReportDraft(stateDir: string, id: string, text: string): void {
  writeStateFileAtomic(auditReportDraftPathFor(stateDir, id), text);
}

/** Le brouillon du rapport de l'audit `id` ; `null` s'il est absent ou illisible. */
export function readAuditReportDraft(stateDir: string, id: string): string | null {
  try {
    return fs.readFileSync(auditReportDraftPathFor(stateDir, id), "utf8");
  } catch {
    return null;
  }
}

// --- les transitions ---------------------------------------------------------

/** `analysing → proposed | failed | stopped`, `proposed → launched | stopped`, `launched → stopped`, `failed → stopped`. */
export function canTransition(from: AuditStatus, to: AuditStatus): boolean {
  return AUDIT_TRANSITIONS[from].includes(to);
}

/**
 * L'audit passé à `to` (copie, `updatedAt` = `now`), ou le refus de la
 * transition. N'écrit rien : l'appelant écrit par `writeAudit`.
 */
export function transitionAudit(
  audit: AuditRecord,
  to: AuditStatus,
  now: number,
): { ok: true; audit: AuditRecord } | { ok: false; error: string } {
  if (!canTransition(audit.status, to)) {
    return { ok: false, error: `transition d'audit refusée : ${audit.status} → ${to}` };
  }
  return { ok: true, audit: { ...audit, status: to, updatedAt: now } };
}

// --- le brief d'audit --------------------------------------------------------

/**
 * Le brouillon du brief d'un audit de l'app (S-1) : le gabarit titré
 * « audit <dépôt> », puis les rubriques « Orientation » et « Constats » (une
 * ligne par faiblesse, ou « - (aucun) »).
 */
export function renderAuditBrief(
  audit: Pick<AuditRecord, "repoRoot" | "orientation">,
  brief: BriefInput,
  weaknesses: readonly Pick<AuditProposalElement, "slug" | "intention">[],
): string {
  const findings =
    weaknesses.length === 0
      ? "- (aucun)"
      : weaknesses.map((weakness) => `- ${weakness.slug} — ${weakness.intention}`).join("\n");
  return [
    renderBrief({ title: `audit ${path.basename(audit.repoRoot)}`, ...brief }),
    "## Orientation",
    audit.orientation,
    "",
    "## Constats",
    findings,
    "",
  ].join("\n");
}
