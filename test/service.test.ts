// Tests du SOCLE du service (S-1) : l'enregistrement `service.json`, son jeton,
// son port, le singleton, et le job launchd qui le relance.
//
// Le service ne tourne pas ici : `Bun.serve` est une doublure injectée dans le
// global (le seul point d'accès de l'hôte, Doc-1 §11), et `launchctl` un exécuteur
// de test. Ce qui est vérifié, c'est ce que les CLIENTS lisent : le fichier, sa
// forme, sa vivacité, et le plist rendu à l'octet.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SERVICE_FLAG,
  SERVICE_LABEL,
  SERVICE_PORT_DEFAULT,
  SERVICE_VERSION,
  asServiceRecord,
  createLaunchd,
  launchAgentPath,
  launchdPath,
  launchdStatusText,
  newServiceToken,
  readService,
  renderServicePlist,
  resolveLaunchdOmpBinary,
  serviceFilePath,
  serviceJobArgv,
  serviceLogPath,
  servicePort,
  serviceRunning,
  startService,
  serviceStatusText,
  writeService,
} from "../omp-mem0-req/extension.ts";
import type { ServiceRecord } from "../omp-mem0-req/extension.ts";

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* répertoire déjà retiré */
    }
  }
});

/** Un enregistrement valide, à la forme exacte de S-1. */
function record(stateDir: string, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    version: SERVICE_VERSION,
    pid: process.pid,
    port: 8788,
    token: newServiceToken(),
    startedAt: 1_700_000_000_000,
    stateDir,
    sessionFile: null,
    ...over,
  };
}

/** La doublure de `Bun` : un serveur qui retient son port et son gestionnaire. */
function fakeBun(options: { busyPorts?: number[]; port?: number } = {}) {
  const calls: Array<{ hostname: string; port: number }> = [];
  const handlers: Array<(request: Request) => Response | Promise<Response>> = [];
  const stops: boolean[] = [];
  let next = options.port ?? 41_000;
  const bun = {
    serve: (opts: { hostname: string; port: number; fetch: (request: Request) => Response | Promise<Response> }) => {
      calls.push({ hostname: opts.hostname, port: opts.port });
      if ((options.busyPorts ?? []).includes(opts.port)) {
        const err = new Error("EADDRINUSE") as Error & { code?: string };
        err.code = "EADDRINUSE";
        throw err;
      }
      handlers.push(opts.fetch);
      const port = opts.port === 0 ? (next += 1) : opts.port;
      return {
        port,
        stop: (force?: boolean) => {
          stops.push(force === true);
        },
        timeout: () => {},
      };
    },
  };
  return { bun, calls, handlers, stops };
}

/** Le global `Bun` : posé pour un test, retiré aussitôt après. */
async function withFakeBun<T>(fake: ReturnType<typeof fakeBun>, body: () => Promise<T>): Promise<T> {
  const host = globalThis as typeof globalThis & { Bun?: unknown };
  const previous = host.Bun;
  host.Bun = fake.bun;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete host.Bun;
    else host.Bun = previous;
  }
}

test("service/AC-1 : service.json est écrit atomiquement, en 0600, et relu tel quel", () => {
  const stateDir = mktmp("service-state-");
  const written = record(stateDir, { port: 9123 });
  writeService(written, stateDir);
  assert.equal(fs.existsSync(serviceFilePath(stateDir)), true);
  assert.equal(fs.statSync(serviceFilePath(stateDir)).mode & 0o777, 0o600, "le jeton ne se lit que par son propriétaire");
  assert.deepEqual(readService(stateDir, { alive: () => true }), written);
  assert.equal(fs.readdirSync(stateDir).some((name) => name.includes(".tmp-")), false, "aucun temporaire laissé");
});

test("service/AC-2 : un enregistrement illisible, d'une autre version ou d'un pid mort est ignoré", () => {
  const stateDir = mktmp("service-state-");
  // Fichier absent.
  assert.equal(readService(stateDir), null);
  // Tronqué.
  fs.writeFileSync(serviceFilePath(stateDir), '{"version":1,"pid":', "utf8");
  assert.equal(readService(stateDir), null);
  // Version inconnue.
  writeService(record(stateDir, { version: 99 as unknown as number }), stateDir);
  assert.equal(readService(stateDir, { alive: () => true }), null);
  // Jeton hors motif.
  writeService(record(stateDir, { token: "pas-un-jeton" }), stateDir);
  assert.equal(readService(stateDir, { alive: () => true }), null);
  // Port éphémère (0) : jamais un port publié.
  writeService(record(stateDir, { port: 0 }), stateDir);
  assert.equal(readService(stateDir, { alive: () => true }), null);
  // Pid mort : le fichier d'un `kill -9` ne fait pas croire à un service vivant.
  writeService(record(stateDir, { pid: 999_999 }), stateDir);
  assert.equal(readService(stateDir), null, "pid mort ⇒ ignoré");
  assert.equal(serviceRunning(stateDir), null);
  assert.equal(serviceStatusText(stateDir), "arrêté (enregistrement périmé)");
});

