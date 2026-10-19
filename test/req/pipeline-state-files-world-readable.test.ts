// Tests de pipeline-state-files-world-readable : le magasin d'état du pipeline
// (`~/.omp/agent/pipeline` ou le dossier personnalisé) est privé — dossiers créés
// en 0700, fichiers d'état créés directement en 0600, temporaire de l'écriture
// atomique compris, quel que soit l'umask ; la racine personnalisée fournie et
// le contrat d'un worktree gardent leurs droits.
//
// Ce fichier est LE SEUL porteur des ids `pipeline-state-files-world-readable/AC-<n>`.
// Harnais recopiés (les fichiers de test ne s'importent pas entre eux) : de
// service-json-token-window-0644.test.ts `mktmp`, `withUmask022`, espion de
// `fs.renameSync` (remplacement puis `syncBuiltinESMExports()`), `noTmpLeft` ; de
// fixruns.test.ts `mkApp`, `runCtx`, `writeSessionFile` (ici `sendMessage`
// ENREGISTRE) ; de pipelines.test.ts `deadPid`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import reqExtension, {
  SERVICE_VERSION,
  appendJournal,
  contractPathFor,
  hasPendingCommands,
  isDefaultStateDir,
  journalPathFor,
  historyIdFor,
  newServiceToken,
  panelInboxDirFor,
  pidAlive,
  pipelineHistoryDir,
  pipelineRunningDir,
  pipelineStateDir,
  readCommandAck,
  readDeliveries,
  readPanelModel,
  readService,
  secureStateStore,
  runningIdFor,
  serviceFilePath,
  tightenStateStore,
  writeBrief,
  writeBytesAtomic,
  writeCommand,
  writeCommandAck,
  writeDelivery,
  writeHistoryEntry,
  writeJsonAtomic,
  writeReport,
  writeRunningEntry,
  writeService,
  writeStateFileAtomic,
} from "../../omp-mem0-req/extension.ts";
import type {
  HistoryEntry,
  PanelDelivery,
  PipelineCommand,
  PipelineCommandAck,
  RunningEntry,
  ServiceRecord,
} from "../../omp-mem0-req/extension.ts";
import { SERVICE_TOKEN_HEADER, createServiceRequestHandler } from "../../omp-mem0-req/serviceHttp.ts";
import type { ServiceApi } from "../../omp-mem0-req/serviceApi.ts";
import { auditReportDraftPathFor, writeAuditReportDraft } from "../../omp-mem0-req/auditRecord.ts";

const SLUG = "pipeline-state-files-world-readable";

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Le corps sous l'umask donnée (022 par défaut), restaurée quoi qu'il arrive. */
function withUmask<T>(body: () => T, mask: number = 0o022): T {
  const previous = process.umask(mask);
  try {
    return body();
  } finally {
    process.umask(previous);
  }
}

/** Le corps avec des variables d'environnement posées (`undefined` = supprimée), restaurées quoi qu'il arrive. */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return body();
  } finally {
    apply(saved);
  }
}

const modeOf = (p: string): number => fs.lstatSync(p).mode & 0o777;

/** Tous les dossiers (racine exclue) et fichiers réguliers sous `root`, avec leurs droits. */
function walk(root: string): { dirs: Array<[string, number]>; files: Array<[string, number]> } {
  const dirs: Array<[string, number]> = [];
  const files: Array<[string, number]> = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push([full, modeOf(full)]);
        visit(full);
      } else if (entry.isFile()) {
        files.push([full, modeOf(full)]);
      }
    }
  };
  visit(root);
  return { dirs, files };
}

function noTmpLeft(root: string): boolean {
  return walk(root).files.every(([file]) => !path.basename(file).includes(".tmp-"));
}

type RenameObservation = { from: string; to: string; tmpMode: number; widerFiles: string[]; targetModeAfter: number };

/**
 * `body` exécuté avec un espion de `fs.renameSync` qui relève, juste avant le
 * `rename` réel, le mode du temporaire et chaque fichier régulier de `root`
 * portant un bit de groupe ou d'autres ; puis le mode de la cible après.
 */
