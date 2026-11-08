// Feature harness-observabilite : journaux JSON (contrat C1), erreurs des clients (C2),
// `GET /metrics` au format Prometheus, points de santé persistés, santé de la mémoire,
// sauvegardes distantes et cibles de notification dédoublonnées.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { Backups, listBackups } from "../../omp-harness/backup.ts";
import { defaultConfig, loadConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { Logger, logDir } from "../../omp-harness/logger.ts";
import type { LogRecord } from "../../omp-harness/logger.ts";
import { startHarness } from "../../omp-harness/main.ts";
import { Notifier } from "../../omp-harness/notify.ts";
import { CLIENT_ERRORS_PER_MIN } from "../../omp-harness/observability.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import { OK, fakeWorld, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);

/** Le service HTTP d'un orchestrateur, avec un client viewer `tableau` et un viewer borné au dépôt `autre`. */
async function serve(orchestrator: Orchestrator) {
  const clients = new ClientRegistry(path.join(tmpdir("harness-observabilite-"), "clients.json"), ADMIN);
  const viewer = clients.add("tableau", "viewer", "*").token;
  const bounded = clients.add("borne", "viewer", ["autre"]).token;
  const server = http.createServer(createHandler({ orchestrator, clients, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, token: string | null, body?: unknown) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  };
  /** Le flux SSE lu jusqu'à `event: <until>`, `fire` lancé une fois le flux ouvert. */
  const stream = async (route: string, token: string, fire: () => Promise<unknown>, until: string) => {
    const controller = new AbortController();
    const response = await fetch(`${url}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    // Les en-têtes reçus, le serveur pose encore son abonnement après le rejeu : un court délai, comme harness-monitoring.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fire();
    try {
      while (!text.includes(`event: ${until}\n`)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
    } finally {
      controller.abort();
    }
    return text;
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { call, stream, close, viewer, bounded };
}

/** Une exposition Prometheus lue : les types par famille et les échantillons (nom, étiquettes, valeur). */
function parseExposition(text: string) {
  const types = new Map<string, string>();
  const samples: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const type = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram|summary|untyped)$/.exec(line);
    if (type) {
      types.set(type[1] as string, type[2] as string);
      continue;
    }
    if (line.startsWith("# HELP ")) continue;
    const sample = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    assert.ok(sample, `ligne d'exposition illisible : ${line}`);
    const labels: Record<string, string> = {};
    for (const pair of (sample[2] ?? "").matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g))
      labels[pair[1] as string] = (pair[2] as string).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
    const value = sample[3] === "+Inf" ? Number.POSITIVE_INFINITY : Number(sample[3]);
    assert.ok(!Number.isNaN(value), `valeur illisible : ${line}`);
    samples.push({ name: sample[1] as string, labels, value });
  }
  const family = (name: string) => name.replace(/_(bucket|sum|count)$/, "");
  for (const sample of samples)
    assert.ok(types.has(sample.name) || types.get(family(sample.name)) === "histogram", `${sample.name} sans # TYPE`);
  const value = (name: string, labels: Record<string, string> = {}) =>
    samples.find(
      (sample) =>
        sample.name === name && Object.entries(labels).every(([key, wanted]) => sample.labels[key] === wanted),
    )?.value;
  return { types, samples, value };
}

function readJsonl(file: string): LogRecord[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

test("harness-observabilite/AC-1 : ctx.log écrit une ligne JSON C1 par événement dans <logs>/harness-AAAA-MM-JJ.jsonl et sur la sortie, avec runId et dépôt quand ils sont connus ; les fichiers plus vieux que logs.retentionDays partent", async () => {
  const world = fakeWorld({});
  const dir = path.join(tmpdir("harness-observabilite-logs-"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "harness-2000-01-01.jsonl"), "{}\n");
  fs.writeFileSync(path.join(dir, "mem0-2000-01-01.jsonl"), "{}\n");
  const printed: string[] = [];
  const logger = new Logger({
    src: "harness",
    dir,
    retentionDays: 14,
    stderr: (_record, json) => printed.push(json),
  });
  // Le rappel de l'oracle en panne : la déduction des modules d'un run échoue et le journalise.
  world.oracle.recall = async () => {
    throw new Error("mémoire en panne");
  };
  const orchestrator = new Orchestrator({ ...world.deps, log: logger.line });
  const run = orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
  const file = path.join(dir, `harness-${new Date().toISOString().slice(0, 10)}.jsonl`);
  await waitFor(
    () => fs.existsSync(file) && readJsonl(file).some((line) => line.runId === run.id),
    () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "aucun fichier"),
  );
  const line = readJsonl(file).find((entry) => entry.runId === run.id) as LogRecord;
  assert.deepEqual(Object.keys(line).sort(), ["level", "msg", "repo", "runId", "src", "ts"]);
  assert.equal(line.src, "harness");
  assert.equal(line.level, "warn");
  assert.equal(line.repo, "demo");
  assert.match(line.msg, /modules non déduits — mémoire en panne/);
  assert.equal(new Date(line.ts).toISOString(), line.ts, "un horodatage ISO 8601");
  assert.ok(printed.includes(JSON.stringify(line)), "la même ligne sur la sortie");
  assert.ok(!fs.existsSync(path.join(dir, "harness-2000-01-01.jsonl")), "le fichier trop vieux est retiré");
  assert.ok(fs.existsSync(path.join(dir, "mem0-2000-01-01.jsonl")), "celui d'une autre source reste");

  // Une erreur garde son message et sa pile ; le niveau minimal écarte le debug.
  logger.error("échec", { err: new Error("boum"), event: "backup_failed" });
  logger.debug("bavard");
  const last = readJsonl(file).at(-1) as LogRecord;
  assert.equal(last.event, "backup_failed");
  assert.equal(last.err?.message, "boum");
  assert.match(last.err?.stack ?? "", /boum/);
  assert.ok(!readJsonl(file).some((entry) => entry.msg === "bavard"));
  assert.equal(logDir(defaultConfig("/srv/omp")), "/srv/omp/logs");
});

test("harness-observabilite/AC-2 : POST /v1/client-errors rend 202, l'erreur se relit par GET (filtres since et source), part en événement SSE client_error et au journal ; une source inconnue est un 400, la 61e de la minute un 429 avec Retry-After", async () => {
  const world = fakeWorld({});
  const lines: { msg: string; level?: string }[] = [];
  const orchestrator = new Orchestrator({
    ...world.deps,
    log: (msg, fields) => lines.push({ msg, level: fields?.level }),
  });
  const api = await serve(orchestrator);
  try {
    const report = {
      source: "ios",
      version: "1.4.0",
      kind: "decode",
      message: "HarnessStatus illisible",
      context: { route: "/v1/status" },
    };
    const text = await api.stream(
      `/v1/events?after=${world.store.lastEventId()}`,
      api.viewer,
      async () => assert.equal((await api.call("POST", "/v1/client-errors", api.viewer, report)).status, 202),
      "client_error",
    );
    assert.match(text, /event: client_error\n/);
    assert.match(text, /HarnessStatus illisible/);
    assert.ok(
      lines.some((line) => line.level === "error" && /erreur client ios 1\.4\.0 \(decode, tableau\)/.test(line.msg)),
    );

    const listed = JSON.parse((await api.call("GET", "/v1/client-errors?source=ios", api.viewer)).text) as {
      errors: { client: string; source: string; kind: string; context: unknown }[];
    };
    assert.deepEqual(
      listed.errors.map((error) => [error.client, error.source, error.kind, error.context]),
      [["tableau", "ios", "decode", { route: "/v1/status" }]],
    );
    assert.equal(
      JSON.parse((await api.call("GET", "/v1/client-errors?source=chrome", api.viewer)).text).errors.length,
      0,
    );
    assert.equal(
      JSON.parse((await api.call("GET", `/v1/client-errors?since=${Date.now() + 60_000}`, api.viewer)).text).errors
        .length,
      0,
    );
    // Un client borné à des dépôts ne relit que ses propres erreurs.
    assert.equal(JSON.parse((await api.call("GET", "/v1/client-errors", api.bounded)).text).errors.length, 0);

    assert.equal(
      (await api.call("POST", "/v1/client-errors", api.viewer, { ...report, source: "android" })).status,
      400,
    );
    assert.equal((await api.call("POST", "/v1/client-errors", api.viewer, { ...report, message: "" })).status, 400);
    assert.equal((await api.call("POST", "/v1/client-errors", null, report)).status, 401);
    for (let i = 1; i < CLIENT_ERRORS_PER_MIN; i++)
      assert.equal((await api.call("POST", "/v1/client-errors", api.viewer, report)).status, 202);
    const refused = await api.call("POST", "/v1/client-errors", api.viewer, report);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    // La borne est par client : un autre client passe encore.
    assert.equal(
      (await api.call("POST", "/v1/client-errors", api.bounded, { ...report, source: "chrome" })).status,
      202,
    );
    assert.equal(world.store.listClientErrors({ limit: 1000 }).length, CLIENT_ERRORS_PER_MIN + 1);
  } finally {
    await api.close();
  }
});

test("harness-observabilite/AC-3 : GET /metrics rend une exposition Prometheus valide (types, étiquettes) cohérente après un run du faux runner — runs par état, durées d'étapes, coût et jetons, slots, requêtes HTTP, flux SSE ; 401 sans jeton, 403 à un client borné", async () => {
  const world: FakeWorld = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  const api = await serve(world.orchestrator);
  try {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter les données en CSV",
    });
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.state),
      30_000,
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged");
    // La consommation d'un message d'agent, telle que la session la note.
    world.store.addUsage({
      runId: run.id,
      auditId: null,
      repo: "demo",
      step: "impl",
      provider: "anthropic",
      model: "claude-test",
      input: 1000,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 0.25,
    });
    world.store.addClientError({ client: "x", source: "mac", version: "1", kind: "k", message: "m", context: null });
    assert.equal((await api.call("GET", "/v1/status", api.viewer)).status, 200);

    assert.equal((await api.call("GET", "/metrics", null)).status, 401);
    assert.equal((await api.call("GET", "/metrics", api.bounded)).status, 403);
    const response = await api.call("GET", "/metrics", api.viewer);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const { types, value, samples } = parseExposition(response.text);
    assert.equal(types.get("omp_harness_runs"), "gauge");
    assert.equal(types.get("omp_harness_step_duration_seconds"), "histogram");
    assert.equal(types.get("omp_harness_cost_usd_total"), "counter");
    assert.equal(types.get("omp_harness_http_requests_total"), "counter");
    assert.equal(value("omp_harness_runs", { repo: "demo", state: "merged" }), 1);
    assert.equal(value("omp_harness_runs", { repo: "demo", state: "failed" }), 0);
    // Quatre étapes réussies : une observation par étape, dans le compte et dans le seau +Inf.
    const steps = world.store.listSteps(run.id).filter((step) => step.status === "done").length;
    const counted = samples
      .filter((sample) => sample.name === "omp_harness_step_duration_seconds_count" && sample.labels.repo === "demo")
      .reduce((sum, sample) => sum + sample.value, 0);
    assert.equal(counted, steps);
    assert.equal(
      value("omp_harness_step_duration_seconds_bucket", { repo: "demo", step: "impl", status: "done", le: "+Inf" }),
      1,
    );
    assert.equal(value("omp_harness_cost_usd_total", { repo: "demo", model: "anthropic/claude-test" }), 0.25);
    assert.equal(
      value("omp_harness_tokens_total", { repo: "demo", model: "anthropic/claude-test", kind: "input" }),
      1000,
    );
    assert.equal(value("omp_harness_slots_capacity", { kind: "runner" }), world.config.runner.slots);
    assert.equal(value("omp_harness_slots_used", { kind: "runner" }), 0);
    assert.equal(value("omp_harness_alerts", { kind: "stalled" }), 0);
    assert.equal(value("omp_harness_oracle_lost_writes_total"), 0);
    assert.equal(
      value("omp_harness_http_requests_total", { route: "/v1/status", method: "GET", status: "200" }),
      1,
      "la route est son motif, le statut une étiquette",
    );
    assert.equal(value("omp_harness_http_requests_total", { route: "/metrics", method: "GET", status: "401" }), 1);
    assert.equal(value("omp_harness_http_request_duration_seconds_count", { route: "/v1/status", method: "GET" }), 1);
    assert.equal(value("omp_harness_sse_clients"), 0);
    assert.equal(value("omp_harness_workstation_online"), 0);

    // Un flux SSE ouvert se compte.
    await api.stream(
      "/v1/events?after=0",
      api.viewer,
      async () => {
        const open = parseExposition((await api.call("GET", "/metrics", api.viewer)).text);
        assert.equal(open.value("omp_harness_sse_clients"), 1);
      },
      "run_created",
    );
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-observabilite/AC-4 : les points de GET /v1/metrics sont en base — un redémarrage les garde, `?since=` les filtre, metrics.retentionDays élague les vieux", async () => {
  const world = fakeWorld({});
  const first = world.orchestrator.metrics.sample();
  world.store.close();

  // Le redémarrage : une nouvelle base ouverte sur le même fichier, un nouvel orchestrateur.
  const store = new Store(path.join(world.config.dataDir, "harness.sqlite"));
  const restarted = new Orchestrator({ ...world.deps, store });
  assert.deepEqual(
    restarted.metrics.samples().map((point) => point.at),
    [first.at],
  );
  const old = Date.now() - (world.config.metrics.retentionDays + 1) * 86_400_000;
  store.addMetricSample(old, { ...first, at: old });
  const second = restarted.metrics.sample();
  const api = await serve(restarted);
  try {
    const all = JSON.parse((await api.call("GET", "/v1/metrics", api.viewer)).text) as { samples: { at: number }[] };
    assert.deepEqual(
      all.samples.map((point) => point.at),
      [old, first.at, second.at],
    );
    const since = JSON.parse((await api.call("GET", `/v1/metrics?since=${second.at}`, api.viewer)).text) as {
      samples: { at: number }[];
    };
    assert.deepEqual(
      since.samples.map((point) => point.at),
      [second.at],
    );
    restarted.observability.tick();
    assert.deepEqual(
      restarted.metrics.samples().map((point) => point.at),
      [first.at, second.at],
      "le point de plus de retentionDays est purgé",
    );
  } finally {
    await api.close();
    store.close();
  }
});