test("service/AC-3 : le jeton fait 32 hexadécimaux et le port lit MEM0_SERVICE_PORT", () => {
  assert.match(newServiceToken(), /^[0-9a-f]{32}$/);
  assert.notEqual(newServiceToken(), newServiceToken(), "deux jetons ne se répètent pas");
  assert.equal(servicePort({}), SERVICE_PORT_DEFAULT);
  assert.equal(servicePort({ MEM0_SERVICE_PORT: "9123" }), 9123);
  assert.equal(servicePort({ MEM0_SERVICE_PORT: "0" }), 0, "0 = port éphémère demandé");
  assert.equal(servicePort({ MEM0_SERVICE_PORT: "pas-un-port" }), SERVICE_PORT_DEFAULT);
  assert.equal(servicePort({ MEM0_SERVICE_PORT: "70000" }), SERVICE_PORT_DEFAULT);
  assert.equal(asServiceRecord({ version: 1 }), null, "une forme incomplète n'est jamais devinée");
});

test("service/AC-4 : le singleton refuse un second service, et n'écrase rien", async () => {
  const stateDir = mktmp("service-state-");
  const first = record(stateDir, { port: 9101, token: "a".repeat(32) });
  writeService(first, stateDir);
  const fake = fakeBun();
  await withFakeBun(fake, async () => {
    const lines: string[] = [];
    const started = await startService({
      // L'API n'est jamais appelée : le singleton sort AVANT d'écouter.
      api: {} as never,
      stateDir,
      log: (line) => lines.push(line),
    });
    assert.deepEqual(started, { kind: "already-running", pid: process.pid });
    assert.deepEqual(lines, [`un service tourne déjà (pid ${process.pid})`]);
    assert.deepEqual(fake.calls, [], "aucun serveur n'est monté");
    assert.deepEqual(readService(stateDir, { alive: () => true }), first, "l'enregistrement du premier est intact");
  });
});

test("service/AC-5 : un port occupé donne un port éphémère, et c'est le FICHIER qui fait foi", async () => {
  const stateDir = mktmp("service-state-");
  const fake = fakeBun({ busyPorts: [8788], port: 43_000 });
  await withFakeBun(fake, async () => {
    const started = await startService({ api: {} as never, stateDir, port: 8788, log: () => {} });
    assert.equal(started.kind, "started");
    if (started.kind !== "started") return;
    assert.deepEqual(
      fake.calls.map((call) => call.port),
      [8788, 0],
      "le port demandé d'abord, le port éphémère ensuite",
    );
    assert.equal(started.handle.port, 43_001, "le port réellement écouté");
    assert.deepEqual(fake.calls.map((call) => call.hostname), ["127.0.0.1", "127.0.0.1"], "jamais 0.0.0.0 (S-12 §3)");
    const onDisk = readService(stateDir, { alive: () => true });
    assert.equal(onDisk?.port, 43_001, "les clients lisent le port dans service.json, jamais un port en dur");
    assert.equal(onDisk?.pid, process.pid);
    assert.equal(serviceStatusText(stateDir), `en marche (pid ${process.pid}, port 43001)`);
    await started.handle.stop();
    assert.equal(fs.existsSync(serviceFilePath(stateDir)), false, "l'arrêt propre retire l'enregistrement");
    assert.deepEqual(fake.stops, [true], "le serveur est coupé (requêtes en vol comprises)");
  });
});

