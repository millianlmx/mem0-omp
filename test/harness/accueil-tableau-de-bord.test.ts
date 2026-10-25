// Feature accueil-tableau-de-bord : l'Accueil des apps Mac et iOS est un tableau de
// bord — KPIs et graphiques (ce qui attend l'humain, débit, coût, santé) — posé au-dessus
// de la boîte de l'humain. Le serveur lui donne ses séries (`GET /v1/stats`) ; les apps
// les tracent.
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

const MAC_HOME = "omp-console/Sources/OMPConsole/Server/HarnessSectionViews.swift";
const IOS_HOME = "omp-console/ios/OMPConsoleIOS/IOSHarnessScreens.swift";
const MAC_DASHBOARD = "omp-console/Sources/OMPConsole/Server/HarnessDashboardView.swift";
const IOS_DASHBOARD = "omp-console/ios/OMPConsoleIOS/IOSDashboardSections.swift";

/** Le corps d'une déclaration `struct <name>` : jusqu'à la déclaration de premier niveau suivante. */
function structBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^struct ${name}\\b`, "m"));
  if (start === -1) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(struct|private struct|enum|extension|final class|\/\/ MARK)\b/m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** Les manques d'un Accueil : le tableau de bord d'abord, puis la boîte ; les quatre blocs tracés. */
function homeFaults(
  home: string,
  dashboard: string,
  names: { home: string; dashboard: string; inbox: string },
): string[] {
  const faults: string[] = [];
  const body = structBody(home, names.home);
  const board = body.indexOf(`${names.dashboard}(`);
  const inbox = body.indexOf(`${names.inbox}(`);
  if (board === -1) faults.push(`${names.home} ne pose pas ${names.dashboard}`);
  if (inbox === -1) faults.push(`${names.home} ne pose plus la boîte ${names.inbox}`);
  if (board !== -1 && inbox !== -1 && board > inbox)
    faults.push(`${names.home} : la boîte passe avant le tableau de bord`);
  if (!body.includes("catalog: true")) faults.push(`${names.home} ne lit pas les statistiques (catalog: true)`);
  for (const block of ["waitingTitle", "throughputTitle", "costTitle", "healthTitle"]) {
    if (!dashboard.includes(`DashboardText.${block}`)) faults.push(`le tableau de bord n'a pas le bloc ${block}`);
  }
  const charts = dashboard.split("Chart {").length - 1 + (dashboard.split("Chart(").length - 1);
  if (charts < 4) faults.push(`le tableau de bord ne trace que ${charts} graphique(s), 4 au moins attendus`);
  if (!dashboard.includes("DashboardKPI")) faults.push("le tableau de bord n'a pas de tuiles de KPI");
  return faults;
}

test("accueil-tableau-de-bord/AC-3 : sur Mac et sur iOS, l'Accueil ouvre sur le tableau de bord — tuiles de KPI et quatre blocs tracés — puis la boîte de l'humain", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const mac = { home: "HarnessHomeView", dashboard: "HarnessDashboardSections", inbox: "HarnessInboxSections" };
  const ios = { home: "IOSHarnessHomeScreen", dashboard: "IOSDashboardSections", inbox: "IOSHarnessInboxSections" };
  assert.deepEqual(homeFaults(read(MAC_HOME), read(MAC_DASHBOARD), mac), []);
  assert.deepEqual(homeFaults(read(IOS_HOME), read(IOS_DASHBOARD), ios), []);

  // Faute plantée : la boîte remontée au-dessus du tableau de bord.
  const swapped = read(MAC_HOME).replace(
    /(HarnessDashboardSections\([^\n]*\n)([\s\S]*?)(\s*HarnessInboxSections\([^\n]*\n)/,
    "$3$2$1",
  );
  assert.ok(homeFaults(swapped, read(MAC_DASHBOARD), mac).some((fault) => fault.includes("passe avant")));
});
