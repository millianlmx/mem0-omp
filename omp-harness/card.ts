// La carte de décision d'une escalade : ce que l'humain lit en 30 secondes, sans connaître le code.
// Les règles vivent ici, dans le serveur, jamais dans le seul prompt : `parseCard` refuse une carte
// non conforme et dit quoi reformuler. `buildCard` en tire le schéma de compréhension (établi →
// ambiguïté → options → impacts), en données structurées : jamais d'image ni de Mermaid.
import { isRecord } from "./config.ts";
import { redact } from "./session-feed.ts";

/** Une `headline` plus longue ne se lit plus d'un coup d'œil. */
export const HEADLINE_WORDS_MAX = 15;
/** Une ligne (`stake`, `established`, `impact`) : ni retour à la ligne ni roman. */
export const CARD_LINE_MAX = 240;
/** Le schéma tient en 12 nœuds : 1 établi + 1 ambiguïté + 4 options + 4 impacts = 10 au plus. */
export const CARD_SCHEMA_NODES_MAX = 12;

export const CARD_COSTS = ["faible", "moyen", "fort"] as const;
export type CardCost = (typeof CARD_COSTS)[number];

export const CARD_CONFIDENCES = ["faible", "moyenne", "forte"] as const;
export type CardConfidence = (typeof CARD_CONFIDENCES)[number];

export type CardOption = { label: string; impact: string; reversible: boolean; cost?: CardCost };

/** Ce que l'agent écrit : la carte avant relecture, avec le texte du nœud « établi ». */
export type CardDraft = {
  headline: string;
  stake: string;
  established: string;
  options: CardOption[];
  /** Le libellé de l'option recommandée. */
  recommended: string;
  confidence: CardConfidence;
};

export type SchemaNodeKind = "established" | "ambiguity" | "option" | "impact";
export type SchemaNode = { id: string; kind: SchemaNodeKind; label: string; recommended: boolean };
export type SchemaEdge = { from: string; to: string };

/** La carte servie : champs d'API publique, ajoutés à l'escalade (un client ancien lit toujours `question`, `options`, `context`). */
export type DecisionCard = {
  headline: string;
  stake: string;
  options: CardOption[];
  recommended: string;
  confidence: CardConfidence;
  /** `true` : le relecteur « humain pressé » a lu la carte ; `false` : elle part telle que l'agent l'a écrite. */
  reviewed: boolean;
  schema: { nodes: SchemaNode[]; edges: SchemaEdge[] };
};

/** Les champs de l'appel `decision` qui disent « voici une carte » : un seul suffit pour l'exiger entière. */
const CARD_FIELDS = ["headline", "stake", "established", "confidence", "recommended"] as const;

const EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|json|md|swift|py|rs|go|sql|ya?ml|toml|sh|css|html|java|kt|rb|c|h|cpp|lock|txt|xml|plist";
const FILE_NAME = new RegExp(`^[\\w@-]+(?:\\.[\\w-]+)*\\.(?:${EXTENSIONS})$`, "i");