test("service/AC-6 : le plist launchd est rendu exactement, PATH et sorties compris", () => {
  const stateDir = "/Users/test/.omp/agent/pipeline";
  const home = "/Users/test";
  const ompBin = "/Users/test/.bun/bin/omp";
  const plist = renderServicePlist({ label: SERVICE_LABEL, argv: serviceJobArgv(ompBin), home, stateDir, ompBin });
  assert.equal(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>",
      `  <string>${SERVICE_LABEL}</string>`,
      "  <key>ProgramArguments</key>",
      "  <array>",
      `    <string>${ompBin}</string>`,
      "    <string>-p</string>",
      "    <string>--no-session</string>",
      "    <string>--pipeline-service</string>",
      "    <string>/service start</string>",
      "  </array>",
      "  <key>RunAtLoad</key>",
      "  <true/>",
      "  <key>KeepAlive</key>",
      "  <true/>",
      "  <key>ThrottleInterval</key>",
      "  <integer>10</integer>",
      "  <key>WorkingDirectory</key>",
      `  <string>${home}</string>`,
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>HOME</key>",
      `    <string>${home}</string>`,
      "    <key>PATH</key>",
      `    <string>${launchdPath(ompBin, home)}</string>`,
      "  </dict>",
      "  <key>StandardOutPath</key>",
      `  <string>${serviceLogPath(stateDir)}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${serviceLogPath(stateDir)}</string>`,
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
  );
  // Le PATH du job contient de quoi trouver `omp` ET `bun` (Doc-3 §5).
  assert.match(launchdPath(ompBin, home), /\.bun\/bin/);
  assert.match(launchdPath(ompBin, home), /\/opt\/homebrew\/bin/);
  assert.match(launchdPath(ompBin, home), /\/usr\/bin/);
  assert.match(
    launchdPath(ompBin, home),
    new RegExp(`^${path.dirname(ompBin).replace(/[.]/g, "\\.")}:`),
    "le dossier du binaire `omp` vient en tête : sans lui, launchd ne trouve pas bun",
  );
});

test("service/AC-7 : install/uninstall/status pilotent launchctl et lisent service.json", async () => {
  const stateDir = mktmp("service-state-");
  const home = mktmp("service-home-");
  const calls: string[][] = [];
  const loaded = { value: false };
  const exec = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "print") return { code: loaded.value ? 0 : 113, stdout: "", stderr: loaded.value ? "" : "Could not find" };
    if (argv[1] === "bootstrap") {
      loaded.value = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[1] === "bootout") {
      loaded.value = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const launchd = createLaunchd({ ompBin: "/usr/local/bin/omp", home, uid: 501, stateDir, exec });

  const before = await launchd.status();
  assert.deepEqual(
    [before.installed, before.loaded, before.running, before.text],
    [false, false, null, "arrêté — job launchd non installé (/service install)"],
  );

  const installed = await launchd.install();
  assert.equal(installed.ok, true);
  assert.equal(fs.existsSync(launchAgentPath(home)), true, "le plist est écrit dans ~/Library/LaunchAgents");
  assert.deepEqual(calls.at(-1), ["launchctl", "bootstrap", "gui/501", launchAgentPath(home)]);
  assert.equal(launchdStatusText({ installed: true, loaded: true, running: null }), "arrêté");
  assert.equal(
    launchdStatusText({ installed: true, loaded: false, running: null }),
    "arrêté — job launchd installé mais non chargé (/service install)",
  );

  writeService(record(stateDir, { port: 8899 }), stateDir);
  const running = await launchd.status();
  assert.equal(running.text, `en marche (pid ${process.pid}, port 8899)`);

  const removed = await launchd.uninstall();
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(launchAgentPath(home)), false);
  assert.deepEqual(calls.at(-1), ["launchctl", "bootout", `gui/501/${SERVICE_LABEL}`]);
});