function observeRenames(root: string, body: () => void): RenameObservation[] {
  const seen: RenameObservation[] = [];
  const original = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    const tmpMode = fs.statSync(from).mode & 0o777;
    const widerFiles = walk(root).files.filter(([, mode]) => (mode & 0o077) !== 0).map(([file, mode]) => `${file} (${mode.toString(8)})`);
    original(from, to);
    seen.push({ from: String(from), to: String(to), tmpMode, widerFiles, targetModeAfter: fs.statSync(to).mode & 0o777 });
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    body();
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  return seen;
}

/** Un run publie son état (running/ puis history/), écrit le journal, un brief, un rapport et un brouillon d'audit. */
function publishRun(stateDir: string): string[] {
  const base = { id: "r-1", cwd: "/dépôt/alpha", label: "alpha", phase: "impl", sessionFile: null, sessionId: null, phaseStartedAt: 1_700_000_000_000 } as const;
  writeRunningEntry(stateDir, { ...base, state: "running", updatedAt: 1_700_000_000_000, owner: { pid: process.pid } } satisfies RunningEntry);
  writeHistoryEntry(stateDir, { ...base, finalState: "done", endedAt: 1_700_000_000_500 } satisfies HistoryEntry);
  appendJournal(stateDir, "depot-1234", {
    at: 1_700_000_000_000,
    slug: "alpha",
    phase: "impl",
    kind: "question",
    question: "Q ?",
    answer: "R",
    source: "utilisateur",
    context: null,
  });
  writeBrief(stateDir, "audit:depot", "# Brief\n");
  writeReport(stateDir, "audit:depot", "# Rapport\n");
  writeAuditReportDraft(stateDir, "a-1", "# Brouillon\n");
  return [
    path.join(stateDir, "running", "r-1.json"),
    path.join(stateDir, "history", "r-1.json"),
    journalPathFor(stateDir, "depot-1234"),
    path.join(stateDir, "briefs"),
    path.join(stateDir, "reports"),
    auditReportDraftPathFor(stateDir, "a-1"),
  ];
}

function assertPrivateTree(root: string, label: string, minFiles: number = 6): void {
  const { dirs, files } = walk(root);
  assert.ok(files.length >= minFiles, `${label} : les fichiers produits sont présents (${files.length})`);
  for (const [dir, mode] of dirs) assert.equal(mode, 0o700, `${label} : ${dir} en 0700 (vu ${mode.toString(8)})`);
  for (const [file, mode] of files) assert.equal(mode, 0o600, `${label} : ${file} en 0600 (vu ${mode.toString(8)})`);
}

/** `withEnv` pour un corps asynchrone (le handler `session_start` l'est). */
async function withEnvAsync<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await body();
  } finally {
    apply(saved);
  }
}

/** Un fichier de session au VRAI format : ligne 1 le créneau de titre, ligne 2 l'en-tête. */
function writeSessionFile(file: string, cwd: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const title = { type: "title", v: 1, title: "", updatedAt: "2026-10-19T00:00:00.000Z", pad: " ".repeat(40) };
  const header = { type: "session", version: 3, id: path.basename(file, ".jsonl"), timestamp: "2026-10-19T00:00:00.000Z", cwd };
  fs.writeFileSync(file, `${JSON.stringify(title)}\n${JSON.stringify(header)}\n`, "utf8");
  return file;
}

type SentMessage = { customType: string; content: string };

/** Une instance de l'extension sur une fausse API de l'hôte ; `sendMessage` enregistre ce qu'elle poste. */
function mkApp(flagValues: Record<string, string>) {
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const messages: SentMessage[] = [];
  const pi = {
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag: (name: string) => flagValues[name],
    on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype: (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) }),
    registerTool() {},
    sendMessage(message: { customType: string; content: string }) {
      messages.push({ customType: message.customType, content: message.content });
    },
    sendUserMessage() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  };
  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return { messages, sessionStart: (ctx: unknown) => hooks.get("session_start")!(undefined as never, ctx as never) };
}

/** Le contexte d'une session ordinaire : un cwd, une session, des minuteries inertes. */
function runCtx(cwd: string, sessionFile: string) {
  return {
    cwd,
    hasUI: false,
    isIdle: () => false,
    setInterval: () => 0,
    clearTimer: () => {},
    sessionManager: { getCwd: () => cwd, getSessionFile: () => sessionFile, getSessionId: () => "run-1" },
    ui: { notify: () => {} },
  };
}

