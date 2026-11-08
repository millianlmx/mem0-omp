// Ce que la vigie relève, en fonctions pures : un événement du journal (flux SSE), une
// ligne de journal structuré (contrat C1, `<dataDir>/logs/<src>-AAAA-MM-JJ.jsonl`), la
// santé et l'état du harness, l'état de la CI de `main`. Chaque fonction rend un signal
// (vigie/fingerprint.ts) avec son instant, son dépôt, son run et un contexte court, ou
// `null` : rien à relever.
//
// Du poste de travail, la vigie ne lit que des MÉTADONNÉES (le type et l'état d'une
// action) : ni page, ni texte, ni destinataire. Une erreur de client (contrat C2) garde sa
// source, sa version, son type et son message, jamais son `context`.
import * as path from "node:path";
import type { EventRow } from "../db.ts";
import type { Signal } from "./fingerprint.ts";
import { record, textOf as text } from "./json.ts";

/** Un signal relevé, prêt à devenir une occurrence d'incident. */
export type Observed = Signal & {
  at: number;
  repo: string | null;
  runId: string | null;
  context: string;
};

/** Une ligne du journal structuré (contrat C1). */
export type LogLine = {
  ts: string;
  at: number;
  level: "debug" | "info" | "warn" | "error";
  src: string;
  msg: string;
  runId?: string;
  repo?: string;
  event?: string;
  err?: { message: string; stack?: string };
};

const LEVELS = ["debug", "info", "warn", "error"] as const;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Une ligne JSONL du journal structuré, ou `null` si elle n'est pas au contrat C1. */
export function parseLogLine(raw: string): LogLine | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const line = record(value);
  const ts = line.ts;
  const at = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  const level = LEVELS.find((candidate) => candidate === line.level);
  if (typeof ts !== "string" || !Number.isFinite(at) || level === undefined) return null;
  if (typeof line.src !== "string" || typeof line.msg !== "string") return null;
  const err = record(line.err);
  return {
    ts,
    at,
    level,
    src: line.src,
    msg: line.msg,
    ...(typeof line.runId === "string" ? { runId: line.runId } : {}),
    ...(typeof line.repo === "string" ? { repo: line.repo } : {}),
    ...(typeof line.event === "string" ? { event: line.event } : {}),
    ...(typeof err.message === "string"
      ? { err: { message: err.message, ...(typeof err.stack === "string" ? { stack: err.stack } : {}) } }
      : {}),
  };
}

/**
 * L'emplacement d'une pile : la première trame hors de node, en `dossier/fichier.ts (fonction)`
 * — sans numéro de ligne, qui bouge d'un commit à l'autre.
 */
export function stackLocation(stack: string): string | null {
  for (const line of stack.split("\n")) {
    const frame = /^\s*at (?:(.+?) \()?(?:file:\/\/)?([^()\s]+?):\d+:\d+\)?\s*$/.exec(line);
    if (!frame) continue;
    const file = frame[2] as string;
    if (file.startsWith("node:") || file.includes("node_modules")) continue;
    const short = file.split(path.sep).join("/").split("/").slice(-2).join("/");
    return frame[1] ? `${short} (${frame[1]})` : short;
  }
  return null;
}

/** Une ligne `warn` ou `error` du journal structuré ; les autres sont du contexte, pas des signaux. */
export function signalOfLogLine(line: LogLine): Observed | null {
  if (line.level !== "warn" && line.level !== "error") return null;
  // La vigie ne se relève pas elle-même : une boucle de signaux sur ses propres plaintes.
  if (line.src === "vigie") return null;
  const location = line.event ?? (line.err?.stack ? stackLocation(line.err.stack) : null) ?? "journal";
  const message = line.err?.message ? `${line.msg} — ${line.err.message}` : line.msg;
  return {
    source: `log:${line.src}`,
    location,
    message: clip(message, 2000),
    at: line.at,
    repo: line.repo ?? null,
    runId: line.runId ?? null,
    context: clip(
      `[${line.level}] ${line.ts} ${line.src} : ${line.msg}${line.err?.stack ? `\n${line.err.stack}` : ""}`,
      4000,
    ),
  };
}

