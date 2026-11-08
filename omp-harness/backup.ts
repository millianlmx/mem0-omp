// Les sauvegardes de la base du harness : runs, décisions, escalades et journal n'existent
// que dans `harness.sqlite`.
//
// Un instantané est un `VACUUM INTO` : une copie cohérente et compacte, prise sans
// arrêter le service (une transaction de lecture, WAL compris). Il est écrit à côté
// puis renommé (jamais un fichier à moitié écrit sous son nom final), en 0600 dans un
// dossier 0700 : il contient tout ce que contient la base. Deux sortes, gardées
// chacune à `keep` exemplaires : `periodique` (toutes les `intervalHours`) et
// `migration` (juste avant une migration du schéma d'une base qui en a déjà un).
//
// `backups.remote` copie chaque instantané hors de la machine (rclone, restic, scp…) :
// la commande reçoit son chemin, le chiffrement est l'affaire de l'outil. Chaque issue,
// locale ou distante, est rendue à `report` : un échec devient `backup_failed`.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BackupRemote, HarnessConfig } from "./config.ts";
import type { LogLine } from "./logger.ts";
import type { Exec } from "./proc.ts";

export type BackupKind = "periodique" | "migration";

/** L'issue d'une sauvegarde : l'instantané local, ou sa copie distante. */
export type BackupOutcome = {
  where: "local" | "remote";
  at: number;
  file: string | null;
  /** `null` : réussie ; sinon la raison de l'échec. */
  error: string | null;
};

/** `harness-<sorte>-<horodatage UTC>[-<suffixe>].sqlite` : l'ordre des noms est celui des dates. */
const NAME = /^harness-(periodique|migration)-(\d{8}T\d{6}\d{3}Z)(?:-[\w.-]+)?\.sqlite$/;

/** Le plus long délai d'un `setTimeout` (≈ 24,8 jours) : au-delà, Node le ramène à 1 ms. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:.]/g, "");
}

function stampTime(text: string): number {
  return Date.parse(text.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/, "$1-$2-$3T$4:$5:$6.$7Z"));
}

/** Les instantanés d'une sorte, du plus récent au plus ancien. */
export function listBackups(dir: string, kind: BackupKind): { file: string; at: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, match: NAME.exec(name) }))
    .filter((entry) => entry.match?.[1] === kind)
    .map((entry) => ({ file: path.join(dir, entry.name), at: stampTime(entry.match?.[2] ?? "") }))
    .sort((a, b) => b.at - a.at || b.file.localeCompare(a.file));
}

/** Prend un instantané de `db` dans `dir` ; rend son chemin. Lève si la copie échoue. */
export function snapshot(db: DatabaseSync, dir: string, kind: BackupKind, now = Date.now(), suffix = ""): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `harness-${kind}-${stamp(now)}${suffix ? `-${suffix}` : ""}.sqlite`);
  // `VACUUM INTO` refuse un fichier existant : un reste d'essai interrompu est retiré.
  const temp = `${file}.tmp`;
  fs.rmSync(temp, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(temp);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return file;
}

/** Ne garde que les `keep` instantanés les plus récents d'une sorte ; rend ceux retirés. */
export function pruneBackups(dir: string, kind: BackupKind, keep: number): string[] {
  const removed = listBackups(dir, kind)
    .slice(keep)
    .map((entry) => entry.file);
  for (const file of removed) fs.rmSync(file, { force: true });
  return removed;
}

/** La ligne de la copie distante : `{file}` et `{name}` remplacés ; sans `{file}`, le chemin en dernier. */
export function remoteArgs(command: readonly string[], file: string): { command: string; args: string[] } {
  const name = path.basename(file);
  const filled = command.map((arg) => arg.replaceAll("{file}", file).replaceAll("{name}", name));
  if (!command.some((arg) => arg.includes("{file}"))) filled.push(file);
  return { command: filled[0] as string, args: filled.slice(1) };
}

