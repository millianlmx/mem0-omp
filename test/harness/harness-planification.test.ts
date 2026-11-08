// Feature harness-planification : des planifications récurrentes (cron à cinq champs, fuseau
// `schedules.timezone`) qui lancent seules un run, un audit ou une relève d'issues — une fois
// par échéance, sans rafale après un arrêt, sans empilement, sous le plafond journalier —
// pilotées par l'API REST (`/v1/schedules`) et le MCP.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { defaultConfig, repoDefaults, validateConfig } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { nextOccurrence, parseCron } from "../../omp-harness/cron.ts";
import type { ScheduleOutcome, ScheduleRow } from "../../omp-harness/db.ts";
import { digestOf } from "../../omp-harness/digest.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { ScheduleInput } from "../../omp-harness/schedules.ts";
import { OK, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Les `n` échéances qui suivent `from`, en ISO, dans le fuseau donné. */
function upcoming(expr: string, from: string, n: number, tz = "Europe/Paris"): (string | null)[] {
  const cron = parseCron(expr);
  const out: (string | null)[] = [];
  let after = at(from);
  for (let i = 0; i < n; i++) {
    const next = nextOccurrence(cron, after, tz);
    out.push(iso(next));
    if (next === null) break;
    after = next;
  }
  return out;
}

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

/** Un `gh` doublé sur `moi/demo` : une issue ouverte #3 qui porte `omp:fix`. */
const fakeGh: Exec = async (command, args, options) => {
  if (command !== "gh") return execProcess(command, args, options);
  const issue = {
    number: 3,
    title: "Le bouton ne répond pas",
    url: "https://github.com/moi/demo/issues/3",
    labels: [{ name: "omp:fix" }],
    author: { login: "alice" },
    createdAt: "2026-11-01T10:00:00Z",
    body: "Rien ne se passe au clic.",
    state: "OPEN",
    comments: [],
  };
  if (args[0] === "issue" && args[1] === "list") return done(JSON.stringify([issue]));
  if (args[0] === "issue" && args[1] === "view") return done(JSON.stringify(issue));
  return done("", 1, `commande gh inattendue : ${args.join(" ")}`);
};

/** Un harness sans slot runner (les runs lancés restent en file), dont `demo` pousse vers `moi/demo`. */
function scheduleWorld(patch: (config: HarnessConfig) => void = () => {}) {
  const world = fakeWorld(
    {},
    {
      exec: fakeGh,
      patch: (config) => {
        config.runner.slots = 0;
        config.issues.pollSec = null;
        for (const repo of config.repos) repo.remote = "origin";
        patch?.(config);
      },
    },
  );
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  return { world, schedules: world.orchestrator.schedules };
}

function runSchedule(cron: string, extra: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    name: "Veille Y",
    cron,
    target: { kind: "run", repo: "demo", title: "Relancer la veille Y", request: "relance la veille Y" },
    enabled: true,
    ...extra,
  };
}

function scheduleEvents(world: ReturnType<typeof fakeWorld>, id: string) {
  return world.store
    .eventsSince(0)
    .filter((event) => event.type.startsWith("schedule_") && event.payload.scheduleId === id);
}

