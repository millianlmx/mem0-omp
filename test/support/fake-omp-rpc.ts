// Un faux `omp --mode rpc` pour les tests du harness : le sous-ensemble du protocole
// v1 que le service parle (ready, set_host_tools, set_model, prompt → prompt_result,
// host_tool_call ↔ host_tool_result), piloté par un scénario JSON.
//
// Ce module n'est pas un fichier de test : le test le lance comme process enfant,
// à la place du binaire `omp`, avec les arguments que le service a construits.
//
// Scénario (FAKE_SCENARIO) : pour chaque étape (`req`, `specs`, `impl`, `review`, `audit`,
// `fix`), une liste d'OCCURRENCES ; chaque occurrence est une liste d'actions :
//   { "write": "chemin", "content": "…" }       écrit un fichier du worktree
//   { "tool": "nom", "args": { … } }            appelle un outil hôte et attend
//   { "error": { "message", "httpStatus" } }    termine le prompt en erreur
//   { "sleep": 60000 }                          attend (une étape qui dure)
// La dernière occurrence se répète. Le compteur d'occurrences vit dans FAKE_STATE
// (il survit aux process : un nouveau runner reprend la suite du scénario).
// Chaque prompt, appel d'outil et commande est journalisé en JSONL dans FAKE_LOG.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

type Action = {
  write?: string;
  content?: string;
  tool?: string;
  args?: Record<string, unknown>;
  error?: Record<string, unknown>;
  sleep?: number;
};

const scenario: Record<string, Action[][]> = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO as string, "utf8"));
const stateDir = process.env.FAKE_STATE as string;
const logFile = process.env.FAKE_LOG as string;

function log(entry: Record<string, unknown>): void {
  fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

function out(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function occurrence(step: string): Action[] {
  const file = path.join(stateDir, `${step}.count`);
  const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
  fs.writeFileSync(file, String(count + 1));
  const list = scenario[step] ?? [[]];
  return list[Math.min(count, list.length - 1)] ?? [];
}

function stepOf(message: string): string | null {
  const first = message.split("\n")[0] ?? "";
  if (first.startsWith("# /impl --fix")) return "fix";
  const match = /^# \/(req|specs|impl|review|audit)\b/.exec(first);
  return match ? (match[1] as string) : null;
}

const waiting = new Map<string, (text: string) => void>();
let toolSeq = 0;
let currentStep = "req";

log({
  kind: "argv",
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(
    [
      "MEM0_PROJECT_ID",
      "MEM0_AUTOSETUP",
      "MEM0_NUDGE",
      "MEM0_MODE",
      "MEM0_HTTP_URL",
      "MEM0_HTTP_TOKEN",
      "HARNESS_TOKEN",
    ].map((key) => [key, process.env[key] ?? null]),
  ),
  // Les clés de fournisseurs posées par les tests (préfixe `test-`) : jamais celles de la machine.
  keys: Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => key.endsWith("_API_KEY") && value?.startsWith("test-")),
  ),
});

function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const id = `fake-tool-${++toolSeq}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    out({ type: "host_tool_call", id, toolCallId: id, toolName: name, arguments: args });
  });
}

async function runPrompt(id: string, message: string): Promise<void> {
  const step = stepOf(message);
  if (step) currentStep = step;
  const nudge = message.startsWith("L'étape /");
  const actions = occurrence(nudge ? `${currentStep}-nudge` : currentStep);
  log({ kind: "prompt", step: currentStep, nudge, message });
  for (const action of actions) {
    if (action.sleep) await new Promise((resolve) => setTimeout(resolve, action.sleep));
    if (action.write) {
      fs.mkdirSync(path.dirname(action.write), { recursive: true });
      fs.writeFileSync(action.write, action.content ?? "");
    }
    if (action.tool) {
      const result = await callTool(action.tool, action.args ?? {});
      log({ kind: "tool", step: currentStep, tool: action.tool, result });
    }
    if (action.error) {
      out({
        type: "prompt_result",
        id,
        agentInvoked: true,
        status: "error",
        error: action.error,
        sessionSettled: true,
      });
      return;
    }
  }
  out({ type: "prompt_result", id, agentInvoked: true, status: "completed", sessionSettled: true });
}

out({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1 << 20,
  maxReassembledFrameBytes: 1 << 24,
});

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const frame = JSON.parse(line) as Record<string, unknown>;
  const id = typeof frame.id === "string" ? frame.id : "";
  switch (frame.type) {
    case "host_tool_result": {
      const result = frame.result as { content: { text: string }[] };
      waiting.get(id)?.(result.content.map((part) => part.text).join("\n"));
      waiting.delete(id);
      return;
    }
    case "set_host_tools":
      log({ kind: "command", type: frame.type, tools: (frame.tools as { name: string }[]).map((tool) => tool.name) });
      out({ id, type: "response", command: "set_host_tools", success: true, data: { toolNames: [] } });
      return;
    case "set_model":
      log({ kind: "command", type: frame.type, provider: frame.provider, modelId: frame.modelId });
      out({ id, type: "response", command: "set_model", success: true, data: {} });
      return;
    case "prompt":
      out({ id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
      void runPrompt(id, String(frame.message ?? ""));
      return;
    default:
      out({ id, type: "response", command: frame.type, success: true, data: {} });
  }
});
lines.on("close", () => process.exit(0));
