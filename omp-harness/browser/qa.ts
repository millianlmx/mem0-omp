// La QA de /review : la prévisualisation du worktree d'un run et SON navigateur Obscura.
//
// Deux conteneurs frères, par étape /review, nommés d'après le run :
// - la prévisualisation : l'image des tests du dépôt, `--network=none` (comme un job heavy, seul `lo`
//   existe), le worktree monté en lecture seule, `preview.command` lancé par `bash -c` ;
// - le navigateur : l'image épinglée `omp-harness-obscura:local`, `--network=container:<prévisualisation>`
//   — le SEUL réseau qu'il a —, `--allow-private-network` (la page est sur 127.0.0.1 : le drapeau vaut
//   pour tout le processus, et ce réseau ne contient que la prévisualisation).
// Le harness n'est sur aucun de ces réseaux : le CDP passe par `docker exec -i <navigateur> nc
// 127.0.0.1 9222` (stdin/stdout du CLI), jamais par un réseau partagé. Aucun port n'est publié.
//
// La QA ne bloque jamais la revue : un échec laisse une preuve `log` qui dit pourquoi. La page
// d'accueil est capturée d'office par le harness dès que la prévisualisation répond.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { QA_CDP_PORT } from "../config.ts";
import type { HarnessConfig, RepoConfig } from "../config.ts";
import type { HarnessError } from "../errors.ts";
import { clientEnv, heavyEnv } from "../heavy.ts";
import type { LogLine } from "../logger.ts";
import type { Exec, ProcResult } from "../proc.ts";
import { MAX_PROOF_BYTES, MAX_PROOF_TITLE } from "../proofs.ts";
import type { ProofSide, ProofStore } from "../proofs.ts";
import type { HostToolResult } from "../rpc.ts";
import { containerUser, engine } from "../runner.ts";
import { CdpClosedError, CdpConnectError, CdpTimeoutError } from "./cdp.ts";
import { browserError } from "./desk.ts";
import { GuardRefusal } from "./guard.ts";
import { QA_TOOL_ARGS } from "./qa-tools.ts";
import type { QaToolName } from "./qa-tools.ts";
import { BrowserSession, KEYS } from "./session.ts";
import type { SessionTarget } from "./session.ts";
import { renderPage } from "./snapshot.ts";
import { runBrowserTask } from "./task.ts";

/** L'image du navigateur de QA : celle de la pile (S-1), jamais une autre. */
export const QA_IMAGE = "omp-harness-obscura:local";

/** La mention des preuves de la QA : un rendu Obscura n'est pas un rendu de navigateur grand public. */
export const QA_CAPTION = "rendu Obscura, fidélité visuelle non garantie";

const BROWSER_MEMORY = "512m";
const POLL_MS = 500;
const CALL_TIMEOUT_MS = 30_000;
const RUN_TIMEOUT_MS = 120_000;
const SHORT_TIMEOUT_MS = 10_000;
const REMOVE_TIMEOUT_MS = 30_000;
const MAX_CAPTURES = 20;
const MAX_TAIL = 1500;

export type QaRole = "preview" | "browser";

/** Le nom d'un conteneur de la QA d'une étape (l'arrêt forcé au redémarrage le retrouve). */
export function qaUnit(runId: string, stepId: number, role: QaRole): string {
  return `omp-qa-${runId}-${stepId}-${role}`;
}

type Argv = { command: string; args: string[] };

const COMMON = [
  "run",
  "-d",
  "--rm",
  "--init",
  "--label=omp-harness=qa",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
];

/** La prévisualisation : sans réseau, worktree en lecture seule, commande du dépôt. */
export function previewArgv(
  config: HarnessConfig,
  repo: RepoConfig,
  preview: NonNullable<RepoConfig["preview"]>,
  worktree: string,
  unit: string,
): Argv {
  const heavy = config.heavy;
  const writable = [...(heavy.cargoTargetRoot ? [heavy.cargoTargetRoot] : []), ...heavy.readWritePaths];
  const env = { ...heavyEnv(config, worktree), HOME: "/tmp", PORT: String(preview.port) };
  return engine(config, [
    ...COMMON,
    `--name=${unit}`,
    "--network=none",
    `--memory=${heavy.memoryMax}`,
    `--memory-swap=${heavy.memoryMax}`,
    `--cpus=${Number.parseInt(heavy.cpuQuota, 10) / 100}`,
    `--oom-score-adj=${heavy.oomScoreAdjust}`,
    `--user=${containerUser(config)}`,
    "--tmpfs=/tmp",
    `--workdir=${worktree}`,
    "--volume",
    `${worktree}:${worktree}:ro`,
    ...[...new Set(writable)].flatMap((dir) => ["--volume", `${dir}:${dir}`]),
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    repo.testImage ?? config.container.testImage,
    "bash",
    "-c",
    preview.command,
  ]);
}

