// L'exécuteur des actions du harness, dans le service worker. Chaque action est d'abord
// validée (`validateAction`) ; les gestes dans la page passent par page/agent.ts, qui
// tranche la garde d'envoi dans la même exécution que le geste.
//
// La fenêtre de l'agent est créée NON focalisée au premier `open` ; son id vit dans
// `chrome.storage.session` (le service worker peut s'endormir entre deux actions).

import type { ActionOutcome, ActionParams, WorkstationAction } from "./lib/actions.ts";
import { validateAction } from "./lib/actions.ts";
import { hostOf, isExcludedHost, stripUrl } from "./lib/url.ts";
import type { ApprovedGesture } from "./lib/outbound.ts";
import type { PageRequest } from "./page/agent.ts";

const AGENT_WINDOW = "agentWindowId";
const LOAD_TIMEOUT_MS = 15_000;

/** La fenêtre de l'agent si elle existe encore, sinon `null`. */
export async function agentWindowId(): Promise<number | null> {
  const stored = (await chrome.storage.session.get(AGENT_WINDOW))[AGENT_WINDOW];
  if (typeof stored !== "number") return null;
  try {
    await chrome.windows.get(stored);
    return stored;
  } catch {
    await chrome.storage.session.remove(AGENT_WINDOW);
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Attend la fin du chargement d'un onglet (15 s au plus : une page lente n'est pas une erreur). */
async function settled(tabId: number): Promise<chrome.tabs.Tab> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    function done(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id: number, change: { status?: string }): void {
      if (id === tabId && change.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") done();
      })
      .catch(done);
  });
  return chrome.tabs.get(tabId);
}

/** L'onglet visé, refusé s'il n'est pas une page web ou s'il est sur un site exclu. */
async function webTab(tabId: number, excluded: readonly string[]): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`onglet ${tabId} introuvable`);
  }
  const host = hostOf(tab.url ?? "");
  if (host === null) throw new Error(`onglet ${tabId} : pas une page web (${(tab.url ?? "").slice(0, 80)})`);
  if (isExcludedHost(host, excluded))
    throw new Error(`onglet ${tabId} : ${host} est un site exclu, l'agent n'y agit pas`);
  return tab;
}

/** Exécute la requête dans le monde isolé de l'onglet, par le module page/agent.js. */
async function inPage(tabId: number, request: PageRequest): Promise<ActionOutcome> {
  const [first] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (url: string, req: PageRequest): Promise<ActionOutcome> =>
      import(url).then((module: { run(r: PageRequest): ActionOutcome }) => module.run(req)),
    args: [chrome.runtime.getURL("page/agent.js"), request],
  });
  return first?.result ?? { outcome: "failed", error: "la page n'a rendu aucun résultat" };
}

async function open(url: string): Promise<ActionOutcome> {
  const windowId = await agentWindowId();
  let tabId: number | undefined;
  if (windowId === null) {
    const created = await chrome.windows.create({ url, focused: false, type: "normal", width: 1280, height: 900 });
    if (created.id !== undefined) await chrome.storage.session.set({ [AGENT_WINDOW]: created.id });
    tabId = created.tabs?.[0]?.id;
  } else {
    tabId = (await chrome.tabs.create({ windowId, url, active: true })).id;
  }
  if (tabId === undefined) throw new Error("l'onglet de l'agent n'a pas pu être ouvert");
  const tab = await settled(tabId);
  return {
    outcome: "done",
    result: { text: `onglet ${tabId} ouvert : ${tab.title ?? ""} · ${tab.url ?? url}`, data: { tabId } },
  };
}

async function listTabs(excluded: readonly string[]): Promise<ActionOutcome> {
  const agent = await agentWindowId();
  const lines: string[] = [];
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined) continue;
    const raw = tab.url ?? "";
    const host = hostOf(raw);
    if (host !== null && isExcludedHost(host, excluded)) continue;
    // Les onglets de l'utilisateur : origine + chemin seulement, comme l'observation.
    const url = tab.windowId === agent ? raw : stripUrl(raw);
    if (url === null) continue;
    lines.push(`${tab.id} · ${(tab.title ?? "").replace(/\s+/g, " ")} · ${url}`);
  }
  return { outcome: "done", result: { text: lines.join("\n") } };
}

