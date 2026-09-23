// Composants de l'hôte : le kit, et l'assemblage d'une transcription.
import type { SessionEntryLike } from "./panelSession.ts";
import { asStringOrNull } from "./store.ts";



// --- le composant et sa fabrique --------------------------------------------

/** Surface de la TUI réellement utilisée : structurelle, donc testable sans OMP. */
export type PanelTui = { terminal?: { rows?: number }; requestRender?: () => void };

export type PanelTheme = {
  fg(color: string, text: string): string;
  nav: { cursor: string };
};


// --- les composants de l'hôte : le kit injecté (S-1) -------------------------
//
// Le panneau et la vue ne composent aucune ligne eux-mêmes : le RENDU vient des
// composants de l'hôte — `Text` replie et colorie un rang, `DynamicBorder` ferme
// le cadre, `Container`/`Spacer` assemblent et remplissent la hauteur, et les
// composants de messages rendent une transcription (S-3). Le dépôt interdit tout
// import de VALEUR `@oh-my-pi/*` (scripts/check.sh § « Extension ») : le kit est
// donc lu sur `pi.pi`, le namespace du module d'entrée de l'hôte, et décrit par
// des types STRUCTURELS — un faux kit suffit à tester le panneau, et un kit
// incomplet vaut un refus explicite, jamais un rendu de repli.

/** Le contrat `Component` de la TUI : `render(width)` rend des rangs ≤ `width`. */
export type HostComponent = { render(width: number): readonly string[]; invalidate?(): void; dispose?(): void };

/** Une fonction de style de l'hôte (`theme.fg`, `theme.bg`) : texte → texte. */
export type HostStyle = (text: string) => string;

/** Un rang de texte : le `Text` de l'hôte replie, colorie et complète à la largeur. */
export type HostText = HostComponent & { setText(text: string): boolean; setStyleFn(style?: HostStyle): unknown };

export type HostContainer = HostComponent & { addChild(child: HostComponent): void };

/** Ce qu'un résultat d'outil porte, tel que `updateResult` le reçoit. */
export type HostToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  details?: unknown;
  isError?: boolean;
};

/** Ce que l'hôte donne à une carte d'outil : trois façons de demander un repaint. */
export type HostToolUi = {
  requestRender(): void;
  requestComponentRender(component: HostComponent): void;
  resetDisplay(): void;
};

/** Une carte d'appel d'outil, ou le groupe de lectures : le handle complet de l'hôte. */
export type HostToolHandle = HostComponent & {
  updateArgs(args: unknown, toolCallId?: string): void;
  setArgsComplete(toolCallId?: string): void;
  setExecutionStarted(toolCallId?: string): void;
  updateResult(result: HostToolResult, isPartial?: boolean, toolCallId?: string): void;
  setExpanded(expanded: boolean): void;
};

/** Un composant repliable : c'est lui que la bascule globale `ctrl+o` atteint (S-4). */
export type HostExpandable = HostComponent & { setExpanded(expanded: boolean): void };

export type HostAssistant = HostExpandable & {
  setImagesVisible(visible: boolean): void;
  setToolResultImagesVisible(visible: boolean): void;
};

export type HostBash = HostExpandable & {
  appendOutput(chunk: string): void;
  setComplete(exitCode: number | undefined, cancelled: boolean, options?: { output?: string; showImages?: boolean }): void;
};


/**
 * Le sous-ensemble de `pi.pi` que le panneau et la vue utilisent. Chaque entrée a
 * été relevée sur les signatures réelles de l'hôte installé (`## Documentation`
 * §2-3) : ce sont les mêmes classes que celles du transcript vivant d'OMP, donc le
 * rendu ne jure pas à côté des autres écrans.
 */
export type HostComponents = {
  Text: new (text?: string, paddingX?: number, paddingY?: number, background?: HostStyle) => HostText;
  DynamicBorder: new (color?: HostStyle) => HostComponent;
  Container: new () => HostContainer;
  Spacer: new (lines?: number) => HostComponent;
  /** Le thème ACTIF du process : celui de l'utilisateur, jamais un ton codé en dur. */
  theme: PanelTheme & { bg(color: string, text: string): string };
  UserMessageComponent: new (text: string, options?: { synthetic?: boolean }) => HostComponent;
  AssistantMessageComponent: new (
    message?: unknown,
    hideThinkingBlock?: boolean,
    onImageUpdate?: () => void,
    thinkingRenderers?: readonly unknown[],
    imageBudget?: unknown,
    proseOnlyThinking?: boolean,
    linkTargets?: ReadonlyMap<string, string>,
  ) => HostAssistant;
  ToolExecutionComponent: new (
    toolName: string,
    args: unknown,
    options: { showImages?: boolean; useBuiltInRenderer?: boolean } | undefined,
    tool: unknown,
    ui: HostToolUi,
    cwd?: string,
    toolCallId?: string,
  ) => HostToolHandle;
  ReadToolGroupComponent: new (options?: { showContentPreview?: boolean }) => HostToolHandle;
  CustomMessageComponent: new (message: unknown, renderer?: unknown) => HostExpandable;
  BashExecutionComponent: new (command: string, ui: HostToolUi, excludeFromContext?: boolean) => HostBash;
  CompactionSummaryMessageComponent: new (message: unknown) => HostExpandable;
  BranchSummaryMessageComponent: new (message: unknown) => HostExpandable;
};


