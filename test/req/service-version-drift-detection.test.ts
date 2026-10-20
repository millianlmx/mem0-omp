// Tests de service-version-drift-detection, lot BR-1 (S-1, S-2, S-3 ; AC-1..AC-8) :
// la version d'omp-mem0-req chargée par le service, exposée par GET /v1/health, et
// le contrôle d'écart avec le plugin installé — par `/service status` et au
// démarrage d'une session interactive non enfant.
//
// Le service est un VRAI serveur node:http sur 127.0.0.1:0 annoncé par un VRAI
// service.json (pid = ce process) ; le plugin installé est un VRAI package.json sous
// `<HOME>/.omp/plugins/node_modules/omp-mem0-req`. Seuls `pi` et `ctx` sont doublés.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

import reqExtension, {
  SERVICE_FLAG,
  SERVICE_VERSION_PROBE_TIMEOUT_MS,
  createServicePilot,
  createServiceRequestHandler,
  markServiceProcess,
  readPackageVersion,
  writeService,
  type ServiceApi,
  type SessionHost,
} from "../../omp-mem0-req/extension.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { sessionFileIn } from "../support/req-fixtures.ts";

const TOKEN = "d".repeat(32);
const INSTALLED = "1.2.3";
const PLUGIN_PACKAGE = path.join(ROOT, "omp-mem0-req", "package.json");

// Le registre et les worktrees d'une session réelle ne doivent jamais être touchés.
process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("svd-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("svd-default-wt-");

const driftExposed = (exposed: string) =>
  `[service] écart de version : le service exécute omp-mem0-req ${exposed}, le plugin installé est en ${INSTALLED} — relance /service install`;
const DRIFT_ABSENT = `[service] écart de version : le service n'expose pas sa version, le plugin installé est en ${INSTALLED} — relance /service install`;

// Délai RÉEL assumé : la sonde de S-3 n'expose aucune promesse (`void …`, jamais
// attendue) et sa borne est l'horloge du runtime — le silence ne se constate qu'après
// la borne + 1 s (contrat S-2/S-3), pas par un signal.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

// ---------------------------------------------------------------------------
// Fixtures : environnement, plugin installé, service simulé
// ---------------------------------------------------------------------------

/** Un HOME et un magasin dédiés, posés pour la durée de `fn` (os.homedir() relit HOME). */
async function withWorld<T>(fn: (world: { home: string; stateDir: string }) => Promise<T>): Promise<T> {
  const home = tmpdir("svd-home-");
  const stateDir = tmpdir("svd-state-");
  const previous = { home: process.env.HOME, state: process.env.MEM0_PIPELINE_STATE_DIR };
  process.env.HOME = home;
  process.env.MEM0_PIPELINE_STATE_DIR = stateDir;
  try {
    return await fn({ home, stateDir });
  } finally {
    process.env.HOME = previous.home;
    process.env.MEM0_PIPELINE_STATE_DIR = previous.state;
  }
}

/** Le plugin installé, tel que `omp plugin install` le pose. */
function installPlugin(home: string, version: string): void {
  const dir = path.join(home, ".omp", "plugins", "node_modules", "omp-mem0-req");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "omp-mem0-req", version })}\n`);
}

/** Annonce un service en marche (pid de CE process, donc vivant) sur `port`. */
function publishService(stateDir: string, port: number, token = TOKEN): void {
  writeService({ version: 1, pid: process.pid, port, token, startedAt: 1, stateDir, sessionFile: null }, stateDir);
}

type HealthReply = { kind: "json"; body: Record<string, unknown> } | { kind: "hang" };

/** Un service simulé : jeton exigé (401 sinon), compte les GET /v1/health. */
async function fakeService(reply: HealthReply) {
  let requests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/health") requests += 1;
    if (req.headers["x-omp-service-token"] !== TOKEN) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (reply.kind === "hang") return; // accepte et ne répond jamais
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    requests: () => requests,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

const healthBody = (pluginVersion?: string): Record<string, unknown> => ({
  version: 1,
  pid: process.pid,
  startedAt: 1,
  sessions: 0,
  lots: 0,
  ...(pluginVersion === undefined ? {} : { pluginVersion }),
});

/** Un port fermé : un serveur écouté puis fermé. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

// ---------------------------------------------------------------------------
// L'extension complète à faux `pi`
// ---------------------------------------------------------------------------

type Notice = { message: string; tone?: string };

const arktype = (definition: unknown) => ({ definition, array: () => ({ definition: [definition] }) });

function mkApp(flags: Record<string, unknown> = {}) {
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const pi = {
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def.handler);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      hooks.set(name, handler);
    },
    arktype,
    registerTool() {},
    setActiveTools: async () => {},
    sendMessage() {},
    sendUserMessage() {},
    // launchctl : job absent, sans sortie.
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  reqExtension(pi as never);
  const notices: Notice[] = [];
  const ui = { notify: (message: string, tone?: string) => notices.push({ message, tone }) };

  /** `/service status` ; rend les notices émises par CE geste. */
  const status = async (): Promise<Notice[]> => {
    const from = notices.length;
    await commands.get("service")!("status", { cwd: process.cwd(), hasUI: true, ui });
    return notices.slice(from);
  };

  /** Le `session_start` d'une session (fichier fourni ou session ordinaire neuve). */
  const start = async (options: { hasUI?: boolean; sessionFile?: string } = {}): Promise<void> => {
    const cwd = tmpdir("svd-cwd-");
    const file = options.sessionFile ?? sessionFileIn(tmpdir("svd-session-"), "s.jsonl");
    const ctx = {
      cwd,
      hasUI: options.hasUI ?? true,
      ui,
      sessionManager: { getSessionFile: () => file, getSessionId: () => path.basename(file), getCwd: () => cwd },
      setInterval: () => 0,
      clearTimer: () => {},
      isIdle: () => true,
    };
    await hooks.get("session_start")!({ type: "session_start" }, ctx);
  };

  const drifts = () => notices.filter((notice) => notice.message.includes("écart de version"));
  return { status, start, notices, drifts };
}

/** Le fichier de session d'un sous-agent : son en-tête porte `parentSession`. */
function subagentSessionFile(): string {
  const dir = tmpdir("svd-sub-");
  const file = path.join(dir, "sub.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session", id: "sub", cwd: dir, parentSession: path.join(dir, "parent.jsonl") })}\n`,
  );
  return file;
}

