// Feature questions-en-contexte : l'humain pilote plusieurs projets et lit chaque
// question hors de la session. Une décision porte la situation (`context`) et, pour
// une escalade, l'impact de chaque option (`impacts`) ; la boîte dit l'étape qui l'a
// posée, la notification nomme le dépôt avant la feature, et les deux apps situent
// chaque question (dépôt › feature › étape) avant de la poser, en Markdown rendu.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONTEXT_MIN, planDecision } from "../../omp-harness/decisions.ts";
import { Store } from "../../omp-harness/db.ts";
import { notificationFor } from "../../omp-harness/notify.ts";
import type { PromptContext } from "../../omp-harness/prompts.ts";
import { stepPrompt } from "../../omp-harness/prompts.ts";
import { inboxOf } from "../../omp-harness/queries.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT } from "../support/repo.ts";

const CONTEXT =
  "La feature exporte les factures en CSV. `src/export.ts` doit dater chaque export ; le modèle `Invoice` n'a pas encore de champ de date.";

const base = {
  question: "Où stocker la date d'export ?",
  context: CONTEXT,
  options: ["ajouter une colonne", "table séparée"],
  chosen: "ajouter une colonne",
  rationale: "une seule lecture par facture",
  category: "reversible",
};

const IMPACTS = ["une migration de `invoices`, lecture directe", "aucune migration, une jointure par lecture"];

function error(raw: unknown): string {
  const parsed = planDecision(raw);
  return parsed.ok ? "" : parsed.error;
}

test("questions-en-contexte/AC-1 : une décision sans situation, ou réduite à une étiquette, est refusée en disant quoi écrire ; la situation voyage avec la décision", () => {
  assert.match(error({ ...base, context: undefined }), /context est requis/);
  assert.match(
    error({ ...base, context: "voir specs" }),
    /context est requis/,
    "une étiquette n'est pas une situation",
  );
  assert.match(error({ ...base, context: " ".repeat(CONTEXT_MIN + 5) }), /context est requis/);
  const parsed = planDecision({ ...base, context: `  ${CONTEXT}  ` });
  assert.ok(parsed.ok && parsed.plan.kind === "checkpoint");
  assert.equal(parsed.ok && parsed.plan.input.context, CONTEXT, "la situation est gardée, sans ses blancs de bord");
  assert.deepEqual(parsed.ok && parsed.plan.input.impacts, [], "les impacts restent facultatifs hors escalade");
});

test("questions-en-contexte/AC-2 : une escalade exige un impact par option, dans l'ordre des options ; une liste qui ne suit pas les options est refusée", () => {
  for (const category of ["schema", "public_api", "deletion"]) {
    assert.match(error({ ...base, category }), /impacts est requis pour une escalade/, category);
    const parsed = planDecision({ ...base, category, impacts: IMPACTS });
    assert.ok(parsed.ok && parsed.plan.kind === "escalate", category);
    assert.deepEqual(parsed.ok && parsed.plan.input.impacts, IMPACTS);
  }
  assert.match(error({ ...base, impacts: [IMPACTS[0]] }), /une conséquence par option/);
  assert.match(error({ ...base, impacts: [IMPACTS[0], " "] }), /une conséquence par option/);
  assert.match(error({ ...base, impacts: "toutes" }), /une conséquence par option/);
  const clarification = planDecision({ ...base, category: "clarification", impacts: IMPACTS });
  assert.ok(clarification.ok && clarification.plan.kind === "checkpoint");
  assert.deepEqual(clarification.ok && clarification.plan.input.impacts, IMPACTS);
  // Durcie par le détecteur (l'agent la croyait réversible) : elle part sans impacts plutôt que d'être refusée.
  const hardened = planDecision({ ...base, rationale: "on fait DROP COLUMN legacy" });
  assert.ok(hardened.ok && hardened.plan.kind === "escalate" && hardened.plan.hardened);
});

