// Les sauvegardes de la base du harness : runs, décisions, escalades et journal n'existent
// que dans `harness.sqlite`.
//
// Un instantané est un `VACUUM INTO` : une copie cohérente et compacte, prise sans
// arrêter le service (une transaction de lecture, WAL compris). Il est écrit à côté
// puis renommé (jamais un fichier à moitié écrit sous son nom final), en 0600 dans un
// dossier 0700 : il contient tout ce que contient la base. Deux sortes, gardées
// chacune à `keep` exemplaires : `periodique` (toutes les `intervalHours`) et
// `migration` (juste avant une migration du schéma d'une base qui en a déjà un).
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HarnessConfig } from "./config.ts";

export type BackupKind = "periodique" | "migration";

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

export type BackupsDeps = {
  db: DatabaseSync;
  dir: string;
  /** L'intervalle des instantanés périodiques ; `null` : aucun. */
  intervalHours: number | null;
  keep: number;
  log: (line: string) => void;
};

/**
 * Les instantanés périodiques : le premier dès que le dernier existant a plus d'un
 * intervalle (un service souvent redémarré n'en prend donc pas un par démarrage),
 * puis un par intervalle. Un échec (disque plein) est journalisé, jamais fatal.
 */
export class Backups {
  readonly #deps: BackupsDeps;
  #timer: NodeJS.Timeout | null = null;

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

  /** Un instantané périodique tout de suite, puis l'élagage ; `null` si la copie a échoué. */
  run(): string | null {
    const { db, dir, keep, log } = this.#deps;
    try {
      const file = snapshot(db, dir, "periodique");
      pruneBackups(dir, "periodique", keep);
      return file;
    } catch (err) {
      log(`sauvegarde de la base échouée : ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
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
