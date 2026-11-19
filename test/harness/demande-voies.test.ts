// Feature demande-voies : le classeur d'une Demande type le run d'un plan `feature` ou `bug` sur sa voie —
// `express` (triviale et localisée), `direct` (déjà structurée, avec ses critères d'acceptation), `full`
// (floue ou large) — et dit pourquoi. Le serveur juge ce rendu, le plan le montre, la confirmation le
// corrige, et le run naît sur cette voie avec les gardes de toujours.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/api/auth.ts";
import { createHandler } from "../../omp-harness/api/http.ts";
import { runOfPlan } from "../../omp-harness/intake/intake-create.ts";
import { criteriaOf } from "../../omp-harness/intake/intake.ts";
import type { IntakeView } from "../../omp-harness/intake/intake.ts";
import { intakePrompt } from "../../omp-harness/runs/prompts.ts";
import { hostToolsFor } from "../../omp-harness/runners/runner.ts";
import { SPECS_BASELINE } from "../../omp-harness/runs/steps.ts";
import { parseAcIds } from "../../omp-harness/runs/verdict.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import type { HarnessConfig } from "../../omp-harness/config/config.ts";
import { ROOT, tmpdir } from "../support/repo.ts";
import { swiftFields } from "../support/swift-contract.ts";

type Args = Record<string, unknown>;
type Body = { intake: IntakeView; error: string };
type Reply = { status: number; json: Body };

const ADMIN = "a".repeat(64);
const classify = (args: Args) => [{ tool: "intake_classify", args }];
const FEATURE = { kind: "feature", repo: "demo", title: "Libellé du bouton", statement: "Renommer le bouton Envoyer." };
const CRITERIA = [
  "AC-1 : Given la liste des runs, When j'exporte, Then un fichier CSV est téléchargé",
  "- Given un titre avec une virgule, When j'exporte, Then le titre est entre guillemets",
];

async function setup(scenario: Args, patch: (config: HarnessConfig) => void = () => {}) {
  const world = fakeWorld(scenario, { patch });
  const clients = new ClientRegistry(path.join(tmpdir("demande-voies-clients-"), "clients.json"), ADMIN);
  const token = clients.add("mac", "admin", "*").token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, body?: unknown): Promise<Reply> => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : {}) as Body };
  };
  const done = async (): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  };
  return { world, call, done };
}

type Call = Awaited<ReturnType<typeof setup>>["call"];

/** Pose une demande et attend la fin de son classement (job compris). */
async function classified(world: FakeWorld, call: Call, text = "une demande"): Promise<IntakeView> {
  const posted = await call("POST", "/v1/intake", { text, source: "cli" });
  assert.equal(posted.status, 201, JSON.stringify(posted.json));
  const id = posted.json.intake.id;
  await waitFor(
    () => !world.orchestrator.intake.isLive(id) && world.store.getIntake(id)?.state !== "classifying",
    () => `la demande ${id} reste en classement`,
  );
  return (await call("GET", `/v1/intake/${id}`)).json.intake;
}

/** Confirme la demande (201 attendu) et rend le run créé. */
async function confirmed(world: FakeWorld, call: Call, id: string, body: Args = {}) {
  const reply = await call("POST", `/v1/intake/${id}/confirm`, body);
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  const created = reply.json.intake.created;
  assert.equal(created?.kind, "run");
  const run = world.store.getRun(created?.id ?? "");
  assert.ok(run, "le run créé existe");
  const event = world.store.eventsSince(0, run.id).find((entry) => entry.type === "run_created")?.payload;
  return { run, event, specs: world.store.getArtifact(run.id, "specs.md") };
}

test("demande-voies/AC-1 : une demande triviale classée `express` montre sa voie et sa raison dans le plan, puis naît à /impl en voie express", async () => {
  const lane = { ...FEATURE, lane: "express", laneReason: "un libellé à changer, vérifiable par un test" };
  const { world, call, done } = await setup({ demande: [classify(lane)] });
  try {
    const intake = await classified(world, call);
    assert.equal(intake.state, "planned");
    assert.equal(intake.plan?.lane, "express");
    assert.equal(intake.plan?.laneReason, "un libellé à changer, vérifiable par un test");
    assert.deepEqual(intake.plan?.criteria, []);
    assert.match(intake.plan?.creates ?? "", /^Un run « Libellé du bouton » sur demo — voie express/);
    const { run, event, specs } = await confirmed(world, call, intake.id);
    assert.equal(run.lane, "express");
    assert.equal(run.step, "impl");
    assert.equal(event?.lane, "express");
    assert.match(specs ?? "", /Voie express/);
    assert.deepEqual(parseAcIds(specs ?? ""), ["AC-1"]);
  } finally {
    await done();
  }
});

