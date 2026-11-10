// Feature serveur-de-pipelines : les apps Mac et iOS sont branchées sur le serveur de
// pipelines du VPS (omp-harness). Le contrat est vérifié des DEUX côtés : chaque champ
// que le client Swift décode existe dans le JSON réel du serveur, chaque route qu'il
// appelle existe dans son routeur.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { APPROVER_ONLY } from "../../omp-harness/workstation.ts";
import { buildCard } from "../../omp-harness/card.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";
import { ROOT } from "../support/repo.ts";

const CLIENT = path.join(ROOT, "omp-console", "Sources", "ConsoleClient");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("serveur-de-pipelines/AC-1 : chaque champ décodé par le client Swift existe dans la boîte RÉELLE du serveur", async () => {
  const world = fakeWorld({});
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: "t".repeat(64) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { store } = world;
    store.createRun({
      id: "r1",
      repo: "demo",
      slug: "a",
      title: "A",
      request: "a",
      branch: "b",
      state: "escalated",
      step: "impl",
    });
    store.createRun({
      id: "r2",
      repo: "demo",
      slug: "b",
      title: "B",
      request: "b",
      branch: "c",
      state: "awaiting_human",
      step: null,
    });
    store.updateRun("r2", {
      verdict: {
        risk: "medium",
        summary: "s",
        blockers: [],
        risks: ["r"],
        files: ["a.ts"],
        unverified: [],
        criteria: [{ id: "AC-1", test: "test/a.test.ts", status: "pass" }],
        confidence: "strong",
      },
    });
    const step = store.startStep("r1", "impl", 0, null, null);
    store.addEscalation({
      runId: "r1",
      stepId: step.id,
      category: "schema",
      question: "Q ?",
      options: ["a", "b"],
      context: "c",
      card: buildCard(
        {
          headline: "Q ?",
          stake: "Un enjeu.",
          established: "Un fait.",
          options: [
            { label: "a", impact: "ia", reversible: true },
            { label: "b", impact: "ib", reversible: false, cost: "fort" },
          ],
          recommended: "a",
          confidence: "forte",
        },
        true,
      ),
    });
    store.addDecision({
      runId: "r1",
      stepId: step.id,
      question: "D ?",
      options: ["x", "y"],
      chosen: "x",
      rationale: "r",
      category: "reversible",
      checkpointSha: null,
      dependsOn: [],
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/inbox`, {
      headers: { Authorization: `Bearer ${"t".repeat(64)}` },
    });
    const inbox = (await response.json()) as Record<string, unknown>;

    const wire = fs.readFileSync(path.join(CLIENT, "HarnessWire.swift"), "utf8");
    covers(inbox, swiftFields(wire, "HarnessInbox"), "HarnessInbox");
    const batch = (inbox.batches as Record<string, unknown>[])[0] as Record<string, unknown>;
    covers(batch, swiftFields(wire, "HarnessEscalationBatch"), "HarnessEscalationBatch");
    covers(
      (batch.items as Record<string, unknown>[])[0] as Record<string, unknown>,
      swiftFields(wire, "HarnessEscalation"),
      "HarnessEscalation",
    );
    covers(
      (inbox.decisions as Record<string, unknown>[])[0] as Record<string, unknown>,
      swiftFields(wire, "HarnessDecision"),
      "HarnessDecision",
    );
    const awaiting = (inbox.awaiting as Record<string, unknown>[])[0] as Record<string, unknown>;
    // `waitCause` n'est porté que par un run retenu en file : prouvé par tour-de-controle/AC-2.
    const runFields = swiftFields(wire, "HarnessRun");
    runFields.delete("waitCause");
    covers(awaiting, runFields, "HarnessRun");
    covers(awaiting.verdict as Record<string, unknown>, swiftFields(wire, "HarnessVerdict"), "HarnessVerdict");
    // Champs ajoutés (session en graphe) : la carte de l'escalade et le briefing du run en attente, que le client
    // Swift décode (HarnessSessionGraph.swift, contrat complet : session-graphe-apps/AC-5).
    const card = (batch.items as Record<string, unknown>[])[0]?.card as Record<string, unknown>;
    assert.deepEqual(Object.keys(card).sort(), [
      "confidence",
      "headline",
      "options",
      "recommended",
      "reviewed",
      "schema",
      "stake",
    ]);
    assert.deepEqual(Object.keys(card.schema as object).sort(), ["edges", "nodes"]);
    assert.deepEqual(awaiting.briefing, { feature: "", cards: [] }, "un run qui attend un verdict : briefing vide");
    // Les états que l'app nomme sont ceux de la machine du serveur.
    const states = [...wire.matchAll(/case (\w+)(?: = "(\w+)")?$/gm)].map(([, name, raw]) => raw ?? name);
    const machine = read("omp-harness", "machine.ts");
    for (const state of states) assert.match(machine, new RegExp(`"${state}"`), `état ${state} inconnu du serveur`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("serveur-de-pipelines/AC-2 : chaque route appelée par le client existe dans le routeur du serveur, en Bearer", () => {
  const model = fs.readFileSync(path.join(CLIENT, "HarnessModel.swift"), "utf8");
  // La table des routes du serveur, telle que le gestionnaire HTTP la sert.
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const served = (method: string, sample: string) =>
    routes.some((route) => route.method === method && route.pattern.test(sample));
  const calls: [string, string, string][] = [
    ["/v1/inbox", "GET", "/v1/inbox"],
    ['path: "/escalations"', "POST", "/v1/runs/r1/escalations"],
    ['"/decisions/\\(seq)/accept"', "POST", "/v1/runs/r1/decisions/3/accept"],
    ['"/decisions/\\(seq)/reverse"', "POST", "/v1/runs/r1/decisions/3/reverse"],
    ['path: "/validate"', "POST", "/v1/runs/r1/validate"],
    ['path: "/cancel"', "POST", "/v1/runs/r1/cancel"],
    ['path: "/v1/status"', "GET", "/v1/status"],
    ['path: "/v1/projects"', "GET", "/v1/projects"],
    ['path: "/v1/audits"', "GET", "/v1/audits"],
    ['path: "/v1/stats"', "GET", "/v1/stats"],
    ['path: "/v1/runs/\\(id)"', "GET", "/v1/runs/r1"],
    ['launch("/v1/runs"', "POST", "/v1/runs"],
    ['launch("/v1/projects"', "POST", "/v1/projects"],
    ['launch("/v1/audits"', "POST", "/v1/audits"],
    ['"/v1/audits/\\(id)/launch"', "POST", "/v1/audits/a1/launch"],
    ['"/v1/audits/\\(id)/cancel"', "POST", "/v1/audits/a1/cancel"],
    ['path: "/retry"', "POST", "/v1/runs/r1/retry"],
    ['path: "/decisions/accept"', "POST", "/v1/runs/r1/decisions/accept"],
    ['path: "/revert"', "POST", "/v1/runs/r1/revert"],
    ['path: "/v1/push/devices"', "POST", "/v1/push/devices"],
    ['"/v1/push/devices/\\(id)"', "DELETE", "/v1/push/devices/ab12"],
    ['/proofs")', "GET", "/v1/runs/r1/proofs"],
    ['/graph")', "GET", "/v1/runs/r1/graph"],
    ['/proofs/\\(n)")', "GET", "/v1/runs/r1/proofs/1"],
  ];
  for (const [client, method, sample] of calls) {
    assert.ok(model.includes(client), `le client n'appelle plus ${client}`);
    assert.ok(served(method, sample), `le serveur ne sert pas ${method} ${sample}`);
  }
  // Les routes de l'OS agentique : les gestes d'une feature vivent dans HarnessModel.swift, les
  // autres dans le fichier de leur modèle (pause, consignes, paliers, espaces, brief, chiffres,
  // propositions, sessions locales, activités démarrées par le serveur).
  const osCalls: [string, string, string, string][] = [
    ["HarnessModel.swift", 'path: "/amend"', "POST", "/v1/runs/r1/amend"],
    ["HarnessModel.swift", 'path: "/modules"', "POST", "/v1/runs/r1/modules"],
    ["HarnessModel.swift", 'path: "/autonomy"', "POST", "/v1/runs/r1/autonomy"],
    ["HarnessModel.swift", '/template")', "GET", "/v1/runs/r1/template"],
    ["HarnessModel.swift", 'path: "/v1/push/activities/start"', "POST", "/v1/push/activities/start"],
    ["HarnessModel.swift", 'path: "/v1/push/activities/start/\\(id)"', "DELETE", "/v1/push/activities/start/ab12"],
    ["HarnessLoop.swift", 'readBound("/v1/pause")', "GET", "/v1/pause"],
    ["HarnessLoop.swift", '"POST", "/v1/pause"', "POST", "/v1/pause"],
    ["HarnessStandingRules.swift", 'readBound("/v1/rules")', "GET", "/v1/rules"],
    ["HarnessStandingRules.swift", '"POST", "/v1/rules"', "POST", "/v1/rules"],
    ["HarnessStandingRules.swift", '"PUT", "/v1/rules/\\(', "PUT", "/v1/rules/c1"],
    ["HarnessStandingRules.swift", '"DELETE", "/v1/rules/\\(', "DELETE", "/v1/rules/c1"],
    ["HarnessAutonomy.swift", '"POST", "/v1/autonomy/rules"', "POST", "/v1/autonomy/rules"],
    ["HarnessSpaces.swift", 'readBound("/v1/spaces")', "GET", "/v1/spaces"],
    ["HarnessSpaces.swift", '"POST", "/v1/spaces"', "POST", "/v1/spaces"],
    ["HarnessSpaces.swift", 'gesture(space, "PUT"', "PUT", "/v1/spaces/e1"],
    ["HarnessSpaces.swift", 'gesture(space, "DELETE"', "DELETE", "/v1/spaces/e1"],
    ["HarnessSpaces.swift", '(space.id))/report"', "GET", "/v1/spaces/e1/report"],
    ["HarnessBrief.swift", '?? "/v1/brief"', "GET", "/v1/brief"],
    ["HarnessBrief.swift", '"POST", "/v1/brief/seen"', "POST", "/v1/brief/seen"],
    ["HarnessBrief.swift", 'readScoped("/v1/scoreboard?days=', "GET", "/v1/scoreboard"],
    ["HarnessProposals.swift", 'readScoped("/v1/proposals")', "GET", "/v1/proposals"],
    ["HarnessProposals.swift", '(proposal.id))/accept"', "POST", "/v1/proposals/issue.0123456789abcdef/accept"],
    ["HarnessProposals.swift", '(proposal.id))/dismiss"', "POST", "/v1/proposals/issue.0123456789abcdef/dismiss"],
    ["HarnessLocalSessions.swift", 'readBound("/v1/local-sessions")', "GET", "/v1/local-sessions"],
    ["HarnessLocalSessions.swift", '(session.id))/handoff"', "POST", "/v1/local-sessions/s1/handoff"],
    ["HarnessLocalSessions.swift", '"DELETE", "/v1/local-sessions/\\(', "DELETE", "/v1/local-sessions/s1"],
  ];
  for (const [file, client, method, sample] of osCalls) {
    assert.ok(fs.readFileSync(path.join(CLIENT, file), "utf8").includes(client), `${file} n'appelle plus ${client}`);
    assert.ok(served(method, sample), `le serveur ne sert pas ${method} ${sample}`);
  }
  // Le flux d'événements est servi hors de la table (SSE).
  assert.ok(model.includes("/v1/events?after="), "le client ne suit plus /v1/events");
  assert.match(read("omp-harness", "http.ts"), /url\.pathname === "\/v1\/events"/);
  const transport = fs.readFileSync(path.join(CLIENT, "HarnessTransport.swift"), "utf8");
  assert.match(transport, /"Bearer \\\(server\.token\)", forHTTPHeaderField: "Authorization"/);
  assert.match(read("omp-harness", "http.ts"), /auth\.startsWith\("Bearer "\)/);
});

test("serveur-de-pipelines/AC-3 : la coque Mac et l'app iOS ouvrent la feuille du serveur depuis Système › Serveur et l'appel à relier de chaque section, sur un seul client par app", () => {
  const shells = [
    {
      app: ["Sources", "OMPConsole", "OMPConsoleApp.swift"],
      root: ["Sources", "OMPConsole", "ConsoleRootView.swift"],
      frame: ["Sources", "OMPConsole", "Server", "HarnessSectionViews.swift"],
      system: ["Sources", "OMPConsole", "Server", "SystemPages.swift"],
      sheet: /ServerSheet\(server: server, drafts: drafts\)/,
    },
    {
      app: ["ios", "OMPConsoleIOS", "OMPConsoleIOSApp.swift"],
      root: ["ios", "OMPConsoleIOS", "RootView.swift"],
      frame: ["ios", "OMPConsoleIOS", "IOSHarnessScreens.swift"],
      system: ["ios", "OMPConsoleIOS", "IOSHarnessScreens.swift"],
      sheet: /IOSServerSheet\(server: server, drafts: drafts\)/,
    },
  ];
  for (const shell of shells) {
    // Un seul modèle et un seul brouillon par app, posés à la racine de la scène.
    const app = read("omp-console", ...shell.app);
    assert.match(
      app,
      // Le Mac y ajoute le serveur de `~/.omp/harness.json` et l'écriture d'un appairage ;
      // l'app iOS le pose dans son `init`, avec la mémoire que porte l'appairage et le
      // serveur de recette de ses arguments de lancement (`-os.server`, jamais enregistré).
      /@StateObject private var server = HarnessModel\.live(\(\)|\(\n\s+fallback: )|IOSSharedServer\.install\(HarnessModel\.live\(fallback: \{ recipeServer \}, onPaired:/,
      `${shell.app.at(-1)} : le modèle partagé`,
    );
    assert.match(
      app,
      /@StateObject private var drafts = HarnessDrafts\(\)/,
      `${shell.app.at(-1)} : les brouillons partagés`,
    );
    // La racine ouvre la feuille sur ce modèle, et tient la boîte à jour par le flux.
    const root = read("omp-console", ...shell.root);
    assert.match(
      root,
      /\.sheet\(isPresented: \$drafts\.serverSheetShown\)/,
      `${shell.root.at(-1)} : la feuille du serveur`,
    );
    assert.match(root, shell.sheet, `${shell.root.at(-1)} : la feuille reçoit le modèle partagé`);
    assert.match(
      root,
      /await server\.load\(\)\s*\n\s*server\.startLive\(\)/,
      `${shell.root.at(-1)} : la boîte se tient à jour par le flux`,
    );
    // Le cadre commun des sections propose de relier un serveur absent.
    const frame = read("omp-console", ...shell.frame);
    assert.match(
      frame,
      /Button\(PipelineServerText\.configure\) \{ drafts\.serverSheetShown = true \}/,
      `${shell.frame.at(-1)} : l'appel à relier ouvre la feuille`,
    );
    // Système rend le hub partagé, dont la rangée Serveur ouvre la feuille.
    assert.match(
      read("omp-console", ...shell.system),
      /SystemHubSections\(server: server, drafts: drafts\)/,
      `${shell.system.at(-1)} : le hub Système`,
    );
  }
  const hub = read("omp-console", "Sources", "ConsoleUI", "SystemViews.swift");
  assert.match(
    hub,
    /drafts\.serverSheetShown = true[\s\S]*?\.consoleID\("system\.server"\)/,
    "la rangée Serveur du hub",
  );
  // Sur le Mac, le pied de la barre latérale ouvre aussi la feuille.
  assert.match(
    read("omp-console", "Sources", "OMPConsole", "ConsoleRootView.swift"),
    /ServerConnectionLine\(server: server\) \{ drafts\.serverSheetShown = true \}/,
  );
  assert.match(
    read("omp-console", "Package.swift"),
    /name: "OMPConsole",\s*\n\s*dependencies: \["ConsoleCore", "ConsoleClient", "ConsoleUI"\]/,
  );
});

test("serveur-de-pipelines/AC-4 : le jeton ne vit qu'au trousseau ; seule l'adresse va dans les préférences", () => {
  const model = fs.readFileSync(path.join(CLIENT, "HarnessModel.swift"), "utf8");
  const writes = [...model.matchAll(/preferences\.set\(([^,]+), forKey: ([^)]+)\)/g)].map(
    ([, value, key]) => `${(value as string).trim()} → ${(key as string).trim()}`,
  );
  assert.deepEqual(writes, ["normalized → Self.addressKey", "nil → Self.addressKey"]);
  assert.match(model, /tokens\.save\(token, for: Self\.tokenAccount\)/);
  assert.match(model, /KeychainTokenStore\(service: keychainService\)/);
  assert.match(
    model,
    /public static let keychainService = "com\.omp\.console\.harness"/,
    "un service de trousseau distinct de celui du Mac",
  );
});

test("serveur-de-pipelines/AC-5 : les apps Mac et iOS ouvrent « Fournisseurs et modèles » aux seuls admins, sur les routes du serveur, la clé en champ secret", () => {
  const app = (file: string) => read("omp-console", file);
  const model = app("Sources/ConsoleClient/HarnessModel.swift");
  for (const route of [
    '"GET", path: "/v1/providers"',
    '"PUT", "/v1/providers/',
    '"DELETE", "/v1/providers/',
    '"PUT", "/v1/models"',
  ])
    assert.ok(model.includes(route), `le client appelle ${route}`);
  assert.match(model, /isAdmin: Bool \{ client\?\.role == "admin" \}/);
  // Les abonnements (connexion OAuth) : chaque route du client est servie, en admin.
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  for (const [client, method, sample] of [
    ['path: "/v1/oauth"', "GET", "/v1/oauth"],
    ['"POST", "/v1/oauth/\\(id)/login"', "POST", "/v1/oauth/openai-codex/login"],
    ['"POST", "/v1/oauth/logins/\\(current.id)/answer"', "POST", "/v1/oauth/logins/abc/answer"],
    ['"DELETE", "/v1/oauth/logins/\\(current.id)"', "DELETE", "/v1/oauth/logins/abc"],
    ['path: "/v1/oauth/logins/\\(id)"', "GET", "/v1/oauth/logins/abc"],
  ] as const) {
    assert.ok(model.includes(client), `le client n'appelle plus ${client}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, "admin", `le serveur ne sert pas ${method} ${sample} aux admins`);
  }
  for (const [sheet, screen] of [
    ["Sources/OMPConsole/Server/ServerSheet.swift", "ProvidersView"],
    ["ios/OMPConsoleIOS/IOSServerSheet.swift", "IOSProvidersScreen"],
  ] as const) {
    const source = app(sheet);
    const gate = source.indexOf("if server.isAdmin {");
    assert.ok(
      gate > 0 && source.indexOf(`${screen}(server: server, drafts: drafts)`) > gate,
      `${sheet} : réservé aux admins`,
    );
  }
  for (const form of ["Sources/OMPConsole/Server/ProvidersView.swift", "ios/OMPConsoleIOS/IOSProvidersScreen.swift"]) {
    const source = app(form);
    assert.match(
      source,
      /SecureField\(\s*PipelineServerText\.keyLabel,\s*text: field\(\\\.apiKey\)/,
      `${form} : la clé en champ secret`,
    );
    assert.ok(source.includes("server.saveChains(nil)"), `${form} : retour aux modèles du serveur`);
  }
});

test("serveur-de-pipelines/AC-6 : chaque route du poste de travail appelée par le client Swift est servie, au rôle du contrat, et aucune n'approuve sans geste", () => {
  const model = fs.readFileSync(path.join(CLIENT, "WorkstationModel.swift"), "utf8");
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const calls: [string, string, string, string][] = [
    ['path: "/v1/workstation")', "GET", "/v1/workstation", "viewer"],
    ['"/v1/workstation/actions?state=awaiting_approval&limit=', "GET", "/v1/workstation/actions", "viewer"],
    ['"/v1/workstation/actions?limit=', "GET", "/v1/workstation/actions", "viewer"],
    ['"/v1/workstation/profile")', "GET", "/v1/workstation/profile", "viewer"],
    ['"/v1/workstation/meetings?limit=', "GET", "/v1/workstation/meetings", "viewer"],
    ['"/v1/workstation/actions/\\(seq)/approve"', "POST", "/v1/workstation/actions/9/approve", "operator"],
    ['"/v1/workstation/actions/\\(seq)/refuse"', "POST", "/v1/workstation/actions/9/refuse", "operator"],
    ['method: "PUT", path: "/v1/workstation/settings"', "PUT", "/v1/workstation/settings", "operator"],
    ['method: "POST", path: "/v1/workstation/profile/rebuild"', "POST", "/v1/workstation/profile/rebuild", "operator"],
  ];
  for (const [client, method, sample, role] of calls) {
    assert.ok(model.includes(client), `le client n'appelle plus ${client}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, role, `le serveur ne sert pas ${method} ${sample} au rôle ${role}`);
  }
  // L'approbation n'est appelée que par un geste de l'humain : dans les deux apps, un
  // `Button` et lui seul porte `approve(shown:` — avec l'action affichée, dont l'`updatedAt`
  // part en If-Match ; le modèle ne l'appelle jamais lui-même. L'autre chemin est l'action
  // « Approuver » d'une notification que l'humain touche : `decideFromNotification`,
  // appelé par le seul `execute(.approveSend)`, que seul le routage de cette action rend.
  const code = (source: string) =>
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
  assert.ok(
    code(model).includes("func approve(shown action: WorkstationAction)"),
    "le modèle approuve l'action affichée",
  );
  assert.equal(code(model).split("approve(shown:").length - 1, 0, "le modèle n'approuve que sur appel");
  for (const view of ["Sources/ConsoleUI/WorkstationSections.swift"]) {
    const source = code(read("omp-console", view));
    const uses = [...source.matchAll(/approve\(shown:/g)].map((match) => source.slice(0, match.index));
    assert.equal(uses.length, 1, `${view} : une seule approbation, celle du bouton`);
    assert.match(
      uses[0] ?? "",
      /Button\(WorkstationText\.approve\) \{\s*Task \{ await workstation\.$/,
      `${view} : l'approbation vient d'un bouton`,
    );
    assert.ok(source.includes("approve(shown: action)"), `${view} : l'approbation porte l'action affichée`);
  }
  const notifications = code(read("omp-console", "Sources", "ConsoleClient", "HarnessNotifications.swift"));
  const decisions = [...notifications.matchAll(/decideFromNotification\([^)]*approve: true\)/g)];
  assert.equal(decisions.length, 1, "une seule approbation depuis une notification");
  assert.match(
    notifications,
    /case let \.approveSend\(seq, revision\):\s*await workstation\.decideFromNotification\(seq: seq, revision: revision, approve: true\)/,
  );
  assert.match(
    notifications,
    /case \.approve:\s*guard approves, let seq = alert\.seq else \{ return \.open\(destination\) \}\s*return \.approveSend\(/,
    "seule l'action « Approuver » d'une notification d'envoi, jeton approbateur, rend .approveSend",
  );
  assert.equal(code(model).split("decideFromNotification(").length - 1, 1, "le modèle ne s'appelle pas lui-même");
});

/** Une valeur JSON qui doit être un objet : vérifiée, puis rendue comme telle. */
function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} : objet attendu`);
  return Object.fromEntries(Object.entries(value));
}

/** Le premier objet d'une liste JSON non vide. */
function firstOf(value: unknown, label: string): Record<string, unknown> {
  assert.ok(Array.isArray(value) && value.length > 0, `${label} : liste non vide attendue`);
  return object(value[0], `${label}[0]`);
}

test("serveur-de-pipelines/AC-7 : chaque champ du poste de travail décodé par le client Swift existe dans le JSON RÉEL du serveur", async () => {
  const token = "t".repeat(64);
  const world = fakeWorld({});
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        // L'extension rapporte l'onglet 1 comme de la fenêtre de l'agent : le cantonnement laisse partir le clic.
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-OMP-Agent-Tabs": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, json: text ? object(JSON.parse(text), route) : {} };
    };
    // L'extension se présente (en ligne), observe, puis rend un envoi à approuver.
    assert.equal((await call("GET", "/v1/workstation/next?wait=0")).status, 204);
    const at = Date.now();
    const observed = await call("POST", "/v1/workstation/observations", {
      tz: -60,
      events: [{ kind: "visit", at, url: "https://mail.google.com/mail", title: "Boîte", durationMs: 60_000 }],
    });
    assert.equal(observed.status, 200, JSON.stringify(observed.json));
    const created = await call("POST", "/v1/workstation/actions", {
      kind: "click",
      params: { tabId: 1, ref: "e1" },
      rationale: "Répondre à Paul",
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const seq = object(created.json.action, "action").seq;
    assert.equal(typeof seq, "number", "la file rend le numéro de l'action");
    assert.equal((await call("GET", "/v1/workstation/next?wait=0")).status, 200);
    const parked = await call("POST", `/v1/workstation/actions/${seq}/result`, {
      outcome: "needs_approval",
      approval: { summary: "Envoyer un message à Paul", recipients: ["paul@exemple.fr"], preview: "Bonjour Paul" },
    });
    assert.equal(parked.status, 200, JSON.stringify(parked.json));
    world.store.addWorkstationProfile({
      summary: "Commercial",
      habits: ["Mails le matin"],
      tools: [{ name: "Gmail", usage: "clients" }],
      schedule: "9 h – 18 h",
      repetitiveTasks: [{ title: "Relancer", frequency: "lundi", steps: ["a"], automatable: true }],
      clientNeeds: [{ need: "Devis", who: "Paul", meetingId: null, at }],
      preferences: ["Vouvoiement"],
    });
    const meeting = await call("POST", "/v1/workstation/meetings", {
      title: "Point",
      url: "https://meet.google.com/x",
      startedAt: at,
    });
    assert.equal(meeting.status, 201, JSON.stringify(meeting.json));

    const wire = fs.readFileSync(path.join(CLIENT, "WorkstationWire.swift"), "utf8");
    const status = (await call("GET", "/v1/workstation")).json;
    covers(status, swiftFields(wire, "WorkstationStatus"), "WorkstationStatus");
    covers(object(status.autonomy, "autonomy"), swiftFields(wire, "WorkstationAutonomy"), "WorkstationAutonomy");
    const pending = (await call("GET", "/v1/workstation/actions?state=awaiting_approval&limit=200")).json;
    const action = firstOf(pending.actions, "actions");
    assert.equal(action.state, "awaiting_approval");
    covers(action, swiftFields(wire, "WorkstationAction"), "WorkstationAction");
    covers(object(action.approval, "approval"), swiftFields(wire, "WorkstationApproval"), "WorkstationApproval");
    const reply = (await call("GET", "/v1/workstation/profile")).json;
    covers(reply, swiftFields(wire, "WorkstationProfileReply"), "WorkstationProfileReply");
    const profile = object(reply.profile, "profile");
    covers(profile, swiftFields(wire, "WorkstationProfile"), "WorkstationProfile");
    covers(firstOf(profile.tools, "tools"), swiftFields(wire, "WorkstationTool"), "WorkstationTool");
    covers(
      firstOf(profile.repetitiveTasks, "repetitiveTasks"),
      swiftFields(wire, "WorkstationTask"),
      "WorkstationTask",
    );
    covers(
      firstOf(profile.clientNeeds, "clientNeeds"),
      swiftFields(wire, "WorkstationClientNeed"),
      "WorkstationClientNeed",
    );
    const stats = object(reply.stats, "stats");
    covers(stats, swiftFields(wire, "WorkstationProfileStats"), "WorkstationProfileStats");
    covers(firstOf(stats.topSites, "topSites"), swiftFields(wire, "WorkstationTopSite"), "WorkstationTopSite");
    assert.ok(Array.isArray(stats.activeHours) && stats.activeHours.length === 24, "24 heures actives");
    const meetings = (await call("GET", "/v1/workstation/meetings?limit=20")).json;
    covers(firstOf(meetings.meetings, "meetings"), swiftFields(wire, "WorkstationMeeting"), "WorkstationMeeting");
    // Les états et sortes que l'app nomme sont ceux du contrat du serveur.
    const states = [
      ...wire
        .slice(wire.indexOf("enum WorkstationActionState"), wire.indexOf("enum WorkstationAutonomySetting"))
        .matchAll(/case (\w+)(?: = "(\w+)")?$/gm),
    ].map(([, name, raw]) => raw ?? name);
    assert.deepEqual(states, ["queued", "running", "awaiting_approval", "done", "failed", "refused", "expired"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("serveur-de-pipelines/AC-8 : le client Swift reconnaît le refus APPROVER_ONLY du serveur, et n'écrit jamais le jeton approbateur dans ~/.omp", () => {
  const model = read("omp-console", "Sources", "ConsoleClient", "HarnessModel.swift");
  const marker = /static let approverOnlyMarker = "([^"]+)"/.exec(model)?.[1];
  assert.ok(marker, "HarnessModel.approverOnlyMarker introuvable");
  assert.ok(APPROVER_ONLY.includes(marker), `le 403 du serveur ne contient plus ${JSON.stringify(marker)}`);
  assert.match(
    model,
    /let rawToken = pairing\?\.appToken \?\? tokenInput/,
    "configure() appelle le serveur avec le jeton approbateur du code",
  );

  const pairing = read("omp-console", "Sources", "ConsoleClient", "HarnessPairing.swift");
  const writer = pairing.slice(
    pairing.indexOf("public func writeShared"),
    pairing.indexOf("private static func writePrivate"),
  );
  assert.ok(writer.length > 0, "writeShared introuvable");
  assert.doesNotMatch(writer, /approverToken|appToken/, "~/.omp ne reçoit que le jeton ordinaire");
});

test("serveur-de-pipelines/AC-29 : chaque champ des demandes et automatisations décodé par le client Swift existe dans le JSON RÉEL du serveur", async () => {
  const token = "t".repeat(64);
  const world = fakeWorld({});
  const ws = world.orchestrator.workstation;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const get = async (route: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200, route);
      return object(await response.json(), route);
    };
    await ws.next(0, new AbortController().signal);
    const { version } = world.store.addWorkstationProfile({
      summary: "s",
      habits: [],
      tools: [],
      schedule: "",
      repetitiveTasks: [{ title: "Relancer", frequency: "lundi", steps: ["a"], automatable: true }],
      clientNeeds: [],
      preferences: [],
    });
    ws.createAutomation({ version, task: 0 }, { by: "test" });
    const request = ws.createRequest({ instruction: "Ouvre la page des factures" }, { by: "test" });
    ws.startRequest(request.id);
    ws.createAction({ kind: "tabs", params: {}, rationale: "voir" }, "agent", "agent", request.id);

    const wire = fs.readFileSync(path.join(CLIENT, "WorkstationWire.swift"), "utf8");
    const listed = firstOf((await get("/v1/workstation/requests")).requests, "requests");
    covers(listed, swiftFields(wire, "WorkstationRequest"), "WorkstationRequest (liste)");
    const detail = await get(`/v1/workstation/requests/${request.id}`);
    covers(object(detail.request, "request"), swiftFields(wire, "WorkstationRequest"), "WorkstationRequest");
    const action = firstOf(detail.actions, "actions");
    assert.equal(action.requestId, request.id);
    covers(action, swiftFields(wire, "WorkstationAction"), "WorkstationAction");
    const automation = firstOf((await get("/v1/workstation/automations")).automations, "automations");
    covers(automation, swiftFields(wire, "WorkstationAutomation"), "WorkstationAutomation");
    const states = [
      ...wire
        .slice(wire.indexOf("enum WorkstationRequestState"), wire.indexOf("public struct WorkstationRequest:"))
        .matchAll(/case (\w+)$/gm),
    ].map(([, name]) => name);
    assert.deepEqual(states, ["queued", "running", "done", "failed", "cancelled"]);
    assert.ok((API_FEATURES as readonly string[]).includes("workstation-requests"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("serveur-de-pipelines/AC-30 : multi-client — chaque route, chaque capacité et chaque champ d'espace que lit le client Swift existent dans le routeur et le JSON RÉEL du serveur", async () => {
  const client = (file: string) => fs.readFileSync(path.join(CLIENT, file), "utf8");
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const calls: [string, string, string, string][] = [
    ["HarnessSpaces.swift", '"POST", "/v1/spaces/onboard"', "POST", "/v1/spaces/onboard"],
    ["HarnessSpaces.swift", 'readBound("/v1/spaces/\\(HarnessModel.pathComponent(id))")', "GET", "/v1/spaces/e1"],
    ["HarnessSpaces.swift", '(spaceId))/usage"', "GET", "/v1/spaces/e1/usage"],
    ["WorkstationControl.swift", '"PUT", "/v1/workstation/browsers/\\(', "PUT", "/v1/workstation/browsers/b1"],
  ];
  for (const [file, literal, method, sample] of calls) {
    assert.ok(client(file).includes(literal), `${file} n'appelle plus ${literal}`);
    assert.ok(
      routes.some((route) => route.method === method && route.pattern.test(sample)),
      `le serveur ne sert pas ${method} ${sample}`,
    );
  }
  // Les capacités que le client lit dans `features` sont celles que le serveur annonce.
  const scope = client("HarnessScope.swift");
  for (const feature of ["space-scope", "space-knowledge", "space-workstation", "space-policy"]) {
    assert.ok(scope.includes(`= "${feature}"`), `le client ne lit plus la capacité ${feature}`);
    assert.ok((API_FEATURES as readonly string[]).includes(feature), `le serveur n'annonce pas ${feature}`);
  }
  // `?space=` part sur ce que le serveur compose, jamais sur la pause (il suspendrait l'espace au lieu de tout).
  assert.match(scope, /\+ "space=" \+ queryValue\(id\)/);
  assert.ok(!client("HarnessLoop.swift").includes("readScoped("), "la pause se lit et se pose sans `?space=`");

  const token = "t".repeat(64);
  const world = fakeWorld({});
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const json = (response.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : {};
      return { status: response.status, text, json: object(json, route) };
    };
    const repo = world.config.repos[0]?.name as string;

    // L'accueil d'un client : le corps que le client envoie, la réponse qu'il décode.
    const onboarded = await call("POST", "/v1/spaces/onboard", { name: "Client Acme", repos: [repo] });
    assert.equal(onboarded.status, 201, onboarded.text);
    for (const key of ["space", "isolation", "next"]) assert.ok(key in onboarded.json, `onboard.${key}`);
    const step = (onboarded.json.next as Record<string, unknown>[])[0];
    if (step) assert.deepEqual(Object.keys(step).sort(), ["code", "text"]);
    const id = object(onboarded.json.space, "space").id as string;

    // Un espace, dans la liste et seul : les champs de base du client Swift, puis ceux de la frontière.
    const listed = firstOf((await call("GET", "/v1/spaces")).json.spaces, "spaces");
    const alone = object((await call("GET", `/v1/spaces/${id}`)).json.space, "space");
    for (const space of [listed, alone]) {
      covers(space, swiftFields(client("HarnessSpaces.swift"), "HarnessSpace"), "HarnessSpace");
      for (const key of ["memoryScopes", "stats", "policy", "identities", "isolation", "atlassian"])
        assert.ok(key in space, `HarnessSpace.${key} : le client Swift le décode, le serveur ne l'envoie pas`);
      const stats = object(space.stats, "stats");
      covers(stats, swiftFields(client("HarnessSpaces.swift"), "HarnessSpaceStats"), "HarnessSpaceStats");
      const isolation = object(space.isolation, "isolation");
      covers(isolation, swiftFields(client("HarnessSpaceFrontier.swift"), "HarnessIsolation"), "HarnessIsolation");
      for (const gap of isolation.gaps as Record<string, unknown>[])
        covers(gap, swiftFields(client("HarnessSpaceFrontier.swift"), "HarnessIsolationGap"), "HarnessIsolationGap");
    }
    // Les codes de lacune que le client nomme sont ceux du serveur.
    const codes = [...client("HarnessSpaceFrontier.swift").matchAll(/^ {4}case \w+ = "([a-z_]+)"$/gm)].map(
      ([, code]) => code,
    );
    const isolation = read("omp-harness", "isolation.ts");
    assert.ok(codes.length >= 8, "les codes de lacune du client");
    for (const code of codes) assert.ok(isolation.includes(`"${code}"`), `code de lacune inconnu du serveur : ${code}`);

    // La politique et les identités partent seules, à la révision lue.
    const put = await fetch(`http://127.0.0.1:${port}/v1/spaces/${id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "If-Match": `"${alone.rev}"` },
      body: JSON.stringify({ identities: ["moi@exemple.fr"] }),
    });
    assert.equal(put.status, 200, await put.text());

    // La consommation : JSON et CSV.
    const usage = object((await call("GET", `/v1/spaces/${id}/usage`)).json.usage, "usage");
    covers(usage, swiftFields(client("HarnessSpaceFrontier.swift"), "HarnessSpaceUsage"), "HarnessSpaceUsage");
    const csv = await call("GET", `/v1/spaces/${id}/usage?format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.text, /^jour;espace;depot;modele;cout_usd;jetons_entree;jetons_sortie\r\n/);

    // La pause dit ses espaces ; l'état, ses avertissements.
    const pause = object((await call("GET", "/v1/pause")).json.pause, "pause");
    assert.ok(Array.isArray(pause.spaces), "pause.spaces");
    assert.ok(Array.isArray((await call("GET", "/v1/status")).json.warnings), "status.warnings");

    // Une consigne d'espace : le corps du client, le champ qu'il relit.
    const rule = await call("POST", "/v1/rules", { text: "Chaque commit cite son ticket.", space: id });
    assert.equal(rule.status, 201, rule.text);
    assert.equal(object(rule.json.rule, "rule").space, id);
    const rules = (await call("GET", "/v1/rules")).json.rules as Record<string, unknown>[];
    covers(
      rules[0] as Record<string, unknown>,
      swiftFields(client("HarnessStandingRules.swift"), "HarnessStandingRule"),
      "HarnessStandingRule",
    );

    // Ce que le serveur compose se lit pour un espace ; un espace inconnu n'existe pas.
    for (const route of ["/v1/brief", "/v1/proposals", "/v1/scoreboard?days=7"]) {
      const join = route.includes("?") ? "&" : "?";
      assert.equal((await call("GET", `${route}${join}space=${id}`)).status, 200, `${route} pour un espace`);
      assert.equal((await call("GET", `${route}${join}space=inconnu`)).status, 404, `${route} pour un espace inconnu`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("serveur-de-pipelines/AC-31 : la feuille du serveur est attachée à la racine du Mac, donc ⌘K › Serveur l'ouvre aussi depuis la nouvelle interface, qui n'a pas de barre latérale", () => {
  const root = read("omp-console", "Sources", "OMPConsole", "ConsoleRootView.swift");
  const classic = root.indexOf("private var classic");
  const sheet = root.indexOf(".sheet(isPresented: $drafts.serverSheetShown)");
  assert.ok(classic > 0, "la coque classique est repérée");
  assert.ok(sheet > 0, "la feuille du serveur est présentée");
  assert.ok(sheet < classic, "la feuille est présentée par la racine (body), pas par la coque classique seule");
  assert.equal(root.split(".sheet(isPresented: $drafts.serverSheetShown)").length - 1, 1, "une seule présentation");
});
