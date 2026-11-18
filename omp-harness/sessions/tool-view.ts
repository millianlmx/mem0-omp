// Le RENDU d'un appel d'outil pour l'humain, comme OMP l'affiche dans son terminal :
// une commande se lit comme une commande, une édition comme des différences, un
// sous-agent comme une fiche (sa mission, ce qu'il fait, ce qu'il a rendu), et le JSON
// des outils du service (décision, verdict, tests…) comme des champs et des listes.
// Le JSON brut reste disponible à côté (`GET /v1/runs/{id}/session/{seq}` : `args`,
// `result`) ; ce module ne fait que le présenter.
//
// Un rendu est une liste de BLOCS de forme unique (les apps n'en dessinent que
// quatre sortes : `text`, `fields`, `list`, `agents`). Un bloc porte un `role` — un
// code que les apps traduisent (`command`, `content`, `changes`, `output`…) — ou un
// `title` tiré des données (une clé JSON). Aucune phrase ici : les apps ont les mots.
//
// Les textes sont bornés ici, et masqués par l'appelant (`session-feed.ts`).

export type ToolBlockKind = "text" | "fields" | "list" | "agents";

/** La forme d'un texte : `markdown` (prose de l'agent), `code` (sortie, fichier), `diff`, `command` (shell), `plain`. */
export type ToolTextFormat = "plain" | "markdown" | "code" | "diff" | "command";

export type ToolField = { key: string; value: string };

/** Un appel d'outil d'un sous-agent, en une ligne. */
export type AgentCall = { tool: string; text: string; error: boolean };

/** Un sous-agent tel que l'humain le lit : qui il est, sa mission, ce qu'il fait, ce qu'il a rendu. */
export type AgentView = {
  id: string;
  name: string;
  /** Son type (`task`, `scout`, `reviewer`…). */
  agent: string;
  /** `pending`, `running`, `completed`, `failed` ou `aborted`. */
  status: string;
  /** Sa mission, entière (Markdown). */
  task: string;
  /** Ce qu'il fait à l'instant : son outil et son intention, ou sa dernière intention. */
  activity: string | null;
  /** Ses derniers appels d'outils, du plus ancien au plus récent. */
  recent: AgentCall[];
  /** Ce qu'il a rendu (Markdown), ou la fin de sa sortie en cours. */
  output: string | null;
  error: string | null;
  durationMs: number | null;
  tokens: number | null;
  cost: number | null;
  model: string | null;
};

/** Un sous-agent en une ligne, pour la rangée du direct (poussée en temps réel). */
export type AgentLine = {
  id: string;
  name: string;
  agent: string;
  status: string;
  task: string;
  activity: string | null;
};

export type ToolBlock = {
  kind: ToolBlockKind;
  /** Ce que dit le bloc, en code traduit par les apps ; `null` : son `title` seul, ou rien. */
  role: string | null;
  /** Un titre tiré des données (une clé JSON), affiché tel quel quand le bloc n'a pas de rôle. */
  title: string | null;
  format: ToolTextFormat | null;
  text: string | null;
  fields: ToolField[] | null;
  items: string[] | null;
  agents: AgentView[] | null;
};

export type ToolView = {
  /** L'appel en une ligne : la commande, le chemin, le motif, les sous-agents… */
  headline: string;
  blocks: ToolBlock[];
  /** Les sous-agents d'un appel `task`, en une ligne chacun ; `null` pour tout autre outil. */
  agents: AgentLine[] | null;
};

/** Ce que le rendu sait d'un appel : ses arguments, et son résultat (partiel s'il tourne encore). */
export type ToolCall = {
  tool: string | null;
  args: unknown;
  result: unknown;
  /** Le résultat est final (`tool_execution_end`). */
  done: boolean;
  isError: boolean;
};

/**
 * Les outils dont l'appel est un MESSAGE de l'agent à l'humain, pas un outil : le
 * direct les montre comme ses paragraphes. La valeur est la clé de l'argument qui
 * porte le message.
 */
export const MESSAGE_TOOLS: ReadonlyMap<string, string> = new Map([["progress", "message"]]);

