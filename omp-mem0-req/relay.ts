// Le relais générique : les questions, jalons et échecs d'une pipeline relayés à
// la session interactive qui l'a lancée (/audit, /project).
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { isReviewCapReason } from "./chain.ts";
import { CONTRACT_PATH } from "./contract.ts";
import type { PipelinePhase } from "./contract.ts";
import { LOT_TICK_MS, lotOwnerAlive, lotRepoKey, parseReplyOptions, questionOf, quotaGroupsOf, readLot } from "./lot.ts";
import type { FeatureEscalation, Lot, LotFeature, QuotaGroup } from "./lot.ts";
import type { LotController } from "./lotController.ts";
import { modelSelector } from "./models.ts";
import { sessionFileOf } from "./publish.ts";
import { exhaustedUntil, quotaDeadlineLabel } from "./quota.ts";
import { appendJournal } from "./context.ts";
import { repoRootOf } from "./runs.ts";
import { liveRunFor, panelInboxDirOf, removeAuditRelay, writeAuditRelay, writeDelivery } from "./store.ts";
import type { PanelAskOption, PipelineCtx, RunningEntry } from "./store.ts";



// ---------------------------------------------------------------------------
// Le relais — une session interactive qui tranche pour l'utilisateur.
// ---------------------------------------------------------------------------
// Une session (/audit, /project) lance des features dans le lot — le pilote
// existant les conduit, et son ARBITRE (S-9) tranche chaque question et chaque
// jalon depuis le brief, le journal et le contrat — puis devient le RELAIS de ce
// que l'arbitre n'a pas pu trancher : seuls les éléments escaladés, les plafonds
// de revue, les échecs et les groupes de quota lui sont injectés, comme un
// message `[<nom>]`, et elle y répond par son seul outil `<nom>_escalate`, qui
// ouvre le dialogue de l'utilisateur (S-10). Le relais n'écrit JAMAIS le lot : il
// livre une réponse `ask` dans la boîte du run (comme le panneau) ou appelle les
// actions du pilote (qui exigent la propriété du lot — d'où la règle « un relais
// ouvert est tenu par le pilote »).
//
// Le relais est OUVERT tant que sa session est la session courante du process
// pilote : un fichier de battement (`<stateDir>/audit/<id>.json`, par CLÉ DE
// RELAIS) le dit au pilote et au panneau, qui cessent alors de proposer ces
// questions et ces jalons. Quitter la session (ou la fermer) retire le fichier —
// tout retombe sur le panneau ; y revenir le réécrit et ré-injecte ce qui attend.
//
// Tout ce qui distingue /audit de /project vit dans son PROFIL (`RelayProfile`) ;
// ce module porte le cœur commun : armement, balayage, battement, injection, file
// des dialogues et l'outil d'escalade.
//
// Les dialogues passent par une FILE (`state.dialogs`) : l'hôte exécute en même
// temps les appels d'outils d'un même tour, donc deux questions escaladées
// ensemble — ou une proposition et une escalade — s'ouvrent l'une après l'autre,
// dans l'ordre des appels, jamais l'une par-dessus l'autre.

export type RelayItemKind = "ask" | "question" | "specs" | "review" | "cap" | "failure" | "quota";

/** Un élément relayé : une question, un jalon ou un échec d'une feature relayée (S-6). */
export type RelayItem = {
  /** `${kind}:${slug}:${discriminant}` — discriminant = toolCallId (ask), `failure.at` (échec), String(feature.sinceAt) sinon. */
  key: string;
  kind: RelayItemKind;
  slug: string;
  phase: PipelinePhase;
  worktree: string;
  question: string | null;
  options: PanelAskOption[];
  toolCallId: string | null;
  inbox: string | null;
  stopReason: string | null;
  /** Le groupe de features bloquées par un même fournisseur : présent ssi `kind === "quota"` (S-5). */
  quota?: QuotaGroup;
  /** L'escalade de l'arbitre : présente ssi l'élément a été renvoyé à l'utilisateur (S-10). */
  escalation?: FeatureEscalation;
};


