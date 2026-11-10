// La sortie de /review : un verdict STRUCTURÉ, et la règle d'auto-merge qui le lit.
//
// Le verdict vient du runner par l'outil hôte `review_verdict` ; il est validé ici
// champ par champ. Les tests verts, eux, ne viennent JAMAIS du verdict : c'est le
// résultat heavy enregistré par le service pour l'arbre exact qui sera mergé. De même
// la liste des critères d'acceptation à couvrir (`acIds`) et les fichiers touchés
// (`touchedFiles`) sont lus par le service, pas déclarés par la revue.
import { isRecord } from "./config.ts";

export type Risk = "low" | "medium" | "high";

/** Un critère d'acceptation, tel que la revue l'a vérifié : son test nommé et son état. */
export type CriterionVerdict = {
  /** `AC-n`, l'id lu dans specs.md. */
  id: string;
  /** Le nom du test qui le prouve (vide si `untested`). */
  test: string;
  status: "pass" | "fail" | "untested";
};

export type Verdict = {
  risk: Risk;
  summary: string;
  /** Ce qui empêche le merge : non vide ⇒ /impl --fix. */
  blockers: string[];
  /** Les risques résiduels, même acceptables. */
  risks: string[];
  /** Les fichiers touchés, tels que la revue les a lus. */
  files: string[];
  /** Ce que la revue n'a PAS pu vérifier. */
  unverified: string[];
  /** La table AC par AC : chaque critère de specs.md, son test, son état. */
  criteria: CriterionVerdict[];
  /** `weak` : la revue elle-même doute — l'humain lira le code. */
  confidence: "strong" | "weak";
  /**
   * Le message du commit squash, rédigé par la revue : ce que le changement fait et
   * pourquoi, pas le récit de la relecture. Absent d'un verdict rendu avant ce champ
   * (run en vol au déploiement) : le merge prend alors le titre du run.
   */
  commit?: CommitMessage;
};

/** Un message de commit : un sujet Conventional Commits et un corps en prose. */
export type CommitMessage = { subject: string; body: string };

/** Les types Conventional Commits admis dans un sujet de commit. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "test",
  "docs",
  "build",
  "ci",
  "chore",
  "style",
  "revert",
] as const;

/** La longueur maximale d'un sujet de commit. */
export const COMMIT_SUBJECT_MAX = 72;

/**
 * `type(scope): résumé` : scope facultatif, sans espace ni parenthèse, résumé non vide.
 * Une seule ligne : `.` ne traverse aucun saut de ligne.
 */
const COMMIT_SUBJECT = new RegExp(`^(?:${COMMIT_TYPES.join("|")})(?:\\([^()\\s]+\\))?: \\S.*$`);

function commitMessage(value: unknown, errors: string[]): CommitMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    errors.push("commit : le message du commit squash est requis ({subject, body})");
    return { subject: "", body: "" };
  }
  const subject = "subject" in value && typeof value.subject === "string" ? value.subject.trim() : "";
  const body = "body" in value && typeof value.body === "string" ? value.body.trim() : "";
  if (subject.length > COMMIT_SUBJECT_MAX || !COMMIT_SUBJECT.test(subject))
    errors.push(
      `commit.subject : \`type(scope): résumé\` en Conventional Commits, une ligne, ${COMMIT_SUBJECT_MAX} caractères au plus ` +
        `(type ${COMMIT_TYPES.join(" | ")}, scope facultatif) — reçu « ${subject} »`,
    );
  if (body === "") errors.push("commit.body : ce que le changement fait et pourquoi est requis");
  return { subject, body };
}

export type VerdictParse = { ok: true; verdict: Verdict } | { ok: false; errors: string[] };

const RISKS: readonly Risk[] = ["low", "medium", "high"];
const CONFIDENCES: readonly Verdict["confidence"][] = ["strong", "weak"];
const STATUSES: readonly CriterionVerdict["status"][] = ["pass", "fail", "untested"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

function strings(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} doit être une liste de chaînes`);
    return [];
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field} doit être une liste de chaînes`);
      return [];
    }
    if (item.trim() !== "") items.push(item.trim());
  }
  return items;
}

