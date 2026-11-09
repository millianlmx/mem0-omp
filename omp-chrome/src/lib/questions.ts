// Les questions en attente d'omp-harness vues par le popup (session en graphe) : les escalades
// ouvertes de `GET /v1/inbox`, lues d'abord par leur carte (`card` : headline, stake, une ligne
// par option avec son impact) puis par le schéma de bifurcation (`card.schema` : établi →
// ambiguïté → options → impacts). Ce module est pur (ni DOM ni `chrome`) : il lit le JSON du
// serveur et calcule la mise en page du schéma en simples nombres ; le popup en tire un SVG
// construit en code (`createElementNS` + `textContent`), jamais de HTML venu du serveur.

export type QuestionCost = "faible" | "moyen" | "fort";

export type QuestionOption = {
  label: string;
  impact: string;
  reversible: boolean | null;
  cost: QuestionCost | null;
  recommended: boolean;
};

export type SchemaKind = "established" | "ambiguity" | "option" | "impact";
export type SchemaNode = { id: string; kind: SchemaKind; label: string; recommended: boolean };
export type SchemaEdge = { from: string; to: string };

/** Une escalade ouverte, telle que le popup la montre. */
export type PendingQuestion = {
  runId: string;
  feature: string;
  id: number;
  headline: string;
  /** L'enjeu ; vide pour une escalade sans carte (serveur ancien). */
  stake: string;
  options: QuestionOption[];
  schema: { nodes: SchemaNode[]; edges: SchemaEdge[] } | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const COSTS: readonly QuestionCost[] = ["faible", "moyen", "fort"];
const KINDS: readonly SchemaKind[] = ["established", "ambiguity", "option", "impact"];

function schemaOf(raw: unknown): PendingQuestion["schema"] {
  const schema = record(raw);
  if (schema === null) return null;
  const nodes: SchemaNode[] = [];
  for (const item of list(schema.nodes)) {
    const node = record(item);
    const kind = node?.kind;
    if (node === null || typeof kind !== "string" || !KINDS.includes(kind as SchemaKind)) continue;
    const id = text(node.id);
    if (id === "") continue;
    nodes.push({ id, kind: kind as SchemaKind, label: text(node.label), recommended: node.recommended === true });
  }
  const known = new Set(nodes.map((node) => node.id));
  const edges: SchemaEdge[] = [];
  for (const item of list(schema.edges)) {
    const edge = record(item);
    const from = text(edge?.from);
    const to = text(edge?.to);
    if (known.has(from) && known.has(to)) edges.push({ from, to });
  }
  return nodes.length === 0 ? null : { nodes, edges };
}

/** L'escalade lue par sa carte, sinon par ses champs historiques (`question`, `options`, `impacts`). */
export function questionOf(runId: string, feature: string, raw: unknown): PendingQuestion | null {
  const item = record(raw);
  if (item === null || typeof item.id !== "number") return null;
  const card = record(item.card);
  if (card !== null) {
    const recommended = text(card.recommended);
    const options: QuestionOption[] = [];
    for (const entry of list(card.options)) {
      const option = record(entry);
      const label = text(option?.label);
      if (option === null || label === "") continue;
      const cost = COSTS.find((candidate) => candidate === option.cost) ?? null;
      options.push({
        label,
        impact: text(option.impact),
        reversible: typeof option.reversible === "boolean" ? option.reversible : null,
        cost,
        recommended: label === recommended,
      });
    }
    const headline = text(card.headline) || text(item.question);
    return { runId, feature, id: item.id, headline, stake: text(card.stake), options, schema: schemaOf(card.schema) };
  }
  const impacts = list(item.impacts);
  const recommended = text(item.recommended);
  const options = list(item.options)
    .map((label, index) => ({
      label: text(label),
      impact: text(impacts[index]),
      reversible: null,
      cost: null,
      recommended: text(label) !== "" && text(label) === recommended,
    }))
    .filter((option) => option.label !== "");
  return { runId, feature, id: item.id, headline: text(item.question), stake: "", options, schema: null };
}

/** Les escalades ouvertes de la boîte (`GET /v1/inbox`), lot par lot. */
export function pendingQuestions(inbox: unknown): PendingQuestion[] {
  const questions: PendingQuestion[] = [];
  for (const entry of list(record(inbox)?.batches)) {
    const batch = record(entry);
    const run = record(batch?.run);
    const runId = text(run?.id);
    if (batch === null || runId === "") continue;
    const feature = text(run?.title) || text(run?.slug) || runId;
    for (const item of list(batch.items)) {
      if (text(record(item)?.status) !== "" && text(record(item)?.status) !== "open") continue;
      const question = questionOf(runId, feature, item);
      if (question !== null && question.headline !== "") questions.push(question);
    }
  }
  return questions;
}

/** Une ligne par option : sa conséquence, réversible ou non, son coût, la recommandée marquée. */
export function optionLine(option: QuestionOption): string {
  const parts = [option.impact !== "" ? `${option.label} — ${option.impact}` : option.label];
  if (option.reversible === true) parts.push("réversible");
  if (option.reversible === false) parts.push("irréversible");
  if (option.cost !== null) parts.push(`coût ${option.cost}`);
  if (option.recommended) parts.push("recommandée");
  return parts.join(" · ");
}

// ── Schéma de bifurcation ─────────────────────────────────────────────────

export type SchemaBox = {
  id: string;
  kind: SchemaKind;
  /** Les lignes du libellé, coupées pour tenir dans la boîte. */
  lines: string[];
  recommended: boolean;
  /** L'option à envoyer en réponse quand on clique sur la boîte (options seulement). */
  answer: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SchemaLink = { x1: number; y1: number; x2: number; y2: number; recommended: boolean };
export type SchemaLayout = { width: number; height: number; boxes: SchemaBox[]; links: SchemaLink[] };

/** La largeur du schéma dans le popup (px) ; le popup fait 360 px. */
export const SCHEMA_WIDTH = 320;
const LINE_HEIGHT = 13;
const PAD = 6;
const GAP = 10;
const CHARS_PER_PX = 1 / 6.2;

/** Coupe `label` en lignes d'au plus `chars` caractères (3 au plus, la dernière finit par « … »). */
export function wrap(label: string, chars: number, max = 3): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of label.split(/\s+/).filter((part) => part !== "")) {
    const next = current === "" ? word : `${current} ${word}`;
    if (next.length <= chars) current = next;
    else {
      if (current !== "") lines.push(current);
      current = word.length > chars ? `${word.slice(0, chars - 1)}…` : word;
    }
  }
  if (current !== "") lines.push(current);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  const last = kept[max - 1] as string;
  kept[max - 1] = `${last.slice(0, Math.max(0, chars - 1))}…`;
  return kept;
}