/** Le message que porte l'appel d'un outil-message (`progress`), ou `null` pour un vrai outil. */
export function messageOf(tool: string | null, args: unknown): string | null {
  const key = tool === null ? undefined : MESSAGE_TOOLS.get(tool);
  return key === undefined ? null : (str(record(args)?.[key]) ?? "");
}

/** La longueur maximale d'un texte de bloc. */
export const BLOCK_TEXT_MAX = 64_000;
/** La longueur maximale de la mission ou de la sortie d'un sous-agent dans sa fiche. */
export const AGENT_TEXT_MAX = 8_000;
/** Les sous-agents montrés au plus (fiches et lignes). */
export const AGENTS_MAX = 16;
/** Les derniers appels d'un sous-agent montrés au plus. */
export const AGENT_RECENT_MAX = 8;
/** Une valeur plus longue (ou sur plusieurs lignes) quitte les champs pour un bloc de texte. */
const FIELD_MAX = 120;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Une ligne, bornée. */
function line(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Un texte borné par son début et sa fin. */
function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… ${text.length - 2 * half} caractères omis …\n${text.slice(text.length - half)}`;
}

/** La fin d'un texte. */
function tailOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max + 1)}`;
}

function block(kind: ToolBlockKind, fields: Partial<ToolBlock>): ToolBlock {
  return {
    kind,
    role: fields.role ?? null,
    title: fields.title ?? null,
    format: fields.format ?? null,
    text: fields.text ?? null,
    fields: fields.fields ?? null,
    items: fields.items ?? null,
    agents: fields.agents ?? null,
  };
}

const textBlock = (role: string | null, format: ToolTextFormat, text: string, title: string | null = null) =>
  block("text", { role, title, format, text: bounded(text, BLOCK_TEXT_MAX) });

/** Le texte d'un résultat d'outil (`{ content: [{ type: "text", text }] }`, ou une chaîne). */
export function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = record(result)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const piece = record(part);
      return piece?.type === "text" && typeof piece.text === "string" ? piece.text : "";
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** Le JSON brut d'une valeur, indenté ; `null` sans valeur. */
export function rawJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === "{}" || json === undefined ? null : json;
  } catch {
    return null;
  }
}

/** Le premier chemin d'un patch (`*** Update File: x`, `+++ b/x`), s'il en nomme un. */
function patchPath(patch: string): string | null {
  const match = /^(?:\*\*\* (?:Update|Add|Delete) File: |\+\+\+ (?:b\/)?)(\S+)/m.exec(patch);
  return match?.[1] ?? null;
}

/** Les différences d'un remplacement : l'ancien texte retiré, le nouveau ajouté. */
function replacementDiff(oldText: string, newText: string): string {
  const minus = oldText.split("\n").map((row) => `-${row}`);
  const plus = newText.split("\n").map((row) => `+${row}`);
  return [...minus, ...plus].join("\n");
}

// ── Les sous-agents (`task`) ─────────────────────────────────────────────────

/** L'appel d'un sous-agent en une ligne : son outil, puis son intention ou ses arguments. */
function callLine(tool: unknown, intent: unknown, args: unknown): string | null {
  const name = str(tool);
  if (!name) return str(intent) ? line(intent as string) : null;
  const what = str(intent) ?? str(args);
  return line(what ? `${name} · ${what}` : name);
}

