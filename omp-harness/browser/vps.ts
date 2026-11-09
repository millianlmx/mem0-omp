// L'exécuteur du poste sur le VPS : un navigateur du poste (`browserId: "vps"`) qui loue la file
// d'actions comme une extension (`Workstation.next`) et les exécute par CDP dans `obscura-poste`,
// le seul Obscura qui garde un profil (cookies persistants). Les gardes sont celles de
// l'extension, tenues ailleurs et par la MÊME source : hôtes permis, onglets de l'agent et
// pause/arrêt par `Workstation` ; garde d'envoi, empreinte, snapshot et gestes par le côté page
// d'omp-chrome (`agent-bundle.ts`), évalué dans la page d'Obscura.
//
// Une connexion CDP = un contexte (jar de cookies) : l'exécuteur garde UNE connexion ouverte,
// dont les onglets sont les onglets de l'agent. Un geste qu'Obscura ne sait pas faire rend
// `failed` avec une raison qui le dit : jamais un succès simulé.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkstationAction } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { LogLine } from "../logger.ts";
import type { BrowserHello, Workstation } from "../workstation.ts";
import { hostOf } from "../workstation-guards.ts";
import { mergeFrames } from "../../omp-chrome/src/lib/snapshot.ts";
import type { FrameSnapshot } from "../../omp-chrome/src/lib/snapshot.ts";
import { validateAction } from "../../omp-chrome/src/lib/actions.ts";
import type { ActionOutcome, ActionParams } from "../../omp-chrome/src/lib/actions.ts";
import { agentScript } from "./agent-bundle.ts";
import { CdpConnection, CdpConnectError, abortError } from "./cdp.ts";
import { checkUrl } from "./guard.ts";
import type { Lookup } from "./guard.ts";
import { VpsLogin } from "./vps-login.ts";
import {
  ACCOUNT_DOMAINS,
  VPS_BROWSER,
  VPS_LABEL,
  accountOfHost,
  isLoginUrl,
  parseMirrorCookies,
  parseMirrorRemovals,
} from "./vps-policy.ts";
import type { AccountDomain, AccountState } from "./vps-policy.ts";

export const VPS_HELLO: BrowserHello = { id: VPS_BROWSER, label: VPS_LABEL, version: null };

export type VpsConfig = { url: string | null; token: string | null };

export type VpsOptions = {
  config: () => VpsConfig;
  log: LogLine;
  callTimeoutMs?: number;
  /** L'attente d'un long-poll (s) : courte, pour qu'une connexion tombée se voie vite. */
  pollSec?: number;
  retryMs?: number;
  /** Les pages qui disent si un compte est ouvert (tests : adresses locales). */
  probeUrls?: Partial<Record<AccountDomain, string>>;
  probeEveryMs?: number;
  /** Tests seulement : la résolution DNS du pré-contrôle d'adresse. */
  lookup?: Lookup;
};

const MAX_TABS = 8;
const WAIT_FOR_POLL_MS = 250;
const GESTURE_PAUSE_MS = 300;
const DEFAULT_PROBES: Record<AccountDomain, string> = {
  "slack.com": "https://app.slack.com/client",
  "google.com": "https://mail.google.com/mail/",
};

type Tab = { id: number; targetId: string; sessionId: string };
type Evaluated = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

