// Le graphe de session d'un run : ce que l'agent a lu, cherché, testé, modifié et décidé, étape par étape.
//
// Construit par le SERVEUR depuis les trames `tool_execution_*` réussies du runner de l'étape (lectures, recherches,
// modifications) et depuis les outils hôtes (tests, décisions). Il ne garde JAMAIS le contenu d'un fichier, ni une
// sortie d'outil, ni un chemin hors du dépôt : seuls le chemin relatif au dépôt et le motif (masqué) d'une recherche
// entrent dans un nœud.
//
// Borné à `GRAPH_NODES_MAX` nœuds : au-delà, les fichiers sont regroupés dans leur dossier, puis le reste est
// fondu ou retiré (voir `Model.enforce`). Gardé en mémoire et écrit dans l'artefact interne `_session-graph.json`
// du run (jamais purgé : il survit à la rétention du direct), poussé en événement `graph` au plus une fois par
// `GRAPH_EVENT_MIN_MS`. Le client relit `GET /v1/runs/{id}/graph`.
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunRow, StepRow, Store } from "./db.ts";
import type { HeavyOutcome } from "./heavy.ts";
import type { LogLine } from "./logger.ts";
import { redact } from "./session-feed.ts";

/** L'artefact interne du run qui garde son graphe (le `_` le cache de l'API et le garde du worktree). */
export const GRAPH_ARTIFACT = "_session-graph.json";
/** Le nombre maximal de nœuds d'un graphe. */
export const GRAPH_NODES_MAX = 300;
/** Le nombre maximal d'arcs d'un graphe. */
export const GRAPH_EDGES_MAX = 1500;
/** L'intervalle minimal entre deux événements `graph` d'un même run. */
export const GRAPH_EVENT_MIN_MS = 2000;
/** Le nombre maximal d'entrées des index de résolution (`paths`, `patterns`, `merged`), ensemble. */
export const GRAPH_KNOWN_MAX = 5000;
/** La longueur maximale du libellé d'un nœud. */
export const GRAPH_LABEL_MAX = 240;
/** Le nombre de runs gardés en mémoire. */
export const GRAPH_RUNS = 32;

/** Les appels d'outils en cours gardés par run (le plus ancien est oublié). */
const CALLS_MAX = 64;
/** Les fichiers distincts retenus pour le décompte d'un nœud `edit`. */
const STEP_FILES_MAX = GRAPH_KNOWN_MAX;
/** La durée pendant laquelle les secrets connus sont gardés avant d'être relus. */
const SECRETS_TTL_MS = 30_000;
const STATE_VERSION = 1;

export type GraphNodeKind = "dir" | "file" | "search" | "test" | "edit" | "decision" | "escalation" | "step";
export type GraphEdgeKind = "read" | "searched" | "edited" | "tested" | "led_to" | "evidence";

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** L'id du nœud d'étape (`step:<stepId>`) pour `search`, `test`, `edit`, `decision`, `escalation` ; sinon `null`. */
  step: string | null;
  parent: string | null;
  path: string | null;
  pattern: string | null;
  reads: number;
  edits: number;
  files: number;
  grouped: boolean;
  count: number;
  outcome: HeavyOutcome | null;
};
export type GraphEdge = { from: string; to: string; kind: GraphEdgeKind; count: number };
export type GraphAmbiguity = { node: string; kind: "decision" | "escalation"; evidence: string[] };
export type SessionGraphView = {
  runId: string;
  version: number;
  updatedAt: number | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  ambiguities: GraphAmbiguity[];
};

type Frame = Record<string, unknown>;
type StepRef = Pick<StepRow, "id" | "kind">;
type RunRef = Pick<RunRow, "id" | "worktree">;
export type GraphResolution = { ok: true; nodes: string[] } | { ok: false; missing: string[] };

const SCHEME = /^[a-z][\w+.-]*:\/\//;
const SELECTOR = /:(?:raw|img|conflicts|-?\d[\d,+-]*)$/;

/**
 * Un chemin RELATIF au dépôt (posix), ou `null` : vide, schéma (`https://`, `local://`…), `~`, hors du worktree
 * (`/etc/passwd`, `/home/…`) ou qui en sort (`../x`). `a.ts:50-90:raw` donne `a.ts`.
 */