test("questions-en-contexte/AC-3 : la politique de décision de chaque étape qui décide demande la situation et les impacts", () => {
  for (const step of ["req", "specs", "impl", "fix"] as const) {
    const ctx: PromptContext = {
      step,
      title: "Export CSV",
      request: "Exporter",
      baseSha: "abc",
      maxDiffLines: 300,
      memories: null,
      blockers: [],
      previousVerdict: null,
      sinceSha: null,
      previousBlockers: [],
      resume: null,
      decisions: [],
      conflicts: [],
      specsDrift: [],
    };
    const policy = stepPrompt(ctx).split("## Politique de décision")[1]?.split("\n## ")[0] ?? "";
    assert.ok(policy.includes("`context`"), `${step} : la politique nomme \`context\``);
    assert.ok(policy.includes("`impacts`"), `${step} : la politique nomme \`impacts\``);
  }
});

test("questions-en-contexte/AC-4 : la base garde situation, raison et impacts ; une ligne antérieure se relit sans eux ; la boîte dit l'étape de chaque question", () => {
  const store = new Store(":memory:");
  try {
    store.createRun({ id: "r1", repo: "demo", slug: "export", title: "Export CSV", request: "Exporter", branch: "b" });
    const step = store.startStep("r1", "specs", 0, null, null);
    store.addEscalation({
      runId: "r1",
      stepId: step.id,
      category: "schema",
      question: "Où stocker la date d'export ?",
      options: base.options,
      recommended: base.chosen,
      context: CONTEXT,
      rationale: base.rationale,
      impacts: IMPACTS,
    });
    // Une escalade d'un serveur antérieur : son contexte était sa raison.
    store.addEscalation({
      runId: "r1",
      stepId: step.id,
      category: "deletion",
      question: "Purger ?",
      options: ["oui", "non"],
      context: "ancienne raison",
    });
    store.addDecision({
      runId: "r1",
      stepId: step.id,
      question: "Séparateur ?",
      options: [",", ";"],
      chosen: ";",
      rationale: "Excel français",
      context: CONTEXT,
      impacts: ["s'ouvre mal dans Excel FR", "s'ouvre bien dans Excel FR"],
      category: "clarification",
      checkpointSha: null,
      dependsOn: [],
    });
    store.addDecision({
      runId: "r1",
      stepId: step.id,
      question: "Nom ?",
      options: ["a", "b"],
      chosen: "a",
      rationale: "r",
      category: "reversible",
      checkpointSha: null,
      dependsOn: [],
    });
    const [fresh, legacy] = store.listEscalations({ runId: "r1" });
    assert.equal(fresh?.context, CONTEXT);
    assert.equal(fresh?.rationale, base.rationale);
    assert.deepEqual(fresh?.impacts, IMPACTS);
    assert.equal(legacy?.context, "ancienne raison");
    assert.equal(legacy?.rationale, null);
    assert.deepEqual(legacy?.impacts, []);
    const [told, untold] = store.listDecisions({ runId: "r1" });
    assert.equal(told?.context, CONTEXT);
    assert.deepEqual(told?.impacts, ["s'ouvre mal dans Excel FR", "s'ouvre bien dans Excel FR"]);
    assert.equal(untold?.context, null);
    assert.deepEqual(untold?.impacts, []);

    const inbox = inboxOf(store) as {
      batches: { items: { step: string | null }[] }[];
      decisions: { step: string | null }[];
    };
    assert.deepEqual(
      inbox.batches.flatMap((batch) => batch.items.map((item) => item.step)),
      ["specs", "specs"],
    );
    assert.deepEqual(
      inbox.decisions.map((decision) => decision.step),
      ["specs", "specs"],
    );
  } finally {
    store.close();
  }
});

async function until(world: FakeWorld, runId: string, states: string[]): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () => `${world.store.getRun(runId)?.state}`,
    30_000,
  );
}

test("questions-en-contexte/AC-5 : l'escalade d'un runner porte sa situation et ses impacts ; tranchée à l'échéance, la décision les garde", async () => {
  const escalate = {
    tool: "decision",
    args: { ...base, category: "schema", impacts: IMPACTS },
  };
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [[escalate, ...OK.impl], OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.review.escalationTimeoutSec = 1;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["escalated", "merged", "failed"]);
    const [open] = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.equal(open?.context, CONTEXT);
    assert.equal(open?.rationale, base.rationale);
    assert.deepEqual(open?.impacts, IMPACTS);

    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    const [decision] = world.store.listDecisions({ runId: run.id });
    assert.equal(decision?.status, "auto_timeout");
    assert.equal(decision?.context, CONTEXT, "la situation survit à l'échéance");
    assert.deepEqual(decision?.impacts, IMPACTS);
  } finally {
    await world.orchestrator.stop();
  }
});