/**
 * Les noms REQUIS du kit : sans eux, ni le panneau ni la vue ne savent rendre, et
 * il n'existe AUCUN rendu de repli (S-1 cas 3) — un kit incomplet vaut un refus
 * explicite, jamais un écran à moitié peint ni une exception en plein rendu.
 */
export const HOST_COMPONENT_NAMES = [
  "Text",
  "DynamicBorder",
  "Container",
  "Spacer",
  "theme",
  "UserMessageComponent",
  "AssistantMessageComponent",
  "ToolExecutionComponent",
  "ReadToolGroupComponent",
  "CustomMessageComponent",
  "BashExecutionComponent",
  "CompactionSummaryMessageComponent",
  "BranchSummaryMessageComponent",
] as const;


/**
 * Lit le kit sur `pi.pi` (le namespace du module d'entrée de l'hôte, seul chemin
 * qui respecte l'interdiction d'import de valeur) : `null` dès qu'un nom requis
 * manque. La forme est vérifiée nom par nom — `theme` doit être un objet qui sait
 * peindre (`fg`), les autres des constructeurs — pour qu'un hôte d'une autre
 * version soit REFUSÉ au montage plutôt que de jeter au premier rendu.
 */
export function hostComponents(pi: unknown): HostComponents | null {
  const host = (pi as { pi?: unknown } | null | undefined)?.pi;
  if (!host || typeof host !== "object") return null;
  const kit = host as Record<string, unknown>;
  for (const name of HOST_COMPONENT_NAMES) {
    const value = kit[name];
    if (name === "theme") {
      // `fg` est REQUIS : il peint chaque rang du panneau, donc un thème qui
      // l'omet est un kit incomplet (S-1 cas 1.3), pas un thème à replier. Ses
      // glyphes, eux, ont leurs replis (`cursorGlyph`) : un thème sans
      // `nav.cursor` ne fait jamais jeter le montage.
      if (!value || typeof value !== "object" || !("fg" in value) || typeof value.fg !== "function") return null;
      continue;
    }
    if (typeof value !== "function") return null;
  }
  return host as unknown as HostComponents;
}


/**
 * Le curseur de sélection du panneau (S-1) : le glyphe du thème ACTIF, ou le
 * curseur ASCII `>` — un thème sans `nav.cursor` (ou d'une autre version) REPLIE,
 * il ne fait jamais jeter le montage. Le cadre, lui, vient de `DynamicBorder`,
 * qui porte son propre repli : `boxRound` n'est plus lu ici.
 */
export function cursorGlyph(theme: unknown): string {
  const nav = theme && typeof theme === "object" && "nav" in theme ? theme.nav : undefined;
  const cursor = nav && typeof nav === "object" && "cursor" in nav ? nav.cursor : undefined;
  return typeof cursor === "string" && cursor !== "" ? cursor : ">";
}


// --- l'assembleur entrée → composants de l'hôte (S-3) ------------------------
//
// Une entrée de fichier devient un ou plusieurs composants de l'HÔTE : c'est la
// table de correspondance de S-3, celle du transcript vivant d'OMP (`## Documentation`
// §6) — `UserMessageComponent` pour un message utilisateur, `AssistantMessageComponent`
// pour l'assistant, `ToolExecutionComponent` pour un appel d'outil (le composant
// résout LUI-MÊME son renderer intégré, diff compris), `CustomMessageComponent`
// pour un message d'affichage. Aucun rendu maison ne subsiste : le repli, la
// coloration, le markdown et les diffs viennent de ces composants.
//
// L'assemblage est INCRÉMENTAL (S-8) : une entrée déjà construite n'est jamais
// reconstruite, un `toolResult` ne crée aucun composant (il met à jour la carte de
// son appel), et une reconstruction (fichier réécrit) repart de zéro.

