// La Demande dans omp-console (Mac et iOS) : le client Swift face au serveur réel
// (routes et champs de `/v1/intake*`), la palette ⌘K qui commence par « Demande », le
// composeur permanent de la liste des fils, la feuille de saisie multiligne (dictée du
// clavier système), les cartes de décision Lancer / Envoyer / Écarter, et le serveur
// antérieur dit en français. Le comportement du modèle est prouvé par
// omp-console/Tests/ConsoleClientTests/HarnessIntakeTests.swift.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir, ROOT } from "../support/repo.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const read = (...parts: string[]) => fs.readFileSync(path.join(CONSOLE, ...parts), "utf8");
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} : objet attendu`);
  return value as Record<string, unknown>;
}

const MODEL = () => read("Sources", "ConsoleClient", "HarnessIntake.swift");
const VIEWS = () => code(read("Sources", "ConsoleUI", "IntakeViews.swift"));

test("demande-console/AC-16 : chaque route et chaque champ /v1/intake* décodés par le client Swift existent dans le routeur et le JSON réel du serveur", async () => {
  const model = MODEL();
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const calls: [string, string, string, string][] = [
    ['"/v1/intake?state=\\(Self.openStates', "GET", "/v1/intake", "viewer"],
    ['"/v1/intake", body: SubmitBody', "POST", "/v1/intake", "operator"],
    ['path: "confirm"', "POST", "/v1/intake/i1/confirm", "operator"],
    ['path: "cancel"', "POST", "/v1/intake/i1/cancel", "operator"],
    ['path: "answer"', "POST", "/v1/intake/i1/answer", "operator"],
  ];
  assert.ok(model.includes('"/v1/intake/\\(HarnessModel.pathComponent(intake.id))/\\(path)"'));
  for (const [literal, method, sample, role] of calls) {
    assert.ok(model.includes(literal), `le client n'appelle plus ${literal}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, role, `le serveur ne sert pas ${method} ${sample} au rôle ${role}`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("intake"));
  assert.ok(
    model.includes('names.contains("intake_state")'),
    "le client ne relit plus la file à l'événement intake_state",
  );
  // Les états de la file sont ceux du serveur.
  const states = fs.readFileSync(path.join(ROOT, "omp-harness", "db", "intakes.ts"), "utf8");
  for (const state of ["classifying", "clarifying", "planned", "answered", "failed"])
    assert.match(states, new RegExp(`"${state}"`));

  const world = fakeWorld({});
  const clients = new ClientRegistry(path.join(tmpdir("demande-console-"), "clients.json"), "a".repeat(64));
  const token = clients.add("mac", "admin", "*").token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: object(await response.json(), route) };
    };
    const { store } = world;
    const base = { source: "console", repo: "", requestedRepo: null, scope: "*" as const, createdBy: "mac" };
    store.createIntake({ id: "iplan", text: "corrige le bug X dans demo", ...base });
    store.updateIntakeIf("iplan", ["classifying"], {
      state: "planned",
      kind: "schedule",
      repo: "demo",
      plan: {
        kind: "schedule",
        repo: "demo",
        title: "Issues de demo",
        statement: "corrige les issues de demo",
        focus: "api",
        schedule: { cron: "0 9 * * 1", target: "issues", focus: "api", label: "bug" },
      },
    });
    store.createIntake({ id: "iask", text: "fais le truc", ...base });
    store.updateIntakeIf("iask", ["classifying"], { state: "clarifying", question: "Quel dépôt ?" });

    const wire = code(model);
    const listed = await call("GET", "/v1/intake?state=classifying,clarifying,planned,answered,failed&limit=200");
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    covers(listed.json, swiftFields(wire, "HarnessIntakeList"), "HarnessIntakeList");
    const intakes = listed.json.intakes as Record<string, unknown>[];
    const planned = object(
      intakes.find((intake) => intake.id === "iplan"),
      "iplan",
    );
    covers(planned, swiftFields(wire, "HarnessIntake"), "HarnessIntake");
    const plan = object(planned.plan, "plan");
    covers(plan, swiftFields(wire, "HarnessIntakePlan"), "HarnessIntakePlan");
    covers(object(plan.schedule, "schedule"), swiftFields(wire, "HarnessIntakeSchedule"), "HarnessIntakeSchedule");

    const one = await call("GET", "/v1/intake/iplan");
    covers(one.json, swiftFields(wire, "HarnessIntakeReply"), "HarnessIntakeReply");

    const answered = await call("POST", "/v1/intake/iask/answer", { text: "demo" });
    assert.equal(answered.status, 200, JSON.stringify(answered.json));
    const after = object(answered.json.intake, "intake");
    assert.equal(after.id, "iask");
    const exchange = object((after.exchanges as unknown[])[0], "exchanges[0]");
    covers(exchange, swiftFields(wire, "HarnessIntakeExchange"), "HarnessIntakeExchange");

    const cancelled = await call("POST", "/v1/intake/iask/cancel");
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json));
    assert.equal(object(cancelled.json.intake, "intake").state, "cancelled");

    const confirmed = await call("POST", "/v1/intake/iplan/confirm", {});
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
    const created = object(object(confirmed.json.intake, "intake").created, "created");
    covers(created, swiftFields(wire, "HarnessIntakeCreated"), "HarnessIntakeCreated");
    assert.equal(created.kind, "schedule");

    // Une route inconnue rend « route inconnue » : le client y lit un serveur antérieur.
    const unknown = await call("POST", "/v1/intake-inexistante", {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error, "route inconnue");
    const missing = await call("GET", "/v1/intake/inexistante");
    assert.equal(missing.status, 404);
    assert.match(String(missing.json.error), /^demande inconnue/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("demande-console/AC-17 : « Demande » ouvre la palette ⌘K saisie vide, sur Mac et iOS, un composeur permanent dans la liste des fils, une feuille titrée au champ multiligne sans dictée propre", () => {
  const palette = code(read("Sources", "ConsoleClient", "HarnessPalette.swift"));
  const search = palette.indexOf("if !search {");
  assert.ok(search > 0);
  const first = palette.indexOf("candidates.", search);
  assert.equal(
    palette.slice(first, palette.indexOf("\n", first)).includes("command: .intake"),
    true,
    "la Demande n'est pas la première candidate",
  );
  const actions = code(read("Sources", "ConsoleUI", "CommandPalette.swift"));
  assert.match(actions, /case \.intake:\s*\n\s*drafts\.openIntake\(\)/);
  assert.match(actions, /\.sheet\(isPresented: \$drafts\.intakeSheetShown\)/);
  // Les deux apps posent la palette (donc la feuille) à leur racine.
  assert.match(read("Sources", "OMPConsole", "OS", "OSRootView.swift"), /\.consolePalette\(/);
  assert.match(read("ios", "OMPConsoleIOS", "RootView.swift"), /\.consolePalette\(/);
  // La liste des fils (Mac et iOS la partagent) porte le composeur, toujours rendu, qui envoie une Demande.
  const list = code(read("Sources", "ConsoleUI", "OS", "OSThreadList.swift"));
  assert.match(list, /OSAskComposer\(intakes: intakes, draft: \$draft, sending: \$sending\)/);
  assert.match(list, /try\? await intakes\.submit\(text: text, source: intakeSource\)/);
  // L'iPhone a en plus « Demander » dans la barre, qui ouvre la feuille.
  assert.match(
    code(read("ios", "OMPConsoleIOS", "IOSOSScreens.swift")),
    /struct IOSOSAskButton[\s\S]*?drafts\.openIntake\(\)/,
  );
  const views = VIEWS();
  const sheet = views.slice(views.indexOf("struct IntakeSheet"), views.indexOf("struct IntakePlanSheet"));
  assert.match(sheet, /TextField\(IntakeText\.fieldPrompt, text: \$drafts\.intakeText, axis: \.vertical\)/);
  assert.match(sheet, /\.navigationTitle\(IntakeText\.title\)/);
  assert.match(sheet, /\.formStyle\(\.grouped\)/);
  for (const forbidden of ["import Speech", "SFSpeechRecognizer", "AVAudioEngine"])
    assert.ok(!views.includes(forbidden), `aucune dictée propre : ${forbidden}`);
  // Hors des fichiers comptés par la garde des titres iOS.
  assert.doesNotMatch(read("..", "test", "console", "ios-listes-groupees-natives.test.ts"), /IntakeViews\.swift/);
});

test("demande-console/AC-18 : les demandes ouvertes sont des décisions de l'OS — plan avec Lancer / Écarter, question avec Envoyer / Écarter, réponse ou échec rangés d'un geste, sans « Reformuler »", () => {
  const model = MODEL();
  assert.match(model, /openStates = \["classifying", "clarifying", "planned", "answered", "failed"\]/);
  assert.match(
    code(read("Sources", "ConsoleClient", "OSDecisions.swift")),
    /items \+= intakes\.filter \{ \$0\.isPlanned \|\| \$0\.isClarifying \}\.map\(OSDecision\.intake\)/,
  );
  const decision = code(read("Sources", "ConsoleUI", "OS", "OSDecisionCard.swift"));
  const card = decision.slice(
    decision.indexOf("private func intakeCard"),
    decision.indexOf("// MARK: Commentaire Jira"),
  );
  assert.ok(card.length > 0, "la carte d'une demande est introuvable");
  for (const gesture of ["intakes.answer(intake, text: custom)", "intakes.confirm(intake)", "intakes.cancel(intake)"])
    assert.ok(card.includes(gesture), `la carte n'appelle pas ${gesture}`);
  // La carte du plan dit le dépôt où il sera lancé.
  assert.match(card, /plan\.repo\.map\(OSDecideText\.launchOn\)/);
  // Une réponse ou un échec se lit dans « Maintenant », et se range d'un geste.
  assert.match(
    code(read("Sources", "ConsoleUI", "OS", "OSHomeView.swift")),
    /if intake\.isSettled \{\s*Button\(OSText\.done\) \{ Task \{ _ = try\? await intakes\.cancel\(intake\) \} \}/,
  );
  assert.ok(!/Reformuler/i.test(VIEWS() + card + read("Sources", "ConsoleCore", "Design", "IntakeText.swift")));
});

test("demande-console/AC-21 : un 404 « route inconnue » sur /v1/intake devient un message français : le serveur ne connaît pas encore la Demande", () => {
  const model = code(MODEL());
  assert.match(model, /reply\.status == 404, Self\.isUnknownRoute\(reply\.body\)/);
  assert.match(model, /throw HarnessIntakeFailure\.unsupported/);
  const views = VIEWS();
  assert.match(views, /case \.unsupported: IntakeText\.unsupported/);
  assert.match(
    read("Sources", "ConsoleCore", "Design", "IntakeText.swift"),
    /unsupported = L10n\.text\("Ce serveur ne connaît pas encore la Demande/,
  );
});