test("harness-planification/AC-1 : le cron lit `*`, listes, plages, pas et noms (anglais ou français), et rend les prochaines échéances dans le fuseau", () => {
  // Lundi 9 nov. 2026 : 8 h à Paris = 07:00Z (heure d'hiver).
  assert.deepEqual(upcoming("0 8 * * 1-5", "2026-11-07T10:00:00Z", 3), [
    "2026-11-09T07:00:00.000Z",
    "2026-11-10T07:00:00.000Z",
    "2026-11-11T07:00:00.000Z",
  ]);
  assert.deepEqual(upcoming("*/20 9-10 * * mon,MER", "2026-11-09T09:30:00Z", 4), [
    "2026-11-09T09:40:00.000Z",
    "2026-11-11T08:00:00.000Z",
    "2026-11-11T08:20:00.000Z",
    "2026-11-11T08:40:00.000Z",
  ]);
  // `a/n` part de a jusqu'au bout du champ ; une liste mêle valeurs et plages.
  assert.deepEqual(upcoming("5/20 * * * *", "2026-11-07T10:00:00Z", 3, "UTC"), [
    "2026-11-07T10:05:00.000Z",
    "2026-11-07T10:25:00.000Z",
    "2026-11-07T10:45:00.000Z",
  ]);
  assert.deepEqual(upcoming("0 1,3-4 * * *", "2026-11-07T00:30:00Z", 3, "UTC"), [
    "2026-11-07T01:00:00.000Z",
    "2026-11-07T03:00:00.000Z",
    "2026-11-07T04:00:00.000Z",
  ]);
  // 7 = dimanche ; noms de mois français, accents ignorés.
  assert.deepEqual(upcoming("0 8 * * 7", "2026-11-07T10:00:00Z", 1), ["2026-11-08T07:00:00.000Z"]);
  assert.deepEqual(upcoming("0 9 1 janv,Juil *", "2026-11-07T10:00:00Z", 2), [
    "2027-01-01T08:00:00.000Z",
    "2027-07-01T07:00:00.000Z",
  ]);
  assert.deepEqual(upcoming("0 0 1 Août *", "2026-11-07T10:00:00Z", 1, "UTC"), ["2027-08-01T00:00:00.000Z"]);
  // Jour du mois ET jour de semaine restreints : l'un OU l'autre (le 13, et chaque vendredi).
  assert.deepEqual(upcoming("0 0 13 * fri", "2026-11-01T00:00:00Z", 3, "UTC"), [
    "2026-11-06T00:00:00.000Z",
    "2026-11-13T00:00:00.000Z",
    "2026-11-20T00:00:00.000Z",
  ]);
  // Un 29 février : la prochaine année bissextile.
  assert.deepEqual(upcoming("0 0 29 2 *", "2026-01-01T00:00:00Z", 1, "UTC"), ["2028-02-29T00:00:00.000Z"]);
  // Strictement après : l'instant d'une échéance n'est pas sa propre suivante.
  assert.equal(
    iso(nextOccurrence(parseCron("0 8 * * *"), at("2026-11-09T07:00:00Z"), "Europe/Paris")),
    "2026-11-10T07:00:00.000Z",
  );
});

test("harness-planification/AC-2 : changements d'heure à Paris — l'heure sautée part décalée du saut, l'heure répétée ne part qu'une fois", () => {
  // 29 mars 2026 : 02:00 → 03:00. 02:30 n'existe pas : 03:30 CEST (01:30Z) ; 03:00 existe (01:00Z).
  assert.deepEqual(upcoming("30 2 * * *", "2026-03-28T12:00:00Z", 2), [
    "2026-03-29T01:30:00.000Z",
    "2026-03-30T00:30:00.000Z",
  ]);
  assert.deepEqual(upcoming("0 3 * * *", "2026-03-28T12:00:00Z", 2), [
    "2026-03-29T01:00:00.000Z",
    "2026-03-30T01:00:00.000Z",
  ]);
  // La veille : 8 h CET (07:00Z), le jour même 8 h CEST (06:00Z).
  assert.deepEqual(upcoming("0 8 * * *", "2026-03-28T00:00:00Z", 2), [
    "2026-03-28T07:00:00.000Z",
    "2026-03-29T06:00:00.000Z",
  ]);
  // 25 octobre 2026 : 03:00 → 02:00. 02:30 existe deux fois : une seule échéance, la première.
  assert.deepEqual(upcoming("30 2 * * *", "2026-10-24T12:00:00Z", 2), [
    "2026-10-25T00:30:00.000Z",
    "2026-10-26T01:30:00.000Z",
  ]);
  // Toutes les heures à travers le retour à l'heure d'hiver : 02:00 une fois, puis 03:00 CET.
  assert.deepEqual(upcoming("0 * * * *", "2026-10-24T23:30:00Z", 3), [
    "2026-10-25T00:00:00.000Z",
    "2026-10-25T02:00:00.000Z",
    "2026-10-25T03:00:00.000Z",
  ]);
});