function agentFromProgress(progress: Json): AgentView {
  const recent = Array.isArray(progress.recentTools) ? progress.recentTools : [];
  const output = Array.isArray(progress.recentOutput)
    ? progress.recentOutput.filter((row): row is string => typeof row === "string").join("\n")
    : "";
  const retry = record(progress.retryFailure) ?? record(progress.retryState);
  return {
    id: str(progress.id) ?? String(progress.index ?? ""),
    name: str(progress.description) ?? str(progress.id) ?? "",
    agent: str(progress.agent) ?? "task",
    status: str(progress.status) ?? "running",
    task: bounded(str(progress.assignment) ?? str(progress.task) ?? "", AGENT_TEXT_MAX),
    activity:
      callLine(progress.currentTool, progress.currentToolIntent, progress.currentToolArgs) ??
      (str(progress.lastIntent) ? line(progress.lastIntent as string) : null),
    recent: recent
      .map(record)
      .filter((call): call is Json => call !== null)
      .slice(-AGENT_RECENT_MAX)
      .map((call) => ({
        tool: str(call.tool) ?? "",
        text: line(str(call.intent) ?? str(call.args) ?? ""),
        error: call.isError === true,
      })),
    output: output.trim() === "" ? null : tailOf(output, AGENT_TEXT_MAX),
    error: retry && str(retry.errorMessage) ? line(retry.errorMessage as string) : null,
    durationMs: num(progress.durationMs),
    tokens: num(progress.tokens),
    cost: num(progress.cost),
    model: str(progress.resolvedModel),
  };
}

function agentFromResult(result: Json): AgentView {
  const exit = num(result.exitCode);
  const failed =
    result.aborted === true ? "aborted" : (exit !== null && exit !== 0) || str(result.error) ? "failed" : "completed";
  return {
    id: str(result.id) ?? String(result.index ?? ""),
    name: str(result.description) ?? str(result.id) ?? "",
    agent: str(result.agent) ?? "task",
    status: failed,
    task: bounded(str(result.assignment) ?? str(result.task) ?? "", AGENT_TEXT_MAX),
    activity: str(result.lastIntent) ? line(result.lastIntent as string) : null,
    recent: [],
    output: str(result.output) ? bounded(result.output as string, AGENT_TEXT_MAX) : null,
    error: str(result.error)
      ? line(result.error as string, 600)
      : str(result.abortReason)
        ? line(result.abortReason as string, 600)
        : null,
    durationMs: num(result.durationMs),
    tokens: num(result.tokens),
    cost: num(record(record(result.usage)?.cost)?.total),
    model: str(result.resolvedModel),
  };
}

/** Les sous-agents d'un appel `task` : les résultats rendus, la progression en cours, sinon les missions demandées. */
function taskAgents(args: Json | null, result: unknown): AgentView[] {
  const details = record(record(result)?.details);
  const byId = new Map<string, AgentView>();
  const progress = Array.isArray(details?.progress) ? details.progress : [];
  for (const item of progress.map(record)) {
    if (!item) continue;
    const agent = agentFromProgress(item);
    byId.set(agent.id, agent);
  }
  const results = Array.isArray(details?.results) ? details.results : [];
  for (const item of results.map(record)) {
    if (!item) continue;
    const done = agentFromResult(item);
    const live = byId.get(done.id);
    byId.set(done.id, live ? { ...done, recent: live.recent, model: done.model ?? live.model } : done);
  }
  if (byId.size > 0) return [...byId.values()].slice(0, AGENTS_MAX);
  // Rien n'a encore démarré : les missions telles que l'agent les a demandées.
  const items = Array.isArray(args?.tasks) ? args.tasks.map(record) : args && str(args.task) ? [args] : [];
  return items
    .filter((item): item is Json => item !== null)
    .slice(0, AGENTS_MAX)
    .map((item, index) => ({
      id: str(item.name) ?? String(index),
      name: str(item.name) ?? "",
      agent: str(item.agent) ?? "task",
      status: "pending",
      task: bounded(str(item.task) ?? "", AGENT_TEXT_MAX),
      activity: null,
      recent: [],
      output: null,
      error: null,
      durationMs: null,
      tokens: null,
      cost: null,
      model: null,
    }));
}

export function agentLines(agents: readonly AgentView[]): AgentLine[] {
  return agents.map((agent) => ({
    id: agent.id,
    name: line(agent.name, 80),
    agent: agent.agent,
    status: agent.status,
    task: line(agent.task, 160),
    activity: agent.activity ? line(agent.activity, 160) : null,
  }));
}