function criteria(value: unknown, errors: string[]): CriterionVerdict[] {
  if (!Array.isArray(value)) {
    errors.push("criteria : la table AC par AC est requise (liste de {id, test, status})");
    return [];
  }
  const table: CriterionVerdict[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      errors.push("criteria : chaque entrée est un objet {id, test, status}");
      return [];
    }
    const id = "id" in item && typeof item.id === "string" ? item.id.trim() : "";
    const test = "test" in item && typeof item.test === "string" ? item.test.trim() : "";
    const status = oneOf("status" in item ? item.status : undefined, STATUSES);
    if (id === "" || status === null) {
      errors.push("criteria : id (AC-n) et status (pass | fail | untested) sont requis");
      return [];
    }
    table.push({ id, test, status });
  }
  return table;
}

/** Valide le verdict brut d'un runner. */
export function parseVerdict(raw: unknown): VerdictParse {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, errors: ["le verdict doit être un objet"] };
  const record: Record<string, unknown> = { ...raw };
  const risk = oneOf(record.risk, RISKS);
  if (risk === null) errors.push("risk : low | medium | high");
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (summary === "") errors.push("summary est requis");
  const confidence = oneOf(record.confidence, CONFIDENCES);
  if (confidence === null) errors.push("confidence : strong | weak (requis)");
  const verdict: Verdict = {
    risk: risk ?? "high",
    summary,
    blockers: strings(record.blockers, "blockers", errors),
    risks: strings(record.risks, "risks", errors),
    files: strings(record.files, "files", errors),
    unverified: strings(record.unverified, "unverified", errors),
    criteria: criteria(record.criteria, errors),
    confidence: confidence ?? "weak",
    commit: commitMessage(record.commit, errors),
  };
  if (verdict.files.length === 0) errors.push("files : la liste des fichiers touchés est requise");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, verdict };
}

const AC_ID = /^\s*(?:[-*]\s*)?\*{0,2}(AC-\d+)/;

