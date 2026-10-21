// La politique de décision des runners : ce qui n'est pas tranché se décide seul,
// par l'option la plus réversible, et devient un checkpoint (commit WIP « decision: … »).
// Seul l'irréversible s'escalade — schéma de données, API publique, suppression — et
// les escalades partent ensemble, en fin d'étape.
//
// Une décision déclare celles dont elle découle (`dependsOn`) : renverser une décision
// n'annule que ses dépendantes, les autres tiennent.
//
// La catégorie DÉCLARÉE par l'agent fait foi ; le détecteur ne peut que la DURCIR
// (jamais l'adoucir) : un « reversible » qui écrit `DROP TABLE` part en escalade.


export type DecisionCategory = "reversible" | "schema" | "public_api" | "deletion";

export const DECISION_CATEGORIES: readonly DecisionCategory[] = ["reversible", "schema", "public_api", "deletion"];

export const IRREVERSIBLE: readonly DecisionCategory[] = ["schema", "public_api", "deletion"];


/** Les motifs SÛRS d'irréversibilité : étroits par construction, un faux positif coûte une escalade. */
const PATTERNS: { category: Exclude<DecisionCategory, "reversible">; pattern: RegExp }[] = [
  { category: "schema", pattern: /\b(drop|alter)\s+(table|column|index)\b/i },
  { category: "schema", pattern: /\bmigration\s+(de\s+)?(sch[ée]ma|base|donn[ée]es|database|schema)\b/i },
  { category: "schema", pattern: /\b(sch[ée]ma|schema)\s+(de\s+(la\s+)?)?(donn[ée]es|base|bdd|database|data)\b/i },
  { category: "public_api", pattern: /\b(api\s+publique|public\s+api|breaking\s+change|changement\s+cassant)\b/i },
  { category: "public_api", pattern: /\b(endpoint|route)\s+(publi[cq]u?e?|public)\b/i },
  { category: "deletion", pattern: /\b(suppression|supprimer|effacer|purger|delete|remove|purge)\s+(d[eu']\s*|des\s+|les\s+|the\s+|all\s+)?(donn[ée]es|data|fichiers?\s+utilisateurs?|user\s+files?|comptes?|accounts?|historique|history|backups?|sauvegardes?)\b/i },
  { category: "deletion", pattern: /\brm\s+-rf\b/i },
];


/** La catégorie irréversible que trahit le texte d'une décision, ou `null`. */
export function detectIrreversible(text: string): Exclude<DecisionCategory, "reversible"> | null {
  for (const { category, pattern } of PATTERNS) if (pattern.test(text)) return category;
  return null;
}


export type DecisionInput = {
  question: string;
  options: string[];
  chosen: string;
  rationale: string;
  category: DecisionCategory;
  /** Les numéros des décisions du run dont ce choix découle. */
  dependsOn: number[];
};

export type DecisionPlan =
  | { kind: "checkpoint"; input: DecisionInput }
  | { kind: "escalate"; input: DecisionInput; category: Exclude<DecisionCategory, "reversible">; hardened: boolean };

export type DecisionParse = { ok: true; plan: DecisionPlan } | { ok: false; error: string };


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


/** Valide l'appel `decision` d'un runner et dit ce que le service en fait. */
export function planDecision(raw: unknown): DecisionParse {
  if (!isRecord(raw)) return { ok: false, error: "arguments attendus : { question, options, chosen, rationale, category, dependsOn? }" };
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (question === "") return { ok: false, error: "question est requise" };
  const options = Array.isArray(raw.options) ? raw.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map(o => o.trim()) : [];
  if (options.length < 2) return { ok: false, error: "au moins deux options sont requises" };
  const chosen = typeof raw.chosen === "string" ? raw.chosen.trim() : "";
  if (!options.includes(chosen)) return { ok: false, error: "chosen doit reprendre une des options mot pour mot" };
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (rationale === "") return { ok: false, error: "rationale est requise : une décision sans raison sera rouverte" };
  const declared = raw.category;
  if (typeof declared !== "string" || !(DECISION_CATEGORIES as readonly string[]).includes(declared)) {
    return { ok: false, error: `category : ${DECISION_CATEGORIES.join(" | ")}` };
  }
  const dependsOn = raw.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every(n => Number.isInteger(n) && (n as number) >= 1)) {
    return { ok: false, error: "dependsOn : la liste des numéros (#N) des décisions dont ce choix découle" };
  }
  const input: DecisionInput = {
    question,
    options,
    chosen,
    rationale,
    category: declared as DecisionCategory,
    dependsOn: [...new Set(dependsOn as number[])].sort((a, b) => a - b),
  };
  if (input.category !== "reversible") return { ok: true, plan: { kind: "escalate", input, category: input.category, hardened: false } };
  const detected = detectIrreversible([question, chosen, rationale].join("\n"));
  if (detected) return { ok: true, plan: { kind: "escalate", input: { ...input, category: detected }, category: detected, hardened: true } };
  return { ok: true, plan: { kind: "checkpoint", input } };
}


/** Le message du commit WIP d'une décision : le checkpoint N, retrouvable après un rebase. */
export function checkpointMessage(runId: string, seq: number, input: Pick<DecisionInput, "question" | "chosen" | "rationale">): string {
  const subject = `decision: ${input.question} → ${input.chosen}`.replace(/\s+/g, " ").slice(0, 120);
  return `${subject}\n\n${input.rationale}\n\nHarness-Decision: ${runId}/${seq}\n`;
}


/** Le trailer d'un commit de décision, lu après un rebase pour remapper les checkpoints. */
export function parseCheckpointTrailer(message: string): { runId: string; seq: number } | null {
  const match = /^Harness-Decision:\s*(\S+)\/(\d+)\s*$/m.exec(message);
  return match ? { runId: match[1] as string, seq: Number(match[2]) } : null;
}


/**
 * Les décisions qu'emporte le renversement de `seq` : celles qui en découlent,
 * directement ou par une chaîne de `dependsOn`, dans l'ordre du run.
 */
export function dependentsOf(decisions: readonly { seq: number; dependsOn: readonly number[] }[], seq: number): number[] {
  const fallen = new Set([seq]);
  for (const decision of [...decisions].sort((a, b) => a.seq - b.seq)) {
    if (decision.seq > seq && decision.dependsOn.some(n => fallen.has(n))) fallen.add(decision.seq);
  }
  fallen.delete(seq);
  return [...fallen];
}