function taskHeadline(args: Json | null, agents: readonly AgentView[]): string {
  const names = agents.map((agent) => agent.name || agent.agent).filter((name) => name !== "");
  if (agents.length > 1) return line(names.join(", "));
  const agent = agents[0];
  if (!agent) return line(str(args?.task) ?? "");
  const label = agent.name && agent.name !== agent.agent ? `${agent.agent} ${agent.name}` : agent.agent;
  return line(`${label} — ${agent.task}`);
}

// ── Le JSON générique (outils du service, outils inconnus) ───────────────────

/** Une valeur simple en une ligne ; `null` si elle n'en est pas une. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Un objet en une ligne : ses valeurs simples jointes, les longues en dernier. */
function objectLine(object: Json): string {
  const short: string[] = [];
  const long: string[] = [];
  for (const value of Object.values(object)) {
    const text =
      scalar(value) ?? (Array.isArray(value) && value.every((v) => scalar(v) !== null) ? value.join(", ") : null);
    if (text === null || text.trim() === "") continue;
    (text.length > FIELD_MAX ? long : short).push(text);
  }
  return [short.join(" · "), ...long].filter((part) => part !== "").join(" — ");
}

/** Les clés dont la valeur longue est du code (un fichier, un patch), pas de la prose. */
const CODE_KEYS = new Set(["content", "code", "diff", "patch", "input", "old_string", "new_string", "script"]);

/**
 * Le rendu d'un objet JSON quelconque : les valeurs courtes en champs, chaque texte
 * long en bloc (code ou Markdown), chaque liste en liste, les objets imbriqués à plat.
 */
export function jsonBlocks(value: unknown, role: string | null = null): ToolBlock[] {
  const object = record(value);
  if (!object) {
    const text = scalar(value) ?? rawJson(value);
    return text ? [textBlock(role, "plain", text)] : [];
  }
  const fields: ToolField[] = [];
  const blocks: ToolBlock[] = [];
  const visit = (prefix: string, entry: Json): void => {
    for (const [key, raw] of Object.entries(entry)) {
      const name = prefix === "" ? key : `${prefix}.${key}`;
      const text = scalar(raw);
      if (text !== null) {
        if (text.length > FIELD_MAX || text.includes("\n")) {
          blocks.push(textBlock(null, CODE_KEYS.has(key) ? "code" : "markdown", text, name));
        } else if (text !== "") fields.push({ key: name, value: text });
      } else if (Array.isArray(raw)) {
        if (raw.length === 0) continue;
        const items = raw.map(
          (item) => scalar(item) ?? (record(item) ? objectLine(record(item) as Json) : (rawJson(item) ?? "")),
        );
        blocks.push(
          block("list", {
            title: name,
            items: items.filter((item) => item !== "").map((item) => bounded(item, 4_000)),
          }),
        );
      } else if (record(raw)) visit(name, record(raw) as Json);
    }
  };
  visit("", object);
  return [...(fields.length > 0 ? [block("fields", { role, fields })] : []), ...blocks];
}

// ── Le rendu d'un appel ──────────────────────────────────────────────────────

/** Les arguments d'un outil en une ligne : le champ parlant s'il y en a un, sinon les valeurs. */
function genericHeadline(args: Json | null): string {
  if (!args) return "";
  for (const key of [
    "command",
    "path",
    "file_path",
    "pattern",
    "query",
    "url",
    "name",
    "message",
    "question",
    "title",
  ]) {
    const value = str(args[key]);
    if (value) return line(value);
  }
  // Sinon ses valeurs simples et courtes : une liste ou un long texte n'est pas un titre.
  const short = Object.values(args)
    .map(scalar)
    .filter((value): value is string => value !== null && value.trim() !== "" && value.length <= FIELD_MAX);
  return line(short.join(" · "));
}

/**
 * Le rendu d'un appel d'outil : son appel en une ligne, ses blocs lisibles (arguments
 * puis résultat), et, pour `task`, ses sous-agents en une ligne chacun.
 */
