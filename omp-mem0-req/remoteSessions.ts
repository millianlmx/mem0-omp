// Le LECTEUR d'un fichier de session OMP (.jsonl) et sa projection filaire : portage de
// `SessionReader` (omp-console/Sources/OMPConsole/Session/SessionReader.swift), de
// `ConversationEntry`/`RemoteConversationEntry` (ConsoleCore/Session/SessionModel.swift,
// Remote/Payloads.swift) et de `RemoteReads.session` (Remote/RemoteReads.swift:85-136).
//
// Le service n'a pas besoin du curseur incrémental du Mac : chaque lecture part du DÉBUT du
// fichier et rend la conversation entière (même résultat qu'un lecteur neuf du Mac). Seules
// les lignes COMPLÈTES (terminées par `\n`) sont consommées ; le fragment final est ignoré.
// Aucune écriture, aucun verrou : la session d'un run vivant reste lisible sans la perturber.
import fs from "node:fs";
import { sortedJson } from "./remoteApi.ts";

/** `RemoteLimits.responseBody` : 2 Mio par réponse JSON (S-7). */
export const REMOTE_RESPONSE_BODY_MAX = 2 * 1024 * 1024;
/** `RemoteLimits.sessionEntries`. */
export const REMOTE_SESSION_ENTRIES_MAX = 2000;

// --- le modèle de conversation (SessionModel.swift) ------------------------------------

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: number;
};

export type SessionHeader = { id: string; cwd: string; version?: number; timestamp?: string; parentSession?: string };

export type SessionToolCall = { id: string; name: string; arguments?: unknown; argumentsText?: string };

export type ConversationKind =
  | { type: "user"; text: string }
  | {
      type: "assistant";
      text: string;
      thinking?: string;
      model?: string;
      provider?: string;
      usage?: TokenUsage;
      toolCalls: SessionToolCall[];
    }
  | { type: "toolResult"; callId?: string; name?: string; text: string; diff?: string; isError: boolean }
  | { type: "compaction"; summary: string; tokensBefore?: number }
  | { type: "branchSummary"; summary: string; fromId: string };

export type ConversationEntry = { index: number; offset: number; kind: ConversationKind; timestampMs?: number };

export type SkipReason = "invalidJSON" | "unknownType" | "malformed";
export type SkippedEntry = { offset: number; reason: SkipReason };

/** Un incident d'ouverture : l'absence, ou la description de l'erreur système. */
export type SessionIssue = { type: "fileMissing" } | { type: "unreadable"; message: string };

export type SessionConversation = {
  header?: SessionHeader;
  /** `topLevel` ou `subagent` (marqué par l'EN-TÊTE, jamais par le nom du fichier). */
  kind?: "topLevel" | "subagent";
  entries: ConversationEntry[];
  skipped: SkippedEntry[];
  issue?: SessionIssue;
};

// --- JSON ordonné (OrderedJSON.swift) : l'ordre du fichier, pour `argumentsText` ----------

type OrderedJson =
  | { t: "object"; members: { key: string; value: OrderedJson }[] }
  | { t: "array"; items: OrderedJson[] }
  | { t: "string"; value: string }
  | { t: "number"; lexeme: string }
  | { t: "bool"; value: boolean }
  | { t: "null" };

const ORDERED_JSON_MAX_DEPTH = 512;