/** Le texte d'un contenu de message : une chaîne, ou les blocs `text` d'un tableau. */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join(" ");
}


/** Le contenu d'un résultat d'outil, sous la forme que `updateResult` attend. */
export function toolContentOf(content: unknown): HostToolResult["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const out: HostToolResult["content"] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (typeof rec.type !== "string") continue;
    out.push({
      type: rec.type,
      ...(typeof rec.text === "string" ? { text: rec.text } : {}),
      ...(typeof rec.data === "string" ? { data: rec.data } : {}),
      ...(typeof rec.mimeType === "string" ? { mimeType: rec.mimeType } : {}),
    });
  }
  return out;
}


/**
 * La règle de l'hôte (`assistantHasVisibleContent`), réécrite localement : un
 * segment d'assistant qui ne porte ni texte, ni raisonnement, ni image ne mérite
 * pas de carte — un tour qui n'a produit que des appels d'outils se lit par ses
 * appels.
 */
export function assistantHasVisibleContent(message: Record<string, unknown>): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type === "image") return true;
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim() !== "") return true;
    if (rec.type === "thinking" && typeof rec.thinking === "string" && rec.thinking.trim() !== "") return true;
  }
  return false;
}


/**
 * `splitAssistantMessageToolTimeline` de l'hôte, réécrite localement (elle vit
 * dans un module inaccessible : `## Documentation` §2) : tout ce qui précède le
 * PREMIER appel d'outil va dans `beforeTools` ; ce qui suit un appel jusqu'au
 * suivant est attaché à cet appel, rendu comme un message « display » (`stopReason`
 * forcé à `stop`, erreur et reprise retirées) — c'est ce qui fait qu'un texte écrit
 * APRÈS un outil s'affiche sous sa carte, pas au-dessus.
 */
export function splitAssistantToolTimeline(message: Record<string, unknown>): {
  beforeTools: Record<string, unknown>;
  afterToolCalls: Map<string, Record<string, unknown>>;
  hasToolCalls: boolean;
  lastToolCallId?: string;
} {
  const content = Array.isArray(message.content) ? message.content : [];
  const before: unknown[] = [];
  const afterToolCalls = new Map<string, Record<string, unknown>>();
  let pending: unknown[] = [];
  let lastToolCallId: string | undefined;
  let sawToolCall = false;
  const displaySegment = (blocks: unknown[]): Record<string, unknown> => ({
    ...message,
    content: blocks,
    stopReason: "stop",
    errorMessage: undefined,
    retryRecovery: undefined,
  });
  const flush = () => {
    if (lastToolCallId === undefined || pending.length === 0) return;
    afterToolCalls.set(lastToolCallId, displaySegment(pending));
    pending = [];
  };
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "toolCall") {
      flush();
      sawToolCall = true;
      lastToolCallId = asStringOrNull((block as Record<string, unknown>).id) ?? undefined;
      continue;
    }
    if (sawToolCall) pending.push(block);
    else before.push(block);
  }
  flush();
  if (!sawToolCall) return { beforeTools: message, afterToolCalls, hasToolCalls: false };
  return { beforeTools: displaySegment(before), afterToolCalls, hasToolCalls: true, lastToolCallId };
}


/**
 * L'état d'un assemblage : l'ordre d'affichage, ce que chaque entrée a produit, ce
 * que la bascule globale atteint, et les cartes d'outils encore en vol. Il se
 * PROLONGE d'une lecture à l'autre (S-8) : c'est lui qui évite de reconstruire ce
 * qui est déjà à l'écran.
 */
export type SessionAssembly = {
  components: HostComponent[];
  /** Les composants qu'une entrée a produits, par clé d'entrée (son `id`, ou son octet). */
  byEntryId: Map<string, HostComponent[]>;
  /** Les composants repliables : c'est cette liste que `ctrl+o` bascule (S-4). */
  expandables: HostExpandable[];
  /** Les cartes d'appel d'outil en attente de résultat, par `toolCallId`. */
  toolCards: Map<string, HostToolHandle>;
  /** Le groupe de lectures OUVERT : un `read` consécutif le rejoint (S-3, §6). */
  readGroup: HostToolHandle | null;
  /** L'état global de dépliage : une carte construite après la bascule naît dépliée. */
  expanded: boolean;
};


/** Le handle d'un composant repliable, suivi à part : `ctrl+o` l'atteindra (S-4). */
export function trackExpandable(assembly: SessionAssembly, component: HostExpandable): void {
  component.setExpanded(assembly.expanded);
  assembly.expandables.push(component);
}


