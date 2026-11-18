// Le journal structuré du service (contrat C1) : une ligne JSON par événement, sur stderr
// et dans `<logs.dir>/<src>-AAAA-MM-JJ.jsonl` (jour UTC), les fichiers plus vieux que
// `logs.retentionDays` retirés au changement de jour.
//
//   {"ts":"<ISO8601>","level":"info","src":"harness","msg":"…","runId":"…","repo":"…","event":"…","err":{…}}
//
// `ctx.log(ligne)` reste la porte des pièces du service : une chaîne, et en second
// argument facultatif le niveau, le run et le dépôt quand ils sont connus.
import * as fs from "node:fs";
import * as path from "node:path";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogSource = "harness" | "mem0" | "vigie";

/** Ce qu'une ligne porte en plus de son message. */
export type LogFields = {
  level?: LogLevel;
  runId?: string | null;
  repo?: string | null;
  /** Le type d'événement du journal que la ligne accompagne (`backup_failed`, `client_error`…). */
  event?: string;
  err?: unknown;
};

/** La porte du journal des pièces du service (`ctx.log`). */
export type LogLine = (line: string, fields?: LogFields) => void;

export type LogRecord = {
  ts: string;
  level: LogLevel;
  src: LogSource;
  msg: string;
  runId?: string;
  repo?: string;
  event?: string;
  err?: { message: string; stack?: string };
};

/** Le motif des fichiers d'une source : `harness-2026-11-07.jsonl`. */
function fileName(src: LogSource, day: string): string {
  return `${src}-${day}.jsonl`;
}

/** L'erreur d'une ligne : son message et sa pile, jamais l'objet entier. */
function errorOf(err: unknown): LogRecord["err"] {
  if (err instanceof Error) return { message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { message: String(err) };
}

/** Une ligne C1 ; les champs absents ou nuls sont omis. */
export function logRecord(src: LogSource, msg: string, fields: LogFields = {}, now = Date.now()): LogRecord {
  return {
    ts: new Date(now).toISOString(),
    level: fields.level ?? "info",
    src,
    msg,
    ...(fields.runId ? { runId: fields.runId } : {}),
    ...(fields.repo ? { repo: fields.repo } : {}),
    ...(fields.event ? { event: fields.event } : {}),
    ...(fields.err !== undefined ? { err: errorOf(fields.err) } : {}),
  };
}

export type LoggerOptions = {
  src: LogSource;
  /** Le dossier des fichiers jsonl ; `null` : stderr seulement. */
  dir: string | null;
  retentionDays: number;
  /** Le niveau le plus bas écrit. */
  level?: LogLevel;
  /** La sortie de chaque ligne en plus du fichier (défaut : stderr, la ligne JSON). */
  stderr?: (record: LogRecord, json: string) => void;
  now?: () => number;
};

export class Logger {
  readonly #options: LoggerOptions;
  readonly #now: () => number;
  readonly #min: number;
  /** Le jour UTC du dernier fichier écrit : un nouveau jour élague les anciens. */
  #day: string | null = null;
  /** La dernière erreur d'écriture du fichier, dite une fois sur stderr (pas à chaque ligne). */
  #fileError: string | null = null;

  constructor(options: LoggerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#min = LOG_LEVELS.indexOf(options.level ?? "info");
  }

  /** `ctx.log` : une chaîne, et ce qu'on sait de son contexte. */
  readonly line: LogLine = (line, fields) => this.write(line, fields);

  debug(msg: string, fields: Omit<LogFields, "level"> = {}): void {
    this.write(msg, { ...fields, level: "debug" });
  }
  info(msg: string, fields: Omit<LogFields, "level"> = {}): void {
    this.write(msg, { ...fields, level: "info" });
  }
  warn(msg: string, fields: Omit<LogFields, "level"> = {}): void {
    this.write(msg, { ...fields, level: "warn" });
  }
  error(msg: string, fields: Omit<LogFields, "level"> = {}): void {
    this.write(msg, { ...fields, level: "error" });
  }

  write(msg: string, fields: LogFields = {}): void {
    if (LOG_LEVELS.indexOf(fields.level ?? "info") < this.#min) return;
    const record = logRecord(this.#options.src, msg, fields, this.#now());
    const json = JSON.stringify(record);
    const { dir, stderr } = this.#options;
    if (stderr) stderr(record, json);
    else process.stderr.write(`${json}\n`);
    if (dir === null) return;
    const day = record.ts.slice(0, 10);
    try {
      if (day !== this.#day) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.#day = day;
        this.prune();
      }
      fs.appendFileSync(path.join(dir, fileName(this.#options.src, day)), `${json}\n`, { mode: 0o600 });
      this.#fileError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.#fileError) {
        this.#fileError = message;
        process.stderr.write(
          `${JSON.stringify(logRecord(this.#options.src, `journal non écrit : ${message}`, { level: "error" }, this.#now()))}\n`,
        );
      }
    }
  }

  /** Retire les fichiers de cette source plus vieux que `retentionDays` jours ; rend ceux retirés. */
  prune(): string[] {
    const { dir, src, retentionDays } = this.#options;
    if (dir === null) return [];
    const oldest = new Date(this.#now() - retentionDays * 86_400_000).toISOString().slice(0, 10);
    const pattern = new RegExp(`^${src}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names) {
      const day = pattern.exec(name)?.[1];
      if (day === undefined || day >= oldest) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    }
    return removed;
  }
}

/** Le dossier des journaux : `logs.dir`, sinon `<dataDir>/logs`. */
export function logDir(config: { dataDir: string; logs: { dir: string | null } }): string {
  return config.logs.dir ?? path.join(config.dataDir, "logs");
}