/** Le `session_start` d'une session ordinaire (aucun drapeau de lot) dont le worktree et la session sont hors du magasin. */
async function startOrdinarySession(flags: Record<string, string>): Promise<SentMessage[]> {
  const worktree = mktmp("psfwr-wt-");
  const sessionFile = writeSessionFile(path.join(mktmp("psfwr-sess-"), "run.jsonl"), worktree);
  const app = mkApp(flags);
  await app.sessionStart(runCtx(worktree, sessionFile));
  return app.messages;
}

/** Un pid RÉELLEMENT mort : un enfant lancé puis terminé, avec son vrai pid. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(child.pid, "l'enfant doit avoir un pid");
  assert.equal(pidAlive(child.pid), false, "le pid de l'enfant terminé doit être mort");
  return child.pid;
}

type LegacyStore = { exec: string; narrow: string; link: string; outside: string };

/**
 * Un magasin d'AVANT le correctif sous `root` : sous-dossiers en 0755, fichiers
 * d'état en 0644, plus un exécutable 0755 (worktree de doc), un dossier vide
 * déjà plus étroit (0500) et un lien symbolique vers un fichier 0644 hors du magasin.
 */
function seedLegacyStore(root: string): LegacyStore {
  const files = [
    path.join("running", "r-1.json"),
    path.join("history", "h-1.json"),
    path.join("lots", "l-1.json"),
    path.join("commands", "acks", "c-1.json"),
    path.join("inbox", "r-1-1", "d-1.json"),
    path.join("journal", "depot-1234.jsonl"),
    path.join("projects", "depot.doc", "PROJECT.md"),
    "service.json",
  ];
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), "{}\n", "utf8");
  }
  const exec = path.join(root, "projects", "depot.doc", "hook.sh");
  fs.writeFileSync(exec, "#!/bin/sh\n", "utf8");
  const { dirs, files: written } = walk(root);
  for (const [dir] of dirs) fs.chmodSync(dir, 0o755);
  for (const [file] of written) fs.chmodSync(file, 0o644);
  fs.chmodSync(exec, 0o755);
  const narrow = path.join(root, "etroit");
  fs.mkdirSync(narrow);
  fs.chmodSync(narrow, 0o500);
  const outside = path.join(mktmp("psfwr-hors-"), "cible.txt");
  fs.writeFileSync(outside, "hors du magasin\n", "utf8");
  fs.chmodSync(outside, 0o644);
  const link = path.join(root, "lien");
  fs.symlinkSync(outside, link);
  fs.chmodSync(root, 0o755);
  return { exec, narrow, link, outside };
}

/** Après balayage : sous-dossiers 0700 (sauf le 0500 inchangé), fichiers 0600 (l'exécutable 0700), lien et cible intacts. */
function assertTightened(root: string, legacy: LegacyStore, label: string, except: string[] = []): void {
  const { dirs, files } = walk(root);
  assert.ok(dirs.length >= 9 && files.length >= 9, `${label} : le magasin est parcouru (${dirs.length} dossiers, ${files.length} fichiers)`);
  for (const [dir, mode] of dirs) {
    assert.equal(mode, dir === legacy.narrow ? 0o500 : 0o700, `${label} : ${dir} (vu ${mode.toString(8)})`);
  }
  for (const [file, mode] of files) {
    if (except.includes(file)) continue;
    assert.equal(mode, file === legacy.exec ? 0o700 : 0o600, `${label} : ${file} (vu ${mode.toString(8)})`);
  }
  assert.equal(fs.lstatSync(legacy.link).isSymbolicLink(), true, `${label} : le lien reste un lien`);
  assert.equal(modeOf(legacy.outside), 0o644, `${label} : la cible du lien n'est ni suivie ni modifiée`);
}

const isTightenWarning = (message: SentMessage): boolean =>
  message.customType === "pipeline" && message.content.startsWith("[pipeline] droits du magasin d'état non resserrés :");