test("harness-planification/AC-3 : une expression ou un fuseau invalides sont refusés, avec ce qui ne va pas", () => {
  for (const [expr, why] of [
    ["* * * *", /cinq champs/],
    ["60 * * * *", /minute : 60 hors de 0-59/],
    ["* 24 * * *", /heure : 24 hors de 0-23/],
    ["* * 0 * *", /jour du mois : 0 hors de 1-31/],
    ["* * * 13 *", /mois : 13 hors de 1-12/],
    ["* * * * 8", /jour de la semaine : 8 hors de 0-7/],
    ["5-1 * * * *", /décroissante/],
    ["*/0 * * * *", /pas/],
    ["* * * * lundy", /ni un nombre ni un nom/],
    ["1,,2 * * * *", /illisible/],
    ["1-2-3 * * * *", /illisible/],
  ] as const)
    assert.throws(
      () => parseCron(expr),
      (err: Error & { status?: number }) => err.status === 400 && why.test(err.message),
      expr,
    );
  // Une expression lisible qui n'échoit jamais.
  assert.equal(nextOccurrence(parseCron("0 0 30 2 *"), at("2026-01-01T00:00:00Z"), "UTC"), null);
  const config = defaultConfig(tmpdir("harness-planification-"));
  assert.equal(config.schedules.timezone, "Europe/Paris");
  config.schedules.timezone = "Europe/Parsi";
  assert.throws(() => validateConfig(config), /schedules\.timezone : fuseau IANA inconnu/);
  config.schedules.timezone = "UTC";
  config.schedules.catchUpMin = 0;
  assert.throws(() => validateConfig(config), /schedules\.catchUpMin/);
});

