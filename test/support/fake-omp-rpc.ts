// Un faux `omp --mode rpc` pour les tests du harness : le sous-ensemble du protocole
// v1 que le service parle (ready, set_host_tools, set_model, prompt → prompt_result,
// steer, host_tool_call ↔ host_tool_result), piloté par un scénario JSON.
//
// Ce module n'est pas un fichier de test : le test le lance comme process enfant,
// à la place du binaire `omp`, avec les arguments que le service a construits.
//
// Scénario (FAKE_SCENARIO) : pour chaque étape (`req`, `specs`, `impl`, `review`, `audit`, `demande`,
// `pilote`, `fix`, `contradicteur`, `reve`, les jobs du poste `poste-profil`, `poste-digest`,
// `poste-service`, `poste-demande`, `poste-signal`, `poste-veille`, et les sessions de la vigie `vigie-triage`, `vigie-pilote`), une liste d'OCCURRENCES ; chaque occurrence est une liste d'actions :
//   { "write": "chemin", "content": "…" }       écrit un fichier du worktree
//   { "tool": "nom", "args": { … } }            appelle un outil hôte et attend
//   { "parallel": [{ "tool", "args" }, …] }     appelle ces outils hôtes ensemble (un tour à plusieurs outils)
//   { "error": { "message", "httpStatus" } }    termine le prompt en erreur
//   { "sleep": 60000 }                          attend (une étape qui dure)
//   { "frame": { "type": "…", … } }             émet une trame telle quelle (le direct de la session)
//   { "waitSteer": 15000 }                      attend un message de pilotage (`steer`), au plus ce délai
// Un message de pilotage (`steer`) est journalisé et accepté ; `"steer": "refuse"` au
// scénario le fait refuser (le runner ne prend pas la consigne).
// La dernière occurrence se répète. Le compteur d'occurrences vit dans FAKE_STATE
// (il survit aux process : un nouveau runner reprend la suite du scénario).
// La connexion OAuth (oauth.ts) : `loginProviders` est la liste que rend
// `get_login_providers` ; `login` ({ url, instructions, prompt, code, error }) dit le
// flux de `login` — `error` le refuse d'emblée, sinon `open_url`, une notification puis
// `input`, jusqu'à recevoir `code` (un `input` annulé est redemandé, comme omp).
// `stateModel` est le modèle que rend `get_state` (`{ input: ["text", "image"] }` : il lit les images).
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
  frame?: Record<string, unknown>;
  parallel?: { tool: string; args?: Record<string, unknown> }[];
  waitSteer?: number;
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
  const match =
    /^# \/(req|specs|impl|review|audit|demande|pilote|contradicteur|reve|poste-profil|poste-digest|poste-service|poste-demande|poste-signal|poste-veille|vigie-triage|vigie-pilote)\b/.exec(
      first,
    );
  return match ? (match[1] as string) : null;
}

const waiting = new Map<string, (text: string, isError: boolean) => void>();
type LoginScenario = { url?: string; instructions?: string; prompt?: string; code?: string; error?: string };
/** La commande `login` en cours et la demande d'`input` qu'elle attend. */
let login: { id: string; provider: string; inputId: string } | null = null;
let uiSeq = 0;

function askCode(): void {
  if (!login) return;
  login.inputId = `fake-ui-${++uiSeq}`;
  const flow = (scenario.login ?? {}) as LoginScenario;
  out({ type: "extension_ui_request", id: login.inputId, method: "input", title: flow.prompt ?? "Paste the code" });
}
let toolSeq = 0;
let currentStep = "req";
/** Le dernier `signalId` lu dans un prompt (la relance d'un nudge ne le répète pas). */
let signalIdOfStep: string | undefined;
/** Les messages de pilotage reçus et pas encore attendus par une action `waitSteer`. */
const steers: string[] = [];
let steered: (() => void) | null = null;

/** Attend un message de pilotage (ou `ms`) : rend celui reçu, ou `null` au délai. */
function nextSteer(ms: number): Promise<string | null> {
  if (steers.length > 0) return Promise.resolve(steers.shift() ?? null);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const timer = setTimeout(() => {
    steered = null;
    resolve(null);
  }, ms);
  steered = () => {
    clearTimeout(timer);
    steered = null;
    resolve(steers.shift() ?? null);
  };
  return promise;
}

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

function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const id = `fake-tool-${++toolSeq}`;
  return new Promise((resolve) => {
    waiting.set(id, (text, isError) => resolve({ text, isError }));
    out({ type: "host_tool_call", id, toolCallId: id, toolName: name, arguments: args });
  });
}

