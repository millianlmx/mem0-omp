// Feature ecran-canaux : sous Poste, les apps Mac et iOS ont un écran Canaux qui montre
// l'état de Gmail, de l'Agenda et de Slack (compte, dernière lecture, phrase du serveur) et
// pilote leur connexion par le harness : client OAuth (feuille), connexion complète ou d'un
// seul canal Google, recollage de l'URL de retour, blocage par l'administrateur. Le contrat
// est vérifié des DEUX côtés : chaque route appelée par le client Swift est servie au rôle du
// contrat, chaque champ décodé existe dans le JSON RÉEL du serveur. Le comportement du modèle
// (corps envoyés, refus rendu au geste, 404 et 403) est prouvé par les tests Swift du même
// slug (omp-console/Tests/ConsoleClientTests/WorkstationChannelsTests.swift).
// Aucune donnée réelle : identifiants inventés.
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
/** Le code sans ses commentaires : un nom cité en commentaire ne câble rien. */
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

const MODEL = () => code(read("Sources", "ConsoleClient", "WorkstationChannels.swift"));
const VIEWS = () => code(read("Sources", "ConsoleUI", "WorkstationChannelViews.swift"));
const SECTIONS = () => code(read("Sources", "ConsoleUI", "WorkstationSections.swift"));
const TEXT = () => code(read("Sources", "ConsoleCore", "Design", "WorkstationText.swift"));

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} : objet attendu`);
  return value as Record<string, unknown>;
}

test("ecran-canaux/AC-1 : sous Poste, sur Mac et iOS, l'écran liste les trois canaux avec état, compte, dernière lecture et la phrase du serveur ; il relit sur workstation_channel", () => {
  const sections = SECTIONS();
  assert.match(sections, /case \.channels: ChannelText\.title/);
  assert.match(sections, /static let rows: \[WorkstationPage\] = \[\.settings, \.channels,/);
  assert.match(sections, /case \.channels:\s*WorkstationChannelsSections\(channels: channels\)/);
  assert.match(
    sections,
    /WorkstationPageView\(workstation: workstation, channels: channels, people: people, drafts: drafts, page: page\)/,
  );
  // Les deux apps posent la page principale avec le modèle des canaux et le lisent.
  for (const frame of [
    ["Sources", "OMPConsole", "Server", "WorkstationViews.swift"],
    ["ios", "OMPConsoleIOS", "IOSWorkstationScreen.swift"],
  ]) {
    const source = code(read(...frame));
    assert.ok(
      source.includes(
        "WorkstationSections(workstation: workstation, channels: server.channels, people: server.people, drafts: drafts)",
      ),
      `${frame.join("/")} : la page du Poste n'a pas les canaux`,
    );
    assert.ok(source.includes("await server.channels.refresh()"), `${frame.join("/")} : les canaux ne sont pas lus`);
    assert.ok(source.includes(".workstationDestinations(server: server, drafts: drafts)"));
  }
  // La rangée de chaque canal : nom, pastille d'état, compte, dernière lecture, phrase du serveur.
  const views = VIEWS();
  for (const shown of [
    "ChannelText.channel(channel.id)",
    "ChannelText.status(channel.state)",
    "channel.account",
    "channel.lastReadAt",
    "if let error = channel.error",
  ])
    assert.ok(views.includes(shown), `la rangée d'un canal ne montre pas ${shown}`);
  // Le vocabulaire prend la valeur brute et rend l'inconnu tel quel.
  const text = TEXT();
  for (const fn of ["state", "channel", "connection"])
    assert.match(text, new RegExp(`public static func ${fn}\\(_ raw: String\\) -> String \\{[\\s\\S]*?default: raw`));
  for (const state of ["disconnected", "connected", "reconnect", "blocked", "error"])
    assert.ok(text.includes(`case "${state}":`), `état ${state} sans mot`);
  // L'événement du serveur fait relire, et le client est câblé au flux.
  assert.ok(MODEL().includes('names.contains("workstation_channel")'));
  assert.ok(MODEL().includes("reloadAgain = true"), "un événement pendant une relecture serait perdu");
  const harness = code(read("Sources", "ConsoleClient", "HarnessModel.swift"));
  assert.match(harness, /channels\.receive\(names\)/);
  assert.match(harness, /channels\.reset\(\)/);
  const events = fs.readFileSync(path.join(ROOT, "omp-harness", "events.ts"), "utf8");
  assert.match(events, /"workstation_channel"/);
});

