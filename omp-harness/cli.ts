// La CLI de script du harness : lancer une feature et attendre sa fin depuis un shell ou une CI,
// sans app ni plugin (`node --experimental-strip-types omp-harness/cli.ts run … --wait --json`).
//
//   run    --repo <dépôt> --title <titre> (--request <texte> | --request -) [--lane full|direct]
//          [--priority n] [--budget usd] [--key <clé>] [--wait] [--timeout 90s|5m|2h] [--json]
//   status <runId> [--json]
//   wait   <runId> [--timeout …] [--json]
//   list   [--repo <dépôt>] [--json]
//
// Le contrat de sortie (README du harness, « La CLI de script ») est figé : le code de sortie dit
// où en est le run, `--json` rend UN objet sur stdout, y compris pour un échec. Le jeton ne passe
// jamais par un argument et n'est écrit nulle part. Aucune dépendance : node et `fetch`.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";
import { humanWaitOf } from "./machine.ts";
import type { HumanWait, RunState, StepKind } from "./machine.ts";

/** Les codes de sortie : un contrat pour les scripts, ils ne changent pas de sens. */
const EXIT = {
  delivered: 0,
  failed: 1,
  usage: 2,
  human: 3,
  timeout: 4,
  unreachable: 5,
} as const;

const USAGE = `usage : cli.ts <commande> [options]

  run    --repo <dépôt> --title <titre> (--request <texte> | --request -) [--lane full|direct]
         [--priority n] [--budget usd] [--key <clé>] [--wait] [--timeout 90s|5m|2h] [--json]
  status <runId> [--json]
  wait   <runId> [--timeout 90s|5m|2h] [--json]
  list   [--repo <dépôt>] [--json]

Connexion : HARNESS_URL et HARNESS_TOKEN, sinon ~/.omp/harness.json ({"url", "token"}).
Sortie : 0 livré · 1 échoué, annulé ou refusé · 2 ligne de commande fausse · 3 attend un humain
         4 délai d'attente dépassé · 5 serveur injoignable ou non configuré`;

/** Le plus gros corps que le serveur lit (omp-harness/http.ts, MAX_BODY) : au-delà il rend 413. */
const MAX_BODY_BYTES = 1024 * 1024;
/** Une réponse du serveur qui ne vient pas en 30 s est une panne réseau. */
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;
const DEFAULT_WAIT_MS = 30 * 60_000;
const DEFAULT_POLL_MS = 3000;
/** Les sondes d'une attente qui échouent de suite (réseau, 502/503/504) avant de renoncer. */
const MAX_MISSED_POLLS = 5;
/** Les statuts d'une passerelle ou d'un serveur qui redémarre : on relance, on ne conclut pas. */
const TRANSIENT_STATUSES: readonly number[] = [502, 503, 504];
const MAX_KEY_LENGTH = 200;

/** Une fin de commande : le code de sortie, les champs du JSON, les lignes de stdout et de stderr. */
type Result = { code: number; data: Record<string, unknown>; out: string[]; err: string[] };

/** Une fin anticipée : le message part sur stderr (ou dans `error` du JSON). */
class Stop extends Error {
  readonly code: number;
  readonly data: Record<string, unknown>;
  constructor(code: number, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const usageError = (message: string): Stop => new Stop(EXIT.usage, message);

type Connection = { url: string; token: string };

/** Le jeton, une fois connu : tout ce qui sort passe par `redact`. */
let secret = "";
const redact = (text: string): string => (secret === "" ? text : text.replaceAll(secret, "***"));

/**
 * Où et comment joindre le harness : `HARNESS_URL` / `HARNESS_TOKEN`, sinon `~/.omp/harness.json`
 * (`{url, token}`, le fichier qu'écrit `harness.sh pair` et que lisent le plugin et les apps ; même
 * lecture que `resolveTarget` d'omp-mem0-req/harness.ts, sans le dépôt). Le serveur est un dossier
 * à part : le plugin n'est pas importé.
 */
function connectionOf(
  env: Record<string, string | undefined> = process.env,
  home = os.homedir(),
): Connection | { refusal: string } {
  const file = path.join(home, ".omp", "harness.json");
  let stored: unknown = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* pas de fichier : l'environnement seul */
  }
  const storedUrl = field(stored, "url");
  const storedToken = field(stored, "token");
  const url = (env.HARNESS_URL ?? (typeof storedUrl === "string" ? storedUrl : "")).replace(/\/+$/, "");
  const token = env.HARNESS_TOKEN ?? (typeof storedToken === "string" ? storedToken : "");
  if (url === "" || token === "")
    return {
      refusal: `harness non configuré : pose HARNESS_URL et HARNESS_TOKEN, ou écris ${file} ({"url", "token"}).`,
    };
  if (!/^https?:\/\/\S+$/.test(url)) return { refusal: "harness non configuré : l'adresse doit être http(s)://…" };
  return { url, token };
}

/** `90s`, `5m`, `2h`, `250ms` ; un nombre seul vaut des secondes. Toujours > 0. */
function durationMs(value: string, option: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(match?.[2] ?? "s") as "ms" | "s" | "m" | "h"];
  const ms = match ? Number(match[1]) * factor : Number.NaN;
  if (!Number.isFinite(ms) || ms <= 0) throw usageError(`${option} : durée attendue (90s, 5m, 2h), reçu « ${value} »`);
  return Math.round(ms);
}

