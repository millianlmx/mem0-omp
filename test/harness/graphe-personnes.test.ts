// Feature graphe-personnes (OS agentique 4/6, sous-feature « Graphe des personnes ») : le poste
// tient un graphe des collègues, alimenté par les contenus que la lecture des canaux a gardés
// (expéditeurs et destinataires Gmail, participants de l'Agenda, auteurs Slack) et par les
// signalements du poste, lu par le propriétaire (`GET /v1/workstation/people`) et corrigé champ
// par champ depuis l'appareil approbateur (`PATCH /v1/workstation/people/{id}`, If-Match).
// Données fictives seulement (exemple.fr).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { PersonView } from "../../omp-harness/canaux/personnes.ts";
import { parseAddresses } from "../../omp-harness/canaux/personnes.ts";
import type { ChannelMessageInput } from "../../omp-harness/db.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const SELF = "moi@exemple.fr";
const ROOT = path.resolve(import.meta.dirname, "../..");

type Reply<T> = { status: number; json: T };
type Api = {
  viewer: string;
  admin: string;
  narrow: string;
  call: <T = Record<string, unknown>>(
    method: string,
    route: string,
    body?: unknown,
    token?: string,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("graphe-personnes-"), "clients.json"), ADMIN);
  const approver = clients.add("app-approbateur", "admin", "*", true).token;
  const admin = clients.add("mac", "admin", "*").token;
  const viewer = clients.add("ipad", "viewer", "*").token;
  const narrow = clients.add("mac-demo", "operator", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    viewer,
    admin,
    narrow,
    call: async <T>(method: string, route: string, body?: unknown, token = approver, headers = {}) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, json: (text ? JSON.parse(text) : null) as T };
    },
    close: async () => {
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}

async function setup(patch?: (config: FakeWorld["config"]) => void): Promise<{ world: FakeWorld; api: Api }> {
  const world = fakeWorld({}, patch ? { patch } : {});
  world.orchestrator.workstation.updateSettings({ selfIdentities: [SELF] }, { by: "test" });
  return { world, api: await serve(world) };
}

async function teardown(world: FakeWorld, api: Api): Promise<void> {
  await api.close();
  await world.orchestrator.stop();
}

let seq = 0;
/** Un message tel que la lecture des canaux le garde (canaux/lecture-google.ts, lecture-slack.ts). */
function message(input: Partial<ChannelMessageInput> & Pick<ChannelMessageInput, "channel">): ChannelMessageInput {
  seq++;
  return {
    id: `${input.channel}:${seq}`,
    sourceId: String(seq),
    threadId: `t${seq}`,
    conversation: null,
    conversationKind: null,
    origin: "history",
    author: null,
    at: Date.now(),
    subject: null,
    text: "",
    headers: {},
    labels: [],
    mentionsMe: false,
    bot: false,
    readAt: Date.now(),
    ...input,
  };
}

/** Un fil Gmail entre l'utilisateur et `from`. */
function gmail(world: FakeWorld, from: string, to = SELF): void {
  world.store.addChannelMessage(
    message({ channel: "gmail", author: from, subject: "Planning", headers: { From: from, To: to } }),
  );
}

const people = async (api: Api, token?: string) =>
  (await api.call<{ people: PersonView[] }>("GET", "/v1/workstation/people", undefined, token)).json.people;
const byEmail = (list: PersonView[], email: string) => list.find((p) => p.emails.includes(email));
const patch = (api: Api, person: PersonView, body: unknown, rev: number | null = person.rev, token?: string) =>
  api.call<{ person: PersonView; error?: string }>(
    "PATCH",
    `/v1/workstation/people/${person.id}`,
    body,
    token,
    rev === null ? {} : { "If-Match": `"${rev}"` },
  );

