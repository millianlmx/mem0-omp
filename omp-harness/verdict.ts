// La sortie de /review : un verdict STRUCTURÉ, et la règle d'auto-merge qui le lit.
//
// Le verdict vient du runner par l'outil hôte `review_verdict` ; il est validé ici
// champ par champ. Les tests verts, eux, ne viennent JAMAIS du verdict : c'est le
// résultat heavy enregistré par le service pour l'arbre exact qui sera mergé. De même
// la liste des critères d'acceptation à couvrir (`acIds`) et les fichiers touchés
// (`touchedFiles`) sont lus par le service, pas déclarés par la revue.

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
};

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

export type MergeDecision =
  | { auto: true }
  /** `readCode` : le verdict est faible — l'humain lit le code, pas seulement le verdict. */
  | { auto: false; reasons: string[]; readCode: boolean };

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/**
 * Auto-merge si tout est établi : aucun bloquant, risque sous le plafond, suite
 * complète verte, petite PR, aucune escalade ouverte, confiance forte, chaque AC des
 * specs validées prouvé `pass` par la revue, aucun d'eux retiré ou réécrit depuis, et
 * tous les fichiers touchés relus. Sinon
 * l'humain lit le verdict — et le code quand la revue doute (confiance faible ou
 * points non vérifiés).
 */
export function mergeDecision(verdict: Verdict, evidence: MergeEvidence): MergeDecision {
  const reasons: string[] = [];
  if (verdict.blockers.length > 0) reasons.push(`${verdict.blockers.length} bloquant(s)`);
  if (RISK_RANK[verdict.risk] > RISK_RANK[evidence.autoMergeRisk]) reasons.push(`risque ${verdict.risk}`);
  if (evidence.fullTests !== "pass")
    reasons.push(evidence.fullTests === "fail" ? "suite complète rouge" : "suite complète non lancée sur cet arbre");
  if (evidence.diffLines > evidence.maxDiffLines)
    reasons.push(`diff de ${evidence.diffLines} lignes (> ${evidence.maxDiffLines})`);
  if (evidence.openEscalations > 0) reasons.push(`${evidence.openEscalations} escalade(s) ouverte(s)`);
  const missing = evidence.acIds.filter((id) => !verdict.criteria.some((c) => c.id === id));
  if (missing.length > 0) reasons.push(`critère(s) absent(s) du verdict : ${missing.join(", ")}`);
  const unproven = verdict.criteria.filter((c) => evidence.acIds.includes(c.id) && c.status !== "pass");
  if (unproven.length > 0)
    reasons.push(`critère(s) non prouvé(s) : ${unproven.map((c) => `${c.id} ${c.status}`).join(", ")}`);
  const weakened = evidence.specsDrift.filter((drift) => drift.validated !== null);
  if (weakened.length > 0)
    reasons.push(`critère(s) validé(s) modifié(s) depuis /specs : ${weakened.map(driftLabel).join(", ")}`);
  const unread = evidence.touchedFiles.filter((file) => !verdict.files.includes(file));
  if (unread.length > 0) reasons.push(`fichier(s) touchés non relus : ${unread.join(", ")}`);
  const unverifiedAc = verdict.unverified.filter((item) => /\bAC-\d+\b/.test(item));
  if (unverifiedAc.length > 0) reasons.push(`critère(s) non vérifié(s) : ${unverifiedAc.join(" ; ")}`);
  if (verdict.confidence === "weak") reasons.push("verdict faible");
  const readCode = verdict.confidence === "weak" || verdict.unverified.length > 0;
  if (reasons.length === 0) return { auto: true };
  return { auto: false, reasons, readCode };
}
