// Le contexte de conduite d'une feature lancée par /project ou /audit (S-6, S-7,
// S-8) : le BRIEF durable validé avec le plan ou la proposition, et le JOURNAL
// des décisions déjà prises. Deux fichiers hors du lot, sans migration : absents,
// il n'y a ni brief ni journal.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";


/** D'où vient une décision : le contexte (brief, journal), l'arbitre, l'utilisateur. */
export type DecisionSource = "contexte" | "arbitrage" | "utilisateur";

export type JournalKind = "question" | "jalon" | "quota";

export type JournalEntry = {
  version: 1;
  at: number;
  slug: string;
  phase: PipelinePhase;
  kind: JournalKind;
  question: string;
  answer: string;
  source: DecisionSource;
  context: string | null;
};

/** Les cinq rubriques d'un brief, dans l'ordre du gabarit. */
export type BriefFields = {
  title: string;
  purpose: string;
  function: string;
  decisions: string[];
  constraints: string[];
  nonGoals: string[];
};

/** Les entrées du journal injectées dans un contexte d'étape (S-8). */
export const JOURNAL_CONTEXT_MAX = 50;

export const BRIEF_SECTIONS = ["But", "Fonction", "Décisions", "Contraintes", "Non-objectifs"] as const;

const NO_BRIEF = "(aucun brief validé)";
const NO_DECISION = "(aucune décision consignée)";
const NONE_ITEM = "- (aucune)";


// --- le brief (S-6) ----------------------------------------------------------

/** `sha1(path.resolve(contextKey)).slice(0,16)` : la règle du battement de relais (store.ts). */
export function contextIdOf(contextKey: string): string {
  return crypto.createHash("sha1").update(path.resolve(contextKey)).digest("hex").slice(0, 16);
}


export function briefPathFor(stateDir: string, contextKey: string): string {
  return path.join(stateDir, "briefs", `${contextIdOf(contextKey)}.md`);
}


function renderList(items: readonly string[]): string {
  const kept = items.map((item) => item.trim()).filter((item) => item !== "");
  return kept.length === 0 ? NONE_ITEM : kept.map((item) => `- ${item}`).join("\n");
}


/** Le gabarit du brief (S-6) : titre puis les cinq rubriques, dans l'ordre. */
export function renderBrief(fields: BriefFields): string {
  return [
    `# Brief — ${fields.title}`,
    "",
    "## But",
    fields.purpose.trim(),
    "",
    "## Fonction",
    fields.function.trim(),
    "",
    "## Décisions",
    renderList(fields.decisions),
    "",
    "## Contraintes",
    renderList(fields.constraints),
    "",
    "## Non-objectifs",
    renderList(fields.nonGoals),
    "",
  ].join("\n");
}


/** Le corps d'une rubrique `## <name>` (jusqu'à la rubrique `## ` suivante), `null` si elle manque. */
function rubricBody(text: string, name: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    body.push(line);
  }
  return body.join("\n").trim();
}


/** La première rubrique absente d'un brief, `null` s'il est complet (S-6 « brief incomplet »). */
export function briefRubricsMissing(text: string): string | null {
  for (const name of BRIEF_SECTIONS) {
    if (rubricBody(text, name) === null) return name;
  }
  return null;
}


function parseList(body: string | null): string[] {
  if (body === null) return [];
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    .filter((line) => line !== "" && line !== "(aucune)");
}


/** Les rubriques d'un brief relu (pour un amendement). Une rubrique absente vaut vide. */
export function parseBrief(text: string, fallbackTitle: string): BriefFields {
  const heading = /^#\s+Brief\s+—\s+(.+)$/m.exec(text);
  return {
    title: heading ? (heading[1] as string).trim() : fallbackTitle,
    purpose: rubricBody(text, "But") ?? "",
    function: rubricBody(text, "Fonction") ?? "",
    decisions: parseList(rubricBody(text, "Décisions")),
    constraints: parseList(rubricBody(text, "Contraintes")),
    nonGoals: parseList(rubricBody(text, "Non-objectifs")),
  };
}