test("demande-voies/AC-2 : une demande structurée classée `direct` porte ses critères renumérotés ; le run naît à /impl en voie directe, gelé sur ces critères", async () => {
  const lane = { ...FEATURE, title: "Export CSV", lane: "direct", laneReason: "résultat précis", criteria: CRITERIA };
  const { world, call, done } = await setup({ demande: [classify(lane)] });
  try {
    const intake = await classified(world, call);
    assert.deepEqual(intake.plan?.criteria, [
      "AC-1 : Given la liste des runs, When j'exporte, Then un fichier CSV est téléchargé",
      "AC-2 : Given un titre avec une virgule, When j'exporte, Then le titre est entre guillemets",
    ]);
    assert.match(intake.plan?.creates ?? "", /voie directe/);
    const { run, event, specs } = await confirmed(world, call, intake.id);
    assert.equal(run.lane, "direct");
    assert.equal(run.step, "impl");
    assert.equal(event?.lane, "direct");
    assert.match(run.request, /^Renommer le bouton Envoyer\.\n\n## Critères d'acceptation\n\nAC-1 : /);
    assert.deepEqual(parseAcIds(specs ?? ""), ["AC-1", "AC-2"]);
    assert.equal(world.store.getArtifact(run.id, SPECS_BASELINE), specs);
  } finally {
    await done();
  }
});

test("demande-voies/AC-3 : une demande floue classée `full` part à /req même quand des critères l'accompagnent ; ils restent dans sa demande", async () => {
  const lane = {
    ...FEATURE,
    title: "Refonte des exports",
    lane: "full",
    laneReason: "plusieurs lectures",
    criteria: CRITERIA,
  };
  const { world, call, done } = await setup({ demande: [classify(lane)] });
  try {
    const intake = await classified(world, call);
    assert.equal(intake.plan?.lane, "full");
    assert.match(intake.plan?.creates ?? "", /voie complète/);
    const { run, event, specs } = await confirmed(world, call, intake.id);
    assert.equal(run.lane, "full");
    assert.equal(run.step, "req");
    assert.equal(event?.lane, "full");
    assert.equal(specs, null);
    assert.match(run.request, /## Critères d'acceptation\n\nAC-1 : /);
  } finally {
    await done();
  }
});

test("demande-voies/AC-4 : le serveur juge la voie — `direct` sans critère devient `full` avec sa raison, une voie inconnue met la demande en échec, un autre type ne porte ni voie ni critères, un plan sans voie garde le tri d'avant", async () => {
  const scenario = {
    demande: [
      classify({ ...FEATURE, lane: "direct", laneReason: "structurée" }),
      classify({ ...FEATURE, lane: "rapide" }),
      classify({
        kind: "audit",
        repo: "demo",
        title: "Audit",
        statement: "Auditer.",
        lane: "express",
        criteria: CRITERIA,
      }),
      classify({ ...FEATURE, criteria: "pas une liste" }),
      classify(FEATURE),
    ],
  };
  const { world, call, done } = await setup(scenario);
  try {
    const downgraded = await classified(world, call);
    assert.equal(downgraded.plan?.lane, "full");
    assert.match(downgraded.plan?.laneReason ?? "", /sans critère d'acceptation/);

    const unknown = await classified(world, call);
    assert.equal(unknown.state, "failed");
    assert.match(unknown.reason ?? "", /voie « rapide » inconnue/);

    const audit = await classified(world, call);
    assert.equal(audit.state, "planned");
    assert.equal(audit.plan?.lane, null);
    assert.equal(audit.plan?.laneReason, null);
    assert.deepEqual(audit.plan?.criteria, []);

    const malformed = await classified(world, call);
    assert.equal(malformed.state, "planned");
    assert.deepEqual(malformed.plan?.criteria, []);

    const plain = await classified(world, call);
    assert.equal(plain.plan?.lane, null);
    assert.equal(plain.plan?.creates, "Un run « Libellé du bouton » sur demo");
    const { run, event } = await confirmed(world, call, plain.id);
    assert.equal(run.lane, "full");
    assert.equal(run.step, "req");
    assert.equal(event?.laneRefused, undefined);
  } finally {
    await done();
  }
});

test("demande-voies/AC-5 : la voie et les critères se corrigent à la confirmation (raison « choisie à la confirmation ») ; `direct` sans critère, une voie inconnue ou des critères qui ne sont pas une liste rendent 400 sans rien créer", async () => {
  const express = { ...FEATURE, lane: "express", laneReason: "trivial" };
  const { world, call, done } = await setup({ demande: [classify(express), classify(express)] });
  try {
    const first = await classified(world, call);
    for (const plan of [{ lane: "direct", criteria: [] }, { lane: "vite" }, { criteria: "AC-1 : x" }]) {
      const refused = await call("POST", `/v1/intake/${first.id}/confirm`, { plan });
      assert.equal(refused.status, 400, JSON.stringify(plan));
      assert.equal(world.store.listRuns().length, 0);
    }
    const { run } = await confirmed(world, call, first.id, { plan: { lane: "direct", criteria: CRITERIA } });
    assert.equal(run.lane, "direct");
    const plan = world.store.getIntake(first.id)?.plan;
    assert.equal(plan?.laneReason, "choisie à la confirmation");
    assert.equal(plan?.criteria?.length, 2);

    const second = await classified(world, call);
    const kept = await confirmed(world, call, second.id, { plan: { title: "Libellé du bouton Envoyer" } });
    assert.equal(kept.run.lane, "express");
    assert.equal(world.store.getIntake(second.id)?.plan?.laneReason, "trivial");
  } finally {
    await done();
  }
});

test("demande-voies/AC-6 : les gardes de la création valent pour la voie du classeur — l'autonomie « tout me demander » refuse l'express, et run_created dit pourquoi", async () => {
  const { world, call, done } = await setup({ demande: [classify({ ...FEATURE, lane: "express" })] });
  try {
    const intake = await classified(world, call);
    const { run, event } = await confirmed(world, call, intake.id, { autonomy: "ask" });
    assert.equal(run.lane, "full");
    assert.match(String(event?.laneRefused), /tout me demander/);
  } finally {
    await done();
  }
});

test("demande-voies/AC-7 : le prompt du classeur décrit les trois voies et les critères, dit les voies coupées par le serveur, et l'outil `intake_classify` accepte `lane`, `laneReason` et `criteria`", () => {
  const base = { text: "x", source: "cli", visibleRepos: ["demo"], requestedRepo: null, exchanges: [] };
  const open = intakePrompt(base);
  for (const lane of ["`express`", "`direct`", "`full`", "`criteria`", "`laneReason`"])
    assert.ok(open.includes(lane), lane);
  assert.doesNotMatch(open, /coupée sur ce serveur/);
  const closed = intakePrompt({ ...base, lanes: { express: false, direct: false } });
  assert.match(closed, /La voie express est coupée sur ce serveur/);
  assert.match(closed, /La voie directe est coupée sur ce serveur/);

  const tool = hostToolsFor("intake").find((entry) => entry.name === "intake_classify");
  assert.ok(tool, "intake_classify est un outil du classeur");
  const properties = (tool.parameters as { properties: Record<string, { enum?: unknown[]; type?: unknown }> })
    .properties;
  assert.deepEqual(properties.lane?.enum, ["express", "direct", "full"]);
  assert.equal(properties.criteria?.type, "array");
  assert.ok("laneReason" in properties);

  assert.deepEqual(criteriaOf(["**AC-3** (B-1) — x", "  ", "* y"]), ["AC-1 : x", "AC-2 : y"]);
  assert.equal(criteriaOf("x"), null);
  assert.deepEqual(
    runOfPlan({ kind: "bug", repo: "demo", title: "t", statement: "s", lane: "direct", criteria: ["AC-1 : c"] }),
    {
      request: "s\n\n## Critères d'acceptation\n\nAC-1 : c",
    },
  );
});

test("demande-voies/AC-8 : les apps décodent la voie, sa raison et les critères du plan, la carte les montre, et « Modifier le plan » corrige la voie et les critères sans envoyer la raison", () => {
  const read = (rel: string): string => fs.readFileSync(path.join(ROOT, "omp-console/Sources", rel), "utf8");
  const fields = swiftFields(read("ConsoleClient/Intake/HarnessIntake.swift"), "HarnessIntakePlan");
  assert.equal(fields.get("lane"), true);
  assert.equal(fields.get("laneReason"), true);
  assert.equal(fields.get("criteria"), false);
  // Un serveur antérieur aux voies n'envoie pas `criteria` : le décodage le tolère.
  assert.match(
    read("ConsoleClient/Intake/HarnessIntake.swift"),
    /decodeIfPresent\(\[String\]\.self, forKey: \.criteria\) \?\? \[\]/,
  );

  const card = read("ConsoleUI/OS/OSDecisionCard.swift");
  assert.match(card, /IntakeText\.laneLine\(plan\.lane, reason: plan\.laneReason\)/);
  assert.match(card, /plan\.criteria/);

  const sheet = read("ConsoleUI/Intake/IntakeViews.swift");
  assert.match(sheet, /Picker\(IntakeText\.laneLabel, selection: laneBinding\)/);
  assert.match(sheet, /IntakeText\.criteriaLabel/);
  assert.match(sheet, /sent\.laneReason = nil/);
});
