// Une doublure de `chrome.*` pour les modules d'exécution de l'extension (executor.ts,
// cdp.ts, background.ts, offscreen.ts) : onglets, fenêtres, stockage, messages, scripts
// injectés frame par frame, débogueur (CDP) et téléchargements. Elle se pose sur
// `globalThis.chrome` AVANT l'import des modules ; chaque test repart de `reset()`.

type Listener = (...args: never[]) => unknown;
export type Tab = { id: number; windowId: number; active: boolean; url: string; title: string; status: string };

/** Le résultat d'un script injecté (`ActionOutcome` du module page/agent). */
type Outcome = { outcome: string; [key: string]: unknown };

export type DownloadItem = {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  mime: string;
  state: "in_progress" | "interrupted" | "complete";
  error?: string;
  fileSize: number;
  totalBytes: number;
  bytesReceived: number;
};

export function chromeEvent() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
    /** Appelle chaque écouteur (copie : un écouteur peut se retirer en route). */
    emit: (...args: unknown[]) => {
      for (const listener of [...listeners]) (listener as (...a: unknown[]) => unknown)(...args);
    },
  };
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fakeChrome() {
  const tabs = new Map<number, Tab>();
  const windows = new Set<number>();
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const onChanged = chromeEvent();
  const onMessage = chromeEvent();
  const onUpdated = chromeEvent();
  const onDetach = chromeEvent();
  const onDownloadCreated = chromeEvent();
  const onDownloadChanged = chromeEvent();
  /** Chaque script injecté ; `frames` seulement hors de la frame principale (`"all"` : toutes). */
  const injected: { tabId: number; request: Record<string, unknown>; frames?: number[] | "all" }[] = [];
  const updates: { tabId: number; props: Record<string, unknown> }[] = [];
  const sent: Record<string, unknown>[] = [];
  /** Les commandes CDP envoyées, dans l'ordre. */
  const cdp: { tabId: number; method: string; params: Record<string, unknown> }[] = [];
  const attached = new Set<number>();
  const attachLog: { tabId: number; op: "attach" | "detach" }[] = [];
  const downloads = new Map<number, DownloadItem>();
  const history: { tabId: number; kind: "back" | "forward" | "reload" }[] = [];
  let nextId = 100;
  let offscreen = false;
  const state = {
    /** Ce que rend la page à `executeScript`, par frame (le module page/agent n'est pas chargé ici). */
    pageResult: (request: Record<string, unknown>, _frameId: number): Outcome => ({
      outcome: "done",
      result: { text: `page : ${String(request.op)}` },
    }),
    /** Les frames de chaque onglet (absent : la principale seule). */
    frames: new Map<number, number[]>(),
    /** L'attache du débogueur : refusée par défaut (un autre débogueur, une page interne). */
    debuggerAttach: "refuse" as "ok" | "refuse",
    /** L'issue d'un téléchargement lancé : il finit tout de suite, ou s'interrompt. */
    downloadOutcome: "complete" as "complete" | "interrupted",
    /** Le type et la taille du prochain fichier téléchargé. */
    downloadFile: { mime: "text/csv", size: 42, name: "export.csv" },
    /** L'adresse où mène `goBack` / `goForward` (`null` : pas d'historique, la promesse rejette). */
    historyUrl: "https://crm.exemple.fr/precedente" as string | null,
    /** L'expéditeur des messages envoyés (le document offscreen, page de l'extension). */
    sender: { id: "ext", url: "chrome-extension://ext/offscreen/offscreen.html" } as Record<string, unknown>,
  };
  function area(data: Map<string, unknown>, name: string) {
    return {
      data,
      async get(keys?: string | string[] | null) {
        const wanted =
          keys === null || keys === undefined ? [...data.keys()] : typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(
          wanted.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]),
        );
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(items)) {
          data.set(key, structuredClone(value));
          changes[key] = { newValue: value };
        }
        onChanged.emit(changes, name);
      },
      async remove(keys: string | string[]) {
        for (const key of typeof keys === "string" ? [keys] : keys) data.delete(key);
      },
    };
  }
  /** Comme Chrome : le message part à tous les autres contextes, la première réponse revient. */
  async function sendMessage(message: unknown): Promise<unknown> {
    sent.push(message as Record<string, unknown>);
    const replies = [...onMessage.listeners].map((listener) => {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const keep = (listener as (m: unknown, s: unknown, r: (v?: unknown) => void) => unknown)(
        message,
        state.sender,
        resolve,
      );
      if (keep !== true) queueMicrotask(() => resolve(undefined));
      return promise;
    });
    for (const reply of await Promise.all(replies)) if (reply !== undefined) return reply;
    return undefined;
  }
  /** Un téléchargement commence (`onCreated`), puis finit ou s'interrompt au tour suivant (`onChanged`). */
  function startDownload(url: string): number {
    const id = nextId++;
    const { mime, size, name } = state.downloadFile;
    const item: DownloadItem = {
      id,
      url,
      finalUrl: url,
      filename: `/Users/moi/Downloads/${name}`,
      mime,
      state: "in_progress",
      fileSize: 0,
      totalBytes: size,
      bytesReceived: 0,
    };
    downloads.set(id, item);
    onDownloadCreated.emit({ ...item });
    setTimeout(() => {
      if (item.state !== "in_progress") return;
      item.state = state.downloadOutcome;
      if (item.state === "complete") Object.assign(item, { fileSize: size, bytesReceived: size });
      else item.error = "NETWORK_FAILED";
      onDownloadChanged.emit({ id, state: { previous: "in_progress", current: item.state } });
    }, 5);
    return id;
  }
  /** Une navigation de l'historique : la page charge (`loading`), puis finit (`complete`). */
  async function navigateHistory(tabId: number, kind: "back" | "forward" | "reload"): Promise<void> {
    const tab = tabs.get(tabId) as Tab;
    if (kind !== "reload" && state.historyUrl === null) throw new Error("Cannot find a next page in history.");
    history.push({ tabId, kind });
    if (kind !== "reload") tab.url = state.historyUrl as string;
    tab.status = "loading";
    onUpdated.emit(tabId, { status: "loading" }, { ...tab });
    setTimeout(() => {
      tab.status = "complete";
      onUpdated.emit(tabId, { status: "complete" }, { ...tab });
    }, 5);
  }
  const api = {
    runtime: {
      id: "ext",
      getURL: (file: string) => `chrome-extension://ext/${file}`,
      getManifest: () => ({ version: "9.9.9" }),
      sendMessage,
      openOptionsPage: async () => undefined,
      getContexts: async () => (offscreen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      onMessage,
      onInstalled: chromeEvent(),
      onStartup: chromeEvent(),
    },
    storage: { local: area(local, "local"), session: area(session, "session"), onChanged },
    tabs: {
      TAB_ID_NONE: -1,
      async get(id: number) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      },
      async query(filter: { windowId?: number; active?: boolean }) {
        return [...tabs.values()]
          .filter((tab) => filter.windowId === undefined || tab.windowId === filter.windowId)
          .filter((tab) => filter.active === undefined || tab.active === filter.active)
          .map((tab) => ({ ...tab }));
      },
      async create(props: { windowId: number; url: string }) {
        const tab = {
          id: nextId++,
          windowId: props.windowId,
          active: true,
          url: props.url,
          title: "Nouvel onglet",
          status: "complete",
        };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(tabId: number, props: Record<string, unknown>) {
        updates.push({ tabId, props });
        const tab = tabs.get(tabId) as Tab;
        Object.assign(tab, props);
        return { ...tab };
      },
      async remove(tabId: number) {
        tabs.delete(tabId);
        if (attached.delete(tabId)) onDetach.emit({ tabId }, "target_closed");
      },
      goBack: (tabId: number) => navigateHistory(tabId, "back"),
      goForward: (tabId: number) => navigateHistory(tabId, "forward"),
      reload: (tabId: number) => navigateHistory(tabId, "reload"),
      captureVisibleTab: async () => "data:image/jpeg;base64,SlBFRw==",
      onActivated: chromeEvent(),
      onUpdated,
      onRemoved: chromeEvent(),
      onCreated: chromeEvent(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async get(id: number) {
        if (!windows.has(id)) throw new Error(`No window with id: ${id}`);
        return { id, focused: false };
      },
      async create(props: { url: string }) {
        const id = nextId++;
        windows.add(id);
        const tab = { id: nextId++, windowId: id, active: true, url: props.url, title: "Ouvert", status: "complete" };
        tabs.set(tab.id, tab);
        return { id, focused: false, tabs: [{ ...tab }] };
      },
      getLastFocused: async () => ({ id: 1, focused: false }),
      onFocusChanged: chromeEvent(),
      onRemoved: chromeEvent(),
    },
    scripting: {
      async executeScript(injection: {
        target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
        args: [string, Record<string, unknown>];
      }) {
        const { tabId, frameIds, allFrames } = injection.target;
        const request = injection.args[1];
        const targets = allFrames === true ? (state.frames.get(tabId) ?? [0]) : (frameIds ?? [0]);
        const frames = allFrames === true ? "all" : frameIds;
        injected.push(frames === undefined ? { tabId, request } : { tabId, request, frames });
        return targets.map((frameId) => ({ frameId, result: state.pageResult(request, frameId) }));
      },
    },
    debugger: {
      async attach(target: { tabId: number }, version: string) {
        if (version !== "1.3") throw new Error(`version de protocole inattendue : ${version}`);
        if (state.debuggerAttach === "refuse") throw new Error("Another debugger is already attached");
        if (attached.has(target.tabId)) throw new Error("Already attached");
        attached.add(target.tabId);
        attachLog.push({ tabId: target.tabId, op: "attach" });
      },
      async detach(target: { tabId: number }) {
        if (!attached.delete(target.tabId)) throw new Error("Debugger is not attached");
        attachLog.push({ tabId: target.tabId, op: "detach" });
      },
      async sendCommand(target: { tabId: number }, method: string, params: Record<string, unknown> = {}) {
        if (!attached.has(target.tabId)) throw new Error("Debugger is not attached");
        cdp.push({ tabId: target.tabId, method, params });
        return {};
      },
      onDetach,
    },
    downloads: {
      download: async (options: { url: string }) => startDownload(options.url),
      search: async (query: { id?: number }) =>
        [...downloads.values()]
          .filter((item) => query.id === undefined || item.id === query.id)
          .map((item) => ({ ...item })),
      async cancel(id: number) {
        const item = downloads.get(id);
        if (item?.state === "in_progress") item.state = "interrupted";
      },
      onCreated: onDownloadCreated,
      onChanged: onDownloadChanged,
    },
    idle: { setDetectionInterval: () => undefined, queryState: async () => "active", onStateChanged: chromeEvent() },
    alarms: { create: async () => undefined, get: async () => undefined, onAlarm: chromeEvent() },
    offscreen: {
      createDocument: async () => {
        offscreen = true;
      },
      closeDocument: async () => undefined,
    },
    tabCapture: { getMediaStreamId: async () => "stream" },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
  };
  return {
    api,
    tabs,
    windows,
    local,
    session,
    injected,
    updates,
    sent,
    cdp,
    attached,
    attachLog,
    downloads,
    history,
    state,
    startDownload,
    /** L'utilisateur clique « Annuler » sur la bannière de débogage : Chrome détache chaque session. */
    cancelDebugging() {
      for (const tabId of [...attached]) {
        attached.delete(tabId);
        onDetach.emit({ tabId }, "canceled_by_user");
      }
    },
    /** Un monde : la fenêtre de l'agent (10, onglet 11) et celle de l'utilisateur (20, onglets 21 actif et 22). */
    reset() {
      // Les sessions CDP encore ouvertes se ferment (cdp.ts oublie aussi les siennes, et ses minuteries).
      for (const tabId of [...attached]) {
        attached.delete(tabId);
        onDetach.emit({ tabId }, "target_closed");
      }
      tabs.clear();
      windows.clear();
      session.clear();
      injected.length = 0;
      updates.length = 0;
      sent.length = 0;
      cdp.length = 0;
      attachLog.length = 0;
      downloads.clear();
      history.length = 0;
      windows.add(10).add(20);
      tabs.set(11, {
        id: 11,
        windowId: 10,
        active: true,
        url: "https://crm.exemple.fr/devis?id=4",
        title: "Devis",
        status: "complete",
      });
      tabs.set(21, {
        id: 21,
        windowId: 20,
        active: true,
        url: "https://mail.exemple.fr/inbox?t=secret",
        title: "Boîte",
        status: "complete",
      });
      tabs.set(22, {
        id: 22,
        windowId: 20,
        active: false,
        url: "https://banque.exemple.fr/",
        title: "Banque",
        status: "complete",
      });
      session.set("agentWindowId", 10);
      state.pageResult = (request) => ({ outcome: "done", result: { text: `page : ${String(request.op)}` } });
      state.frames.clear();
      state.debuggerAttach = "refuse";
      state.downloadOutcome = "complete";
      state.downloadFile = { mime: "text/csv", size: 42, name: "export.csv" };
      state.historyUrl = "https://crm.exemple.fr/precedente";
    },
  };
}