test("harness-planification/AC-4 : à l'échéance, le tour lance le run, l'audit ou la relève d'issues de sa cible, une seule fois, et note l'issue", async () => {
  const { world, schedules } = scheduleWorld();
  const created = at("2026-11-09T06:00:00Z"); // lundi, 7 h à Paris
  const veille = schedules.create(
    runSchedule("0 8 * * *", {
      target: {
        kind: "run",
        repo: "demo",
        title: "Relancer la veille Y",
        request: "relance la veille Y",
        priority: 5,
        lane: "full",
        budgetUsd: 2.5,
      },
    }),
    { by: "mac" },
    created,
  );
  const audit = schedules.create(
    {
      name: "Audit du lundi",
      cron: "0 9 * * lun",
      target: { kind: "audit", repo: "demo", focus: "sécurité" },
      enabled: true,
    },
    { by: "mac" },
    created,
  );
  const nuit = schedules.create(
    { name: "Issues de la nuit", cron: "0 2 * * *", target: { kind: "issues", repo: "demo" }, enabled: true },
    { by: "mac" },
    created,
  );
  assert.deepEqual(
    [veille, audit, nuit].map((s) => iso(s.nextRunAt)),
    ["2026-11-09T07:00:00.000Z", "2026-11-09T08:00:00.000Z", "2026-11-10T01:00:00.000Z"],
  );
  assert.equal(veille.createdBy, "mac");

  await schedules.tick(created + 30 * MINUTE);
  assert.equal(world.store.listRuns().length, 0, "rien avant l'échéance");

  // 8 h : le run part, avec la priorité, la voie et le budget propre de la cible.
  const eight = at("2026-11-09T07:00:20Z");
  await schedules.tick(eight);
  const runs = world.store.listRuns();
  assert.deepEqual(
    runs.map((run) => [run.title, run.request, run.priority, run.state]),
    [["Relancer la veille Y", "relance la veille Y", 5, "queued"]],
  );
  const budget = world.orchestrator.runView(runs[0]?.id as string).budget as { budget: number; source: string };
  assert.deepEqual([budget.budget, budget.source], [2.5, "run"]);
  const fired = world.store.getSchedule(veille.id) as ScheduleRow;
  assert.equal(fired.lastOutcome?.status, "fired");
  assert.deepEqual(fired.lastOutcome?.runIds, [runs[0]?.id]);
  assert.deepEqual(fired.lastFired, { kind: "run", ids: [runs[0]?.id] });
  assert.equal(fired.lastRunAt, eight);
  assert.equal(iso(fired.nextRunAt), "2026-11-10T07:00:00.000Z");
  const events = scheduleEvents(world, veille.id);
  assert.deepEqual(
    events.map((event) => [event.type, event.repo, event.payload.runIds]),
    [["schedule_fired", "demo", [runs[0]?.id]]],
  );
  // L'événement se notifie (s'il est dans `notify.events`).
  assert.match(notificationFor(events[0] as never, null)?.title ?? "", /Planification lancée — demo · Veille Y/);

  // Le même instant, de nouveau : rien ne repart.
  await schedules.tick(eight);
  assert.equal(world.store.listRuns().length, 1);

  // 9 h le lundi : l'audit part en file.
  await schedules.tick(at("2026-11-09T08:00:05Z"));
  const audits = world.store.listAudits([]);
  assert.deepEqual(
    audits.map((row) => [row.repo, row.focus, row.state]),
    [["demo", "sécurité", "queued"]],
  );
  assert.deepEqual(world.store.getSchedule(audit.id)?.lastFired, { kind: "audit", ids: [audits[0]?.id] });

  // 2 h la nuit : la relève lance l'issue du label par défaut.
  await schedules.tick(at("2026-11-10T01:00:05Z"));
  const issueRun = world.store.listRuns().find((run) => run.title.startsWith("Issue #3"));
  assert.ok(issueRun, "l'issue #3 est lancée en run");
  const harvest = world.store.getSchedule(nuit.id) as ScheduleRow;
  assert.equal(harvest.lastOutcome?.status, "fired");
  assert.deepEqual(harvest.lastOutcome?.runIds, [issueRun.id]);
  assert.match(harvest.lastOutcome?.detail ?? "", /omp:fix.*1 issue\(s\) lancée\(s\)/);
  assert.equal(iso(harvest.nextRunAt), "2026-11-11T01:00:00.000Z");

  // Une planification désactivée ne part pas.
  world.store.updateSchedule(veille.id, { enabled: false });
  await schedules.tick(at("2026-11-10T07:00:30Z"));
  assert.equal(world.store.listRuns().filter((run) => run.title === "Relancer la veille Y").length, 1);
  await world.orchestrator.stop();
});

test("harness-planification/AC-5 : pas d'empilement — tant que le run précédent n'est pas fini, l'échéance est sautée et notée ; fini, la suivante part", async () => {
  const { world, schedules } = scheduleWorld();
  const created = at("2026-11-09T10:00:00Z");
  const schedule = schedules.create(runSchedule("*/10 * * * *"), { by: "mac" }, created);
  await schedules.tick(at("2026-11-09T10:10:01Z"));
  const [first] = world.store.listRuns();
  assert.equal(first?.state, "queued");

  await schedules.tick(at("2026-11-09T10:20:01Z"));
  assert.equal(world.store.listRuns().length, 1, "le run précédent est encore en file : pas de second");
  const skipped = world.store.getSchedule(schedule.id) as ScheduleRow;
  assert.equal(skipped.lastOutcome?.status, "busy");
  assert.match(skipped.lastOutcome?.detail ?? "", new RegExp(`${first?.id}.*queued`));
  assert.equal(iso(skipped.nextRunAt), "2026-11-09T10:30:00.000Z", "l'échéance avance quand même");
  assert.deepEqual(skipped.lastFired, { kind: "run", ids: [first?.id] }, "le dernier lancement reste le run en cours");
  const last = scheduleEvents(world, schedule.id).at(-1);
  assert.deepEqual([last?.type, last?.payload.reason], ["schedule_skipped", "busy"]);

  // Le déclenchement à la main refuse aussi d'empiler.
  await assert.rejects(
    schedules.runNow(schedule.id, { by: "mac" }, null),
    (err: Error & { status?: number }) => err.status === 409,
  );

  await world.orchestrator.cancel(first?.id as string);
  await schedules.tick(at("2026-11-09T10:30:01Z"));
  const runs = world.store.listRuns();
  assert.equal(runs.length, 2, "le run précédent annulé : l'échéance suivante part");
  assert.equal(world.store.getSchedule(schedule.id)?.lastOutcome?.status, "fired");
  await world.orchestrator.stop();
});

