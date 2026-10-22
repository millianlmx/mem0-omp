// La session d'un runner OMP : un process RPC, son modèle et sa chaîne de bascule.
//
// Partagée par les runs et les audits — une seule façon de lancer un runner, de
// prendre un jeton de fournisseur par prompt, de basculer sur un rate limit (même
// runner, `set_model`), de changer de tier entre deux étapes et de BORNER un prompt
// dans le temps : au-delà de l'échéance de l'étape, le runner est arrêté et le
// prompt rend une erreur relançable, jamais une attente infinie.
import type { ModelChoice, RepoConfig, Tier } from "./config.ts";
import { modelChain } from "./config.ts";
import type { HarnessContext } from "./context.ts";
import type { EventType } from "./events.ts";
import { FAILOVER_PROMPT } from "./prompts.ts";
import type { HostToolDefinition, HostToolHandler, PromptResult } from "./rpc.ts";
import { RpcRunner, isRateLimit } from "./rpc.ts";
import { runnerArgv, runnerEnv, stopRunner } from "./runner.ts";


export type SessionHooks = {
  onHostTool: HostToolHandler;
  /** Un événement de la session (runner lancé ou arrêté, bascule, délai) au nom de son propriétaire. */
  event: (type: EventType, payload: Record<string, unknown>) => void;
  /** Le modèle ou l'unité du runner ont changé (lancement, bascule, changement de tier). */
  runnerChanged?: (unit: string | null, model: string | null) => void;
};

/** Le résultat d'un prompt arrêté à l'échéance de son étape. */
export function timeoutResult(seconds: number): PromptResult {
  return { status: "error", error: { message: `délai d'étape dépassé (${seconds} s) : runner arrêté`, retryable: true } };
}


export function modelLabel(model: ModelChoice | null): string | null {
  return model ? `${model.provider}/${model.model}` : null;
}


export class RunnerSession {
  readonly #ctx: HarnessContext;
  readonly #repo: RepoConfig;
  readonly #cwd: string;
  readonly #hooks: SessionHooks;
  #runner: RpcRunner | null = null;
  #unit: string | null = null;
  #tier: Tier | null = null;
  #model: ModelChoice | null = null;
  #modelIndex = 0;
  /** Le jeton du fournisseur déjà pris au lancement (le premier prompt ne repaie pas). */
  #prepaid = false;

  constructor(ctx: HarnessContext, target: { repo: RepoConfig; cwd: string }, hooks: SessionHooks) {
    this.#ctx = ctx;
    this.#repo = target.repo;
    this.#cwd = target.cwd;
    this.#hooks = hooks;
  }

  get alive(): boolean {
    return this.#runner?.alive === true;
  }

  get unit(): string | null {
    return this.#unit;
  }