/** Un mot qui est un chemin de fichier : absolu, relatif, à plusieurs segments, ou un nom avec extension. */
function isPathLike(word: string): boolean {
  const bare = word.replace(/^[("'`]+|[)"'`,;:.!?]+$/g, "");
  if (bare === "") return false;
  if (/^(?:~|\.{1,2})?\//.test(bare) || /^[A-Za-z]:\\/.test(bare)) return bare.length > 1;
  if (bare.includes("/")) {
    const segments = bare.split("/").filter((part) => part !== "");
    const last = segments.at(-1) ?? "";
    return segments.length >= 3 || /\.\w+$/.test(last);
  }
  return FILE_NAME.test(bare);
}

/** Un mot qui est du code : appel, `snake_case`, `camelCase`, `::`. */
function isCodeLike(word: string): boolean {
  return /\w\(\)?$/.test(word) || /\w_\w/.test(word) || /^[a-z]+[A-Z]\w*$/.test(word) || word.includes("::");
}

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

/** Le nom de la règle qu'une ligne de carte viole (`stake`, `established`, `impact`, `headline`), ou `null`. */
function lineProblem(name: string, text: string, paths: boolean): string | null {
  if (text.trim() === "") return `${name} est requis : une ligne, lisible sans connaître le code`;
  if (/[\r\n]/.test(text)) return `${name} tient sur une seule ligne`;
  if (text.length > CARD_LINE_MAX) return `${name} : ${CARD_LINE_MAX} caractères au plus`;
  if (paths && words(text).some(isPathLike))
    return `${name} : pas de chemin de fichier (dis la chose, pas où elle se trouve)`;
  return null;
}

/** Les règles de `headline` : 15 mots au plus, ni chemin de fichier ni code. */
export function headlineProblem(text: string): string | null {
  const line = lineProblem("headline", text, true);
  if (line !== null) return line;
  const list = words(text);
  if (list.length > HEADLINE_WORDS_MAX)
    return `headline : ${HEADLINE_WORDS_MAX} mots au plus (${list.length} ici) — une question, pas un paragraphe`;
  if (text.includes("`") || list.some(isCodeLike))
    return "headline : pas de `code` ni d'identifiant (fonction, variable, nom de table) — dis-le en mots";
  return null;
}

/** Les règles de `stake` et `established` : une ligne, sans chemin. */
export function stakeProblem(name: "stake" | "established", text: string): string | null {
  return lineProblem(name, text, true);
}

/** Les règles d'un `impact` : une ligne non vide. */
export function impactProblem(index: number, text: string): string | null {
  return lineProblem(`options[${index}].impact`, text, false);
}

/** Vrai si l'appel `decision` porte (au moins en partie) une carte. */
export function carriesCard(raw: Record<string, unknown>): boolean {
  if (CARD_FIELDS.some((field) => raw[field] !== undefined && raw[field] !== null)) return true;
  return Array.isArray(raw.options) && raw.options.some(isRecord);
}

/** Dit quelle règle viole une carte ENTIÈRE (rien : `null`). Rejuge aussi la réécriture du relecteur. */
export function cardProblem(draft: CardDraft): string | null {
  const headline = headlineProblem(draft.headline);
  if (headline !== null) return headline;
  const stake = stakeProblem("stake", draft.stake);
  if (stake !== null) return stake;
  const established = stakeProblem("established", draft.established);
  if (established !== null) return established;
  for (const [index, option] of draft.options.entries()) {
    const impact = impactProblem(index, option.impact);
    if (impact !== null) return impact;
  }
  return null;
}

const OPTION_SHAPE = "options : chaque option est { label, impact, reversible, cost? } (cost : faible | moyen | fort)";

function optionOf(raw: unknown, index: number): { ok: true; option: CardOption } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `options[${index}] : ${OPTION_SHAPE}` };
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (label === "") return { ok: false, error: `options[${index}].label est requis` };
  const impact = typeof raw.impact === "string" ? raw.impact.trim() : "";
  if (impact === "")
    return { ok: false, error: `options[${index}] « ${label} » : impact est requis (sa conséquence pour l'humain)` };
  if (typeof raw.reversible !== "boolean")
    return { ok: false, error: `options[${index}] « ${label} » : reversible est requis (true ou false)` };
  const option: CardOption = { label, impact, reversible: raw.reversible };
  if (raw.cost !== undefined && raw.cost !== null) {
    const cost = (CARD_COSTS as readonly unknown[]).includes(raw.cost) ? (raw.cost as CardCost) : null;
    if (cost === null)
      return { ok: false, error: `options[${index}] « ${label} » : cost vaut ${CARD_COSTS.join(" | ")} (ou est omis)` };
    option.cost = cost;
  }
  return { ok: true, option };
}

export type CardParse = { ok: true; draft: CardDraft | null } | { ok: false; error: string };

/**
 * La carte d'un appel `decision`, ou `null` si l'appel n'en porte pas. Une carte entamée doit être
 * entière : le serveur refuse, et dit quoi reformuler.
 */
export function parseCard(raw: Record<string, unknown>): CardParse {
  if (!carriesCard(raw)) return { ok: true, draft: null };
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const list = Array.isArray(raw.options) ? (raw.options as unknown[]) : [];
  const options: CardOption[] = [];
  for (const [index, item] of list.entries()) {
    const parsed = optionOf(item, index);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    options.push(parsed.option);
  }
  const recommended = text(raw.recommended) || text(raw.chosen);
  const confidence = (CARD_CONFIDENCES as readonly unknown[]).includes(raw.confidence)
    ? (raw.confidence as CardConfidence)
    : null;
  if (confidence === null) return { ok: false, error: `confidence : ${CARD_CONFIDENCES.join(" | ")}` };
  if (!options.some((option) => option.label === recommended))
    return { ok: false, error: "recommended doit reprendre le libellé d'une option mot pour mot" };
  const draft: CardDraft = {
    headline: text(raw.headline),
    stake: text(raw.stake),
    established: text(raw.established),
    options,
    recommended,
    confidence,
  };
  const problem = cardProblem(draft);
  return problem === null ? { ok: true, draft } : { ok: false, error: problem };
}

/** Les mêmes textes, masqués (secrets connus et formes reconnues) : la carte part sur le réseau. */
export function maskCard(draft: CardDraft, known: readonly string[]): CardDraft {
  const mask = (text: string): string => redact(text, known);
  return {
    ...draft,
    headline: mask(draft.headline),
    stake: mask(draft.stake),
    established: mask(draft.established),
    options: draft.options.map((option) => ({ ...option, impact: mask(option.impact) })),
  };
}

/** Le schéma de compréhension : établi → ambiguïté → chaque option → son impact, l'option recommandée marquée. */
function schemaOf(draft: CardDraft): DecisionCard["schema"] {
  const nodes: SchemaNode[] = [
    { id: "established", kind: "established", label: draft.established, recommended: false },
    { id: "ambiguity", kind: "ambiguity", label: draft.headline, recommended: false },
  ];
  const edges: SchemaEdge[] = [{ from: "established", to: "ambiguity" }];
  for (const [index, option] of draft.options.entries()) {
    const optionId = `option-${index + 1}`;
    const impactId = `impact-${index + 1}`;
    nodes.push({ id: optionId, kind: "option", label: option.label, recommended: option.label === draft.recommended });
    nodes.push({ id: impactId, kind: "impact", label: option.impact, recommended: false });
    edges.push({ from: "ambiguity", to: optionId }, { from: optionId, to: impactId });
  }
  return { nodes, edges };
}

export function buildCard(draft: CardDraft, reviewed: boolean): DecisionCard {
  return {
    headline: draft.headline,
    stake: draft.stake,
    options: draft.options,
    recommended: draft.recommended,
    confidence: draft.confidence,
    reviewed,
    schema: schemaOf(draft),
  };
}

/**
 * Ce que le relecteur « humain pressé » a rendu : ses réécritures de `headline`, `stake`, `established`
 * et des `impact` (une par option, dans l'ordre), jamais les options. Une réécriture qui viole une règle de
 * la carte jette TOUT : la carte de l'agent part inchangée (`null`).
 */
export function applyReview(draft: CardDraft, raw: Record<string, unknown>): CardDraft | null {
  const next: CardDraft = { ...draft, options: draft.options.map((option) => ({ ...option })) };
  for (const field of ["headline", "stake", "established"] as const) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") return null;
    next[field] = value.trim();
  }
  if (raw.impacts !== undefined && raw.impacts !== null) {
    if (!Array.isArray(raw.impacts) || raw.impacts.length !== draft.options.length) return null;
    for (const [index, impact] of (raw.impacts as unknown[]).entries()) {
      if (typeof impact !== "string") return null;
      (next.options[index] as CardOption).impact = impact.trim();
    }
  }
  return cardProblem(next) === null ? next : null;
}

/**
 * Ce que dit la notification d'un lot d'escalades (ntfy, webhook, alerte push) : la `headline` de la première
 * en titre, son `stake` en corps, suivi de « · +N autres questions » s'il y en a d'autres (décision #2). `null`
 * si la première n'a pas de carte : la notification garde alors son texte d'avant, jamais la question brute.
 */
export function batchLead(items: readonly unknown[]): { headline: string; body: string } | null {
  const first = items[0];
  if (!isRecord(first)) return null;
  const headline = typeof first.question === "string" ? first.question.trim() : "";
  const stake = typeof first.stake === "string" ? first.stake.trim() : "";
  if (headline === "" || stake === "") return null;
  const others = items.length - 1;
  const more = others === 0 ? "" : ` · +${others} ${others === 1 ? "autre question" : "autres questions"}`;
  return { headline, body: `${stake}${more}` };
}

/**
 * La ligne « Ce que fait cette feature : … » en tête de specs.md (une phrase), ou `null` si elle manque ou ne dit
 * rien. Le serveur l'exige à la clôture de /specs : c'est la première ligne de la carte des specs à valider.
 */
export function featureLine(specsMd: string): string | null {
  const line = /^[ \t]*Ce que fait cette feature[ \t]*:[ \t]*(\S.*?)[ \t]*$/im.exec(specsMd)?.[1] ?? "";
  return line.length >= 8 ? line : null;
}
