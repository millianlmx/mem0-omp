// Feature harness-rpc : le canal JSONL d'un runner `omp --mode rpc` — ready, requêtes
// corrélées, prompt → prompt_result, outils hôtes, dialogues annulés, mort du runner.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RpcRunner, classifyPromptError, isRateLimit, parseRetryAfter } from "../../omp-harness/rpc.ts";
import type { PromptError, PromptErrorCause, RunnerProcess } from "../../omp-harness/rpc.ts";

/** Un process factice : on écrit ses trames stdout, on lit ce que le runner lui envoie. */
function fakeProc(): {
  proc: RunnerProcess;
  emit: (frame: object) => void;
  sent: () => Record<string, unknown>[];
  exit: () => void;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = new EventEmitter();
  const lines: string[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)));
  const proc: RunnerProcess = {
    pid: 42,
    stdin,
    stdout,
    stderr,
    kill: () => {
      events.emit("exit", null, "SIGTERM");
      return true;
    },
    once: (event, listener) => events.once(event, listener),
    on: (event, listener) => events.on(event, listener),
  };
  return {
    proc,
    emit: (frame) => stdout.write(`${JSON.stringify(frame)}\n`),
    sent: () => lines.map((line) => JSON.parse(line)),
    exit: () => events.emit("exit", 1, null),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("harness-rpc/AC-1 : ready attendu, commandes corrélées par id, prompt résolu au prompt_result (pas à l'accusé)", async () => {
  const { proc, emit, sent } = fakeProc();
  const runner = new RpcRunner(proc, { onHostTool: async () => ({ text: "" }) });
  emit({ type: "ready", protocolVersion: 1 });
  await runner.ready(1000);
  const tools = runner.setHostTools([]);
  await tick();
  const setId = sent()[0]?.id;
  emit({ id: setId, type: "response", command: "set_host_tools", success: true, data: { toolNames: [] } });
  assert.deepEqual(await tools, { toolNames: [] });
  let settled = false;
  const prompt = runner.prompt("bonjour").then((result) => {
    settled = true;
    return result;
  });
  await tick();
  const promptId = sent()[1]?.id;
  assert.equal(sent()[1]?.type, "prompt");
  emit({ id: promptId, type: "response", command: "prompt", success: true });
  await tick();
  assert.equal(settled, false, "l'accusé ne termine pas le prompt");
  // Une ligne non JSON (bruit) est ignorée, une trame coupée en deux se recolle.
  proc.stdout?.emit("data", 'bruit\n{"type":"prompt_res');
  proc.stdout?.emit(
    "data",
    `ult","id":"${promptId}","status":"error","error":{"message":"429 rate limit","httpStatus":429}}\n`,
  );
  const result = await prompt;
  assert.equal(result.status, "error");
  assert.equal(isRateLimit(result.error), true);
});

test("harness-rpc/AC-2 : un host_tool_call est exécuté par le service et répondu par host_tool_result", async () => {
  const { proc, emit, sent } = fakeProc();
  const calls: string[] = [];
  new RpcRunner(proc, {
    onHostTool: async (name, args) => {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return name === "boom" ? Promise.reject(new Error("panne")) : { text: "VERT", details: { outcome: "pass" } };
    },
  });
  emit({ type: "host_tool_call", id: "c1", toolCallId: "t1", toolName: "run_tests", arguments: { scope: "touched" } });
  emit({ type: "host_tool_call", id: "c2", toolCallId: "t2", toolName: "boom", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['run_tests:{"scope":"touched"}', "boom:{}"]);
  const results = sent().filter((frame) => frame.type === "host_tool_result");
  assert.deepEqual(results[0], {
    type: "host_tool_result",
    id: "c1",
    result: { content: [{ type: "text", text: "VERT" }], details: { outcome: "pass" } },
  });
  assert.equal(results[1]?.isError, true);
});

test("harness-rpc/AC-3 : un dialogue bloquant est annulé (aucun humain dans un runner) ; un dialogue informatif est ignoré", async () => {
  const { proc, emit, sent } = fakeProc();
  new RpcRunner(proc, { onHostTool: async () => ({ text: "" }) });
  emit({ type: "extension_ui_request", id: "u1", method: "select", title: "?", options: ["a"] });
  emit({ type: "extension_ui_request", id: "u2", method: "notify", message: "info" });
  await tick();
  assert.deepEqual(sent(), [{ type: "extension_ui_response", id: "u1", cancelled: true }]);
});

test("harness-rpc/AC-4 : la mort du runner rejette toutes les attentes en vol", async () => {
  const { proc, exit } = fakeProc();
  const runner = new RpcRunner(proc, { onHostTool: async () => ({ text: "" }) });
  const prompt = runner.prompt("x");
  exit();
  await assert.rejects(prompt, /runner arrêté/);
  await assert.rejects(runner.ready(100), /runner arrêté/);
  assert.equal(runner.alive, false);
  await assert.rejects(runner.setModel("p", "m"), /runner arrêté/);
});

test("harness-rpc/AC-5 : un runner qu'on ne peut pas signaler (lancé par sudo) est arrêté par son unité, et l'arrêt reste borné", async () => {
  const stdin = new PassThrough();
  const events = new EventEmitter();
  let forced = 0;
  const proc: RunnerProcess = {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      events.emit("error", new Error("kill EPERM"));
      throw new Error("kill EPERM");
    },
    once: (event, listener) => events.once(event, listener),
    on: (event, listener) => events.on(event, listener),
  };
  const runner = new RpcRunner(proc, { onHostTool: async () => ({ text: "" }) });
  await runner.stop(20, async () => {
    forced++;
    events.emit("exit", null, "SIGKILL");
  });
  assert.equal(forced, 1, "l'arrêt passe par l'unité systemd");
  assert.equal(runner.alive, false);
  // Un process qui ne sort jamais : l'arrêt rend quand même la main.
  const stuck = fakeProc();
  const hung = new RpcRunner({ ...stuck.proc, kill: () => true }, { onHostTool: async () => ({ text: "" }) });
  await hung.stop(10);
  assert.equal(hung.alive, false);
});

test("harness-rpc/AC-6 : la cause d'une erreur de prompt se lit sur le statut puis sur le message — rate limit, 5xx, réseau, contexte, autre", () => {
  const cases: [PromptError | null, PromptErrorCause][] = [
    [{ message: "429 Too Many Requests", httpStatus: 429 }, "rate_limit"],
    [{ message: "You have hit your usage limit for this period" }, "rate_limit"],
    [{ message: "Internal Server Error", httpStatus: 503 }, "server_error"],
    [{ message: "502 Bad Gateway" }, "server_error"],
    [{ message: "fetch failed: ECONNRESET" }, "network"],
    [{ message: "TypeError: fetch failed" }, "network"],
    [{ message: "socket hang up" }, "network"],
    [{ message: "prompt is too long: 213000 tokens > 200000 maximum context length" }, "context"],
    [{ message: "input exceeds the maximum context window", httpStatus: 400 }, "context"],
    [{ message: "Go model requires Global regions" }, "other"],
    [{ message: "invalid api key", httpStatus: 401 }, "other"],
    [null, "other"],
  ];
  for (const [error, cause] of cases) assert.equal(classifyPromptError(error), cause, JSON.stringify(error));
  // Une erreur de contexte prime sur un 5xx : relancer tel quel ne sert à rien.
  assert.equal(classifyPromptError({ message: "maximum context length exceeded", httpStatus: 500 }), "context");
  assert.equal(isRateLimit({ message: "overloaded_error", httpStatus: 529 }), true);
});

test("harness-rpc/AC-7 : `retry-after` se lit dans les détails (en-tête en secondes ou date HTTP, retryAfter du corps) ou dans le message ; sinon null", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  assert.equal(parseRetryAfter({ message: "429", details: { headers: { "retry-after": "30" } } }, now), 30_000);
  assert.equal(
    parseRetryAfter({ message: "429", details: { headers: { "Retry-After": "Wed, 22 Oct 2026 10:00:45 GMT" } } }, now),
    45_000,
  );
  assert.equal(parseRetryAfter({ message: "429", details: { body: { error: { retryAfter: 12 } } } }, now), 12_000);
  assert.equal(parseRetryAfter({ message: "429", details: { retryAfterMs: 1500 } }, now), 1500);
  assert.equal(parseRetryAfter({ message: "Rate limit reached. Please retry after 20 seconds." }, now), 20_000);
  assert.equal(parseRetryAfter({ message: "Too many requests, try again in 2 min" }, now), 120_000);
  assert.equal(parseRetryAfter({ message: "rate limited, retry in 750ms" }, now), 750);
  assert.equal(parseRetryAfter({ message: "429 Too Many Requests" }, now), null);
  assert.equal(
    parseRetryAfter({ message: "429", retryAfterMs: 9000, details: { headers: { "retry-after": "1" } } }, now),
    9000,
    "une valeur déjà posée prime",
  );
  assert.equal(parseRetryAfter(null, now), null);
});
