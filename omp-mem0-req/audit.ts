// /audit : le relais des questions et des jalons d'une pipeline vers sa session /audit.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { isReviewCapReason } from "./chain.ts";
import { CONTRACT_PATH } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { toSlug } from "./git.ts";
import { cleanAskText } from "./inbox.ts";
import { LOT_EDITOR_MAX, LOT_TICK_MS, lotOwnerAlive, lotRepoKey, parseReplyOptions, questionOf, readLot } from "./lot.ts";
import type { Lot, LotFeature } from "./lot.ts";
import type { LotController } from "./lotController.ts";
import { sessionFileOf } from "./publish.ts";
import { repoRootOf } from "./runs.ts";
import { liveRunFor, panelInboxDirOf, removeAuditRelay, writeAuditRelay, writeDelivery } from "./store.ts";
import type { PanelAskOption, PipelineCtx, RunningEntry } from "./store.ts";



// ---------------------------------------------------------------------------
// Le relais /audit — une session interactive qui tranche pour l'utilisateur.
// ---------------------------------------------------------------------------
// La session /audit lance UNE feature dans le lot (le pilote existant la
// conduit) puis devient son RELAIS : chaque question d'un maillon et chaque jalon
// lui est injecté comme un message `[audit]`, et elle y répond par ses outils
// (`audit_reply`, `audit_approve`, `audit_escalate`). Le relais n'écrit JAMAIS le
// lot : il livre une réponse `ask` dans la boîte du run (comme le panneau) ou
// appelle les actions du pilote (qui exigent la propriété du lot — d'où la règle
// « un relais ouvert est tenu par le pilote »).
//
// Le relais est OUVERT tant que la session /audit est la session courante du
// process pilote : un fichier de battement (`<stateDir>/audit/<id>.json`) le dit
// au pilote et au panneau, qui cessent alors de proposer ces questions et ces
// jalons. Quitter la session (ou la fermer) retire le fichier — tout retombe sur
// le panneau ; y revenir le réécrit et ré-injecte ce qui attend encore.

export type AuditItemKind = "ask" | "question" | "specs" | "review" | "cap";

/** Un élément relayé à la session /audit : une question ou un jalon d'une feature /audit (S-6). */
export type AuditItem = {
  /** `${kind}:${slug}:${discriminant}` — discriminant = toolCallId (ask), String(feature.sinceAt) sinon. */
  key: string;
  kind: AuditItemKind;
  slug: string;
  phase: PipelinePhase;
  worktree: string;
  question: string | null;
  options: PanelAskOption[];
  toolCallId: string | null;
  inbox: string | null;
  stopReason: string | null;
};


/** L'état /audit du process : partagé par les instances de l'extension (même patron que `runState`). */
export type AuditState = {
  /** Les quatre outils /audit : inscrits une seule fois par process. */
  tools: boolean;
  /** Les sessions ouvertes par `/audit` dans ce process. */
  created: Set<string>;
  /** La session /audit ARMÉE, ou `null`. */
  sessionFile: string | null;
  repoRoot: string | null;
  /** Les éléments déjà injectés dans la session armée, par clé. */
  relayed: Map<string, AuditItem>;
  stopTimer: (() => void) | null;
  /** Un dialogue /audit (choix, intention, escalade) est ouvert. */
  dialog: boolean;
  /** La notice « lot piloté ailleurs » est dite une fois par armement. */
  foreignWarned: boolean;
  ctx: ExtensionContext | null;
};

const AUDIT_STATE_KEY = Symbol.for("omp-mem0-req.auditState");

export const auditState: AuditState = (() => {
  const host = globalThis as unknown as Record<symbol, AuditState | undefined>;
  const existing = host[AUDIT_STATE_KEY];
  if (existing) return existing;
  const created: AuditState = {
    tools: false,
    created: new Set(),
    sessionFile: null,
    repoRoot: null,
    relayed: new Map(),
    stopTimer: null,
    dialog: false,
    foreignWarned: false,
    ctx: null,
  };
  host[AUDIT_STATE_KEY] = created;
  return created;
})();


