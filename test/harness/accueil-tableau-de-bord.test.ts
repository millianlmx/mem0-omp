// Feature accueil-tableau-de-bord : les KPIs et graphiques (ce qui attend l'humain,
// débit, coût, santé) des apps Mac et iOS. Le serveur leur donne leurs séries
// (`GET /v1/stats`) ; les apps les tracent sous Système › Statistiques et santé, et
// « À traiter » ne montre que la file de ce qui attend l'humain (refonte du 2026-11-08).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "../../omp-harness/db.ts";
import { SERIES_DAYS, computeStats } from "../../omp-harness/stats.ts";
import { ROOT } from "../support/repo.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12);

/** Une base dont l'horloge se règle : chaque écriture prend l'instant courant. */
function clockedStore(): { store: Store; at: (ms: number) => void } {
  let now = NOW;
  const store = new Store(":memory:", () => now);
  return { store, at: (ms) => (now = ms) };
}

type Stats = {
  runs: {
    byDay: { day: string; created: number; merged: number; failed: number }[];
    byRepo: Record<string, { total: number; active: number; merged: number; failed: number; mergedLast7Days: number }>;
  };
  usage: { byRepoLast7Days: Record<string, { cost: number }> };
};

test("accueil-tableau-de-bord/AC-1 : les runs jour par jour couvrent les 14 derniers jours, chacun présent — créés, mergés et échoués le jour de leur fin", () => {
  const { store, at } = clockedStore();
  try {
    const run = (id: string, repo: string, createdAt: number) => {
      at(createdAt);
      store.createRun({ id, repo, slug: id, title: id, request: id, branch: `b/${id}` });
    };
    run("a", "facturation", NOW - 3 * DAY);
    at(NOW - DAY);
    store.updateRun("a", { state: "merged" });
    run("b", "facturation", NOW - 2 * DAY);
    at(NOW);
    store.updateRun("b", { state: "failed" });
    run("c", "site", NOW);
    run("old", "site", NOW - 40 * DAY);

    const stats = computeStats(store, NOW) as Stats;
    const days = stats.runs.byDay;
    assert.equal(days.length, SERIES_DAYS);
    assert.equal(days.at(-1)?.day, "2026-10-25", "la série finit aujourd'hui");
    assert.equal(days[0]?.day, "2026-10-12", "et commence 13 jours plus tôt");
    const day = (offset: number) => days[SERIES_DAYS - 1 - offset];
    assert.deepEqual(day(3), { day: "2026-10-22", created: 1, merged: 0, failed: 0 });
    assert.deepEqual(day(1), { day: "2026-10-24", created: 0, merged: 1, failed: 0 });
    assert.deepEqual(day(0), { day: "2026-10-25", created: 1, merged: 0, failed: 1 });
    assert.deepEqual(
      day(5),
      { day: "2026-10-20", created: 0, merged: 0, failed: 0 },
      "un jour vide reste dans la série",
    );
    assert.equal(
      days.reduce((sum, d) => sum + d.created, 0),
      3,
      "un run plus ancien que la fenêtre n'y entre pas",
    );
  } finally {
    store.close();
  }
});

test("accueil-tableau-de-bord/AC-2 : chaque dépôt a ses runs en cours, mergés, échoués, et son coût sur 7 jours", () => {
  const { store, at } = clockedStore();
  try {
    for (const [id, repo, state] of [
      ["a", "facturation", "merged"],
      ["b", "facturation", "running"],
      ["c", "facturation", "cancelled"],
      ["d", "site", "failed"],
      ["e", "site", "escalated"],
    ] as const) {
      store.createRun({ id, repo, slug: id, title: id, request: id, branch: `b/${id}` });
      store.updateRun(id, { state });
    }
    const usage = (repo: string, cost: number, ms: number) => {
      at(ms);
      store.addUsage({
        runId: null,
        auditId: null,
        repo,
        step: "impl",
        provider: "anthropic",
        model: "m",
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cost,
      });
    };
    usage("facturation", 1.5, NOW - DAY);
    usage("facturation", 4, NOW - 10 * DAY);
    usage("site", 0.25, NOW);

    const stats = computeStats(store, NOW) as Stats;
    assert.deepEqual(stats.runs.byRepo.facturation, { total: 3, active: 1, merged: 1, failed: 0, mergedLast7Days: 1 });
    assert.deepEqual(stats.runs.byRepo.site, { total: 2, active: 1, merged: 0, failed: 1, mergedLast7Days: 0 });
    assert.equal(stats.usage.byRepoLast7Days.facturation?.cost, 1.5, "la dépense d'il y a 10 jours sort de la semaine");
    assert.equal(stats.usage.byRepoLast7Days.site?.cost, 0.25);
    const filtered = computeStats(store, NOW, ["site"]) as Stats;
    assert.deepEqual(Object.keys(filtered.runs.byRepo), ["site"], "un client ne voit que ses dépôts");
  } finally {
    store.close();
  }
});

