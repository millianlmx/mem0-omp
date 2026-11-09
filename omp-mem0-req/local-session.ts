// Le rapporteur de session locale : la session omp ouverte dans ce terminal se signale au
// harness (`POST /v1/local-sessions`), pour que les apps montrent ce qui se fait à la main à
// côté des runs du serveur.
//
// - La session PRINCIPALE seulement : le plugin est ré-instancié pour chaque sous-agent
//   (`ctx.agent.kind === "sub"`), qui ne rapporte rien ; un runner du harness (`MEM0_MODE=runner`)
//   non plus — le serveur le suit déjà.
// - Un battement à chaque changement d'état (ouverte ou en attente : `idle` ; l'agent tourne :
//   `working` ; fermée : `ended`), et au plus un toutes les 10 s pour les outils et leur
//   intention. Une session qui dure sans rien dire renvoie un battement d'entretien, sinon le
//   serveur la croirait partie.
// - Rien sans harness configuré (aucun appel réseau), rien si `OMP_HARNESS_LOCAL_SESSIONS=0`.
//   Le rapporteur ne jette JAMAIS dans l'hôte : toute erreur est avalée, et un serveur qui
//   refuse la route (401, 403, 404 : jeton refusé ou serveur trop ancien) le fait taire.
import { execFile } from "node:child_process";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HarnessCallError, harnessCall, resolveTarget } from "./harness.ts";

/** L'écart minimal entre deux battements d'outil d'un même état. */
export const BEAT_MIN_MS = 10_000;
/** Le pas de l'entretien, et le silence au-delà duquel il renvoie un battement, selon l'état. */
export const KEEPALIVE_TICK_MS = 30_000;
export const WORKING_KEEPALIVE_MS = 60_000;
export const IDLE_KEEPALIVE_MS = 10 * 60_000;
/** Le délai d'un battement ; celui du dernier tient dans le budget de `session_shutdown` (2 s). */
const SEND_TIMEOUT_MS = 5_000;
const FINAL_TIMEOUT_MS = 1_200;
/** Ce que le dernier battement attend des précédents encore en route, pour arriver après eux. */
const FINAL_DRAIN_MS = 300;
/** La branche et le distant sont relus au plus à cette cadence. */
const GIT_TTL_MS = 30_000;
const MAX_TITLE = 200;
const MAX_INTENT = 300;

type SessionState = "working" | "idle" | "ended";

/** La branche courante (`null` : HEAD détachée) et l'adresse du distant (`null` : aucun). */
export type GitInfo = { branch: string | null; remote: string | null };

export type LocalSessionOptions = {
  env?: Record<string, string | undefined>;
  /** Le dossier personnel où chercher `~/.omp/harness.json`. */
  home?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  /** La lecture de git dans `cwd` ; `null` : pas un dépôt, ou git absent. */
  git?: (cwd: string) => Promise<GitInfo | null>;
};

export type LocalSessionReporter = {
  /** Le dernier battement (`ended`), attendu : à appeler depuis `session_shutdown`. */
  shutdown(ctx: ExtensionContext | undefined): Promise<void>;
  /** Résolue quand les battements déjà partis ont reçu leur réponse. */
  settled(): Promise<void>;
};

/** La minuterie contenue de l'hôte (`ctx.setTimeout`, `ctx.setInterval`). */
type HostTimer = ReturnType<ExtensionContext["setTimeout"]>;

/** Ce que le rapporteur sait de la session suivie. */
type Tracked = {
  id: string;
  /** `null` : rien n'a encore été rapporté. */
  state: SessionState | null;
  /** L'instant du dernier battement parti, et celui du dernier battement d'outil. */
  sentAt: number;
  toolAt: number;
  cwd: string;
  title: string;
  /** Le premier message de l'utilisateur, gardé une fois trouvé. */
  firstMessage: string;
  tool: string | null;
  /** La dernière intention pas encore envoyée. */
  intent: string | null;
  /** Le battement différé qui portera l'outil et l'intention retenus par le débrayage. */
  flush: HostTimer | null;
};

/** La dernière lecture de git : `known` vaut `undefined` tant qu'elle court. */
type GitRead = { cwd: string; at: number; info: Promise<GitInfo | null>; known: GitInfo | null | undefined };

/** Une adresse de distant sans identifiants (`https://jeton@hôte/…` → `https://hôte/…`) ; `null` si elle est illisible. */
export function scrubRemote(url: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function gitLine(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", cwd, ...args], { timeout: 2_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
}

/** Les noms de branche que le serveur accepte (omp-harness/local-sessions.ts `isSafeBranch`). */
const SAFE_BRANCH = /^(?!-)[\w./-]{1,250}$/;

/**
 * La branche et le distant (`origin`, sinon le premier) du dépôt de `cwd`, lus par git. Une branche
 * que le serveur refuserait (un accent, un `@`…) part `null` : il rendrait 400 à chaque battement, et
 * la session ne paraîtrait jamais.
 */
export async function gitOf(cwd: string): Promise<GitInfo | null> {
  const [branch, remotes] = await Promise.all([
    gitLine(cwd, ["branch", "--show-current"]),
    gitLine(cwd, ["remote", "-v"]),
  ]);
  if (branch === null || remotes === null) return null;
  const fetched = remotes.split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
    return match ? [{ name: match[1], url: match[2] as string }] : [];
  });
  const chosen = fetched.find((remote) => remote.name === "origin") ?? fetched[0];
  const sober = SAFE_BRANCH.test(branch) && !branch.includes("..");
  return { branch: sober ? branch : null, remote: chosen ? scrubRemote(chosen.url) : null };
}

