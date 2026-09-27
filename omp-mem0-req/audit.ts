// /audit : le relais des questions et des jalons d'une pipeline vers sa session /audit.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { isReviewCapReason } from "./chain.ts";
import { CONTRACT_PATH } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { toSlug } from "./git.ts";
import {
  LOT_EDITOR_MAX,
  LOT_TICK_MS,
  lotFeature,
  lotOwnerAlive,
  lotReplaceable,
  lotRepoKey,
  parseReplyOptions,
  questionOf,
  readLot,
} from "./lot.ts";
import type { Lot, LotFeature } from "./lot.ts";
import type { LotController } from "./lotController.ts";
import { modelDialogChoice, modelDialogOptions, modelQuestionTitle } from "./models.ts";
import { sessionFileOf } from "./publish.ts";
import { repoRootOf } from "./runs.ts";
import { liveRunFor, panelInboxDirOf, removeAuditRelay, writeAuditRelay, writeDelivery } from "./store.ts";
import type { PanelAskOption, PipelineCtx, RunningEntry } from "./store.ts";



// ---------------------------------------------------------------------------
// Le relais /audit — une session interactive qui tranche pour l'utilisateur.
// ---------------------------------------------------------------------------
// La session /audit lance une ou plusieurs features dans le lot — les éléments
// que l'utilisateur coche, lancés en parallèle dans l'ordre de leurs dépendances
// (le pilote existant les conduit) — puis devient leur RELAIS : chaque question
// d'un maillon et chaque jalon lui est injecté comme un message `[audit]`, et
// elle y répond par ses outils (`audit_reply`, `audit_approve`, `audit_escalate`).
// Le relais n'écrit JAMAIS le lot : il livre une réponse `ask` dans la boîte du
// run (comme le panneau) ou appelle les actions du pilote (qui exigent la
// propriété du lot — d'où la règle « un relais ouvert est tenu par le pilote »).
//
// Le relais est OUVERT tant que la session /audit est la session courante du
// process pilote : un fichier de battement (`<stateDir>/audit/<id>.json`) le dit
// au pilote et au panneau, qui cessent alors de proposer ces questions et ces
// jalons. Quitter la session (ou la fermer) retire le fichier — tout retombe sur
// le panneau ; y revenir le réécrit et ré-injecte ce qui attend encore.
//
// Les dialogues /audit passent par une FILE (`auditState.dialogs`) : l'hôte
// exécute en même temps les appels d'outils d'un même tour, donc deux questions
// escaladées ensemble — ou une proposition et une escalade — s'ouvrent l'une
// après l'autre, dans l'ordre des appels, jamais l'une par-dessus l'autre.

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
  /**
   * La file des dialogues /audit (S-5) : la QUEUE d'une chaîne FIFO de places.
   * Chaque séquence de dialogues (proposition, escalade) s'y inscrit et n'ouvre
   * rien avant que la place précédente soit libérée.
   */
  dialogs: Promise<void>;
  /**
   * Les slugs lancés par `audit_propose`, par session /audit (S-4). Jamais
   * persisté ni vidé en cours de process : il garde « déjà lancé » un élément dont
   * la feature a quitté le lot quand celui-ci a été remplacé.
   */
  launched: Map<string, Set<string>>;
  /** La notice « lot piloté ailleurs » est dite une fois par armement. */
  foreignWarned: boolean;
  ctx: ExtensionContext | null;
};

const AUDIT_STATE_KEY = Symbol.for("omp-mem0-req.auditState");