async function screenshot(tabId: number, excluded: readonly string[]): Promise<ActionOutcome> {
  const tab = await webTab(tabId, excluded);
  if (!tab.active) {
    // Activer un onglet de la fenêtre de l'utilisateur changerait ce qu'il regarde.
    if (tab.windowId !== (await agentWindowId())) {
      throw new Error(
        `onglet ${tabId} : capture impossible, il n'est pas affiché (seuls les onglets de la fenêtre de l'agent sont activés pour la capture)`,
      );
    }
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  return {
    outcome: "done",
    result: { text: `capture de l'onglet ${tabId} (${tab.title ?? ""})` },
    image: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}

async function run(params: ActionParams, gate: ApprovedGesture, excluded: readonly string[]): Promise<ActionOutcome> {
  switch (params.kind) {
    case "decision":
      return { outcome: "failed", error: "une décision est un journal : elle n'est jamais exécutée" };
    case "tabs":
      return listTabs(excluded);
    case "open":
      if (isExcludedHost(hostOf(params.url) ?? "", excluded)) {
        return { outcome: "failed", error: `${hostOf(params.url)} est un site exclu, l'agent n'y va pas` };
      }
      return open(params.url);
    case "navigate": {
      await webTab(params.tabId, excluded);
      if (isExcludedHost(hostOf(params.url) ?? "", excluded)) {
        return { outcome: "failed", error: `${hostOf(params.url)} est un site exclu, l'agent n'y va pas` };
      }
      await chrome.tabs.update(params.tabId, { url: params.url });
      const tab = await settled(params.tabId);
      return {
        outcome: "done",
        result: { text: `onglet ${params.tabId} : ${tab.title ?? ""} · ${tab.url ?? params.url}` },
      };
    }
    case "snapshot": {
      const tab = await webTab(params.tabId, excluded);
      // Les onglets de l'utilisateur : adresse sans query ni fragment, comme `tabs`.
      return inPage(params.tabId, { op: "snapshot", fullUrl: tab.windowId === (await agentWindowId()) });
    }
    case "click":
      await webTab(params.tabId, excluded);
      return inPage(params.tabId, { op: "click", ref: params.ref, ...gate });
    case "type":
      await webTab(params.tabId, excluded);
      return inPage(params.tabId, { op: "type", ref: params.ref, text: params.text, submit: params.submit, ...gate });
    case "key":
      await webTab(params.tabId, excluded);
      return inPage(params.tabId, { op: "key", ref: params.ref, key: params.key, ...gate });
    case "scroll":
      await webTab(params.tabId, excluded);
      return inPage(params.tabId, { op: "scroll", dy: params.dy });
    case "screenshot":
      return screenshot(params.tabId, excluded);
    case "wait":
      await sleep(params.ms);
      return { outcome: "done", result: { text: `attendu ${Math.round(params.ms)} ms` } };
    case "close": {
      const tab = await chrome.tabs.get(params.tabId).catch(() => null);
      if (tab === null) throw new Error(`onglet ${params.tabId} introuvable`);
      // Fermer un onglet de l'utilisateur est irréversible pour lui : seule la fenêtre de l'agent.
      if (tab.windowId !== (await agentWindowId())) {
        throw new Error(`onglet ${params.tabId} : l'agent ne ferme que les onglets de sa fenêtre`);
      }
      await chrome.tabs.remove(params.tabId);
      return { outcome: "done", result: { text: `onglet ${params.tabId} fermé` } };
    }
  }
}

/** Le résultat d'une action (jamais d'exception : une erreur rend `failed`). */
export async function execute(action: WorkstationAction, excluded: readonly string[]): Promise<ActionOutcome> {
  const checked = validateAction(action.kind, action.params);
  if (!checked.ok) return { outcome: "failed", error: checked.error };
  // `fingerprint` seulement : l'empreinte de l'envoi que l'humain a vu, recomparée dans la page.
  const gate: ApprovedGesture = {
    approved: action.approved === true,
    approval: action.approval ? { fingerprint: action.approval.fingerprint } : null,
  };
  try {
    return await run(checked.params, gate, excluded);
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