/** Le texte d'un groupe de quota relayé (S-5), mot pour mot : une seule escalade par fournisseur. */
export function quotaRelayMessage(name: string, item: RelayItem): string {
  const group = item.quota as QuotaGroup;
  return (
    `[${name}] quota ${group.provider} épuisé ${quotaDeadlineLabel(group.until, group.announced)} — ` +
    `features bloquées : ${group.slugs.join(", ")}. ` +
    `Décision réservée à l'utilisateur : appelle ${name}_escalate avec l'élément ${item.key}.`
  );
}

/**
 * Le texte d'un élément ESCALADÉ (S-10), mot pour mot : la question, ses options
 * numérotées, le motif de l'arbitre, puis la décision réservée à l'utilisateur.
 */
export function escalationRelayMessage(name: string, item: RelayItem): string {
  const escalation = item.escalation as FeatureEscalation;
  const lines = [`[${name}] escalade — ${item.slug} /${item.phase} : ${escalation.question}`];
  if (escalation.options.length > 0) {
    lines.push("Options :");
    escalation.options.forEach((option, index) => lines.push(`- (${index + 1}) ${option}`));
  }
  lines.push(
    `motif de l'arbitre : ${escalation.reason}`,
    `Décision réservée à l'utilisateur : appelle ${name}_escalate avec l'élément ${item.key}.`,
  );
  return lines.join("\n");
}


/** L'état d'un relais dans le process : partagé par les instances de l'extension (même patron que `runState`). */
export type RelayState = {
  /** Les outils du relais : inscrits une seule fois par process. */
  tools: boolean;
  /** Les sessions ouvertes par la commande du relais dans ce process. */
  created: Set<string>;
  /** La session ARMÉE, ou `null`. */
  sessionFile: string | null;
  repoRoot: string | null;
  /** Les éléments déjà injectés dans la session armée, par clé. */
  relayed: Map<string, RelayItem>;
  stopTimer: (() => void) | null;
  /**
   * La file des dialogues (S-5) : la QUEUE d'une chaîne FIFO de places. Chaque
   * séquence de dialogues (proposition, plan, escalade) s'y inscrit et n'ouvre
   * rien avant que la place précédente soit libérée.
   */
  dialogs: Promise<void>;
  /** La notice « lot piloté ailleurs » est dite une fois par armement. */
  foreignWarned: boolean;
  ctx: ExtensionContext | null;
};


export type Relay = {
  markCreated(sessionFile: string): void;
  sync(ctx: ExtensionContext): void;
  disarm(): void;
  scan(): void;
  items(): RelayItem[];
};


export type RelayDeps = {
  pi: ExtensionAPI;
  stateDir: () => string;
  controllerFor: (ctx: ExtensionContext) => LotController;
  notify: (text: string) => void;
  now?: () => number;
};


export type RelayToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Le résultat d'un outil du relais : un texte, en erreur ou non. */
export function relayToolText(text: string, isError = false): RelayToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}


/** Ce que le cœur prête aux outils propres d'un profil (`audit_propose`, `project_plan`…). */
export type RelayCore = {
  scan(): void;
  items(): RelayItem[];
  /** La session de `ctx` est-elle la session armée ? */
  armedOn(ctx: ExtensionContext | undefined): boolean;
  /** Une séquence de dialogues à SON tour dans la file. */
  inDialogTurn<T>(signal: AbortSignal | undefined, run: () => Promise<T>, aborted: () => T): Promise<T>;
  /** `Error: aucune session /<nom> active dans ce process`. */
  notArmed: string;
  /** `Error: /<nom> demande une session interactive`. */
  needsUi: string;
};


/**
 * L'escalade d'un élément PROPRE au profil (l'échec d'une feature de projet) :
 * la réponse de l'utilisateur (`undefined` = pas de réponse), l'action exécutée
 * APRÈS la revérification de l'élément, et le texte rendu en cas de succès.
 */
export type RelayEscalation = { answer: string | undefined; act?: () => Promise<string | null>; done?: string };


type ToolDoc = { label: string; description: string };