// ---------------------------------------------------------------------------
// S-1 : la version chargée, exposée par GET /v1/health
// ---------------------------------------------------------------------------

test("service-version-drift-detection/AC-1 : GET /v1/health expose la version d'omp-mem0-req chargée, `version` vaut toujours 1", async () => {
  const stateDir = tmpdir("svd-pilot-");
  const pilot = createServicePilot({
    stateDir,
    host: { list: () => [] } as unknown as SessionHost,
    run: async () => {
      throw new Error("aucun run dans ce test");
    },
    runGit: async () => ({ code: 0, stdout: "", stderr: "" }),
    now: () => 1_700_000_000_000,
    startedAt: 1_700_000_000_000,
    schedule: () => () => {},
  });
  const api = { health: () => pilot.health() } as unknown as ServiceApi;
  const handler = createServiceRequestHandler({ api, token: TOKEN });
  const server = http.createServer((req, res) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
    void handler(new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method ?? "GET", headers }))
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers.entries())).end(await response.text());
      })
      .catch(() => res.writeHead(500).end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const url = `http://127.0.0.1:${address.port}/v1/health`;
    const expected = readPackageVersion(PLUGIN_PACKAGE);
    assert.ok(expected, "le package.json du dépôt porte une version");

    const ok = await fetch(url, { headers: { "X-OMP-Service-Token": TOKEN } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body.pluginVersion, expected, "le nouveau champ porte la version du code chargé");
    assert.equal(body.version, 1, "`version` reste la version du format");
    assert.deepEqual(Object.keys(body).sort(), ["lots", "pid", "pluginVersion", "sessions", "startedAt", "version"]);

    const refused = await fetch(url);
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: "unauthorized" });
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("service-version-drift-detection/AC-2 : un upgrade sur disque après le chargement ne change pas la version annoncée", async () => {
  const dir = path.join(tmpdir("svd-copy-"), "omp-mem0-req");
  fs.mkdirSync(dir, { recursive: true });
  const module = path.join(dir, "pluginVersion.ts");
  fs.copyFileSync(path.join(ROOT, "omp-mem0-req", "pluginVersion.ts"), module);
  const pkg = JSON.parse(fs.readFileSync(PLUGIN_PACKAGE, "utf8")) as Record<string, unknown>;
  const pkgFile = path.join(dir, "package.json");
  fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version: "9.0.0-x" }, null, 2)}\n`);

  // Import dynamique voulu : c'est le CHARGEMENT d'une copie isolée du module qui est testé.
  const loaded = (await import(pathToFileURL(module).href)) as {
    LOADED_PLUGIN_VERSION: string | null;
    readPackageVersion: (file: string) => string | null;
  };
  assert.equal(loaded.LOADED_PLUGIN_VERSION, "9.0.0-x", "la version du package.json voisin, lue au chargement");

  fs.writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version: "9.0.1-y" }, null, 2)}\n`);
  assert.equal(loaded.readPackageVersion(pkgFile), "9.0.1-y", "le disque a bien changé");
  assert.equal(loaded.LOADED_PLUGIN_VERSION, "9.0.0-x", "la version chargée, elle, est figée");
});

