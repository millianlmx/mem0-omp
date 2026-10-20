// Les OUTILS DE PILOTAGE (outils-de-pilotage-du-mod-le, S-1..S-4, S-6, S-7) : quatre outils
// qu'une session OMP interactive offre à son modèle pour piloter le lot du dépôt — lire son
// état, poster un geste au service, lire la fin du dernier run d'une feature, faire avancer
// son worktree sur la base. Ils ne sont JAMAIS armés dans un enfant headless de lot (la
// décision d'armer appartient à `session_start`, extension.ts).
//
// Doctrine :
//  * LECTURE PURE pour `pipeline_state` et `pipeline_session_tail` : `readStore`, `readLot`,
//    `readDeliveries`, `entriesOfText` — jamais `reconcileStore` ni `readPanelModel` (qui
//    ÉCRIVENT), jamais `readSessionTail` (plafonné), et aucune troncature des textes rendus ;
//  * ÉCRITURE par l'API du service SEULEMENT (`postCommand`) : l'outil construit l'enveloppe
//    (id, horodatage, dépôt) — le modèle ne fournit ni URL, ni jeton, ni identifiant — et ne
//    dépose JAMAIS de fichier (ni boîte de run, ni journal) : une réponse à une question en
//    vol passe par le contrôleur du lot (journal + `answeredAsks` + livraison) ;
//  * APPROBATION `prompt` des deux outils d'écriture dans TOUS les modes de l'hôte : l'hôte
//    ne lève `execute` qu'après l'accord de l'utilisateur (wrapper d'outil d'extension).
import * as fs from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { COMMAND_KINDS, asCommand, commandShapeRefusal } from "./commands.ts";
import type { CommandKind, PipelineCommand } from "./commands.ts";
import { realpathOr, repoRootOf } from "./git.ts";
import {
  LOT_NONE_REFUSAL,
  lotFeature,
  lotFeatureMissingRefusal,
  lotRepoKey,
  parseReplyOptions,
  questionOf,
  readLot,
} from "./lot.ts";
import type { LotFeature } from "./lot.ts";
import { entriesOfText, type SessionEntryLike } from "./panelSession.ts";
import type { ServiceClient } from "./serviceClient.ts";
import { liveRunFor, readDeliveries, readStore, panelInboxDirOf } from "./store.ts";
import type { PanelAskOption, RunningEntry } from "./store.ts";

/**
 * L'approbation des outils d'ÉCRITURE : `policy: "prompt"` fait demander l'utilisateur dans les
 * trois modes (always-ask, write, yolo) — sans elle, `{tier: "write"}` serait auto-approuvé en
 * yolo, le défaut de l'hôte. Une politique utilisateur `allow` ne la contourne pas ; seule
 * `deny` l'emporte (OMP 18.8.6, tools/approval.ts `resolveApproval`).
 */
export const PILOT_WRITE_APPROVAL = {
  tier: "write",
  policy: "prompt",
  reason: "geste de pilotage posté au service OMP",
} as const;

const PILOT_READ_APPROVAL = { tier: "read" } as const;

/** Bornes de `n` pour `pipeline_session_tail`. */
export const PILOT_TAIL_MIN = 1;
export const PILOT_TAIL_MAX = 1000;

/** Les kinds que `pipeline_command` accepte : ceux du service, sans `avance` (outil dédié). */
export const PILOT_COMMAND_KINDS: readonly Exclude<CommandKind, "avance">[] = (
  Object.keys(COMMAND_KINDS) as CommandKind[]
).filter((kind): kind is Exclude<CommandKind, "avance"> => kind !== "avance");

// --- sorties ------------------------------------------------------------------

export type PilotQuestion =
  | { kind: "ask"; toolCallId: string; question: string; options: PanelAskOption[] }
  | { kind: "text"; question: string; options: string[]; source: "session" | "waitPrompt" };

export type PilotFeature = {
  slug: string;
  name: string;
  state: LotFeature["state"];
  phase: LotFeature["phase"];
  sinceAt: number;
  waitKind: LotFeature["waitKind"];
  prUrl: string | null;
  base: string | null;
  worktree: string;
  branch: string;
  running: boolean;
  questions: PilotQuestion[];
};

export type PilotLot = { id: string; status: string; features: PilotFeature[] };

export type PilotState = { repoRoot: string; lots: PilotLot[] };

/** Un message de session rendu lisible : rôle, texte, appels d'outil avec leurs arguments COMPLETS. */
export type PilotMessage = {
  role: string;
  text: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  toolCallId?: string;
  isError?: boolean;
};