const MAC_INBOX = "omp-console/Sources/OMPConsole/Server/HarnessSectionViews.swift";
const IOS_SCREENS = "omp-console/ios/OMPConsoleIOS/IOSHarnessScreens.swift";
const MAC_STATS = "omp-console/Sources/OMPConsole/Server/SystemPages.swift";
const MAC_CHARTS = "omp-console/Sources/OMPConsole/Server/HarnessStatsCharts.swift";
const IOS_CHARTS = "omp-console/ios/OMPConsoleIOS/IOSStatsCharts.swift";

/** Le corps d'une déclaration `struct <name>` : jusqu'à la déclaration de premier niveau suivante. */
function structBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^struct ${name}\\b`, "m"));
  if (start === -1) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(struct|private struct|enum|extension|final class|\/\/ MARK)\b/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

type Shell = { inbox: string; stats: string; charts: string };

/**
 * Les manques d'une app : « À traiter » pose la file (`InboxFeed`) et aucun graphique ;
 * la page des statistiques pose les graphiques, qui tracent les quatre blocs.
 */
function boardFaults(inboxSource: string, statsSource: string, charts: string, names: Shell): string[] {
  const faults: string[] = [];
  const inbox = structBody(inboxSource, names.inbox);
  if (inbox === "") return [`${names.inbox} absent`];
  if (!inbox.includes("InboxFeed(")) faults.push(`${names.inbox} ne pose plus la file InboxFeed`);
  for (const chart of [`${names.charts}(`, "Chart(", "Chart {", "DashboardKPI"]) {
    if (inbox.includes(chart)) faults.push(`${names.inbox} pose un tableau de bord (${chart})`);
  }
  if (!structBody(statsSource, names.stats).includes(`${names.charts}(`))
    faults.push(`${names.stats} ne pose pas ${names.charts}`);
  for (const block of ["waitingTitle", "throughputTitle", "costTitle", "healthTitle"]) {
    if (!charts.includes(`DashboardText.${block}`)) faults.push(`${names.charts} n'a pas le bloc ${block}`);
  }
  const traced = charts.split("Chart {").length - 1 + (charts.split("Chart(").length - 1);
  if (traced < 4) faults.push(`${names.charts} ne trace que ${traced} graphique(s), 4 au moins attendus`);
  return faults;
}

test("accueil-tableau-de-bord/AC-3 : sur Mac et sur iOS, « À traiter » montre la file et jamais le tableau de bord, dont les quatre blocs tracés vivent sous Système › Statistiques", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const mac = { inbox: "HarnessInboxView", stats: "SystemStatsPage", charts: "HarnessStatsCharts" };
  const ios = { inbox: "IOSInboxScreen", stats: "IOSStatsScreen", charts: "IOSStatsCharts" };
  assert.deepEqual(boardFaults(read(MAC_INBOX), read(MAC_STATS), read(MAC_CHARTS), mac), []);
  assert.deepEqual(boardFaults(read(IOS_SCREENS), read(IOS_SCREENS), read(IOS_CHARTS), ios), []);

  // Faute plantée : les graphiques remontés sur « À traiter ».
  const crowded = read(MAC_INBOX).replace(
    /(\n\s*)InboxFeed\(/,
    "$1HarnessStatsCharts(dashboard: HarnessDashboard(inbox: HarnessInbox(), stats: nil))$1InboxFeed(",
  );
  assert.notEqual(crowded, read(MAC_INBOX), "la faute n'a pas pu être plantée");
  assert.ok(
    boardFaults(crowded, read(MAC_STATS), read(MAC_CHARTS), mac).some((fault) => fault.includes("tableau de bord")),
  );
});