/** `body` avec `fs.chmodSync` qui lève `EPERM` pour chaque chemin de `blocked`, restauré quoi qu'il arrive. */
async function withChmodFailing<T>(blocked: string[], body: () => Promise<T>): Promise<T> {
  const original = fs.chmodSync;
  fs.chmodSync = ((target: fs.PathLike, mode: fs.Mode) => {
    if (blocked.includes(String(target))) {
      throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${String(target)}'`), { code: "EPERM" });
    }
    return original(target, mode);
  }) as typeof fs.chmodSync;
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    fs.chmodSync = original;
    syncBuiltinESMExports();
  }
}

test(`${SLUG}/AC-1 : HOME isolé sans magasin, umask 022 — ~/.omp/agent/pipeline et ses sous-dossiers en 0700, chaque fichier produit en 0600`, () => {
  const home = mktmp("psfwr-ac1-");
  withEnv({ HOME: home, MEM0_PIPELINE_STATE_DIR: undefined }, () =>
    withUmask(() => {
      const stateDir = pipelineStateDir();
      assert.equal(stateDir, path.join(home, ".omp", "agent", "pipeline"), "le magasin par défaut suit HOME");
      assert.equal(fs.existsSync(path.join(home, ".omp")), false, "HOME neuf");
      const produced = publishRun(stateDir);
      for (const p of produced) assert.ok(fs.existsSync(p), `${p} produit`);

      assert.equal(modeOf(stateDir), 0o700, "la racine par défaut est créée en 0700");
      assert.equal(modeOf(path.join(home, ".omp")), 0o700, "~/.omp créé par l'appel : 0700");
      assert.equal(modeOf(path.join(home, ".omp", "agent")), 0o700, "~/.omp/agent créé par l'appel : 0700");
      assertPrivateTree(stateDir, "magasin par défaut");
      assert.equal(noTmpLeft(stateDir), true, "aucun temporaire laissé");

      // Un journal préexistant en 0644 auquel on ajoute une ligne ressort en 0600.
      const journal = journalPathFor(stateDir, "depot-1234");
      fs.chmodSync(journal, 0o644);
      appendJournal(stateDir, "depot-1234", {
        at: 1_700_000_000_001,
        slug: "alpha",
        phase: "impl",
        kind: "jalon",
        question: "Q2 ?",
        answer: "R2",
        source: "arbitrage",
        context: null,
      });
      assert.equal(modeOf(journal), 0o600, "journal 0644 resserré à l'ajout");
      assert.equal(fs.readFileSync(journal, "utf8").trim().split("\n").length, 2, "une ligne ajoutée, la première intacte");
    }),
  );
});