export type PilotToolsDeps = {
  /** Le répertoire d'état du service, le même que celui du panneau. */
  stateDir: () => string;
  client: () => ServiceClient;
};

type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});
const refuse = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Un objet ordinaire en lecture (sinon `{}`) : une entrée de session ou des paramètres d'outil sont des données externes. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

// --- le dépôt de la session -----------------------------------------------------

/** « Dépôt de la session » : depuis un worktree de feature, le dépôt PRINCIPAL ; hors git, le cwd résolu. */
function sessionRepoOf(ctx: ExtensionContext | undefined): string {
  return realpathOr(repoRootOf(ctx?.cwd ?? process.cwd()));
}

// --- lecture d'une session ------------------------------------------------------

function readEntries(file: string | null): SessionEntryLike[] | null {
  if (file === null || file === "") return null;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return entriesOfText(text, 0);
}

/** Les blocs texte d'un contenu de message, joints par `\n` (ou le contenu s'il est une chaîne). */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = recordOf(block);
    if (b.type === "text") {
      const text = b.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function toolCallsOf(content: unknown): PilotMessage["toolCalls"] {
  if (!Array.isArray(content)) return [];
  const calls: PilotMessage["toolCalls"] = [];
  for (const block of content) {
    const b = recordOf(block);
    if (b.type !== "toolCall") continue;
    calls.push({
      id: typeof b.id === "string" ? b.id : "",
      name: typeof b.name === "string" ? b.name : "",
      arguments: b.arguments ?? {},
    });
  }
  return calls;
}

/** Les messages d'un fichier de session, dans l'ordre du fichier, sans plafond ni troncature. */
export function pilotMessagesOf(entries: SessionEntryLike[]): PilotMessage[] {
  const out: PilotMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    const message: PilotMessage = {
      role: typeof m.role === "string" ? m.role : "",
      text: textOfContent(m.content),
      toolCalls: toolCallsOf(m.content),
    };
    if (message.role === "toolResult") {
      message.toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
      message.isError = m.isError === true;
    }
    out.push(message);
  }
  return out;
}

// --- pipeline_state -------------------------------------------------------------

/** La question en TEXTE d'une feature `waiting`/`answer` : le dernier message assistant, en entier. */
function textQuestionOf(feature: LotFeature): PilotQuestion {
  const entries = readEntries(feature.lastRunSessionFile ?? feature.sessionFile);
  if (entries !== null) {
    const assistants = pilotMessagesOf(entries).filter((m) => m.role === "assistant" && m.text.trim() !== "");
    const last = assistants[assistants.length - 1];
    if (last !== undefined) {
      return {
        kind: "text",
        question: questionOf(last.text) ?? last.text,
        options: parseReplyOptions(last.text),
        source: "session",
      };
    }
  }
  const prompt = feature.waitPrompt ?? "";
  return {
    kind: "text",
    question: questionOf(prompt) ?? prompt,
    options: parseReplyOptions(prompt),
    source: "waitPrompt",
  };
}

/** La question `ask` en vol, sauf si sa réponse est déjà livrée (acheminée, pas encore consommée). */
function askQuestionOf(entry: RunningEntry | null): PilotQuestion | null {
  const asked = entry?.pendingAsk;
  if (!entry || !asked) return null;
  const inbox = panelInboxDirOf(entry);
  if (inbox !== null) {
    const delivered = readDeliveries(inbox).some(
      (d) => d.delivery?.kind === "ask" && d.delivery.toolCallId === asked.toolCallId,
    );
    if (delivered) return null;
  }
  return { kind: "ask", toolCallId: asked.toolCallId, question: asked.question, options: asked.options };
}

/** L'état du lot du dépôt, tel que le panneau le lit, SANS rien écrire. */
export function pilotStateOf(stateDir: string, repoRoot: string): PilotState {
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  if (lot === null) return { repoRoot, lots: [] };
  const snapshot = readStore(stateDir);
  const features: PilotFeature[] = lot.features.map((f) => {
    const entry = liveRunFor(stateDir, f.worktree, snapshot);
    const questions: PilotQuestion[] = [];
    const ask = askQuestionOf(entry);
    if (ask !== null) questions.push(ask);
    if (f.state === "waiting" && f.waitKind === "answer") questions.push(textQuestionOf(f));
    return {
      slug: f.slug,
      name: f.name,
      state: f.state,
      phase: f.phase,
      sinceAt: f.sinceAt,
      waitKind: f.waitKind,
      prUrl: f.prUrl,
      base: f.base ?? null,
      worktree: f.worktree,
      branch: f.branch,
      running: entry !== null,
      questions,
    };
  });
  return { repoRoot, lots: [{ id: lot.id, status: lot.status, features }] };
}