export type AuditRelay = {
  markCreated(sessionFile: string): void;
  sync(ctx: ExtensionContext): void;
  disarm(): void;
  scan(): void;
  items(): AuditItem[];
};


export type AuditRelayDeps = {
  pi: ExtensionAPI;
  stateDir: () => string;
  controllerFor: (ctx: ExtensionContext) => LotController;
  notify: (text: string) => void;
  now?: () => number;
};


/**
 * Les éléments courants des features /audit d'une session, dans l'ordre du lot,
 * au plus un par feature (S-6). Pure hors `liveOf`, qui lit le run vivant.
 */
export function auditItemsOf(
  lot: Lot,
  sessionFile: string,
  liveOf: (feature: LotFeature) => RunningEntry | null,
): AuditItem[] {
  const items: AuditItem[] = [];
  for (const feature of lot.features) {
    if (feature.auditSession !== sessionFile) continue;
    const base = {
      slug: feature.slug,
      phase: feature.phase,
      worktree: feature.worktree,
      question: null,
      options: [] as PanelAskOption[],
      toolCallId: null,
      inbox: null,
      stopReason: null,
    };
    const since = String(feature.sinceAt);
    if (feature.state === "running") {
      const entry = liveOf(feature);
      const inbox = entry ? panelInboxDirOf(entry) : null;
      const ask = entry?.pendingAsk ?? null;
      if (inbox === null || !ask) continue;
      items.push({
        ...base,
        key: `ask:${feature.slug}:${ask.toolCallId}`,
        kind: "ask",
        question: ask.question,
        options: ask.options,
        toolCallId: ask.toolCallId,
        inbox,
      });
      continue;
    }
    if (feature.state === "waiting" && feature.waitKind === "answer") {
      items.push({
        ...base,
        key: `question:${feature.slug}:${since}`,
        kind: "question",
        question: questionOf(feature.waitPrompt) ?? feature.waitPrompt,
        options: parseReplyOptions(feature.waitPrompt).map((label) => ({ label })),
      });
      continue;
    }
    if (feature.state === "waiting" && (feature.waitKind === "specs" || feature.waitKind === "review")) {
      items.push({ ...base, key: `${feature.waitKind}:${feature.slug}:${since}`, kind: feature.waitKind });
      continue;
    }
    if (feature.state === "blocked" && feature.phase === "review" && isReviewCapReason(feature.stopReason)) {
      items.push({ ...base, key: `cap:${feature.slug}:${since}`, kind: "cap", stopReason: feature.stopReason });
    }
  }
  return items;
}


/** Le message injecté dans la session /audit pour un élément, mot pour mot (S-6). */
export function buildRelayMessage(item: AuditItem): string {
  const contract = path.join(item.worktree, CONTRACT_PATH);
  switch (item.kind) {
    case "ask":
    case "question": {
      const lines = [
        `[audit] Question de /${item.phase} — feature ${item.slug}`,
        `Élément : ${item.key}`,
        item.question ?? "(question sans texte)",
      ];
      if (item.options.length > 0) {
        lines.push("Options :");
        item.options.forEach((option, index) => {
          lines.push(`- (${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`);
        });
      }
      lines.push(
        `Contrat de la feature : ${contract}`,
        "Réponds toi-même avec audit_reply (élément, réponse = libellé exact d'une option ou texte libre) si l'audit et le contrat te donnent la réponse ; sinon audit_escalate (élément).",
      );
      return lines.join("\n");
    }
    case "specs":
      return [
        `[audit] Jalon « specs validées » — feature ${item.slug}`,
        `Élément : ${item.key}`,
        `À examiner : ${contract}, sections ## Spécifications et ## Lots.`,
        "Valide avec audit_approve (élément) si elles servent l'intention de l'audit ; en cas de doute, audit_escalate (élément).",
      ].join("\n");
    case "review":
      return [
        `[audit] Jalon « revue propre » — feature ${item.slug}`,
        `Élément : ${item.key}`,
        `À examiner : ${contract}, section ## Revue.`,
        "Accepte avec audit_approve (élément) — la livraison ouvrira la PR ; en cas de doute, audit_escalate (élément).",
      ].join("\n");
    case "cap":
      return [
        `[audit] Plafond de la boucle revue ⇄ correction — feature ${item.slug}`,
        `Élément : ${item.key}`,
        item.stopReason ?? "",
        "Aucune PR ne sera ouverte avant la décision de l'utilisateur : appelle audit_escalate (élément), sans trancher.",
      ].join("\n");
  }
}


