// Une session de navigation : UNE connexion CDP = UN contexte isolé d'Obscura (cookies, pages
// et état propres, détruits à la fermeture). Les gestes passent par les références `eN` du
// dernier snapshot. Obscura n'a ni DOM.getBoxModel ni getContentQuads : un clic se fait par
// le centre de getBoundingClientRect puis Input.dispatchMouseEvent.
import { CdpConnection, CdpError, CdpTimeoutError } from "./cdp.ts";
import { GuardRefusal, checkUrl } from "./guard.ts";
import type { GuardVerdict, Lookup } from "./guard.ts";
import { RefBook, buildSnapshot } from "./snapshot.ts";
import type { AxNode, PageSnapshot } from "./snapshot.ts";
import type { Duplex } from "node:stream";

/** Un geste mal formé (champ attendu, touche inconnue…) : le message ne reprend que des arguments de l'agent. */
export class BrowserUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUsageError";
  }
}

/** Une référence absente du dernier snapshot. */
export class UnknownRef extends Error {
  readonly ref: string;
  constructor(ref: string) {
    super(`référence inconnue : ${ref}`);
    this.name = "UnknownRef";
    this.ref = ref;
  }
}

/** Les touches que `key` sait envoyer, avec leur code de touche virtuelle. */
export const KEYS: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

export type SessionTarget = {
  url: string;
  token: string | null;
  allowPrivateNetwork: boolean;
  callTimeoutMs: number;
  /** Tests seulement : la résolution DNS du pré-contrôle. */
  lookup?: Lookup;
  /** Un transport à la place de la connexion TCP vers `url` (QA de /review : `docker exec`). */
  connect?: () => Duplex;
  /** Quand il est donné, toute navigation, redirection ou geste qui sort de cette origine est refusé (QA de /review). */
  origin?: string;
};

const GESTURE_PAUSE_MS = 300;
const POLL_MS = 100;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FIELD_ROLES = ["textbox", "searchbox", "combobox"];

const DOCUMENT_KEY = `(() => { const k = Symbol.for("omp.doc"); return document[k] || (document[k] = Math.random().toString(36).slice(2) + Date.now().toString(36)); })()`;

const CENTER = `function () {
  this.scrollIntoView({ block: "center" });
  const r = this.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}`;

const CLEAR = `function () {
  if (this.isContentEditable) this.textContent = ""; else this.value = "";
  this.dispatchEvent(new Event("input", { bubbles: true }));
}`;