/** Les rubriques-listes FACULTATIVES de `project_amend` : seules celles qui sont présentes. */
export function checkBriefPatch(
  record: Record<string, unknown>,
): { ok: true; patch: Partial<Pick<BriefInput, "decisions" | "constraints" | "nonGoals">> } | { ok: false; error: string } {
  const patch: Partial<Pick<BriefInput, "decisions" | "constraints" | "nonGoals">> = {};
  for (const key of ["decisions", "constraints", "nonGoals"] as const) {
    if (record[key] === undefined) continue;
    const list = stringList(record[key], key);
    if (!list.ok) return list;
    patch[key] = list.items;
  }
  return { ok: true, patch };
}


/** Les cinq rubriques d'un brief hors titre : ce que `project_plan` et `audit_propose` transportent. */
export type BriefInput = Omit<BriefFields, "title">;

const BRIEF_FIELD_MAX = 20_000;

function stringList(raw: unknown, label: string): { ok: true; items: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    return { ok: false, error: `Error: ${label} must be a list of strings` };
  }
  const items = (raw as string[]).map((item) => item.trim().slice(0, BRIEF_FIELD_MAX)).filter((item) => item !== "");
  return { ok: true, items };
}

/** Les trois listes OBLIGATOIRES d'un brief (`decisions`, `constraints`, `nonGoals`) lues dans `record`. */
export function checkBriefLists(
  record: Record<string, unknown>,
  prefix = "",
): { ok: true; lists: Pick<BriefInput, "decisions" | "constraints" | "nonGoals"> } | { ok: false; error: string } {
  const decisions = stringList(record.decisions, `${prefix}decisions`);
  if (!decisions.ok) return decisions;
  const constraints = stringList(record.constraints, `${prefix}constraints`);
  if (!constraints.ok) return constraints;
  const nonGoals = stringList(record.nonGoals, `${prefix}nonGoals`);
  if (!nonGoals.ok) return nonGoals;
  return { ok: true, lists: { decisions: decisions.items, constraints: constraints.items, nonGoals: nonGoals.items } };
}

/** Le brief OBLIGATOIRE de `audit_propose` : `{purpose, function, decisions, constraints, nonGoals}`. */
export function checkBrief(raw: unknown): { ok: true; brief: BriefInput } | { ok: false; error: string } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (record === null) return { ok: false, error: "Error: brief is missing" };
  const purpose = typeof record.purpose === "string" ? record.purpose.trim() : "";
  if (purpose === "") return { ok: false, error: "Error: brief.purpose is empty" };
  const fn = typeof record.function === "string" ? record.function.trim() : "";
  if (fn === "") return { ok: false, error: "Error: brief.function is empty" };
  const lists = checkBriefLists(record, "brief.");
  if (!lists.ok) return lists;
  return {
    ok: true,
    brief: { purpose: purpose.slice(0, BRIEF_FIELD_MAX), function: fn.slice(0, BRIEF_FIELD_MAX), ...lists.lists },
  };
}

/** Le contexte minimal d'un éditeur : un dialogue `editor` de l'hôte. */
export type BriefEditorCtx = {
  ui: { editor(title: string, prefill?: string, options?: { signal?: AbortSignal }): Promise<string | undefined> };
};

/**
 * L'éditeur du brief (S-6) : rouvert avec le texte saisi et la notice
 * `brief incomplet : rubrique « <X> » absente` tant qu'une des cinq rubriques
 * manque. Échap (ou signal tombé) rend `null` : rien n'est écrit.
 */
export async function editBrief(
  ctx: BriefEditorCtx,
  title: string,
  prefill: string,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  let heading = title;
  let text = prefill;
  for (;;) {
    const typed = await ctx.ui.editor(heading, text, { signal });
    if (signal?.aborted === true || typed === undefined) return null;
    const missing = briefRubricsMissing(typed);
    if (missing === null) return typed;
    heading = `brief incomplet : rubrique « ${missing} » absente\n${title}`;
    text = typed;
  }
}


