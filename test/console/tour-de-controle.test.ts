// Feature tour-de-controle : les apps Mac et iOS pilotent l'OS agentique — consigne et
// budget d'une feature, raison d'une file, arrêt d'urgence et demandes du poste, vigie,
// planifications, administration et issues. Le contrat est vérifié des DEUX côtés :
// chaque route que le client Swift appelle est servie au rôle du contrat, chaque champ
// qu'il décode existe dans le JSON réel du serveur, et chaque section est câblée dans
// les deux apps (l'Administration seulement pour un admin).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT } from "../support/repo.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const CLIENT = path.join(CONSOLE, "Sources", "ConsoleClient");
const read = (...parts: string[]) => fs.readFileSync(path.join(CONSOLE, ...parts), "utf8");
const client = (file: string) => fs.readFileSync(path.join(CLIENT, file), "utf8");

/** Les propriétés stockées d'une struct Swift : nom → optionnelle ? */
function swiftFields(source: string, struct: string): Map<string, boolean> {
  const start = source.indexOf(`public struct ${struct}:`);
  assert.ok(start >= 0, `struct ${struct} introuvable`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const fields = new Map<string, boolean>();
  for (const [, name, type] of body.matchAll(/^ {4}public var (\w+): ([^\s{=]+)\s*$/gm))
    fields.set(name as string, (type as string).endsWith("?"));
  assert.ok(fields.size > 0, `aucun champ lu dans ${struct}`);
  return fields;
}

function covers(object: unknown, fields: Map<string, boolean>, label: string): void {
  assert.ok(object !== null && typeof object === "object", `${label} : objet attendu`);
  const record = object as Record<string, unknown>;
  for (const [name, optional] of fields) {
    assert.ok(name in record, `${label}.${name} : le client Swift le décode, le serveur ne l'envoie pas`);
    if (!optional)
      assert.notEqual(record[name], null, `${label}.${name} : non optionnel côté Swift, null côté serveur`);
  }
}

test("tour-de-controle/AC-1 : chaque route de la tour de contrôle appelée par le client Swift est servie, au rôle du contrat", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const sources = fs
    .readdirSync(CLIENT)
    .map((file) => client(file))
    .join("\n");
  const calls: [string, string, string, string][] = [
    ['path: "/instructions"', "POST", "/v1/runs/r1/instructions", "operator"],
    ['path: "/budget"', "POST", "/v1/runs/r1/budget", "operator"],
    ['"/v1/workstation/stop"', "POST", "/v1/workstation/stop", "viewer"],
    ['"/v1/workstation/actions/\\(seq)/cancel"', "POST", "/v1/workstation/actions/9/cancel", "operator"],
    ['"/v1/workstation/actions/\\(seq)/capture"', "GET", "/v1/workstation/actions/9/capture", "viewer"],
    ['"/v1/workstation/actions/\\(seq)"', "GET", "/v1/workstation/actions/9", "viewer"],
    ['"/v1/workstation/actions", body:', "POST", "/v1/workstation/actions", "operator"],
    ['"/v1/workstation/meetings/\\(encoded)"', "GET", "/v1/workstation/meetings/m1", "viewer"],
    ['case .workstation: "/v1/workstation/session"', "GET", "/v1/workstation/session", "viewer"],
    ['"/v1/workstation/requests?limit=', "GET", "/v1/workstation/requests", "viewer"],
    ['"/v1/workstation/requests", body:', "POST", "/v1/workstation/requests", "operator"],
    ['"/v1/workstation/requests/\\(encoded)"', "GET", "/v1/workstation/requests/q1", "viewer"],
    ['"/v1/workstation/requests/\\(id)/cancel"', "POST", "/v1/workstation/requests/q1/cancel", "operator"],
    ['"/v1/workstation/automations")', "GET", "/v1/workstation/automations", "viewer"],
    ['"/v1/workstation/automations", body:', "POST", "/v1/workstation/automations", "operator"],
    ['"/v1/workstation/automations/\\(id)/launch"', "POST", "/v1/workstation/automations/a1/launch", "operator"],
    ['"DELETE", "/v1/workstation/automations/\\(id)"', "DELETE", "/v1/workstation/automations/a1", "operator"],
    ['"PUT", "/v1/workstation/settings"', "PUT", "/v1/workstation/settings", "operator"],
    ['readIfServed("/v1/vigie")', "GET", "/v1/vigie", "viewer"],
    ['"PUT", "/v1/vigie"', "PUT", "/v1/vigie", "admin"],
    ['"/v1/vigie/incidents?limit=', "GET", "/v1/vigie/incidents", "viewer"],
    ['readIfServed("/v1/schedules")', "GET", "/v1/schedules", "viewer"],
    ['"POST", "/v1/schedules"', "POST", "/v1/schedules", "operator"],
    ['"PUT", "/v1/schedules/\\(', "PUT", "/v1/schedules/s1", "operator"],
    ['"DELETE", "/v1/schedules/\\(', "DELETE", "/v1/schedules/s1", "operator"],
    [
      '"POST", "/v1/schedules/\\(HarnessModel.pathComponent(schedule.id))/run"',
      "POST",
      "/v1/schedules/s1/run",
      "operator",
    ],
    ['path: "/v1/clients"', "GET", "/v1/clients", "admin"],
    ['"POST", "/v1/clients"', "POST", "/v1/clients", "admin"],
    ['"DELETE", "/v1/clients/\\(', "DELETE", "/v1/clients/c1", "admin"],
    ['path: "/v1/repos"', "GET", "/v1/repos", "viewer"],
    ['"POST", "/v1/repos"', "POST", "/v1/repos", "admin"],
    ['"POST", "/v1/reload"', "POST", "/v1/reload", "admin"],
    ['"/v1/client-errors?limit=', "GET", "/v1/client-errors", "viewer"],
    ['mcpPath = "/v1/mcp"', "POST", "/v1/mcp", "viewer"],
  ];
  for (const [literal, method, sample, role] of calls) {
    assert.ok(sources.includes(literal), `le client n'appelle plus ${literal}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, role, `le serveur ne sert pas ${method} ${sample} au rôle ${role}`);
  }
  // Les issues n'ont d'autre surface que le MCP : les deux outils appelés existent.
  const mcp = fs.readFileSync(path.join(ROOT, "omp-harness", "mcp.ts"), "utf8");
  for (const tool of ["issues_list", "issue_fix"]) {
    assert.ok(client("HarnessControlModels.swift").includes(`"${tool}"`), `le client n'appelle plus ${tool}`);
    assert.match(mcp, new RegExp(`name: "${tool}"`), `le MCP ne sert plus ${tool}`);
  }
});

test("tour-de-controle/AC-2 : chaque champ de la vigie, des planifications, des clients, de la file et du budget décodé par le client Swift existe dans le JSON RÉEL du serveur", async () => {
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
      const json = (await response.json()) as Record<string, unknown>;
      assert.ok(response.status < 300, `${method} ${route} : ${response.status} ${JSON.stringify(json)}`);
      return json;
    };
    const wire = client("HarnessControlWire.swift");

    const vigie = await call("GET", "/v1/vigie");
    covers(vigie, swiftFields(wire, "VigieView"), "VigieView");
    covers(vigie.settings, swiftFields(wire, "VigieSettings"), "VigieSettings");
    covers(vigie.today, swiftFields(wire, "VigieToday"), "VigieToday");
    const modes = [...wire.slice(wire.indexOf("enum VigieMode")).matchAll(/^ {4}case (\w+)$/gm)]
      .slice(0, 4)
      .map(([, name]) => name);
    assert.deepEqual(modes, ["off", "shadow", "report", "fix"]);

    const created = await call("POST", "/v1/schedules", {
      name: "audit du lundi",
      cron: "0 8 * * 1",
      target: { kind: "audit", repo: "demo", focus: "" },
    });
    covers(created.schedule, swiftFields(wire, "HarnessSchedule"), "HarnessSchedule");
    const listed = await call("GET", "/v1/schedules");
    assert.equal(typeof listed.timezone, "string");
    covers((listed.schedules as unknown[])[0], swiftFields(wire, "HarnessSchedule"), "HarnessSchedule (liste)");

    const clients = await call("GET", "/v1/clients");
    covers((clients.clients as unknown[])[0], swiftFields(wire, "HarnessManagedClient"), "HarnessManagedClient");

    const status = await call("GET", "/v1/status");
    covers(status.queue, swiftFields(wire, "HarnessQueueStatus"), "HarnessQueueStatus");

    // Un run en file sur un dépôt retiré : l'admission dit ce qui le retient (`waitCause`).
    world.store.createRun({
      id: "r9",
      repo: "parti",
      slug: "x",
      title: "X",
      request: "x",
      branch: "b",
      state: "queued",
      step: "req",
    });
    await world.orchestrator.tick();
    const held = await call("GET", "/v1/runs/r9");
    const run = held.run as Record<string, unknown>;
    assert.equal(run.waitCause, "unknown_repo", JSON.stringify(run));
    assert.equal(typeof run.reason, "string");
    const budget = held.budget as Record<string, unknown>;
    covers(budget, swiftFields(client("HarnessMonitoring.swift"), "HarnessBudget"), "HarnessBudget");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

test("tour-de-controle/AC-3 : Vigie, Planifications, Issues et Administration sont câblées dans les deux apps, l'Administration aux seuls admins", () => {
  // Vigie, Planifications et Administration sont des pages du hub Système ; Issues,
  // une portée de la section Features.
  const section = read("Sources", "ConsoleCore", "Design", "ConsoleSection.swift");
  assert.match(
    section,
    /public enum SystemPage[^{]*\{\s*case vigie\s*case schedules\s*case autonomy\s*case stats\s*case admin\s*case server/,
  );
  assert.match(section, /public enum RunsScope[^{]*\{\s*case features\s*case projects\s*case audits\s*case issues/);
  assert.match(section, /public var isAdminOnly: Bool \{ self == \.admin \}/);
  assert.match(section, /allCases\.filter \{ isAdmin \|\| !\$0\.isAdminOnly \}/);
  const mac = read("Sources", "OMPConsole", "Server", "SystemPages.swift");
  const ios = read("ios", "OMPConsoleIOS", "IOSHarnessScreens.swift");
  for (const [name, macView, iosView] of [
    ["vigie", "VigieSections", "IOSVigieScreen"],
    ["schedules", "SystemSchedulesPage", "IOSSchedulesScreen"],
    ["admin", "AdminSections", "IOSAdminScreen"],
  ] as const) {
    assert.match(
      mac,
      new RegExp(`case \\.${name}:\\s*(HarnessForm\\(server: server, drafts: drafts\\) \\{ )?${macView}\\(`),
      `Mac : .${name}`,
    );
    assert.match(ios, new RegExp(`case \\.${name}: ${iosView}\\(`), `iOS : .${name}`);
  }
  assert.match(
    read("Sources", "OMPConsole", "Server", "HarnessSectionViews.swift"),
    /case \.issues:\s*HarnessForm\(server: server, drafts: drafts\) \{ IssuesSections\(/,
    "Mac : portée Issues",
  );
  assert.match(ios, /case \.issues: IssuesSections\(/, "iOS : portée Issues");
  // Les écrans iOS passent par le cadre commun et rendent le contenu partagé (ConsoleUI).
  for (const shared of ["VigieSections(", "SchedulesSections(", "IssuesSections(", "AdminSections("])
    assert.ok(ios.includes(shared), `iOS ne rend pas ${shared}`);
  // L'Administration est masquée hors admin : hub Système (partagé) et palettes des deux apps.
  assert.match(
    read("Sources", "ConsoleUI", "SystemViews.swift"),
    /ForEach\(SystemPage\.visible\(isAdmin: server\.isAdmin\)/,
  );
  for (const palette of [
    read("Sources", "ConsoleUI", "CommandPalette.swift"),
    read("ios", "OMPConsoleIOS", "IOSSearchScreen.swift"),
  ])
    assert.match(palette, /systemPages: SystemPage\.visible\(isAdmin: server\.isAdmin\)/);
  // La consigne s'envoie depuis la page d'une feature, dans les deux apps (vue partagée).
  assert.match(
    read("Sources", "OMPConsole", "Server", "RunPageView.swift"),
    /RunInstructionsComposer\(server: server, drafts: drafts, runId: run\.id\)/,
  );
  assert.match(
    read("ios", "OMPConsoleIOS", "IOSRunScreen.swift"),
    /RunInstructionsComposer\(server: server, drafts: drafts, runId: runId\)/,
  );
});

test("tour-de-controle/AC-4 : l'arrêt d'urgence n'est jamais grisé par le rôle et passe par une confirmation", () => {
  const header = read("Sources", "ConsoleUI", "WorkstationSections.swift");
  const start = header.indexOf("struct WorkstationHeaderSection");
  assert.ok(start >= 0, "l'en-tête du Poste (état et arrêt d'urgence) est introuvable");
  const stop = header.slice(start, header.indexOf("// MARK: -", start));
  assert.match(stop, /drafts\.workstationStopAsked = true/, "le bouton ne fait que demander confirmation");
  assert.doesNotMatch(stop, /canAct/, "l'arrêt ne dépend pas du rôle du jeton");
  assert.doesNotMatch(stop, /workstation\.stop\(\)/, "le bouton n'arrête pas sans confirmation");
  const ui = read("Sources", "ConsoleUI", "WorkstationControlSections.swift");
  assert.match(ui, /Button\(ControlText\.stop, role: \.destructive\) \{\s*Task \{ await workstation\.stop\(\) \}/);
  const palette = read("Sources", "ConsoleUI", "CommandPalette.swift");
  assert.match(palette, /case \.stopWorkstation:\s*select\(\.workstation\)\s*drafts\.workstationStopAsked = true/);
});
