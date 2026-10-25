// La politique de décision des runners : ce qui n'est pas tranché se décide seul,
// par l'option la plus réversible, et devient un checkpoint (commit WIP « decision: … »).
// Seul l'irréversible s'escalade — schéma de données, API publique, suppression — et
// les escalades partent ensemble, en fin d'étape ; passé le délai de réponse humaine,
// l'option recommandée s'applique (décision « auto_timeout », renversable).
//
// Une décision déclare celles dont elle découle (`dependsOn`) : renverser une décision
// n'annule que ses dépendantes, les autres tiennent.
//
// La catégorie DÉCLARÉE par l'agent fait foi ; le détecteur ne peut que la DURCIR
// (jamais l'adoucir) : un « reversible » qui écrit `DROP TABLE` part en escalade.
//
// « clarification » : une question de produit ou d'UX que le besoin ne tranche pas.
// Réversible par nature : l'agent choisit, checkpoint, et l'humain relit (inbox).
//
// Le lecteur pilote plusieurs projets à la fois et lit la question hors de la session :
// chaque décision porte son `context` (la situation, autoportante, en Markdown) et,
// pour une escalade, l'impact de chaque option (`impacts`, dans l'ordre des options).

export type DecisionCategory = "reversible" | "clarification" | "schema" | "public_api" | "deletion";

export const DECISION_CATEGORIES: readonly DecisionCategory[] = [
  "reversible",
  "clarification",
  "schema",
  "public_api",
  "deletion",
];

export type IrreversibleCategory = "schema" | "public_api" | "deletion";

export const IRREVERSIBLE: readonly IrreversibleCategory[] = ["schema", "public_api", "deletion"];

/** Entre deux et quatre options : une seule n'est pas un choix, cinq noient la réponse. */
export const OPTIONS_MIN = 2;
export const OPTIONS_MAX = 4;

/** Un contexte plus court ne dit pas la situation : c'est une étiquette, pas une explication. */
export const CONTEXT_MIN = 40;

/** Les motifs SÛRS d'irréversibilité : étroits par construction, un faux positif coûte une escalade. */
const PATTERNS: { category: IrreversibleCategory; pattern: RegExp }[] = [
  { category: "schema", pattern: /\b(drop|alter)\s+(table|column|index)\b/i },
  { category: "schema", pattern: /\bmigration\s+(de\s+)?(sch[ée]ma|base|donn[ée]es|database|schema)\b/i },
  { category: "schema", pattern: /\b(sch[ée]ma|schema)\s+(de\s+(la\s+)?)?(donn[ée]es|base|bdd|database|data)\b/i },
  { category: "public_api", pattern: /\b(api\s+publique|public\s+api|breaking\s+change|changement\s+cassant)\b/i },
  { category: "public_api", pattern: /\b(endpoint|route)\s+(publi[cq]u?e?|public)\b/i },
  {
    category: "deletion",
    pattern:
      /\b(suppression|supprimer|effacer|purger|delete|remove|purge)\s+(d[eu']\s*|des\s+|les\s+|the\s+|all\s+)?(donn[ée]es|data|fichiers?\s+utilisateurs?|user\s+files?|comptes?|accounts?|historique|history|backups?|sauvegardes?)\b/i,
  },
  { category: "deletion", pattern: /\brm\s+-rf\b/i },
];

/** La catégorie irréversible que trahit le texte d'une décision, ou `null`. */
export function detectIrreversible(text: string): IrreversibleCategory | null {
  for (const { category, pattern } of PATTERNS) if (pattern.test(text)) return category;
  return null;
}

export type DecisionInput = {
  question: string;
  options: string[];
  chosen: string;
  rationale: string;
  /** La situation qui pose la question, lisible sans la session (Markdown). */
  context: string;
  /** Ce qu'emporte chaque option, dans l'ordre de `options` ; vide si l'agent ne l'a pas dit. */
  impacts: string[];
  category: DecisionCategory;
  /** Les numéros des décisions du run dont ce choix découle. */
  dependsOn: number[];
};

export type DecisionPlan =
  | { kind: "checkpoint"; input: DecisionInput }
  | { kind: "escalate"; input: DecisionInput; category: IrreversibleCategory; hardened: boolean };

export type DecisionParse = { ok: true; plan: DecisionPlan } | { ok: false; error: string };

/** La catégorie déclarée, ou `null` si elle n'est pas du vocabulaire. */
function categoryOf(value: unknown): DecisionCategory | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "reversible":
    case "clarification":
    case "schema":
    case "public_api":
    case "deletion":
      return value;
    default:
      return null;
  }
}