export function repoPath(raw: string, worktree: string | null): string | null {
  let p = raw.trim();
  if (p === "" || p.includes("\0") || p.startsWith("~") || SCHEME.test(p)) return null;
  for (let i = 0; i < 2; i++) p = p.replace(SELECTOR, "");
  if (p === "") return null;
  if (path.isAbsolute(p)) {
    if (worktree === null) return null;
    p = path.relative(worktree, p);
    if (path.isAbsolute(p) || p === ".." || p.startsWith("../")) return null;
  }
  p = path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/+$/, "");
  if (p === ".." || p.startsWith("../")) return null;
  return p === "" ? "." : p;
}

const record = (value: unknown): Frame | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Frame) : null;

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

function blank(id: string, kind: GraphNodeKind, label: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind,
    label,
    step: null,
    parent: null,
    path: null,
    pattern: null,
    reads: 0,
    edits: 0,
    files: 0,
    grouped: false,
    count: 0,
    outcome: null,
    ...extra,
  };
}

const depth = (node: GraphNode): number => (node.path ?? ".").split("/").length;
const pathOf = (node: GraphNode): string => node.path ?? "";

/** Le nombre de recherches que porte un nœud `search` : une, ou `<n> recherches` pour un nœud fondu. */
function searchesIn(node: GraphNode): number {
  return node.pattern === null ? Number.parseInt(node.label, 10) || 1 : 1;
}

/** Le graphe d'UN run : nœuds, arcs, curseur et index de résolution. Pur, sans entrée-sortie. */
class Model {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  /** Chemin lu ou modifié → le nœud qui le porte aujourd'hui. */
  readonly paths = new Map<string, string>();
  /** Motif masqué → le nœud `search`. */
  readonly patterns = new Map<string, string>();
  /** Dossier fondu par (c) ou (e) → son absorbant courant. */
  readonly merged = new Map<string, string>();
  /** Les fichiers distincts modifiés par un nœud `edit`. */
  readonly stepFiles = new Map<string, string[]>();
  version = 0;
  updatedAt: number | null = null;
  cursor: string | null = null;
  lastStep: string | null = null;
  searchSeq = 0;

  // -- arcs et curseur -------------------------------------------------------

  edge(kind: GraphEdgeKind, from: string, to: string, count = 1): void {
    if (from === to) return;
    const key = `${kind}\0${from}\0${to}`;
    const known = this.edges.get(key);
    if (known) known.count += count;
    else this.edges.set(key, { from, to, kind, count });
  }