export function toolView(call: ToolCall): ToolView {
  const args = record(call.args);
  const output = resultText(call.result);
  const details = record(record(call.result)?.details);
  const outputBlock = (role: string, format: ToolTextFormat): ToolBlock[] =>
    output.trim() === "" ? [] : [textBlock(call.isError ? "error" : role, format, output)];
  switch (call.tool) {
    case "bash": {
      const command = str(args?.command) ?? "";
      const fields: ToolField[] = [];
      if (str(args?.cwd)) fields.push({ key: "cwd", value: args?.cwd as string });
      const exit = num(details?.exitCode);
      if (exit !== null) fields.push({ key: "exit", value: String(exit) });
      if (details?.timedOut === true) fields.push({ key: "timeout", value: String(num(details.timeoutSeconds) ?? "") });
      return {
        headline: line(command),
        blocks: [
          textBlock("command", "command", command),
          ...(fields.length > 0 ? [block("fields", { fields })] : []),
          ...outputBlock("output", "code"),
        ],
        agents: null,
      };
    }
    case "read":
      return { headline: line(str(args?.path) ?? ""), blocks: outputBlock("content", "code"), agents: null };
    case "write": {
      const path = str(args?.path) ?? "";
      const content = typeof args?.content === "string" ? args.content : null;
      return {
        headline: line(path),
        blocks: [
          ...(content !== null ? [textBlock("content", "code", content)] : []),
          ...(call.isError ? outputBlock("output", "plain") : []),
        ],
        agents: null,
      };
    }
    case "edit":
    case "ast_edit": {
      const input = str(args?.input);
      const edits = Array.isArray(args?.edits) ? args.edits.map(record) : [];
      const path = str(args?.path) ?? (input ? patchPath(input) : null) ?? "";
      const diff =
        str(details?.diff) ??
        (typeof args?.old_string === "string" && typeof args?.new_string === "string"
          ? replacementDiff(args.old_string, args.new_string)
          : null) ??
        (edits.length > 0 ? edits.map((edit) => str(edit?.diff) ?? "").join("\n") : null) ??
        input;
      return {
        headline: line(path),
        blocks: [
          ...(diff && diff.trim() !== "" ? [textBlock("changes", "diff", diff)] : []),
          ...(call.isError || !diff ? outputBlock("output", "plain") : []),
        ],
        agents: null,
      };
    }
    case "grep":
    case "ast_grep":
    case "glob":
    case "find": {
      const pattern = str(args?.pattern) ?? "";
      const path = str(args?.path);
      return {
        headline: line(pattern && path ? `${pattern} — ${path}` : pattern || path || ""),
        blocks: outputBlock("output", "code"),
        agents: null,
      };
    }
    case "task": {
      const agents = taskAgents(args, call.result);
      const context = str(args?.context);
      return {
        headline: taskHeadline(args, agents),
        blocks: [
          ...(context ? [textBlock("context", "markdown", context)] : []),
          ...(agents.length > 0 ? [block("agents", { role: "agents", agents })] : []),
          ...(call.done && agents.every((agent) => !agent.output) ? outputBlock("output", "markdown") : []),
        ],
        agents: agentLines(agents),
      };
    }
    case "todo": {
      const items = [
        ...(Array.isArray(args?.items) ? args.items : []),
        ...(Array.isArray(args?.list) ? args.list.map((item) => scalar(item) ?? objectLine(record(item) ?? {})) : []),
      ].filter((item): item is string => typeof item === "string" && item !== "");
      const what = [str(args?.op), str(args?.task) ?? str(args?.phase)].filter((part) => part !== null).join(" · ");
      return {
        headline: line(what),
        blocks: [
          ...(items.length > 0 ? [block("list", { role: "todos", items })] : []),
          ...outputBlock("result", "plain"),
        ],
        agents: null,
      };
    }
    default:
      return {
        headline: genericHeadline(args),
        blocks: [...jsonBlocks(args, "arguments"), ...outputBlock("result", "markdown")],
        agents: null,
      };
  }
}

/** Les textes d'une valeur passés par `clean` (le masque des secrets), en profondeur. */
export function cleanDeep<T>(value: T, clean: (text: string) => string): T {
  if (typeof value === "string") return clean(value) as T;
  if (Array.isArray(value)) return value.map((item) => cleanDeep(item, clean)) as T;
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, cleanDeep(item, clean)])) as T;
}