/** Tout ce qui distingue un relais d'un autre (BR-2). */
export type RelayProfile = {
  /** `audit` | `project` : le tag `[<nom>]`, le `customType` des messages, le préfixe des outils, la source d'une réponse. */
  name: "audit" | "project";
  state: RelayState;
  /** Le prédicat d'armement d'une session, évalué par `sync`. */
  armed(sessionFile: string, repoRoot: string): boolean;
  /** Réévalué après chaque crochet de balayage : devenu faux, le relais se désarme. Absent : jamais réévalué. */
  stillArmed?(): boolean;
  /** La CLÉ DE RELAIS de la session armée (réévaluée à chaque balayage), `null` si elle n'en a pas encore. */
  keyOf(): string | null;
  /** Le plafond de la boucle revue ⇄ correction est-il un élément de ce relais ? */
  cap: boolean;
  /** Les éléments supplémentaires, APRÈS ceux du lot (les échecs du projet). */
  extraItems?(lot: Lot | null): RelayItem[];
  /** Le message injecté pour un élément, mot pour mot. */
  message(item: RelayItem): string;
  tools: { escalate: ToolDoc };
  /** L'escalade des éléments supplémentaires. */
  escalate?(ctx: ExtensionContext, item: RelayItem, signal: AbortSignal | undefined): Promise<RelayEscalation>;
  /** Les outils propres au profil, inscrits AVANT les trois outils de réponse. */
  registerTools?(core: RelayCore): void;
  /** Le crochet de balayage (la passe du pilote du projet). */
  onScan?(): void;
  /** À chaque armement, après la remise à zéro de l'état. */
  onArm?(): void;
};


/**
 * Les éléments courants des features relayées à `key`, dans l'ordre du lot, au
 * plus un par feature (S-6). Pure hors `liveOf`, qui lit le run vivant. Le
 * plafond de revue n'est un élément que si `cap`.
 */
export function relayItemsOf(
  lot: Lot,
  key: string,
  liveOf: (feature: LotFeature) => RunningEntry | null,
  options: { cap: boolean },
): RelayItem[] {
  const items: RelayItem[] = [];
  for (const feature of lot.features) {
    if (feature.auditSession !== key) continue;
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
    if (
      options.cap &&
      feature.state === "blocked" &&
      feature.phase === "review" &&
      isReviewCapReason(feature.stopReason)
    ) {
      items.push({ ...base, key: `cap:${feature.slug}:${since}`, kind: "cap", stopReason: feature.stopReason });
    }
  }
  // Une seule escalade par fournisseur (S-5) : les features bloquées par un quota
  // se regroupent, quel que soit leur nombre. La clé n'a pas de discriminant — le
  // groupe n'est pas réinjecté tant qu'il subsiste.
  for (const group of quotaGroupsOf(lot, (feature) => feature.auditSession === key)) {
    const first = lot.features.find((feature) => feature.slug === group.slugs[0]) as LotFeature;
    items.push({
      slug: first.slug,
      phase: first.quota?.phase ?? first.phase,
      worktree: first.worktree,
      question: null,
      options: [],
      toolCallId: null,
      inbox: null,
      stopReason: first.stopReason,
      key: `quota:${group.provider}`,
      kind: "quota",
      quota: group,
    });
  }
  return items;
}


const FREE_TEXT = "Autre réponse (texte libre)";
const LEAVE_BLOCKED = "Laisser bloquées pour l'instant";
const ABANDON_FEATURE = "Abandonner la feature (worktree et branche conservés)";
const gone = (item: string) => `Error: ${item} n'est plus en attente (déjà traité, ou retombé au panneau /pipelines)`;


