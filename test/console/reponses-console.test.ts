// Feature reponses-console : les apps Mac et iOS montrent les brouillons de réponse au
// collègue dans « À traiter » (comptés au badge), leur feuille (canal, lien du fil, texte
// modifiable ; Approuver ou, pour une origine `manual`, Copier seulement ; Classer) et
// l'état de la réponse dans la section Origine. Le contrat est vérifié des DEUX côtés :
// chaque route appelée par le client Swift est servie au rôle du contrat, chaque champ
// décodé existe dans le JSON RÉEL du serveur. Données fictives.
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
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("///"))
    .join("\n");

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} : objet attendu`);
  return value as Record<string, unknown>;
}

test("reponses-console/AC-1 : « À traiter » montre les brouillons sur les deux apps, comptés au badge", () => {
  const feed = code(read("Sources", "ConsoleUI", "InboxFeed.swift"));
  assert.match(feed, /ReplyDraftsSection\(signals: signals, drafts: drafts\)/);
  const model = code(read("Sources", "ConsoleClient", "CorporateSignals.swift"));
  // Le badge des deux apps lit `signals.pendingCount`, qui compte les brouillons.
  assert.match(model, /repliesAvailability == \.available \? replies\.count : 0/);
  assert.match(model, /catch HarnessFailure\.forbidden \{\s*clearReplies\(\.reserved\)/);
  assert.match(code(read("Sources", "OMPConsole", "ConsoleRootView.swift")), /\+ signals\.pendingCount/);
  assert.match(code(read("ios", "OMPConsoleIOS", "RootView.swift")), /\+ signals\.pendingCount/);
});

test("reponses-console/AC-2 : la feuille modifie, approuve ou classe ; une origine manual se copie seulement", () => {
  const views = code(read("Sources", "ConsoleUI", "CorporateSignalViews.swift"));
  assert.match(views, /\.sheet\(item: \$drafts\.replyShown\)/);
  assert.match(views, /signals\.edit\(reply, text: text\)/);
  assert.match(views, /signals\.approve\(reply, text: text\)/);
  assert.match(views, /signals\.archive\(reply\)/);
  // Le bouton d'envoi n'existe que hors d'une origine `manual`, qui n'offre que Copier.
  assert.match(views, /if reply\.isCopyOnly \{\s*Button\(copied \? SignalText\.copiedReply : SignalText\.copyReply/);
  assert.match(views, /\} else \{\s*Button\(SignalText\.approveReply\)/);
  assert.match(
    code(read("Sources", "ConsoleClient", "CorporateSignals.swift")),
    /var isCopyOnly: Bool \{ channel == "manual" \}/,
  );
});

test("reponses-console/AC-3 : la section Origine montre l'état de la réponse", () => {
  const views = code(read("Sources", "ConsoleUI", "CorporateSignalViews.swift"));
  assert.match(views, /if let state = origin\.reply \{/);
  for (const state of [".none", ".draft", ".awaitingApproval", ".sent", "case let .other(raw): raw"])
    assert.ok(views.includes(state), `état ${state} non rendu`);
});

test("reponses-console/AC-4 : chaque route et chaque champ du client Swift existent dans le routeur et le JSON RÉEL du serveur", async () => {
  const model = read("Sources", "ConsoleClient", "CorporateSignals.swift");
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const calls: [string, string, string, string][] = [
    ['"/v1/replies?state=draft&limit=', "GET", "/v1/replies", "viewer"],
    ['"PUT", "/v1/replies/\\(HarnessModel.pathComponent(reply.id))"', "PUT", "/v1/replies/rp1", "operator"],
    ['"/v1/replies/\\(HarnessModel.pathComponent(reply.id))/approve"', "POST", "/v1/replies/rp1/approve", "operator"],
    ['"/v1/replies/\\(HarnessModel.pathComponent(reply.id))/archive"', "POST", "/v1/replies/rp1/archive", "operator"],
  ];
  for (const [literal, method, sample, role] of calls) {
    assert.ok(model.includes(literal), `le client n'appelle plus ${literal}`);
    const served = routes.find((route) => route.method === method && route.pattern.test(sample));
    assert.equal(served?.role, role, `le serveur ne sert pas ${method} ${sample} au rôle ${role}`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("corporate-replies"));
  assert.ok(model.includes('names.contains("reply")'), "le client ne relit plus la liste à l'événement reply");
  for (const state of ["aucune", "brouillon", "en attente d'approbation", "envoyée"])
    assert.ok(model.includes(`"${state}"`), `CorporateReplyStatus ne connaît pas ${state}`);

  const world = fakeWorld({});
  const clients = new ClientRegistry(path.join(tmpdir("reponses-console-"), "clients.json"), "a".repeat(64));
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
    const link = (id: string, channel: "slack" | "manual", n: number): string => {
      store.insertSignal({
        id,
        channel,
        threadRef: `${channel}:C0FAKE/${n}`,
        url: channel === "manual" ? "" : `https://acme.slack.example/archives/C0FAKE/p${n}`,
        personRef: "lea@exemple.test",
        excerpt: "L'export échoue depuis hier.",
      });
      store.updateSignal(id, {
        state: "confirmed",
        repo: "demo",
        title: "Export cassé",
        issueRepo: "demo",
        issueNumber: n,
        issueUrl: `https://github.com/moi/demo/issues/${n}`,
        confirmedBy: "app-approbateur",
        confirmedAt: Date.now(),
      });
      const run = store.createRun({
        id: `r${n}`,
        repo: "demo",
        slug: `corpo-${n}`,
        title: `Issue #${n}`,
        request: "corriger",
        branch: `harness/corpo-${n}`,
        state: "merged",
      });
      store.updateRun(run.id, { prUrl: `https://github.com/moi/demo/pull/${n}` });
      store.linkSignalRun(run.id, id);
      return run.id;
    };
    const slackRun = link("sg1", "slack", 1);
    link("sg2", "manual", 2);
    world.orchestrator.corporateReplies.reconcile();

    const wire = code(model);
    const listed = await call("GET", "/v1/replies?state=draft&limit=200");
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const replies = listed.json.replies as unknown[];
    assert.equal(replies.length, 2);
    covers(listed.json, swiftFields(wire, "CorporateReplyList"), "CorporateReplyList");
    for (const [index, item] of replies.entries())
      covers(object(item, `replies[${index}]`), swiftFields(wire, "CorporateReply"), "CorporateReply");
    const manual = replies.map((item) => object(item, "reply")).find((item) => item.channel === "manual");
    assert.ok(manual, "le brouillon d'origine manual porte son canal");
    const slack = replies.map((item) => object(item, "reply")).find((item) => item.channel === "slack");
    assert.ok(slack);

    // Un client restreint : 403 propriétaire, que l'app tait.
    const refused = await call("GET", "/v1/replies?state=draft&limit=200", narrow);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, "le poste est réservé au propriétaire");

    const edited = await call("PUT", `/v1/replies/${slack.id}`, approver, { text: "Bonjour, c’est corrigé." });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    covers(edited.json, swiftFields(wire, "CorporateReplyEnvelope"), "CorporateReplyEnvelope");
    covers(object(edited.json.reply, "reply"), swiftFields(wire, "CorporateReply"), "CorporateReply (modifié)");

    // L'origine manual se copie : le serveur refuse son approbation.
    const copyOnly = await call("POST", `/v1/replies/${manual.id}/approve`, approver, { text: "Bonjour" });
    assert.equal(copyOnly.status, 409);

    const archived = await call("POST", `/v1/replies/${manual.id}/archive`);
    assert.equal(archived.status, 200, JSON.stringify(archived.json));
    covers(object(archived.json.reply, "reply"), swiftFields(wire, "CorporateReply"), "CorporateReply (classé)");

    const origin = await call("GET", `/v1/runs/${slackRun}/origin`);
    assert.equal(origin.status, 200);
    const read = object(origin.json.origin, "origin");
    covers(read, swiftFields(wire, "CorporateRunOrigin"), "CorporateRunOrigin");
    assert.equal(read.reply, "brouillon");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});
