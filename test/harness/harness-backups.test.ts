// Feature harness-backups : la base du harness (runs, décisions, escalades, journal)
// est copiée par `VACUUM INTO` — un instantané par jour par défaut, les 7 derniers
// gardés, et un juste avant chaque migration du schéma d'une base existante.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backups, backupDir, listBackups, pruneBackups, snapshot } from "../../omp-harness/backup.ts";
import { defaultConfig, loadConfig } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { MIGRATIONS, Store } from "../../omp-harness/db.ts";
import { startHarness } from "../../omp-harness/main.ts";
import { waitFor } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

/** Une base du harness avec un run : ce qu'une sauvegarde doit rendre. */
function storeWithRun(dir: string): Store {
  const store = new Store(path.join(dir, "harness.sqlite"));
  store.createRun({
    id: "r-1",
    repo: "demo",
    slug: "sauve",
    title: "À sauver",
    request: "x",
    branch: "harness/sauve",
    state: "queued",
  });
  return store;
}

/** Une configuration de service sans dépôt ni systemd, sur un dossier neuf. */
function serviceConfig(patch: (config: HarnessConfig) => void = () => {}): HarnessConfig {
  const config = defaultConfig(tmpdir("harness-backups-"));
  config.listen.port = 0;
  config.runner.isolation = "none";
  config.heavy.isolation = "none";
  patch(config);
  return config;
}

/** Une base laissée par une version précédente : le schéma moins sa dernière migration. */
function previousVersionDb(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  const from = MIGRATIONS.length - 1;
  for (const migration of MIGRATIONS.slice(0, from)) db.exec(migration);
  db.exec(`PRAGMA user_version = ${from}`);
  db.close();
  return from;
}

test("harness-backups/AC-1 : un instantané est une copie cohérente qui se rouvre telle quelle — fichier 0600 dans un dossier 0700, aucun reste temporaire", () => {
  const dir = tmpdir("harness-backups-");
  const store = storeWithRun(dir);
  const backups = path.join(dir, "backups");
  const file = snapshot(store.db, backups, "periodique");
  store.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(backups).mode & 0o777, 0o700);
  assert.deepEqual(
    fs.readdirSync(backups).filter((name) => name.endsWith(".tmp")),
    [],
  );
  // La restauration documentée : la copie prend la place de harness.sqlite.
  const restored = path.join(tmpdir("harness-restore-"), "harness.sqlite");
  fs.copyFileSync(file, restored);
  const reopened = new Store(restored);
  try {
    assert.equal(reopened.getRun("r-1")?.title, "À sauver");
    assert.equal(reopened.schemaVersion, MIGRATIONS.length);
  } finally {
    reopened.close();
  }
});

test("harness-backups/AC-2 : l'élagage garde les `keep` instantanés les plus récents de chaque sorte, sans toucher à l'autre sorte ni aux fichiers étrangers", () => {
  const dir = tmpdir("harness-backups-");
  const store = storeWithRun(dir);
  const backups = path.join(dir, "backups");
  const day = 86_400_000;
  const periodic = [1, 2, 3, 4].map((n) => snapshot(store.db, backups, "periodique", Date.UTC(2026, 0, n)));
  const before = snapshot(store.db, backups, "migration", Date.UTC(2026, 0, 1) - day, "v3");
  fs.writeFileSync(path.join(backups, "notes.txt"), "à moi");
  store.close();
  const removed = pruneBackups(backups, "periodique", 2);
  assert.deepEqual(removed.sort(), periodic.slice(0, 2).sort(), "les deux plus anciens partent");
  assert.deepEqual(
    listBackups(backups, "periodique").map((entry) => entry.file),
    [periodic[3], periodic[2]],
    "du plus récent au plus ancien",
  );
  assert.ok(fs.existsSync(before), "l'instantané d'avant migration est d'une autre sorte");
  assert.ok(fs.existsSync(path.join(backups, "notes.txt")));
});

test("harness-backups/AC-3 : le premier instantané périodique part dès le démarrage s'il n'y en a pas d'assez récent ; un récent le repousse, `intervalHours: null` les coupe", async () => {
  const dir = tmpdir("harness-backups-");
  const store = storeWithRun(dir);
  const log: string[] = [];
  try {
    const fresh = path.join(dir, "neuf");
    const first = new Backups({ db: store.db, dir: fresh, intervalHours: 24, keep: 7, log: (l) => log.push(l) });
    first.start();
    try {
      await waitFor(
        () => listBackups(fresh, "periodique").length === 1,
        () => "aucun instantané",
      );
    } finally {
      first.stop();
    }

    const recent = path.join(dir, "recent");
    snapshot(store.db, recent, "periodique", Date.now() - 3_600_000);
    const second = new Backups({ db: store.db, dir: recent, intervalHours: 24, keep: 7, log: (l) => log.push(l) });
    second.start();
    const off = path.join(dir, "coupe");
    const third = new Backups({ db: store.db, dir: off, intervalHours: null, keep: 7, log: (l) => log.push(l) });
    third.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    second.stop();
    third.stop();
    assert.equal(listBackups(recent, "periodique").length, 1, "le dernier a une heure : rien de plus");
    assert.equal(fs.existsSync(off), false);
    assert.deepEqual(log, []);
  } finally {
    store.close();
  }
});

