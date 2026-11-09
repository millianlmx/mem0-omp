// La connexion interactive d'un compte (une fois, par l'appareil approbateur) : une page du
// navigateur du poste (`moli-poste`) dont l'app affiche des images et à laquelle elle renvoie
// clics et frappes, 2FA comprise. La page vit dans le contexte par défaut de Moli, celui de
// l'exécuteur : les cookies obtenus restent dans `moli-poste`. Elle survit à une connexion CDP
// tombée (Moli garde ses pages) : elle est rattachée à la connexion suivante, et le balayage de
// l'exécuteur l'épargne tant qu'elle est ouverte. Départ obligatoire sur un domaine de compte ;
// pendant la connexion, la navigation reste sur ces domaines et sur les hôtes de `allowedHosts`
// (l'IdP de l'entreprise) : une page qui mène ailleurs est vidée et la connexion est refusée.
// Le harness n'intercepte aucune requête : l'adresse est contrôlée APRÈS chaque navigation (les
// redirections sont suivies par le moteur).
import { randomBytes } from "node:crypto";
import type { LogLine } from "../logger.ts";
import { HarnessError } from "../errors.ts";
import { hostOf } from "../workstation-guards.ts";
import { CdpError } from "./cdp.ts";
import type { CdpConnection } from "./cdp.ts";
import { setTimeout as sleep } from "node:timers/promises";
import type { GuardVerdict } from "./guard.ts";
import { KEYS } from "./session.ts";
import { accountOfHost, loginNavigationAllowed } from "./vps-policy.ts";
import type { AccountDomain } from "./vps-policy.ts";

export type LoginView = { id: string; domain: AccountDomain; host: string; startedAt: number; error: string | null };

export type LoginInput =
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; dy: number };

/**
 * La fenêtre de la page de connexion, posée par `Emulation.setDeviceMetricsOverride` (Moli
 * ouvre ses pages en 1920 × 1080) : l'app y convertit ses clics.
 */
export const LOGIN_VIEWPORT = { width: 1280, height: 720 } as const;
const MAX_TEXT = 1000;
const SETTLE_MS = 300;

function bad(message: string): never {
  throw new HarnessError(400, message);
}