test("graphe-personnes/AC-1 : GET rend les personnes avec tous leurs champs, leur révision et leurs champs corrigés ; 403 client restreint, 404 poste désactivé", async () => {
  const { world, api } = await setup();
  try {
    gmail(world, "Alice Martin <alice@exemple.fr>");
    gmail(world, "Bruno Petit <bruno@exemple.fr>");
    world.orchestrator.people.feed();
    const list = await people(api, api.viewer);
    assert.equal(list.length, 2, "l'utilisateur lui-même n'est pas une personne du graphe");
    const alice = byEmail(list, "alice@exemple.fr") as PersonView;
    assert.deepEqual(Object.keys(alice).sort(), [
      "corrected",
      "createdAt",
      "delegation",
      "emails",
      "id",
      "name",
      "projects",
      "rev",
      "role",
      "slackIds",
      "team",
      "tone",
      "topics",
      "updatedAt",
    ]);
    assert.equal(alice.name, "Alice Martin");
    assert.equal(alice.rev, 1);
    assert.deepEqual(alice.corrected, {
      name: false,
      emails: false,
      slackIds: false,
      role: false,
      team: false,
      projects: false,
      tone: false,
      delegation: false,
      topics: false,
    });
    assert.ok(byEmail(list, "bruno@exemple.fr"));
    // Une correction se lit comme telle.
    assert.equal((await patch(api, alice, { tone: "tutoiement" })).status, 200);
    const corrected = byEmail(await people(api), "alice@exemple.fr") as PersonView;
    assert.equal(corrected.corrected.tone, true);
    assert.equal(corrected.corrected.role, false);

    const narrow = await api.call("GET", "/v1/workstation/people", undefined, api.narrow);
    assert.equal(narrow.status, 403);
    assert.equal(narrow.json.error, "le poste est réservé au propriétaire");
    assert.ok((API_FEATURES as readonly string[]).includes("workstation-people"));
  } finally {
    await teardown(world, api);
  }
  const off = await setup((config) => {
    config.workstation.enabled = false;
  });
  try {
    assert.equal((await off.api.call("GET", "/v1/workstation/people")).status, 404);
    assert.equal((await off.api.call("PATCH", "/v1/workstation/people/pp1", { tone: "x" })).status, 404);
  } finally {
    await teardown(off.world, off.api);
  }
});