/**
 * La validation d'une proposition `audit_propose` (S-5) : PURE, sans exception,
 * première erreur rendue, dans l'ordre du contrat.
 */
export function checkProposal(
  input: unknown,
):
  | { ok: true; proposal: { weaknesses: string[]; features: { slug: string; intention: string }[] } }
  | { ok: false; error: string } {
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const rawWeaknesses = record.weaknesses;
  if (!Array.isArray(rawWeaknesses) || rawWeaknesses.length < 1 || rawWeaknesses.length > 20) {
    return { ok: false, error: "Error: weaknesses must list 1 to 20 items" };
  }
  const weaknesses: string[] = [];
  for (const [index, raw] of rawWeaknesses.entries()) {
    const weakness = cleanAskText(typeof raw === "string" ? raw : "", 300).trim();
    if (weakness === "") return { ok: false, error: `Error: weakness ${index + 1} is empty` };
    weaknesses.push(weakness);
  }
  const rawFeatures = record.features;
  if (!Array.isArray(rawFeatures) || rawFeatures.length < 1 || rawFeatures.length > 8) {
    return { ok: false, error: "Error: features must list 1 to 8 items" };
  }
  const features: { slug: string; intention: string }[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of rawFeatures.entries()) {
    const n = index + 1;
    const feature = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const slug = typeof feature.name === "string" ? toSlug(feature.name) : null;
    if (slug === null) return { ok: false, error: `Error: feature ${n} has an invalid name` };
    if (slug === "aucune") return { ok: false, error: `Error: feature ${n} is named « aucune », which is reserved` };
    if (seen.has(slug)) return { ok: false, error: `Error: duplicate feature « ${slug} »` };
    seen.add(slug);
    const intention = typeof feature.intention === "string" ? feature.intention.trim().slice(0, LOT_EDITOR_MAX) : "";
    if (intention === "") return { ok: false, error: `Error: feature ${n} has no intention` };
    features.push({ slug, intention });
  }
  return { ok: true, proposal: { weaknesses, features } };
}