  /** Pose `led_to` du curseur vers `target`, qui devient le curseur. */
  #lead(target: string): void {
    if (this.cursor !== null) this.edge("led_to", this.cursor, target);
    this.cursor = target;
  }

  // -- actions ---------------------------------------------------------------

  /** Crée le nœud d'étape ; `false` s'il existe déjà (rien ne change). */
  addStep(step: StepRef): boolean {
    const id = `step:${step.id}`;
    if (this.nodes.has(id)) return false;
    this.nodes.set(id, blank(id, "step", step.kind, { count: 1 }));
    if (this.lastStep !== null) this.edge("led_to", this.lastStep, id);
    this.lastStep = id;
    this.cursor = id;
    return true;
  }

  read(stepNode: string, file: string, isDir: boolean): void {
    const target = isDir ? this.#readDir(file) : this.#touchFile("reads", file);
    this.edge("read", stepNode, target.id);
    this.#lead(target.id);
  }

  edit(stepNode: string, stepId: number, files: readonly string[]): void {
    const id = `edit:${stepId}`;
    const node = this.nodes.get(id) ?? this.#add(blank(id, "edit", "", { step: stepNode }));
    node.count++;
    const known = this.stepFiles.get(id) ?? [];
    for (const file of files) {
      if (!known.includes(file) && known.length < STEP_FILES_MAX) known.push(file);
      this.edge("edited", id, this.#touchFile("edits", file).id);
    }
    this.stepFiles.set(id, known);
    node.label = `${known.length} fichier${known.length > 1 ? "s" : ""}`;
    this.#lead(id);
  }

  search(stepNode: string, pattern: string, label: string): void {
    let node = [...this.nodes.values()].find((n) => n.kind === "search" && n.pattern === pattern && n.label === label);
    if (!node) {
      this.searchSeq += 1;
      node = this.#add(blank(`search:${this.searchSeq}`, "search", label, { step: stepNode, pattern }));
      this.patterns.set(pattern, node.id);
    }
    node.count++;
    this.edge("searched", stepNode, node.id);
    this.#lead(node.id);
  }

  test(stepNode: string, stepId: number, scope: string, check: string | null, outcome: HeavyOutcome): void {
    const id = check === null ? `test:${stepId}:${scope}` : `test:${stepId}:check:${check}`;
    const node = this.nodes.get(id) ?? this.#add(blank(id, "test", check === null ? scope : `check:${check}`));
    node.step = stepNode;
    node.count++;
    node.outcome = outcome;
    this.edge("tested", stepNode, id);
    this.#lead(id);
  }

  /** Les éléments qui ne se résolvent plus (aucun arc pour eux). */
  decide(
    stepNode: string,
    id: string,
    kind: "decision" | "escalation",
    label: string,
    evidence: readonly string[],
    worktree: string | null,
    clean: (raw: string) => string,
  ): string[] {
    const node = this.nodes.get(id) ?? this.#add(blank(id, kind, label, { step: stepNode, count: 1 }));
    const missing: string[] = [];
    for (const item of evidence) {
      const found = this.resolve([item], worktree, clean);
      if (found.ok) for (const target of found.nodes) this.edge("evidence", node.id, target);
      else missing.push(...found.missing);
    }
    this.#lead(node.id);
    return missing;
  }

  #add(node: GraphNode): GraphNode {
    this.nodes.set(node.id, node);
    return node;
  }

  // -- fichiers et dossiers --------------------------------------------------

  /** Le nœud d'un dossier : `dir:<p>`, ou l'absorbant qui l'a fondu ; `null` s'il n'y en a pas. */
  dirNode(p: string): GraphNode | null {
    const direct = this.nodes.get(`dir:${p}`);
    if (direct) return direct;
    const into = this.merged.get(`dir:${p}`);
    return (into !== undefined ? this.nodes.get(into) : undefined) ?? null;
  }

  #ensureDir(p: string): GraphNode {
    return this.nodes.get(`dir:${p}`) ?? this.#add(blank(`dir:${p}`, "dir", p, { path: p }));
  }

  #readDir(p: string): GraphNode {
    const dir = this.dirNode(p) ?? this.#ensureDir(p);
    dir.reads++;
    this.paths.set(p, dir.id);
    return dir;
  }

  /** Compte une lecture ou une modification de `f` et rend le nœud qui la porte. */
  #touchFile(counter: "reads" | "edits", f: string): GraphNode {
    const file = this.nodes.get(`file:${f}`);
    if (file) {
      file[counter]++;
      const dir = file.parent === null ? undefined : this.nodes.get(file.parent);
      if (dir) dir[counter]++;
      return file;
    }
    const d = path.posix.dirname(f);
    const merged = this.merged.get(`dir:${d}`);
    const direct = this.nodes.get(`dir:${d}`);
    const home = (merged !== undefined ? this.nodes.get(merged) : undefined) ?? (direct?.grouped ? direct : undefined);
    if (home) {
      home[counter]++;
      if (this.paths.get(f) !== home.id) home.files++;
      this.paths.set(f, home.id);
      return home;
    }
    const dir = this.#ensureDir(d);
    const created = this.#add(blank(`file:${f}`, "file", f, { path: f, parent: dir.id, [counter]: 1 }));
    dir[counter]++;
    dir.files++;
    this.paths.set(f, created.id);
    return created;
  }

  // -- résolution des preuves ------------------------------------------------

  resolve(items: readonly string[], worktree: string | null, clean: (raw: string) => string): GraphResolution {
    const nodes: string[] = [];
    const missing: string[] = [];
    for (const raw of items) {
      const item = raw.trim();
      const p = repoPath(item, worktree);
      const byPath = p === null ? undefined : this.paths.get(p);
      const found =
        (byPath !== undefined && this.nodes.has(byPath) ? byPath : null) ??
        (p === null ? null : (this.dirNode(p)?.id ?? null)) ??
        this.#patternNode(clean(item));
      if (found === null) missing.push(item);
      else if (!nodes.includes(found)) nodes.push(found);
    }
    return missing.length === 0 ? { ok: true, nodes } : { ok: false, missing };
  }

  #patternNode(pattern: string): string | null {
    const id = this.patterns.get(pattern);
    return id !== undefined && this.nodes.has(id) ? id : null;
  }

  // -- la borne --------------------------------------------------------------

  /** Ramène le graphe à `GRAPH_NODES_MAX` nœuds, la première règle possible à chaque tour (#11, #14, #16). */
  enforce(): void {
    for (let guard = 0; this.nodes.size > GRAPH_NODES_MAX && guard < 10_000; guard++)
      if (!(this.#groupFiles() || this.#fuseSearches() || this.#raiseDir() || this.#dropAction() || this.#foldTop()))
        break;
    for (const kind of ["led_to", "read"] as const)
      for (const [key, edge] of this.edges) {
        if (this.edges.size <= GRAPH_EDGES_MAX) break;
        if (edge.kind === kind) this.edges.delete(key);
      }
    while (this.paths.size + this.patterns.size + this.merged.size > GRAPH_KNOWN_MAX) {
      const biggest = [this.paths, this.patterns, this.merged].reduce((a, b) => (b.size > a.size ? b : a));
      biggest.delete(biggest.keys().next().value as string);
    }
  }

  /** (a) Les fichiers directs du dossier le plus fourni passent dans ce dossier. */
  #groupFiles(): boolean {
    const per = new Map<string, number>();
    for (const n of this.nodes.values())
      if (n.kind === "file" && n.parent !== null) per.set(n.parent, (per.get(n.parent) ?? 0) + 1);
    let best: GraphNode | null = null;
    let bestCount = 0;
    for (const [id, count] of per) {
      const dir = this.nodes.get(id);
      if (!dir) continue;
      if (count > bestCount || (count === bestCount && best !== null && pathOf(dir) < pathOf(best))) {
        best = dir;
        bestCount = count;
      }
    }
    if (!best) return false;
    for (const n of [...this.nodes.values()])
      if (n.kind === "file" && n.parent === best.id) this.#absorb(n.id, best.id);
    best.grouped = true;
    return true;
  }

  /** (b) Les recherches de l'étape la plus ancienne qui en porte au moins deux sont fondues en une. */
  #fuseSearches(): boolean {
    const per = new Map<string, GraphNode[]>();
    for (const n of this.nodes.values())
      if (n.kind === "search" && n.step !== null) per.set(n.step, [...(per.get(n.step) ?? []), n]);
    for (const step of this.nodes.values()) {
      const list = per.get(step.id);
      if (step.kind !== "step" || !list || list.length < 2) continue;
      const id = `search:${step.id.slice("step:".length)}:*`;
      const fused = this.nodes.get(id) ?? this.#add(blank(id, "search", "", { step: step.id }));
      const total = list.reduce((sum, n) => sum + searchesIn(n), 0);
      for (const n of list) {
        if (n === fused) continue;
        fused.count += n.count;
        this.#absorb(n.id, id);
      }
      fused.label = `${total} recherches`;
      return true;
    }
    return false;
  }

  /** (c) Le dossier le plus profond (deux segments au moins) passe dans son dossier parent. */
  #raiseDir(): boolean {
    let deepest: GraphNode | null = null;
    for (const n of this.nodes.values()) {
      if (n.kind !== "dir" || depth(n) < 2) continue;
      if (!deepest || depth(n) > depth(deepest) || (depth(n) === depth(deepest) && pathOf(n) < pathOf(deepest)))
        deepest = n;
    }
    if (!deepest) return false;
    this.#foldDir(deepest, path.posix.dirname(pathOf(deepest)));
    return true;
  }

  /** (d) Retire la plus ancienne recherche, sinon le plus ancien test, sinon la plus ancienne modification. */
  #dropAction(): boolean {
    const cited = new Set<string>();
    for (const e of this.edges.values()) if (e.kind === "evidence") cited.add(e.to);
    for (const kind of ["search", "test", "edit"] as const)
      for (const n of this.nodes.values())
        if (n.kind === kind && !cited.has(n.id)) {
          this.#remove(n);
          return true;
        }
    return false;
  }

  /** (e) Le plus ancien dossier de premier niveau passe dans la racine. */
  #foldTop(): boolean {
    for (const n of this.nodes.values())
      if (n.kind === "dir" && depth(n) === 1 && n.path !== ".") {
        this.#foldDir(n, ".");
        return true;
      }
    return false;
  }

  #foldDir(dir: GraphNode, into: string): void {
    const target = this.dirNode(into) ?? this.#ensureDir(into);
    target.reads += dir.reads;
    target.edits += dir.edits;
    target.files += dir.files;
    target.grouped = true;
    this.#absorb(dir.id, target.id);
    this.merged.set(dir.id, target.id);
  }

  /** `from` disparaît dans `into` : ses arcs, le curseur et les index le suivent. */
  #absorb(from: string, into: string): void {
    for (const [key, e] of [...this.edges]) {
      if (e.from !== from && e.to !== from) continue;
      this.edges.delete(key);
      this.edge(e.kind, e.from === from ? into : e.from, e.to === from ? into : e.to, e.count);
    }
    if (this.cursor === from) this.cursor = into;
    for (const index of [this.paths, this.patterns, this.merged])
      for (const [key, id] of index) if (id === from) index.set(key, into);
    this.nodes.delete(from);
  }

  #remove(node: GraphNode): void {
    for (const [key, e] of [...this.edges]) if (e.from === node.id || e.to === node.id) this.edges.delete(key);
    for (const index of [this.paths, this.patterns, this.merged])
      for (const [key, id] of [...index]) if (id === node.id) index.delete(key);
    this.nodes.delete(node.id);
    this.stepFiles.delete(node.id);
    if (node.pattern !== null) {
      const other = [...this.nodes.values()].find((n) => n.kind === "search" && n.pattern === node.pattern);
      if (other) this.patterns.set(node.pattern, other.id);
    }
    if (this.cursor === node.id) this.cursor = this.lastStep;
  }

  // -- vue et persistance ----------------------------------------------------

  ambiguities(): GraphAmbiguity[] {
    const out: GraphAmbiguity[] = [];
    for (const n of this.nodes.values()) {
      if (n.kind !== "decision" && n.kind !== "escalation") continue;
      const evidence: string[] = [];
      for (const e of this.edges.values()) if (e.kind === "evidence" && e.from === n.id) evidence.push(e.to);
      out.push({ node: n.id, kind: n.kind, evidence });
    }
    return out;
  }

  serialize(): string {
    return JSON.stringify({
      v: STATE_VERSION,
      version: this.version,
      updatedAt: this.updatedAt,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      cursor: this.cursor,
      lastStep: this.lastStep,
      searchSeq: this.searchSeq,
      paths: Object.fromEntries(this.paths),
      patterns: Object.fromEntries(this.patterns),
      merged: Object.fromEntries(this.merged),
      stepFiles: Object.fromEntries(this.stepFiles),
    });
  }

  /** Relit un état écrit par `serialize` ; lève s'il n'en a pas la forme. */
  static parse(content: string): Model | null {
    const data = record(JSON.parse(content));
    if (!data || data.v !== STATE_VERSION) return null;
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error("nœuds ou arcs illisibles");
    const model = new Model();
    for (const n of data.nodes as GraphNode[]) model.nodes.set(n.id, n);
    for (const e of data.edges as GraphEdge[]) model.edges.set(`${e.kind}\0${e.from}\0${e.to}`, e);
    const index = (value: unknown, into: Map<string, string>): void => {
      for (const [key, id] of Object.entries(record(value) ?? {})) if (typeof id === "string") into.set(key, id);
    };
    index(data.paths, model.paths);
    index(data.patterns, model.patterns);
    index(data.merged, model.merged);
    for (const [key, files] of Object.entries(record(data.stepFiles) ?? {}))
      if (Array.isArray(files))
        model.stepFiles.set(
          key,
          files.filter((f): f is string => typeof f === "string"),
        );
    model.version = typeof data.version === "number" ? data.version : 0;
    model.updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : null;
    model.cursor = typeof data.cursor === "string" ? data.cursor : null;
    model.lastStep = typeof data.lastStep === "string" ? data.lastStep : null;
    model.searchSeq = typeof data.searchSeq === "number" ? data.searchSeq : 0;
    return model;
  }
}