/** La fabrique d'un relais (S-6) : le cœur commun, paramétré par son profil. */
export function createRelay(profile: RelayProfile, deps: RelayDeps): Relay {
  const { pi } = deps;
  const { state, name } = profile;
  const tag = `/${name}`;
  const now = () => (deps.now ?? Date.now)();
  const notArmed = `Error: aucune session ${tag} active dans ce process`;
  const needsUi = `Error: ${tag} demande une session interactive`;
  const notAnswered = (item: string) =>
    `Error: l'utilisateur n'a pas répondu — ${item} reste en attente ; ne le tranche pas, rappelle ${name}_escalate quand il te le demande`;

  const lotOf = (repoRoot: string): Lot | null => readLot(deps.stateDir(), lotRepoKey(repoRoot));

  /** Retire le battement de la clé courante — jamais une exception. */
  function removeHeartbeat(): void {
    const key = profile.keyOf();
    if (key !== null) removeAuditRelay(deps.stateDir(), key);
  }

  function disarm(): void {
    try {
      if (state.sessionFile !== null) removeHeartbeat();
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

  /**
   * Les éléments du LOT relayés à `key`, runs vivants lus dans le magasin. Une
   * question ou un jalon n'est relayé que ESCALADÉ (S-10) : sans escalade, l'arbitre
   * le tranche et la session parente ne reçoit rien.
   */
  function lotItems(lot: Lot, key: string): RelayItem[] {
    const stateDir = deps.stateDir();
    return relayItemsOf(lot, key, (f) => (f.worktree === "" ? null : liveRunFor(stateDir, f.worktree)), {
      cap: profile.cap,
    }).flatMap((item): RelayItem[] => {
      if (item.kind === "cap" || item.kind === "failure" || item.kind === "quota") return [item];
      const escalation = lot.features.find((feature) => feature.slug === item.slug)?.escalation;
      return escalation !== undefined && escalation.key === item.key ? [{ ...item, escalation }] : [];
    });
  }

  function items(): RelayItem[] {
    const { sessionFile, repoRoot } = state;
    if (sessionFile === null || repoRoot === null) return [];
    const key = profile.keyOf();
    const lot = lotOf(repoRoot);
    return [...(lot !== null && key !== null ? lotItems(lot, key) : []), ...(profile.extraItems?.(lot) ?? [])];
  }

  /**
   * Un balayage armé (BR-2), dans cet ordre : (1) le lot — tenu par une autre
   * session VIVANTE, le relais se tait (battement retiré, notice unique, aucun
   * crochet ni injection) ; propriétaire mort, il est SILENCIEUX lui aussi : seul
   * le service reprend un lot (S-4), une session terminale n'appelle plus
   * `adopt()`/`start()` ; (2) le crochet du profil (il tourne AUSSI sans lot) ;
   * (3) le prédicat d'armement réévalué ; (4) le battement puis l'injection des
   * éléments nouveaux. Sans lot à ce process, seul un profil à éléments
   * supplémentaires injecte encore (ses échecs ne dépendent pas du lot).
   */
  function scan(): void {
    try {
      const { sessionFile, repoRoot, ctx } = state;
      if (sessionFile === null || repoRoot === null || ctx === null) return;
      const stateDir = deps.stateDir();
      const lot = lotOf(repoRoot);
      if (lot !== null && lot.owner.pid !== process.pid) {
        removeHeartbeat();
        state.relayed.clear();
        if (lotOwnerAlive(lot.owner, now())) {
          if (!state.foreignWarned) {
            state.foreignWarned = true;
            deps.notify(
              `[${name}] le lot de ${path.basename(repoRoot)} est piloté par une autre session vivante (pid ${lot.owner.pid}) : les questions et jalons de cette session ${tag} restent dans son panneau /pipelines`,
            );
          }
        }
        // Propriétaire mort : plus aucun pilote (le service est arrêté) — rien à
        // relayer, rien à reprendre (S-4, S-11).
        return;
      }
      profile.onScan?.();
      if (profile.stillArmed !== undefined && !profile.stillArmed()) {
        disarm();
        return;
      }
      const key = profile.keyOf();
      if (key === null) return;
      const owned = lot !== null && lot.owner.pid === process.pid ? lot : null;
      if (owned === null) {
        removeAuditRelay(stateDir, key);
        if (profile.extraItems === undefined) return;
      } else {
        // Le battement AVANT l'injection : le pilote et le panneau cessent de
        // proposer un élément au moment où la session le reçoit.
        writeAuditRelay(stateDir, { version: 1, sessionFile: key, pid: process.pid, heartbeatAt: now() });
      }
      const current = [...(owned !== null ? lotItems(owned, key) : []), ...(profile.extraItems?.(owned ?? lot) ?? [])];
      const keys = new Set(current.map((item) => item.key));
      for (const known of [...state.relayed.keys()]) {
        if (!keys.has(known)) state.relayed.delete(known);
      }
      for (const item of current) {
        if (state.relayed.has(item.key)) continue;
        state.relayed.set(item.key, item);
        pi.sendMessage(
          {
            customType: name,
            content: item.escalation !== undefined ? escalationRelayMessage(name, item) : profile.message(item),
            display: true,
            attribution: "agent",
          },
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
    if (!profile.armed(sessionFile, repoRoot)) {
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
    profile.onArm?.();
    if (!state.tools) {
      state.tools = true;
      registerTools();
    }
    if (typeof ctx.setInterval === "function" && typeof ctx.clearTimer === "function") {
      const timer = ctx.setInterval(scan, LOT_TICK_MS);
      state.stopTimer = () => ctx.clearTimer(timer);
    }
    scan();
  }

  const armedOn = (ctx: ExtensionContext | undefined): boolean =>
    ctx !== undefined && state.sessionFile !== null && sessionFileOf(ctx as PipelineCtx) === state.sessionFile;

  const findItem = (key: string): RelayItem | undefined => items().find((item) => item.key === key);

  /** Livre une réponse `ask` dans la boîte du run : libellé exact ⇒ `selected`, sinon `custom`. */
  function deliverAsk(item: RelayItem, answer: string): string | null {
    const sentAt = now();
    const toolCallId = item.toolCallId ?? "";
    try {
      writeDelivery(
        item.inbox ?? "",
        item.options.some((o) => o.label === answer)
          ? { version: 1, kind: "ask", toolCallId, selected: answer, sentAt }
          : { version: 1, kind: "ask", toolCallId, custom: answer, sentAt },
      );
      // Le journal (S-7) : la réponse de l'utilisateur à la question du run, une fois livrée.
      if (state.repoRoot !== null) {
        appendJournal(deps.stateDir(), lotRepoKey(state.repoRoot), {
          at: sentAt,
          slug: item.slug,
          phase: item.phase,
          kind: "question",
          question: item.question ?? "(question sans texte)",
          answer,
          source: "utilisateur",
          context: profile.keyOf(),
        });
      }
      return null;
    } catch (err) {
      return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Une séquence de dialogues, à SON tour dans la file (S-5). La place est prise
   * tout de suite et chaînée derrière la précédente : libérée tôt (signal tombé
   * pendant l'attente), elle ne laisse pourtant jamais un appel suivant passer
   * avant la fin du précédent. `aborted` répond quand le `signal` tombe avant le
   * tour — aucun dialogue ne s'ouvre alors.
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
  async function askUser(ctx: ExtensionContext, item: RelayItem, signal?: AbortSignal): Promise<string | undefined> {
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

  const core: RelayCore = { scan, items, armedOn, inDialogTurn, notArmed, needsUi };

  function registerTools(): void {
    profile.registerTools?.(core);

    pi.registerTool({
      name: `${name}_escalate`,
      label: profile.tools.escalate.label,
      description: profile.tools.escalate.description,
      approval: "read",
      loadMode: "essential",
      parameters: pi.arktype({ item: "string" }),
      async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
        const { item: key } = params as { item: string };
        if (!armedOn(ctx) || ctx === undefined) return relayToolText(notArmed, true);
        if (findItem(key) === undefined) return relayToolText(gone(key), true);
        if (!ctx.hasUI) return relayToolText(needsUi, true);
        return inDialogTurn(
          signal,
          () => escalate(ctx, key, signal),
          () => relayToolText(notAnswered(key), true),
        );
      },
    });
  }

  /**
   * L'escalade d'un groupe de quota (S-5) : le catalogue sans « défaut OMP » ni
   * modèle épuisé, puis « Laisser bloquées pour l'instant ». Le choix devient le
   * repli des features de la session (`resolveQuota`, portée = sa clé de relais).
   */
  async function escalateQuota(
    ctx: ExtensionContext,
    item: RelayItem,
    signal: AbortSignal | undefined,
  ): Promise<RelayToolResult> {
    const group = item.quota as QuotaGroup;
    const at = now();
    const selectors = (ctx.models?.list?.() ?? [])
      .map(modelSelector)
      .filter((selector) => exhaustedUntil(deps.stateDir(), selector, at) === null)
      .sort();
    const answer = await ctx.ui.select(
      `Quota ${group.provider} épuisé — relancer ${group.slugs.length} feature(s) avec quel repli ?`,
      [...selectors, LEAVE_BLOCKED],
      { signal },
    );
    if (answer === undefined) return relayToolText(notAnswered(item.key), true);
    if (answer === LEAVE_BLOCKED) {
      return relayToolText(
        `Décision de l'utilisateur : les features bloquées par ${group.provider} restent bloquées pour l'instant (${group.slugs.join(", ")}).`,
      );
    }
    const current = findItem(item.key);
    if (current === undefined) {
      return relayToolText(`${gone(item.key)} — la réponse de l'utilisateur n'a pas été transmise`, true);
    }
    const key = profile.keyOf();
    const refusal = await deps.controllerFor(ctx).resolveQuota(group.provider, answer, { kind: "context", key: key ?? "" });
    if (refusal !== null) return relayToolText(`Error: ${refusal}`, true);
    state.relayed.delete(item.key);
    return relayToolText(
      `Quota ${group.provider} : ${group.slugs.length} feature(s) relancée(s) avec le repli ${answer} (${group.slugs.join(", ")}) — décision de l'utilisateur.`,
    );
  }

  /** `<nom>_escalate` à son tour de dialogue (S-5) : l'élément est relu, il a pu être traité entre-temps. */
  async function escalate(ctx: ExtensionContext, key: string, signal: AbortSignal | undefined): Promise<RelayToolResult> {
    const item = findItem(key);
    if (item === undefined) return relayToolText(gone(key), true);
    if (item.kind === "quota") return escalateQuota(ctx, item, signal);
    try {
      const contract = path.join(item.worktree, CONTRACT_PATH);
      const controller = deps.controllerFor(ctx);
      // `answer` : ce que l'utilisateur a rendu ; `act` : la livraison, exécutée
      // APRÈS la revérification de l'élément ; `done` : le texte d'un succès
      // propre au profil (sinon la réponse transmise mot pour mot).
      let answer: string | undefined;
      let act: (() => Promise<string | null>) | undefined;
      let done: string | undefined;
      switch (item.kind) {
        case "ask":
        case "question": {
          answer = await askUser(ctx, item, signal);
          const text = answer;
          if (text !== undefined) {
            act = async () =>
              item.kind === "ask" ? deliverAsk(item, text) : controller.answer(item.slug, text, { viaRelay: true });
          }
          break;
        }
        case "specs": {
          answer = await ctx.ui.select(
            `Jalon « specs validées » — ${item.slug} : ${tag} a un doute, décide\nSpécifications : ${contract}`,
            ["Valider les specs", ABANDON_FEATURE],
            { signal },
          );
          if (answer === "Valider les specs") act = () => controller.validate(item.slug);
          else if (answer === ABANDON_FEATURE) act = () => controller.cancel(item.slug, "keep");
          break;
        }
        case "review": {
          answer = await ctx.ui.select(
            `Jalon « revue propre » — ${item.slug} : ${tag} a un doute, décide\nRevue : ${contract}`,
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
              act = () => controller.answer(item.slug, text, { viaRelay: true });
            }
          }
          break;
        }
        case "failure": {
          const escalation = await profile.escalate?.(ctx, item, signal);
          answer = escalation?.answer;
          act = escalation?.act;
          done = escalation?.done;
          break;
        }
      }
      if (act === undefined || answer === undefined) return relayToolText(notAnswered(key), true);
      if (findItem(key) === undefined) {
        return relayToolText(`${gone(key)} — la réponse de l'utilisateur n'a pas été transmise`, true);
      }
      const refusal = await act();
      if (refusal !== null) return relayToolText(`Error: ${refusal}`, true);
      state.relayed.delete(key);
      return relayToolText(
        done ?? `Réponse de l'utilisateur transmise mot pour mot à /${item.phase} — feature ${item.slug} : ${answer}`,
      );
    } catch (err) {
      // Un dialogue interrompu (tour abandonné) vaut « non répondu ».
      if (signal?.aborted === true) return relayToolText(notAnswered(key), true);
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
