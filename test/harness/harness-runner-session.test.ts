// Feature harness-runner-session : la session d'un runner face aux erreurs du
// fournisseur — bascule sur les causes de `runner.failoverOn` (rate limit, 5xx,
// réseau), attente `retry-after` puis réessai du même fournisseur quand la chaîne
// n'en a qu'un, cause exposée sur l'erreur rendue.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { HarnessContext } from "../../omp-harness/context.ts";
import type { SpawnRunner } from "../../omp-harness/context.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import type { EventType } from "../../omp-harness/events.ts";
import { Git } from "../../omp-harness/git.ts";
import { HeavyRunner } from "../../omp-harness/heavy.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { PromptError, RunnerProcess } from "../../omp-harness/rpc.ts";
import { RunnerSession, SAME_PROVIDER_RETRIES } from "../../omp-harness/runner-session.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { MemoryOracle, harnessRepo, testConfig } from "../support/harness-fixtures.ts";

/** Un faux runner en mémoire : chaque prompt reçoit la prochaine réponse du script (`null` : succès). */
function scriptedRunner(script: (PromptError | null)[]) {
  const prompts: string[] = [];
  const models: string[] = [];
  const spawn: SpawnRunner = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    stdin.setEncoding("utf8");
    stdin.on("end", () => events.emit("exit", 0, null));
    const out = (frame: object) => stdout.write(`${JSON.stringify(frame)}\n`);
    stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const frame: { id: string; type: string; message?: string; provider?: string; modelId?: string } = JSON.parse(line);
        if (frame.type === "set_host_tools") out({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
        if (frame.type === "set_model") {
          models.push(`${frame.provider}/${frame.modelId}`);
          out({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
        }
        if (frame.type === "prompt") {
          prompts.push(frame.message ?? "");
          out({ id: frame.id, type: "response", command: "prompt", success: true });
          const error = script.shift() ?? null;
          out(error ? { id: frame.id, type: "prompt_result", status: "error", error } : { id: frame.id, type: "prompt_result", status: "completed", error: null });
        }
      }
    });
    const proc: RunnerProcess = {
      pid: 1,
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => {
        events.emit("exit", null, "SIGTERM");
        return true;
      },
      once: (event, listener) => events.once(event, listener),
      on: (event, listener) => events.on(event, listener),
    };
    queueMicrotask(() => out({ type: "ready", protocolVersion: 1 }));
    return proc;
  };
  return { spawn, prompts, models };
}

