// Les connexions OAuth des fournisseurs (abonnements Claude Pro/Max, ChatGPT, Gemini…),
// menées depuis les apps Mac et iOS, sans terminal sur le serveur.
//
// omp mène la connexion lui-même : en mode RPC, `get_login_providers` liste les
// fournisseurs et leur état, `login` déroule le flux et le confie à l'hôte par deux
// demandes d'UI — `open_url` (le lien à ouvrir dans un navigateur) puis `input` (le
// code d'autorisation, ou l'URL de retour, que le navigateur de l'humain ne peut pas
// renvoyer au serveur). Le service lance cet omp avec l'identité, le HOME et le
// profil des runners : les identifiants atterrissent là où les runners les lisent.
// Ils ne transitent jamais par le service, ni par l'API, ni par la base.
//
// Une connexion à la fois. Ce qu'un humain voit d'une connexion (`LoginView`) vit en
// mémoire : un redémarrage du service l'abandonne, et l'app en relance une.
import { randomBytes } from "node:crypto";
import type { HarnessConfig } from "./config.ts";
import type { SpawnRunner } from "./context.ts";
import { HarnessError } from "./errors.ts";
import type { Exec } from "./proc.ts";
import type { ProviderRegistry } from "./providers.ts";
import { RpcRunner } from "./rpc.ts";
import { containerUser, engine, forceStop } from "./runner.ts";

/** Un fournisseur qu'omp sait connecter en OAuth, et s'il l'est déjà. */
export type LoginProvider = { id: string; name: string; available: boolean; authenticated: boolean };

/**
 * `starting` : omp démarre ; `waiting` : le lien est prêt (et `prompt`, si omp attend le
 * code) ; `verifying` : le code est parti ; puis `done`, `failed` ou `cancelled`.
 */
export type LoginState = "starting" | "waiting" | "verifying" | "done" | "failed" | "cancelled";

export type LoginView = {
  id: string;
  provider: string;
  state: LoginState;
  /** Le lien à ouvrir dans un navigateur (http ou https seulement). */
  url: string | null;
  /** Les consignes du fournisseur, telles qu'omp les donne. */
  instructions: string | null;
  /** La question d'omp quand il attend une saisie (le code, ou l'URL de retour) ; sinon `null`. */
  prompt: string | null;
  /** Les messages d'avancement d'omp, du plus ancien au plus récent. */
  progress: string[];
  error: string | null;
  startedBy: string | null;
  startedAt: string;
};