// --- pipeline_session_tail ------------------------------------------------------

/** Les `n` derniers messages du dernier run de la feature, du plus ancien au plus récent, ou un refus. */
export function pilotTailOf(
  stateDir: string,
  repoRoot: string,
  slug: string,
  n: unknown,
): { ok: true; messages: PilotMessage[] } | { ok: false; reason: string } {
  if (typeof n !== "number" || !Number.isInteger(n) || n < PILOT_TAIL_MIN || n > PILOT_TAIL_MAX) {
    return { ok: false, reason: `n doit être un entier entre ${PILOT_TAIL_MIN} et ${PILOT_TAIL_MAX}` };
  }
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  if (lot === null) return { ok: false, reason: LOT_NONE_REFUSAL };
  const feature = lotFeature(lot, slug);
  if (feature === undefined) return { ok: false, reason: lotFeatureMissingRefusal(slug) };
  const live = liveRunFor(stateDir, feature.worktree);
  for (const file of [live?.sessionFile ?? null, feature.lastRunSessionFile ?? null, feature.sessionFile]) {
    const entries = readEntries(file);
    if (entries === null) continue;
    return { ok: true, messages: pilotMessagesOf(entries).slice(-n) };
  }
  return { ok: false, reason: `aucune session pour la feature « ${slug} »` };
}

// --- pipeline_command / pipeline_advance ----------------------------------------

/** Poste UNE commande au service et rend l'accusé (ou le refus de transport) tel quel. */
async function postGesture(deps: PilotToolsDeps, repo: string, raw: Record<string, unknown>): Promise<ToolResult> {
  const cmd: PipelineCommand | null = asCommand(raw);
  if (cmd === null) return refuse(commandShapeRefusal(raw));
  const posted = await deps.client().postCommand(repo, cmd);
  if (!posted.ok) return refuse(posted.reason);
  const result = ok(posted.ack);
  return posted.ack.state === "refused" ? { ...result, isError: true } : result;
}

/** L'enveloppe d'une commande : posée par l'outil, jamais par le modèle. */
function envelopeOf(deps: PilotToolsDeps, repo: string) {
  return { version: 1, id: deps.client().nextId("pilot"), sentAt: Date.now(), repo };
}

/** Les champs du corps d'une commande que le modèle peut fournir (hors enveloppe). */
const COMMAND_FIELDS = [
  "slug",
  "title",
  "description",
  "deps",
  "modelReqSpecs",
  "modelImplReview",
  "fallbackReqSpecs",
  "fallbackImplReview",
  "verdict",
  "provider",
  "model",
  "toolCallId",
  "selected",
  "custom",
  "text",
  "fate",
] as const;

const COMMAND_DESCRIPTION =
  "Poste UN geste de pilotage au service OMP du dépôt de la session (soumis à l'approbation de l'utilisateur) et rend l'accusé du service tel quel : " +
  "`state: taken` (pris en charge) ou `refused` (le motif est dans `reason`, rien n'a changé). Tu ne fournis que `kind` et ses champs : " +
  "l'identifiant, l'horodatage, le dépôt et le jeton sont posés par l'outil. Kinds : " +
  "launch/add {title, description, deps?, modelReqSpecs?, modelImplReview?, fallbackReqSpecs?, fallbackImplReview?} (ajoute une feature) ; " +
  "remove {slug} ; verdict {slug, verdict: v (valide les specs) | y (accepte la revue)} ; " +
  "answer {slug, toolCallId, selected (libellé EXACT d'une option) | custom (texte libre)} (répond à une question `ask` en vol — c'est le chemin officiel : journal du lot, jamais un fichier déposé) ; " +
  "reply {slug, text} (répond à une question en texte d'une feature en attente) ; " +
  "models {slug, modelReqSpecs, modelImplReview, fallbackReqSpecs?, fallbackImplReview?} ; " +
  "relaunch {slug} (relance une feature bloquée, échouée ou annulée) ; cancel {slug, fate: keep | archive | delete} ; " +
  "arbitrage {slug, text} (ajoute `text` au contrat sous « Arbitrages du pilote » puis relance, tout ou rien : refusé si la feature est en cours ou figée sur une question) ; " +
  "start {} (ouvre le lot) ; stop {} ; quota {provider, model}. " +
  "Un `taken` n'est pas une garantie de l'effet : relis `pipeline_state` ensuite.";