test("ecran-canaux/AC-2 : les gestes (client, connexion complète ou d'un canal Google, recollage, blocage) n'existent que pour l'approbateur ; le refus du serveur revient au geste", () => {
  const views = VIEWS();
  for (const gesture of [
    "channels.setGoogleClient(client)",
    "channels.setSlackClient(clientId: id)",
    "channels.startLogin(connection.id, channels: only)",
    'connect(["gmail"])',
    'connect(["calendar"])',
    "channels.answer(connection.id, value: sent)",
    "channels.declareBlocked(connection.id, channels: only)",
    'block(["gmail"])',
    'block(["calendar"])',
  ])
    assert.ok(views.includes(gesture), `geste absent : ${gesture}`);
  // Les gestes sont posés sous `channels.isApprover` ; ailleurs une phrase dit qui connecte.
  assert.match(
    views,
    /if channels\.isApprover \{\s*ForEach\(channels\.connections\.filter \{ \$0\.login\?\.state == "waiting" \}\)/,
  );
  assert.match(views, /if channels\.isApprover \{\s*Button \{\s*clientSheet = ChannelClientTarget/);
  assert.match(views, /if !channels\.isApprover \{\s*Section \{\s*Text\(ChannelText\.approverOnly\)/);
  assert.match(views, /failure == \.approverOnly \? ChannelText\.approverOnly : failure\.message/);
  assert.match(MODEL(), /public var isApprover: Bool \{ harness\?\.client\?\.approver \?\? false \}/);
  // Le texte d'erreur du fournisseur se recolle tel quel : c'est le serveur qui reconnaît le blocage.
  assert.match(VIEWS(), /Link\(destination: url\)/);
});

test("ecran-canaux/AC-3 : un secret saisi n'est ni réaffiché ni gardé par l'app", () => {
  const views = VIEWS();
  // Saisi dans un champ masqué, dans l'état de la feuille seulement, vidé à l'envoi et à la fermeture.
  assert.match(views, /SecureField\(ChannelText\.clientSecretLabel, text: \$clientSecret\)/);
  assert.match(views, /@State private var clientSecret = ""/);
  assert.match(views, /private func forgetSecrets\(\) \{\s*json = ""\s*clientSecret = ""\s*\}/);
  assert.match(views, /forgetSecrets\(\)\s*Task \{/);
  assert.match(views, /\.onDisappear\(perform: forgetSecrets\)/);
  // Le modèle n'a aucune propriété qui le garde (les corps d'envoi privés ne vivent que
  // le temps du geste), les brouillons partagés non plus.
  const model = MODEL();
  const start = model.indexOf("public final class WorkstationChannelsModel");
  const owner = model.slice(start, model.indexOf("private struct ClientBody"));
  const stored = [...owner.matchAll(/^\s*(?:@Published )?(?:public )?(?:private(?:\(set\))? )?var (\w+)/gm)].map(
    ([, name]) => name as string,
  );
  assert.ok(stored.includes("channels") && stored.includes("connections"), "propriétés du modèle non lues");
  for (const name of stored) assert.doesNotMatch(name, /secret|json/i, `le modèle garde ${name}`);
  assert.doesNotMatch(code(read("Sources", "ConsoleClient", "HarnessDrafts.swift")), /clientSecret|channelSecret/);
  // Le serveur ne le rend jamais : le contrat décodé ne porte ni secret ni jeton.
  assert.doesNotMatch(model.slice(0, start), /secret|token/i);
});

test("ecran-canaux/AC-4 : sur un serveur sans ces routes (404) ou pour un jeton restreint (403), l'écran est absent sans erreur", () => {
  const model = MODEL();
  assert.match(model, /if reply\.status == 404 \{\s*clear\(\.absent\)/);
  assert.match(model, /catch HarnessFailure\.forbidden \{\s*clear\(\.reserved\)/);
  // La rangée de la page n'existe que si le serveur sert les canaux ; le client ne lit pas `features`.
  assert.match(SECTIONS(), /case \.channels: channels\.availability == \.available/);
  assert.doesNotMatch(model, /workstation-channels|features/);
});

test("ecran-canaux/AC-5 : chaque route et chaque champ du client Swift existent dans le routeur et le JSON RÉEL du serveur", async () => {
  const model = MODEL();
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const calls: [string, string, string, string][] = [
    ['path: "/v1/workstation/channels")', "GET", "/v1/workstation/channels", "viewer"],
    ['"/v1/workstation/channels/google/client"', "PUT", "/v1/workstation/channels/google/client", "operator"],
    ['"/v1/workstation/channels/slack/client"', "PUT", "/v1/workstation/channels/slack/client", "operator"],
    [
      '"/v1/workstation/channels/\\(HarnessModel.pathComponent(connection))/login"',
      "POST",
      "/v1/workstation/channels/google/login",
      "operator",
    ],
    [
      '"/v1/workstation/channels/\\(HarnessModel.pathComponent(connection))/login/answer"',
      "POST",
      "/v1/workstation/channels/google/login/answer",
      "operator",
    ],
  ];
  for (const [literal, method, sample, role] of calls) {
    assert.ok(model.includes(literal), `le client n'appelle plus ${literal}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, role, `le serveur ne sert pas ${method} ${sample} au rôle ${role}`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("workstation-channels"));

  const world = fakeWorld({});
  const clients = new ClientRegistry(path.join(tmpdir("ecran-canaux-"), "clients.json"), "a".repeat(64));
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const plain = clients.add("mac", "admin", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
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
    const CHANNELS = "/v1/workstation/channels";

    // Les corps que le client envoie : JSON collé (chaîne), identifiant Slack seul.
    const pasted = JSON.stringify({
      installed: { client_id: "1234-abcdef.apps.googleusercontent.com", client_secret: "secret-invente" },
    });
    const google = await call("PUT", `${CHANNELS}/google/client`, approver, { json: pasted });
    assert.equal(google.status, 200, JSON.stringify(google.json));
    covers(google.json, swiftFields(model, "WorkstationChannelClientReply"), "WorkstationChannelClientReply");
    covers(
      object(google.json.connection, "connection"),
      swiftFields(model, "WorkstationChannelConnection"),
      "WorkstationChannelConnection",
    );
    assert.ok(!JSON.stringify(google.json).includes("secret-invente"), "le serveur ne rend jamais le secret");
    const credentials = await call("PUT", `${CHANNELS}/google/client`, approver, {
      clientId: "1234-abcdef.apps.googleusercontent.com",
      clientSecret: "secret-invente",
    });
    assert.equal(credentials.status, 200, JSON.stringify(credentials.json));
    assert.equal((await call("PUT", `${CHANNELS}/slack/client`, approver, { clientId: "111.222" })).status, 200);

    // Connexion d'un seul canal Google, puis la vue avec la connexion en attente.
    const login = await call("POST", `${CHANNELS}/google/login`, approver, { channels: ["calendar"] });
    assert.equal(login.status, 201, JSON.stringify(login.json));
    covers(login.json, swiftFields(model, "WorkstationChannelLoginReply"), "WorkstationChannelLoginReply");
    covers(object(login.json.login, "login"), swiftFields(model, "WorkstationChannelLogin"), "WorkstationChannelLogin");
    assert.equal((await call("POST", `${CHANNELS}/slack/login`, approver, {})).status, 201);

    const view = await call("GET", CHANNELS);
    assert.equal(view.status, 200);
    covers(view.json, swiftFields(model, "WorkstationChannelsReply"), "WorkstationChannelsReply");
    const listed = view.json.channels as unknown[];
    assert.deepEqual(
      listed.map((channel) => object(channel, "channel").id),
      ["gmail", "calendar", "slack"],
    );
    for (const channel of listed)
      covers(object(channel, "channel"), swiftFields(model, "WorkstationChannel"), "WorkstationChannel");
    const waiting = object((view.json.connections as unknown[])[0], "connections[0]");
    covers(waiting, swiftFields(model, "WorkstationChannelConnection"), "WorkstationChannelConnection");
    covers(
      object(waiting.login, "login"),
      swiftFields(model, "WorkstationChannelLogin"),
      "WorkstationChannelLogin (vue)",
    );
    // L'URL n'est rendue qu'à l'approbateur : un autre jeton du propriétaire lit l'état, sans URL.
    const other = await call("GET", CHANNELS, plain);
    assert.equal(object(object((other.json.connections as unknown[])[0], "c").login, "login").url, null);

    // Déclarer bloqué un seul canal Google, puis toute la connexion Slack.
    const blocked = await call("POST", `${CHANNELS}/google/login/answer`, approver, {
      blocked: true,
      channels: ["calendar"],
    });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.json));
    covers(blocked.json, swiftFields(model, "WorkstationChannelAnswerReply"), "WorkstationChannelAnswerReply");
    const calendar = object((blocked.json.channels as unknown[])[1], "calendar");
    assert.equal(calendar.state, "blocked");
    assert.match(String(calendar.error), /la veille ne lit pas ce canal/);
    assert.equal(object((blocked.json.channels as unknown[])[0], "gmail").state, "disconnected");
    const slack = await call("POST", `${CHANNELS}/slack/login/answer`, approver, { blocked: true });
    assert.equal(slack.status, 200);
    assert.equal(object((slack.json.channels as unknown[])[2], "slack").state, "blocked");

    // Un geste d'un jeton non approbateur : 403 que l'app rend au geste ; un jeton restreint : 403 propriétaire.
    const refused = await call("POST", `${CHANNELS}/google/login`, plain, {});
    assert.equal(refused.status, 403);
    assert.match(String(refused.json.error), /seul l'appareil approbateur/);
    const restricted = await call("GET", CHANNELS, narrow);
    assert.equal(restricted.status, 403);
    assert.equal(restricted.json.error, "le poste est réservé au propriétaire");
  } finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await world.orchestrator.stop();
  }
});
