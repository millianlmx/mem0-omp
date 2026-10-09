// /audit : le relais des questions et des jalons d'une pipeline vers sa session /audit.
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import { checkBrief, editBrief, renderBrief, writeBrief } from "./context.ts";
import type { BriefInput } from "./context.ts";
import { toSlug } from "./git.ts";
import { LOT_EDITOR_MAX, lotFeature, lotRepoKey, lotReplaceable, readLot } from "./lot.ts";
import type { Lot, LotFeature } from "./lot.ts";
import { askFeatureModels } from "./models.ts";
import { createRelay, escalationRelayMessage, quotaRelayMessage, relayItemsOf, relayToolText as toolText } from "./relay.ts";
import type { RelayCore, RelayDeps, RelayItem, RelayState, RelayToolResult } from "./relay.ts";
import type { RunningEntry } from "./store.ts";



// ---------------------------------------------------------------------------
// Le relais /audit — une session interactive qui tranche pour l'utilisateur.
// ---------------------------------------------------------------------------
// La session /audit lance une ou plusieurs features dans le lot — les éléments
// que l'utilisateur coche, lancés en parallèle dans l'ordre de leurs dépendances
// (le pilote existant les conduit) — puis devient leur RELAIS : l'arbitre du
// pilote tranche leurs questions et leurs jalons, et la session ne reçoit, comme
// un message `[audit]`, que ce qu'il escalade, puis y répond par son seul outil
// `audit_escalate`. Le cœur du relais (armement, balayage, battement, file des
// dialogues, outil d'escalade) est GÉNÉRIQUE (`relay.ts`) : ce module n'en est que
// le PROFIL /audit, plus la proposition (`audit_propose`).
//
// Le relais est OUVERT tant que la session /audit est la session courante du
// process pilote : un fichier de battement (`<stateDir>/audit/<id>.json`) le dit
// au pilote et au panneau, qui cessent alors de proposer ces questions et ces
// jalons. Quitter la session (ou la fermer) retire le fichier — tout retombe sur
// le panneau ; y revenir le réécrit et ré-injecte ce qui attend encore.

export type AuditItemKind = "ask" | "question" | "specs" | "review" | "cap" | "quota";

/** Un élément relayé à la session /audit : une question ou un jalon d'une feature /audit (S-6). */
export type AuditItem = RelayItem & { kind: AuditItemKind };