  get model(): string | null {
    return modelLabel(this.#model);
  }

  /**
   * Un runner prêt pour `tier` : celui qui vit déjà (review ⇄ fix garde sa
   * conversation, seul le modèle suit le tier), sinon un nouveau, sous `unit`.
   * Rend `true` si le runner a été réutilisé.
   */
  async open(tier: Tier, unit: string, signal: AbortSignal): Promise<boolean> {
    const { config, scheduler } = this.#ctx;
    if (this.#runner?.alive) {
      if (this.#tier !== tier) {
        const pick = await scheduler.waitModel(tier, modelChain(config, tier), 0, signal);
        this.#tier = tier;
        this.#prepaid = pick !== null;
        if (pick && (pick.choice.provider !== this.#model?.provider || pick.choice.model !== this.#model?.model)) {
          await this.#switch(pick.choice, pick.index, "model_tier");
        } else if (pick) this.#modelIndex = pick.index;
      }
      return true;
    }
    const pick = await scheduler.waitModel(tier, modelChain(config, tier), 0, signal);
    this.#tier = tier;
    this.#model = pick?.choice ?? null;
    this.#modelIndex = pick?.index ?? 0;
    this.#prepaid = pick !== null;
    const scope = this.#repo.scope;
    const argv = runnerArgv(config, {
      unit,
      cwd: this.#cwd,
      overlay: this.#ctx.overlay(),
      model: this.#model,
      scope,
      repo: this.#repo.path,
      oracleUrl: config.oracle?.url ?? null,
    });
    const proc = this.#ctx.spawn(argv.command, argv.args, { cwd: this.#cwd, env: runnerEnv(scope, config.oracle) });
    const runner = new RpcRunner(proc, {
      onHostTool: this.#hooks.onHostTool,
      onFrame: frame => {
        // L'activité des outils est ÉPHÉMÈRE : poussée en direct, jamais écrite au journal.
        if (frame.type === "tool_execution_start") this.#hooks.event("activity", { tool: frame.toolName, intent: frame.intent ?? null });
      },
    });
    this.#runner = runner;
    this.#unit = unit;
    this.#hooks.runnerChanged?.(unit, this.model);
    this.#hooks.event("runner_started", { unit, model: this.model });
    await runner.ready();
    // Un arrêt demandé pendant le lancement : le runner tout juste né ne survit pas.
    if (signal.aborted) {
      await this.stop();
      throw new Error("runner arrêté pendant son lancement");
    }
    return false;
  }

  setHostTools(tools: HostToolDefinition[]): Promise<unknown> {
    return this.#live().setHostTools(tools);
  }

  #live(): RpcRunner {
    if (!this.#runner) throw new Error("aucun runner ouvert");
    return this.#runner;
  }

  /**
   * Un prompt, avec un jeton du fournisseur courant (ou du suivant de la chaîne), la
   * bascule sur rate limit, et l'échéance `deadlineAt` (ms) : passé ce temps, le
   * runner est arrêté et le prompt rend une erreur relançable.
   */
  async prompt(message: string, signal: AbortSignal, deadlineAt: number): Promise<PromptResult> {
    const { config, scheduler } = this.#ctx;
    const tier = this.#tier ?? "heavy";
    const chain = modelChain(config, tier);
    if (this.#prepaid) this.#prepaid = false;
    else if (chain.length > 0 && this.#model) {
      const pick = await scheduler.waitModel(tier, chain, this.#modelIndex, signal);
      if (pick && pick.index !== this.#modelIndex) await this.#switch(pick.choice, pick.index, "model_failover");
    }
    let text = message;
    for (let failovers = 0; ; failovers++) {
      const result = await this.#bounded(text, deadlineAt, signal);
      if (result.status !== "error" || !isRateLimit(result.error) || !this.#model || failovers >= chain.length) return result;
      scheduler.reportRateLimit(this.#model.provider, null);
      this.#hooks.event("rate_limited", { provider: this.#model.provider, model: this.#model.model });
      const next = await scheduler.waitModel(tier, chain, (this.#modelIndex + 1) % chain.length, signal);
      if (!next) return result;
      await this.#switch(next.choice, next.index, "model_failover");
      text = FAILOVER_PROMPT;
    }
  }

  /**
   * Le prompt borné par l'échéance et par `signal` : à l'heure, le runner est arrêté
   * (son prompt rejette, ignoré) ; sur un arrêt, il est arrêté aussi et le prompt lève.
   */
  async #bounded(text: string, deadlineAt: number, signal: AbortSignal): Promise<PromptResult> {
    if (signal.aborted) throw new Error("prompt annulé : run arrêté");
    const onAbort = () => void this.stop();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.#timed(text, deadlineAt);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #timed(text: string, deadlineAt: number): Promise<PromptResult> {
    const seconds = this.#ctx.config.runner.stepTimeoutSec;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      this.#hooks.event("step_timeout", { seconds });
      await this.stop();
      return timeoutResult(seconds);
    }
    const pending = this.#live().prompt(text);
    let timer: NodeJS.Timeout | null = null;
    const expired = new Promise<"expired">(resolve => {
      timer = setTimeout(() => resolve("expired"), remaining);
    });
    try {
      const first = await Promise.race([pending, expired]);
      if (first !== "expired") return first;
      pending.catch(() => {});
      this.#hooks.event("step_timeout", { seconds });
      await this.stop();
      return timeoutResult(seconds);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #switch(choice: ModelChoice, index: number, event: "model_failover" | "model_tier"): Promise<void> {
    await this.#live().setModel(choice.provider, choice.model);
    const from = this.model;
    this.#model = choice;
    this.#modelIndex = index;
    this.#hooks.runnerChanged?.(this.#unit, this.model);
    this.#hooks.event(event, { from, to: this.model });
  }

  /** Arrête le runner (borné : stdin, signaux, puis l'arrêt forcé de son unité). */
  async stop(): Promise<void> {
    const runner = this.#runner;
    const unit = this.#unit;
    this.#runner = null;
    this.#unit = null;
    this.#prepaid = false;
    if (runner) {
      await stopRunner(this.#ctx.config, this.#ctx.exec, runner, unit);
      this.#hooks.event("runner_stopped", {});
    }
  }
}