/**
 * Le schéma en rangées : l'établi, puis l'ambiguïté, puis une colonne par option avec son impact
 * dessous. Un arc relie chaque nœud à celui qu'il pointe, du bas de l'un au haut de l'autre.
 */
export function layoutSchema(schema: { nodes: SchemaNode[]; edges: SchemaEdge[] }): SchemaLayout {
  const byKind = (kind: SchemaKind) => schema.nodes.filter((node) => node.kind === kind);
  const options = byKind("option");
  const impactOf = new Map<string, SchemaNode>();
  for (const edge of schema.edges) {
    const target = schema.nodes.find((node) => node.id === edge.to && node.kind === "impact");
    if (target !== undefined && options.some((option) => option.id === edge.from)) impactOf.set(edge.from, target);
  }
  const boxes: SchemaBox[] = [];
  let y = 0;
  const row = (nodes: SchemaNode[], answers: boolean) => {
    if (nodes.length === 0) return;
    const width = (SCHEMA_WIDTH - GAP * (nodes.length - 1)) / nodes.length;
    const chars = Math.max(6, Math.floor((width - PAD * 2) * CHARS_PER_PX));
    const placed = nodes.map((node, index) => ({
      id: node.id,
      kind: node.kind,
      lines: wrap(node.label, chars),
      recommended: node.recommended,
      answer: answers ? node.label : null,
      x: index * (width + GAP),
      y,
      width,
      height: 0,
    }));
    const height = Math.max(...placed.map((box) => box.lines.length)) * LINE_HEIGHT + PAD * 2;
    for (const box of placed) box.height = height;
    boxes.push(...placed);
    y += height + GAP * 2;
  };
  row(byKind("established"), false);
  row(byKind("ambiguity"), false);
  row(options, true);
  const impacts = options.map((option) => impactOf.get(option.id)).filter((node) => node !== undefined);
  const unlinked = byKind("impact").filter((node) => !impacts.includes(node));
  row([...impacts, ...unlinked], false);
  const at = new Map(boxes.map((box) => [box.id, box]));
  const links: SchemaLink[] = [];
  for (const edge of schema.edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined) continue;
    links.push({
      x1: from.x + from.width / 2,
      y1: from.y + from.height,
      x2: to.x + to.width / 2,
      y2: to.y,
      recommended: from.recommended || to.recommended,
    });
  }
  return { width: SCHEMA_WIDTH, height: Math.max(0, y - GAP * 2), boxes, links };
}

export { LINE_HEIGHT as SCHEMA_LINE_HEIGHT, PAD as SCHEMA_PAD };