export const auditState: AuditState = (() => {
  const host = globalThis as unknown as Record<symbol, AuditState | undefined>;
  // Un état posé par un chargement ANTÉRIEUR de l'extension dans le même process
  // peut précéder la file et `launched` : il reçoit les champs manquants.
  const existing = host[AUDIT_STATE_KEY] as
    | (Omit<AuditState, "dialogs" | "launched"> & Partial<Pick<AuditState, "dialogs" | "launched">>)
    | undefined;
  if (existing) {
    existing.dialogs ??= Promise.resolve();
    existing.launched ??= new Map();
    return existing as AuditState;
  }
  const created: AuditState = {
    tools: false,
    created: new Set(),
    sessionFile: null,
    repoRoot: null,
    relayed: new Map(),
    stopTimer: null,
    dialogs: Promise.resolve(),
    launched: new Map(),
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


/** La nature d'un élément proposé par /audit. */
export type ProposalElementKind = "weakness" | "feature";

/** Un élément lançable de la proposition : son slug, son intention, les slugs dont il dépend (S-1). */
export type ProposalElement = { kind: ProposalElementKind; slug: string; intention: string; deps: string[] };

/** Une proposition validée : les faiblesses dans l'ordre reçu, PUIS les features. */
export type Proposal = { elements: ProposalElement[] };

/**
 * Le premier cycle de dépendances, parcouru en profondeur dans l'ordre des
 * éléments puis des dépendances déclarées : la pile depuis l'élément retrouvé
 * jusqu'à l'élément courant, puis cet élément à nouveau — ou `null`.
 */
function dependencyCycle(elements: readonly ProposalElement[]): string[] | null {
  const bySlug = new Map(elements.map((element) => [element.slug, element]));
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (slug: string): string[] | null => {
    stack.push(slug);
    for (const dep of bySlug.get(slug)?.deps ?? []) {
      const onStack = stack.indexOf(dep);
      if (onStack !== -1) return [...stack.slice(onStack), dep];
      if (done.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    done.add(slug);
    return null;
  };
  for (const element of elements) {
    if (done.has(element.slug)) continue;
    const cycle = visit(element.slug);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * La validation d'une proposition `audit_propose` (S-1) : PURE, sans exception,
 * première erreur rendue, dans l'ordre du contrat.
 */
export function checkProposal(input: unknown): { ok: true; proposal: Proposal } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const elements: ProposalElement[] = [];
  // Les `deps` bruts, à l'index de leur élément : validés une fois TOUS les
  // slugs connus (une dépendance peut viser un élément déclaré plus loin).
  const declared: unknown[] = [];
  const seen = new Set<string>();
  const collect = (raws: unknown[], kind: ProposalElementKind): string | null => {
    for (const [index, raw] of raws.entries()) {
      const n = index + 1;
      const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const slug = entry !== null && typeof entry.name === "string" ? toSlug(entry.name) : null;
      if (entry === null || slug === null) return `Error: ${kind} ${n} has an invalid name`;
      if (seen.has(slug)) return `Error: duplicate element « ${slug} »`;
      seen.add(slug);
      const intention = typeof entry.intention === "string" ? entry.intention.trim() : "";
      if (intention === "") return `Error: ${kind} ${n} has no intention`;
      elements.push({ kind, slug, intention: intention.slice(0, LOT_EDITOR_MAX), deps: [] });
      declared.push(entry.deps);
    }
    return null;
  };
  const rawWeaknesses = record.weaknesses;
  if (!Array.isArray(rawWeaknesses) || rawWeaknesses.length < 1 || rawWeaknesses.length > 20) {
    return fail("Error: weaknesses must list 1 to 20 items");
  }
  const weaknessError = collect(rawWeaknesses, "weakness");
  if (weaknessError !== null) return fail(weaknessError);
  const rawFeatures = record.features;
  if (!Array.isArray(rawFeatures) || rawFeatures.length < 1 || rawFeatures.length > 8) {
    return fail("Error: features must list 1 to 8 items");
  }
  const featureError = collect(rawFeatures, "feature");
  if (featureError !== null) return fail(featureError);
  for (const [index, element] of elements.entries()) {
    const raw = declared[index];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.some((dep) => typeof dep !== "string")) {
      return fail(`Error: « ${element.slug} » has invalid deps`);
    }
    for (const entry of raw as string[]) {
      const dep = toSlug(entry);
      if (dep === null || !seen.has(dep)) return fail(`Error: « ${element.slug} » depends on unknown « ${entry.trim()} »`);
      if (dep === element.slug) return fail(`Error: « ${element.slug} » depends on itself`);
      if (!element.deps.includes(dep)) element.deps.push(dep);
    }
  }
  const cycle = dependencyCycle(elements);
  if (cycle !== null) return fail(`Error: dependency cycle « ${cycle.join(" → ")} »`);
  return { ok: true, proposal: { elements } };
}

/**
 * L'ordre des ajouts (S-4) : topologique et STABLE — répéter, prendre dans
 * l'ordre reçu le premier élément non traité dont toutes les dépendances qui
 * sont dans la liste sont déjà traitées. `checkProposal` exclut les cycles.
 */
function launchOrder<T extends { slug: string; deps: readonly string[] }>(items: readonly T[]): T[] {
  const inList = new Set(items.map((item) => item.slug));
  const placed = new Set<string>();
  const order: T[] = [];
  while (order.length < items.length) {
    const next = items.find(
      (item) => !placed.has(item.slug) && item.deps.every((dep) => !inList.has(dep) || placed.has(dep)),
    );
    if (next === undefined) break;
    placed.add(next.slug);
    order.push(next);
  }
  return order;
}


type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toolText(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

const NOT_ARMED = "Error: aucune session /audit active dans ce process";
const NEEDS_UI = "Error: /audit demande une session interactive";
const LAUNCH_ID = "audit-launch";
const LAUNCH_TITLE =
  "Quelles pipelines lancer ? Coche un ou plusieurs éléments puis valide — valider sans rien cocher ne lance rien.";
const LAUNCH_ACTION = "Lancer la sélection";
const INTERRUPTED = "Aucune pipeline lancée : dialogue interrompu.";
const notAnswered = (item: string) =>
  `Error: l'utilisateur n'a pas répondu — ${item} reste en attente ; ne le tranche pas, rappelle audit_escalate quand il te le demande`;
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

  /**
   * Une séquence de dialogues /audit, à SON tour dans la file (S-5). La place est
   * prise tout de suite et chaînée derrière la précédente : libérée tôt (signal
   * tombé pendant l'attente), elle ne laisse pourtant jamais un appel suivant
   * passer avant la fin du précédent. `aborted` répond quand le `signal` tombe
   * avant le tour — aucun dialogue ne s'ouvre alors.
   */
  async function inDialogTurn<T>(signal: AbortSignal | undefined, run: () => Promise<T>, aborted: () => T): Promise<T> {
    const previous = state.dialogs;
    let release = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.dialogs = previous.then(() => mine);
    try {
      if (signal === undefined) await previous;
      else if (!signal.aborted) {
        let stop = () => {};
        const interrupted = new Promise<void>((resolve) => {
          stop = resolve;
          signal.addEventListener("abort", stop, { once: true });
        });
        await Promise.race([previous, interrupted]);
        signal.removeEventListener("abort", stop);
      }
      if (signal?.aborted === true) return aborted();
      return await run();
    } finally {
      release();
    }
  }

  /** La question d'un élément ask/question, pour l'utilisateur : son origine, puis ses options d'origine. */
  async function askUser(ctx: ExtensionContext, item: AuditItem, signal?: AbortSignal): Promise<string | undefined> {
    const question = `Question de /${item.phase} — feature ${item.slug}\n${item.question ?? "(question sans texte)"}`;
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

  /**
   * La sélection de lancement (S-2) : les éléments cochés, dans l'ordre de
   * `launchable`, et le texte libre du dialogue riche — `null` = abandon.
   */
  async function selectElements(
    ctx: ExtensionContext,
    title: string,
    launchable: readonly ProposalElement[],
    signal: AbortSignal | undefined,
  ): Promise<{ checked: ProposalElement[]; free: string | null } | null> {
    const options = launchable.map((element) => ({
      label: element.slug,
      description:
        `${element.kind === "weakness" ? "faiblesse" : "feature"} — ${(element.intention.split("\n")[0] ?? "").slice(0, 200)}` +
        (element.deps.length > 0 ? ` · après ${element.deps.join(", ")}` : ""),
    }));
    const ui = ctx.ui;
    if (typeof ui.askDialog === "function") {
      const result = await ui.askDialog([{ id: LAUNCH_ID, question: title, options, multi: true }], { signal });
      if (!result || result.kind !== "submit") return null;
      const first = result.results[0];
      if (!first || first.timedOut === true) return null;
      const picked = new Set(first.selectedOptions);
      const free = first.customInput?.trim() ?? "";
      return { checked: launchable.filter((element) => picked.has(element.slug)), free: free === "" ? null : free };
    }
    // Le repli de l'hôte (D-3) : une liste à cases, rouverte après chaque bascule
    // avec le curseur sur l'élément basculé ; la ligne d'action n'a pas de case.
    const marked = new Set<number>();
    let cursor = 0;
    for (;;) {
      const checkedIndices = [...marked].sort((a, b) => a - b);
      const answer = await ui.select(
        title,
        [...options, { label: LAUNCH_ACTION, description: `${checkedIndices.length} élément(s) coché(s)` }],
        { signal, selectionMarker: "checkbox", checkedIndices, markableCount: launchable.length, initialIndex: cursor },
      );
      if (answer === undefined) return null;
      if (answer === LAUNCH_ACTION) {
        return { checked: launchable.filter((_, index) => marked.has(index)), free: null };
      }
      const index = launchable.findIndex((element) => element.slug === answer);
      if (index === -1) continue;
      if (marked.has(index)) marked.delete(index);
      else marked.add(index);
      cursor = index;
    }
  }

  /**
   * `audit_propose` à son tour de dialogue : sélection (S-2), intention puis
   * modèle de chaque élément coché (S-3), ajouts et compte rendu (S-4).
   */
  async function propose(
    ctx: ExtensionContext,
    sessionFile: string,
    repoRoot: string,
    elements: readonly ProposalElement[],
    signal: AbortSignal | undefined,
  ): Promise<ToolResult> {
    // Les éléments pris, lus À CE TOUR : deux propositions successives ne lancent
    // jamais deux fois le même élément. `launched` garde ceux dont la feature a
    // quitté un lot remplacé depuis.
    const taken = new Set([
      ...(lotOf(repoRoot)?.features.map((feature) => feature.slug) ?? []),
      ...(state.launched.get(sessionFile) ?? []),
    ]);
    const launchable = elements.filter((element) => !taken.has(element.slug));
    const excluded = elements
      .filter((element) => taken.has(element.slug))
      .map((element) => element.slug)
      .join(", ");
    if (launchable.length === 0) {
      return toolText(`Aucune pipeline lancée : tous les éléments proposés sont déjà lancés (${excluded}).`);
    }
    const title = excluded === "" ? LAUNCH_TITLE : `${LAUNCH_TITLE}\nDéjà lancés (non cochables) : ${excluded}`;
    // Un tour interrompu referme le dialogue ouvert, qui rend `undefined` comme un
    // Échap : seul le signal les distingue (D-4). Relu par une fonction, car le
    // compilateur garderait sinon le `false` du premier test à travers les `await`.
    const interrupted = (): boolean => signal?.aborted === true;
    const selection = await selectElements(ctx, title, launchable, signal);
    if (interrupted()) return toolText(INTERRUPTED);
    if (selection === null) return toolText("Aucune pipeline lancée : sélection abandonnée.");
    const { checked, free } = selection;
    const freeLine = free === null ? [] : [`Texte libre de l'utilisateur, non lancé : « ${free} »`];
    if (checked.length === 0) return toolText(["Aucune pipeline lancée : aucun élément coché.", ...freeLine].join("\n"));

    // S-3 — TOUS les dialogues avant le premier ajout : son run de collecte porte
    // déjà `--model`, et un abandon tardif n'a rien écrit.
    const modelOptions = modelDialogOptions(ctx.models?.list?.() ?? []);
    const retained: { slug: string; intention: string; deps: string[]; model: string | null }[] = [];
    const reasons = new Map<string, string>();
    for (const element of checked) {
      const { slug } = element;
      let intention = element.intention;
      let validated = false;
      for (;;) {
        const verdict = await ctx.ui.select(
          `Intention transmise à /req — ${slug}\n${intention}`,
          ["Valider et lancer", "Amender l'intention", "Abandonner"],
          { signal },
        );
        if (verdict === "Valider et lancer") validated = true;
        if (verdict !== "Amender l'intention") break;
        const amended = await ctx.ui.editor(`Amende l'intention transmise à /req — ${slug}`, intention, { signal });
        if (amended !== undefined && amended.trim() !== "") intention = amended.trim().slice(0, LOT_EDITOR_MAX);
      }
      if (!validated) {
        reasons.set(slug, "intention non validée");
        continue;
      }
      let model: string | null = null;
      if (modelOptions.length > 0) {
        const chosen = modelDialogChoice(await ctx.ui.select(modelQuestionTitle(slug), modelOptions, { signal }));
        if (chosen === null) {
          reasons.set(slug, "modèle non choisi");
          continue;
        }
        model = chosen.model;
      }
      retained.push({ slug, intention, deps: element.deps, model });
    }
    if (interrupted()) return toolText(INTERRUPTED);

    // S-4 — un ajout à la fois, dans l'ordre des dépendances. Chaque `add` est une
    // écriture autonome du pilote : un refus n'annule jamais un ajout précédent.
    // Les règles de dépendance du lot restent celles du pilote : on choisit
    // seulement quelles dépendances lui passer.
    const controller = deps.controllerFor(ctx);
    const retainedSlugs = new Set(retained.map((element) => element.slug));
    const started = new Map<string, string[]>();
    let refused = false;
    for (const element of launchOrder(retained)) {
      const lot = lotOf(repoRoot);
      const kept: string[] = [];
      let missing: string | null = null;
      for (const dep of element.deps) {
        if (retainedSlugs.has(dep)) {
          if (!started.has(dep)) {
            missing = dep;
            break;
          }
          kept.push(dep);
          continue;
        }
        // Hors des retenus : attendue seulement si le lot la conduit encore (un lot
        // remplaçable sera remplacé par cet ajout, une feature annulée ne finira pas).
        const feature = lot !== null && !lotReplaceable(lot) ? lotFeature(lot, dep) : undefined;
        if (feature !== undefined && feature.state !== "cancelled") kept.push(dep);
      }
      if (missing !== null) {
        reasons.set(element.slug, `dépend de ${missing}, non lancée`);
        continue;
      }
      const refusal = await controller.add({
        name: element.slug,
        description: element.intention,
        deps: kept,
        auditSession: sessionFile,
        model: element.model ?? undefined,
      });
      if (refusal !== null) {
        refused = true;
        reasons.set(element.slug, `lancement refusé : ${refusal}`);
        continue;
      }
      started.set(element.slug, kept);
      let mine = state.launched.get(sessionFile);
      if (mine === undefined) {
        mine = new Set();
        state.launched.set(sessionFile, mine);
      }
      mine.add(element.slug);
    }
    if (started.size > 0) scan();

    const total = checked.length;
    const lines = [
      started.size > 0
        ? `Pipelines lancées : ${started.size}/${total}.`
        : refused
          ? `Error: aucune pipeline lancée (0/${total}).`
          : `Aucune pipeline lancée (0/${total}).`,
    ];
    for (const { slug } of checked) {
      const kept = started.get(slug);
      lines.push(
        kept === undefined
          ? `- ${slug} : non lancée — ${reasons.get(slug)}`
          : `- ${slug} : lancée (branche feat/${slug})${kept.length > 0 ? `, démarre après ${kept.join(", ")}` : ""}`,
      );
    }
    lines.push(...freeLine);
    for (const { slug, intention } of retained) {
      if (started.has(slug)) lines.push(`Intention transmise à /req — ${slug} :`, intention);
    }
    if (started.size > 0) lines.push("Les questions des maillons et les jalons te seront relayés par des messages [audit].");
    return toolText(lines.join("\n"), started.size === 0 && refused);
  }

  function registerAuditTools(): void {
    const element = pi.arktype({ name: "string", intention: "string", "deps?": "string[]" });
    pi.registerTool({
      name: "audit_propose",
      label: "Audit — proposer",
      description:
        "Soumet l'analyse de /audit — faiblesses et features, chacune nommée, avec ses dépendances (deps) : l'outil montre à l'utilisateur une liste à cocher de tous les éléments pas encore lancés, lui fait valider ou amender l'intention puis choisir le modèle de chaque élément coché, et lance leurs pipelines en parallèle (un élément attend la fin de ceux dont il dépend). Rappelle-le avec la même analyse pour lancer d'autres éléments plus tard.",
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ weaknesses: element.array(), features: element.array() }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const checked = checkProposal(params);
        if (!checked.ok) return toolText(checked.error, true);
        if (!armedOn(ctx) || ctx === undefined) return toolText(NOT_ARMED, true);
        if (!ctx.hasUI) return toolText(NEEDS_UI, true);
        const sessionFile = state.sessionFile as string;
        const repoRoot = state.repoRoot as string;
        return inDialogTurn(
          signal,
          () => propose(ctx, sessionFile, repoRoot, checked.proposal.elements, signal),
          () => toolText(INTERRUPTED),
        );
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
        if (findItem(key) === undefined) return toolText(gone(key), true);
        if (!ctx.hasUI) return toolText(NEEDS_UI, true);
        return inDialogTurn(
          signal,
          () => escalate(ctx, key, signal),
          () => toolText(notAnswered(key), true),
        );
      },
    });
  }

  /** `audit_escalate` à son tour de dialogue (S-5) : l'élément est relu, il a pu être traité entre-temps. */
  async function escalate(ctx: ExtensionContext, key: string, signal: AbortSignal | undefined): Promise<ToolResult> {
    const item = findItem(key);
    if (item === undefined) return toolText(gone(key), true);
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
      if (act === undefined || answer === undefined) return toolText(notAnswered(key), true);
      if (findItem(key) === undefined) {
        return toolText(`${gone(key)} — la réponse de l'utilisateur n'a pas été transmise`, true);
      }
      const refusal = await act();
      if (refusal !== null) return toolText(`Error: ${refusal}`, true);
      state.relayed.delete(key);
      return toolText(`Réponse de l'utilisateur transmise mot pour mot à /${item.phase} — feature ${item.slug} : ${answer}`);
    } catch (err) {
      // Un dialogue interrompu (tour abandonné) vaut « non répondu ».
      if (signal?.aborted === true) return toolText(notAnswered(key), true);
      throw err;
    }
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