/** Le `signalId` cité dans le prompt d'un tri de signalement : un scénario statique l'écrit `$signalId`. */
function fill(value: unknown, signalId: string | undefined): unknown {
  if (value === "$signalId") return signalId ?? value;
  if (Array.isArray(value)) return value.map((item) => fill(item, signalId));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, signalId)]));
  return value;
}

async function runPrompt(id: string, message: string): Promise<void> {
  const step = stepOf(message);
  const signalId = /signalId: "([^"]+)"/.exec(message)?.[1] ?? signalIdOfStep;
  if (signalId) signalIdOfStep = signalId;
  if (step) currentStep = step;
  const nudge = message.startsWith("L'étape /");
  const actions = occurrence(nudge ? `${currentStep}-nudge` : currentStep);
  log({ kind: "prompt", step: currentStep, nudge, message });
  for (const action of actions) {
    if (action.sleep) await new Promise((resolve) => setTimeout(resolve, action.sleep));
    if (action.waitSteer) log({ kind: "steered", step: currentStep, message: await nextSteer(action.waitSteer) });
    if (action.frame) out(action.frame);
    if (action.write) {
      fs.mkdirSync(path.dirname(action.write), { recursive: true });
      fs.writeFileSync(action.write, action.content ?? "");
    }
    if (action.tool) {
      const { text, isError } = await callTool(
        action.tool,
        fill(action.args ?? {}, signalId) as Record<string, unknown>,
      );
      log({ kind: "tool", step: currentStep, tool: action.tool, result: text, ...(isError ? { isError: true } : {}) });
    }
    if (action.parallel) {
      const calls = action.parallel;
      const results = await Promise.all(
        calls.map((call) => callTool(call.tool, fill(call.args ?? {}, signalId) as Record<string, unknown>)),
      );
      for (const [i, call] of calls.entries()) {
        log({ kind: "tool", step: currentStep, tool: call.tool, result: results[i]?.text });
      }
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
      // Une image jointe (capture du poste) est journalisée par sa forme, jamais ses octets.
      const result = frame.result as { content: { type?: string; text?: string; mimeType?: string; data?: string }[] };
      waiting.get(id)?.(
        result.content
          .map((part) =>
            part.type === "image" ? `[image ${part.mimeType} ${String(part.data?.length ?? 0)}]` : (part.text ?? ""),
          )
          .join("\n"),
        frame.isError === true,
      );
      waiting.delete(id);
      return;
    }
    case "get_state":
      // `stateModel` du scénario : le modèle que rend `get_state` (`input` dit s'il lit les images).
      out({ id, type: "response", command: "get_state", success: true, data: { model: scenario.stateModel ?? null } });
      return;
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
    case "steer": {
      log({ kind: "command", type: frame.type, message: frame.message });
      steers.push(String(frame.message ?? ""));
      steered?.();
      // `"steer": "refuse"` dans le scénario : le runner refuse le pilotage (le service garde alors la consigne).
      if ((scenario as Record<string, unknown>).steer === "refuse")
        out({ id, type: "response", command: "steer", success: false, error: "steering refusé" });
      else out({ id, type: "response", command: "steer", success: true });
      return;
    }
    case "get_login_providers":
      log({ kind: "command", type: frame.type });
      out({
        id,
        type: "response",
        command: frame.type,
        success: true,
        data: { providers: scenario.loginProviders ?? [] },
      });
      return;
    case "login": {
      const flow = (scenario.login ?? {}) as LoginScenario;
      log({ kind: "command", type: frame.type, providerId: frame.providerId });
      if (flow.error) {
        out({ id, type: "response", command: "login", success: false, error: flow.error });
        return;
      }
      login = { id, provider: String(frame.providerId), inputId: "" };
      out({
        type: "extension_ui_request",
        id: `fake-ui-${++uiSeq}`,
        method: "open_url",
        url: flow.url ?? "https://example.com/oauth",
        instructions: flow.instructions ?? "",
      });
      out({
        type: "extension_ui_request",
        id: `fake-ui-${++uiSeq}`,
        method: "notify",
        message: "Waiting for browser authentication...",
      });
      askCode();
      return;
    }
    case "extension_ui_response": {
      log({ kind: "ui_response", id, value: frame.value ?? null, cancelled: frame.cancelled === true });
      if (!login || id !== login.inputId) return;
      if (frame.cancelled === true) {
        askCode();
        return;
      }
      const flow = (scenario.login ?? {}) as LoginScenario;
      const done = login;
      login = null;
      if (frame.value === flow.code)
        out({ id: done.id, type: "response", command: "login", success: true, data: { providerId: done.provider } });
      else
        out({ id: done.id, type: "response", command: "login", success: false, error: "Invalid authorization code" });
      return;
    }
    default:
      out({ id, type: "response", command: frame.type, success: true, data: {} });
  }
});
lines.on("close", () => process.exit(0));