/** Écrit le texte EXACT validé par l'utilisateur, atomiquement (temporaire puis `rename`). */
export function writeBrief(stateDir: string, contextKey: string, text: string): void {
  const file = briefPathFor(stateDir, contextKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}


/** Le brief d'un contexte, relu depuis le fichier à chaque usage ; `null` s'il est absent ou illisible. */
export function readBrief(stateDir: string, contextKey: string): string | null {
  try {
    return fs.readFileSync(briefPathFor(stateDir, contextKey), "utf8");
  } catch {
    return null;
  }
}


// --- le journal (S-7) --------------------------------------------------------

export function journalPathFor(stateDir: string, repoKey: string): string {
  return path.join(stateDir, "journal", `${repoKey}.jsonl`);
}


/** Ajoute UNE ligne complète au journal du dépôt. Ne jette jamais : une écriture ratée est silencieuse. */
export function appendJournal(
  stateDir: string,
  repoKey: string,
  entry: Omit<JournalEntry, "version" | "at"> & { at: number },
): void {
  try {
    const file = journalPathFor(stateDir, repoKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line: JournalEntry = { version: 1, ...entry };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    // le journal est une aide à la décision : jamais une raison de refuser la décision
  }
}


const PHASES: ReadonlySet<string> = new Set(["req", "specs", "impl", "review", "release"]);
const KINDS: ReadonlySet<string> = new Set(["question", "jalon", "quota"]);
const SOURCES: ReadonlySet<string> = new Set(["contexte", "arbitrage", "utilisateur"]);


function asEntry(raw: unknown): JournalEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.at !== "number" || typeof r.slug !== "string") return null;
  if (typeof r.phase !== "string" || !PHASES.has(r.phase)) return null;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
  if (typeof r.question !== "string" || typeof r.answer !== "string") return null;
  if (typeof r.source !== "string" || !SOURCES.has(r.source)) return null;
  return {
    version: 1,
    at: r.at,
    slug: r.slug,
    phase: r.phase as PipelinePhase,
    kind: r.kind as JournalKind,
    question: r.question,
    answer: r.answer,
    source: r.source as DecisionSource,
    context: typeof r.context === "string" ? r.context : null,
  };
}


/** Les entrées d'une feature, dans l'ordre d'écriture ; les lignes illisibles sont ignorées. */
export function journalFor(stateDir: string, repoKey: string, slug: string): JournalEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(journalPathFor(stateDir, repoKey), "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = asEntry(JSON.parse(line));
      if (entry !== null && entry.slug === slug) out.push(entry);
    } catch {
      // ligne illisible : ignorée
    }
  }
  return out;
}


// --- le bloc de contexte d'une étape (S-8) -----------------------------------

/** Une entrée du journal au format de S-8 : `- [/<phase>] Q : <question> → R : <réponse> (source : <source>)`. */
export function journalLine(e: JournalEntry): string {
  return `- [/${e.phase}] Q : ${e.question} → R : ${e.answer} (source : ${e.source})`;
}


/** Le bloc exact injecté dans le prompt de tout run d'une feature AVEC contexte. */
export function contextBlock(input: { stateDir: string; repoKey: string; slug: string; contextKey: string }): string {
  const brief = readBrief(input.stateDir, input.contextKey);
  const entries = journalFor(input.stateDir, input.repoKey, input.slug);
  const omitted = Math.max(0, entries.length - JOURNAL_CONTEXT_MAX);
  const lines = entries
    .slice(omitted)
    .map(journalLine);
  if (omitted > 0) lines.unshift(`- (${omitted} décisions plus anciennes omises)`);
  if (lines.length === 0) lines.push(`- ${NO_DECISION}`);
  return [
    "[contexte de conduite] Brief et décisions déjà prises pour cette feature : appuie-toi dessus avant de poser une question.",
    "",
    brief !== null && brief.trim() !== "" ? brief.trim() : NO_BRIEF,
    "",
    `## Journal de la feature ${input.slug}`,
    ...lines,
  ].join("\n");
}