/** Un événement du journal du harness qui dit un dysfonctionnement ; le reste n'est que du contexte. */
export function signalOfEvent(event: EventRow): Observed | null {
  const payload = event.payload;
  const base = { at: event.at, repo: event.repo, runId: event.runId };
  switch (event.type) {
    case "run_failed":
      return {
        ...base,
        source: "run",
        location: `étape ${text(payload.step) || "?"} (${text(payload.cause) || "cause inconnue"})`,
        message: clip(text(payload.reason) || "run échoué", 2000),
        context: `run ${event.runId ?? "?"} échoué à l'étape ${text(payload.step) || "?"}`,
      };
    case "push_failed":
      return {
        ...base,
        source: "git",
        location: payload.revert === true ? "push du revert" : "push de main",
        message: clip(text(payload.detail) || "push refusé", 2000),
        context: `push refusé pour le run ${event.runId ?? "?"}`,
      };
    case "revert_failed":
      return {
        ...base,
        source: "git",
        location: "revert",
        message: clip(text(payload.reason) || "revert impossible", 2000),
        context: `revert impossible pour le run ${event.runId ?? "?"}`,
      };
    case "notify_failed":
      return {
        ...base,
        source: "harness",
        location: "notifications",
        message: clip(text(payload.detail) || "notification perdue", 2000),
        context: "une notification sortante (ntfy) n'est pas partie",
      };
    case "client_error": {
      // Contrat C2 : la source, la version, le type et le message ; le `context` d'un client n'est jamais lu.
      const source = text(payload.source) || "client";
      return {
        ...base,
        source: `client:${source}`,
        location: text(payload.kind) || "erreur",
        message: clip(text(payload.message) || "erreur du client", 2000),
        context: `erreur du client ${source} ${text(payload.version)}`.trim(),
      };
    }
    case "workstation_action": {
      // Le poste : métadonnées seulement (type et état de l'action), jamais son contenu.
      if (payload.state !== "failed") return null;
      const kind = text(payload.kind) || "action";
      return {
        ...base,
        source: "poste",
        location: `action ${kind}`,
        message: `une action ${kind} du poste a échoué`,
        context: `action #${typeof payload.seq === "number" ? payload.seq : "?"} (${kind}, origine ${text(payload.origin) || "?"}) en échec`,
      };
    }
    default:
      return null;
  }
}

/** `GET /v1/health` qui répond, mais pas `ok` : les vérifications en échec. */
export function signalOfHealth(body: Record<string, unknown>, at: number): Observed | null {
  if (body.ok === true) return null;
  const checks = record(body.checks);
  const failing = Object.entries(checks)
    .filter(([, check]) => record(check).ok === false)
    .map(([name]) => name)
    .sort();
  const names = failing.join(", ") || "inconnues";
  return {
    source: "health",
    location: `vérifications ${names}`,
    message: `GET /v1/health en échec : ${names}`,
    at,
    repo: null,
    runId: null,
    context: clip(JSON.stringify(checks), 2000),
  };
}

/** Les écritures perdues de la mémoire déjà vues : seule une hausse est un signal. */
export function signalsOfStatus(
  body: Record<string, unknown>,
  lostBefore: number,
  at: number,
): {
  signals: Observed[];
  lost: number;
} {
  const signals: Observed[] = [];
  const oracle = record(body.oracle);
  const lostWrites = record(oracle.lostWrites);
  const lost = typeof lostWrites.count === "number" ? lostWrites.count : lostBefore;
  const base = { at, repo: null, runId: null };
  if (lost > lostBefore)
    signals.push({
      ...base,
      source: "memory",
      location: "oracle.lostWrites",
      message: `écritures de la mémoire perdues : ${text(lostWrites.lastError) || "cause inconnue"}`,
      context: `${lost - lostBefore} écriture(s) perdue(s) de plus (${lost} depuis le démarrage du harness)`,
    });
  if (oracle.configured === true && oracle.ok === false)
    signals.push({
      ...base,
      source: "memory",
      location: "oracle",
      message: "la mémoire du projet (mem0-rs) ne répond pas au harness",
      context: "GET /v1/status : oracle.ok = false",
    });
  const memory = record(body.memory);
  if (memory.ok === false)
    signals.push({
      ...base,
      source: "memory",
      location: "memory",
      message: `la mémoire est en échec : ${text(memory.error) || "cause inconnue"}`,
      context: clip(JSON.stringify(memory), 2000),
    });
  return { signals, lost };
}

/** Un run de workflow GitHub Actions (API REST, `GET /repos/{slug}/actions/runs`). */
export type CiRun = {
  name: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
  createdAt: string;
};

const RED: Record<string, true> = { failure: true, timed_out: true, startup_failure: true };

/** Le dernier run terminé de chaque workflow de `main` : rouge, c'est un signal. */
export function signalsOfCi(slug: string, runs: readonly CiRun[], at: number): Observed[] {
  const latest = new Map<string, CiRun>();
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (run.status !== "completed" || latest.has(run.name)) continue;
    latest.set(run.name, run);
  }
  return [...latest.values()]
    .filter((run) => run.conclusion !== null && RED[run.conclusion] === true)
    .map((run) => ({
      source: "ci",
      location: `${slug} · ${run.name}`,
      message: `CI rouge sur main : ${run.name} (${run.conclusion})`,
      at,
      repo: null,
      runId: null,
      context: `${run.htmlUrl} — commit ${run.headSha.slice(0, 12)}`,
    }));
}