// ---------------------------------------------------------------------------
// S-2 : `/service status`
// ---------------------------------------------------------------------------

test("service-version-drift-detection/AC-3 : `/service status` signale un service plus ancien, plus récent ou sans version, et propose /service install", async () => {
  const cases: Array<{ exposed: string | undefined; expected: string }> = [
    { exposed: "0.0.1", expected: driftExposed("0.0.1") },
    { exposed: "999.0.0", expected: driftExposed("999.0.0") },
    { exposed: undefined, expected: DRIFT_ABSENT },
  ];
  for (const { exposed, expected } of cases) {
    await withWorld(async ({ home, stateDir }) => {
      installPlugin(home, INSTALLED);
      const service = await fakeService({ kind: "json", body: healthBody(exposed) });
      try {
        publishService(stateDir, service.port);
        const emitted = await mkApp().status();
        assert.ok(
          emitted.some((notice) =>
            notice.message.startsWith(`[service] en marche (pid ${process.pid}, port ${service.port})`),
          ),
          "la ligne d'état reste émise",
        );
        const drifts = emitted.filter((notice) => notice.message.includes("écart de version"));
        assert.deepEqual(drifts, [{ message: expected, tone: "warning" }], `service en ${exposed ?? "(absente)"}`);
        assert.ok(emitted.indexOf(drifts[0]!) > 0, "l'écart suit la ligne d'état");
      } finally {
        await service.close();
      }
    });
  }
});

test("service-version-drift-detection/AC-4 : `/service status` ne signale rien quand les versions sont identiques", async () => {
  await withWorld(async ({ home, stateDir }) => {
    installPlugin(home, INSTALLED);
    const service = await fakeService({ kind: "json", body: healthBody(INSTALLED) });
    try {
      publishService(stateDir, service.port);
      const emitted = await mkApp().status();
      assert.equal(service.requests(), 1, "le service a bien été sondé");
      assert.ok(emitted.some((notice) => notice.message.startsWith("[service] en marche")));
      assert.deepEqual(
        emitted.filter((notice) => notice.message.includes("écart de version")),
        [],
      );
    } finally {
      await service.close();
    }
  });
});