type Timer = { cancel(): void };

/** Un run en mémoire : son graphe (chargé à la demande), ses appels d'outils en cours et l'état de l'envoi. */
type Entry = {
  runId: string;
  model: Model | null;
  stepId: number | null;
  /** Les versions écrite en base et poussée. */
  saved: number;
  sent: number;
  lastSent: number;
  timer: Timer | null;
  calls: Map<string, { tool: string; args: Frame }>;
};

const TRACKED: Readonly<Record<string, true>> = {
  read: true,
  write: true,
  edit: true,
  ast_edit: true,
  grep: true,
  ast_grep: true,
  glob: true,
  find: true,
};
const HASHLINE = /^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]/gm;
const PATCH = /^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ (?:b\/)?)(\S+)/gm;

export type SessionGraphsOptions = {
  store: Pick<Store, "getArtifact" | "putArtifact">;
  publish: (runId: string, payload: { version: number; nodes: number; edges: number }) => void;
  secrets?: () => readonly string[];
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Timer;
  log?: LogLine;
};

export class SessionGraphs {
  readonly #store: SessionGraphsOptions["store"];
  readonly #publish: SessionGraphsOptions["publish"];
  readonly #secrets: () => readonly string[];
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => Timer;
  readonly #log: LogLine;
  readonly #runs = new Map<string, Entry>();
  #known: { at: number; values: readonly string[] } | null = null;