/** Un geste de l'app, validé : jamais une valeur hors fenêtre, jamais une touche hors liste. */
export function parseLoginInput(body: Record<string, unknown>): LoginInput {
  const finite = (key: string, min: number, max: number): number => {
    const value = body[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      bad(`${key} : nombre de ${min} à ${max} attendu`);
    return value;
  };
  switch (body.type) {
    case "click":
      return { type: "click", x: finite("x", 0, LOGIN_VIEWPORT.width), y: finite("y", 0, LOGIN_VIEWPORT.height) };
    case "text":
      if (typeof body.text !== "string" || body.text === "" || body.text.length > MAX_TEXT)
        bad(`text : chaîne de 1 à ${MAX_TEXT} caractères attendue`);
      return { type: "text", text: body.text };
    case "key":
      if (typeof body.key !== "string" || !Object.hasOwn(KEYS, body.key)) bad(`key : ${Object.keys(KEYS).join(" | ")}`);
      return { type: "key", key: body.key };
    case "scroll":
      return { type: "scroll", dy: finite("dy", -5000, 5000) };
    default:
      return bad("type : click | text | key | scroll");
  }
}

export type LoginDeps = {
  connection: () => Promise<CdpConnection>;
  allowedHosts: () => readonly string[];
  /** Le pré-contrôle réseau de l'adresse de départ (jamais le tailnet ni le réseau privé). */
  guard: (url: string) => Promise<GuardVerdict>;
  /** La connexion est finie : le compte est relu (probe) par l'appelant. */
  finished: (domain: AccountDomain) => Promise<void>;
  log: LogLine;
  idleMs: number;
};

type Page = LoginView & { targetId: string; sessionId: string; connection: CdpConnection; timer: NodeJS.Timeout };

export class VpsLogin {
  readonly #deps: LoginDeps;
  #page: Page | null = null;
  #frames = 0;

  constructor(deps: LoginDeps) {
    this.#deps = deps;
  }

  view(): LoginView | null {
    if (this.#page === null) return null;
    const { id, domain, host, startedAt, error } = this.#page;
    return { id, domain, host, startedAt, error };
  }

  /** La cible de la page ouverte, que le balayage de l'exécuteur ne ferme pas ; `null` sans connexion en cours. */
  target(): string | null {
    return this.#page?.targetId ?? null;
  }

  start(rawUrl: unknown): Promise<LoginView> {
    return this.#guarded(() => this.#start(rawUrl));
  }

  /** Une image de la page (PNG), après contrôle de l'adresse. */
  frame(): Promise<{ seq: number; mime: "image/png"; width: number; height: number; host: string; image: string }> {
    return this.#guarded(() => this.#frame());
  }

  input(event: LoginInput): Promise<void> {
    return this.#guarded(() => this.#input(event));
  }

  /** Une erreur CDP ou réseau devient une erreur du serveur, sans le texte de Moli. */
  async #guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError(502, `navigateur du poste : ${error instanceof Error ? error.name : "erreur"}`);
    }
  }

  async #start(rawUrl: unknown): Promise<LoginView> {
    if (typeof rawUrl !== "string") bad("url : adresse de la page de connexion attendue");
    const host = hostOf(rawUrl);
    const domain = host === null ? null : accountOfHost(host);
    if (domain === null) bad("url : la connexion part de slack.com ou de google.com (sous-domaines compris)");
    if (this.#page !== null) throw new HarnessError(409, "une connexion est déjà ouverte : termine-la d'abord");
    const verdict = await this.#deps.guard(rawUrl);
    if (!verdict.ok) bad(`adresse refusée : ${verdict.reason}`);
    const connection = await this.#deps.connection();
    const { targetId } = await connection.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await connection.send("Page.enable", {}, { sessionId });
    await fit(connection, sessionId);
    const page: Page = {
      id: `lg_${randomBytes(6).toString("hex")}`,
      domain: domain as AccountDomain,
      host: host as string,
      startedAt: Date.now(),
      error: null,
      targetId,
      sessionId,
      connection,
      timer: setTimeout(() => void this.finish().catch(() => undefined), this.#deps.idleMs).unref(),
    };
    this.#page = page;
    try {
      await connection.send("Page.navigate", { url: rawUrl }, { sessionId });
    } catch {
      // Un chargement qui échoue laisse la page vide : l'app le voit sur l'image.
    }
    await this.#verify(connection, page);
    return this.view() as LoginView;
  }

  async #frame(): Promise<{
    seq: number;
    mime: "image/png";
    width: number;
    height: number;
    host: string;
    image: string;
  }> {
    const { connection, page } = await this.#active();
    await this.#verify(connection, page);
    const { data } = await connection.send<{ data?: string }>(
      "Page.captureScreenshot",
      { format: "png" },
      { sessionId: page.sessionId },
    );
    return { seq: ++this.#frames, mime: "image/png", ...LOGIN_VIEWPORT, host: page.host, image: data ?? "" };
  }

  async #input(event: LoginInput): Promise<void> {
    const { connection, page } = await this.#active();
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      connection.send(method, params, { sessionId: page.sessionId });
    if (event.type === "click") {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x: event.x, y: event.y, button: "left", clickCount: 1 });
    } else if (event.type === "text") {
      await send("Input.insertText", { text: event.text });
    } else if (event.type === "key") {
      const key = { key: event.key, code: event.key, windowsVirtualKeyCode: KEYS[event.key] };
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...key,
        ...(event.key === "Enter" ? { text: "\r" } : {}),
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    } else {
      await send("Runtime.evaluate", { expression: `window.scrollBy(0, ${event.dy})` });
    }
    await sleep(SETTLE_MS);
    await this.#verify(connection, page);
  }

  /** Ferme la page de connexion ; l'état du compte est relu par `finished`. */
  async finish(): Promise<AccountDomain | null> {
    const page = this.#page;
    if (page === null) return null;
    this.#page = null;
    clearTimeout(page.timer);
    try {
      const connection = await this.#deps.connection();
      await connection.send("Target.closeTarget", { targetId: page.targetId });
    } catch {
      // Moli injoignable : la page, sans propriétaire, sera fermée par le balayage de la reconnexion.
    }
    await this.#deps.finished(page.domain).catch((error: unknown) => {
      this.#deps.log(`poste : état du compte non relu (${error instanceof Error ? error.name : "erreur"})`);
    });
    return page.domain;
  }

  async #active(): Promise<{ connection: CdpConnection; page: Page }> {
    const page = this.#page;
    if (page === null) throw new HarnessError(404, "aucune connexion ouverte");
    if (page.error !== null) throw new HarnessError(409, page.error);
    page.timer.refresh();
    const connection = await this.#deps.connection();
    if (page.connection !== connection) await this.#reattach(connection, page);
    return { connection, page };
  }

  /**
   * La page a survécu à la connexion tombée : une session sur la connexion neuve. Partie avec un
   * redémarrage de Moli, la connexion interactive est perdue (409 jusqu'à `finish`).
   */
  async #reattach(connection: CdpConnection, page: Page): Promise<void> {
    let sessionId: string;
    try {
      ({ sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      }));
    } catch (error) {
      if (!(error instanceof CdpError)) throw error;
      page.error = "page de connexion perdue (navigateur du poste redémarré) : recommence la connexion";
      throw new HarnessError(409, page.error);
    }
    await connection.send("Page.enable", {}, { sessionId });
    await fit(connection, sessionId);
    page.sessionId = sessionId;
    page.connection = connection;
  }

  /** L'adresse actuelle doit rester dans les domaines permis ; sinon la page est vidée et la connexion refusée. */
  async #verify(connection: CdpConnection, page: Page): Promise<void> {
    const reply = await connection.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      { sessionId: page.sessionId },
    );
    const host = hostOf(String(reply.result?.value ?? ""));
    if (host === null || loginNavigationAllowed(host, this.#deps.allowedHosts())) {
      if (host !== null) page.host = host;
      return;
    }
    page.error = `navigation refusée : ${host} n'est ni un domaine du compte ni un hôte permis (allowedHosts)`;
    await connection
      .send("Page.navigate", { url: "about:blank" }, { sessionId: page.sessionId })
      .catch(() => undefined);
    throw new HarnessError(409, page.error);
  }
}

/** Pose la fenêtre de la page de connexion (`LOGIN_VIEWPORT`), celle des images et des clics de l'app. */
async function fit(connection: CdpConnection, sessionId: string): Promise<void> {
  await connection.send(
    "Emulation.setDeviceMetricsOverride",
    { ...LOGIN_VIEWPORT, deviceScaleFactor: 1, mobile: false },
    { sessionId },
  );
}