/**
 * Le navigateur : l'image épinglée avec son entrypoint, dans l'espace réseau de la prévisualisation et nulle
 * part ailleurs. Le jeton n'est pas dans la ligne de commande : `--env OBSCURA_CDP_TOKEN` le lit dans
 * l'environnement du CLI (`QaPreview` le lui donne).
 */
export function browserArgv(config: HarnessConfig, previewUnit: string, unit: string): Argv {
  return engine(config, [
    ...COMMON,
    `--name=${unit}`,
    `--network=container:${previewUnit}`,
    `--memory=${BROWSER_MEMORY}`,
    `--memory-swap=${BROWSER_MEMORY}`,
    "--cpus=1",
    "--env",
    "OBSCURA_ENV_FILE=/dev/null",
    "--env",
    "OBSCURA_CDP_TOKEN",
    QA_IMAGE,
    "--allow-private-network",
  ]);
}

/** La sonde de disponibilité, depuis le navigateur (même espace réseau que la prévisualisation). */
export function probeArgv(config: HarnessConfig, browserUnit: string, preview: { port: number; path: string }): Argv {
  return engine(config, [
    "exec",
    browserUnit,
    "/busybox",
    "wget",
    "-q",
    "-T",
    "2",
    "-O",
    "/dev/null",
    `http://127.0.0.1:${preview.port}${preview.path}`,
  ]);
}

export const inspectArgv = (config: HarnessConfig, previewUnit: string): Argv =>
  engine(config, ["inspect", "--format", "{{.State.Running}}", previewUnit]);

export const logsArgv = (config: HarnessConfig, previewUnit: string): Argv =>
  engine(config, ["logs", "--tail=20", previewUnit]);

/** Le canal CDP : stdin/stdout de ce process sont une socket vers Obscura, dans l'espace réseau de la QA. */
export const bridgeArgv = (config: HarnessConfig, browserUnit: string): Argv =>
  engine(config, ["exec", "-i", browserUnit, "/busybox", "nc", "127.0.0.1", String(QA_CDP_PORT)]);

export const removeArgv = (config: HarnessConfig, runId: string, stepId: number): Argv =>
  engine(config, ["rm", "--force", qaUnit(runId, stepId, "browser"), qaUnit(runId, stepId, "preview")]);

/** Arrête de force les conteneurs de la QA d'une étape (une absence n'est pas une erreur). */
export async function forceStopQa(
  config: HarnessConfig,
  exec: Exec,
  runId: string,
  stepId: number,
): Promise<ProcResult> {
  const argv = removeArgv(config, runId, stepId);
  return exec(argv.command, argv.args, { env: clientEnv(), timeoutMs: REMOVE_TIMEOUT_MS });
}

/** Un flux Duplex sur stdin/stdout d'un process : fermé avec lui, le process tué avec le flux. */
export function spawnBridge(argv: Argv): Duplex {
  const child = spawn(argv.command, argv.args, { env: clientEnv(), stdio: ["pipe", "pipe", "ignore"] });
  const stream = new Duplex({
    read() {
      child.stdout.resume();
    },
    write(chunk: Buffer, _encoding, done) {
      child.stdin.write(chunk, done);
    },
    final(done) {
      child.stdin.end();
      done();
    },
    destroy(error, done) {
      child.kill("SIGKILL");
      done(error);
    },
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) child.stdout.pause();
  });
  child.stdin.on("error", () => {});
  child.on("error", (error) => stream.destroy(error));
  child.on("close", () => {
    stream.push(null);
    setImmediate(() => stream.destroy());
  });
  return stream;
}

export type QaDeps = {
  config: HarnessConfig;
  exec: Exec;
  log: LogLine;
  proofs: ProofStore;
  /** Tests seulement : le canal CDP (par défaut `docker exec -i … nc`). */
  bridge?: (argv: Argv) => Duplex;
  /** Tests seulement : l'attente entre deux sondes de disponibilité. */
  pollMs?: number;
};

export type QaTarget = { runId: string; stepId: number; repo: RepoConfig; worktree: string };

const describe = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
};

const tail = (text: string): string => (text.length > MAX_TAIL ? `…${text.slice(-MAX_TAIL)}` : text).trim();

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