test("service/AC-8 : un `launchctl bootstrap` en échec est NOMMÉ, jamais avalé", async () => {
  const stateDir = mktmp("service-state-");
  const home = mktmp("service-home-");
  const exec = async (argv: string[]) =>
    argv[1] === "print"
      ? { code: 113, stdout: "", stderr: "" }
      : { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
  const launchd = createLaunchd({ ompBin: "/usr/local/bin/omp", home, uid: 501, stateDir, exec });
  const result = await launchd.install();
  assert.equal(result.ok, false);
  assert.match(result.text, /launchctl bootstrap a échoué : Bootstrap failed: 5/);
  assert.equal(SERVICE_FLAG, "pipeline-service");
});

test("service/AC-9 : le binaire `omp` du job launchd est résolu en CHEMIN ABSOLU, sinon l'installation refuse", async () => {
  const stateDir = mktmp("service-state-");
  const home = mktmp("service-home-");
  const calls: string[][] = [];
  const exec = async (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "print") return { code: 113, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };

  // (1) La RÉSOLUTION. `omp` est un script `#!/usr/bin/env bun` (donc
  //     `process.execPath` vaut `bun`, inutilisable) : le chemin se cherche sur le
  //     PATH de l'installation et sort ABSOLU.
  const ompAbs = path.join(home, ".bun", "bin", "omp");
  assert.deepEqual(
    resolveLaunchdOmpBinary({ PATH: path.dirname(ompAbs) }, file => file === ompAbs),
    { bin: ompAbs, problem: null },
  );
  // Un `omp` introuvable est NOMMÉ — jamais rendu tel quel dans un plist.
  const missing = resolveLaunchdOmpBinary({ PATH: "/usr/bin:/bin" }, () => false);
  assert.equal(missing.bin, null);
  assert.match(String(missing.problem), /introuvable dans le PATH/);
  // Le drapeau garde la priorité comme NOM à chercher : une valeur relative ne
  // sort JAMAIS telle quelle — elle est résolue, ou refusée.
  assert.equal(
    resolveLaunchdOmpBinary({ MEM0_PIPELINE_OMP_BIN: "omp", PATH: "/usr/bin" }, file => file === "/usr/bin/omp").bin,
    "/usr/bin/omp",
    "un drapeau relatif est résolu sur le PATH, jamais recopié dans le plist",
  );
  assert.equal(
    resolveLaunchdOmpBinary({ MEM0_PIPELINE_OMP_BIN: "omp", PATH: "/usr/bin" }, () => false).bin,
    null,
  );
  // Un drapeau qui porte un CHEMIN mais relatif (« bin/omp ») est refusé.
  const relative = resolveLaunchdOmpBinary({ MEM0_PIPELINE_OMP_BIN: "bin/omp", PATH: "/usr/bin" }, () => true);
  assert.equal(relative.bin, null);
  assert.match(String(relative.problem), /n'est pas un chemin absolu/);
  assert.equal(
    resolveLaunchdOmpBinary({ MEM0_PIPELINE_OMP_BIN: "/abs/omp" }, file => file === "/abs/omp").bin,
    "/abs/omp",
  );

  // (2) L'INSTALLATION refuse un binaire non absolu AVANT d'écrire : launchd
  //     résout un premier argument relatif via `_PATH_STDPATH`, où `omp` n'est
  //     pas — le job mourrait en `78: EX_CONFIG` sans jamais démarrer (mesuré).
  const bare = createLaunchd({ ompBin: "omp", home, uid: 501, stateDir, exec });
  const refused = await bare.install();
  assert.equal(refused.ok, false);
  assert.match(refused.text, /non absolu/);
  assert.match(refused.text, /MEM0_PIPELINE_OMP_BIN=\/chemin\/absolu\/omp/);
  assert.equal(fs.existsSync(launchAgentPath(home)), false, "aucun plist n'est écrit");
  assert.deepEqual(calls, [], "launchctl n'est jamais appelé");

  // (2bis) Un drapeau ABSOLU mais INTROUVABLE (`/nope/omp`) : la résolution rend
  //        son motif, l'installation le porte et REFUSE AVANT d'écrire — sinon le
  //        plist porterait un chemin que launchd ne pourrait pas `exec`.
  const missingFlag = resolveLaunchdOmpBinary({ MEM0_PIPELINE_OMP_BIN: "/nope/omp" }, () => false);
  assert.equal(missingFlag.bin, null);
  assert.match(String(missingFlag.problem), /n'existe pas/);
  const unusable = createLaunchd({
    ompBin: "/nope/omp",
    ompBinProblem: missingFlag.problem,
    home,
    uid: 501,
    stateDir,
    exec,
  });
  const refusedMissing = await unusable.install();
  assert.equal(refusedMissing.ok, false);
  assert.match(refusedMissing.text, /n'existe pas/);
  assert.match(refusedMissing.text, /MEM0_PIPELINE_OMP_BIN=\/chemin\/absolu\/omp/);
  assert.equal(fs.existsSync(launchAgentPath(home)), false, "aucun plist n'est écrit");
  assert.deepEqual(calls, [], "launchctl n'est jamais appelé");

  // (3) Avec un chemin ABSOLU, le plist le porte en `ProgramArguments[0]`.
  const absolute = createLaunchd({ ompBin: ompAbs, home, uid: 501, stateDir, exec });
  const installed = await absolute.install();
  assert.equal(installed.ok, true);
  const plist = fs.readFileSync(launchAgentPath(home), "utf8");
  assert.match(
    plist,
    new RegExp(`<key>ProgramArguments</key>\\s*<array>\\s*<string>${ompAbs.replace(/\./g, "\\.")}</string>`),
    "le premier argument du job est le chemin absolu de `omp`",
  );
  assert.match(plist, /<string>--pipeline-service<\/string>/);
});