const CHOOSE = `function (wanted) {
  if (this.tagName !== "SELECT") return "pas une liste";
  const options = Array.from(this.options || this.querySelectorAll("option"));
  const text = (o) => (o.textContent || "").trim();
  const option = options.find((o) => o.value === wanted) || options.find((o) => o.label === wanted || text(o) === wanted);
  if (!option) return "aucune option";
  option.selected = true;
  this.value = option.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;

type Evaluated = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export class BrowserSession {
  readonly #connection: CdpConnection;
  readonly #sessionId: string;
  readonly #target: SessionTarget;
  readonly #book = new RefBook();
  #last: PageSnapshot | null = null;

  constructor(connection: CdpConnection, sessionId: string, target: SessionTarget) {
    this.#connection = connection;
    this.#sessionId = sessionId;
    this.#target = target;
  }

  /** Ouvre la connexion, une cible vide et son domaine Page ; une étape qui échoue ferme la connexion. */
  static async open(target: SessionTarget, options: { signal?: AbortSignal } = {}): Promise<BrowserSession> {
    const connection = await CdpConnection.connect({
      url: target.url,
      token: target.token,
      callTimeoutMs: target.callTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(target.connect ? { connect: target.connect } : {}),
    });
    try {
      const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await connection.send("Page.enable", {}, { sessionId });
      return new BrowserSession(connection, sessionId, target);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.#connection.closed;
  }

  close(): void {
    this.#connection.close();
  }

  async navigate(url: string): Promise<void> {
    const verdict = await this.#verdict(url);
    if (!verdict.ok) throw new GuardRefusal(verdict.reason);
    await this.#send("Page.navigate", { url });
    await this.#verifyLocation();
  }

  async snapshot(): Promise<PageSnapshot> {
    this.#book.begin(String(await this.#evaluate(DOCUMENT_KEY)));
    const { nodes } = await this.#send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
    const page = (await this.#evaluate("({ url: location.href, title: document.title })")) as {
      url?: unknown;
      title?: unknown;
    };
    this.#last = buildSnapshot(nodes, this.#book, { url: String(page.url ?? ""), title: String(page.title ?? "") });
    return this.#last;
  }

  async click(ref: string): Promise<void> {
    const objectId = await this.#object(ref);
    const box = (await this.#call(objectId, CENTER)) as { x: number; y: number; w: number; h: number };
    if (!(box.w > 0 && box.h > 0)) throw new CdpError("click", "élément sans boîte visible", { remote: false });
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.#send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    await this.#afterGesture();
  }

  async fill(ref: string, text: string): Promise<void> {
    const backendNodeId = this.#backend(ref);
    if (!FIELD_ROLES.includes(this.#last?.refs.get(ref)?.role ?? ""))
      throw new BrowserUsageError(`fill : [${ref}] n'est pas un champ`);
    await this.#send("DOM.focus", { backendNodeId });
    await this.#call(await this.#object(ref), CLEAR);
    await this.#send("Input.insertText", { text });
    await this.#afterGesture();
  }

  async select(ref: string, value: string): Promise<void> {
    const outcome = await this.#call(await this.#object(ref), CHOOSE, [{ value }]);
    if (outcome === "pas une liste") throw new BrowserUsageError(`select : [${ref}] n'est pas une liste`);
    if (outcome !== "ok") throw new BrowserUsageError(`select : aucune option « ${value} »`);
    await this.#afterGesture();
  }

  async key(key: string, ref?: string): Promise<void> {
    const code = KEYS[key];
    if (code === undefined)
      throw new BrowserUsageError(`key : touche inconnue « ${key} » (${Object.keys(KEYS).join(", ")})`);
    if (ref !== undefined) await this.#send("DOM.focus", { backendNodeId: this.#backend(ref) });
    const event = { key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : {}) };
    await this.#send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await this.#send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    await this.#afterGesture();
  }

  /** Attend que `text` figure dans le texte de la page ; sinon `CdpTimeoutError("wait_for")`. */
  async waitFor(condition: { text: string }, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const probe = `(() => { const b = document.body; if (!b) return false; const t = b.innerText !== undefined ? b.innerText : b.textContent; return String(t).includes(${JSON.stringify(condition.text)}); })()`;
    for (;;) {
      if ((await this.#evaluate(probe)) === true) return;
      if (Date.now() + POLL_MS > deadline) throw new CdpTimeoutError("wait_for", timeoutMs);
      await sleep(POLL_MS);
    }
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.#send<{ data?: string }>("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(data ?? "", "base64");
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
      throw new CdpError("screenshot", "capture invalide", { remote: false });
    return png;
  }

  #guard(): { allowPrivateNetwork: boolean; lookup?: Lookup } {
    return {
      allowPrivateNetwork: this.#target.allowPrivateNetwork,
      ...(this.#target.lookup ? { lookup: this.#target.lookup } : {}),
    };
  }

  #send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#connection.send<T>(method, params, { sessionId: this.#sessionId });
  }

  /** Une exception levée par la page devient une erreur `remote` : son texte est un contenu non fiable. */
  #raise(method: string, details: Evaluated["exceptionDetails"]): void {
    if (details)
      throw new CdpError(method, details.exception?.description ?? details.text ?? "exception", { remote: true });
  }

  async #evaluate(expression: string): Promise<unknown> {
    const reply = await this.#send<Evaluated>("Runtime.evaluate", { expression, returnByValue: true });
    this.#raise("Runtime.evaluate", reply.exceptionDetails);
    return reply.result?.value;
  }

  async #call(objectId: string, functionDeclaration: string, args?: unknown[]): Promise<unknown> {
    const reply = await this.#send<Evaluated>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      returnByValue: true,
      ...(args ? { arguments: args } : {}),
    });
    this.#raise("Runtime.callFunctionOn", reply.exceptionDetails);
    return reply.result?.value;
  }

  #backend(ref: string): number {
    const backendId = this.#book.resolve(ref);
    if (backendId === null) throw new UnknownRef(ref);
    return backendId;
  }

  async #object(ref: string): Promise<string> {
    const { object } = await this.#send<{ object: { objectId: string } }>("DOM.resolveNode", {
      backendNodeId: this.#backend(ref),
    });
    return object.objectId;
  }

  /** L'URL finale d'une navigation ou d'un geste : refusée, la session se ferme (aucun contenu rendu). */
  async #verifyLocation(): Promise<void> {
    const verdict = await this.#verdict(String(await this.#evaluate("location.href")));
    if (verdict.ok) return;
    this.close();
    throw new GuardRefusal(verdict.reason);
  }

  /** Le pré-contrôle de `checkUrl`, plus l'origine unique d'une session bornée (QA de /review). */
  async #verdict(url: string): Promise<GuardVerdict> {
    const { origin } = this.#target;
    if (origin !== undefined) {
      let actual: URL | null = null;
      try {
        actual = new URL(url);
      } catch {
        actual = null;
      }
      if (actual === null) return { ok: false, reason: "URL illisible" };
      if (actual.origin !== origin) return { ok: false, reason: `${actual.host} : hors de la prévisualisation` };
    }
    return checkUrl(url, this.#guard());
  }

  async #afterGesture(): Promise<void> {
    await sleep(GESTURE_PAUSE_MS);
    await this.#verifyLocation();
  }
}