test("questions-en-contexte/AC-6 : une notification nomme le dépôt avant la feature ; sans run connu, l'identifiant suffit", () => {
  const event = {
    id: 1,
    at: Date.now(),
    runId: "r1",
    repo: "facturation",
    type: "escalations" as const,
    payload: { step: "impl", items: [{ question: "Où stocker la date ?" }] },
  };
  const run = { repo: "facturation", title: "Export CSV", step: "impl" } as Parameters<typeof notificationFor>[1];
  assert.equal(notificationFor(event, run)?.title, "Question — facturation · Export CSV");
  assert.equal(notificationFor(event, null)?.title, "Question — r1");
});

const INBOX_VIEWS = {
  mac: {
    file: "omp-console/Sources/OMPConsole/Server/HarnessInboxSections.swift",
    place: "HarnessQuestionPlaceView(",
    context: "HarnessContextView(",
    choice: "HarnessChoiceRow(",
  },
  ios: {
    file: "omp-console/ios/OMPConsoleIOS/IOSHarnessScreens.swift",
    place: "IOSQuestionPlaceView(",
    context: "IOSContextView(",
    choice: "IOSChoiceRow(",
  },
} as const;

/** Les textes de l'agent qu'un `Text(<chaîne>)` montrerait en source Markdown (`**`, accents graves). */
const RAW_AGENT_TEXT = [
  "Text(item.question)",
  "Text(decision.question)",
  "Text(context)",
  "Text(verdict.summary)",
  "Text(specs)",
  "Text(item)",
];

/** Les manques d'une boîte : chaque question située, sa situation et ses options rendues, rien en source. */
function inboxFaults(sources: Record<keyof typeof INBOX_VIEWS, string>): string[] {
  const faults: string[] = [];
  for (const [app, view] of Object.entries(INBOX_VIEWS) as [keyof typeof INBOX_VIEWS, (typeof INBOX_VIEWS)["mac"]][]) {
    const source = sources[app];
    // Les escalades, les specs, les verdicts et les décisions : quatre places.
    const places = source.split(view.place).length - 1;
    if (places < 4) faults.push(`${app} : ${places} question(s) située(s) par ${view.place}, 4 attendues`);
    if (!source.includes(view.context)) faults.push(`${app} : la situation n'est pas rendue par ${view.context}`);
    if (source.split(view.choice).length - 1 < 2)
      faults.push(`${app} : les options des escalades et des décisions ne passent pas par ${view.choice}`);
    for (const raw of RAW_AGENT_TEXT)
      if (source.includes(raw)) faults.push(`${app} : ${raw} montre le Markdown en source`);
  }
  return faults;
}

test("questions-en-contexte/AC-7 : dans les deux apps, chaque question de la boîte est située, sa situation et ses options rendues, aucun texte de l'agent montré en source", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const sources = { mac: read(INBOX_VIEWS.mac.file), ios: read(INBOX_VIEWS.ios.file) };
  assert.deepEqual(inboxFaults(sources), [], "l'arbre réel doit être sain");

  const planted = {
    ...sources,
    mac: sources.mac.replace("MarkdownBlocksView(markdown: verdict.summary)", "Text(verdict.summary)"),
  };
  assert.notEqual(planted.mac, sources.mac, "la faute doit pouvoir se planter");
  assert.ok(inboxFaults(planted).some((fault) => fault.includes("Text(verdict.summary)")));
  const unplaced = { ...sources, ios: sources.ios.replaceAll(INBOX_VIEWS.ios.place, "EmptyView(") };
  assert.ok(inboxFaults(unplaced).some((fault) => fault.startsWith("ios : 0 question(s) située(s)")));
});
