// Le RUNTIME d'une session hébergée par le service (S-6) : les actions que
// l'extension d'une session reçoit, et le contexte UI par lequel ses dialogues
// sortent vers l'app.
//
// `createAgentSession` construit le runner mais n'appelle PAS `initializeExtensions`
// (Doc-1 §5) : sans ce câblage, `session_start` n'est jamais émis et les
// commandes d'extension de la session ne trouvent ni `sendMessage` ni
// `sendUserMessage`. Les trois objets d'actions sont recopiés de
// `P/src/modes/runtime-init.ts:45-186` — la référence de l'hôte — et rien
// d'autre : `import type` seulement, jamais un import de valeur depuis
// `@oh-my-pi/*` (règle `scripts/check.sh:211-241`).
import type {
  AgentSession,
  CompactOptions,
  ExtensionActions,
  ExtensionCommandContextActions,
  ExtensionContextActions,
  ExtensionUIContext,
  ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent";
import type { DialogAnswer, DialogRequest } from "./serviceApi.ts";


/** L'ouverture d'un dialogue : la requête sans son identifiant, posé par le canal. */
export type DialogOpen = Omit<DialogRequest, "id">;


/**
 * Le canal de dialogues d'une session : c'est LUI qui tient les identifiants, les
 * trames SSE et l'attente de la réponse. Le contexte UI ne fait que traduire un
 * appel d'extension en ouverture de dialogue (S-6).
 */
export type DialogChannel = {
  request: (input: DialogOpen) => Promise<DialogAnswer>;
  notice: (level: "info" | "warning" | "error", message: string) => void;
};


/** Le libellé et la description d'une option de sélection, séparés (Doc-4 §3). */
function splitSelectItem(item: ExtensionUISelectItem): { label: string; description: string | null } {
  if (typeof item === "string") return { label: item, description: null };
  const description = typeof item.description === "string" && item.description !== "" ? item.description : null;
  return { label: item.label, description };
}


/** La réponse d'un dialogue ramenée à la forme de chaque méthode d'UI. */
function valueOf(answer: DialogAnswer): string | undefined {
  return "value" in answer ? answer.value : undefined;
}


/**
 * Le contexte UI d'une session servie : chaque dialogue devient une trame `dialog`
 * et la promesse attend la réponse (S-6). Aucun `askDialog` : l'app réutilise sa
 * feuille de dialogue sans nouveau cas (Doc-1 §6, Doc-4 §3) — l'outil `ask`
 * retombe donc sur `select`/`input`/`editor`, exactement comme en mode RPC.
 *
 * Tout ce qui RELÈVE DU RENDU LOCAL (thème, widgets, en-têtes) est un no-op
 * journalisé : ces surfaces n'existent pas dans un process de service, et un
 * no-op silencieux ferait croire qu'elles ont servi.
 */
export function createServiceUIContext(channel: DialogChannel, log: (line: string) => void): ExtensionUIContext {
  const noop = (what: string) => {
    log(`[service] UI locale ignorée : ${what}`);
  };
  const context = {
    timeoutStartsOnPresentation: false,
    select: async (title: string, options: ExtensionUISelectItem[]) => {
      const items = options.map(splitSelectItem);
      const answer = await channel.request({
        method: "select",
        title,
        options: items.map(item => item.label),
        optionDescriptions: items.map(item => item.description),
      });
      return valueOf(answer);
    },
    confirm: async (title: string, message: string) => {
      const answer = await channel.request({
        method: "confirm",
        title,
        message,
        options: [],
        optionDescriptions: [],
      });
      return "confirmed" in answer ? answer.confirmed : false;
    },
    input: async (title: string, placeholder?: string) =>
      valueOf(
        await channel.request({
          method: "input",
          title,
          placeholder,
          options: [],
          optionDescriptions: [],
        }),
      ),
    notify: (message: string, type?: "info" | "warning" | "error") => {
      channel.notice(type ?? "info", message);
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => {
      // Un composant plein écran n'existe pas dans un service : le refus est
      // NOMMÉ, jamais un `undefined` déguisé en succès.
      throw new Error("UI personnalisée indisponible dans le service OMP");
    },
    setEditorText: () => noop("setEditorText"),
    pasteToEditor: () => noop("pasteToEditor"),
    getEditorText: () => "",
    editor: async (title: string, prefill?: string, _dialogOptions?: unknown, editorOptions?: { promptStyle?: boolean }) =>
      valueOf(
        await channel.request({
          method: "editor",
          title,
          prefill,
          promptStyle: editorOptions?.promptStyle === true ? "true" : undefined,
          options: [],
          optionDescriptions: [],
        }),
      ),
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getAllThemes: async () => [],
    getTheme: async () => undefined,
    setTheme: async () => ({ success: false, error: "thèmes indisponibles dans le service OMP" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
    // Le thème n'est lu que par un RENDU local, qui n'existe pas ici : la seule
    // assertion du module, nommée, pour un objet que rien ne consomme (Doc-1 §6).
    theme: undefined as unknown as ExtensionUIContext["theme"],
  };
  return context as unknown as ExtensionUIContext;
}


/**
 * Le `compact` d'une session : l'union `string | CompactOptions` de l'API
 * d'extension se scinde en deux arguments positionnels côté session — la même
 * scission que `runExtensionCompact` de l'hôte (Doc-1 §5).
 */
async function runCompact(session: AgentSession, instructions: string | CompactOptions | undefined): Promise<void> {
  const text = typeof instructions === "string" ? instructions : undefined;
  const options = instructions !== null && typeof instructions === "object" ? instructions : undefined;
  await session.compact(text, options);
}


/**
 * Les trois objets d'actions du runner, recopiés de la référence de l'hôte
 * (`runtime-init.ts:45-186`) : envois, entrées de session, outils, modèle,
 * et les actions de contexte/commande qui délèguent à la session.
 *
 * Comme l'hôte (`initializeExtensions`), la fabrique se termine par
 * `session_start` : SANS lui, la branche de session du plugin n'est jamais
 * atteinte — un maillon ne publierait pas son entrée (`running/<id>.json`),
 * n'armerait pas sa boîte, et le relais d'une session servie ne serait pas armé.
 */
export async function initializeHostedRunner(
  session: AgentSession,
  ui: ExtensionUIContext,
  report: (line: string) => void,
  onShutdown: () => void,
): Promise<void> {
  const runner = session.extensionRunner;
  if (!runner) {
    report("[service] session sans runner d'extension : les commandes du plugin y seront inertes");
    return;
  }
  const actions: ExtensionActions = {
    sendMessage: (message, sendOptions) => {
      void Promise.resolve(session.sendCustomMessage(message, sendOptions)).catch(err => {
        report(`[service] envoi d'extension refusé : ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    sendUserMessage: (content, sendOptions) => {
      void Promise.resolve(session.sendUserMessage(content, sendOptions)).catch(err => {
        report(`[service] envoi utilisateur refusé : ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    appendEntry: (customType, data) => {
      session.sessionManager.appendCustomEntry(customType, data);
    },
    setLabel: (targetId, label) => {
      session.sessionManager.appendLabelChange(targetId, label);
    },
    getActiveTools: () => session.getEnabledToolNames(),
    getAllTools: () => session.getAllToolInfos(),
    setActiveTools: toolNames => session.setActiveToolsByName(toolNames),
    getCommands: () => [],
    setModel: async model => {
      // Même règle que la référence de l'hôte (`runExtensionSetModel`) : sans clé
      // d'API pour ce modèle, le changement est REFUSÉ, jamais appliqué à moitié.
      const key = await session.modelRegistry.getApiKey(model);
      if (!key) return false;
      await session.setModel(model);
      return true;
    },
    getThinkingLevel: () => session.thinkingLevel,
    setThinkingLevel: level => session.setThinkingLevel(level),
    getServiceTiers: () => session.serviceTierByFamily,
    setServiceTier: (family, tier) => session.setServiceTierFamily(family, tier),
    getSessionName: () => session.sessionManager.getSessionName(),
    setSessionName: async name => {
      await session.sessionManager.setSessionName(name, "user");
    },
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => session.model,
    isIdle: () => !session.isStreaming,
    abort: () => session.abort({ reason: "arrêt demandé depuis le service OMP" }),
    hasPendingMessages: () => session.queuedMessageCount > 0,
    shutdown: () => onShutdown(),
    getContextUsage: () => session.getContextUsage(),
    getSystemPrompt: () => session.systemPrompt,
    runEphemeralTurn: args => session.runEphemeralTurn(args),
    compact: instructions => runCompact(session, instructions),
  };
  const commandActions: ExtensionCommandContextActions = {
    getContextUsage: () => session.getContextUsage(),
    waitForIdle: () => session.agent.waitForIdle(),
    newSession: async newOptions => {
      const success = await session.newSession({ parentSession: newOptions?.parentSession });
      if (success && newOptions?.setup) await newOptions.setup(session.sessionManager);
      return { cancelled: !success };
    },
    branch: async entryId => {
      const result = await session.branch(entryId);
      return { cancelled: result.cancelled };
    },
    navigateTree: async (targetId, navOptions) => {
      const result = await session.navigateTree(targetId, { summarize: navOptions?.summarize });
      return { cancelled: result.cancelled };
    },
    switchSession: async sessionPath => {
      const success = await session.switchSession(sessionPath);
      return { cancelled: !success };
    },
    reload: async () => {
      await session.reload();
    },
    compact: instructions => runCompact(session, instructions),
  };
  runner.initialize(actions, contextActions, commandActions, ui, "print");
  runner.onError(error => {
    report(`[service] erreur d'extension : ${error instanceof Error ? error.message : String(error)}`);
  });
  // L'hôte n'émet `session_start` que par son `initializeExtensions` (Doc-1 §5) :
  // recopié ici, il doit l'émettre AUSSI — une erreur d'un handler est déjà
  // routée vers `onError`, jamais propagée à la création de la session.
  try {
    await runner.emit({ type: "session_start" });
  } catch (err) {
    report(`[service] session_start en échec : ${err instanceof Error ? err.message : String(err)}`);
  }
}