const ADVANCE_DESCRIPTION =
  "Fait avancer le worktree d'une feature AU REPOS sur la base du dépôt (soumis à l'approbation de l'utilisateur) : le service récupère la base par gh (HTTPS, sans SSH) " +
  "puis fait `merge --ff-only`. Refusé, par un motif nommé et sans rien modifier, si un maillon tourne dans le worktree ou si l'avance n'est pas fast-forward. " +
  "Rend l'accusé du service tel quel.";

/**
 * Inscrit les quatre outils de pilotage. Une seule fois par process : un second appel (second
 * `session_start` interactif) n'enregistre rien de plus — comme `state.tools` du relais.
 */
const registered = new WeakSet<object>();

export function registerPilotTools(pi: ExtensionAPI, deps: PilotToolsDeps): void {
  if (registered.has(pi)) return;
  registered.add(pi);

  const kinds = PILOT_COMMAND_KINDS.map((kind) => `'${kind}'`).join(" | ");

  pi.registerTool({
    name: "pipeline_state",
    label: "Pipeline — état du lot",
    description:
      "Rend l'état du lot du dépôt de la session (JSON) : pour chaque feature son état, sinceAt, waitKind, prUrl, base, worktree, et les questions en vol " +
      "avec leur texte et leurs options COMPLETS (question `ask` d'un run vivant, ou question en texte d'une feature en attente). Lecture seule ; " +
      "un dépôt sans lot rend `lots: []`.",
    approval: PILOT_READ_APPROVAL,
    loadMode: "essential",
    parameters: pi.arktype({}),
    async execute(
      _toolCallId: string,
      _params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      return ok(pilotStateOf(deps.stateDir(), sessionRepoOf(ctx)));
    },
  });

  pi.registerTool({
    name: "pipeline_command",
    label: "Pipeline — geste de pilotage",
    description: COMMAND_DESCRIPTION,
    approval: PILOT_WRITE_APPROVAL,
    loadMode: "essential",
    parameters: pi.arktype({
      kind: kinds,
      "slug?": "string",
      "title?": "string",
      "description?": "string",
      "deps?": "string[]",
      "modelReqSpecs?": "string | null",
      "modelImplReview?": "string | null",
      "fallbackReqSpecs?": "string | null",
      "fallbackImplReview?": "string | null",
      "verdict?": "'v' | 'y'",
      "provider?": "string",
      "model?": "string",
      "toolCallId?": "string",
      "selected?": "string",
      "custom?": "string",
      "text?": "string",
      "fate?": "'keep' | 'archive' | 'delete'",
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      const given = recordOf(params);
      // Seuls les champs déclarés passent : le modèle ne peut ni choisir l'identifiant, ni le dépôt.
      // `kind` « avance » reste réservé à `pipeline_advance` (le schéma le refuse déjà ; défense en profondeur).
      if (typeof given.kind !== "string" || !(PILOT_COMMAND_KINDS as readonly string[]).includes(given.kind)) {
        return refuse(`kind inconnu pour pipeline_command : ${String(given.kind)} (${PILOT_COMMAND_KINDS.join(", ")})`);
      }
      const body: Record<string, unknown> = { kind: given.kind };
      for (const field of COMMAND_FIELDS) {
        if (given[field] !== undefined) body[field] = given[field];
      }
      const repo = sessionRepoOf(ctx);
      return postGesture(deps, repo, { ...body, ...envelopeOf(deps, repo) });
    },
  });

  pi.registerTool({
    name: "pipeline_session_tail",
    label: "Pipeline — fin du dernier run",
    description:
      "Rend les `n` derniers messages (1 à 1000) du dernier run de la feature `slug`, du plus ancien au plus récent, lisibles : rôle, texte, " +
      "appels d'outil avec leurs arguments COMPLETS (aucune troncature). Lecture seule.",
    approval: PILOT_READ_APPROVAL,
    loadMode: "essential",
    parameters: pi.arktype({ slug: "string", n: "number" }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      const { slug, n } = recordOf(params);
      const tail = pilotTailOf(deps.stateDir(), sessionRepoOf(ctx), typeof slug === "string" ? slug : "", n);
      return tail.ok ? ok(tail.messages) : refuse(tail.reason);
    },
  });

  pi.registerTool({
    name: "pipeline_advance",
    label: "Pipeline — avancer sur la base",
    description: ADVANCE_DESCRIPTION,
    approval: PILOT_WRITE_APPROVAL,
    loadMode: "essential",
    parameters: pi.arktype({ slug: "string" }),
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      const slug = recordOf(params).slug;
      const repo = sessionRepoOf(ctx);
      return postGesture(deps, repo, { ...envelopeOf(deps, repo), kind: "avance", slug });
    },
  });
}