/** Le premier message de l'utilisateur de la branche courante, sur une ligne, coupé à 200 caractères. */
function firstUserMessage(ctx: ExtensionContext): string {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) continue;
    const { content } = entry.message;
    const text =
      typeof content === "string"
        ? content
        : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ");
    const line = text.replace(/\s+/g, " ").trim();
    if (line !== "") return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
  }
  return "";
}

/** Branche le rapporteur sur les événements de la session ; `session_shutdown` reste à l'appelant (`shutdown`). */
export function registerLocalSession(
  pi: Pick<ExtensionAPI, "on">,
  options: LocalSessionOptions = {},
): LocalSessionReporter {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const readGit = options.git ?? gitOf;
  const host = os.hostname();
  let session: Tracked | null = null;
  let lastCtx: ExtensionContext | undefined;
  let keepAlive: HostTimer | null = null;
  let queue: Promise<void> = Promise.resolve();
  /** Le serveur a refusé la route : plus aucun battement de cette session. */
  let refused = false;
  let git: GitRead | null = null;

  /** L'environnement fait foi au moment du hook, pas au chargement du module. */
  function reports(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
    return (
      !refused && env.OMP_HARNESS_LOCAL_SESSIONS !== "0" && env.MEM0_MODE !== "runner" && ctx?.agent?.kind === "main"
    );
  }

  function gitInfo(cwd: string): Promise<GitInfo | null> {
    if (git !== null && git.cwd === cwd && now() - git.at < GIT_TTL_MS) return git.info;
    const read: GitRead = { cwd, at: now(), info: readGit(cwd).catch(() => null), known: undefined };
    void read.info.then((info) => {
      read.known = info;
    });
    git = read;
    return read.info;
  }

  /** Le nom de la session, sinon son premier message ; vide tant qu'elle n'a ni l'un ni l'autre (le serveur nomme alors le dossier). */
  function titleOf(ctx: ExtensionContext, tracked: Tracked): string {
    const name = (ctx.sessionManager.getSessionName() ?? "").replace(/\s+/g, " ").trim();
    if (name !== "") return name.slice(0, MAX_TITLE);
    if (tracked.firstMessage === "") tracked.firstMessage = firstUserMessage(ctx);
    return tracked.firstMessage;
  }

  /**
   * Envoie un battement, sans jamais lever. `fresh` : la branche et le distant sont relus par git
   * s'ils datent ; sinon seuls ceux déjà lus partent (le dernier battement n'attend pas un process).
   */
  async function send(body: Record<string, unknown>, cwd: string, timeoutMs: number, fresh: boolean): Promise<void> {
    try {
      const target = resolveTarget(cwd, { ...env, HARNESS_REPO: env.HARNESS_REPO ?? "poste" }, options.home);
      if ("refusal" in target) return;
      const read = fresh ? await gitInfo(cwd) : git?.cwd === cwd ? git.known : undefined;
      const fetcher = options.fetcher ?? fetch;
      await harnessCall(target, "POST", "/v1/local-sessions", read ? { ...body, ...read } : body, {
        fetcher: (input, init) => fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      });
    } catch (err) {
      if (err instanceof HarnessCallError && [401, 403, 404].includes(err.status)) refused = true;
    }
  }

  /** Le battement de l'état courant de `tracked` : il porte l'outil et l'intention en attente. */
  function beatOf(ctx: ExtensionContext, tracked: Tracked): Record<string, unknown> {
    if (tracked.flush !== null) {
      ctx.clearTimer(tracked.flush);
      tracked.flush = null;
    }
    tracked.sentAt = now();
    tracked.cwd = ctx.cwd;
    tracked.title = titleOf(ctx, tracked);
    const { cost } = ctx.sessionManager.getUsageStatistics();
    const body = {
      id: tracked.id,
      host,
      cwd: tracked.cwd,
      title: tracked.title,
      state: tracked.state,
      ...(tracked.state === "working" && tracked.tool !== null ? { tool: tracked.tool } : {}),
      ...(tracked.intent !== null ? { intent: tracked.intent } : {}),
      ...(ctx.model ? { model: ctx.model.id } : {}),
      ...(Number.isFinite(cost) && cost >= 0 ? { cost } : {}),
    };
    tracked.intent = null;
    return body;
  }

  /** Un battement, à la suite des précédents : le serveur les reçoit dans l'ordre. */
  function emit(ctx: ExtensionContext, tracked: Tracked): void {
    const body = beatOf(ctx, tracked);
    const { cwd } = tracked;
    queue = queue.then(() => send(body, cwd, SEND_TIMEOUT_MS, true));
  }

  /** La session de `ctx` ; une autre que celle suivie (nouvelle, reprise, bifurquée) : l'ancienne est dite `ended`. */
  function trackedOf(ctx: ExtensionContext): Tracked {
    const id = ctx.sessionManager.getSessionId();
    if (session !== null && session.id === id) return session;
    const previous = session;
    if (previous !== null && previous.state !== null && previous.state !== "ended") {
      if (previous.flush !== null) ctx.clearTimer(previous.flush);
      const body = { id: previous.id, host, cwd: previous.cwd, title: previous.title, state: "ended" };
      queue = queue.then(() => send(body, previous.cwd, SEND_TIMEOUT_MS, false));
    }
    session = {
      id,
      state: null,
      sentAt: Number.NEGATIVE_INFINITY,
      toolAt: Number.NEGATIVE_INFINITY,
      cwd: ctx.cwd,
      title: "",
      firstMessage: "",
      tool: null,
      intent: null,
      flush: null,
    };
    return session;
  }

  /** L'entretien : un battement quand la session se tait depuis trop longtemps pour son état. */
  function tick(): void {
    try {
      const ctx = lastCtx;
      if (!reports(ctx) || session === null || session.state === null || session.state === "ended") return;
      const limit = session.state === "working" ? WORKING_KEEPALIVE_MS : IDLE_KEEPALIVE_MS;
      if (now() - session.sentAt >= limit) emit(ctx, session);
    } catch {
      /* le rapporteur ne jette jamais dans l'hôte */
    }
  }

  /**
   * La session est dans `state`. Un changement d'état part tout de suite. Sans changement, seul un
   * outil (`tool`) mérite un battement, au plus un par BEAT_MIN_MS : celui qui arrive trop tôt est
   * différé jusqu'à l'échéance, et porte alors le dernier outil et la dernière intention.
   */
  function report(ctx: ExtensionContext, state: SessionState, tool = false): void {
    lastCtx = ctx;
    const tracked = trackedOf(ctx);
    keepAlive ??= ctx.setInterval(tick, KEEPALIVE_TICK_MS);
    const changed = tracked.state !== state;
    tracked.state = state;
    if (!changed && !tool) return;
    const wait = changed ? 0 : BEAT_MIN_MS - (now() - tracked.toolAt);
    if (wait <= 0) {
      if (tool) tracked.toolAt = now();
      emit(ctx, tracked);
      return;
    }
    tracked.flush ??= ctx.setTimeout(() => {
      tracked.flush = null;
      try {
        if (session !== tracked || tracked.state !== state || !reports(ctx)) return;
        tracked.toolAt = now();
        emit(ctx, tracked);
      } catch {
        /* le rapporteur ne jette jamais dans l'hôte */
      }
    }, wait);
  }

  /** Un hook de l'hôte : rien hors de la session principale, et jamais une erreur qui remonte. */
  function hook<E>(handle: (event: E, ctx: ExtensionContext) => void): (event: E, ctx: ExtensionContext) => void {
    return (event, ctx) => {
      try {
        if (reports(ctx)) handle(event, ctx);
      } catch {
        /* le rapporteur ne jette jamais dans l'hôte */
      }
    };
  }

  pi.on(
    "session_start",
    hook((_event, ctx) => report(ctx, "idle")),
  );
  pi.on(
    "session_switch",
    hook((_event, ctx) => report(ctx, "idle")),
  );
  pi.on(
    "agent_start",
    hook((_event, ctx) => report(ctx, "working")),
  );
  pi.on(
    "tool_execution_start",
    hook((event, ctx) => {
      const tracked = trackedOf(ctx);
      tracked.tool = event.toolName;
      const intent = (event.intent ?? "").replace(/\s+/g, " ").trim();
      if (intent !== "") tracked.intent = intent.slice(0, MAX_INTENT);
      report(ctx, "working", true);
    }),
  );
  pi.on(
    "agent_end",
    hook((event, ctx) => {
      // Une relance automatique est déjà programmée : l'agent n'attend pas l'humain.
      if (event.willContinue !== true) report(ctx, "idle");
    }),
  );

  return {
    async shutdown(ctx) {
      try {
        if (!reports(ctx)) return;
        const tracked = trackedOf(ctx);
        // Rien n'a été rapporté, ou la fin l'a déjà été : rien à dire.
        if (tracked.state === null || tracked.state === "ended") return;
        tracked.state = "ended";
        if (keepAlive !== null) ctx.clearTimer(keepAlive);
        keepAlive = null;
        const body = beatOf(ctx, tracked);
        let drain: NodeJS.Timeout | undefined;
        await Promise.race([
          queue,
          new Promise<void>((resolve) => {
            drain = setTimeout(resolve, FINAL_DRAIN_MS);
          }),
        ]);
        clearTimeout(drain);
        await send(body, tracked.cwd, FINAL_TIMEOUT_MS, false);
      } catch {
        /* le rapporteur ne jette jamais dans l'hôte */
      }
    },
    settled: () => queue,
  };
}