const TERMINAL: ReadonlySet<LoginState> = new Set(["done", "failed", "cancelled"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** omp attend le code dix minutes ; le service ne garde pas une connexion plus longtemps. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Une connexion finie reste lisible ce temps-là, le temps que l'app lise son issue. */
const KEEP_MS = 10 * 60 * 1000;

/**
 * omp refuse de démarrer en mode RPC sans aucun modèle utilisable (« No models
 * available »). Une connexion n'en appelle aucun et ne reçoit aucune clé : une clé
 * factice d'un fournisseur sans abonnement (Groq) suffit à le démarrer, sans
 * qu'aucun abonnement ne paraisse connecté.
 */
export const LOGIN_PLACEHOLDER_ENV: Readonly<Record<string, string>> = { GROQ_API_KEY: "omp-harness-login" };

type Live = {
  view: LoginView;
  runner: RpcRunner | null;
  unit: string;
  promptId: string | null;
  endedAt: number | null;
};

/** L'omp d'une connexion : celui des runners (même image, même HOME, même profil), sans worktree ni clé montée. */
export function loginArgv(config: HarnessConfig, unit: string): { command: string; args: string[] } {
  const omp = (cwd: string) => [
    config.ompBin,
    "--mode",
    "rpc",
    "--no-ui",
    "--no-session",
    "--no-lsp",
    "--no-title",
    "--profile",
    config.runner.profile,
    "--cwd",
    cwd,
  ];
  const isolation = config.runner.isolation;
  if (isolation === "none") {
    const line = omp(config.dataDir);
    return { command: line[0] as string, args: line.slice(1) };
  }
  if (isolation === "container") {
    const box = config.container;
    if (!box.runnerHome)
      throw new HarnessError(
        501,
        "connexion OAuth : container.runnerHome n'est pas déclaré, les identifiants ne survivraient pas au conteneur",
      );
    return engine(config, [
      "run",
      "--rm",
      "-i",
      "--init",
      `--name=${unit}`,
      "--label=omp-harness=login",
      `--memory=${config.runner.memoryMax}`,
      `--memory-swap=${config.runner.memoryMax}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--user=${containerUser(config)}`,
      ...(box.network ? [`--network=${box.network}`] : []),
      "--workdir=/home/runner",
      "--volume",
      `${box.runnerHome}:/home/runner`,
      "--env",
      "HOME=/home/runner",
      ...Object.entries(LOGIN_PLACEHOLDER_ENV).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      box.runnerImage,
      ...omp("/home/runner"),
    ]);
  }
  throw new HarnessError(
    501,
    `connexion OAuth depuis les apps : pas en isolation systemd — sur le serveur, « sudo -u omp-runner -H omp --profile ${config.runner.profile} », puis /login`,
  );
}

/** Le message d'une commande refusée par omp, sans le préfixe du client RPC. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^login refusé : /, "");
}

export class OAuthLogins {
  readonly #config: HarnessConfig;
  readonly #spawn: SpawnRunner;
  readonly #exec: Exec;
  readonly #providers: ProviderRegistry;
  readonly #log: (line: string) => void;
  readonly #timeoutMs: number;
  readonly #logins = new Map<string, Live>();

  constructor(deps: {
    config: HarnessConfig;
    spawn: SpawnRunner;
    exec: Exec;
    providers: ProviderRegistry;
    log: (line: string) => void;
    timeoutMs?: number;
  }) {
    this.#config = deps.config;
    this.#spawn = deps.spawn;
    this.#exec = deps.exec;
    this.#providers = deps.providers;
    this.#log = deps.log;
    this.#timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  /** Les fournisseurs qu'omp sait connecter, et leur état chez les runners. */
  async providers(): Promise<LoginProvider[]> {
    const unit = `omp-login-${randomBytes(4).toString("hex")}`;
    const runner = this.#open(unit, () => {});
    try {
      await runner.ready();
      const data = await runner.request({ type: "get_login_providers" });
      const list = Array.isArray(data)
        ? data
        : Array.isArray((data as { providers?: unknown } | null)?.providers)
          ? (data as { providers: unknown[] }).providers
          : [];
      return list
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
        .filter((entry) => typeof entry.id === "string" && PROVIDER_ID.test(entry.id))
        .map((entry) => ({
          id: entry.id as string,
          name: typeof entry.name === "string" ? entry.name : (entry.id as string),
          available: entry.available !== false,
          authenticated: entry.authenticated === true,
        }));
    } catch (err) {
      throw new HarnessError(502, `omp ne liste pas ses fournisseurs OAuth : ${reason(err)}`);
    } finally {
      await this.#stop(runner, unit);
    }
  }

  /** La connexion en cours, s'il y en a une. */
  active(): LoginView | null {
    this.#prune();
    for (const live of this.#logins.values()) if (!TERMINAL.has(live.view.state)) return structuredClone(live.view);
    return null;
  }

  /** Lance la connexion d'un fournisseur ; l'issue se lit ensuite avec `view`. */
  start(provider: string, by: string | null): LoginView {
    if (!PROVIDER_ID.test(provider)) throw new HarnessError(400, `fournisseur OAuth illisible : ${provider}`);
    const busy = this.active();
    if (busy) throw new HarnessError(409, `une connexion est déjà en cours (${busy.provider}) : finis-la ou annule-la`);
    const id = randomBytes(8).toString("hex");
    const unit = `omp-login-${id}`;
    // L'isolation est vérifiée avant de rendre la main : systemd est refusé ici, pas plus tard.
    loginArgv(this.#config, unit);
    const live: Live = {
      view: {
        id,
        provider,
        state: "starting",
        url: null,
        instructions: null,
        prompt: null,
        progress: [],
        error: null,
        startedBy: by,
        startedAt: new Date().toISOString(),
      },
      runner: null,
      unit,
      promptId: null,
      endedAt: null,
    };
    this.#logins.set(id, live);
    this.#log(`connexion OAuth ${provider} lancée${by ? ` par ${by}` : ""}`);
    void this.#drive(live);
    return structuredClone(live.view);
  }

  view(id: string): LoginView {
    this.#prune();
    const live = this.#logins.get(id);
    if (!live) throw new HarnessError(404, `connexion inconnue : ${id}`);
    return structuredClone(live.view);
  }

  /** Le code d'autorisation (ou l'URL de retour) que l'humain a copié de son navigateur. */
  answer(id: string, value: string): LoginView {
    const live = this.#logins.get(id);
    if (!live) throw new HarnessError(404, `connexion inconnue : ${id}`);
    const text = value.trim();
    if (text === "" || text.length > 4096) throw new HarnessError(400, "value : le code ou l'URL de retour");
    if (live.promptId === null || !live.runner) throw new HarnessError(409, "cette connexion n'attend pas de code");
    live.runner.respondUi(live.promptId, text);
    live.promptId = null;
    live.view.prompt = null;
    live.view.state = "verifying";
    return structuredClone(live.view);
  }

  /** Abandonne une connexion : omp s'arrête, rien n'est enregistré. */
  async cancel(id: string): Promise<LoginView> {
    const live = this.#logins.get(id);
    if (!live) throw new HarnessError(404, `connexion inconnue : ${id}`);
    if (!TERMINAL.has(live.view.state)) {
      this.#end(live, "cancelled", null);
      if (live.runner) await this.#stop(live.runner, live.unit);
    }
    return structuredClone(live.view);
  }

  /** L'arrêt du service : les connexions en cours sont abandonnées. */
  async stop(): Promise<void> {
    for (const live of this.#logins.values()) {
      if (TERMINAL.has(live.view.state)) continue;
      this.#end(live, "cancelled", null);
      if (live.runner) await this.#stop(live.runner, live.unit);
    }
  }

  async #drive(live: Live): Promise<void> {
    let timer: NodeJS.Timeout | null = null;
    try {
      const runner = this.#open(live.unit, (frame) => this.#onFrame(live, frame));
      live.runner = runner;
      await runner.ready();
      if (TERMINAL.has(live.view.state)) return;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("délai dépassé : aucun code reçu en dix minutes")), this.#timeoutMs);
      });
      await Promise.race([runner.request({ type: "login", providerId: live.view.provider }), timeout]);
      if (TERMINAL.has(live.view.state)) return;
      this.#end(live, "done", null);
      this.#providers.adoptOAuth(live.view.provider, live.view.startedBy);
      this.#log(`connexion OAuth ${live.view.provider} réussie`);
    } catch (err) {
      if (!TERMINAL.has(live.view.state)) {
        this.#end(live, "failed", reason(err));
        this.#log(`connexion OAuth ${live.view.provider} échouée : ${reason(err)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (live.runner) await this.#stop(live.runner, live.unit);
    }
  }

  #onFrame(live: Live, frame: Record<string, unknown>): void {
    if (frame.type !== "extension_ui_request" || TERMINAL.has(live.view.state)) return;
    const id = typeof frame.id === "string" ? frame.id : null;
    switch (frame.method) {
      case "open_url":
        if (typeof frame.url === "string" && /^https?:\/\/\S+$/.test(frame.url)) live.view.url = frame.url;
        if (typeof frame.instructions === "string") live.view.instructions = frame.instructions;
        live.view.state = "waiting";
        return;
      case "input":
        // Un nouveau `input` remplace le précédent : omp redemande le code tant qu'il ne l'a pas.
        live.promptId = id;
        live.view.prompt =
          typeof frame.title === "string" ? frame.title : typeof frame.message === "string" ? frame.message : "";
        live.view.state = "waiting";
        return;
      case "notify":
        if (typeof frame.message === "string") live.view.progress = [...live.view.progress, frame.message].slice(-20);
        return;
      default:
        // Un choix ou une confirmation : rien que l'app sache montrer, omp échoue proprement.
        if (
          id !== null &&
          typeof frame.method === "string" &&
          ["select", "confirm", "editor", "ask"].includes(frame.method)
        )
          live.runner?.respondUi(id, null);
    }
  }

  #end(live: Live, state: LoginState, error: string | null): void {
    live.view.state = state;
    live.view.error = error;
    live.view.prompt = null;
    live.promptId = null;
    live.endedAt = Date.now();
  }

  #open(unit: string, onFrame: (frame: Record<string, unknown>) => void): RpcRunner {
    const argv = loginArgv(this.#config, unit);
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.HARNESS_TOKEN;
    for (const [key, value] of Object.entries(LOGIN_PLACEHOLDER_ENV)) env[key] ??= value;
    const proc = this.#spawn(argv.command, argv.args, { cwd: this.#config.dataDir, env });
    return new RpcRunner(proc, {
      onHostTool: async () => ({ text: "aucun outil hôte pendant une connexion", isError: true }),
      onFrame,
      interactive: true,
    });
  }

  async #stop(runner: RpcRunner, unit: string): Promise<void> {
    const force =
      this.#config.runner.isolation === "container" ? () => forceStop(this.#config, this.#exec, unit) : undefined;
    await runner.stop(2000, force);
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, live] of this.#logins) {
      if (live.endedAt !== null && now - live.endedAt > KEEP_MS) this.#logins.delete(id);
    }
  }
}