/** La QA d'une étape /review : démarrée en tâche de fond, arrêtée par `stop()`. */
export class QaPreview {
  readonly #deps: QaDeps;
  readonly #target: QaTarget;
  readonly #preview: NonNullable<RepoConfig["preview"]>;
  readonly #previewUnit: string;
  readonly #browserUnit: string;
  readonly #origin: string;
  readonly #token = randomBytes(32).toString("hex");
  readonly #abort = new AbortController();
  readonly #captures = new Map<string, Buffer>();
  readonly #ready: Promise<boolean>;
  readonly #done: Promise<void>;
  #reason: string | null = null;
  #touched = false;
  #stopping: Promise<void> | null = null;
  #session: BrowserSession | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #captureSeq = 0;

  /** `null` : le dépôt ne déclare pas de `preview`, rien à faire. */
  static start(deps: QaDeps, target: QaTarget, signal?: AbortSignal): QaPreview | null {
    return target.repo.preview === undefined ? null : new QaPreview(deps, target, target.repo.preview, signal);
  }

  private constructor(
    deps: QaDeps,
    target: QaTarget,
    preview: NonNullable<RepoConfig["preview"]>,
    signal: AbortSignal | undefined,
  ) {
    this.#deps = deps;
    this.#target = target;
    this.#preview = preview;
    this.#previewUnit = qaUnit(target.runId, target.stepId, "preview");
    this.#browserUnit = qaUnit(target.runId, target.stepId, "browser");
    this.#origin = `http://127.0.0.1:${preview.port}`;
    if (signal?.aborted) this.#abort.abort();
    else signal?.addEventListener("abort", () => this.#abort.abort(), { once: true });
    let markReady: (ok: boolean) => void = () => {};
    this.#ready = new Promise<boolean>((resolve) => {
      markReady = resolve;
    });
    this.#done = this.#boot(markReady)
      .catch((error) => {
        this.#fail(`erreur inattendue : ${describe(error)}`);
      })
      .finally(() => markReady(false));
  }

  /** Les outils `qa_*` ne sont proposés qu'à une QA qui peut tourner : isolation `container`. */
  get offersTools(): boolean {
    return this.#deps.config.heavy.isolation === "container";
  }

  /** La tâche de fond (démarrage, capture d'office) est finie : sa preuve, ou sa preuve d'échec, est écrite. */
  finish(): Promise<void> {
    return this.#done;
  }

  /** Ferme la session de l'agent, interrompt la tâche de fond, arrête les deux conteneurs. Idempotent. */
  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      this.#abort.abort();
      this.#session?.close();
      this.#session = null;
      await this.#done;
      if (!this.#touched) return;
      const removed = await forceStopQa(this.#deps.config, this.#deps.exec, this.#target.runId, this.#target.stepId);
      // Un conteneur absent (la prévisualisation n'a pas démarré, `--rm` l'a déjà retiré) n'est pas une erreur.
      if (removed.code !== 0 && !/no such container/i.test(removed.stderr))
        this.#deps.log(
          `QA de /review : arrêt des conteneurs de ${this.#previewUnit} refusé : ${tail(removed.stderr)}`,
          {
            level: "warn",
            runId: this.#target.runId,
            repo: this.#target.repo.name,
          },
        );
    })();
    return this.#stopping;
  }

  /** Une preuve `log` qui dit pourquoi la QA n'est pas (entièrement) disponible ; silencieuse si on l'arrête. */
  #note(reason: string): void {
    if (this.#abort.signal.aborted) return;
    const { runId, repo } = this.#target;
    this.#deps.log(`QA de /review indisponible : ${reason}`, { level: "warn", runId, repo: repo.name });
    this.#deps.proofs.add(runId, {
      kind: "log",
      title: "QA de /review indisponible",
      step: "review",
      mime: "text/plain; charset=utf-8",
      data: Buffer.from(`${reason}\nLa revue continue sans navigateur de QA ni capture.\n`, "utf8"),
      side: "after",
    });
  }

  /** La QA ne sera pas disponible : sa raison, une seule preuve `log`. */
  #fail(reason: string): false {
    if (this.#reason !== null) return false;
    this.#reason = reason;
    this.#note(reason);
    return false;
  }

  #run(argv: Argv, options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ProcResult> {
    return this.#deps.exec(argv.command, argv.args, {
      env: options.env ?? clientEnv(),
      timeoutMs: options.timeoutMs ?? SHORT_TIMEOUT_MS,
      signal: this.#abort.signal,
    });
  }

  async #boot(markReady: (ok: boolean) => void): Promise<void> {
    const { config } = this.#deps;
    const { repo, worktree } = this.#target;
    if (config.heavy.isolation !== "container") {
      this.#fail(
        `la prévisualisation ne tourne qu'en isolation container (heavy.isolation : ${config.heavy.isolation})`,
      );
      return;
    }
    this.#touched = true;
    const started = await this.#run(previewArgv(config, repo, this.#preview, worktree, this.#previewUnit), {
      timeoutMs: RUN_TIMEOUT_MS,
    });
    if (started.code !== 0) {
      this.#fail(`la prévisualisation n'a pas démarré : ${tail(started.stderr || started.stdout)}`);
      return;
    }
    const browser = await this.#run(browserArgv(config, this.#previewUnit, this.#browserUnit), {
      timeoutMs: RUN_TIMEOUT_MS,
      env: { ...clientEnv(), OBSCURA_CDP_TOKEN: this.#token },
    });
    if (browser.code !== 0) {
      this.#fail(`le navigateur de QA n'a pas démarré : ${tail(browser.stderr || browser.stdout)}`);
      return;
    }
    if (!(await this.#waitReady())) return;
    markReady(true);
    await this.#capture();
  }

  async #waitReady(): Promise<boolean> {
    const { config, pollMs = POLL_MS } = this.#deps;
    const { port, path, readyTimeoutSec } = this.#preview;
    const signal = this.#abort.signal;
    const deadline = Date.now() + readyTimeoutSec * 1000;
    for (;;) {
      const probe = await this.#run(probeArgv(config, this.#browserUnit, this.#preview));
      if (probe.code === 0) return true;
      if (signal.aborted) return false;
      if (/not running|no such container/i.test(probe.stderr))
        return this.#fail(`le navigateur de QA s'est arrêté : ${tail(probe.stderr)}`);
      const inspected = await this.#run(inspectArgv(config, this.#previewUnit));
      if (inspected.code !== 0 || inspected.stdout.trim() !== "true") {
        const logs = await this.#run(logsArgv(config, this.#previewUnit));
        const last = tail(`${logs.stdout}${logs.stderr}`);
        return this.#fail(`la prévisualisation s'est arrêtée avant de répondre${last === "" ? "" : ` :\n${last}`}`);
      }
      if (Date.now() >= deadline)
        return this.#fail(`la prévisualisation n'a pas répondu sur le port ${port} (${path}) en ${readyTimeoutSec} s`);
      await sleep(pollMs, signal);
    }
  }

  /** La page d'accueil, prise d'office par le harness sur sa propre connexion (décision #9). */
  async #capture(): Promise<void> {
    const { runId } = this.#target;
    const { path } = this.#preview;
    let png: Buffer;
    try {
      png = await runBrowserTask(
        this.#sessionTarget(),
        async (session) => {
          await session.navigate(`${this.#origin}${path}`);
          return session.screenshot();
        },
        { signal: this.#abort.signal },
      );
    } catch (error) {
      this.#note(`la capture d'office de la page d'accueil a échoué : ${describe(error)}`);
      return;
    }
    const added = this.#deps.proofs.add(runId, {
      kind: "screenshot",
      title: `Page d'accueil de la prévisualisation (${path.slice(0, 80)}) — ${QA_CAPTION}`,
      step: "review",
      mime: "image/png",
      data: png,
      side: "after",
    });
    if (!added.ok) this.#note(`la capture d'office n'a pas pu être enregistrée : ${added.reason}`);
  }

  #sessionTarget(): SessionTarget {
    return {
      url: `http://127.0.0.1:${QA_CDP_PORT}`,
      token: this.#token,
      allowPrivateNetwork: true,
      callTimeoutMs: CALL_TIMEOUT_MS,
      origin: this.#origin,
      connect: () => (this.#deps.bridge ?? spawnBridge)(bridgeArgv(this.#deps.config, this.#browserUnit)),
    };
  }

  /** Un outil de navigation `qa_*` : sérialisé, refusé avant toute page si la QA n'est pas disponible. */
  async tool(name: QaToolName, args: Record<string, unknown>): Promise<HostToolResult> {
    const unknown = Object.keys(args).find((key) => !QA_TOOL_ARGS[name].includes(key));
    if (unknown !== undefined) return refuse(name, `argument inconnu « ${unknown} »`);
    if (this.#stopping !== null) return refuse(name, "la QA de cette revue est arrêtée");
    if (!(await this.#ready))
      return { text: `${name} : QA indisponible : ${this.#reason ?? "arrêtée"}`, isError: true };
    const next = this.#queue.then(
      () => this.#operate(name, args),
      () => this.#operate(name, args),
    );
    this.#queue = next.catch(() => {});
    return next;
  }

  async #operate(name: QaToolName, args: Record<string, unknown>): Promise<HostToolResult> {
    if (this.#stopping !== null) return refuse(name, "la QA de cette revue est arrêtée");
    try {
      if (name === "qa_open") {
        const path = args.path ?? this.#preview.path;
        if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.length > 2048)
          return refuse(name, "path : un chemin de la prévisualisation, qui commence par « / »");
        if (this.#session === null || this.#session.closed)
          this.#session = await BrowserSession.open(this.#sessionTarget(), { signal: this.#abort.signal });
        await this.#session.navigate(`${this.#origin}${path}`);
        return page(await this.#session.snapshot());
      }
      const session = this.#session;
      if (session === null || session.closed) return refuse(name, "aucune page ouverte : commence par qa_open");
      switch (name) {
        case "qa_snapshot":
          return page(await session.snapshot());
        case "qa_screenshot": {
          if (this.#captures.size >= MAX_CAPTURES) return refuse(name, `${MAX_CAPTURES} captures en attente au plus`);
          const png = await session.screenshot();
          if (png.length > MAX_PROOF_BYTES) return refuse(name, "capture trop lourde");
          const id = `c${++this.#captureSeq}`;
          this.#captures.set(id, png);
          return {
            text: `capture ${id} (${png.length} octets). Ce n'est pas encore une preuve : \`qa_record_proof\` avec \`kind: screenshot\`, \`capture: ${id}\` et un \`title\` la joint à la revue.`,
            details: { capture: id, bytes: png.length },
          };
        }
        case "qa_click":
          if (!REF.test(String(args.ref))) return refuse(name, "ref : une référence [eN] du dernier snapshot");
          await session.click(String(args.ref));
          return page(await session.snapshot());
        case "qa_fill":
          if (!REF.test(String(args.ref))) return refuse(name, "ref : une référence [eN] du dernier snapshot");
          if (typeof args.text !== "string" || args.text.length > 10_000)
            return refuse(name, "text : 10 000 caractères au plus");
          await session.fill(String(args.ref), args.text);
          return page(await session.snapshot());
        case "qa_key": {
          if (typeof args.key !== "string" || !(args.key in KEYS))
            return refuse(name, `key : une touche parmi ${Object.keys(KEYS).join(", ")}`);
          if (args.ref !== undefined && !REF.test(String(args.ref)))
            return refuse(name, "ref : une référence [eN] du dernier snapshot");
          await session.key(args.key, args.ref === undefined ? undefined : String(args.ref));
          return page(await session.snapshot());
        }
        default:
          return refuse(name, "outil inconnu");
      }
    } catch (error) {
      if (
        error instanceof GuardRefusal ||
        error instanceof CdpTimeoutError ||
        error instanceof CdpClosedError ||
        error instanceof CdpConnectError
      ) {
        this.#session?.close();
        this.#session = null;
      }
      let mapped: HarnessError;
      try {
        mapped = browserError(error);
      } catch {
        throw error;
      }
      return { text: mapped.message, isError: true };
    }
  }

  /** `qa_record_proof { kind: "screenshot" }` : une capture de `qa_screenshot` devient une preuve du côté après. */
  attach(input: { capture: unknown; title: string; acRef: string | null; side: ProofSide | null }): HostToolResult {
    const reject = (reason: string): HostToolResult => ({ text: `qa_record_proof refusé : ${reason}`, isError: true });
    if (input.side === "before") return reject("la QA ne porte que sur le côté après");
    if (typeof input.capture !== "string")
      return reject("capture attendue pour un screenshot (l'identifiant rendu par qa_screenshot)");
    const png = this.#captures.get(input.capture);
    if (png === undefined) return reject(`capture inconnue ou déjà jointe : ${input.capture}`);
    const title = input.title.trim();
    if (title === "") return reject("titre vide");
    const suffix = ` — ${QA_CAPTION}`;
    const added = this.#deps.proofs.add(this.#target.runId, {
      kind: "screenshot",
      title: `${title.slice(0, MAX_PROOF_TITLE - suffix.length)}${suffix}`,
      step: "review",
      mime: "image/png",
      data: png,
      acRef: input.acRef,
      side: "after",
    });
    if (!added.ok) return reject(added.reason);
    this.#captures.delete(input.capture);
    return { text: `preuve #${added.proof.n} enregistrée` };
  }
}

const REF = /^e\d+$/;

const refuse = (name: string, reason: string): HostToolResult => ({
  text: `${name} refusé : ${reason}`,
  isError: true,
});

const page = (snapshot: Parameters<typeof renderPage>[0]): HostToolResult => ({ text: renderPage(snapshot) });