/** Une promesse qui s'arrête dès que `signal` s'abat (l'appel CDP en vol est abandonné, jamais attendu). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  // Les sources sont typées en lib ES2023 : pas de Promise.withResolvers (comme proc.ts).
  let reject: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_, ko) => {
    reject = ko;
  });
  const onAbort = (): void => reject(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

const failed = (error: string): ActionOutcome => ({ outcome: "failed", error });

export class VpsBrowser {
  readonly #workstation: Workstation;
  readonly #options: VpsOptions;
  readonly #login: VpsLogin;
  #connection: CdpConnection | null = null;
  #home: string | null = null;
  #connecting: Promise<CdpConnection> | null = null;
  readonly #tabs = new Map<number, Tab>();
  #nextTab = 1;
  #current: { seq: number; controller: AbortController } | null = null;
  #poll: AbortController | null = null;
  /** Le jeu de cookies de la connexion en cours : un mirroir d'une autre génération doit tout renvoyer. */
  #generation: string | null = null;
  #loop: Promise<void> | null = null;
  #stopping = new AbortController();
  #probedAt = Date.now();

  constructor(workstation: Workstation, options: VpsOptions) {
    this.#workstation = workstation;
    this.#options = options;
    workstation.onHalt((seqs) => {
      if (this.#current !== null && (seqs === null || seqs.includes(this.#current.seq)))
        this.#current.controller.abort();
    });
    this.#login = new VpsLogin({
      connection: () => this.#connect(),
      allowedHosts: () => workstation.settings().allowedHosts,
      guard: (url) =>
        checkUrl(url, { allowPrivateNetwork: false, ...(options.lookup ? { lookup: options.lookup } : {}) }),
      finished: (domain) => this.#probeAfterLogin(domain),
      log: options.log,
      idleMs: 10 * 60_000,
    });
  }

  get configured(): boolean {
    return this.#options.config().url !== null;
  }

  /** Lance la boucle de l'exécuteur (une seule fois) ; sans URL configurée, elle attend sans rien faire. */
  start(): void {
    this.#loop ??= this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    this.#poll?.abort();
    this.#current?.controller.abort();
    await this.#login.finish().catch(() => undefined);
    await this.#loop?.catch(() => undefined);
    this.#connection?.close();
  }

  // -- connexion --------------------------------------------------------------------

  /** La connexion persistante (un contexte), ouverte à la demande ; son échec est `CdpConnectError`. */
  #connect(): Promise<CdpConnection> {
    if (this.#connection !== null && !this.#connection.closed) return Promise.resolve(this.#connection);
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open(): Promise<CdpConnection> {
    const { url, token } = this.#options.config();
    if (url === null) throw new CdpConnectError("navigateur du poste non configuré");
    const connection = await CdpConnection.connect({
      url,
      token,
      callTimeoutMs: this.#options.callTimeoutMs ?? 30_000,
    });
    try {
      const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await connection.send("Page.enable", {}, { sessionId });
      this.#home = sessionId;
      // Une connexion neuve repart de l'instantané d'Obscura : le mirroir de Chrome est à renvoyer en entier.
      this.#generation = randomBytes(8).toString("hex");
    } catch (error) {
      connection.close();
      throw error;
    }
    this.#tabs.clear();
    this.#connection = connection;
    connection.onClose(() => {
      if (this.#connection !== connection) return;
      this.#connection = null;
      this.#generation = null;
      this.#tabs.clear();
      this.#poll?.abort();
      this.#workstation.forget(VPS_BROWSER);
    });
    return connection;
  }

  /** Le navigateur est connu du poste (réglage du navigateur par défaut) mais hors ligne. */
  #offline(): void {
    this.#workstation.touch(VPS_HELLO);
    this.#workstation.forget(VPS_BROWSER);
  }

  async #run(): Promise<void> {
    const retryMs = this.#options.retryMs ?? 5_000;
    const stopped = this.#stopping.signal;
    while (!stopped.aborted) {
      try {
        if (!this.configured) {
          await sleep(retryMs, undefined, { signal: stopped, ref: false });
          continue;
        }
        try {
          await this.#connect();
        } catch (error) {
          this.#offline();
          this.#options.log(`poste : navigateur vps injoignable (${error instanceof Error ? error.name : "erreur"})`);
          await sleep(retryMs, undefined, { signal: stopped, ref: false });
          continue;
        }
        await this.#probeDue();
        const poll = new AbortController();
        this.#poll = poll;
        if (stopped.aborted) poll.abort();
        const started = Date.now();
        const action = await this.#workstation.next(
          this.#options.pollSec ?? 5,
          poll.signal,
          VPS_HELLO,
          [...this.#tabs.keys()].join(","),
        );
        this.#poll = null;
        if (action !== null) await this.#execute(action);
        else if (Date.now() - started < 50) await sleep(100, undefined, { signal: stopped });
      } catch (error) {
        if (stopped.aborted) return;
        this.#options.log(`poste : exécuteur vps en erreur (${error instanceof Error ? error.name : "erreur"})`);
        await sleep(retryMs, undefined, { signal: stopped }).catch(() => undefined);
      }
    }
  }

  // -- exécution --------------------------------------------------------------------

  async #execute(action: WorkstationAction): Promise<void> {
    const controller = new AbortController();
    this.#current = { seq: action.seq, controller };
    let outcome: ActionOutcome;
    try {
      outcome = await this.#perform(action, controller.signal);
    } catch (error) {
      outcome = failed(controller.signal.aborted ? "arrêt demandé" : reason(error));
    } finally {
      this.#current = null;
    }
    // Annulée (arrêt d'urgence, annulation) : le serveur a déjà rendu l'action ; aucun résultat n'est plus attendu.
    if (controller.signal.aborted) return;
    try {
      this.#workstation.submitResult(action.seq, { ...outcome, agentTabs: [...this.#tabs.keys()] }, VPS_HELLO);
    } catch (error) {
      this.#options.log(
        `poste : résultat de l'action #${action.seq} refusé (${error instanceof Error ? error.name : "erreur"})`,
      );
    }
  }

  #tab(id: number): Tab {
    const tab = this.#tabs.get(id);
    if (tab === undefined) throw new Error(`onglet ${id} introuvable`);
    return tab;
  }

  async #send<T = Record<string, unknown>>(
    signal: AbortSignal,
    tab: Tab | null,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const connection = await abortable(this.#connect(), signal);
    // Les méthodes `Target.*` sont celles du navigateur : sans session.
    const sessionId = method.startsWith("Target.") ? undefined : (tab?.sessionId ?? (this.#home as string));
    return abortable(connection.send<T>(method, params, sessionId === undefined ? {} : { sessionId }), signal);
  }

  async #evaluate(signal: AbortSignal, tab: Tab, expression: string): Promise<unknown> {
    const reply = await this.#send<Evaluated>(signal, tab, "Runtime.evaluate", { expression, returnByValue: true });
    if (reply.exceptionDetails)
      throw new Error(
        reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "exception de la page",
      );
    return reply.result?.value;
  }

  /** Exécute une requête du côté page d'omp-chrome (injecté au besoin) et rend son issue telle quelle. */
  async #inPage(signal: AbortSignal, tab: Tab, request: Record<string, unknown>): Promise<ActionOutcome> {
    if ((await this.#evaluate(signal, tab, "typeof globalThis.__ompAgent")) !== "object")
      await this.#evaluate(signal, tab, agentScript());
    const outcome = await this.#evaluate(signal, tab, `globalThis.__ompAgent.run(${JSON.stringify(request)})`);
    if (outcome === null || typeof outcome !== "object") return failed("la page n'a rien rendu");
    return outcome as ActionOutcome;
  }

  async #locate(signal: AbortSignal, tab: Tab): Promise<{ url: string; title: string }> {
    const page = (await this.#evaluate(signal, tab, "({ url: location.href, title: document.title })")) as {
      url?: unknown;
      title?: unknown;
    };
    return { url: String(page.url ?? ""), title: String(page.title ?? "") };
  }

  async #navigate(signal: AbortSignal, tab: Tab, url: string): Promise<{ url: string; title: string }> {
    await this.#send(signal, tab, "Page.navigate", { url });
    const page = await this.#locate(signal, tab);
    await this.#observe(page.url);
    return page;
  }

  /** Une session ouverte qui renvoie vers une page de connexion est expirée (une alerte, une fois). */
  async #observe(url: string): Promise<void> {
    const host = hostOf(url);
    const account = host === null ? null : accountOfHost(host);
    if (account === null || !isLoginUrl(url)) return;
    const current = this.#workstation.vpsAccounts().find((entry) => entry.domain === account);
    if (current?.state === "connected") this.#workstation.setVpsAccount(account, "expired");
  }

  async #guardUrl(url: string): Promise<string | null> {
    const verdict = await checkUrl(url, {
      allowPrivateNetwork: false,
      ...(this.#options.lookup ? { lookup: this.#options.lookup } : {}),
    });
    return verdict.ok ? null : `adresse refusée : ${verdict.reason}`;
  }

  async #perform(action: WorkstationAction, signal: AbortSignal): Promise<ActionOutcome> {
    const checked = validateAction(action.kind, action.params);
    if (!checked.ok) return failed(checked.error);
    const params = checked.params;
    // L'empreinte de l'envoi que l'humain a vu, recomparée dans la page (comme l'extension).
    const gate = {
      approved: action.approved === true,
      approval: action.approval ? { fingerprint: action.approval.fingerprint } : null,
    };
    switch (params.kind) {
      case "decision":
        return failed("une décision est un journal : elle n'est jamais exécutée");
      case "tabs":
        return this.#tabsList(signal);
      case "open":
        return this.#openTab(signal, params.url);
      case "wait":
        await sleep(params.ms, undefined, { signal });
        return { outcome: "done", result: { text: `attendu ${Math.round(params.ms)} ms` } };
      case "close": {
        const tab = this.#tab(params.tabId);
        await this.#send(signal, tab, "Target.closeTarget", { targetId: tab.targetId });
        this.#tabs.delete(tab.id);
        return { outcome: "done", result: { text: `onglet ${tab.id} fermé` } };
      }
      case "download":
        return failed("download : Obscura ne gère pas les téléchargements de fichiers (limite du moteur)");
      default:
        return this.#inTab(signal, params, gate);
    }
  }

  async #tabsList(signal: AbortSignal): Promise<ActionOutcome> {
    const lines: string[] = [];
    for (const tab of this.#tabs.values()) {
      const page = await this.#locate(signal, tab);
      lines.push(`${tab.id} · agent · ${page.title.replace(/\s+/g, " ")} · ${page.url}`);
    }
    return { outcome: "done", result: { text: lines.join("\n") } };
  }

  async #openTab(signal: AbortSignal, url: string): Promise<ActionOutcome> {
    const refused = await this.#guardUrl(url);
    if (refused !== null) return failed(refused);
    if (this.#tabs.size >= MAX_TABS) return failed(`${MAX_TABS} onglets ouverts au plus : ferme-en un (close)`);
    const { targetId } = await this.#send<{ targetId: string }>(signal, null, "Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await this.#send<{ sessionId: string }>(signal, null, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const tab: Tab = { id: this.#nextTab++, targetId, sessionId };
    this.#tabs.set(tab.id, tab);
    try {
      await this.#send(signal, tab, "Page.enable");
      const page = await this.#navigate(signal, tab, url);
      return {
        outcome: "done",
        result: { text: `onglet ${tab.id} ouvert : ${page.title} · ${page.url}`, data: { tabId: tab.id } },
      };
    } catch (error) {
      this.#tabs.delete(tab.id);
      await this.#send(signal, null, "Target.closeTarget", { targetId }).catch(() => undefined);
      throw error;
    }
  }

  /** Les gestes qui visent un onglet de l'agent (tous ceux d'`obscura-poste`). */
  async #inTab(
    signal: AbortSignal,
    params: Exclude<ActionParams, { kind: "decision" | "tabs" | "open" | "wait" | "close" | "download" }>,
    gate: Record<string, unknown>,
  ): Promise<ActionOutcome> {
    const tab = this.#tab(params.tabId);
    switch (params.kind) {
      case "navigate": {
        const refused = await this.#guardUrl(params.url);
        if (refused !== null) return failed(refused);
        const page = await this.#navigate(signal, tab, params.url);
        return { outcome: "done", result: { text: `onglet ${tab.id} : ${page.title} · ${page.url}` } };
      }
      case "snapshot": {
        const outcome = await this.#inPage(signal, tab, { op: "snapshot", fullUrl: true });
        const data = outcome.outcome === "done" ? outcome.result?.data : undefined;
        if (data === undefined || typeof data !== "object" || data === null || !("tree" in data)) return outcome;
        return {
          outcome: "done",
          result: { data: mergeFrames([{ frameId: 0, snapshot: data as FrameSnapshot }], []) },
        };
      }
      case "screenshot": {
        const { data } = await this.#send<{ data?: string }>(signal, tab, "Page.captureScreenshot", { format: "png" });
        if (!data) return failed("screenshot : Obscura n'a rendu aucune image");
        const page = await this.#locate(signal, tab);
        return { outcome: "done", result: { text: `capture de l'onglet ${tab.id} (${page.title})` }, image: data };
      }
      case "click":
        return this.#gesture(signal, tab, { op: "click", ref: params.ref, ...gate });
      case "type":
        return this.#gesture(signal, tab, {
          op: "type",
          ref: params.ref,
          text: params.text,
          submit: params.submit,
          ...gate,
        });
      case "key":
        return this.#gesture(signal, tab, { op: "key", ref: params.ref, key: params.key, ...gate });
      case "hover":
        return this.#gesture(signal, tab, { op: "hover", ref: params.ref });
      case "select":
        return this.#gesture(signal, tab, { op: "select", ref: params.ref, option: params.option });
      case "scroll":
        return this.#inPage(signal, tab, { op: "scroll", dy: params.dy });
      case "wait_for":
        return this.#waitFor(signal, tab, params);
      case "back":
      case "forward":
      case "reload":
        return this.#history(signal, tab, params.kind);
      case "upload": {
        const file = this.#workstation.uploadFile(this.#current?.seq as number);
        const outcome = await this.#inPage(signal, tab, {
          op: "upload",
          ref: params.ref,
          file: { name: file.name, mime: file.mime, data: file.data },
        });
        return outcome.outcome === "failed"
          ? failed(`upload : Obscura ne sait pas joindre ce fichier (${outcome.error})`)
          : outcome;
      }
    }
  }

  /** Un geste du côté page ; une issue `done` laisse la page réagir, puis contrôle l'adresse (session expirée). */
  async #gesture(signal: AbortSignal, tab: Tab, request: Record<string, unknown>): Promise<ActionOutcome> {
    const outcome = await this.#inPage(signal, tab, request);
    if (outcome.outcome !== "done") return outcome;
    await sleep(GESTURE_PAUSE_MS, undefined, { signal });
    await this.#observe((await this.#locate(signal, tab)).url);
    return outcome;
  }

  async #waitFor(
    signal: AbortSignal,
    tab: Tab,
    params: Extract<ActionParams, { kind: "wait_for" }>,
  ): Promise<ActionOutcome> {
    const deadline = Date.now() + params.timeoutMs;
    for (;;) {
      const outcome = await this.#inPage(signal, tab, {
        op: "find",
        text: params.text,
        role: params.role,
        name: params.name,
      });
      const data = outcome.outcome === "done" ? (outcome.result?.data as { found?: unknown } | undefined) : undefined;
      if (outcome.outcome === "failed") return outcome;
      if (typeof data?.found === "string") return { outcome: "done", result: { text: `trouvé : ${data.found}` } };
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        return failed(
          `wait_for : toujours absent après ${params.timeoutMs} ms (${params.text !== null ? `texte « ${params.text} »` : `rôle ${params.role}`})`,
        );
      await sleep(Math.min(WAIT_FOR_POLL_MS, remaining), undefined, { signal });
    }
  }

  async #history(signal: AbortSignal, tab: Tab, kind: "back" | "forward" | "reload"): Promise<ActionOutcome> {
    const before = await this.#locate(signal, tab);
    if (kind === "reload") {
      const page = await this.#navigate(signal, tab, before.url);
      return { outcome: "done", result: { text: `onglet ${tab.id} : ${page.title} · ${page.url}` } };
    }
    await this.#evaluate(signal, tab, kind === "back" ? "history.back()" : "history.forward()");
    await sleep(GESTURE_PAUSE_MS * 2, undefined, { signal });
    const after = await this.#locate(signal, tab);
    if (after.url === before.url)
      return failed(
        `${kind} : aucune page ${kind === "back" ? "précédente" : "suivante"} (ou Obscura ne rejoue pas l'historique : limite du moteur)`,
      );
    await this.#observe(after.url);
    return { outcome: "done", result: { text: `onglet ${tab.id} : ${after.title} · ${after.url}` } };
  }

  // -- comptes : mirroir de la session de Chrome, connexion, état ---------------------

  /**
   * Ce que l'extension lit pour savoir si elle est la source du mirroir : la génération du jeu de
   * cookies d'`obscura-poste`, ou `null` (ce navigateur n'est pas la source, ou Obscura est injoignable).
   */
  async mirrorStatus(hello: BrowserHello): Promise<{ mirror: { generation: string } | null }> {
    if (!this.configured || hello.id === null || this.#workstation.settings().mirrorBrowser !== hello.id)
      return { mirror: null };
    try {
      await this.#connect();
    } catch {
      return { mirror: null };
    }
    return { mirror: this.#generation === null ? null : { generation: this.#generation } };
  }

  /**
   * Un envoi du mirroir : les cookies du Chrome de l'utilisateur, de TOUS les domaines, posés dans
   * `obscura-poste` par `Network.setCookies`, et ceux qui y ont disparu, retirés. Jamais écrits
   * ailleurs (ni base, ni journal, ni événement). Après le dernier envoi d'une copie entière, l'état
   * des comptes est relu : une page de connexion donne `blocked` (session copiée refusée).
   */
  async acceptMirror(hello: BrowserHello, body: Record<string, unknown>): Promise<{ set: number; removed: number }> {
    const source = this.#workstation.settings().mirrorBrowser;
    if (source === null || hello.id !== source)
      throw new HarnessError(403, "ce navigateur n'est pas la source du mirroir (réglage `mirrorBrowser` du poste)");
    const cookies = parseMirrorCookies(body.set);
    const removals = parseMirrorRemovals(body.removed);
    let connection: CdpConnection;
    try {
      connection = await this.#connect();
    } catch {
      throw new HarnessError(503, "navigateur du poste injoignable");
    }
    if (typeof body.generation !== "string" || body.generation !== this.#generation)
      throw new HarnessError(409, "génération périmée : le mirroir doit renvoyer la session entière");
    try {
      for (const removal of removals)
        await connection.send("Network.deleteCookies", removal, { sessionId: this.#home as string });
      if (cookies.length > 0)
        await connection.send("Network.setCookies", { cookies }, { sessionId: this.#home as string });
    } catch (error) {
      // Le message d'Obscura n'est pas rendu : il pourrait citer un cookie.
      throw new HarnessError(
        502,
        `navigateur du poste : cookies refusés (${error instanceof Error ? error.name : "erreur"})`,
      );
    }
    this.#workstation.markMirrored();
    if (body.full === true && body.last === true)
      void (async () => {
        for (const domain of ACCOUNT_DOMAINS) await this.#probe(domain, "blocked");
      })();
    return { set: cookies.length, removed: removals.length };
  }

  get login(): VpsLogin {
    return this.#login;
  }

  async #probeAfterLogin(domain: AccountDomain): Promise<void> {
    await this.#probe(domain, "disconnected");
  }

  /**
   * Relit l'état d'un compte en ouvrant sa page d'accueil dans un onglet jetable : une page de
   * connexion donne `onLogin`, sinon `connected`. Rend l'état posé, `null` si la page n'a pas chargé
   * (l'état reste ce qu'il était : un réseau en panne ne dit rien de la session).
   */
  async #probe(domain: AccountDomain, onLogin: AccountState): Promise<AccountState | null> {
    const url = this.#options.probeUrls?.[domain] ?? DEFAULT_PROBES[domain];
    const signal = AbortSignal.timeout(45_000);
    let targetId: string | null = null;
    try {
      const created = await this.#send<{ targetId: string }>(signal, null, "Target.createTarget", {
        url: "about:blank",
      });
      targetId = created.targetId;
      const { sessionId } = await this.#send<{ sessionId: string }>(signal, null, "Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const tab: Tab = { id: 0, targetId, sessionId };
      await this.#send(signal, tab, "Page.enable");
      await this.#send(signal, tab, "Page.navigate", { url });
      const page = await this.#locate(signal, tab);
      const state: AccountState = isLoginUrl(page.url) ? onLogin : "connected";
      this.#workstation.setVpsAccount(domain, state);
      return state;
    } catch {
      return null;
    } finally {
      if (targetId !== null)
        await this.#send(AbortSignal.timeout(5_000), null, "Target.closeTarget", { targetId }).catch(() => undefined);
    }
  }

  /** Relit périodiquement les comptes connectés : une session qui n'ouvre plus devient expirée. */
  async #probeDue(): Promise<void> {
    const every = this.#options.probeEveryMs ?? 30 * 60_000;
    if (Date.now() - this.#probedAt < every) return;
    this.#probedAt = Date.now();
    for (const account of this.#workstation.vpsAccounts())
      if (account.state === "connected") await this.#probe(account.domain, "expired");
  }
}

/** La raison d'un échec d'exécution, sans jamais reprendre un contenu de page. */
function reason(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "arrêt demandé";
  return error instanceof Error ? error.message : String(error);
}