/** Le groupe de lectures courant, ouvert au premier `read` d'une course (S-3, §6). */
export function ensureReadGroup(assembly: SessionAssembly, kit: HostComponents): HostToolHandle {
  if (assembly.readGroup) return assembly.readGroup;
  const group = new kit.ReadToolGroupComponent({ showContentPreview: false });
  trackExpandable(assembly, group);
  assembly.components.push(group);
  assembly.readGroup = group;
  return group;
}


/** Une entrée → ses composants, ajoutés à l'assemblage dans l'ordre du fichier. */
export function appendEntry(
  assembly: SessionAssembly,
  entry: SessionEntryLike,
  kit: HostComponents,
  ui: HostToolUi,
  cwd: string,
): void {
  if (entry.type === "other") return; // entrée technique : aucun composant (S-3)
  if (entry.type === "custom_message") {
    assembly.readGroup = null;
    if (!entry.display) return;
    const component = new kit.CustomMessageComponent(
      {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: true,
        details: entry.details,
        attribution: entry.attribution,
        timestamp: entry.timestamp,
      },
      undefined,
    );
    trackExpandable(assembly, component);
    assembly.components.push(component);
    return;
  }
  const message = entry.message;
  const role = asStringOrNull(message.role);
  if (role !== "assistant" && role !== "toolResult") {
    // Un message qui n'est ni un assistant ni un résultat d'outil referme la
    // course de lectures : le repli de l'hôte s'arrête là (S-3, §6).
    assembly.readGroup = null;
  }
  if (role === "user" || role === "developer") {
    const text = textOfContent(message.content).trim();
    if (text === "") return;
    const synthetic = role === "developer" || message.synthetic === true;
    assembly.components.push(synthetic ? new kit.UserMessageComponent(text, { synthetic: true }) : new kit.UserMessageComponent(text));
    return;
  }
  if (role === "assistant") {
    const timeline = splitAssistantToolTimeline(message);
    const before = timeline.beforeTools;
    if (assistantHasVisibleContent(before)) {
      const card = new kit.AssistantMessageComponent(before, false, () => ui.requestRender(), [], undefined, true, undefined);
      card.setImagesVisible(false);
      card.setToolResultImagesVisible(true);
      trackExpandable(assembly, card);
      assembly.components.push(card);
      // Un texte visible referme la course de lectures : les lectures qui suivent
      // commencent un nouveau groupe (S-3, §6).
      assembly.readGroup = null;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const call = block as Record<string, unknown>;
      if (call.type !== "toolCall") continue;
      const id = asStringOrNull(call.id) ?? "";
      const name = asStringOrNull(call.name) ?? "?";
      const after = id === "" ? undefined : timeline.afterToolCalls.get(id);
      if (name === "read" && id !== "") {
        const group = ensureReadGroup(assembly, kit);
        group.updateArgs(call.arguments, id);
        group.setArgsComplete(id);
        group.setExecutionStarted(id);
        assembly.toolCards.set(id, group);
      } else {
        assembly.readGroup = null;
        const card = new kit.ToolExecutionComponent(
          name,
          call.arguments,
          { showImages: false, useBuiltInRenderer: true },
          undefined,
          ui,
          cwd,
          id === "" ? undefined : id,
        );
        card.setArgsComplete(id);
        card.setExecutionStarted(id);
        trackExpandable(assembly, card);
        assembly.components.push(card);
        if (id !== "") assembly.toolCards.set(id, card);
      }
      if (after && assistantHasVisibleContent(after)) {
        const segment = new kit.AssistantMessageComponent(after, false, () => ui.requestRender(), [], undefined, true, undefined);
        segment.setImagesVisible(false);
        segment.setToolResultImagesVisible(true);
        trackExpandable(assembly, segment);
        assembly.components.push(segment);
        assembly.readGroup = null;
      }
    }
    return;
  }
  if (role === "toolResult") {
    const id = asStringOrNull(message.toolCallId) ?? "";
    const card = assembly.toolCards.get(id);
    // Un résultat sans carte connue est ignoré, comme chez l'hôte : les résultats
    // se rendent DANS la carte de leur appel, jamais à part (S-3).
    if (!card) return;
    card.updateResult(
      { content: toolContentOf(message.content), details: message.details, isError: message.isError === true },
      false,
      id,
    );
    assembly.toolCards.delete(id);
    return;
  }
  if (role === "bashExecution") {
    const component = new kit.BashExecutionComponent(
      asStringOrNull(message.command) ?? "",
      ui,
      message.excludeFromContext === true,
    );
    if (typeof message.output === "string" && message.output !== "") component.appendOutput(message.output);
    component.setComplete(typeof message.exitCode === "number" ? message.exitCode : undefined, message.cancelled === true, {
      showImages: false,
    });
    trackExpandable(assembly, component);
    assembly.components.push(component);
    return;
  }
  if (role === "pythonExecution") {
    // `EvalExecutionComponent` n'est pas atteignable (`## Documentation` §2) : la
    // carte d'outil `eval` rend le même bloc, avec le code et sa sortie.
    const card = new kit.ToolExecutionComponent(
      "eval",
      { code: message.code },
      { showImages: false, useBuiltInRenderer: true },
      undefined,
      ui,
      cwd,
    );
    card.setArgsComplete();
    card.setExecutionStarted();
    card.updateResult(
      {
        content: toolContentOf(typeof message.output === "string" ? message.output : ""),
        isError: message.exitCode !== 0 && message.exitCode !== undefined,
      },
      false,
    );
    trackExpandable(assembly, card);
    assembly.components.push(card);
    return;
  }
  if (role === "compactionSummary" || role === "branchSummary") {
    const component =
      role === "compactionSummary"
        ? new kit.CompactionSummaryMessageComponent(message)
        : new kit.BranchSummaryMessageComponent(message);
    trackExpandable(assembly, component);
    assembly.components.push(component);
    return;
  }
  if (role === "custom" || role === "hookMessage") {
    if (message.display !== true) return;
    const component = new kit.CustomMessageComponent(message, undefined);
    trackExpandable(assembly, component);
    assembly.components.push(component);
    return;
  }
  // `fileMention` (et tout rôle inconnu) ne rend rien : `buildFileMentionBlock`
  // n'est pas atteignable (`## Documentation` §2) — écart documenté de S-3.
}