/** Analyse un texte JSON entier selon la RFC 8259 ; `null` sur tout écart (profondeur > 512 comprise). */
function parseOrdered(text: string): OrderedJson | null {
  let index = 0;
  let depth = 0;
  const skipSpace = () => {
    while (index < text.length && " \t\n\r".includes(text[index] as string)) index++;
  };
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

  const parseString = (): string | null => {
    index++; // guillemet ouvrant
    let out = "";
    while (index < text.length) {
      const c = text[index] as string;
      const code = c.charCodeAt(0);
      if (c === '"') {
        index++;
        return out;
      }
      if (code < 0x20) return null;
      if (c !== "\\") {
        // Une substitution UTF-16 seule n'est pas du texte valide.
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = text.charCodeAt(index + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
          out += c + (text[index + 1] as string);
          index += 2;
          continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff) return null;
        out += c;
        index++;
        continue;
      }
      const e = text[index + 1];
      index += 2;
      switch (e) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "/": out += "/"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u": {
          const unit = hex4(index);
          if (unit === null) return null;
          index += 4;
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (text[index] !== "\\" || text[index + 1] !== "u") return null;
            const low = hex4(index + 2);
            if (low === null || low < 0xdc00 || low > 0xdfff) return null;
            index += 6;
            out += String.fromCharCode(unit, low);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return null;
          } else {
            out += String.fromCharCode(unit);
          }
          break;
        }
        default:
          return null;
      }
    }
    return null;
  };
  const hex4 = (at: number): number | null => {
    const digits = text.slice(at, at + 4);
    return /^[0-9a-fA-F]{4}$/.test(digits) ? Number.parseInt(digits, 16) : null;
  };

  const parseNumber = (): OrderedJson | null => {
    const start = index;
    if (text[index] === "-") index++;
    if (text[index] === "0") index++;
    else if (isDigit(text[index])) while (isDigit(text[index])) index++;
    else return null;
    if (text[index] === ".") {
      index++;
      if (!isDigit(text[index])) return null;
      while (isDigit(text[index])) index++;
    }
    if (text[index] === "e" || text[index] === "E") {
      index++;
      if (text[index] === "+" || text[index] === "-") index++;
      if (!isDigit(text[index])) return null;
      while (isDigit(text[index])) index++;
    }
    return { t: "number", lexeme: text.slice(start, index) };
  };

  const parseLiteral = (word: string, value: OrderedJson): OrderedJson | null => {
    if (!text.startsWith(word, index)) return null;
    index += word.length;
    return value;
  };

  const parseValue = (): OrderedJson | null => {
    const c = text[index];
    if (c === "{") {
      if (++depth > ORDERED_JSON_MAX_DEPTH) return null;
      index++;
      const members: { key: string; value: OrderedJson }[] = [];
      skipSpace();
      if (text[index] === "}") {
        index++;
        depth--;
        return { t: "object", members };
      }
      for (;;) {
        if (text[index] !== '"') return null;
        const key = parseString();
        if (key === null) return null;
        skipSpace();
        if (text[index] !== ":") return null;
        index++;
        skipSpace();
        const value = parseValue();
        if (value === null) return null;
        members.push({ key, value });
        skipSpace();
        if (text[index] === ",") {
          index++;
          skipSpace();
        } else if (text[index] === "}") {
          index++;
          depth--;
          return { t: "object", members };
        } else return null;
      }
    }
    if (c === "[") {
      if (++depth > ORDERED_JSON_MAX_DEPTH) return null;
      index++;
      const items: OrderedJson[] = [];
      skipSpace();
      if (text[index] === "]") {
        index++;
        depth--;
        return { t: "array", items };
      }
      for (;;) {
        const value = parseValue();
        if (value === null) return null;
        items.push(value);
        skipSpace();
        if (text[index] === ",") {
          index++;
          skipSpace();
        } else if (text[index] === "]") {
          index++;
          depth--;
          return { t: "array", items };
        } else return null;
      }
    }
    if (c === '"') {
      const value = parseString();
      return value === null ? null : { t: "string", value };
    }
    if (c === "t") return parseLiteral("true", { t: "bool", value: true });
    if (c === "f") return parseLiteral("false", { t: "bool", value: false });
    if (c === "n") return parseLiteral("null", { t: "null" });
    if (c === "-" || isDigit(c)) return parseNumber();
    return null;
  };

  skipSpace();
  const value = parseValue();
  if (value === null) return null;
  skipSpace();
  return index === text.length ? value : null;
}

/** `escapeJSON` (SessionRendering.swift) : guillemet, antislash, \n \r \t \b \f, autres contrôles en \u00xx minuscule. */
function escapeJson(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x0c) out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/** `OrderedJSON.rendered` : compact, ordre conservé, nombres par leur lexème. */
function renderOrdered(value: OrderedJson): string {
  switch (value.t) {
    case "object":
      return `{${value.members.map(m => `"${escapeJson(m.key)}":${renderOrdered(m.value)}`).join(",")}}`;
    case "array":
      return `[${value.items.map(renderOrdered).join(",")}]`;
    case "string":
      return `"${escapeJson(value.value)}"`;
    case "number":
      return value.lexeme;
    case "bool":
      return value.value ? "true" : "false";
    case "null":
      return "null";
  }
}