function world(script: (PromptError | null)[], patch: (config: HarnessConfig) => void) {
  const repo = harnessRepo();
  const config = testConfig(repo, patch);
  const store = new Store(path.join(config.dataDir, "h.sqlite"));
  const scheduler = new Scheduler({
    runnerSlots: 5,
    heavySlots: 2,
    admission: config.admission,
    providers: config.providers,
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
  const git = new Git(execProcess, config.git);
  const heavy = new HeavyRunner({ config, store, scheduler, git, exec: execProcess });
  const runner = scriptedRunner(script);
  const ctx = new HarnessContext({ config, store, scheduler, git, heavy, oracle: new MemoryOracle(), spawn: runner.spawn, exec: execProcess });
  const events: { type: EventType; payload: Record<string, unknown> }[] = [];
  const sleeps: number[] = [];
  const repoConfig = config.repos[0];
  if (!repoConfig) throw new Error("dépôt de test absent");
  const session = new RunnerSession(
    ctx,
    { repo: repoConfig, cwd: repo },
    {
      onHostTool: async () => ({ text: "" }),
      event: (type, payload) => events.push({ type, payload }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  return { session, events, sleeps, runner, scheduler };
}

const far = () => Date.now() + 3_600_000;

test("harness-runner-session/AC-1 : un 5xx bascule sur le fournisseur suivant (set_model) comme un rate limit, et l'erreur finale porte sa cause", async () => {
  const w = world([{ message: "Internal Server Error", httpStatus: 503 }, null], (config) => {
    config.models = {
      fast: [],
      standard: [],
      heavy: [
        { provider: "alpha", model: "big" },
        { provider: "beta", model: "big2" },
      ],
    };
  });
  await w.session.open("heavy", "u1", new AbortController().signal);
  const result = await w.session.prompt("bonjour", new AbortController().signal, far());
  assert.equal(result.status, "completed");
  assert.deepEqual(w.runner.models, ["beta/big2"]);
  assert.equal(w.events.filter((e) => e.type === "provider_error").length, 1);
  assert.equal(w.events.filter((e) => e.type === "model_failover" && e.payload.to === "beta/big2").length, 1);
  assert.equal(w.runner.prompts.length, 2);
  assert.match(w.runner.prompts[1] ?? "", /Reprends exactement/);
  assert.equal(w.sleeps.length, 0, "un autre fournisseur était là : aucune attente");
  await w.session.stop();
});

test("harness-runner-session/AC-2 : une cause hors `failoverOn` (contexte, autre) est rendue telle quelle, avec sa cause, sans bascule ni attente", async () => {
  const w = world(
    [{ message: "prompt is too long: maximum context length" }, { message: "Internal Server Error", httpStatus: 500 }],
    (config) => {
      config.runner.failoverOn = ["rate_limit"];
      config.models = {
        fast: [],
        standard: [],
        heavy: [
          { provider: "alpha", model: "big" },
          { provider: "beta", model: "big2" },
        ],
      };
    },
  );
  await w.session.open("heavy", "u1", new AbortController().signal);
  const context = await w.session.prompt("a", new AbortController().signal, far());
  assert.equal(context.status, "error");
  assert.equal(context.error?.cause, "context");
  const server = await w.session.prompt("b", new AbortController().signal, far());
  assert.equal(server.error?.cause, "server_error");
  assert.deepEqual(w.runner.models, []);
  assert.deepEqual(w.sleeps, []);
  assert.equal(w.runner.prompts.length, 2);
  await w.session.stop();
});

test("harness-runner-session/AC-3 : chaîne à un seul fournisseur — attendre `retry-after` (sinon le refroidissement par défaut) puis réessayer le même, au plus 3 fois", async () => {
  const limited: PromptError = { message: "429 Too Many Requests", httpStatus: 429, details: { headers: { "retry-after": "7" } } };
  const w = world([limited, { message: "502 Bad Gateway" }, null], (config) => {
    config.models = { fast: [], standard: [], heavy: [{ provider: "alpha", model: "big" }] };
  });
  await w.session.open("heavy", "u1", new AbortController().signal);
  const result = await w.session.prompt("bonjour", new AbortController().signal, far());
  assert.equal(result.status, "completed");
  assert.deepEqual(w.sleeps, [7000, 60_000], "retry-after du fournisseur, puis le refroidissement par défaut");
  assert.deepEqual(w.runner.models, [], "jamais de set_model : même modèle");
  assert.equal(w.runner.prompts.length, 3);
  assert.equal(w.events.filter((e) => e.type === "provider_retry").length, 2);
  assert.deepEqual(
    w.events.filter((e) => e.type === "rate_limited").map((e) => e.payload.retryAfterMs),
    [7000],
  );
  await w.session.stop();

  // Au-delà de SAME_PROVIDER_RETRIES, l'erreur est rendue (classée) à l'étape.
  const always = Array.from({ length: SAME_PROVIDER_RETRIES + 1 }, () => ({ message: "fetch failed" }));
  const w2 = world(always, (config) => {
    config.models = { fast: [], standard: [], heavy: [{ provider: "alpha", model: "big" }] };
  });
  await w2.session.open("heavy", "u2", new AbortController().signal);
  const failed = await w2.session.prompt("bonjour", new AbortController().signal, far());
  assert.equal(failed.status, "error");
  assert.equal(failed.error?.cause, "network");
  assert.equal(w2.runner.prompts.length, SAME_PROVIDER_RETRIES + 1);
  assert.equal(w2.sleeps.length, SAME_PROVIDER_RETRIES);
  await w2.session.stop();
});

test("harness-runner-session/AC-4 : l'attente avant réessai est bornée par l'échéance de l'étape ; à l'échéance, l'erreur est rendue sans réessai", async () => {
  const w = world([{ message: "429", httpStatus: 429, details: { headers: { "retry-after": "600" } } }, null], (config) => {
    config.models = { fast: [], standard: [], heavy: [{ provider: "alpha", model: "big" }] };
  });
  await w.session.open("heavy", "u1", new AbortController().signal);
  const result = await w.session.prompt("bonjour", new AbortController().signal, Date.now() + 5_000);
  assert.equal(result.status, "completed");
  assert.equal(w.sleeps.length, 1);
  assert.ok((w.sleeps[0] ?? 0) <= 5_000, `attente bornée par l'échéance : ${w.sleeps[0]}`);
  await w.session.stop();
});
