// Feature harness-rpc : le canal JSONL d'un runner `omp --mode rpc` — ready, requêtes
// corrélées, prompt → prompt_result, outils hôtes, dialogues annulés, mort du runner.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RpcRunner, isRateLimit } from "../../omp-harness/rpc.ts";
import type { RunnerProcess } from "../../omp-harness/rpc.ts";


/** Un process factice : on écrit ses trames stdout, on lit ce que le runner lui envoie. */
function fakeProc(): { proc: RunnerProcess; emit: (frame: object) => void; sent: () => Record<string, unknown>[]; exit: () => void } {
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
  };
  return { proc, emit: frame => stdout.write(`${JSON.stringify(frame)}\n`), sent: () => lines.map(line => JSON.parse(line)), exit: () => events.emit("exit", 1, null) };
}

const tick = () => new Promise(resolve => setImmediate(resolve));


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
  const prompt = runner.prompt("bonjour").then(result => {
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
  proc.stdout?.emit("data", "bruit\n{\"type\":\"prompt_res");
  proc.stdout?.emit("data", `ult","id":"${promptId}","status":"error","error":{"message":"429 rate limit","httpStatus":429}}\n`);
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
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['run_tests:{"scope":"touched"}', "boom:{}"]);
  const results = sent().filter(frame => frame.type === "host_tool_result");
  assert.deepEqual(results[0], { type: "host_tool_result", id: "c1", result: { content: [{ type: "text", text: "VERT" }], details: { outcome: "pass" } } });
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
