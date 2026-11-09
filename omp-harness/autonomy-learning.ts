// L'apprentissage borné de l'autonomie par paliers : le harness PROPOSE de monter ou de baisser la
// porte d'une règle ; il ne change jamais une règle seul (aucune écriture : tout se calcule à la lecture).
//
// Un passage est une attente que la porte pouvait lever (`validation.liftable`, constaté par le serveur
// au moment du geste) validée par un humain ou par l'autonomie, ou refusée par un humain. Le taux de
// corrections d'un groupe (dépôt, type, porte) se compte PAR RUN : la part des runs du groupe corrigés au
// moins une fois dans la fenêtre — refus humain, revert (porte revue), validation prise seule renversée.
import type { AutonomyGate, AutonomyRule, GateMode, WorkKind } from "./autonomy-rules.ts";
import { AUTONOMY_BY } from "./autonomy-rules.ts";
import type { HarnessConfig } from "./config.ts";
import type { RepoFilter, Store } from "./db.ts";

export type AutonomyChange = { path: string; value: unknown };

export type AutonomyProposal = {
  repo: string;
  kind: WorkKind;
  gate: AutonomyGate;
  direction: "raise" | "lower";
  /** La porte telle que la configuration la règle aujourd'hui. */
  current: "human" | "auto";
  /** Le rang (à partir de 1) de la règle qui la règle, `null` : aucune règle ne s'applique. */
  rule: number | null;
  runs: number;
  passages: number;
  corrections: number;
  rate: number;
  /** La modification de configuration suggérée (l'humain la fait lui-même). */
  changes: AutonomyChange[];
};

const DAY_MS = 86_400_000;

type Group = {
  repo: string;
  kind: WorkKind;
  gate: AutonomyGate;
  passages: number;
  runs: Set<string>;
  refused: Set<string>;
};

/** La règle qui règle la porte de ce type : la première de même `kind` qui peut s'appliquer à cette porte. */
export function ruleFor(
  rules: readonly AutonomyRule[],
  kind: WorkKind,
  gate: AutonomyGate,
): { rule: AutonomyRule; rank: number } | null {
  for (const [index, rule] of rules.entries()) {
    if (rule.match.kind !== kind) continue;
    const idle =
      rule.match.paths === undefined &&
      rule.match.maxDiffLines === undefined &&
      !Object.values(rule.require).some(Boolean);
    if (gate === "review" || idle) return { rule, rank: index + 1 };
  }
  return null;
}

/** Une retouche des règles d'un dépôt : la porte d'une règle, son seuil de diff, ou une règle ajoutée en fin de liste. */
type RuleEdit =
  | { op: "gate"; at: number; gate: AutonomyGate; mode: GateMode }
  | { op: "widen"; at: number; maxDiffLines: number }
  | { op: "add"; rule: AutonomyRule };

/**
 * Les retouches qui mettent la porte d'un type en `mode` : la règle qui la règle déjà (`match`) change de
 * porte — et reçoit un seuil de diff utile si sa revue passe en auto —, sinon une règle prudente, en auto
 * sur cette seule porte, est ajoutée.
 */
function editsOf(
  kind: WorkKind,
  gate: AutonomyGate,
  mode: GateMode,
  match: { rule: AutonomyRule; rank: number } | null,
  reviewMaxDiffLines: number,
): RuleEdit[] {
  if (match !== null) {
    const at = match.rank - 1;
    const wide = match.rule.match.maxDiffLines;
    const widen = mode === "auto" && gate === "review" && (wide === undefined || wide <= reviewMaxDiffLines);
    const widened: RuleEdit[] = widen ? [{ op: "widen", at, maxDiffLines: 2 * reviewMaxDiffLines }] : [];
    return [{ op: "gate", at, gate, mode }, ...widened];
  }
  const specs = gate === "specs";
  return [
    {
      op: "add",
      rule: {
        match: { kind, ...(specs ? {} : { maxDiffLines: 2 * reviewMaxDiffLines }) },
        require: specs ? {} : { reproTest: true, greenChecks: true, proofs: true },
        gates: { specs: specs ? "auto" : "human", review: specs ? "human" : "auto" },
      },
    },
  ];
}

/** La modification de configuration d'une proposition de palier, telle que l'humain la lit (`changes`). */
export function changesOf(
  proposal: Pick<AutonomyProposal, "repo" | "kind" | "gate" | "direction" | "rule">,
  match: { rule: AutonomyRule; rank: number } | null,
  reviewMaxDiffLines: number,
): AutonomyChange[] {
  const base = `repos.${proposal.repo}.autonomy.rules`;
  const mode: GateMode = proposal.direction === "lower" ? "human" : "auto";
  return editsOf(proposal.kind, proposal.gate, mode, match, reviewMaxDiffLines).map((edit): AutonomyChange => {
    if (edit.op === "add") return { path: `${base}[+]`, value: edit.rule };
    return edit.op === "gate"
      ? { path: `${base}[${edit.at}].gates.${edit.gate}`, value: edit.mode }
      : { path: `${base}[${edit.at}].match.maxDiffLines`, value: edit.maxDiffLines };
  });
}