test("graphe-personnes/AC-2 : PATCH de l'approbateur avec If-Match : seuls les champs cités changent, la révision avance ; 412, 428, 403, 404, 400", async () => {
  const { world, api } = await setup();
  try {
    gmail(world, "Alice Martin <alice@exemple.fr>");
    gmail(world, "Bruno Petit <bruno@exemple.fr>");
    world.orchestrator.people.feed();
    const read = await people(api);
    const alice = byEmail(read, "alice@exemple.fr") as PersonView;
    const bruno = byEmail(read, "bruno@exemple.fr") as PersonView;
    // Une personne créée par la lecture des canaux entre la lecture de l'app et sa correction.
    gmail(world, "Chloé Durand <chloe@exemple.fr>");
    world.orchestrator.people.feed();
    const chloe = byEmail(await people(api), "chloe@exemple.fr") as PersonView;

    const done = await patch(api, alice, { tone: "vouvoiement, bref", delegation: "brouillon" });
    assert.equal(done.status, 200);
    assert.equal(done.json.person.rev, alice.rev + 1);
    const after = await people(api);
    const alice2 = byEmail(after, "alice@exemple.fr") as PersonView;
    assert.equal(alice2.tone, "vouvoiement, bref");
    assert.equal(alice2.delegation, "brouillon");
    assert.equal(alice2.rev, alice.rev + 1);
    for (const field of ["name", "emails", "slackIds", "role", "team", "projects", "topics"] as const)
      assert.deepEqual(alice2[field], alice[field], `${field} inchangé`);
    assert.deepEqual(byEmail(after, "bruno@exemple.fr"), bruno);
    assert.deepEqual(byEmail(after, "chloe@exemple.fr"), chloe);

    const stale = await patch(api, alice, { tone: "autre" });
    assert.equal(stale.status, 412);
    assert.equal(stale.json.error, "la personne a changé depuis votre lecture : relisez-la");
    assert.equal((byEmail(await people(api), "alice@exemple.fr") as PersonView).tone, "vouvoiement, bref");
    assert.equal((await patch(api, alice2, { tone: "autre" }, null)).status, 428);
    const notApprover = await patch(api, alice2, { tone: "autre" }, alice2.rev, api.admin);
    assert.equal(notApprover.status, 403);
    assert.match(notApprover.json.error ?? "", /seul l'appareil approbateur/);
    assert.equal((await patch(api, { ...alice2, id: "pp-inconnu" }, { tone: "autre" })).status, 404);
    for (const body of [{ delegation: "toujours" }, { humeur: "bonne" }, { emails: ["pas-une-adresse"] }, {}])
      assert.equal((await patch(api, alice2, body)).status, 400, JSON.stringify(body));
    assert.deepEqual(byEmail(await people(api), "alice@exemple.fr"), alice2, "aucun refus n'a rien changé");
    // Pas de PUT de collection.
    assert.equal(
      apiRoutes(world.orchestrator, new ClientRegistry(null, ADMIN)).some(
        (route) => route.path === "/v1/workstation/people" && route.method !== "GET",
      ),
      false,
    );
  } finally {
    await teardown(world, api);
  }
});

test("graphe-personnes/AC-3 : un fil Gmail avec un collègue inconnu crée une personne (nom, adresse) ; un auteur Slack de même adresse la rejoint sans doublon", async () => {
  const { world, api } = await setup();
  try {
    assert.deepEqual(parseAddresses('"Martin, Alice" <Alice@Exemple.fr>, bruno@exemple.fr'), [
      { name: "Martin, Alice", email: "alice@exemple.fr" },
      { name: null, email: "bruno@exemple.fr" },
    ]);
    gmail(world, "Alice Martin <alice@exemple.fr>");
    // Ni une lettre d'information, ni un bot Slack n'entrent dans le graphe.
    world.store.addChannelMessage(
      message({
        channel: "gmail",
        headers: { From: "Lettre <info@exemple.fr>", To: SELF, "List-Unsubscribe": "<mailto:stop@exemple.fr>" },
      }),
    );
    world.store.addChannelMessage(message({ channel: "slack", author: "B0BOT", bot: true }));
    world.orchestrator.people.feed();
    let list = await people(api);
    assert.equal(list.length, 1);
    const alice = list[0] as PersonView;
    assert.equal(alice.name, "Alice Martin");
    assert.deepEqual(alice.emails, ["alice@exemple.fr"]);
    assert.deepEqual(alice.slackIds, []);

    world.store.putSlackUser(
      { id: "U0ALICE", name: "alice", realName: "Alice M.", email: "alice@exemple.fr", bot: false },
      Date.now(),
    );
    world.store.addChannelMessage(message({ channel: "slack", author: "U0ALICE", conversation: "D1" }));
    world.orchestrator.people.feed();
    list = await people(api);
    assert.equal(list.length, 1, "même adresse : une seule personne");
    assert.deepEqual((list[0] as PersonView).slackIds, ["U0ALICE"]);
    assert.equal((list[0] as PersonView).name, "Alice Martin", "le nom déjà connu reste");
    assert.ok(
      world.store
        .eventsOfType("workstation_person")
        .every((e) => e.repo === null && Object.keys(e.payload).join() === "id"),
      "les événements ne portent que l'identifiant, sans dépôt",
    );
    // Les noms et adresses rejoignent ce que la vigie retire des issues.
    const texts = world.store.workstationTexts(0);
    assert.ok(texts.includes("Alice Martin") && texts.includes("alice@exemple.fr"));
  } finally {
    await teardown(world, api);
  }
});

test("graphe-personnes/AC-4 : un rôle corrigé reste face à une nouvelle suggestion ; relâché par role à null, la suggestion suivante le remplace", async () => {
  const { world, api } = await setup();
  try {
    const graph = world.orchestrator.people;
    graph.observe({ name: "Alice Martin", emails: ["alice@exemple.fr"], role: "cheffe de projet" });
    let alice = (await people(api))[0] as PersonView;
    assert.equal(alice.role, "cheffe de projet");
    assert.equal((await patch(api, alice, { role: "directrice technique" })).status, 200);
    graph.observe({ emails: ["alice@exemple.fr"], role: "stagiaire", team: "Plateforme" });
    alice = (await people(api))[0] as PersonView;
    assert.equal(alice.role, "directrice technique", "le rôle corrigé reste");
    assert.equal(alice.team, "Plateforme", "un champ non corrigé suit la suggestion");
    assert.equal(alice.corrected.role, true);

    const released = await patch(api, alice, { role: null });
    assert.equal(released.status, 200);
    assert.equal(released.json.person.corrected.role, false);
    assert.equal(released.json.person.role, "directrice technique", "relâché : la valeur reste jusqu'à la suggestion");
    graph.observe({ emails: ["alice@exemple.fr"], role: "responsable produit" });
    alice = (await people(api))[0] as PersonView;
    assert.equal(alice.role, "responsable produit");
  } finally {
    await teardown(world, api);
  }
});

test("graphe-personnes/AC-5 : une personne créée automatiquement est au niveau jamais sans sujet ; une écriture automatique du niveau ou des sujets est ignorée", async () => {
  const { world, api } = await setup();
  try {
    const graph = world.orchestrator.people;
    graph.observe({
      emails: ["alice@exemple.fr"],
      name: "Alice Martin",
      delegation: "réponse",
      topics: ["planning"],
    });
    let alice = (await people(api))[0] as PersonView;
    assert.equal(alice.delegation, "jamais");
    assert.deepEqual(alice.topics, []);
    // Personne non corrigée : l'écriture automatique du niveau et des sujets est ignorée.
    assert.equal(graph.observe({ emails: ["alice@exemple.fr"], delegation: "brouillon", topics: ["x"] }), null);
    alice = (await people(api))[0] as PersonView;
    assert.equal(alice.delegation, "jamais");
    assert.deepEqual(alice.topics, []);
    // Personne corrigée par l'humain : de même.
    assert.equal((await patch(api, alice, { delegation: "réponse", topics: ["planning"] })).status, 200);
    graph.observe({ emails: ["alice@exemple.fr"], delegation: "jamais", topics: [], tone: "direct" });
    alice = (await people(api))[0] as PersonView;
    assert.equal(alice.delegation, "réponse");
    assert.deepEqual(alice.topics, ["planning"]);
    assert.equal(alice.tone, "direct");
    // Un signalement du poste (observation) dont la personne est une adresse l'ajoute, au niveau jamais.
    world.store.insertSignal({
      id: "sg1",
      channel: "gmail",
      threadRef: "fil-1",
      url: "https://mail.exemple.fr/fil-1",
      personRef: "Bruno <bruno@exemple.fr>",
      excerpt: "extrait",
    });
    graph.feed();
    const bruno = byEmail(await people(api), "bruno@exemple.fr") as PersonView;
    assert.equal(bruno.delegation, "jamais");
    assert.deepEqual(bruno.topics, []);
  } finally {
    await teardown(world, api);
  }
});

test("graphe-personnes/AC-6 : les apps Mac et iOS ont une page Personnes sous Poste, qui liste et corrige chaque champ, absente sur un serveur sans la route", () => {
  const read = (file: string) => fs.readFileSync(path.join(ROOT, "omp-console", file), "utf8");
  const model = read("Sources/ConsoleClient/WorkstationPeople.swift");
  assert.ok(model.includes('method: "PATCH",'));
  assert.ok(model.includes('path: "/v1/workstation/people/\\(HarnessModel.pathComponent(person.id))"'));
  assert.ok(model.includes('HarnessCall(method: "GET", path: "/v1/workstation/people")'));
  assert.ok(model.includes('"If-Match": "\\"\\(person.rev)\\""'), "la révision lue part en If-Match");
  assert.match(model, /reply\.status == 404[\s\S]*clear\(\.absent\)/, "404 : la page disparaît sans erreur");
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, ADMIN));
  for (const [method, sample, role] of [
    ["GET", "/v1/workstation/people", "viewer"],
    ["PATCH", "/v1/workstation/people/pp1", "operator"],
  ] as const)
    assert.equal(routes.find((r) => r.method === method && r.pattern.test(sample))?.role, role);
  // Chaque champ du serveur est lu et corrigeable par le client.
  for (const field of ["name", "emails", "slackIds", "role", "team", "projects", "tone", "delegation", "topics"])
    assert.ok(model.includes(`case ${field}`), `le client ne corrige pas ${field}`);
  const sections = read("Sources/ConsoleUI/WorkstationSections.swift");
  assert.match(sections, /case people/);
  assert.match(sections, /case \.people: people\.availability == \.available/);
  assert.match(sections, /case \.people:\s*WorkstationPeopleSections\(people: people\)/);
  assert.ok(read("Sources/ConsoleUI/WorkstationPeopleViews.swift").includes("struct WorkstationPeopleSections"));
  for (const frame of [
    "Sources/OMPConsole/Server/WorkstationViews.swift",
    "ios/OMPConsoleIOS/IOSWorkstationScreen.swift",
  ])
    assert.ok(read(frame).includes("await server.people.refresh()"), `${frame} : les personnes ne sont pas lues`);
  const harness = read("Sources/ConsoleClient/HarnessModel.swift");
  assert.match(harness, /people\.receive\(names\)/);
  assert.match(harness, /people\.reset\(\)/);
});