type RunInfo = {
  id: string;
  repo?: string;
  title?: string;
  state: RunState;
  step: StepKind | null;
  reason: string | null;
  prUrl?: string | null;
  mergeSha?: string | null;
};

type Question = {
  id: number;
  question: string;
  options: string[];
  recommended: string | null;
  status?: string;
};

/** Un champ d'une valeur JSON lue sans présumer de sa forme ; `undefined` si ce n'est pas un objet. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function isRunInfo(value: unknown): value is RunInfo {
  return typeof field(value, "id") === "string" && typeof field(value, "state") === "string";
}

function isQuestion(value: unknown): value is Question {
  return (
    typeof field(value, "id") === "number" &&
    typeof field(value, "question") === "string" &&
    Array.isArray(field(value, "options"))
  );
}

type RunReply = { run: RunInfo; escalations: Question[] };

type Reply = { status: number; body: unknown };

/** Un échange HTTP, sans relance : un échec réseau ou d'écriture de la réponse lève. */
async function once(
  conn: Connection,
  method: string,
  route: string,
  payload: string | undefined,
  extra: Record<string, string>,
): Promise<Reply> {
  const res = await fetch(`${conn.url}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      Accept: "application/json",
      // Une connexion par échange : rien ne reste ouvert après la sortie, et une sonde ne tombe pas sur une
      // connexion que le serveur a refermée en redémarrant.
      Connection: "close",
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extra,
    },
    ...(payload !== undefined ? { body: payload } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    /* corps non JSON : le statut parle seul */
  }
  return { status: res.status, body };
}

function errorOf(reply: Reply): string {
  const message = field(reply.body, "error");
  return typeof message === "string" ? message : `HTTP ${reply.status}`;
}

/**
 * Un appel avec UNE relance sur une erreur réseau ou un 502/503/504 (jamais sur un 4xx), avec les
 * mêmes en-têtes — donc la même `Idempotency-Key`. Sans réponse exploitable : exit 5.
 */
async function call(
  conn: Connection,
  method: string,
  route: string,
  payload?: string,
  extra: Record<string, string> = {},
): Promise<Reply> {
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      const reply = await once(conn, method, route, payload, extra);
      if (!TRANSIENT_STATUSES.includes(reply.status)) return reply;
      failure = `HTTP ${reply.status} (${errorOf(reply)})`;
    } catch (error) {
      failure = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
    }
  }
  throw new Stop(EXIT.unreachable, `serveur injoignable (${conn.url}) : ${failure}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Une réponse 2xx portant un run, ou la fin de commande qui dit pourquoi. */
function runOf(reply: Reply, action: string): RunReply {
  if (reply.status < 200 || reply.status >= 300)
    throw new Stop(EXIT.failed, `${action} refusé par le serveur (${reply.status}) : ${errorOf(reply)}`, {
      status: reply.status,
    });
  const run = field(reply.body, "run");
  if (!isRunInfo(run)) throw new Stop(EXIT.failed, `${action} : réponse du serveur inattendue (pas de run)`);
  const escalations = field(reply.body, "escalations");
  return {
    run: { ...run, step: run.step ?? null, reason: run.reason ?? null },
    escalations: Array.isArray(escalations) ? escalations.filter(isQuestion) : [],
  };
}

const WAIT_LABEL: Record<HumanWait | "questions", string> = {
  questions: "des questions à trancher",
  specs: "des specs à valider",
  irreversible: "des specs à valider (geste irréversible)",
  verdict: "un verdict à valider",
  arbitration: "un arbitrage entre revue et correction",
  budget: "un budget à accorder",
  failure: "une relance après un échec",
};

/**
 * Où en est un run, en code de sortie. `escalated` (questions ouvertes) et `awaiting_human` (specs,
 * verdict, arbitrage, budget, échec relançable ; `humanWaitOf` dit lequel) attendent l'humain, et
 * `run.reason` dit pourquoi. Un run encore en cours n'a pas de code : `null`.
 */
function outcomeOf(view: RunReply): Result | null {
  const { run } = view;
  const base = { runId: run.id, state: run.state, run };
  const line = renderRun(run);
  if (run.state === "merged")
    return { code: EXIT.delivered, data: { ...base, outcome: "delivered" }, out: line, err: [] };
  if (run.state === "failed" || run.state === "cancelled") {
    const error = `run ${run.id} ${run.state === "failed" ? "échoué" : "annulé"}${run.reason ? ` : ${run.reason}` : ""}`;
    return { code: EXIT.failed, data: { ...base, outcome: run.state, error }, out: line, err: [error] };
  }
  if (run.state !== "escalated" && run.state !== "awaiting_human") return null;
  const kind = run.state === "escalated" ? "questions" : (humanWaitOf(run) ?? "failure");
  const questions = view.escalations.filter((item) => item.status !== "answered");
  const reason = run.reason ?? WAIT_LABEL[kind];
  const error = `le run ${run.id} attend l'humain (${WAIT_LABEL[kind]}) : ${reason}`;
  return {
    code: EXIT.human,
    data: {
      ...base,
      outcome: "waiting_human",
      error,
      waiting: {
        kind,
        reason,
        ...(questions.length > 0
          ? {
              questions: questions.map(({ id, question, options, recommended }) => ({
                id,
                question,
                options,
                recommended: recommended ?? null,
              })),
            }
          : {}),
      },
    },
    out: line,
    err: [
      error,
      ...questions.map(
        (item) => `  ? ${item.question}${item.options.length > 0 ? ` [${item.options.join(" | ")}]` : ""}`,
      ),
    ],
  };
}

/** `<id> <état>`, puis la raison (sauf livré) et la PR : la première colonne se lit au shell. */
function renderRun(run: RunInfo): string[] {
  return [
    `${run.id} ${run.state}`,
    ...(run.state !== "merged" && run.reason ? [`  raison : ${run.reason}`] : []),
    ...(run.prUrl ? [`  PR : ${run.prUrl}`] : []),
  ];
}

/** Sonde `GET /v1/runs/{id}` jusqu'à une fin, une attente de l'humain ou le délai ; le run, lui, continue. */
async function waitFor(
  conn: Connection,
  runId: string,
  timeoutMs: number,
  pollMs: number,
  progress: (text: string) => void,
): Promise<Result> {
  const deadline = Date.now() + timeoutMs;
  let missed = 0;
  let shown = "";
  for (;;) {
    let view: RunReply | null = null;
    try {
      view = runOf(await call(conn, "GET", `/v1/runs/${encodeURIComponent(runId)}`), "lecture du run");
      missed = 0;
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      missed += 1;
      // Le run existe : toute fin anticipée dit son identifiant, pour qu'un `wait` le reprenne.
      if (error.code !== EXIT.unreachable || missed > MAX_MISSED_POLLS)
        throw new Stop(error.code, `${error.message} (run ${runId})`, { ...error.data, runId });
    }
    if (view !== null) {
      const done = outcomeOf(view);
      if (done !== null) return done;
      const now = `${view.run.state}${view.run.step ? ` (${view.run.step})` : ""}`;
      if (now !== shown) progress(`état : ${now}`);
      shown = now;
      if (Date.now() >= deadline) return timeoutResult(view.run, timeoutMs);
    } else if (Date.now() >= deadline) {
      throw new Stop(EXIT.unreachable, `serveur injoignable (${conn.url}) pendant l'attente du run ${runId}`);
    }
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
}

function timeoutResult(run: RunInfo, timeoutMs: number): Result {
  const error = `délai d'attente dépassé (${timeoutMs / 1000} s) : le run ${run.id} continue sur le serveur (état : ${run.state})`;
  return {
    code: EXIT.timeout,
    data: { runId: run.id, state: run.state, outcome: "timeout", error, run },
    out: renderRun(run),
    err: [error],
  };
}

const COMMON: ParseArgsOptionsConfig = { json: { type: "boolean" } };
const OPTIONS = {
  run: {
    ...COMMON,
    repo: { type: "string" },
    title: { type: "string" },
    request: { type: "string" },
    lane: { type: "string" },
    priority: { type: "string" },
    budget: { type: "string" },
    key: { type: "string" },
    wait: { type: "boolean" },
    timeout: { type: "string" },
    poll: { type: "string" },
  },
  status: { ...COMMON },
  wait: { ...COMMON, timeout: { type: "string" }, poll: { type: "string" } },
  list: { ...COMMON, repo: { type: "string" } },
} satisfies Record<string, ParseArgsOptionsConfig>;

type Command = keyof typeof OPTIONS;

function parse(command: Command, args: string[]): { values: Record<string, unknown>; positionals: string[] } {
  try {
    return parseArgs({ args, options: OPTIONS[command], allowPositionals: true, strict: true });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    const option = /'(--?[\w-]+)/.exec(message)?.[1] ?? "";
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw usageError(`option inconnue pour « ${command} » : ${option}`);
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") throw usageError(`${option} : valeur manquante`);
    throw usageError(message);
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** La demande lue sur stdin (`--request -`), bornée à ce que le serveur accepte. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > MAX_BODY_BYTES) throw usageError("demande trop grosse : 1 Mio au plus (la limite du serveur)");
    chunks.push(part);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function nonBlank(value: string | undefined, option: string): string {
  if (value === undefined || value.trim() === "") throw usageError(`${option} : valeur requise`);
  return value;
}

async function runCommand(conn: () => Connection, args: string[], progress: (text: string) => void): Promise<Result> {
  const { values, positionals } = parse("run", args);
  if (positionals.length > 0) throw usageError(`argument en trop : ${positionals[0]}`);
  const repo = nonBlank(str(values.repo), "--repo");
  const title = nonBlank(str(values.title), "--title");
  const requestArg = str(values.request);
  if (requestArg === undefined) throw usageError("--request : texte de la demande, ou - pour le lire sur stdin");
  const lane = str(values.lane);
  if (lane !== undefined && lane !== "full" && lane !== "direct") throw usageError('--lane : "full" ou "direct"');
  const priority = str(values.priority);
  if (priority !== undefined && !/^-?\d+$/.test(priority)) throw usageError("--priority : entier attendu");
  const budgetArg = str(values.budget);
  const budget = budgetArg === undefined ? undefined : Number(budgetArg);
  if (budget !== undefined && (budgetArg?.trim() === "" || !Number.isFinite(budget) || budget <= 0))
    throw usageError("--budget : montant en dollars attendu (> 0)");
  const key = str(values.key) ?? randomUUID();
  if (key.trim() === "" || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key))
    throw usageError(`--key : de 1 à ${MAX_KEY_LENGTH} caractères ASCII imprimables, sans espace`);
  const timeoutMs = values.timeout === undefined ? DEFAULT_WAIT_MS : durationMs(str(values.timeout) ?? "", "--timeout");
  const pollMs = values.poll === undefined ? DEFAULT_POLL_MS : durationMs(str(values.poll) ?? "", "--poll");
  if (values.wait !== true && values.timeout !== undefined) throw usageError("--timeout n'a de sens qu'avec --wait");

  const request = requestArg === "-" ? await readStdin() : requestArg;
  if (request.trim() === "") throw usageError("--request : demande vide");
  // `direct` est la voie que le serveur choisit seul quand la demande porte ses critères : seule `full` se force.
  const payload = JSON.stringify({
    repo,
    title,
    request,
    ...(lane === "full" ? { lane: "full" } : {}),
    ...(priority !== undefined ? { priority: Number(priority) } : {}),
    ...(budget !== undefined ? { budgetUsd: budget } : {}),
  });
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES)
    throw usageError("demande trop grosse : 1 Mio au plus (la limite du serveur)");

  const connection = conn();
  const created = runOf(await call(connection, "POST", "/v1/runs", payload, { "Idempotency-Key": key }), "lancement");
  if (values.wait !== true) {
    return {
      code: EXIT.delivered,
      data: { runId: created.run.id, state: created.run.state, outcome: "created", key, run: created.run },
      out: renderRun(created.run),
      err: [],
    };
  }
  progress(`run ${created.run.id} créé`);
  const done = await waitFor(connection, created.run.id, timeoutMs, pollMs, progress);
  return { ...done, data: { ...done.data, key } };
}

async function statusCommand(conn: () => Connection, args: string[]): Promise<Result> {
  const { positionals } = parse("status", args);
  const runId = oneRunId(positionals);
  const view = runOf(await call(conn(), "GET", `/v1/runs/${encodeURIComponent(runId)}`), "lecture du run");
  // Un run en cours n'est ni livré ni échoué : 4, « pas fini », comme `wait` qui n'attendrait pas.
  return (
    outcomeOf(view) ?? {
      code: EXIT.timeout,
      data: {
        runId,
        state: view.run.state,
        outcome: "running",
        error: `le run ${runId} n'est pas fini (état : ${view.run.state})`,
        run: view.run,
      },
      out: renderRun(view.run),
      err: [],
    }
  );
}

function oneRunId(positionals: string[]): string {
  if (positionals.length !== 1) throw usageError("un identifiant de run est attendu");
  return nonBlank(positionals[0], "runId");
}

async function waitCommand(conn: () => Connection, args: string[], progress: (text: string) => void): Promise<Result> {
  const { values, positionals } = parse("wait", args);
  const runId = oneRunId(positionals);
  const timeoutMs = values.timeout === undefined ? DEFAULT_WAIT_MS : durationMs(str(values.timeout) ?? "", "--timeout");
  const pollMs = values.poll === undefined ? DEFAULT_POLL_MS : durationMs(str(values.poll) ?? "", "--poll");
  return waitFor(conn(), runId, timeoutMs, pollMs, progress);
}

async function listCommand(conn: () => Connection, args: string[]): Promise<Result> {
  const { values, positionals } = parse("list", args);
  if (positionals.length > 0) throw usageError(`argument en trop : ${positionals[0]}`);
  const repo = str(values.repo);
  const reply = await call(conn(), "GET", `/v1/runs${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`);
  if (reply.status < 200 || reply.status >= 300)
    throw new Stop(EXIT.failed, `liste refusée par le serveur (${reply.status}) : ${errorOf(reply)}`, {
      status: reply.status,
    });
  const listed = field(reply.body, "runs");
  const runs = Array.isArray(listed) ? listed.filter(isRunInfo) : [];
  return {
    code: EXIT.delivered,
    data: { runs },
    out: runs.map((run) => `${run.id} ${run.state} ${run.repo ?? ""} ${run.title ?? ""}`.trimEnd()),
    err: [],
  };
}

/** Le résultat de la ligne de commande `args` ; `progress` reçoit les diagnostics de l'attente. */
async function execute(args: string[], progress: (text: string) => void): Promise<Result> {
  const [command = "", ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h")
    return { code: EXIT.delivered, data: { usage: USAGE }, out: [USAGE], err: [] };
  if (!(command in OPTIONS)) throw usageError(command === "" ? "commande attendue" : `commande inconnue : ${command}`);
  // La connexion n'est lue qu'une fois la ligne de commande jugée bonne : un usage faux ne dépend pas d'elle.
  let connection: Connection | undefined;
  const conn = (): Connection => {
    if (connection !== undefined) return connection;
    const found = connectionOf();
    if ("refusal" in found) throw new Stop(EXIT.unreachable, found.refusal);
    secret = found.token;
    connection = found;
    return found;
  };
  switch (command as Command) {
    case "run":
      return runCommand(conn, rest, progress);
    case "status":
      return statusCommand(conn, rest);
    case "wait":
      return waitCommand(conn, rest, progress);
    case "list":
      return listCommand(conn, rest);
  }
}

async function main(args: string[]): Promise<number> {
  // `--json` se lit avant l'analyse : même une option fausse rend alors son objet JSON.
  const json = args.includes("--json");
  const progress = (text: string): void => {
    if (!json) process.stderr.write(`${redact(text)}\n`);
  };
  let result: Result;
  try {
    result = await execute(args, progress);
  } catch (error) {
    if (error instanceof Stop) {
      result = {
        code: error.code,
        data: { ...error.data, error: error.message },
        out: [],
        err: error.code === EXIT.usage ? [error.message, USAGE] : [error.message],
      };
    } else {
      const message = `erreur inattendue : ${error instanceof Error ? error.message : String(error)}`;
      result = { code: EXIT.failed, data: { error: message }, out: [], err: [message] };
    }
  }
  if (json) {
    process.stdout.write(
      redact(`${JSON.stringify({ ok: result.code === EXIT.delivered, exitCode: result.code, ...result.data })}\n`),
    );
  } else {
    if (result.out.length > 0) process.stdout.write(redact(`${result.out.join("\n")}\n`));
    if (result.err.length > 0) process.stderr.write(redact(`${result.err.join("\n")}\n`));
  }
  return result.code;
}

process.exitCode = await main(process.argv.slice(2));