test("harness-backups/AC-4 : un instantané qui échoue est journalisé sans arrêter le service", () => {
  const dir = tmpdir("harness-backups-");
  const store = storeWithRun(dir);
  // Un fichier à la place du dossier : la copie ne peut pas s'écrire.
  const blocked = path.join(dir, "bloque");
  fs.writeFileSync(blocked, "");
  const log: string[] = [];
  try {
    const backups = new Backups({ db: store.db, dir: blocked, intervalHours: 24, keep: 7, log: (l) => log.push(l) });
    assert.equal(backups.run(), null);
    assert.match(log.join("\n"), /sauvegarde de la base échouée/);
  } finally {
    store.close();
  }
});

test("harness-backups/AC-5 : le service démarré copie la base avant de migrer un schéma existant — la copie garde l'ancienne version ; une base neuve ou `beforeMigration: false` n'en prend pas", async () => {
  const config = serviceConfig((c) => (c.backups.intervalHours = null));
  const from = previousVersionDb(path.join(config.dataDir, "harness.sqlite"));
  const harness = await startHarness(config, { token: "t".repeat(64), log: () => {} });
  try {
    assert.equal(harness.store.schemaVersion, MIGRATIONS.length, "la migration est passée");
  } finally {
    await harness.stop();
  }
  const copies = listBackups(backupDir(config), "migration");
  assert.equal(copies.length, 1);
  assert.match(path.basename(copies[0]?.file ?? ""), new RegExp(`-v${from}\\.sqlite$`));
  const copy = new DatabaseSync(copies[0]?.file ?? "", { readOnly: true });
  try {
    assert.equal(Number((copy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), from);
  } finally {
    copy.close();
  }

  const neuf = serviceConfig((c) => (c.backups.intervalHours = null));
  const started = await startHarness(neuf, { token: "t".repeat(64), log: () => {} });
  await started.stop();
  assert.deepEqual(listBackups(backupDir(neuf), "migration"), [], "une base neuve n'a rien à sauver");

  const off = serviceConfig((c) => {
    c.backups.intervalHours = null;
    c.backups.beforeMigration = false;
  });
  previousVersionDb(path.join(off.dataDir, "harness.sqlite"));
  const unsaved = await startHarness(off, { token: "t".repeat(64), log: () => {} });
  await unsaved.stop();
  assert.deepEqual(listBackups(backupDir(off), "migration"), []);
});

test("harness-backups/AC-6 : le service démarré prend son instantané périodique dans `<dataDir>/backups` (`backups.dir` le déplace)", async () => {
  const elsewhere = path.join(tmpdir("harness-backups-ailleurs-"), "copies");
  const config = serviceConfig((c) => (c.backups.dir = elsewhere));
  const plain = serviceConfig();
  assert.equal(backupDir(plain), path.join(plain.dataDir, "backups"));
  const harness = await startHarness(config, { token: "t".repeat(64), log: () => {} });
  try {
    await waitFor(
      () => listBackups(elsewhere, "periodique").length === 1,
      () => "aucun instantané périodique",
    );
  } finally {
    await harness.stop();
  }
});

test("harness-backups/AC-7 : par défaut un instantané par jour, 7 gardés, et un avant migration ; une valeur hors bornes est refusée en nommant sa clé", () => {
  assert.deepEqual(defaultConfig("/tmp/x").backups, { dir: null, intervalHours: 24, keep: 7, beforeMigration: true });
  const dir = tmpdir("harness-backups-conf-");
  const write = (backups: unknown): string => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ dataDir: dir, backups }));
    return file;
  };
  assert.equal(loadConfig(write({ intervalHours: null })).backups.intervalHours, null);
  assert.throws(() => loadConfig(write({ keep: 0 })), /backups\.keep/);
  assert.throws(() => loadConfig(write({ intervalHours: 0 })), /backups\.intervalHours/);
  assert.throws(() => loadConfig(write({ dir: "relatif" })), /backups\.dir/);
});