test(`${SLUG}/AC-2 : umask 022 — le temporaire de l'écriture atomique est déjà en 0600 au rename, et aucun fichier du magasin n'est plus large que 0600`, () => {
  withUmask(() => {
    // Magasin neuf : chaque écriture, JSON, texte et octets, observée à l'instant du rename.
    const stateDir = path.join(mktmp("psfwr-ac2-"), "pipeline");
    const writes: Array<[string, () => void, string]> = [
      ["writeJsonAtomic", () => writeJsonAtomic(path.join(stateDir, "lots", "l-1.json"), { version: 1 }), `${JSON.stringify({ version: 1 }, null, 2)}\n`],
      ["writeStateFileAtomic (texte)", () => writeStateFileAtomic(path.join(stateDir, "briefs", "b.md"), "é\n"), "é\n"],
      ["writeStateFileAtomic (octets)", () => writeStateFileAtomic(path.join(stateDir, "raw", "x.bin"), new TextEncoder().encode("octets")), "octets"],
    ];
    for (const [label, write, expected] of writes) {
      const seen = observeRenames(stateDir, write);
      assert.equal(seen.length, 1, `${label} : un seul rename`);
      const [obs] = seen;
      assert.equal(obs!.from, `${obs!.to}.tmp-${process.pid}`, `${label} : temporaire voisin du même pid`);
      assert.equal(obs!.tmpMode, 0o600, `${label} : le temporaire est en 0600 avant le rename`);
      assert.deepEqual(obs!.widerFiles, [], `${label} : aucun fichier du magasin plus large que 0600 au rename`);
      assert.equal(obs!.targetModeAfter, 0o600, `${label} : fichier final en 0600`);
      assert.equal(fs.readFileSync(obs!.to, "utf8"), expected, `${label} : contenu exact`);
    }
    assert.equal(noTmpLeft(stateDir), true, "aucun temporaire laissé");

    // Temporaire périmé du même pid en 0644 : retiré puis recréé en 0600.
    const stale = path.join(stateDir, "lots", "l-2.json");
    fs.writeFileSync(`${stale}.tmp-${process.pid}`, "périmé", "utf8");
    fs.chmodSync(`${stale}.tmp-${process.pid}`, 0o644);
    const [staleObs] = observeRenames(stateDir, () => writeJsonAtomic(stale, { version: 2 }));
    assert.equal(staleObs!.tmpMode, 0o600, "temporaire périmé 0644 recréé en 0600");
    assert.deepEqual(staleObs!.widerFiles, [], "le périmé 0644 a disparu avant le rename");
    assert.deepEqual(JSON.parse(fs.readFileSync(stale, "utf8")), { version: 2 });

    // Fichier préexistant en 0644 réécrit atomiquement : il ressort en 0600.
    const old = path.join(stateDir, "lots", "l-3.json");
    fs.writeFileSync(old, "{}\n", "utf8");
    fs.chmodSync(old, 0o644);
    const [oldObs] = observeRenames(stateDir, () => writeJsonAtomic(old, { version: 3 }));
    assert.equal(oldObs!.tmpMode, 0o600);
    assert.equal(modeOf(old), 0o600, "réécrit : 0600");

    // Échec du rename (la cible est un dossier non vide) : même erreur, aucun temporaire laissé.
    const blocked = path.join(stateDir, "lots", "occupé.json");
    fs.mkdirSync(path.join(blocked, "dedans"), { recursive: true });
    assert.throws(() => writeStateFileAtomic(blocked, "x"), (err: NodeJS.ErrnoException) => typeof err.code === "string");
    assert.equal(fs.existsSync(`${blocked}.tmp-${process.pid}`), false, "temporaire d'un échec retiré");
  });

  // umask 0o177 (bits propriétaire masqués) : dossiers imbriqués créés en 0700, fichier final en 0600.
  const stateDir177 = mktmp("psfwr-ac2-177-");
  withUmask(() => {
    const file = path.join(stateDir177, "lots", "profond", "l-1.json");
    const [obs] = observeRenames(stateDir177, () => writeJsonAtomic(file, { version: 1 }));
    assert.equal(obs!.tmpMode, 0o600, "umask 177 : temporaire 0600");
    assert.equal(modeOf(file), 0o600, "umask 177 : fichier 0600");
    assert.equal(modeOf(path.dirname(file)), 0o700, "umask 177 : dossier imbriqué créé 0700");
    assert.equal(modeOf(path.join(stateDir177, "lots")), 0o700, "umask 177 : dossier intermédiaire créé 0700");
  }, 0o177);
});

test(`${SLUG}/AC-3 : MEM0_PIPELINE_STATE_DIR existant en 0755, umask 022 — la racine reste 0755, sous-dossiers créés en 0700, fichiers en 0600`, () => {
  const root = mktmp("psfwr-ac3-");
  fs.chmodSync(root, 0o755);
  withEnv({ MEM0_PIPELINE_STATE_DIR: root }, () =>
    withUmask(() => {
      const stateDir = pipelineStateDir();
      assert.equal(stateDir, root, "le magasin personnalisé est la racine fournie");
      publishRun(stateDir);
      assert.equal(modeOf(root), 0o755, "la racine personnalisée garde ses droits");
      assertPrivateTree(root, "magasin personnalisé");
      assert.equal(modeOf(path.join(root, "running")), 0o700);
      assert.equal(modeOf(path.join(root, "history")), 0o700);
    }),
  );

  // Racine personnalisée ABSENTE : créée par le pipeline, donc 0700 (ancêtres créés compris).
  const parent = mktmp("psfwr-ac3-absent-");
  fs.chmodSync(parent, 0o755);
  const absent = path.join(parent, "a", "magasin");
  withEnv({ MEM0_PIPELINE_STATE_DIR: absent }, () =>
    withUmask(() => {
      publishRun(pipelineStateDir());
      assert.equal(modeOf(parent), 0o755, "le dossier existant n'est pas touché");
      assert.equal(modeOf(path.join(parent, "a")), 0o700, "ancêtre créé : 0700");
      assert.equal(modeOf(absent), 0o700, "racine absente créée : 0700");
      assertPrivateTree(absent, "racine personnalisée absente");
    }),
  );
});