test("harness-planification/AC-6 : après un arrêt, pas de rafale — la plus récente échéance rattrapable part une fois, une échéance trop vieille est notée manquée", async () => {
  const { world, schedules } = scheduleWorld();
  const created = at("2026-11-09T10:00:00Z");
  // Toutes les 10 min, service arrêté 5 h : un seul run, 30 échéances regroupées.
  const often = schedules.create(runSchedule("*/10 * * * *"), { by: "mac" }, created);
  const back = at("2026-11-09T15:10:30Z");
  await schedules.tick(back);
  await schedules.tick(back + 1000);
  assert.equal(world.store.listRuns().length, 1, "une seule fois, pas une par échéance passée");
  const caught = world.store.getSchedule(often.id) as ScheduleRow;
  assert.equal(caught.lastOutcome?.status, "fired");
  assert.equal(iso(caught.lastOutcome?.dueAt ?? null), "2026-11-09T15:10:00.000Z", "la plus récente échéance");
  assert.equal(caught.lastOutcome?.missed, 30);
  assert.equal(iso(caught.nextRunAt), "2026-11-09T15:20:00.000Z");
  world.store.updateSchedule(often.id, { enabled: false });

  // Chaque nuit à 2 h, service revenu à 9 h : au-delà de catchUpMin (60 min), rien ne part.
  const nightly = schedules.create(
    runSchedule("0 2 * * *", { name: "Nuit", target: { kind: "run", repo: "demo", title: "Nuit", request: "n" } }),
    { by: "mac" },
    created,
  );
  await schedules.tick(at("2026-11-10T08:00:00Z"));
  const missed = world.store.getSchedule(nightly.id) as ScheduleRow;
  assert.equal(missed.lastOutcome?.status, "missed");
  assert.equal(missed.lastOutcome?.missed, 1);
  assert.equal(missed.lastRunAt, null);
  assert.equal(iso(missed.nextRunAt), "2026-11-11T01:00:00.000Z");
  assert.ok(!world.store.listRuns().some((run) => run.title === "Nuit"));
  const event = scheduleEvents(world, nightly.id).at(-1);
  assert.deepEqual([event?.type, event?.payload.reason], ["schedule_skipped", "missed"]);

  // Revenu 20 min après 2 h : l'échéance est rattrapée.
  await schedules.tick(at("2026-11-11T01:20:00Z"));
  assert.equal(world.store.getSchedule(nightly.id)?.lastOutcome?.status, "fired");
  assert.equal(world.store.listRuns().filter((run) => run.title === "Nuit").length, 1);

  // Le rapport du matin dit ce qui est parti et ce qui a été manqué.
  const digest = digestOf(world.store, 0, Date.now() + HOUR);
  assert.match(digest.text, /## Planifications \(3\)/);
  assert.match(digest.text, /demo · Nuit : manquée/);
  assert.match(digest.text, /demo · Veille Y : lancée — run /);
  await world.orchestrator.stop();
});

test("harness-planification/AC-7 : le plafond journalier atteint, l'échéance est sautée sans rien lancer", async () => {
  const { world, schedules } = scheduleWorld((config) => {
    config.monitoring.dailyBudgetUsd = 1;
  });
  world.store.addUsage({
    runId: null,
    auditId: null,
    repo: "demo",
    step: null,
    provider: "anthropic",
    model: "m",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 2,
  });
  const now = Date.now();
  const schedule = schedules.create(runSchedule("* * * * *"), { by: "mac" }, now - 2 * MINUTE);
  await schedules.tick(now);
  assert.equal(world.store.listRuns().length, 0);
  const row = world.store.getSchedule(schedule.id) as ScheduleRow;
  assert.equal(row.lastOutcome?.status, "daily_budget");
  assert.match(row.lastOutcome?.detail ?? "", /plafond journalier atteint : 2\.00 \$ \/ 1\.00 \$/);
  assert.ok((row.nextRunAt as number) > now);
  await assert.rejects(
    schedules.runNow(schedule.id, { by: "mac" }, null),
    (err: Error & { status?: number }) => err.status === 409,
  );
  await world.orchestrator.stop();
});

/** Les corps que rendent l'API et le MCP dans ces scénarios (lus sans contrôle : c'est le serveur testé). */
type ApiBody = {
  error?: string;
  timezone?: string;
  deleted?: boolean;
  schedule: ScheduleRow;
  schedules: ScheduleRow[];
  outcome: ScheduleOutcome;
  result: { tools: { name: string }[] } & ToolResult;
};

type ToolResult = {
  content: { text: string }[];
  isError?: boolean;
  structuredContent: { schedule: ScheduleRow; schedules: ScheduleRow[]; id?: string; deleted?: boolean };
};

/** Le harness derrière une vraie API, avec un client par rôle et par portée. */
async function apiWorld() {
  const autre = harnessRepo("harness-autre-");
  const { world } = scheduleWorld((config) => {
    config.repos.push(repoDefaults({ name: "autre", path: autre }));
  });
  const clients = new ClientRegistry(path.join(tmpdir("harness-planification-"), "clients.json"), "t".repeat(64));
  const tokens = {
    viewer: clients.add("tableau", "viewer", "*").token,
    operator: clients.add("mac", "operator", "*").token,
    demoOnly: clients.add("demo-seul", "operator", ["demo"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    route: string,
    token: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, etag: response.headers.get("etag"), body: (await response.json()) as ApiBody };
  };
  return {
    world,
    tokens,
    call,
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      await world.orchestrator.stop();
    },
  };
}

test("harness-planification/AC-8 : /v1/schedules — lecture viewer filtrée par dépôt, création, modification (If-Match), suppression et déclenchement en operator", async () => {
  const api = await apiWorld();
  const { tokens, call } = api;
  try {
    assert.ok((API_FEATURES as readonly string[]).includes("schedules"));
    const body = {
      name: "Audit du lundi",
      cron: "0  9 * *   mon",
      target: { kind: "audit", repo: "autre", focus: "dette" },
    };
    assert.equal((await call("POST", "/v1/schedules", tokens.viewer, body)).status, 403, "viewer : lecture seule");
    assert.equal((await call("POST", "/v1/schedules", tokens.demoOnly, body)).status, 403, "dépôt non permis");
    for (const [bad, why] of [
      [{ ...body, cron: "0 9 * mon" }, /cinq champs/],
      [{ ...body, cron: "0 0 30 2 *" }, /aucune échéance/],
      [{ ...body, name: " " }, /name/],
      [
        { ...body, target: { kind: "automation", automationId: "a1" } },
        /automation.*poste Chrome.*pas encore planifiables/,
      ],
      [{ ...body, target: { kind: "rêve", repo: "demo" } }, /target\.kind : run \| audit \| issues/],
      [{ ...body, target: { kind: "run", repo: "demo", title: "t" } }, /request/],
      [{ ...body, target: { kind: "run", repo: "demo", title: "t", request: "r", budgetUsd: -1 } }, /budgetUsd/],
      [{ ...body, target: { kind: "audit", repo: "inconnu" } }, /dépôt inconnu/],
    ] as const) {
      const refused = await call("POST", "/v1/schedules", tokens.operator, bad);
      assert.ok(refused.status === 400 || refused.status === 404, JSON.stringify(refused));
      assert.match(String(refused.body.error), why);
    }

    const created = await call("POST", "/v1/schedules", tokens.operator, body);
    assert.equal(created.status, 201);
    const schedule = created.body.schedule;
    assert.equal(schedule.cron, "0 9 * * mon", "l'expression est normalisée");
    assert.equal(schedule.createdBy, "mac");
    assert.equal(created.etag, `"${schedule.rev}"`);
    const mine = await call("POST", "/v1/schedules", tokens.demoOnly, {
      name: "Veille",
      cron: "0 8 * * *",
      target: { kind: "run", repo: "demo", title: "Veille", request: "relance la veille" },
      enabled: false,
    });
    assert.equal(mine.status, 201);

    const all = await call("GET", "/v1/schedules", tokens.viewer);
    assert.equal(all.body.timezone, "Europe/Paris");
    assert.deepEqual(
      all.body.schedules.map((row: ScheduleRow) => row.name),
      ["Audit du lundi", "Veille"],
    );
    const demoOnly = await call("GET", "/v1/schedules", tokens.demoOnly);
    assert.deepEqual(
      demoOnly.body.schedules.map((row: ScheduleRow) => row.name),
      ["Veille"],
      "un client ne voit que les planifications de ses dépôts",
    );
    for (const [method, route] of [
      ["PUT", `/v1/schedules/${schedule.id}`],
      ["DELETE", `/v1/schedules/${schedule.id}`],
      ["POST", `/v1/schedules/${schedule.id}/run`],
    ] as const)
      assert.equal((await call(method, route, tokens.demoOnly, {})).status, 404, `${method} ${route} : invisible`);
    assert.equal((await call("DELETE", `/v1/schedules/${schedule.id}`, tokens.viewer)).status, 403);

    // If-Match : une révision périmée est refusée, la bonne passe et avance la révision.
    const stale = await call(
      "PUT",
      `/v1/schedules/${schedule.id}`,
      tokens.operator,
      { name: "x" },
      { "If-Match": "99" },
    );
    assert.equal(stale.status, 412);
    const edited = await call(
      "PUT",
      `/v1/schedules/${schedule.id}`,
      tokens.operator,
      { cron: "30 7 * * 1-5", target: { kind: "issues", repo: "demo", label: "urgent" } },
      { "If-Match": String(schedule.rev) },
    );
    assert.equal(edited.status, 200);
    assert.equal(edited.body.schedule.rev, schedule.rev + 1);
    assert.equal(edited.body.schedule.repo, "demo");
    assert.deepEqual(edited.body.schedule.target, { kind: "issues", repo: "demo", label: "urgent" });
    assert.ok(edited.body.schedule.nextRunAt !== schedule.nextRunAt, "une nouvelle expression réarme l'échéance");
    const nowVisible = await call("GET", "/v1/schedules", tokens.demoOnly);
    assert.equal(nowVisible.body.schedules.length, 2, "ciblée sur demo, elle devient visible au client de demo");

    // Déclenchement immédiat, même désactivée : le run part tout de suite.
    const fired = await call("POST", `/v1/schedules/${mine.body.schedule.id}/run`, tokens.demoOnly, {});
    assert.equal(fired.status, 201);
    assert.equal(fired.body.outcome.status, "fired");
    assert.equal(fired.body.outcome.dueAt, null);
    const runId = fired.body.outcome.runIds[0];
    assert.equal(api.world.store.getRun(runId)?.title, "Veille");
    const event = scheduleEvents(api.world, mine.body.schedule.id).at(-1);
    assert.deepEqual([event?.type, event?.payload.by], ["schedule_fired", "demo-seul"]);
    assert.equal(fired.body.schedule.enabled, false, "déclencher ne réactive pas");

    const removed = await call("DELETE", `/v1/schedules/${schedule.id}`, tokens.operator);
    assert.deepEqual([removed.status, removed.body], [200, { deleted: true }]);
    assert.equal((await call("DELETE", `/v1/schedules/${schedule.id}`, tokens.operator)).status, 404);
  } finally {
    await api.close();
  }
});

test("harness-planification/AC-9 : MCP — schedules_list, schedule_create (operator, dépôt par nom GitHub) et schedule_delete", async () => {
  const api = await apiWorld();
  const { tokens, call } = api;
  const tool = async (token: string, name: string, args: Record<string, unknown>) => {
    const reply = await call("POST", "/v1/mcp", token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return reply.body.result as ToolResult;
  };
  try {
    const listed = await call("POST", "/v1/mcp", tokens.viewer, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = listed.body.result.tools.map((item: { name: string }) => item.name);
    for (const name of ["schedules_list", "schedule_create", "schedule_delete"]) assert.ok(names.includes(name), name);

    const args = {
      name: "Issues de la nuit",
      cron: "0 2 * * *",
      target: { kind: "issues", repo: "moi/demo" },
    };
    const denied = await tool(tokens.viewer, "schedule_create", args);
    assert.equal(denied.isError, true);
    assert.match(denied.content[0]?.text ?? "", /operator requis/);
    const reserved = await tool(tokens.operator, "schedule_create", {
      ...args,
      target: { kind: "automation", automationId: "a" },
    });
    assert.equal(reserved.isError, true);
    assert.match(reserved.content[0]?.text ?? "", /automation/);

    const created = await tool(tokens.operator, "schedule_create", args);
    assert.notEqual(created.isError, true, created.content[0]?.text);
    const schedule = created.structuredContent.schedule;
    assert.deepEqual(schedule.target, { kind: "issues", repo: "demo" }, "owner/name résolu vers le dépôt déclaré");

    const list = await tool(tokens.viewer, "schedules_list", {});
    assert.deepEqual(
      list.structuredContent.schedules.map((row: ScheduleRow) => row.id),
      [schedule.id],
    );
    const stale = await tool(tokens.operator, "schedule_delete", { id: schedule.id, rev: schedule.rev + 3 });
    assert.equal(stale.isError, true);
    const deleted = await tool(tokens.operator, "schedule_delete", { id: schedule.id, rev: schedule.rev });
    assert.deepEqual(deleted.structuredContent, { id: schedule.id, deleted: true });
    assert.equal(api.world.store.listSchedules().length, 0);
  } finally {
    await api.close();
  }
});

test("harness-planification/AC-10 : le tour de l'orchestrateur déclenche la planification due ; le faux runner conduit son run jusqu'au merge, qui ne bloque plus le lancement suivant", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  const schedule = world.orchestrator.schedules.create(
    runSchedule("* * * * *", {
      target: { kind: "run", repo: "demo", title: "Export CSV", request: "Exporter les données en CSV" },
    }),
    { by: "mac" },
    Date.now() - 2 * MINUTE,
  );
  await world.orchestrator.start();
  try {
    await waitFor(
      () => (world.store.getSchedule(schedule.id)?.lastFired?.ids.length ?? 0) > 0,
      () => JSON.stringify(world.store.getSchedule(schedule.id)?.lastOutcome),
    );
    const runId = world.store.getSchedule(schedule.id)?.lastFired?.ids[0] as string;
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(runId)?.state ?? ""),
      () => `${world.store.getRun(runId)?.state} — ${world.store.getRun(runId)?.reason}`,
      30_000,
    );
    assert.equal(world.store.getRun(runId)?.state, "merged");
    const again = await world.orchestrator.schedules.runNow(schedule.id, { by: "mac" }, null);
    assert.equal(again.outcome.status, "fired");
    assert.notEqual(again.outcome.runIds[0], runId);
  } finally {
    await world.orchestrator.stop();
  }
});
