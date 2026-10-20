// La sortie de /review : un verdict STRUCTURÉ, et la règle d'auto-merge qui le lit.
//
// Le verdict vient du runner par l'outil hôte `review_verdict` ; il est validé ici
// champ par champ. Les tests verts, eux, ne viennent JAMAIS du verdict : c'est le
// résultat heavy enregistré par le service pour l'arbre exact qui sera mergé.


export type Risk = "low" | "medium" | "high";

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
  /** `weak` : la revue elle-même doute — l'humain lira le code. */
  confidence: "strong" | "weak";
};

export type VerdictParse = { ok: true; verdict: Verdict } | { ok: false; errors: string[] };


function strings(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    errors.push(`${field} doit être une liste de chaînes`);
    return [];
  }
  return value.map(item => (item as string).trim()).filter(item => item !== "");
}


/** Valide le verdict brut d'un runner. */
export function parseVerdict(raw: unknown): VerdictParse {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["le verdict doit être un objet"] };
  const record = raw as Record<string, unknown>;
  const risk = record.risk;
  if (risk !== "low" && risk !== "medium" && risk !== "high") errors.push("risk : low | medium | high");
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (summary === "") errors.push("summary est requis");
  const confidence = record.confidence ?? "strong";
  if (confidence !== "strong" && confidence !== "weak") errors.push("confidence : strong | weak");
  const verdict: Verdict = {
    risk: risk as Risk,
    summary,
    blockers: strings(record.blockers, "blockers", errors),
    risks: strings(record.risks, "risks", errors),
    files: strings(record.files, "files", errors),
    unverified: strings(record.unverified, "unverified", errors),
    confidence: confidence as "strong" | "weak",
  };
  if (verdict.files.length === 0) errors.push("files : la liste des fichiers touchés est requise");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, verdict };
}


/** Les faits que le SERVICE établit, indépendamment de ce que dit la revue. */
export type MergeEvidence = {
  /** Le résultat de la suite complète sur l'arbre courant (cache heavy). */
  fullTests: "pass" | "fail" | "not_run";
  diffLines: number;
  maxDiffLines: number;
  openEscalations: number;
};

export type MergeDecision =
  | { auto: true }
  /** `readCode` : le verdict est faible — l'humain lit le code, pas seulement le verdict. */
  | { auto: false; reasons: string[]; readCode: boolean };


/**
 * Bas risque + tests verts → auto-merge. Sinon l'humain lit le verdict, et le code
 * seulement si le verdict est faible (confiance faible ou points non vérifiés).
 */
export function mergeDecision(verdict: Verdict, evidence: MergeEvidence): MergeDecision {
  const reasons: string[] = [];
  if (verdict.blockers.length > 0) reasons.push(`${verdict.blockers.length} bloquant(s)`);
  if (verdict.risk !== "low") reasons.push(`risque ${verdict.risk}`);
  if (evidence.fullTests !== "pass") reasons.push(evidence.fullTests === "fail" ? "suite complète rouge" : "suite complète non lancée sur cet arbre");
  if (evidence.diffLines > evidence.maxDiffLines) reasons.push(`diff de ${evidence.diffLines} lignes (> ${evidence.maxDiffLines})`);
  if (evidence.openEscalations > 0) reasons.push(`${evidence.openEscalations} escalade(s) ouverte(s)`);
  const weak = verdict.confidence === "weak" || verdict.unverified.length > 0;
  if (weak) reasons.push("verdict faible");
  if (reasons.length === 0) return { auto: true };
  return { auto: false, reasons, readCode: weak };
}