test(`${SLUG}/AC-4 : ~/.omp/agent/pipeline existant en 0755 (sous-dossiers 0755, fichiers 0644) — au premier accès d'un processus OMP, racine et sous-dossiers en 0700, fichiers en 0600`, async () => {
  const home = mktmp("psfwr-ac4-");
  const stateDir = path.join(home, ".omp", "agent", "pipeline");
  fs.mkdirSync(stateDir, { recursive: true });
  const legacy = seedLegacyStore(stateDir);
  assert.equal(modeOf(stateDir), 0o755);

  await withEnvAsync({ HOME: home, MEM0_PIPELINE_STATE_DIR: undefined }, async () => {
    assert.equal(isDefaultStateDir(stateDir), true, "le magasin du HOME isolé est le défaut");
    // Une session ordinaire, sans aucun drapeau : son magasin est le défaut.
    const messages = await startOrdinarySession({});
    assert.deepEqual(messages.filter(isTightenWarning), [], "tout est resserré : aucun avertissement");
    assert.equal(modeOf(stateDir), 0o700, "la racine par défaut est resserrée");
    assertTightened(stateDir, legacy, "magasin par défaut");

    // Second accès du même process : aucun second balayage.
    const late = path.join(stateDir, "lots", "l-1.json");
    fs.chmodSync(late, 0o644);
    assert.equal(secureStateStore(stateDir, () => assert.fail("aucun avertissement")), null, "déjà balayé : rien");
    await startOrdinarySession({});
    assert.equal(modeOf(late), 0o644, "un seul balayage par process et par magasin");
  });
});

test(`${SLUG}/AC-5 : dossier d'état personnalisé en 0755 — au premier accès, la racine reste 0755, sous-dossiers en 0700, fichiers en 0600`, async () => {
  const root = mktmp("psfwr-ac5-");
  const legacy = seedLegacyStore(root);
  const home = mktmp("psfwr-ac5-home-");
  await withEnvAsync({ HOME: home, MEM0_PIPELINE_STATE_DIR: undefined }, async () => {
    assert.equal(isDefaultStateDir(root), false, "une racine personnalisée n'est pas le défaut");
    // MEM0_PIPELINE_STATE_DIR égal au défaut (même avec `/` final) : traité comme le défaut.
    assert.equal(isDefaultStateDir(`${path.join(home, ".omp", "agent", "pipeline")}/`), true);

    const messages = await startOrdinarySession({ "pipeline-state-dir": root });
    assert.deepEqual(messages.filter(isTightenWarning), [], "tout est resserré : aucun avertissement");
    assert.equal(modeOf(root), 0o755, "la racine personnalisée garde ses droits");
    assertTightened(root, legacy, "magasin personnalisé");
    assert.equal(fs.existsSync(path.join(home, ".omp")), false, "le magasin par défaut n'est ni créé ni balayé");
  });
});