/** Les ids `AC-n` déclarés dans specs.md (un par ligne qui commence par l'id), sans doublon. */
export function parseAcIds(specsMd: string): string[] {
  const ids: string[] = [];
  for (const line of specsMd.split("\n")) {
    const match = AC_ID.exec(line);
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** Le texte d'une ligne de critère, sans puce ni gras, espaces resserrés : ce qui fait son contrat. */
function criterionText(line: string): string {
  return line
    .replace(/^\s*(?:[-*]\s*)?/, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Chaque `AC-n` de specs.md (première ligne qui commence par l'id) et son texte. */
export function parseAcLines(specsMd: string): Map<string, string> {
  const lines = new Map<string, string>();
  for (const line of specsMd.split("\n")) {
    const match = AC_ID.exec(line);
    if (match && !lines.has(match[1])) lines.set(match[1], criterionText(line));
  }
  return lines;
}

/** Un critère qui a bougé depuis la validation des specs : `validated` null = ajouté, `current` null = retiré. */
export type CriterionDrift = { id: string; validated: string | null; current: string | null };

/**
 * Les critères des specs VALIDÉES que la suite du run a retirés ou réécrits, puis ceux
 * qu'elle a ajoutés. /impl peut corriger une spec ambiguë ; il ne peut pas, sans
 * l'humain, affaiblir le contrat sur lequel l'auto-merge juge.
 */
export function criteriaDrift(validatedMd: string, currentMd: string): CriterionDrift[] {
  const validated = parseAcLines(validatedMd);
  const current = parseAcLines(currentMd);
  const drift: CriterionDrift[] = [];
  for (const [id, text] of validated) {
    const now = current.get(id) ?? null;
    if (now !== text) drift.push({ id, validated: text, current: now });
  }
  for (const [id, text] of current) if (!validated.has(id)) drift.push({ id, validated: null, current: text });
  return drift;
}

/** Une ligne lisible par critère qui a bougé : `AC-2 réécrit`, `AC-3 retiré`, `AC-4 ajouté`. */
export function driftLabel(drift: CriterionDrift): string {
  return `${drift.id} ${drift.current === null ? "retiré" : drift.validated === null ? "ajouté" : "réécrit"}`;
}

/** Les faits que le SERVICE établit, indépendamment de ce que dit la revue. */
export type MergeEvidence = {
  /** Le résultat de la suite complète sur l'arbre courant (cache heavy). */
  fullTests: "pass" | "fail" | "not_run";
  diffLines: number;
  maxDiffLines: number;
  openEscalations: number;
  /** Les `AC-n` des specs validées et ceux ajoutés depuis : chacun doit figurer dans `criteria` en `pass`. */
  acIds: string[];
  /** Les critères qui ont bougé depuis la validation des specs (`criteriaDrift`). */
  specsDrift: CriterionDrift[];
  /** Le risque maximal que l'auto-merge accepte (`review.autoMergeRisk`). */
  autoMergeRisk: "low" | "medium";
  /** Les fichiers que git voit modifiés depuis la base : la revue doit tous les avoir lus. */
  touchedFiles: string[];
};

/** Ce que la revue garde de son évidence (steps.ts `REVIEW_EVIDENCE`) : celle du merge, les tests ajoutés ou modifiés, le sha relu. */
export type ReviewEvidence = MergeEvidence & { reproTests: string[]; reviewSha: string };

export type MergeDecision =
  | { auto: true }
  /** `readCode` : le verdict est faible — l'humain lit le code, pas seulement le verdict. */
  | { auto: false; reasons: string[]; readCode: boolean };

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/**
 * Un motif du refus d'auto-merge, en DONNÉES : le code de ce que `mergeDecision` dit en texte, et ses
 * chiffres. Les apps en tirent leur propre phrase (`humanWait.reasons` d'un run, machine.ts).
 * `open_questions` sert aussi à un run `escalated` : le nombre de ses questions ouvertes.
 */
export type MergeFact =
  | { code: "blockers"; count: number }
  /** `max` : le risque le plus haut que l'auto-merge accepte (`review.autoMergeRisk`). */
  | { code: "risk"; risk: Risk; max: "low" | "medium" }
  | { code: "tests_not_green"; tests: "fail" | "not_run" }
  | { code: "diff_over_limit"; diffLines: number; maxDiffLines: number }
  | { code: "open_questions"; count: number }
  | { code: "criteria_missing"; ids: string[] }
  | { code: "criteria_unproven"; ids: string[] }
  | { code: "specs_drift"; ids: string[] }
  /** `files` : les dix premiers au plus. */
  | { code: "files_unread"; count: number; files: string[] }
  | { code: "criteria_unverified"; ids: string[] }
  | { code: "weak_verdict" };

/** Les fichiers non relus nommés dans le fait `files_unread`. */
const UNREAD_FILES_MAX = 10;

/** Chaque motif de refus de l'auto-merge : son fait à code et le texte que la raison du run en garde. */
function mergeFindings(verdict: Verdict, evidence: MergeEvidence): { fact: MergeFact; text: string }[] {
  const found: { fact: MergeFact; text: string }[] = [];
  const blockers = verdict.blockers.length;
  if (blockers > 0) found.push({ fact: { code: "blockers", count: blockers }, text: `${blockers} bloquant(s)` });
  if (RISK_RANK[verdict.risk] > RISK_RANK[evidence.autoMergeRisk])
    found.push({
      fact: { code: "risk", risk: verdict.risk, max: evidence.autoMergeRisk },
      text: `risque ${verdict.risk}`,
    });
  if (evidence.fullTests !== "pass")
    found.push({
      fact: { code: "tests_not_green", tests: evidence.fullTests },
      text: evidence.fullTests === "fail" ? "suite complète rouge" : "suite complète non lancée sur cet arbre",
    });
  if (evidence.diffLines > evidence.maxDiffLines)
    found.push({
      fact: { code: "diff_over_limit", diffLines: evidence.diffLines, maxDiffLines: evidence.maxDiffLines },
      text: `diff de ${evidence.diffLines} lignes (> ${evidence.maxDiffLines})`,
    });
  if (evidence.openEscalations > 0)
    found.push({
      fact: { code: "open_questions", count: evidence.openEscalations },
      text: `${evidence.openEscalations} escalade(s) ouverte(s)`,
    });
  const missing = evidence.acIds.filter((id) => !verdict.criteria.some((c) => c.id === id));
  if (missing.length > 0)
    found.push({
      fact: { code: "criteria_missing", ids: missing },
      text: `critère(s) absent(s) du verdict : ${missing.join(", ")}`,
    });
  const unproven = verdict.criteria.filter((c) => evidence.acIds.includes(c.id) && c.status !== "pass");
  if (unproven.length > 0)
    found.push({
      fact: { code: "criteria_unproven", ids: unproven.map((c) => c.id) },
      text: `critère(s) non prouvé(s) : ${unproven.map((c) => `${c.id} ${c.status}`).join(", ")}`,
    });
  const weakened = evidence.specsDrift.filter((drift) => drift.validated !== null);
  if (weakened.length > 0)
    found.push({
      fact: { code: "specs_drift", ids: weakened.map((drift) => drift.id) },
      text: `critère(s) validé(s) modifié(s) depuis /specs : ${weakened.map(driftLabel).join(", ")}`,
    });
  const unread = evidence.touchedFiles.filter((file) => !verdict.files.includes(file));
  if (unread.length > 0)
    found.push({
      fact: { code: "files_unread", count: unread.length, files: unread.slice(0, UNREAD_FILES_MAX) },
      text: `fichier(s) touchés non relus : ${unread.join(", ")}`,
    });
  const unverifiedAc = verdict.unverified.filter((item) => /\bAC-\d+\b/.test(item));
  if (unverifiedAc.length > 0)
    found.push({
      fact: {
        code: "criteria_unverified",
        ids: [...new Set(unverifiedAc.flatMap((item) => item.match(/\bAC-\d+\b/g) ?? []))],
      },
      text: `critère(s) non vérifié(s) : ${unverifiedAc.join(" ; ")}`,
    });
  if (verdict.confidence === "weak") found.push({ fact: { code: "weak_verdict" }, text: "verdict faible" });
  return found;
}

/**
 * Auto-merge si tout est établi : aucun bloquant, risque sous le plafond, suite
 * complète verte, petite PR, aucune escalade ouverte, confiance forte, chaque AC des
 * specs validées prouvé `pass` par la revue, aucun d'eux retiré ou réécrit depuis, et
 * tous les fichiers touchés relus. Sinon
 * l'humain lit le verdict — et le code quand la revue doute (confiance faible ou
 * points non vérifiés).
 */
export function mergeDecision(verdict: Verdict, evidence: MergeEvidence): MergeDecision {
  const reasons = mergeFindings(verdict, evidence).map((finding) => finding.text);
  const readCode = verdict.confidence === "weak" || verdict.unverified.length > 0;
  if (reasons.length === 0) return { auto: true };
  return { auto: false, reasons, readCode };
}

/** Les motifs à code du refus d'auto-merge, dans l'ordre des raisons de `mergeDecision` ; vide s'il l'accepte. */
export function mergeFacts(verdict: Verdict, evidence: MergeEvidence): MergeFact[] {
  return mergeFindings(verdict, evidence).map((finding) => finding.fact);
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * L'évidence de merge gardée par la revue (steps.ts `REVIEW_EVIDENCE` : `{merge, evidence}`), relue de
 * son artefact ; `null` s'il manque ou ne se lit plus (run d'avant un champ) — jamais d'exception.
 */
export function readMergeEvidence(raw: string | null): MergeEvidence | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const saved = isRecord(parsed) ? parsed.evidence : null;
  if (!isRecord(saved)) return null;
  const { fullTests, diffLines, maxDiffLines, openEscalations, acIds, specsDrift, autoMergeRisk, touchedFiles } = saved;
  if (fullTests !== "pass" && fullTests !== "fail" && fullTests !== "not_run") return null;
  if (typeof diffLines !== "number" || typeof maxDiffLines !== "number" || typeof openEscalations !== "number")
    return null;
  if (autoMergeRisk !== "low" && autoMergeRisk !== "medium") return null;
  if (!isStrings(acIds) || !isStrings(touchedFiles) || !Array.isArray(specsDrift)) return null;
  const drifts: CriterionDrift[] = [];
  for (const drift of specsDrift) {
    if (!isRecord(drift)) return null;
    const { id, validated, current } = drift;
    if (typeof id !== "string") return null;
    if (validated !== null && typeof validated !== "string") return null;
    if (current !== null && typeof current !== "string") return null;
    drifts.push({ id, validated, current });
  }
  return {
    fullTests,
    diffLines,
    maxDiffLines,
    openEscalations,
    acIds,
    specsDrift: drifts,
    autoMergeRisk,
    touchedFiles,
  };
}
