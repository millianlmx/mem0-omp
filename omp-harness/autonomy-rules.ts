// Les règles d'autonomie par paliers d'un dépôt : leur forme, leur validation au
// chargement de la configuration et la règle qui correspond à un run.
//
// Module feuille (aucun import de `config.ts`) : `db/` et `config.ts` le lisent.
// Le nom « autonomie » désigne déjà le poste de travail (workstation.ts) : ici, une
// règle est une `AutonomyRule`, jamais `Autonomy` seul.

export const WORK_KINDS = ["bug", "feature", "docs", "deps", "test"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type AutonomyGate = "specs" | "review";
export type GateMode = "human" | "auto";

/** Le début de `actor.by` d'une validation prise seule : `autonomie:<dépôt>#<rang>`. */
export const AUTONOMY_BY = "autonomie:";

export type AutonomyRule = {
  match: { kind: WorkKind; maxDiffLines?: number; paths?: string[]; labels?: string[] };
  require: { reproTest?: boolean; greenChecks?: boolean; proofs?: boolean };
  gates: { specs: GateMode; review: GateMode };
};

/** La règle retenue pour une validation prise seule, telle qu'elle est inscrite à la décision. */
export type RuleSnapshot = { rank: number; match: AutonomyRule["match"]; require: AutonomyRule["require"]; gates: AutonomyRule["gates"] };

/** Ce qui est gardé d'une validation prise seule : la porte, la règle et les preuves constatées. */
export type AutonomyProof = { gate: AutonomyGate; rule: RuleSnapshot; proofs: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).some((key) => !allowed.includes(key));
}

function checkMatch(where: string, value: unknown): AutonomyRule["match"] {
  if (!isRecord(value)) throw new Error(`${where}.match.kind : ${WORK_KINDS.join(" | ")}`);
  const kind = value.kind;
  if (typeof kind !== "string" || !(WORK_KINDS as readonly string[]).includes(kind))
    throw new Error(`${where}.match.kind : ${WORK_KINDS.join(" | ")}`);
  if (unknownKey(value, ["kind", "maxDiffLines", "paths", "labels"]))
    throw new Error(`${where}.match : kind, maxDiffLines?, paths?, labels?`);
  const match: AutonomyRule["match"] = { kind: kind as WorkKind };
  if (value.maxDiffLines !== undefined) {
    if (typeof value.maxDiffLines !== "number" || !Number.isInteger(value.maxDiffLines) || value.maxDiffLines < 1)
      throw new Error(`${where}.match.maxDiffLines : entier ≥ 1`);
    match.maxDiffLines = value.maxDiffLines;
  }
  if (value.paths !== undefined) {
    const paths = value.paths;
    const bad =
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some(
        (p) => typeof p !== "string" || p === "" || p.startsWith("/") || p.split("/").some((segment) => segment === ".."),
      );
    if (bad) throw new Error(`${where}.match.paths : chemins relatifs du dépôt (liste non vide)`);
    match.paths = [...(paths as string[])];
  }
  if (value.labels !== undefined) {
    const labels = value.labels;
    if (!Array.isArray(labels) || labels.length === 0 || labels.some((l) => typeof l !== "string" || l === ""))
      throw new Error(`${where}.match.labels : liste de labels non vides`);
    match.labels = [...(labels as string[])];
  }
  return match;
}

function checkRequire(where: string, value: unknown): AutonomyRule["require"] {
  if (value === undefined) return {};
  const keys = ["reproTest", "greenChecks", "proofs"] as const;
  if (!isRecord(value) || unknownKey(value, keys) || Object.values(value).some((v) => typeof v !== "boolean"))
    throw new Error(`${where}.require : { reproTest?, greenChecks?, proofs? } booléens`);
  return { ...(value as AutonomyRule["require"]) };
}

function checkGates(where: string, value: unknown): AutonomyRule["gates"] {
  const gates: AutonomyRule["gates"] = { specs: "human", review: "human" };
  if (value === undefined) return gates;
  if (!isRecord(value) || unknownKey(value, ["specs", "review"])) throw new Error(`${where}.gates : { specs?, review? }`);
  for (const gate of ["specs", "review"] as const) {
    const mode = value[gate];
    if (mode === undefined) continue;
    if (mode !== "human" && mode !== "auto") throw new Error(`${where}.gates.${gate} : human | auto`);
    gates[gate] = mode;
  }
  return gates;
}

/** Valide `repos[].autonomy` et le rend normalisé (`require` toujours présent, deux portes toujours posées). */
export function checkAutonomy(where: string, value: unknown): { rules: AutonomyRule[] } {
  if (!isRecord(value)) throw new Error(`${where} : { rules: [...] }`);
  const rules = value.rules ?? [];
  if (!Array.isArray(rules)) throw new Error(`${where}.rules : liste de règles`);
  return {
    rules: rules.map((rule, index) => {
      const at = `${where}.rules[${index}]`;
      if (!isRecord(rule) || unknownKey(rule, ["match", "require", "gates"]))
        throw new Error(`${at} : { match, require?, gates? }`);
      return { match: checkMatch(at, rule.match), require: checkRequire(at, rule.require), gates: checkGates(at, rule.gates) };
    }),
  };
}

export type RuleFacts = {
  kind: WorkKind | null;
  labels: string[];
  touchedFiles?: string[];
  diffLines?: number;
};

function under(file: string, path: string): boolean {
  const base = path.replace(/\/+$/, "");
  return file === base || file.startsWith(`${base}/`);
}

/**
 * La première règle qui correspond au run, dans l'ordre déclaré, ou `null`. Un run sans type
 * n'en a aucune. À la porte `specs` (rien n'est encore écrit), seules `kind` et `labels` se
 * comparent : une règle qui porte `paths`, `maxDiffLines` ou une exigence ne correspond pas.
 */
export function firstRule(
  rules: readonly AutonomyRule[],
  facts: RuleFacts,
  gate: AutonomyGate,
): { rule: AutonomyRule; rank: number } | null {
  if (facts.kind === null) return null;
  for (const [index, rule] of rules.entries()) {
    const { match } = rule;
    if (match.kind !== facts.kind) continue;
    if (!(match.labels ?? []).every((label) => facts.labels.includes(label))) continue;
    if (gate === "specs") {
      if (match.paths !== undefined || match.maxDiffLines !== undefined || Object.values(rule.require).some(Boolean))
        continue;
    } else {
      const files = facts.touchedFiles ?? [];
      if (match.paths !== undefined && (files.length === 0 || !files.every((f) => match.paths?.some((p) => under(f, p)))))
        continue;
      if (match.maxDiffLines !== undefined && (facts.diffLines ?? Number.POSITIVE_INFINITY) > match.maxDiffLines) continue;
    }
    return { rule, rank: index + 1 };
  }
  return null;
}