test(`${SLUG}/AC-6 : un fichier d'état dont le resserrement échoue — avertissement visible qui le nomme, le reste resserré, le pipeline continue`, async () => {
  const root = mktmp("psfwr-ac6-");
  const legacy = seedLegacyStore(root);
  // Le fichier bloqué est une entrée d'historique réelle : le panneau devra la relire.
  const oldCwd = mktmp("psfwr-ac6-ancien-");
  const old: HistoryEntry = {
    id: historyIdFor(oldCwd, 1_600_000_000_500),
    cwd: oldCwd,
    label: "ancien",
    phase: "review",
    sessionFile: null,
    sessionId: null,
    phaseStartedAt: 1_600_000_000_000,
    finalState: "done",
    endedAt: 1_600_000_000_500,
  };
  const blocked = path.join(pipelineHistoryDir(root), `${old.id}.json`);
  writeHistoryEntry(root, old);
  fs.chmodSync(blocked, 0o644);

  await withChmodFailing([blocked], async () => {
    const messages = await startOrdinarySession({ "pipeline-state-dir": root });
    const warnings = messages.filter(isTightenWarning);
    assert.equal(warnings.length, 1, "un seul avertissement");
    assert.equal(warnings[0]!.content, `[pipeline] droits du magasin d'état non resserrés :\n- ${blocked} (EPERM)`, "il nomme le chemin et le code");
    assert.equal(modeOf(blocked), 0o644, "le fichier en échec garde ses droits");
    assertTightened(root, legacy, "les autres chemins", [blocked]);

    // Le pipeline continue : publication d'état, puis lecture du panneau.
    const liveCwd = mktmp("psfwr-ac6-vivant-");
    const live: RunningEntry = {
      id: runningIdFor(liveCwd),
      cwd: liveCwd,
      label: "vivant",
      phase: "impl",
      sessionFile: null,
      sessionId: null,
      phaseStartedAt: 1_700_000_000_000,
      state: "running",
      updatedAt: 1_700_000_000_000,
      owner: { pid: process.pid },
    };
    fs.rmSync(path.join(pipelineRunningDir(root), "r-1.json"));
    writeRunningEntry(root, live);
    assert.equal(modeOf(path.join(pipelineRunningDir(root), `${live.id}.json`)), 0o600);
    const model = readPanelModel({ stateDir: root });
    assert.deepEqual(model.running.map((entry) => entry.id), [live.id], "l'entrée publiée est lue");
    assert.ok(model.history.some((entry) => entry.id === old.id), "l'entrée non resserrée reste lisible");
  });

  // Plus de dix échecs : dix chemins nommés, le reste compté ; un second appel ne balaie ni ne prévient.
  const many = mktmp("psfwr-ac6-many-");
  const failing = Array.from({ length: 12 }, (_, n) => path.join(many, `f-${String(n).padStart(2, "0")}.json`));
  for (const file of failing) {
    fs.writeFileSync(file, "{}\n", "utf8");
    fs.chmodSync(file, 0o644);
  }
  await withChmodFailing(failing, async () => {
    const warned: string[] = [];
    const report = secureStateStore(many, (text) => warned.push(text));
    assert.deepEqual(report?.tightened, []);
    assert.equal(report?.failures.length, 12);
    assert.equal(warned.length, 1);
    const lines = warned[0]!.split("\n");
    assert.equal(lines.length, 12, "titre + 10 chemins + le reste");
    assert.equal(lines[0], "[pipeline] droits du magasin d'état non resserrés :");
    assert.equal(lines[11], "- … et 2 autre(s)");
    assert.equal(secureStateStore(many, (text) => warned.push(text)), null);
    assert.equal(warned.length, 1, "un seul avertissement par process et par magasin");
  });
  // `warn` qui lève, racine absente : `secureStateStore` ne lève jamais.
  const throwing = mktmp("psfwr-ac6-warn-");
  fs.writeFileSync(path.join(throwing, "x.json"), "{}\n", "utf8");
  await withChmodFailing([path.join(throwing, "x.json")], async () => {
    assert.equal(secureStateStore(throwing, () => { throw new Error("canal en panne"); })?.failures.length, 1);
  });
  assert.deepEqual(tightenStateStore(path.join(throwing, "absent"), { includeRoot: true }), { tightened: [], failures: [] });
});