/**
 * Les composants des entrées d'une fenêtre, dans l'ordre du fichier (S-3). Avec un
 * assemblage PRÉCÉDENT, seules les entrées dont la clé n'y figure pas encore sont
 * construites (S-8.2) ; un composant dont le constructeur jette devient un rang
 * d'erreur lisible, sans interrompre l'assemblage du reste.
 */
export function buildSessionComponents(
  entries: SessionEntryLike[],
  deps: {
    components: HostComponents;
    ui: HostToolUi;
    cwd: string;
    /** L'état global de dépliage ; sans lui, celui de l'assemblage précédent (S-4). */
    expanded?: boolean;
    previous?: SessionAssembly | null;
  },
): SessionAssembly {
  const previous = deps.previous ?? null;
  const assembly: SessionAssembly = previous
    ? { ...previous, expandables: [...previous.expandables] }
    : {
        components: [],
        byEntryId: new Map(),
        expandables: [],
        toolCards: new Map(),
        readGroup: null,
        expanded: deps.expanded ?? false,
      };
  assembly.expanded = deps.expanded ?? previous?.expanded ?? false;
  for (const entry of entries) {
    // La clé porte l'id ET l'octet de l'entrée : l'id SEUL n'est pas unique dans un
    // fichier de session (deux entrées peuvent le partager), et une entrée sautée
    // serait une transcription menteuse. L'octet, lui, ne bouge jamais dans un
    // fichier qu'on ne fait que compléter (S-8) — c'est lui qui rend l'assemblage
    // incrémental.
    const key = entry.id !== "" ? `${entry.id}@${entry.at}` : `#${entry.at}`;
    if (assembly.byEntryId.has(key)) continue;
    const before = assembly.components.length;
    try {
      appendEntry(assembly, entry, deps.components, deps.ui, deps.cwd);
    } catch {
      // Une entrée illisible ne casse pas la transcription : elle se voit (BR-3).
      const id = entry.id !== "" ? entry.id : key;
      assembly.components.push(new deps.components.Text(`entrée illisible — ${id}`, 1, 0));
    }
    assembly.byEntryId.set(key, assembly.components.slice(before));
  }
  return assembly;
}


/** La bascule GLOBALE de dépliage (S-4) : toutes les cartes repliables, d'un coup. */
export function applyExpanded(assembly: SessionAssembly, expanded: boolean): void {
  assembly.expanded = expanded;
  for (const component of assembly.expandables) component.setExpanded(expanded);
}


/**
 * La surface de TUI que les cartes d'outil reçoivent (`ToolExecutionUi`) : elles ne
 * repeignent que par elle, et un overlay n'a qu'un repaint à offrir — les trois
 * méthodes demandent le même rendu, jamais un état de TUI qu'on n'a pas.
 */
export function toolUi(tui: PanelTui): HostToolUi {
  const repaint = () => tui.requestRender?.();
  return { requestRender: repaint, requestComponentRender: repaint, resetDisplay: repaint };
}
