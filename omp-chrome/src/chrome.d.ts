// Déclarations ambiantes MINIMALES des API chrome.* qu'emploie l'extension, écrites à la
// main (aucune dépendance npm, pas de @types/chrome). Seul ce qui est appelé est déclaré ;
// une API neuve s'ajoute ici, avec la signature de la documentation Chrome (promesses MV3).

declare namespace chrome {
  type Listener = (...args: never[]) => unknown;

  interface ChromeEvent<T extends Listener> {
    addListener(callback: T): void;
    removeListener(callback: T): void;
  }

  namespace runtime {
    interface MessageSender {
      id?: string;
      url?: string;
      frameId?: number;
      tab?: chrome.tabs.Tab;
    }
    interface Manifest {
      version: string;
    }
    interface ExtensionContext {
      contextType: string;
      documentUrl?: string;
    }
    const id: string;
    function getURL(path: string): string;
    function getManifest(): Manifest;
    function sendMessage(message: unknown): Promise<unknown>;
    function openOptionsPage(): Promise<void>;
    function getContexts(filter: { contextTypes?: string[]; documentUrls?: string[] }): Promise<ExtensionContext[]>;
    const onMessage: ChromeEvent<
      (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined
    >;
    const onInstalled: ChromeEvent<() => void>;
    const onStartup: ChromeEvent<() => void>;
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: ChromeEvent<(changes: Record<string, StorageChange>, areaName: string) => void>;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
      active: boolean;
      url?: string;
      title?: string;
      status?: string;
    }
    const TAB_ID_NONE: number;
    function query(query: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
      windowId?: number;
    }): Promise<Tab[]>;
    function get(tabId: number): Promise<Tab>;
    function create(properties: { windowId?: number; url?: string; active?: boolean }): Promise<Tab>;
    function update(tabId: number, properties: { url?: string; active?: boolean }): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function captureVisibleTab(
      windowId: number,
      options: { format: "jpeg" | "png"; quality?: number },
    ): Promise<string>;
    const onActivated: ChromeEvent<(info: { tabId: number; windowId: number }) => void>;
    const onUpdated: ChromeEvent<
      (tabId: number, change: { status?: string; url?: string; title?: string }, tab: Tab) => void
    >;
    const onRemoved: ChromeEvent<(tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void>;
  }

  namespace windows {
    interface Window {
      id?: number;
      focused: boolean;
      tabs?: chrome.tabs.Tab[];
    }
    const WINDOW_ID_NONE: number;
    function create(properties: {
      url?: string;
      focused?: boolean;
      type?: "normal" | "popup";
      state?: "normal" | "minimized" | "maximized";
      width?: number;
      height?: number;
    }): Promise<Window>;
    function get(windowId: number, options?: { populate?: boolean }): Promise<Window>;
    function getLastFocused(options?: { populate?: boolean }): Promise<Window>;
    const onFocusChanged: ChromeEvent<(windowId: number) => void>;
    const onRemoved: ChromeEvent<(windowId: number) => void>;
  }

  namespace scripting {
    interface InjectionResult<T> {
      frameId: number;
      result?: T;
    }
    function executeScript<Args extends unknown[], Result>(injection: {
      target: { tabId: number; frameIds?: number[] };
      func: (...args: Args) => Result;
      args?: Args;
      world?: "ISOLATED" | "MAIN";
    }): Promise<InjectionResult<Awaited<Result>>[]>;
  }

  namespace idle {
    type IdleState = "active" | "idle" | "locked";
    function setDetectionInterval(intervalInSeconds: number): void;
    function queryState(detectionIntervalInSeconds: number): Promise<IdleState>;
    const onStateChanged: ChromeEvent<(state: IdleState) => void>;
  }

  namespace alarms {
    interface Alarm {
      name: string;
      scheduledTime: number;
      periodInMinutes?: number;
    }
    function create(
      name: string,
      info: { delayInMinutes?: number; periodInMinutes?: number; when?: number },
    ): Promise<void>;
    function get(name: string): Promise<Alarm | undefined>;
    const onAlarm: ChromeEvent<(alarm: Alarm) => void>;
  }

  namespace offscreen {
    function createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>;
    function closeDocument(): Promise<void>;
  }

  namespace tabCapture {
    function getMediaStreamId(options: { targetTabId?: number; consumerTabId?: number }): Promise<string>;
  }

  namespace action {
    function setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    function setBadgeBackgroundColor(details: { color: string; tabId?: number }): Promise<void>;
  }
}
