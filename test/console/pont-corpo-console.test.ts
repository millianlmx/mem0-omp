// Feature pont-corpo-console : les apps Mac et iOS montrent les propositions nées des
// signalements de collègues dans « À traiter » (comptées au badge), leur feuille de
// confirmation (aperçu exact, dépôt modifiable, confirmer ou écarter), et la section
// Origine de la page d'une feature. Le contrat est vérifié des DEUX côtés : chaque route
// appelée par le client Swift est servie au rôle du contrat, chaque champ décodé existe
// dans le JSON RÉEL du serveur (liste, aperçu, confirmation, origine), et chaque vue est
// câblée dans les deux apps.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import { fakeWorld, git } from "../support/harness-fixtures.ts";
import { tmpdir, ROOT } from "../support/repo.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const CLIENT = path.join(CONSOLE, "Sources", "ConsoleClient");
const read = (...parts: string[]) => fs.readFileSync(path.join(CONSOLE, ...parts), "utf8");
/** Le code sans ses commentaires : un nom cité en commentaire ne câble rien. */
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("///"))
    .join("\n");

const done = (stdout: string, code = 0, stderr = ""): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr,
  timedOut: false,
  aborted: false,
});

/** Une forge GitHub doublée : `issue create` rend l'URL de l'issue, `issue view` la relit ouverte. */
function fakeGitHub(): Exec {
  const created: { title: string; body: string }[] = [];
  return async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    const flag = (name: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? "") : "");
    const [noun, verb] = args;
    if (noun === "issue" && verb === "create") {
      created.push({ title: flag("--title"), body: flag("--body") });
      return done(`https://github.com/moi/demo/issues/${created.length}\n`);
    }
    if (noun === "issue" && verb === "view") {
      const number = Number(args[2]);
      const issue = created[number - 1];
      if (!issue) return done("", 1, "GraphQL: Could not resolve to an issue");
      return done(
        JSON.stringify({
          number,
          title: issue.title,
          body: issue.body,
          url: `https://github.com/moi/demo/issues/${number}`,
          state: "OPEN",
          labels: [],
          author: { login: "omp-harness" },
          createdAt: "2026-11-08T10:00:00Z",
          comments: [],
        }),
      );
    }
    if (noun === "issue" && verb === "list") return done("[]");
    return done("", 1, `commande gh inattendue : ${args.join(" ")}`);
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} : objet attendu`);
  return value as Record<string, unknown>;
}

test("pont-corpo-console/AC-1 : « À traiter » montre les propositions des deux apps, comptées au badge, et rien pour un client restreint", () => {
  const feed = code(read("Sources", "ConsoleUI", "InboxFeed.swift"));
  assert.match(feed, /SignalProposalsSection\(signals: signals, drafts: drafts\)/);
  assert.match(feed, /items\.isEmpty, workstation\.approvals\.isEmpty, signals\.pendingCount == 0/);
  // La même file sert le Mac et l'iPhone/iPad.
  assert.match(code(read("Sources", "OMPConsole", "Server", "HarnessSectionViews.swift")), /InboxFeed\(server:/);
  assert.match(code(read("ios", "OMPConsoleIOS", "IOSHarnessScreens.swift")), /InboxFeed\(server:/);
  // Le badge d'« À traiter » compte les propositions, sur les deux apps, relues à chaque serveur relié.
  const mac = code(read("Sources", "OMPConsole", "ConsoleRootView.swift"));
  assert.match(mac, /case \.inbox: .*\+ signals\.pendingCount/);
  assert.match(mac, /await signals\.refresh\(\)/);
  const ios = code(read("ios", "OMPConsoleIOS", "RootView.swift"));
  assert.match(ios, /pending: \(server\.inbox\?\.pendingCount \?\? 0\) \+ signals\.pendingCount/);
  assert.match(ios, /await signals\.refresh\(\)/);
  // Un 403 propriétaire n'est pas un échec : le modèle passe en `.reserved`, sans bandeau.
  const model = code(fs.readFileSync(path.join(CLIENT, "CorporateSignals.swift"), "utf8"));
  assert.match(model, /catch HarnessFailure\.forbidden \{\s*clear\(\.reserved\)/);
  const section = code(read("Sources", "ConsoleUI", "CorporateSignalViews.swift"));
  assert.match(section, /if signals\.availability == \.available, !signals\.proposals\.isEmpty/);
  assert.ok(!section.includes("ConsoleFailureBanner"), "aucun bandeau d'échec global");
});

test("pont-corpo-console/AC-2 : la feuille relit l'aperçu après chaque modification, confirme vers le dépôt choisi et dit le refus d'approbateur", () => {
  const sheet = code(read("Sources", "ConsoleUI", "CorporateSignalViews.swift"));
  assert.match(sheet, /\.task\(id: \[repo, title, text\]\) \{ await readPreview\(\) \}/);
  assert.match(sheet, /Picker\(SignalText\.repoLabel, selection: \$repo\)/);
  assert.match(sheet, /server\.repos\.map\(\\\.name\)/);
  assert.match(sheet, /signals\.confirm\(signal, repo: repo, title: title, body: text\)/);
  assert.match(sheet, /signals\.dismiss\(signal, reason: reason\)/);
  assert.match(sheet, /failure == \.approverOnly \? SignalText\.approverOnly : failure\.message/);
  // La feuille est posée une fois par app, avec les autres gestes du serveur.
  assert.match(
    code(read("Sources", "ConsoleUI", "RunViews.swift")),
    /\.modifier\(SignalGestures\(server: server, drafts: drafts\)\)/,
  );
  assert.match(
    code(read("Sources", "OMPConsole", "Server", "HarnessSectionViews.swift")),
    /\.harnessGestures\(server: server, drafts: drafts\)/,
  );
  assert.match(
    code(read("ios", "OMPConsoleIOS", "RootView.swift")),
    /\.harnessGestures\(server: server, drafts: drafts\)/,
  );
  // Le refus du serveur reste reconnu : son 403 porte le fragment de l'approbateur.
  const signals = fs.readFileSync(path.join(ROOT, "omp-harness", "corporate", "signals.ts"), "utf8");
  assert.match(signals, /if \(!client\.approver\) throw new HarnessError\(403, APPROVER_ONLY\)/);
});

test("pont-corpo-console/AC-3 : la page d'une feature, sur Mac et iOS, montre la section Origine lue au serveur", () => {
  for (const [file, load] of [
    [["Sources", "OMPConsole", "Server", "RunPageView.swift"], "await server.signals.loadOrigin(runId: runId)"],
    [["ios", "OMPConsoleIOS", "IOSRunScreen.swift"], "await server.signals.loadOrigin(runId: runId)"],
  ] as const) {
    const page = code(read(...file));
    assert.ok(page.includes(load), `${file.join("/")} : l'origine n'est pas lue`);
    assert.ok(
      page.includes("RunOriginSection(signals: server.signals, runId: run.id)"),
      `${file.join("/")} : pas de section Origine`,
    );
  }
  const section = code(read("Sources", "ConsoleUI", "CorporateSignalViews.swift"));
  assert.match(section, /if let origin = signals\.origins\[runId\]/);
  for (const shown of ["origin.channel", "origin.personRef", "origin.url", "origin.excerpt"])
    assert.ok(section.includes(shown), `la section Origine ne montre pas ${shown}`);
});

test("pont-corpo-console/AC-4 : chaque route et chaque champ du client Swift existent dans le routeur et le JSON RÉEL du serveur", async () => {
  const model = fs.readFileSync(path.join(CLIENT, "CorporateSignals.swift"), "utf8");
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const calls: [string, string, string, string][] = [
    ['"/v1/signals?state=proposed&limit=', "GET", "/v1/signals", "viewer"],
    ['"/v1/signals/\\(HarnessModel.pathComponent(signal.id))/preview"', "POST", "/v1/signals/sg1/preview", "viewer"],
    ['"/v1/signals/\\(HarnessModel.pathComponent(signal.id))/confirm"', "POST", "/v1/signals/sg1/confirm", "operator"],
    ['"/v1/signals/\\(HarnessModel.pathComponent(signal.id))/dismiss"', "POST", "/v1/signals/sg1/dismiss", "operator"],
    ['"/v1/runs/\\(HarnessModel.pathComponent(runId))/origin"', "GET", "/v1/runs/r1/origin", "viewer"],
  ];
  for (const [literal, method, sample, role] of calls) {
    assert.ok(model.includes(literal), `le client n'appelle plus ${literal}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, role, `le serveur ne sert pas ${method} ${sample} au rôle ${role}`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("corporate-signals"));
  assert.ok(model.includes('names.contains("signal")'), "le client ne relit plus la liste à l'événement signal");

  const world = fakeWorld({}, { exec: fakeGitHub() });
  git(world.repo, "remote", "add", "origin", "git@github.com:moi/demo.git");
  const clients = new ClientRegistry(path.join(tmpdir("pont-console-"), "clients.json"), "a".repeat(64));
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, route: string, token = approver, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: object(await response.json(), route) };
    };
    const { store } = world;
    store.insertSignal({
      id: "sg1",
      channel: "slack",
      threadRef: "slack:C1/1762.1",
      url: "https://exemple.slack.com/archives/C1/p1762",
      personRef: "paul@exemple.fr",
      excerpt: "Le bouton Exporter plante depuis hier.",
    });
    store.updateSignal("sg1", {
      state: "proposed",
      repo: "demo",
      kind: "bug",
      title: "Exporter plante",
      body: "Le bouton Exporter échoue.",
    });

    const wire = code(model);
    const listed = await call("GET", "/v1/signals?state=proposed&limit=200");
    assert.equal(listed.status, 200);
    const signal = object((listed.json.signals as unknown[])[0], "signals[0]");
    covers(signal, swiftFields(wire, "CorporateSignal"), "CorporateSignal");
    // Un client restreint : 403 propriétaire, que l'app tait.
    const refused = await call("GET", "/v1/signals?state=proposed&limit=200", narrow);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, "le poste est réservé au propriétaire");

    const preview = await call("POST", "/v1/signals/sg1/preview", approver, { repo: "demo" });
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    covers(preview.json, swiftFields(wire, "CorporateSignalPreview"), "CorporateSignalPreview");
    covers(object(preview.json.policy, "policy"), swiftFields(wire, "CorporatePolicy"), "CorporatePolicy");

    const confirmed = await call("POST", "/v1/signals/sg1/confirm", approver, {
      repo: "demo",
      title: preview.json.title,
      body: preview.json.body,
    });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
    covers(confirmed.json, swiftFields(wire, "CorporateConfirmation"), "CorporateConfirmation");
    covers(object(confirmed.json.signal, "signal"), swiftFields(wire, "CorporateSignal"), "CorporateSignal (confirmé)");
    covers(object(confirmed.json.issue, "issue"), swiftFields(wire, "CorporateSignalIssue"), "CorporateSignalIssue");
    const runId = object(confirmed.json.signal, "signal").runId as string;
    assert.ok(runId, "la confirmation lance la feature liée");

    const origin = await call("GET", `/v1/runs/${runId}/origin`);
    assert.equal(origin.status, 200);
    covers(object(origin.json.origin, "origin"), swiftFields(wire, "CorporateRunOrigin"), "CorporateRunOrigin");
    covers(origin.json, swiftFields(wire, "CorporateRunOriginReply"), "CorporateRunOriginReply");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});