/** La catégorie si elle s'escalade, `null` si un checkpoint suffit. */
function irreversibleOf(category: DecisionCategory): IrreversibleCategory | null {
  switch (category) {
    case "reversible":
    case "clarification":
      return null;
    case "schema":
    case "public_api":
    case "deletion":
      return category;
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Les numéros cités par `dependsOn`, triés sans doublon ; `null` si la liste n'en est pas une. */
function dependsOnOf(value: unknown): number[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const seqs: number[] = [];
  for (const n of value) {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return null;
    if (!seqs.includes(n)) seqs.push(n);
  }
  return seqs.sort((a, b) => a - b);
}

/** Les impacts, un par option ; `null` si la liste n'en est pas une ou ne suit pas les options. */
function impactsOf(value: unknown, options: readonly string[]): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  const impacts = items.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (impacts.length !== options.length || impacts.some((item) => item === "")) return null;
  return impacts;
}

/** Valide l'appel `decision` d'un runner et dit ce que le service en fait. */
export function planDecision(raw: unknown): DecisionParse {
  if (!isRecord(raw))
    return {
      ok: false,
      error: "arguments attendus : { question, context, options, impacts?, chosen, rationale, category, dependsOn? }",
    };
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (question === "") return { ok: false, error: "question est requise" };
  const options = Array.isArray(raw.options)
    ? raw.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim())
    : [];
  if (options.length < OPTIONS_MIN) return { ok: false, error: "au moins deux options sont requises" };
  if (options.length > OPTIONS_MAX)
    return { ok: false, error: `au plus ${OPTIONS_MAX} options : garde les plus plausibles` };
  if (new Set(options).size !== options.length) return { ok: false, error: "options : deux options identiques" };
  const chosen = typeof raw.chosen === "string" ? raw.chosen.trim() : "";
  if (!options.includes(chosen)) return { ok: false, error: "chosen doit reprendre une des options mot pour mot" };
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (rationale === "") return { ok: false, error: "rationale est requise : une décision sans raison sera rouverte" };
  const context = typeof raw.context === "string" ? raw.context.trim() : "";
  if (context.length < CONTEXT_MIN)
    return {
      ok: false,
      error:
        "context est requis : la situation en quelques phrases (la feature, l'endroit du code, ce qui pose la question, l'enjeu), lisible par quelqu'un qui n'a pas suivi la session",
    };
  const category = categoryOf(raw.category);
  if (category === null) return { ok: false, error: `category : ${DECISION_CATEGORIES.join(" | ")}` };
  const impacts = impactsOf(raw.impacts, options);
  if (impacts === null)
    return { ok: false, error: "impacts : une conséquence par option, non vide, dans l'ordre des options" };
  const dependsOn = dependsOnOf(raw.dependsOn);
  if (dependsOn === null)
    return { ok: false, error: "dependsOn : la liste des numéros (#N) des décisions dont ce choix découle" };
  const input: DecisionInput = { question, options, chosen, rationale, context, impacts, category, dependsOn };
  const declared = irreversibleOf(category);
  if (declared !== null && impacts.length === 0)
    return {
      ok: false,
      error: "impacts est requis pour une escalade : l'humain tranche entre des conséquences, pas entre des libellés",
    };
  if (declared !== null) return { ok: true, plan: { kind: "escalate", input, category: declared, hardened: false } };
  // Le contexte décrit la situation, pas le choix : il n'entre pas dans la détection (faux positifs).
  const detected = detectIrreversible([question, chosen, rationale].join("\n"));
  if (detected)
    return {
      ok: true,
      plan: { kind: "escalate", input: { ...input, category: detected }, category: detected, hardened: true },
    };
  return { ok: true, plan: { kind: "checkpoint", input } };
}

/** Le message du commit WIP d'une décision : le checkpoint N, retrouvable après un rebase. */
export function checkpointMessage(
  runId: string,
  seq: number,
  input: Pick<DecisionInput, "question" | "chosen" | "rationale">,
): string {
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
export function dependentsOf(
  decisions: readonly { seq: number; dependsOn: readonly number[] }[],
  seq: number,
): number[] {
  const fallen = new Set([seq]);
  for (const decision of [...decisions].sort((a, b) => a.seq - b.seq)) {
    if (decision.seq > seq && decision.dependsOn.some((n) => fallen.has(n))) fallen.add(decision.seq);
  }
  fallen.delete(seq);
  return [...fallen];
}