test("service-version-drift-detection/AC-5 : service arrêté, injoignable ou 401 ⇒ aucun écart, ni par `/service status` ni au démarrage d'une session", async () => {
  type Setup = { label: string; arrange: (stateDir: string) => Promise<() => Promise<void>> };
  const setups: Setup[] = [
    { label: "arrêté (aucun service.json)", arrange: async () => async () => {} },
    {
      label: "injoignable (port fermé)",
      arrange: async (stateDir) => {
        publishService(stateDir, await closedPort());
        return async () => {};
      },
    },
    {
      label: "401 (jeton refusé)",
      arrange: async (stateDir) => {
        const service = await fakeService({ kind: "json", body: healthBody("0.0.1") });
        publishService(stateDir, service.port, "e".repeat(32));
        return service.close;
      },
    },
  ];
  for (const { label, arrange } of setups) {
    await withWorld(async ({ home, stateDir }) => {
      installPlugin(home, INSTALLED);
      const cleanup = await arrange(stateDir);
      try {
        const viaStatus = mkApp();
        await viaStatus.status();
        assert.deepEqual(viaStatus.drifts(), [], `/service status — ${label}`);

        const viaSession = mkApp();
        await viaSession.start({ hasUI: true });
        await sleep(SERVICE_VERSION_PROBE_TIMEOUT_MS + 1000);
        assert.deepEqual(viaSession.drifts(), [], `session_start — ${label}`);
      } finally {
        await cleanup();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// S-3 : au démarrage d'une session interactive non enfant
// ---------------------------------------------------------------------------

test("service-version-drift-detection/AC-6 : une session interactive signale l'écart (ancien, récent, absent), rien à versions égales", async () => {
  const cases: Array<{ exposed: string | undefined; expected: string }> = [
    { exposed: "0.0.1", expected: driftExposed("0.0.1") },
    { exposed: "999.0.0", expected: driftExposed("999.0.0") },
    { exposed: undefined, expected: DRIFT_ABSENT },
  ];
  for (const { exposed, expected } of cases) {
    await withWorld(async ({ home, stateDir }) => {
      installPlugin(home, INSTALLED);
      const service = await fakeService({ kind: "json", body: healthBody(exposed) });
      try {
        publishService(stateDir, service.port);
        const app = mkApp();
        await app.start({ hasUI: true });
        assert.ok(await waitUntil(() => app.drifts().length > 0), `signalement émis — ${exposed ?? "(absente)"}`);
        assert.deepEqual(app.drifts(), [{ message: expected, tone: "warning" }]);
      } finally {
        await service.close();
      }
    });
  }

  await withWorld(async ({ home, stateDir }) => {
    installPlugin(home, INSTALLED);
    const service = await fakeService({ kind: "json", body: healthBody(INSTALLED) });
    try {
      publishService(stateDir, service.port);
      const app = mkApp();
      await app.start({ hasUI: true });
      assert.ok(await waitUntil(() => service.requests() === 1), "la sonde est partie");
      await sleep(SERVICE_VERSION_PROBE_TIMEOUT_MS + 1000);
      assert.deepEqual(app.drifts(), [], "versions identiques : silence");
    } finally {
      await service.close();
    }
  });
});

test("service-version-drift-detection/AC-7 : ni le service, ni une session hébergée, ni un sous-agent, ni un enfant de lot ne contrôlent", async () => {
  await withWorld(async ({ home, stateDir }) => {
    installPlugin(home, INSTALLED);
    const service = await fakeService({ kind: "json", body: healthBody("0.0.1") });
    try {
      publishService(stateDir, service.port);
      const silent: Array<{ drifts: () => Notice[] }> = [];

      // (a) le process du service (drapeau --pipeline-service)
      const serviceProcess = mkApp({ [SERVICE_FLAG]: true });
      await serviceProcess.start({ hasUI: true });
      silent.push(serviceProcess);

      // (b) une session hébergée par le service (marqueur de process posé)
      const hosted = mkApp();
      markServiceProcess(true);
      try {
        await hosted.start({ hasUI: true });
      } finally {
        markServiceProcess(false);
      }
      silent.push(hosted);

      // (c) un sous-agent (en-tête `parentSession`)
      const subagent = mkApp();
      await subagent.start({ hasUI: true, sessionFile: subagentSessionFile() });
      silent.push(subagent);

      // (d) un enfant de lot (drapeaux de maillon)
      const child = mkApp({ "pipeline-lot": "lot-1", "pipeline-feature": "alpha", "pipeline-phase": "impl" });
      await child.start({ hasUI: true });
      silent.push(child);

      // Le témoin : une session interactive ordinaire, qui, elle, sonde et signale.
      const witness = mkApp();
      await witness.start({ hasUI: true });
      assert.ok(await waitUntil(() => witness.drifts().length > 0), "le témoin signale l'écart");
      await sleep(SERVICE_VERSION_PROBE_TIMEOUT_MS + 1000);

      assert.equal(service.requests(), 1, "seul le témoin a sondé le service");
      silent.forEach((app, at) => {
        assert.deepEqual(app.drifts(), [], `cas ${"abcd"[at]} : aucun signalement`);
      });
    } finally {
      await service.close();
    }
  });
});

test("service-version-drift-detection/AC-8 : un service muet ne retarde pas l'ouverture de la session et ne produit aucun signalement", async () => {
  await withWorld(async ({ home, stateDir }) => {
    installPlugin(home, INSTALLED);
    const service = await fakeService({ kind: "hang" });
    try {
      publishService(stateDir, service.port);
      const app = mkApp();
      const begun = performance.now();
      await app.start({ hasUI: true });
      const elapsed = performance.now() - begun;
      assert.ok(elapsed < SERVICE_VERSION_PROBE_TIMEOUT_MS, `session_start rendu en ${Math.round(elapsed)} ms`);
      assert.ok(await waitUntil(() => service.requests() === 1), "la sonde a atteint le service");
      await sleep(SERVICE_VERSION_PROBE_TIMEOUT_MS + 1000);
      assert.deepEqual(app.drifts(), [], "sonde abandonnée à la borne, aucun signalement");
    } finally {
      await service.close();
    }
  });
});

// S-5 : le pas 5 de `### Installer une nouvelle version`, de la ligne `5. ` à la fin
// de la sous-section, aplati. Rend la liste des manques (vide = conforme).
function step5Gaps(doc: string): string[] {
  const start = doc.indexOf("\n### Installer une nouvelle version\n");
  if (start < 0) return ["sous-section `### Installer une nouvelle version` introuvable"];
  const rest = doc.slice(start + 1);
  const next = rest.search(/\n#{1,3} /);
  const subsection = next < 0 ? rest : rest.slice(0, next + 1);
  const step = subsection.search(/^5\. /m);
  if (step < 0) return ["pas 5 introuvable"];
  const text = subsection.slice(step).replace(/\s+/g, " ");
  const gaps: string[] = [];
  if (!text.includes("`/service status`")) gaps.push("`/service status` absent du pas 5");
  if (!text.includes("aucun écart de version")) gaps.push("« aucun écart de version » absent du pas 5");
  return gaps;
}

test("service-version-drift-detection/AC-11 : le pas 5 de PUBLISHING.md fait constater que /service status ne signale aucun écart de version", () => {
  const doc = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  assert.deepEqual(step5Gaps(doc), [], "PUBLISHING.md réel");
  const mutated = doc.replace(/ Constate aussi que `\/service status`[\s\S]*?lis son\s+message\./, "");
  assert.notEqual(mutated, doc, "la phrase de S-5 est présente dans le document réel");
  assert.deepEqual(step5Gaps(mutated), ["« aucun écart de version » absent du pas 5"], "copie mutée, phrase retirée");
});