/** L'état /audit du process : partagé par les instances de l'extension (même patron que `runState`). */
export type AuditState = RelayState & {
  /**
   * Les slugs lancés par `audit_propose`, par session /audit (S-4). Jamais
   * persisté ni vidé en cours de process : il garde « déjà lancé » un élément dont
   * la feature a quitté le lot quand celui-ci a été remplacé.
   */
  launched: Map<string, Set<string>>;
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


export type AuditRelayDeps = RelayDeps;


/**
 * Les éléments courants des features /audit d'une session, dans l'ordre du lot,
 * au plus un par feature (S-6). Pure hors `liveOf`, qui lit le run vivant.
 */
export function auditItemsOf(
  lot: Lot,
  sessionFile: string,
  liveOf: (feature: LotFeature) => RunningEntry | null,
): AuditItem[] {
  return relayItemsOf(lot, sessionFile, liveOf, { cap: true }) as AuditItem[];
}


/** Le message injecté dans la session /audit pour un élément, mot pour mot (S-6). */
export function buildRelayMessage(item: AuditItem): string {
  switch (item.kind) {
    case "ask":
    case "question":
    case "specs":
    case "review":
      // Un élément n'arrive à la session que ESCALADÉ par l'arbitre (S-10).
      return escalationRelayMessage("audit", item);
    case "quota":
      return quotaRelayMessage("audit", item);
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
export type Proposal = { elements: ProposalElement[]; brief: BriefInput };

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
  const briefChecked = checkBrief(record.brief);
  if (!briefChecked.ok) return fail(briefChecked.error);
  return { ok: true, proposal: { elements, brief: briefChecked.brief } };
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


const LAUNCH_ID = "audit-launch";
const LAUNCH_TITLE =
  "Quelles pipelines lancer ? Coche un ou plusieurs éléments puis valide — valider sans rien cocher ne lance rien.";
const LAUNCH_ACTION = "Lancer la sélection";
const INTERRUPTED = "Aucune pipeline lancée : dialogue interrompu.";


/** La fabrique du relais /audit (S-6) : le profil /audit sur le relais générique, plus `audit_propose`. */
export function createAuditRelay(deps: AuditRelayDeps): AuditRelay {
  const { pi } = deps;
  const state = auditState;
  /** Le cœur du relais, prêté à l'inscription des outils (avant tout appel d'outil). */
  let core: RelayCore | null = null;

  const lotOf = (repoRoot: string): Lot | null => readLot(deps.stateDir(), lotRepoKey(repoRoot));

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
    brief: BriefInput,
    signal: AbortSignal | undefined,
  ): Promise<RelayToolResult> {
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
    // déjà ses `--model`, et un abandon tardif n'a rien écrit. L'ordre (S-6) :
    // intentions, puis brief, puis modèles.
    const catalogue = ctx.models?.list?.() ?? [];
    const validatedElements: { slug: string; intention: string; deps: string[] }[] = [];
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
      validatedElements.push({ slug, intention, deps: element.deps });
    }
    if (interrupted()) return toolText(INTERRUPTED);
    // Le brief (S-6) : un nouvel `audit_propose` validé dans la même session est
    // l'amendement — le brief est réécrit de la même façon. Échap : rien n'est écrit.
    let briefText: string | null = null;
    if (validatedElements.length > 0) {
      briefText = await editBrief(
        ctx,
        `Brief de l'audit — ${path.basename(repoRoot)} : valide ou corrige (rubriques : But, Fonction, Décisions, Contraintes, Non-objectifs)`,
        renderBrief({ title: `/audit ${path.basename(repoRoot)}`, ...brief }),
        signal,
      );
      if (interrupted()) return toolText(INTERRUPTED);
      if (briefText === null) return toolText("Aucune pipeline lancée : brief non validé — rien n'est écrit.");
    }
    const retained: {
      slug: string;
      intention: string;
      deps: string[];
      modelReqSpecs: string | null;
      modelImplReview: string | null;
      fallbackReqSpecs: string | null;
      fallbackImplReview: string | null;
    }[] = [];
    for (const { slug, intention, deps: elementDeps } of validatedElements) {
      let modelReqSpecs: string | null = null;
      let modelImplReview: string | null = null;
      let fallbackReqSpecs: string | null = null;
      let fallbackImplReview: string | null = null;
      if (catalogue.length > 0) {
        const chosen = await askFeatureModels((title, options, opts) => ctx.ui.select(title, options, opts), catalogue, slug, signal);
        if (chosen === null) {
          reasons.set(slug, "modèle non choisi");
          continue;
        }
        modelReqSpecs = chosen.models.reqSpecs;
        modelImplReview = chosen.models.implReview;
        fallbackReqSpecs = chosen.fallbacks.reqSpecs;
        fallbackImplReview = chosen.fallbacks.implReview;
      }
      retained.push({ slug, intention, deps: elementDeps, modelReqSpecs, modelImplReview, fallbackReqSpecs, fallbackImplReview });
    }
    if (interrupted()) return toolText(INTERRUPTED);
    if (briefText !== null && retained.length > 0) writeBrief(deps.stateDir(), sessionFile, briefText);

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
        modelReqSpecs: element.modelReqSpecs ?? undefined,
        modelImplReview: element.modelImplReview ?? undefined,
        fallbackReqSpecs: element.fallbackReqSpecs ?? undefined,
        fallbackImplReview: element.fallbackImplReview ?? undefined,
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
    if (started.size > 0) core?.scan();

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

  return createRelay(
    {
      name: "audit",
      state,
      // Armé dans une session ouverte par `/audit`, ou qui a lancé une feature
      // /audit encore vivante.
      armed: (sessionFile, repoRoot) =>
        state.created.has(sessionFile) ||
        (lotOf(repoRoot)?.features.some(
          (f) => f.auditSession === sessionFile && f.state !== "done" && f.state !== "cancelled",
        ) ??
          false),
      keyOf: () => state.sessionFile,
      cap: true,
      message: (item) => buildRelayMessage(item as AuditItem),
      tools: {
        escalate: {
          label: "Audit — demander à l'utilisateur",
          description:
            "Remonte à l'utilisateur, dans cette session, un élément que l'arbitre de /audit n'a pas pu trancher et que le message [audit] t'a relayé (identifiant = « élément » du message) : la question d'origine et ses options, ou un jalon en doute, ou le plafond de la boucle revue ⇄ correction. Appelle-le sans répondre toi-même : la réponse de l'utilisateur est transmise mot pour mot au maillon.",
        },
      },
      registerTools(relayCore) {
        core = relayCore;
        const { armedOn, inDialogTurn, notArmed, needsUi } = relayCore;
        const element = pi.arktype({ name: "string", intention: "string", "deps?": "string[]" });
        pi.registerTool({
          name: "audit_propose",
          label: "Audit — proposer",
          description:
            "Soumet l'analyse de /audit — faiblesses et features, chacune nommée, avec ses dépendances (deps) : l'outil montre à l'utilisateur une liste à cocher de tous les éléments pas encore lancés, lui fait valider ou amender l'intention puis choisir le modèle de chaque élément coché, et lance leurs pipelines en parallèle (un élément attend la fin de ceux dont il dépend). Rappelle-le avec la même analyse pour lancer d'autres éléments plus tard.",
          approval: "read",
          loadMode: "essential",
          parameters: pi.arktype({
            weaknesses: element.array(),
            features: element.array(),
            brief: pi.arktype({
              purpose: "string",
              function: "string",
              decisions: "string[]",
              constraints: "string[]",
              nonGoals: "string[]",
            }),
          }),
          async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
            const checked = checkProposal(params);
            if (!checked.ok) return toolText(checked.error, true);
            if (!armedOn(ctx) || ctx === undefined) return toolText(notArmed, true);
            if (!ctx.hasUI) return toolText(needsUi, true);
            const sessionFile = state.sessionFile as string;
            const repoRoot = state.repoRoot as string;
            return inDialogTurn(
              signal,
              () => propose(ctx, sessionFile, repoRoot, checked.proposal.elements, checked.proposal.brief, signal),
              () => toolText(INTERRUPTED),
            );
          },
        });
      },
    },
    deps,
  ) as AuditRelay;
}