export type BackupsDeps = {
  db: DatabaseSync;
  dir: string;
  /** L'intervalle des instantanés périodiques ; `null` : aucun. */
  intervalHours: number | null;
  keep: number;
  log: LogLine;
  /** La copie hors machine de chaque instantané ; `null` ou absente : aucune. */
  remote?: BackupRemote | null;
  exec?: Exec;
  /** Chaque issue, réussie ou non (l'état de `GET /v1/status`, l'événement `backup_failed`). */
  report?: (outcome: BackupOutcome) => void;
};

/**
 * Les instantanés périodiques : le premier dès que le dernier existant a plus d'un
 * intervalle (un service souvent redémarré n'en prend donc pas un par démarrage),
 * puis un par intervalle. Un échec (disque plein, copie distante refusée) est
 * journalisé et rendu à `report`, jamais fatal.
 */
export class Backups {
  readonly #deps: BackupsDeps;
  #timer: NodeJS.Timeout | null = null;
  /** Les copies distantes en cours (un arrêt les attend). */
  readonly #copies = new Set<Promise<void>>();

  constructor(deps: BackupsDeps) {
    this.#deps = deps;
  }

  start(): void {
    const { intervalHours, dir } = this.#deps;
    if (intervalHours === null) return;
    const last = listBackups(dir, "periodique")[0]?.at ?? Number.NEGATIVE_INFINITY;
    this.#schedule(last + intervalHours * 3_600_000);
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Attend les copies distantes en cours. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#copies]);
  }

  /** Un instantané périodique tout de suite, puis l'élagage et sa copie distante ; `null` si la copie locale a échoué. */
  run(): string | null {
    const { db, dir, keep, log } = this.#deps;
    let file: string;
    try {
      file = snapshot(db, dir, "periodique");
      pruneBackups(dir, "periodique", keep);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`sauvegarde de la base échouée : ${reason}`, { level: "error", event: "backup_failed" });
      this.#deps.report?.({ where: "local", at: Date.now(), file: null, error: reason });
      return null;
    }
    this.#deps.report?.({ where: "local", at: Date.now(), file, error: null });
    this.copyRemote(file);
    return file;
  }

  /** La copie distante d'un instantané (`backups.remote`), en arrière-plan ; rien si elle n'est pas configurée. */
  copyRemote(file: string): void {
    const { remote, exec } = this.#deps;
    if (!remote || !exec) return;
    const { command, args } = remoteArgs(remote.command, file);
    const copy = exec(command, args, { timeoutMs: remote.timeoutSec * 1000, maxBytes: 4096 })
      .then(
        (result) =>
          result.code === 0
            ? null
            : result.timedOut
              ? `${command} : délai de ${remote.timeoutSec} s dépassé`
              : `${command} : code ${result.code ?? result.signal} — ${(result.stderr.trim() || result.stdout.trim()).slice(-300)}`,
        (err: unknown) => `${command} : ${err instanceof Error ? err.message : String(err)}`,
      )
      .then((error) => {
        if (error !== null)
          this.#deps.log(`copie distante de la sauvegarde échouée : ${error}`, {
            level: "error",
            event: "backup_failed",
          });
        this.#deps.report?.({ where: "remote", at: Date.now(), file, error });
      })
      .finally(() => this.#copies.delete(copy));
    this.#copies.add(copy);
  }

  /** Le prochain instantané à l'heure `due` ; un délai plus long que celui d'un timer est fait en plusieurs fois. */
  #schedule(due: number): void {
    const interval = (this.#deps.intervalHours ?? 0) * 3_600_000;
    this.#timer = setTimeout(
      () => {
        if (Date.now() < due) return this.#schedule(due);
        this.run();
        this.#schedule(Date.now() + interval);
      },
      Math.min(Math.max(0, due - Date.now()), MAX_TIMEOUT_MS),
    );
    this.#timer.unref?.();
  }
}

/** Le dossier des instantanés : `backups.dir`, sinon `<dataDir>/backups`. */
export function backupDir(config: Pick<HarnessConfig, "backups" | "dataDir">): string {
  return config.backups.dir ?? path.join(config.dataDir, "backups");
}