test(`${SLUG}/AC-7 : magasin resserré — panneau, pid mort balayé vers history/, inbox, commande et accusé, service HTTP : mêmes résultats qu'avant`, async () => {
  const stateDir = path.join(mktmp("psfwr-ac7-"), "pipeline");
  const worktree = mktmp("psfwr-ac7-wt-");
  const repo = mktmp("psfwr-ac7-repo-");
  const base = { label: "depot/feature", sessionFile: null, sessionId: null } as const;
  const live: RunningEntry = { ...base, id: runningIdFor(worktree), cwd: worktree, phase: "impl", phaseStartedAt: 1_000, state: "running", updatedAt: 2_000, owner: { pid: process.pid } };
  const dead: RunningEntry = { ...base, id: runningIdFor(repo), cwd: repo, phase: "review", phaseStartedAt: 1_500, state: "running", updatedAt: 4_000, owner: { pid: deadPid() } };
  writeRunningEntry(stateDir, live);
  writeRunningEntry(stateDir, dead);
  // Un magasin d'avant le correctif, puis resserré par le premier accès.
  for (const [dir] of walk(stateDir).dirs) fs.chmodSync(dir, 0o755);
  for (const [file] of walk(stateDir).files) fs.chmodSync(file, 0o644);
  const report = secureStateStore(stateDir, () => assert.fail("aucun avertissement"));
  assert.ok(report && report.tightened.length >= 3 && report.failures.length === 0);
  assertPrivateTree(stateDir, "magasin resserré", 2);

  // Panneau : l'entrée vivante est lue ; le pid mort rejoint l'historique en « échoué ».
  const model = readPanelModel({ stateDir });
  assert.deepEqual(model.running.map((entry) => entry.id), [live.id]);
  assert.equal(model.history.length, 1);
  const record = model.history[0]!;
  assert.equal(record.finalState, "failed");
  assert.equal(record.phase, "review");
  assert.equal(record.endedAt, dead.updatedAt, "l'instant de fin est le dernier battement");
  assert.equal(fs.existsSync(path.join(pipelineRunningDir(stateDir), `${dead.id}.json`)), false, "running/ ne la contient plus");
  const historyFile = path.join(pipelineHistoryDir(stateDir), `${record.id}.json`);
  assert.equal(modeOf(historyFile), 0o600, "l'historique écrit par le second processus est en 0600");
  assert.equal(readPanelModel({ stateDir }).history.length, 1, "idempotent");

  // Inbox : la livraison déposée est relue telle quelle.
  const inbox = panelInboxDirFor(stateDir, worktree);
  const delivery: PanelDelivery = { version: 1, kind: "text", text: "bonjour", sentAt: 1_700_000_000_000 };
  writeDelivery(inbox, delivery);
  const delivered = readDeliveries(inbox);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0]!.delivery, delivery);
  assert.equal(modeOf(delivered[0]!.file), 0o600);

  // Canal de commandes : la commande est en attente, l'accusé est relu.
  const cmd: PipelineCommand = { version: 1, id: "c-1", sentAt: 1_700_000_000_000, repo, kind: "launch", title: "Titre", description: "faire" };
  writeCommand(stateDir, cmd);
  assert.equal(hasPendingCommands(stateDir, repo), true, "la commande déposée est en attente");
  const ack: PipelineCommandAck = { version: 1, id: "c-1", repo, kind: "launch", state: "taken", reason: null, at: 1_700_000_000_100 };
  writeCommandAck(stateDir, ack);
  assert.deepEqual(readCommandAck(stateDir, "c-1"), ack);

  // Service HTTP : le jeton relu de service.json (0600) authentifie comme avant.
  const written: ServiceRecord = { version: SERVICE_VERSION, pid: process.pid, port: 8788, token: newServiceToken(), startedAt: 1_700_000_000_000, stateDir, sessionFile: null };
  writeService(written);
  assert.equal(modeOf(serviceFilePath(stateDir)), 0o600);
  const reread = readService(stateDir, { alive: () => true });
  assert.deepEqual(reread, written);
  const handle = createServiceRequestHandler({ api: { lot: () => null } as unknown as ServiceApi, token: written.token });
  const get = (headers: Record<string, string>) =>
    handle(new Request(`http://127.0.0.1/v1/repos/${encodeURIComponent(stateDir)}/lot`, { method: "GET", headers }));
  assert.equal((await get({ [SERVICE_TOKEN_HEADER]: reread!.token })).status, 200, "jeton relu accepté");
  assert.equal((await get({})).status, 401, "sans jeton");

  assertPrivateTree(stateDir, "magasin après les clients", 6);
});

test(`${SLUG}/AC-8 : umask 022 — le contrat écrit dans le worktree conduit garde 0644`, () => {
  withUmask(() => {
    const worktree = mktmp("psfwr-ac8-");
    const contract = contractPathFor(worktree);
    assert.equal(contract, path.join(worktree, ".omp", "pipeline", "contract.md"));
    writeBytesAtomic(contract, new TextEncoder().encode("## Besoins\n"));
    assert.equal(modeOf(contract), 0o644, "le contrat suit l'umask");
    assert.equal(modeOf(path.dirname(contract)), 0o755, "ses dossiers aussi");
    assert.equal(modeOf(path.join(worktree, ".omp")), 0o755);
    assert.equal(fs.readFileSync(contract, "utf8"), "## Besoins\n");
    assert.equal(noTmpLeft(worktree), true);
  });
});