/** Valeur du DERNIER membre de clé `key` (comme `JSONSerialization`). */
function lastMember(value: OrderedJson | undefined, key: string): OrderedJson | undefined {
  if (value?.t !== "object") return undefined;
  for (let i = value.members.length - 1; i >= 0; i--) {
    const member = value.members[i] as { key: string; value: OrderedJson };
    if (member.key === key) return member.value;
  }
  return undefined;
}

/** Le texte ORDONNÉ des arguments de chaque appel de la ligne ; tout ou rien par compte. */
function orderedArgumentsTexts(line: string, count: number): (string | undefined)[] | null {
  const parsed = parseOrdered(line);
  const content = lastMember(lastMember(parsed ?? undefined, "message"), "content");
  if (content?.t !== "array") return null;
  const calls = content.items.filter(item => {
    const type = lastMember(item, "type");
    return type?.t === "string" && type.value === "toolCall";
  });
  if (calls.length !== count) return null;
  return calls.map(call => {
    const args = lastMember(call, "arguments");
    return args === undefined ? undefined : renderOrdered(args);
  });
}

// --- la classification d'une ligne -----------------------------------------------------

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `(x as? NSNumber)?.intValue` : un nombre tronqué, un booléen JSON vaut 1 ou 0. */
function nsInt(value: unknown): number | undefined {
  if (typeof value === "number") return Math.trunc(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

/** `(x as? NSNumber)?.doubleValue`. */
function nsDouble(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

const ISO_TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

/** L'horodatage ISO 8601 (avec ou sans fraction) en millisecondes époque ; `undefined` si absent ou illisible. */
function entryTimestamp(object: Json): number | undefined {
  const text = object.timestamp;
  if (typeof text !== "string") return undefined;
  const match = ISO_TIMESTAMP.exec(text);
  if (match === null) return undefined;
  const whole = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(whole)) return undefined;
  const fraction = match[2] === undefined ? 0 : Number(`0${match[2]}`);
  return (whole / 1000 + fraction) * 1000;
}

const OUT_OF_SCOPE_TYPES: Record<string, true> = {
  model_usage: true,
  thinking_level_change: true,
  model_change: true,
  service_tier_change: true,
  reset_boundary: true,
  custom: true,
  custom_message: true,
  label: true,
  title_change: true,
  ttsr_injection: true,
  credential_pin: true,
  session_init: true,
  mode_change: true,
};

function contentBlocks(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

/** Une chaîne seule, ou la concaténation par `\n` des blocs `text`. */
function bodyText(content: unknown): string {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join("\n");
}

/** `usage` d'un message assistant : `input`/`output`/… (entiers, 0 par défaut) et `cost.total` quand il est numérique. */
function usageOf(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  const integer = (key: string) => nsInt(value[key]) ?? 0;
  const cost = isObject(value.cost) ? nsDouble(value.cost.total) : undefined;
  return {
    input: integer("input"),
    output: integer("output"),
    cacheRead: integer("cacheRead"),
    cacheWrite: integer("cacheWrite"),
    totalTokens: integer("totalTokens"),
    ...(cost === undefined ? {} : { cost }),
  };
}

type Classified =
  | { type: "silent" }
  | { type: "skipped"; reason: SkipReason }
  | { type: "entry"; kind: ConversationKind; timestampMs: number | undefined }
  | { type: "header"; header: SessionHeader };

const SILENT: Classified = { type: "silent" };

function assistantKind(message: Json, line: string): ConversationKind {
  const blocks = contentBlocks(message.content);
  const thinking = blocks.filter(b => b.type === "thinking" && typeof b.thinking === "string").map(b => b.thinking as string);
  const toolCalls: SessionToolCall[] = blocks
    .filter(b => b.type === "toolCall")
    .map(b => ({
      id: typeof b.id === "string" ? b.id : "",
      name: typeof b.name === "string" ? b.name : "",
      ...(isObject(b.arguments) ? { arguments: b.arguments } : {}),
    }));
  if (toolCalls.length > 0) {
    const texts = orderedArgumentsTexts(line, toolCalls.length);
    if (texts !== null) {
      toolCalls.forEach((call, position) => {
        const text = texts[position];
        if (text !== undefined) call.argumentsText = text;
      });
    }
  }
  const usage = usageOf(message.usage);
  return {
    type: "assistant",
    text: bodyText(message.content),
    ...(thinking.length === 0 ? {} : { thinking: thinking.join("\n") }),
    ...(typeof message.model === "string" ? { model: message.model } : {}),
    ...(typeof message.provider === "string" ? { provider: message.provider } : {}),
    ...(usage === undefined ? {} : { usage }),
    toolCalls,
  };
}

function classify(bytes: Buffer, decoder: TextDecoder): Classified {
  // Règle 1 : vide ou espaces seulement.
  if (bytes.every(b => b === 0x20 || b === 0x09 || b === 0x0d)) return SILENT;
  // Règle 2 : UTF-8 invalide ou JSON invalide.
  let line: string;
  let parsed: unknown;
  try {
    line = decoder.decode(bytes);
    parsed = JSON.parse(line);
  } catch {
    return { type: "skipped", reason: "invalidJSON" };
  }
  // Règles 3 et 4 : pas un objet, ou `type` absent/hors des types connus.
  if (!isObject(parsed) || typeof parsed.type !== "string") return { type: "skipped", reason: "unknownType" };
  const timestampMs = entryTimestamp(parsed);
  switch (parsed.type) {
    case "session": {
      if (typeof parsed.id !== "string") return { type: "skipped", reason: "malformed" };
      const version = nsInt(parsed.version);
      const parent = typeof parsed.parentSession === "string" && parsed.parentSession !== "" ? parsed.parentSession : undefined;
      return {
        type: "header",
        header: {
          id: parsed.id,
          cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
          ...(version === undefined ? {} : { version }),
          ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
          ...(parent === undefined ? {} : { parentSession: parent }),
        },
      };
    }
    case "title":
      return SILENT;
    case "message": {
      const message = parsed.message;
      if (!isObject(message) || typeof message.role !== "string") return { type: "skipped", reason: "malformed" };
      switch (message.role) {
        case "user":
          return { type: "entry", kind: { type: "user", text: bodyText(message.content) }, timestampMs };
        case "assistant":
          return { type: "entry", kind: assistantKind(message, line), timestampMs };
        case "toolResult": {
          const details = isObject(message.details) ? message.details : undefined;
          return {
            type: "entry",
            kind: {
              type: "toolResult",
              ...(typeof message.toolCallId === "string" ? { callId: message.toolCallId } : {}),
              ...(typeof message.toolName === "string" ? { name: message.toolName } : {}),
              text: bodyText(message.content),
              ...(typeof details?.diff === "string" ? { diff: details.diff } : {}),
              isError: message.isError === true,
            },
            timestampMs,
          };
        }
        default:
          return SILENT;
      }
    }
    case "compaction": {
      if (typeof parsed.summary !== "string") return { type: "skipped", reason: "malformed" };
      const tokensBefore = nsInt(parsed.tokensBefore);
      return {
        type: "entry",
        kind: { type: "compaction", summary: parsed.summary, ...(tokensBefore === undefined ? {} : { tokensBefore }) },
        timestampMs,
      };
    }
    case "branch_summary":
      if (typeof parsed.summary !== "string") return { type: "skipped", reason: "malformed" };
      return {
        type: "entry",
        kind: { type: "branchSummary", summary: parsed.summary, fromId: typeof parsed.fromId === "string" ? parsed.fromId : "" },
        timestampMs,
      };
    default:
      return OUT_OF_SCOPE_TYPES[parsed.type] === true ? SILENT : { type: "skipped", reason: "unknownType" };
  }
}

// --- la lecture d'un fichier ------------------------------------------------------------

/** Lit un fichier de session du début à la fin ; ne lève jamais (un incident devient `issue`). */
export function readSessionFile(file: string): SessionConversation {
  const conversation: SessionConversation = { entries: [], skipped: [] };
  let bytes: Buffer;
  try {
    fs.statSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    conversation.issue = code === "ENOENT" || code === "ENOTDIR" ? { type: "fileMissing" } : { type: "unreadable", message: (err as Error).message };
    return conversation;
  }
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    conversation.issue = { type: "unreadable", message: code === "EACCES" ? "ouverture en lecture refusée" : (err as Error).message };
    return conversation;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const classified = classify(bytes.subarray(start, newline), decoder);
    switch (classified.type) {
      case "skipped":
        conversation.skipped.push({ offset: start, reason: classified.reason });
        break;
      case "entry":
        conversation.entries.push({
          index: conversation.entries.length + 1,
          offset: start,
          kind: classified.kind,
          ...(classified.timestampMs === undefined ? {} : { timestampMs: classified.timestampMs }),
        });
        break;
      case "header":
        // L'en-tête est posé une fois pour toutes : une seconde ligne `session` ne le remplace pas.
        if (conversation.header === undefined) {
          conversation.header = classified.header;
          conversation.kind = classified.header.parentSession === undefined ? "topLevel" : "subagent";
        }
        break;
      case "silent":
        break;
    }
    start = newline + 1;
  }
  return conversation;
}

// --- la projection filaire ---------------------------------------------------------------

export type RemoteConversationEntry = {
  index: number;
  offset?: number;
  timestampMs?: number;
  kind: "user" | "assistant" | "toolResult" | "compaction" | "branchSummary";
  text?: string;
  thinking?: string;
  model?: string;
  usage?: TokenUsage;
  toolCalls?: SessionToolCall[];
  callId?: string;
  name?: string;
  diff?: string;
  isError?: boolean;
  tokensBefore?: number;
  fromId?: string;
};

export type RemoteSessionPayload = {
  header?: SessionHeader;
  kind?: string;
  entries: RemoteConversationEntry[];
  skipped: SkippedEntry[];
  truncated: boolean;
  unreadableReason?: string;
};

/** `RemoteConversationEntry.init(_ entry:)`. */
export function remoteEntry(entry: ConversationEntry): RemoteConversationEntry {
  const base = {
    index: entry.index,
    offset: entry.offset,
    ...(entry.timestampMs === undefined ? {} : { timestampMs: entry.timestampMs }),
  };
  const kind = entry.kind;
  switch (kind.type) {
    case "user":
      return { ...base, kind: "user", text: kind.text };
    case "assistant":
      return {
        ...base,
        kind: "assistant",
        text: kind.text,
        ...(kind.thinking === undefined ? {} : { thinking: kind.thinking }),
        ...(kind.model === undefined ? {} : { model: kind.model }),
        ...(kind.usage === undefined ? {} : { usage: kind.usage }),
        ...(kind.toolCalls.length === 0 ? {} : { toolCalls: kind.toolCalls }),
      };
    case "toolResult":
      return {
        ...base,
        kind: "toolResult",
        text: kind.text,
        ...(kind.callId === undefined ? {} : { callId: kind.callId }),
        ...(kind.name === undefined ? {} : { name: kind.name }),
        ...(kind.diff === undefined ? {} : { diff: kind.diff }),
        isError: kind.isError,
      };
    case "compaction":
      return {
        ...base,
        kind: "compaction",
        text: kind.summary,
        ...(kind.tokensBefore === undefined ? {} : { tokensBefore: kind.tokensBefore }),
      };
    case "branchSummary":
      return { ...base, kind: "branchSummary", text: kind.summary, fromId: kind.fromId };
  }
}

/**
 * La charge utile de `GET /v1/sessions/:id` : lecture du fichier, bornée aux 2000 dernières
 * entrées puis, tant que l'encodage dépasse 2 Mio, amputée de sa moitié la plus ancienne.
 * Un fichier illisible reste un 200 qui porte `unreadableReason`.
 */
export function sessionPayload(file: string): RemoteSessionPayload {
  const conversation = readSessionFile(file);
  const skipped = conversation.skipped.map(s => ({ offset: s.offset, reason: s.reason }));
  const unreadableReason = conversation.issue?.type === "unreadable" ? conversation.issue.message : undefined;
  const header = conversation.header;
  const kind = conversation.kind ?? (header === undefined ? undefined : "topLevel");
  const all = conversation.entries;
  let kept = all.slice(Math.max(0, all.length - REMOTE_SESSION_ENTRIES_MAX)).map(remoteEntry);
  let truncated = all.length > kept.length;
  const build = (): RemoteSessionPayload => ({
    ...(header === undefined ? {} : { header }),
    ...(kind === undefined ? {} : { kind }),
    entries: kept,
    skipped,
    truncated,
    ...(unreadableReason === undefined ? {} : { unreadableReason }),
  });
  let payload = build();
  while (kept.length > 0 && Buffer.byteLength(sortedJson(payload)) > REMOTE_RESPONSE_BODY_MAX) {
    kept = kept.slice(Math.max(1, Math.floor(kept.length / 2)));
    truncated = true;
    payload = build();
  }
  return payload;
}