test("harness-observabilite/AC-5 : backups.remote reçoit le chemin de chaque instantané ; un échec, distant ou local, émet backup_failed (notifié), et GET /v1/status le montre", async () => {
  const remoteDir = tmpdir("harness-observabilite-distant-");
  const received: { body: string; type: string | undefined }[] = [];
  const hook = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ body, type: request.headers["content-type"] });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
  const webhook = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/alertes`;
  const copy = [
    process.execPath,
    "-e",
    "require('node:fs').copyFileSync(process.argv[1], process.argv[2])",
    "{file}",
    path.join(remoteDir, "{name}"),
  ];
  const config = testConfig(harnessRepo(), (c) => {
    c.backups.remote = { command: copy, timeoutSec: 30 };
    c.notify.targets = [{ kind: "webhook", url: webhook, headers: {} }];
  });
  const harness = await startHarness(config, { token: ADMIN, log: () => {} });
  try {
    await waitFor(
      () => fs.readdirSync(remoteDir).length === 1,
      () => "aucune copie distante",
    );
    const local = listBackups(path.join(config.dataDir, "backups"), "periodique")[0]?.file as string;
    assert.deepEqual(fs.readdirSync(remoteDir), [path.basename(local)], "la commande a reçu le chemin et le nom");
    await waitFor(
      () => harness.orchestrator.observability.backupStatus().remote.lastAt !== null,
      () => JSON.stringify(harness.orchestrator.observability.backupStatus()),
    );
  } finally {
    await harness.stop();
  }

  // La même base, une copie distante qui échoue : l'événement, la notification, le statut.
  config.backups.remote = { command: ["sh", "-c", "echo 'destination refusée' >&2; exit 3"], timeoutSec: 30 };
  // Sans instantané périodique sur le disque, le prochain démarrage en prend un tout de suite.
  fs.rmSync(path.join(config.dataDir, "backups"), { recursive: true, force: true });
  const failing = await startHarness(config, { token: ADMIN, log: () => {} });
  try {
    await waitFor(
      () => failing.store.eventsSince(0).some((event) => event.type === "backup_failed"),
      () => "aucun backup_failed",
    );
    const event = failing.store.eventsSince(0).find((entry) => entry.type === "backup_failed");
    assert.equal(event?.payload.where, "remote");
    assert.match(String(event?.payload.detail), /code 3 — destination refusée/);
    await waitFor(
      () => received.some((post) => post.body.includes("backup_failed")),
      () => JSON.stringify(received),
    );
    const posted = JSON.parse(received.find((post) => post.body.includes("backup_failed"))?.body ?? "{}");
    assert.equal(posted.title, "Copie distante de la sauvegarde échouée");
    assert.equal(received[0]?.type, "application/json");
    const api = await serve(failing.orchestrator);
    try {
      const status = JSON.parse((await api.call("GET", "/v1/status", api.viewer)).text) as {
        backups: { lastAt: number | null; remote: { configured: boolean; lastError: string | null } };
        memory: { configured: boolean; ok: boolean };
      };
      assert.equal(status.backups.remote.configured, true);
      assert.match(String(status.backups.remote.lastError), /destination refusée/);
      assert.ok(status.backups.lastAt !== null, "la copie locale, elle, a réussi");
      assert.deepEqual([status.memory.configured, status.memory.ok], [false, false]);
    } finally {
      await api.close();
    }
  } finally {
    await failing.stop();
  }

  // Un instantané local impossible (un fichier à la place du dossier) : backup_failed `local`.
  const world = fakeWorld({});
  const blocked = path.join(tmpdir("harness-observabilite-"), "bloque");
  fs.writeFileSync(blocked, "");
  const backups = new Backups({
    db: world.store.db,
    dir: blocked,
    intervalHours: 24,
    keep: 7,
    log: () => {},
    report: (outcome) => world.orchestrator.observability.recordBackup(outcome),
  });
  assert.equal(backups.run(), null);
  const local = world.store.eventsSince(0).find((entry) => entry.type === "backup_failed");
  assert.equal(local?.payload.where, "local");
  assert.ok(world.orchestrator.observability.backupStatus().lastError !== null);
  hook.closeAllConnections();
  await new Promise<void>((resolve) => hook.close(() => resolve()));
});

test("harness-observabilite/AC-6 : la santé de la mémoire (version, souvenirs, taille, dernier instantané) entre dans GET /v1/status et dans le rapport du matin ; injoignable, ok passe à false", async () => {
  const world = fakeWorld({}, { patch: (c) => (c.oracle = { url: "http://127.0.0.1:1", token: null }) });
  world.oracle.healthBody = {
    ok: true,
    mem0: "mem0-rs 0.2.0",
    version: "0.2.0",
    uptime_s: 42,
    memories: 1234,
    db_bytes: 5 * 1024 * 1024,
    last_backup_at: "2026-11-07T03:00:00Z",
    last_backup_error: null,
  };
  const api = await serve(world.orchestrator);
  try {
    const status = JSON.parse((await api.call("GET", "/v1/status", api.viewer)).text) as Record<string, unknown>;
    assert.deepEqual(
      { ...(status.memory as Record<string, unknown>), checkedAt: 0 },
      {
        configured: true,
        ok: true,
        version: "0.2.0",
        uptimeSec: 42,
        memories: 1234,
        dbBytes: 5 * 1024 * 1024,
        lastBackupAt: "2026-11-07T03:00:00Z",
        lastBackupError: null,
        checkedAt: 0,
      },
    );
    const digest = JSON.parse((await api.call("GET", "/v1/digest", api.viewer)).text) as { text: string };
    assert.match(
      digest.text,
      /## Santé \(\d\)\n- Mémoire 0\.2\.0, 1234 souvenir\(s\), base 5\.0 Mio, dernier instantané 2026-11-07 03:00 UTC/,
    );
    // Un client borné à des dépôts n'a pas la section santé du serveur.
    const bounded = JSON.parse((await api.call("GET", "/v1/digest", api.bounded)).text) as { text: string };
    assert.ok(!bounded.text.includes("## Santé"), bounded.text);

    world.oracle.healthy = false;
    const down = await world.orchestrator.observability.memoryStatus(0);
    assert.deepEqual([down.configured, down.ok, down.memories], [true, false, null]);
    const downDigest = JSON.parse((await api.call("GET", "/v1/digest", api.viewer)).text) as { text: string };
    assert.match(downDigest.text, /## Santé \(\d\)\n- Mémoire injoignable/);
  } finally {
    await api.close();
  }
});

test("harness-observabilite/AC-7 : notify envoie à chaque cible (ntfy et webhook JSON) et ne renvoie pas la même alerte avant notify.dedupMin minutes", async () => {
  const posts: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      posts.push({ path: request.url ?? "", headers: request.headers, body });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let now = 1_000_000;
  const config = testConfig(harnessRepo(), (c) => {
    c.notify.url = `${base}/ntfy`;
    c.notify.targets = [{ kind: "webhook", url: `${base}/hook`, headers: { Authorization: "Bearer secret" } }];
    c.notify.dedupMin = 30;
  });
  const store = new Store(path.join(tmpdir("harness-observabilite-"), "h.sqlite"));
  const notifier = new Notifier({ config, store, now: () => now });
  notifier.subscribe();
  store.createRun({ id: "r1", repo: "demo", slug: "x", title: "Export CSV", request: "x", branch: "harness/x" });
  try {
    store.appendEvent("run_failed", "r1", { reason: "runner mort" });
    store.appendEvent("run_failed", "r1", { reason: "runner mort" });
    await notifier.idle();
    assert.deepEqual(posts.map((post) => post.path).sort(), ["/hook", "/ntfy"], "une alerte, une fois par cible");
    const hook = posts.find((post) => post.path === "/hook");
    assert.equal(hook?.headers.authorization, "Bearer secret");
    assert.deepEqual(
      (({ title, body, event, runId, repo }) => ({ title, body, event, runId, repo }))(JSON.parse(hook?.body ?? "{}")),
      { title: "Run échoué — demo · Export CSV", body: "runner mort", event: "run_failed", runId: "r1", repo: "demo" },
    );
    assert.equal(posts.find((post) => post.path === "/ntfy")?.body, "runner mort");

    store.appendEvent("run_failed", "r1", { reason: "autre cause" });
    now += 31 * 60_000;
    store.appendEvent("run_failed", "r1", { reason: "runner mort" });
    await notifier.idle();
    assert.equal(posts.length, 6, "une autre alerte part ; la même repart après la fenêtre");
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("harness-observabilite/AC-8 : la configuration valide logs, metrics, backups.remote et notify.targets en nommant la clé fautive ; les défauts gardent le comportement d'avant", () => {
  const config = defaultConfig("/tmp/x");
  assert.deepEqual(config.logs, { dir: null, retentionDays: 14, level: "info" });
  assert.deepEqual(config.metrics, { retentionDays: 7 });
  assert.deepEqual([config.backups.remote, config.notify.targets], [null, []]);
  const dir = tmpdir("harness-observabilite-conf-");
  const load = (raw: Record<string, unknown>) => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ dataDir: dir, ...raw }));
    return loadConfig(file);
  };
  assert.deepEqual(
    load({ backups: { remote: { command: ["rclone", "copyto", "{file}", "b2:omp/{name}"] } } }).backups.remote,
    {
      command: ["rclone", "copyto", "{file}", "b2:omp/{name}"],
      timeoutSec: 600,
    },
  );
  assert.throws(() => load({ backups: { remote: { command: [] } } }), /backups\.remote/);
  assert.throws(() => load({ logs: { level: "trace" } }), /logs\.level/);
  assert.throws(() => load({ logs: { dir: "relatif" } }), /logs\.dir/);
  assert.throws(() => load({ metrics: { retentionDays: 0 } }), /metrics\.retentionDays/);
  assert.throws(() => load({ notify: { targets: [{ kind: "slack", url: "https://x" }] } }), /notify\.targets\[0\]/);
  assert.throws(() => load({ notify: { dedupMin: -1 } }), /notify\.dedupMin/);
  assert.deepEqual(
    load({ notify: { targets: [{ kind: "webhook", url: "https://hooks.example/a" }] } }).notify.targets,
    [{ kind: "webhook", url: "https://hooks.example/a", headers: {} }],
  );
});