type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toolText(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

const NOT_ARMED = "Error: aucune session /audit active dans ce process";
const NEEDS_UI = "Error: /audit demande une session interactive";
const DIALOG_OPEN = "Error: un dialogue /audit est déjà ouvert — attends la réponse de l'utilisateur";
const FREE_TEXT = "Autre réponse (texte libre)";
const ABANDON_FEATURE = "Abandonner la feature (worktree et branche conservés)";
const gone = (item: string) => `Error: ${item} n'est plus en attente (déjà traité, ou retombé au panneau /pipelines)`;
const reserved = (item: string) => `Error: ${item} : décision réservée à l'utilisateur — appelle audit_escalate`;


/** La fabrique du relais (S-6) et de ses quatre outils. */
export function createAuditRelay(deps: AuditRelayDeps): AuditRelay {
  const { pi } = deps;
  const now = () => (deps.now ?? Date.now)();
  const state = auditState;

  const lotOf = (repoRoot: string): Lot | null => readLot(deps.stateDir(), lotRepoKey(repoRoot));

  function disarm(): void {
    try {
      if (state.sessionFile !== null) removeAuditRelay(deps.stateDir(), state.sessionFile);
    } catch {
      /* le retrait ne jette jamais */
    }
    try {
      state.stopTimer?.();
    } catch {
      /* une minuterie déjà nettoyée n'est pas une erreur */
    }
    state.stopTimer = null;
    state.sessionFile = null;
    state.relayed.clear();
  }

  function items(): AuditItem[] {
    const { sessionFile, repoRoot } = state;
    if (sessionFile === null || repoRoot === null) return [];
    const lot = lotOf(repoRoot);
    if (lot === null) return [];
    const stateDir = deps.stateDir();
    return auditItemsOf(lot, sessionFile, (f) => (f.worktree === "" ? null : liveRunFor(stateDir, f.worktree)));
  }

  function scan(): void {
    try {
      const { sessionFile, repoRoot, ctx } = state;
      if (sessionFile === null || repoRoot === null || ctx === null) return;
      const stateDir = deps.stateDir();
      let lot = lotOf(repoRoot);
      if (lot === null) {
        removeAuditRelay(stateDir, sessionFile);
        return;
      }
      if (lot.owner.pid !== process.pid) {
        if (lotOwnerAlive(lot.owner, now())) {
          removeAuditRelay(stateDir, sessionFile);
          state.relayed.clear();
          if (!state.foreignWarned) {
            state.foreignWarned = true;
            deps.notify(
              `[audit] le lot de ${path.basename(repoRoot)} est piloté par une autre session vivante (pid ${lot.owner.pid}) : les questions et jalons de cette session /audit restent dans son panneau /pipelines`,
            );
          }
          return;
        }
        const controller = deps.controllerFor(ctx);
        if (controller.adopt()) controller.start();
        lot = lotOf(repoRoot);
        if (lot === null || lot.owner.pid !== process.pid) {
          removeAuditRelay(stateDir, sessionFile);
          return;
        }
      }
      // Le battement AVANT l'injection : le pilote et le panneau cessent de
      // proposer un élément au moment où /audit le reçoit.
      writeAuditRelay(stateDir, { version: 1, sessionFile, pid: process.pid, heartbeatAt: now() });
      const current = auditItemsOf(lot, sessionFile, (f) =>
        f.worktree === "" ? null : liveRunFor(stateDir, f.worktree),
      );
      const keys = new Set(current.map((item) => item.key));
      for (const key of [...state.relayed.keys()]) {
        if (!keys.has(key)) state.relayed.delete(key);
      }
      for (const item of current) {
        if (state.relayed.has(item.key)) continue;
        state.relayed.set(item.key, item);
        pi.sendMessage(
          { customType: "audit", content: buildRelayMessage(item), display: true, attribution: "agent" },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
    } catch {
      // Avalée : le balayage suivant réessaie.
    }
  }

  function sync(ctx: ExtensionContext): void {
    const sessionFile = sessionFileOf(ctx as PipelineCtx);
    if (sessionFile === null) {
      disarm();
      return;
    }
    const repoRoot = repoRootOf(ctx.cwd);
    const audit =
      state.created.has(sessionFile) ||
      (lotOf(repoRoot)?.features.some(
        (f) => f.auditSession === sessionFile && f.state !== "done" && f.state !== "cancelled",
      ) ??
        false);
    if (!audit) {
      disarm();
      return;
    }
    if (state.sessionFile === sessionFile) return;
    disarm();
    state.sessionFile = sessionFile;
    state.repoRoot = repoRoot;
    state.ctx = ctx;
    state.relayed = new Map();
    state.foreignWarned = false;
    if (!state.tools) {
      state.tools = true;
      registerAuditTools();
    }
    if (typeof ctx.setInterval === "function" && typeof ctx.clearTimer === "function") {
      const timer = ctx.setInterval(scan, LOT_TICK_MS);
      state.stopTimer = () => ctx.clearTimer(timer);
    }
    scan();
  }

  /** La session de `ctx` est-elle la session /audit armée ? */
  const armedOn = (ctx: ExtensionContext | undefined): boolean =>
    ctx !== undefined && state.sessionFile !== null && sessionFileOf(ctx as PipelineCtx) === state.sessionFile;

  const findItem = (key: string): AuditItem | undefined => items().find((item) => item.key === key);

  /** Livre une réponse `ask` dans la boîte du run : libellé exact ⇒ `selected`, sinon `custom`. */
  function deliverAsk(item: AuditItem, answer: string): string | null {
    const sentAt = now();
    const toolCallId = item.toolCallId ?? "";
    try {
      writeDelivery(
        item.inbox ?? "",
        item.options.some((o) => o.label === answer)
          ? { version: 1, kind: "ask", toolCallId, selected: answer, sentAt }
          : { version: 1, kind: "ask", toolCallId, custom: answer, sentAt },
      );
      return null;
    } catch (err) {
      return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** La question d'un élément ask/question, pour l'utilisateur : ses options d'origine, rien d'ajouté. */
  async function askUser(ctx: ExtensionContext, item: AuditItem, signal?: AbortSignal): Promise<string | undefined> {
    const question = item.question ?? "(question sans texte)";
    const ui = ctx.ui;
    if (typeof ui.askDialog === "function") {
      const result = await ui.askDialog([{ id: item.key, question, options: item.options, multi: false }], { signal });
      if (!result || result.kind !== "submit") return undefined;
      const first = result.results[0];
      if (!first || first.timedOut === true) return undefined;
      if (typeof first.customInput === "string" && first.customInput.trim() !== "") return first.customInput;
      return first.selectedOptions[0];
    }
    let answer: string | undefined;
    if (item.options.length > 0) {
      const chosen = await ui.select(question, [...item.options, { label: FREE_TEXT }], { signal });
      answer = chosen === FREE_TEXT ? await ui.input(question, undefined, { signal }) : chosen;
    } else {
      answer = await ui.input(question, undefined, { signal });
    }
    return answer === undefined || answer.trim() === "" ? undefined : answer;
  }

  function registerAuditTools(): void {
    pi.registerTool({
      name: "audit_propose",
      label: "Audit — proposer",
      description:
        "Soumet l'analyse de /audit (faiblesses et features proposées) : l'outil demande à l'utilisateur quelle pipeline lancer (ou « aucune »), lui fait valider ou amender l'intention transmise à /req, puis lance la pipeline de la feature choisie.",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({
        weaknesses: "string[]",
        features: pi.arktype({ name: "string", intention: "string" }).array(),
      }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const checked = checkProposal(params);
        if (!checked.ok) return toolText(checked.error, true);
        if (!armedOn(ctx) || ctx === undefined) return toolText(NOT_ARMED, true);
        if (!ctx.hasUI) return toolText(NEEDS_UI, true);
        const sessionFile = state.sessionFile as string;
        const launched = state.repoRoot === null ? undefined : lotOf(state.repoRoot)?.features.find((f) => f.auditSession === sessionFile);
        if (launched) return toolText(`Error: cette session /audit a déjà lancé « ${launched.slug} »`, true);
        if (state.dialog) return toolText(DIALOG_OPEN, true);
        state.dialog = true;
        try {
          const { features } = checked.proposal;
          const choice = await ctx.ui.select(
            "Quelle pipeline lancer ?",
            [
              ...features.map((f) => ({ label: f.slug, description: (f.intention.split("\n")[0] ?? "").slice(0, 200) })),
              { label: "aucune", description: "ne lancer aucune pipeline" },
            ],
            { signal },
          );
          if (choice === "aucune") return toolText("Aucune pipeline lancée : réponse « aucune ».");
          const feature = features.find((f) => f.slug === choice);
          if (feature === undefined) return toolText("Aucune pipeline lancée : choix abandonné.");
          const slug = feature.slug;
          let intention = feature.intention;
          for (;;) {
            const verdict = await ctx.ui.select(
              `Intention transmise à /req — ${slug}\n${intention}`,
              ["Valider et lancer", "Amender l'intention", "Abandonner"],
              { signal },
            );
            if (verdict === "Valider et lancer") break;
            if (verdict !== "Amender l'intention") return toolText("Aucune pipeline lancée : intention non validée.");
            const amended = await ctx.ui.editor(`Amende l'intention transmise à /req — ${slug}`, intention, { signal });
            if (amended !== undefined && amended.trim() !== "") intention = amended.trim().slice(0, LOT_EDITOR_MAX);
          }
          const refusal = await deps.controllerFor(ctx).add({ name: slug, description: intention, deps: [], auditSession: sessionFile });
          if (refusal !== null) return toolText(`Error: lancement refusé : ${refusal}`, true);
          scan();
          return toolText(
            `Pipeline lancée : « ${slug} » (branche feat/${slug}). Intention transmise à /req :\n${intention}\n` +
              "Les questions des maillons et les jalons te seront relayés par des messages [audit].",
          );
        } finally {
          state.dialog = false;
        }
      },
    });

    pi.registerTool({
      name: "audit_reply",
      label: "Audit — répondre",
      description:
        "Répond à la place de l'utilisateur à une question relayée par un message [audit] (élément = son identifiant ; réponse = libellé exact d'une option ou texte libre).",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ item: "string", answer: "string" }),
      async execute(_toolCallId: string, params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const { item: key, answer } = params as { item: string; answer: string };
        if (!armedOn(ctx) || ctx === undefined) return toolText(NOT_ARMED, true);
        const item = findItem(key);
        if (item === undefined) return toolText(gone(key), true);
        if (item.kind === "specs" || item.kind === "review") {
          return toolText(`Error: ${key} est un jalon — audit_approve pour valider, audit_escalate en cas de doute`, true);
        }
        if (item.kind === "cap") return toolText(reserved(key), true);
        if (answer.trim() === "") return toolText("Error: réponse vide", true);
        const refusal =
          item.kind === "ask"
            ? deliverAsk(item, answer)
            : await deps.controllerFor(ctx).answer(item.slug, answer, { from: "audit" });
        if (refusal !== null) return toolText(`Error: ${refusal}`, true);
        state.relayed.delete(key);
        return toolText(
          `Question de /${item.phase} — feature ${item.slug}\n${item.question ?? "(question sans texte)"}\nRéponse envoyée par /audit : ${answer}`,
        );
      },
    });

    pi.registerTool({
      name: "audit_approve",
      label: "Audit — valider",
      description:
        "Valide un jalon relayé par un message [audit] : « specs validées » (reprend sur /impl) ou « revue propre » (livre et ouvre la PR).",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ item: "string" }),
      async execute(_toolCallId: string, params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const { item: key } = params as { item: string };
        if (!armedOn(ctx) || ctx === undefined) return toolText(NOT_ARMED, true);
        const item = findItem(key);
        if (item === undefined) return toolText(gone(key), true);
        if (item.kind === "cap") return toolText(reserved(key), true);
        if (item.kind === "ask" || item.kind === "question") {
          return toolText(`Error: ${key} n'est pas un jalon — audit_reply ou audit_escalate`, true);
        }
        const controller = deps.controllerFor(ctx);
        const refusal = item.kind === "specs" ? await controller.validate(item.slug) : await controller.accept(item.slug);
        if (refusal !== null) return toolText(`Error: ${refusal}`, true);
        state.relayed.delete(key);
        return toolText(
          item.kind === "specs"
            ? `Jalon « specs validées » de ${item.slug} validé par /audit — la chaîne repart sur /impl`
            : `Jalon « revue propre » de ${item.slug} accepté par /audit — livraison et ouverture de la PR`,
        );
      },
    });

    pi.registerTool({
      name: "audit_escalate",
      label: "Audit — demander à l'utilisateur",
      description:
        "Remonte à l'utilisateur, dans cette session, un élément relayé que /audit ne tranche pas : la question d'origine et ses options, un jalon en doute, ou le plafond de la boucle revue ⇄ correction. La réponse de l'utilisateur est transmise mot pour mot au maillon.",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ item: "string" }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const { item: key } = params as { item: string };
        if (!armedOn(ctx) || ctx === undefined) return toolText(NOT_ARMED, true);
        const item = findItem(key);
        if (item === undefined) return toolText(gone(key), true);
        if (!ctx.hasUI) return toolText(NEEDS_UI, true);
        if (state.dialog) return toolText(DIALOG_OPEN, true);
        state.dialog = true;
        try {
          const contract = path.join(item.worktree, CONTRACT_PATH);
          const controller = deps.controllerFor(ctx);
          // `answer` : ce que l'utilisateur a rendu ; `act` : la livraison, exécutée
          // APRÈS la revérification de l'élément.
          let answer: string | undefined;
          let act: (() => Promise<string | null>) | undefined;
          switch (item.kind) {
            case "ask":
            case "question": {
              answer = await askUser(ctx, item, signal);
              const text = answer;
              if (text !== undefined) {
                act = async () =>
                  item.kind === "ask" ? deliverAsk(item, text) : controller.answer(item.slug, text, { from: "audit" });
              }
              break;
            }
            case "specs": {
              answer = await ctx.ui.select(
                `Jalon « specs validées » — ${item.slug} : /audit a un doute, décide\nSpécifications : ${contract}`,
                ["Valider les specs", ABANDON_FEATURE],
                { signal },
              );
              if (answer === "Valider les specs") act = () => controller.validate(item.slug);
              else if (answer === ABANDON_FEATURE) act = () => controller.cancel(item.slug, "keep");
              break;
            }
            case "review": {
              answer = await ctx.ui.select(
                `Jalon « revue propre » — ${item.slug} : /audit a un doute, décide\nRevue : ${contract}`,
                ["Accepter la revue et livrer (PR)", ABANDON_FEATURE],
                { signal },
              );
              if (answer === "Accepter la revue et livrer (PR)") act = () => controller.accept(item.slug);
              else if (answer === ABANDON_FEATURE) act = () => controller.cancel(item.slug, "keep");
              break;
            }
            case "cap": {
              const relaunch = "Relancer un cycle de correction";
              const reply = "Répondre au maillon /review (texte libre)";
              answer = await ctx.ui.select(
                `Plafond de la boucle revue ⇄ correction — ${item.slug}\n${item.stopReason ?? ""}\nAucune PR ne sera ouverte avant ta décision.`,
                [relaunch, reply, ABANDON_FEATURE],
                { signal },
              );
              if (answer === relaunch) act = () => controller.relaunch(item.slug);
              else if (answer === ABANDON_FEATURE) act = () => controller.cancel(item.slug, "keep");
              else if (answer === reply) {
                const text = await ctx.ui.input(`Réponse au maillon /review — ${item.slug}`, undefined, { signal });
                answer = text;
                if (text !== undefined && text.trim() !== "") {
                  act = () => controller.answer(item.slug, text, { from: "audit" });
                }
              }
              break;
            }
          }
          if (act === undefined || answer === undefined) {
            return toolText(
              `Error: l'utilisateur n'a pas répondu — ${key} reste en attente ; ne le tranche pas, rappelle audit_escalate quand il te le demande`,
              true,
            );
          }
          if (findItem(key) === undefined) {
            return toolText(`${gone(key)} — la réponse de l'utilisateur n'a pas été transmise`, true);
          }
          const refusal = await act();
          if (refusal !== null) return toolText(`Error: ${refusal}`, true);
          state.relayed.delete(key);
          return toolText(`Réponse de l'utilisateur transmise mot pour mot à /${item.phase} — feature ${item.slug} : ${answer}`);
        } catch (err) {
          // Un dialogue interrompu (tour abandonné) vaut « non répondu ».
          if (signal?.aborted === true) {
            return toolText(
              `Error: l'utilisateur n'a pas répondu — ${key} reste en attente ; ne le tranche pas, rappelle audit_escalate quand il te le demande`,
              true,
            );
          }
          throw err;
        } finally {
          state.dialog = false;
        }
      },
    });
  }

  return {
    markCreated(sessionFile: string) {
      state.created.add(sessionFile);
    },
    sync,
    disarm,
    scan,
    items,
  };
}