  constructor(options: SessionGraphsOptions) {
    this.#store = options.store;
    this.#publish = options.publish;
    this.#secrets = options.secrets ?? (() => []);
    this.#now = options.now ?? Date.now;
    this.#schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return { cancel: () => clearTimeout(timer) };
      });
    this.#log = options.log ?? (() => {});
  }

  /** L'étape `step` du run commence : son nœud, relié à l'étape précédente. */
  step(run: RunRef, step: StepRef): void {
    this.#mutate(run.id, step, () => false);
  }

  /** Une trame du runner de l'étape : les lectures, recherches et modifications réussies entrent dans le graphe. */
  frame(run: RunRef, step: StepRef | null, frame: Frame): void {
    if (step === null) return;
    if (frame.type !== "tool_execution_start" && frame.type !== "tool_execution_end") return;
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : null;
    if (id === null) return;
    const entry = this.#entry(run.id);
    if (frame.type === "tool_execution_start") {
      const tool = typeof frame.toolName === "string" ? frame.toolName : null;
      if (tool === null || !Object.hasOwn(TRACKED, tool)) return;
      entry.calls.delete(id);
      entry.calls.set(id, { tool, args: record(frame.args) ?? {} });
      if (entry.calls.size > CALLS_MAX) entry.calls.delete(entry.calls.keys().next().value as string);
      return;
    }
    const call = entry.calls.get(id);
    if (!call) return;
    entry.calls.delete(id);
    if (frame.isError === true) return;
    this.#mutate(run.id, step, (model, stepNode) => this.#apply(model, stepNode, step, run.worktree, call));
  }

  /** Un passage `run_tests` de l'étape et son issue. */
  test(
    runId: string,
    step: StepRef,
    scope: "touched" | "full" | "check",
    check: string | null,
    outcome: HeavyOutcome,
  ): void {
    this.#mutate(runId, step, (model, stepNode) => {
      model.test(stepNode, step.id, scope, scope === "check" ? this.#clean(check ?? "", null) : null, outcome);
      return true;
    });
  }

  /** Ce qui fonde une décision : chaque preuve doit être un chemin ou une recherche du graphe. */
  resolve(run: RunRef, evidence: readonly string[]): GraphResolution {
    const model = this.#model(this.#entry(run.id));
    return model.resolve(evidence, run.worktree, (raw) => this.#clean(raw, run.worktree));
  }

  /**
   * Le nœud d'une décision ou d'une escalade et ses arcs `evidence`. Les preuves arrivent BRUTES et sont résolues
   * ici, sur l'état courant : aucun id de nœud ne franchit d'attente entre `resolve` et cet appel.
   */
  decision(
    run: RunRef,
    step: StepRef,
    ref: { kind: "decision"; seq: number } | { kind: "escalation"; id: number },
    label: string,
    evidence: readonly string[],
  ): void {
    const id = ref.kind === "decision" ? `decision:${ref.seq}` : `escalation:${ref.id}`;
    const clean = (raw: string) => this.#clean(raw, run.worktree);
    this.#mutate(run.id, step, (model, stepNode) => {
      const missing = model.decide(stepNode, id, ref.kind, clean(label), evidence, run.worktree, clean);
      if (missing.length > 0)
        this.#log(`graphe : preuve introuvable pour ${id} (${missing.length} manquante(s))`, { runId: run.id });
      return true;
    });
  }

  view(runId: string): SessionGraphView {
    const model = this.#model(this.#entry(runId));
    return {
      runId,
      version: model.version,
      updatedAt: model.updatedAt,
      nodes: [...model.nodes.values()].map((n) => ({ ...n })),
      edges: [...model.edges.values()].map((e) => ({ ...e })),
      ambiguities: model.ambiguities(),
    };
  }

  /** Écrit l'état tout de suite ; l'événement, lui, respecte l'intervalle minimal (le minuteur reste armé). */
  flush(runId: string): void {
    const entry = this.#runs.get(runId);
    if (!entry?.model) return;
    if (entry.saved !== entry.model.version) this.#save(entry);
    if (entry.sent === entry.model.version) return;
    const wait = entry.lastSent + GRAPH_EVENT_MIN_MS - this.#now();
    if (wait <= 0) this.#push(entry);
    else this.#arm(entry, wait);
  }

  // -- construction ----------------------------------------------------------

  /** Applique `change` au graphe du run ; s'il a changé : borne, version, envoi. Jamais d'exception vers l'étape. */
  #mutate(runId: string, step: StepRef, change: (model: Model, stepNode: string) => boolean): void {
    try {
      const entry = this.#entry(runId);
      const model = this.#model(entry);
      entry.stepId = step.id;
      const added = model.addStep(step);
      const changed = change(model, `step:${step.id}`);
      if (!added && !changed) return;
      model.enforce();
      model.version++;
      model.updatedAt = this.#now();
      this.#dispatch(entry, model);
    } catch (err) {
      this.#log("graphe : mise à jour échouée", { runId: runId, err });
    }
  }

  #apply(
    model: Model,
    stepNode: string,
    step: StepRef,
    worktree: string | null,
    call: { tool: string; args: Frame },
  ): boolean {
    const { args } = call;
    const rel = (raw: unknown): string | null => {
      const value = text(raw);
      return value === null ? null : repoPath(value, worktree);
    };
    switch (call.tool) {
      case "read": {
        const file = rel(args.path);
        if (file === null) return false;
        model.read(stepNode, file, isDirectory(worktree, file));
        return true;
      }
      case "write":
      case "edit":
      case "ast_edit": {
        const files = [...new Set(editPaths(call.tool, args).map((raw) => repoPath(raw, worktree)))].filter(
          (file): file is string => file !== null,
        );
        if (files.length === 0) return false;
        model.edit(stepNode, step.id, files);
        return true;
      }
      default: {
        let pattern = text(args.pattern)?.trim() ?? null;
        if (pattern === null) return false;
        // Un motif de fichiers (`glob`, `find`) qui désigne un chemin hors du dépôt n'est jamais gardé.
        const isFiles = call.tool === "glob" || call.tool === "find";
        if (isFiles && /^[/~]|\.\./.test(pattern)) pattern = repoPath(pattern, worktree);
        if (pattern === null) return false;
        const scope = (text(args.path) ?? "")
          .split(";")
          .map((p) => repoPath(p, worktree))
          .filter((p): p is string => p !== null)
          .join(", ");
        const masked = this.#clean(pattern, worktree);
        model.search(stepNode, masked, this.#clean(scope === "" ? pattern : `${pattern} — ${scope}`, worktree));
        return true;
      }
    }
  }

  /** Un texte sur une ligne, sans secret ni chemin du poste, borné. */
  #clean(raw: string, worktree: string | null): string {
    const now = this.#now();
    if (!this.#known || now - this.#known.at > SECRETS_TTL_MS) this.#known = { at: now, values: this.#secrets() };
    let out = redact(raw, this.#known.values);
    if (worktree) out = out.split(worktree).join(".");
    out = out.replace(/\s+/g, " ").trim();
    return out.length <= GRAPH_LABEL_MAX ? out : `${out.slice(0, GRAPH_LABEL_MAX - 1)}…`;
  }

  // -- mémoire ---------------------------------------------------------------

  #entry(runId: string): Entry {
    const known = this.#runs.get(runId);
    if (known) {
      this.#runs.delete(runId);
      this.#runs.set(runId, known);
      return known;
    }
    const entry: Entry = {
      runId,
      model: null,
      stepId: null,
      saved: 0,
      sent: 0,
      lastSent: Number.NEGATIVE_INFINITY,
      timer: null,
      calls: new Map(),
    };
    this.#runs.set(runId, entry);
    if (this.#runs.size > GRAPH_RUNS) {
      const [oldId, old] = this.#runs.entries().next().value as [string, Entry];
      this.flush(oldId);
      this.#runs.delete(old.runId);
    }
    return entry;
  }

  /** Le graphe du run, relu de son artefact au premier besoin ; vide si l'artefact manque ou n'est pas lisible. */
  #model(entry: Entry): Model {
    if (entry.model) return entry.model;
    let model: Model | null = null;
    try {
      const content = this.#store.getArtifact(entry.runId, GRAPH_ARTIFACT);
      model = content === null ? null : Model.parse(content);
    } catch (err) {
      this.#log("graphe : état illisible, reparti de zéro", { runId: entry.runId, err });
    }
    entry.model = model ?? new Model();
    entry.saved = entry.model.version;
    entry.sent = entry.model.version;
    return entry.model;
  }

  // -- envoi -----------------------------------------------------------------

  /** Envoie tout de suite si l'intervalle est écoulé ; sinon arme UN minuteur pour la fin de l'intervalle. */
  #dispatch(entry: Entry, model: Model): void {
    const wait = entry.lastSent + GRAPH_EVENT_MIN_MS - this.#now();
    if (wait <= 0) this.#send(entry, model);
    else this.#arm(entry, wait);
  }

  #arm(entry: Entry, wait: number): void {
    if (entry.timer) return;
    entry.timer = this.#schedule(() => {
      entry.timer = null;
      if (entry.model && entry.sent !== entry.model.version) this.#send(entry, entry.model);
    }, wait);
  }

  /** L'envoi : l'artefact d'abord, puis l'événement. Un échec est journalisé, jamais propagé. */
  #send(entry: Entry, model: Model): void {
    entry.timer?.cancel();
    entry.timer = null;
    if (entry.saved !== model.version) this.#save(entry);
    this.#push(entry);
  }

  #save(entry: Entry): void {
    const model = entry.model;
    if (!model) return;
    try {
      this.#store.putArtifact(entry.runId, GRAPH_ARTIFACT, model.serialize(), entry.stepId);
      entry.saved = model.version;
    } catch (err) {
      this.#log("graphe : écriture de l'artefact échouée", { runId: entry.runId, err });
    }
  }

  #push(entry: Entry): void {
    const model = entry.model;
    if (!model) return;
    entry.timer?.cancel();
    entry.timer = null;
    entry.lastSent = this.#now();
    entry.sent = model.version;
    try {
      this.#publish(entry.runId, { version: model.version, nodes: model.nodes.size, edges: model.edges.size });
    } catch (err) {
      this.#log("graphe : événement non poussé", { runId: entry.runId, err });
    }
  }
}

/** Le chemin désigne-t-il un dossier du worktree ? Toute erreur vaut « fichier ». */
function isDirectory(worktree: string | null, file: string): boolean {
  if (worktree === null) return false;
  try {
    return fs.statSync(path.join(worktree, file)).isDirectory();
  } catch {
    return false;
  }
}

/** Les chemins d'un appel `write`, `edit` ou `ast_edit` : `path`, en-têtes hashline, en-têtes de patch, `edits[]`. */
function editPaths(tool: string, args: Frame): string[] {
  const out: string[] = [];
  const direct = text(args.path);
  if (direct !== null) out.push(direct);
  if (tool === "write") return out;
  const input = text(args.input);
  if (input !== null)
    for (const pattern of [HASHLINE, PATCH]) for (const m of input.matchAll(pattern)) out.push(m[1] as string);
  if (Array.isArray(args.edits))
    for (const item of args.edits) {
      const edited = text(record(item)?.path);
      if (edited !== null) out.push(edited);
    }
  return out;
}