/** Le réglage d'une porte d'un type de travail, écrit par l'humain (`POST /v1/autonomy/rules`). */
export type AutonomyRuleInput = { repo: string; kind: WorkKind; gate: AutonomyGate; mode: GateMode };

/**
 * Les règles d'un dépôt une fois la porte réglée par l'humain : la même modification que celle d'une
 * proposition de palier (`changesOf`), appliquée à une copie. Mettre en `human` une porte qu'aucune
 * règle ne règle ne change rien : elle est déjà à l'humain.
 */
export function rulesWith(
  rules: readonly AutonomyRule[],
  input: Pick<AutonomyRuleInput, "kind" | "gate" | "mode">,
  reviewMaxDiffLines: number,
): AutonomyRule[] {
  const next = structuredClone([...rules]);
  const match = ruleFor(rules, input.kind, input.gate);
  if (match === null && input.mode === "human") return next;
  for (const edit of editsOf(input.kind, input.gate, input.mode, match, reviewMaxDiffLines)) {
    if (edit.op === "add") {
      next.push(edit.rule);
      continue;
    }
    const rule = next[edit.at];
    if (rule === undefined) throw new Error(`règle ${edit.at + 1} introuvable`);
    if (edit.op === "gate") rule.gates[edit.gate] = edit.mode;
    else rule.match.maxDiffLines = edit.maxDiffLines;
  }
  return next;
}

/**
 * Les propositions de palier des dépôts que le lecteur voit (`repos`, `null` : tous), sur la fenêtre
 * `autonomyLearning.windowDays`. Fonction pure sur le store : rien n'est écrit, la configuration reste telle quelle.
 */
export function autonomyProposals(
  store: Store,
  config: HarnessConfig,
  now: number,
  repos: RepoFilter = null,
): AutonomyProposal[] {
  const { windowDays, minRuns, raiseMaxRate, lowerMinRate } = config.autonomyLearning;
  const since = now - windowDays * DAY_MS;
  const inWindow = (at: number | null) => at !== null && at >= since && at <= now;
  const kinds = new Map(store.listRuns({ repos }).map((run) => [run.id, run.kind]));

  const groups = new Map<string, Group>();
  for (const event of store.eventsOfType("validation", repos)) {
    const { gate: wait, approve, liftable, by, pilot } = event.payload;
    const kind = event.runId === null ? null : (kinds.get(event.runId) ?? null);
    if (!inWindow(event.at) || event.runId === null || kind === null || liftable !== true) continue;
    if (wait !== "specs" && wait !== "verdict") continue;
    const gate: AutonomyGate = wait === "specs" ? "specs" : "review";
    if (gate === "specs" && config.review.specsGate !== true) continue;
    const byAutonomy = typeof by === "string" && by.startsWith(AUTONOMY_BY);
    // Le pilote d'un audit n'est pas un humain : ses gestes ne comptent pas.
    if (pilot === true && !byAutonomy) continue;
    if (approve !== true && byAutonomy) continue;
    const key = `${event.repo}\u0000${kind}\u0000${gate}`;
    const group = groups.get(key) ?? {
      repo: event.repo ?? "",
      kind,
      gate,
      passages: 0,
      runs: new Set(),
      refused: new Set(),
    };
    group.passages += 1;
    group.runs.add(event.runId);
    if (approve !== true) group.refused.add(event.runId);
    groups.set(key, group);
  }

  const reverted = new Set(
    store
      .eventsOfType("reverted", repos)
      .filter((e) => inWindow(e.at))
      .map((e) => e.runId),
  );
  const overturned = store
    .listDecisions({ status: ["reversed"], repos })
    .filter((d) => d.autonomy !== null && inWindow(d.decidedAt));

  const proposals: AutonomyProposal[] = [];
  for (const group of groups.values()) {
    const corrected = [...group.runs].filter(
      (runId) =>
        group.refused.has(runId) ||
        (group.gate === "review" && reverted.has(runId)) ||
        overturned.some((d) => d.runId === runId && d.autonomy?.gate === group.gate),
    ).length;
    const runs = group.runs.size;
    if (runs < minRuns) continue;
    const rate = corrected / runs;
    const declared = config.repos.find((r) => r.name === group.repo);
    if (declared === undefined) continue;
    const match = ruleFor(declared.autonomy?.rules ?? [], group.kind, group.gate);
    const current = match?.rule.gates[group.gate] ?? "human";
    const direction: AutonomyProposal["direction"] | null =
      current === "auto" ? (rate >= lowerMinRate ? "lower" : null) : rate <= raiseMaxRate ? "raise" : null;
    if (direction === null) continue;
    const head = { repo: group.repo, kind: group.kind, gate: group.gate, direction, rule: match?.rank ?? null };
    proposals.push({
      ...head,
      current,
      runs,
      passages: group.passages,
      corrections: corrected,
      rate,
      changes: changesOf(head, match, config.review.maxDiffLines),
    });
  }
  return proposals.sort(
    (a, b) => a.repo.localeCompare(b.repo) || a.kind.localeCompare(b.kind) || a.gate.localeCompare(b.gate),
  );
}
