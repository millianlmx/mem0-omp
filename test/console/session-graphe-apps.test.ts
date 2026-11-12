// Feature session-graphe-apps : les rendus de la session en graphe dans les apps Mac et iOS et
// dans le popup d'omp-chrome. Le comportement du client Swift (décodage de la carte et du
// briefing, voies et dossiers de la carte, onglet absent sur un 404 et relu sur `graph`, lien
// d'un nœud vers le direct, alerte locale réduite à headline et stake) est prouvé côté Swift
// (omp-console/Tests/ConsoleClientTests/SessionGrapheAppsTests.swift, session-graphe-apps/AC-90
// à AC-94). Ce fichier juge ce qui se voit dans le dépôt et contre le serveur RÉEL : l'ordre
// des couches de la carte d'une question, le briefing en tête des specs et des arbitrages,
// l'onglet « Carte » des deux pages, le popup (service worker sur la doublure de `chrome.*`,
// boîte servie par le vrai gestionnaire HTTP) et le contrat des champs que le client décode.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { buildCard } from "../../omp-harness/card.ts";
import { apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { WAIT_REASON } from "../../omp-harness/machine.ts";
import type { PendingQuestion } from "../../omp-chrome/src/lib/questions.ts";
import { layoutSchema, optionLine, pendingQuestions, wrap } from "../../omp-chrome/src/lib/questions.ts";
import { DEMO_RUN, demoWorld, GRAPH_RUN } from "../../scripts/recette/mac-shots-serveur.ts";
import { fakeChrome, flush } from "../support/chrome-double.ts";
import { ROOT } from "../support/repo.ts";
import { covers, swiftFields } from "../support/swift-contract.ts";

const CONSOLE = path.join(ROOT, "omp-console");
const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const TOKEN = "t".repeat(64);
const SPECS_RUN = "demo-specs";

/** Le serveur de démonstration de la capture Mac, servi par le vrai gestionnaire HTTP, avec une feature dont les specs attendent. */
async function serveDemo() {
  const world = demoWorld();
  world.store.createRun({
    id: SPECS_RUN,
    repo: "demo",
    slug: "export-factures",
    title: "Export des factures",
    request: "Exporter les factures en CSV.",
    branch: "harness/export-factures",
    state: "awaiting_human",
    step: "specs",
  });
  world.store.updateRun(SPECS_RUN, { reason: WAIT_REASON.specs });
  const card = buildCard(
    {
      headline: "Faut-il dater chaque export de factures ?",
      stake: "Sans date, un export ne se retrouve plus.",
      established: "Les specs exportent les factures en CSV.",
      options: [
        { label: "valider les specs", impact: "L'implémentation démarre sur ces specs.", reversible: true },
        { label: "refaire /specs", impact: "Un tour de plus avant le code.", reversible: true, cost: "moyen" },
      ],
      recommended: "valider les specs",
      confidence: "moyenne",
    },
    true,
  );
  world.store.putArtifact(
    SPECS_RUN,
    "_briefing.json",
    JSON.stringify({ kind: "specs", briefing: { feature: "Elle exporte les factures en CSV.", cards: [card] } }),
    null,
  );
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (route: string) =>
    (await realFetch(`${url}${route}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Promise<
      Record<string, unknown>
    >;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  };
  return { world, url, get, close };
}

/** Le corps d'une struct Swift (jusqu'à sa première accolade fermante en colonne 0). */
function swiftBody(source: string, start: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `${start} introuvable`);
  return source.slice(from, source.indexOf("\n}\n", from));
}

/** Vérifie que `needles` apparaissent dans `text`, dans cet ordre. */
function inOrder(text: string, needles: string[], label: string): void {
  let at = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, at + 1);
    assert.ok(next > at, `${label} : « ${needle} » manque ou n'est pas à sa place`);
    at = next;
  }
}

test("session-graphe-apps/AC-1 : dans « Comprendre » (Mac et iOS), une escalade à carte se lit headline + stake + une ligne par option, puis le schéma natif aux options cliquables, puis la carte d'exploration (repliée sur iPhone), puis les Détails repliés ; sans carte, l'affichage d'avant", async () => {
  const feed = read(CONSOLE, "Sources", "ConsoleUI", "InboxFeed.swift");
  const batch = swiftBody(feed, "struct EscalationBatchCard: View");
  inOrder(
    batch,
    [
      "if let card = item.card {",
      "DecisionCardSummary(card: card)",
      "BifurcationSchemaView(schema: card.schema, selected: drafts.answer(for: item)) { option in",
      "drafts.answers[item.id] = option",
      "CardExplorationView(server: server, runId: batch.id, escalationId: item.id",
      "CardDetailsView(context: item.shownContext, rationale: item.shownRationale)",
      "} else {",
      "QuestionContextView(context: item.shownContext)",
      "QuestionChoiceRow(",
    ],
    "EscalationBatchCard",
  );
  // La carte de ce que la feature attend se pose en tête de « Comprendre », partagé par les deux plateformes.
  assert.match(read(CONSOLE, "Sources", "ConsoleUI", "RunPendingCard.swift"), /EscalationBatchCard\(/);
  assert.match(read(CONSOLE, "Sources", "ConsoleUI", "OS", "OSUnderstandView.swift"), /RunPendingCard\(server: server/);
  for (const host of [
    read(CONSOLE, "Sources", "OMPConsole", "OS", "OSRootView.swift"),
    read(CONSOLE, "ios", "OMPConsoleIOS", "IOSOSScreens.swift"),
  ])
    assert.match(host, /OSUnderstandView\(/);

  const cards = read(CONSOLE, "Sources", "ConsoleUI", "DecisionCardViews.swift");
  const summary = swiftBody(cards, "public struct DecisionCardSummary: View");
  inOrder(summary, ["Text(card.headline)", "SessionGraphText.stake(card.stake)", "DecisionOptionLine("], "synthèse");
  const line = swiftBody(cards, "struct DecisionOptionLine: View");
  for (const piece of [
    "option.impact",
    "SessionGraphText.reversible",
    "SessionGraphText.irreversible",
    "SessionGraphText.cost",
    "RecommendedBadge()",
  ])
    assert.ok(line.includes(piece), `ligne d'option : ${piece}`);
  // Le schéma est dessiné nativement : établi → ambiguïté → fourche (une Shape) → options → impacts.
  const schema = swiftBody(cards, "public struct BifurcationSchemaView: View");
  inOrder(
    schema,
    ["schema.established", "schema.ambiguity", "SchemaFork(branches:", "option(branch.option)", "branch.impact"],
    "schéma",
  );
  assert.match(cards, /struct SchemaFork: Shape \{/);
  assert.match(schema, /Button \{ choose\(node\.label\) \}/);
  for (const source of [cards, read(CONSOLE, "Sources", "ConsoleUI", "SessionGraphViews.swift")])
    assert.doesNotMatch(source, /WKWebView|WebView|mermaid/i, "ni WebView ni Mermaid");
  // La carte d'exploration : repliée sur iPhone (largeur compacte), ouverte ailleurs ; les preuves de l'escalade surlignées.
  const exploration = swiftBody(
    read(CONSOLE, "Sources", "ConsoleUI", "SessionGraphViews.swift"),
    "public struct CardExplorationView: View",
  );
  assert.match(exploration, /#if os\(iOS\)\s+sizeClass == \.compact\s+#else\s+false/);
  assert.match(exploration, /if collapses \{\s+DisclosureGroup \{/);
  assert.match(exploration, /read\.highlighted\(escalation: escalationId\)/);
  assert.match(swiftBody(cards, "public struct CardDetailsView: View"), /DisclosureGroup\(SessionGraphText\.details\)/);

  // Le serveur RÉEL : la boîte porte l'escalade de démonstration avec sa carte et son schéma.
  const demo = await serveDemo();
  try {
    const inbox = await demo.get("/v1/inbox");
    const batches = inbox.batches as { run: { id: string }; items: Record<string, unknown>[] }[];
    const item = batches.find((each) => each.run.id === GRAPH_RUN)?.items[0] as Record<string, unknown>;
    const card = item.card as { headline: string; schema: { nodes: { kind: string }[] } };
    assert.equal(item.question, card.headline, "un client ancien lit la headline");
    assert.deepEqual(
      [...new Set(card.schema.nodes.map((node) => node.kind))],
      ["established", "ambiguity", "option", "impact"],
    );
  } finally {
    await demo.close();
  }
});

test("session-graphe-apps/AC-2 : specs à valider et arbitrages — le briefing (ce que fait la feature, puis les cartes des points ambigus) s'affiche en tête de la carte, avant le document complet", async () => {
  const feed = read(CONSOLE, "Sources", "ConsoleUI", "InboxFeed.swift");
  inOrder(
    swiftBody(feed, "struct SpecsCard: View"),
    [
      "QuestionPlaceView(place: inbox.question(run))",
      "BriefingView(briefing: briefing)",
      "drafts.specs[run.id]",
      "ConsoleMarkdown(blocks:",
    ],
    "SpecsCard",
  );
  inOrder(
    swiftBody(feed, "struct VerdictCard: View"),
    [
      "QuestionPlaceView(place: inbox.question(run))",
      "BriefingView(briefing: briefing)",
      "if let verdict = run.verdict",
      "ConsoleMarkdown(markdown: verdict.summary)",
    ],
    "VerdictCard",
  );
  const briefing = swiftBody(
    read(CONSOLE, "Sources", "ConsoleUI", "DecisionCardViews.swift"),
    "public struct BriefingView: View",
  );
  inOrder(
    briefing,
    [
      "if !briefing.isEmpty",
      "SessionGraphText.feature(briefing.feature)",
      "DecisionCardSummary(card: card)",
      "BifurcationSchemaView(schema: card.schema)",
    ],
    "BriefingView",
  );

  // Le serveur RÉEL : le briefing est servi sur la boîte et sur la vue du run ; vide pour un run qui n'attend pas de specs.
  const demo = await serveDemo();
  try {
    const inbox = await demo.get("/v1/inbox");
    const awaiting = inbox.awaiting as { id: string; briefing: { feature: string; cards: unknown[] } }[];
    const specs = awaiting.find((run) => run.id === SPECS_RUN);
    assert.equal(specs?.briefing.feature, "Elle exporte les factures en CSV.");
    assert.equal(specs?.briefing.cards.length, 1);
    const view = (await demo.get(`/v1/runs/${SPECS_RUN}`)).run as { briefing: unknown };
    assert.deepEqual(view.briefing, specs?.briefing);
    const verdict = awaiting.find((run) => run.id === DEMO_RUN);
    assert.deepEqual(verdict?.briefing, { feature: "", cards: [] });
  } finally {
    await demo.close();
  }
});

test("session-graphe-apps/AC-3 : le niveau « Récit » de « Comprendre » (Mac et iOS) montre la carte — graphe relu sur l'événement `graph`, dossiers dépliables, ambiguïtés et décisions en évidence, nœud → entrée du direct — et sans la capacité `session-graph`, le fil du direct", async () => {
  const source = read(CONSOLE, "Sources", "ConsoleUI", "OS", "OSUnderstandView.swift");
  const name = "OSUnderstandView.swift";
  inOrder(
    swiftBody(source, "private func story(_ run: HarnessRun) -> some View"),
    ["if graph.showsTab {", "RunGraphSections(", "workspace.level = .raw", "} else {", "live(run, .timeline)"],
    `${name} : la carte au Récit, le direct sans graphe servi`,
  );
  assert.ok(source.includes("await graph.load()"), `${name} : le graphe est lu à l'ouverture`);
  assert.match(
    source,
    /\.onChange\(of: server\.graphVersions\[runId\]\) \{ _, version in\s+Task \{ await graph\.receive\(version: version\) \}/,
  );
  assert.ok(source.includes("HarnessGraphLink.links(in: read, entries: feed.entries)"), `${name} : nœud → direct`);
  // Le direct du Mac défile jusqu'à l'entrée ouverte depuis la Carte.
  assert.match(
    read(CONSOLE, "Sources", "OMPConsole", "Server", "HarnessSessionView.swift"),
    /guard let seq = focus\.wrappedValue[^\n]*\n\s+proxy\.scrollTo\(seq, anchor: \.center\)/,
  );
  // Le modèle relit le graphe sur l'événement éphémère `graph` du flux de la feature.
  const model = read(CONSOLE, "Sources", "ConsoleClient", "HarnessModel.swift");
  assert.match(model, /else if let version = event\.graphVersion \{[^}]*graphVersions\[runId\] = version/);
  const views = read(CONSOLE, "Sources", "ConsoleUI", "SessionGraphViews.swift");
  assert.match(views, /struct GraphFlowLayout: Layout \{/);
  assert.match(views, /DisclosureGroup\(isExpanded: Binding\(/, "les dossiers se déplient");
  assert.match(views, /let highlighted = focus\.isEmpty \? graph\.allHighlighted : focus/);
  assert.match(views, /node\.isAmbiguity \? tint\.opacity/, "ambiguïtés et décisions teintées");
  // Les vues partagées n'écrivent aucun mot en dur : tout vient de SessionGraphText, traduit en anglais.
  for (const file of ["SessionGraphViews.swift", "DecisionCardViews.swift"])
    assert.doesNotMatch(read(CONSOLE, "Sources", "ConsoleUI", file), /\b(Text|Label|Button|DisclosureGroup)\("/);
  const words = read(CONSOLE, "Sources", "ConsoleCore", "Design", "SessionGraphText.swift");
  const english = read(CONSOLE, "Sources", "ConsoleCore", "Resources", "en.lproj", "Localizable.strings");
  const keys = [...words.matchAll(/L10n\.(?:text|format)\("([^"]+)"/g)].map(([, key]) => key as string);
  assert.ok(keys.length >= 30, "le vocabulaire de la session en graphe");
  for (const key of keys) assert.ok(english.includes(`"${key}" = "`), `traduction anglaise de « ${key} »`);

  // Le serveur RÉEL : le graphe de démonstration (deux étapes, dossiers, escalade et ses preuves), servi au viewer.
  const demo = await serveDemo();
  try {
    const graph = (await demo.get(`/v1/runs/${GRAPH_RUN}/graph`)) as {
      nodes: { id: string; kind: string; step: string | null }[];
      ambiguities: { node: string; evidence: string[] }[];
    };
    assert.deepEqual(graph.nodes.filter((node) => node.kind === "step").length, 2, "une voie par étape");
    assert.ok(graph.nodes.some((node) => node.kind === "dir"));
    assert.deepEqual(graph.ambiguities[0]?.evidence, ["file:src/factures/relance.ts", "file:src/courriel/envoi.ts"]);
    const routes = apiRoutes(demo.world.orchestrator, new ClientRegistry(null, TOKEN));
    assert.equal(
      routes.find((route) => route.method === "GET" && route.pattern.test("/v1/runs/r1/graph"))?.role,
      "viewer",
    );
    const unknown = await realFetch(`${demo.url}/v1/runs/inconnu/graph`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(unknown.status, 404, "un 404 cache l'onglet");
  } finally {
    await demo.close();
  }
});

// -- AC-4 : le popup d'omp-chrome ----------------------------------------------------------------------

const realFetch = globalThis.fetch;
const chrome = fakeChrome();
(globalThis as Record<string, unknown>).chrome = chrome.api;
const posted: { path: string; body: unknown }[] = [];
let harness = "";

// Le service worker parle au VRAI gestionnaire HTTP pour lire ; les réponses sont simulées (le run ne repart pas).
globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if ((init.method ?? "GET") === "POST" && url.pathname.endsWith("/escalations")) {
    posted.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ run: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.pathname === "/v1/inbox") return realFetch(`${harness}${url.pathname}`, init);
  return new Response(JSON.stringify({ error: "route inconnue" }), { status: 404 });
}) as typeof fetch;

test("session-graphe-apps/AC-4 : le popup montre chaque question en attente — headline, stake, options avec leur impact — et son schéma en SVG construit en code (createElementNS + textContent, jamais innerHTML) ; une option cliquée répond", async () => {
  const demo = await serveDemo();
  harness = demo.url;
  try {
    chrome.reset();
    chrome.local.set("settings", { pairing: { url: "http://harness.test", token: TOKEN }, excluded: [] });
    // Chemin calculé : le programme de types des tests (sans DOM ni `chrome`) ne suit pas le service worker.
    await import(pathToFileURL(path.join(ROOT, "omp-chrome", "src", "background.ts")).href);
    await flush();
    chrome.state.sender = { id: "ext", url: "chrome-extension://ext/popup/popup.html" };
    const reply = (await chrome.api.runtime.sendMessage({ to: "background", type: "questions-get" })) as {
      ok: boolean;
      value: PendingQuestion[];
    };
    assert.equal(reply.ok, true);
    const question = reply.value.find((each) => each.runId === GRAPH_RUN) as PendingQuestion;
    assert.equal(question.headline, "Combien de relances pour une même facture impayée ?");
    assert.equal(question.stake, "Trop de relances agacent les clients ; trop peu laissent filer des impayés.");
    assert.deepEqual(question.options.map(optionLine), [
      "une seule fois — Un seul courriel ; le suivi reste manuel ensuite. · réversible · recommandée",
      "chaque semaine — Un courriel par semaine jusqu'au paiement ; risque de relancer un client qui a payé. · irréversible · coût moyen",
    ]);
    // Le schéma en nombres : établi, ambiguïté, une colonne par option (cliquable) et son impact dessous.
    const layout = layoutSchema(question.schema as NonNullable<PendingQuestion["schema"]>);
    assert.deepEqual(
      layout.boxes.map((box) => box.kind),
      ["established", "ambiguity", "option", "option", "impact", "impact"],
    );
    assert.deepEqual(
      layout.boxes.filter((box) => box.answer !== null).map((box) => box.answer),
      ["une seule fois", "chaque semaine"],
    );
    const [first, second] = layout.boxes.filter((box) => box.kind === "option");
    assert.ok(first && second && first.x < second.x && first.y === second.y, "les options côte à côte");
    assert.equal(layout.links.length, 5, "établi → ambiguïté → 2 options → 2 impacts");
    assert.ok(layout.boxes.every((box) => box.lines.every((text) => text.length <= 60)));
    assert.deepEqual(wrap("un deux trois quatre", 9), ["un deux", "trois", "quatre"]);

    const answered = (await chrome.api.runtime.sendMessage({
      to: "background",
      type: "question-answer",
      runId: GRAPH_RUN,
      id: question.id,
      answer: "une seule fois",
    })) as { ok: boolean };
    assert.equal(answered.ok, true);
    assert.deepEqual(posted, [
      { path: `/v1/runs/${GRAPH_RUN}/escalations`, body: { answers: [{ id: question.id, answer: "une seule fois" }] } },
    ]);
    // Une escalade sans carte (serveur ancien) : sa question, ses options et leurs impacts, sans schéma.
    const legacy = pendingQuestions({
      batches: [
        {
          run: { id: "r9", title: "Ancienne" },
          items: [
            { id: 3, question: "Q ?", options: ["a", "b"], impacts: ["ia", "ib"], recommended: "a", status: "open" },
          ],
        },
      ],
    });
    assert.deepEqual(legacy[0]?.options.map(optionLine), ["a — ia · recommandée", "b — ib"]);
    assert.equal(legacy[0]?.schema, null);
  } finally {
    await demo.close();
  }
  const popup = read(ROOT, "omp-chrome", "src", "popup", "popup.ts");
  assert.doesNotMatch(popup, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(popup, /document\.createElementNS\(SVG, tag\)/);
  assert.match(popup, /span\.textContent = line;/);
  assert.match(read(ROOT, "omp-chrome", "src", "popup", "popup.html"), /id="questions" hidden/);
});

test("session-graphe-apps/AC-5 : chaque champ que le client Swift décode de la carte, du briefing et du graphe existe dans le JSON RÉEL du serveur, et la route du graphe appelée par le client est servie", async () => {
  const wire = read(CONSOLE, "Sources", "ConsoleClient", "HarnessWire.swift");
  const graphWire = read(CONSOLE, "Sources", "ConsoleClient", "HarnessSessionGraph.swift");
  const demo = await serveDemo();
  try {
    const inbox = await demo.get("/v1/inbox");
    const batch = (inbox.batches as { run: { id: string }; items: Record<string, unknown>[] }[]).find(
      (each) => each.run.id === GRAPH_RUN,
    );
    const item = batch?.items[0] as Record<string, unknown>;
    covers(item, swiftFields(wire, "HarnessEscalation"), "HarnessEscalation");
    const card = item.card as Record<string, unknown>;
    const cardFields = swiftFields(graphWire, "HarnessCard");
    covers(card, cardFields, "card");
    assert.deepEqual(Object.keys(card).sort(), [...cardFields.keys()].sort());
    const options = card.options as Record<string, unknown>[];
    const optionFields = swiftFields(graphWire, "HarnessCardOption");
    covers(options.find((option) => "cost" in option) as Record<string, unknown>, optionFields, "card.options[]");
    for (const option of options)
      for (const key of Object.keys(option)) assert.ok(optionFields.has(key), `option.${key}`);
    const schema = card.schema as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
    covers(schema, swiftFields(graphWire, "HarnessCardSchema"), "card.schema");
    for (const node of schema.nodes) covers(node, swiftFields(graphWire, "HarnessSchemaNode"), "schema.nodes[]");
    for (const edge of schema.edges) covers(edge, swiftFields(graphWire, "HarnessSchemaEdge"), "schema.edges[]");

    const specs = (inbox.awaiting as Record<string, unknown>[]).find((run) => run.id === SPECS_RUN) as Record<
      string,
      unknown
    >;
    // `briefing` n'est servi que par la boîte et la vue du run : il porte une valeur par défaut côté Swift.
    assert.match(swiftBody(wire, "public struct HarnessRun:"), /public var briefing: HarnessBriefing\? = nil/);
    assert.match(wire, /briefing = try container\.decodeIfPresent\(HarnessBriefing\.self, forKey: \.briefing\)/);
    covers(specs.briefing as Record<string, unknown>, swiftFields(graphWire, "HarnessBriefing"), "briefing");

    const graph = await demo.get(`/v1/runs/${GRAPH_RUN}/graph`);
    const graphFields = swiftFields(graphWire, "HarnessGraph");
    covers(graph, graphFields, "graph");
    assert.deepEqual(Object.keys(graph).sort(), [...graphFields.keys()].sort());
    const nodeFields = swiftFields(graphWire, "HarnessGraphNode");
    for (const node of graph.nodes as Record<string, unknown>[]) {
      covers(node, nodeFields, "graph.nodes[]");
      assert.deepEqual(Object.keys(node).sort(), [...nodeFields.keys()].sort());
    }
    for (const edge of graph.edges as Record<string, unknown>[])
      covers(edge, swiftFields(graphWire, "HarnessGraphEdge"), "graph.edges[]");
    for (const ambiguity of graph.ambiguities as Record<string, unknown>[])
      covers(ambiguity, swiftFields(graphWire, "HarnessGraphAmbiguity"), "graph.ambiguities[]");
  } finally {
    await demo.close();
  }
  // La route que le client appelle, servie au viewer ; un 404 rend `nil` (onglet absent), une autre panne lève.
  const model = read(CONSOLE, "Sources", "ConsoleClient", "HarnessModel.swift");
  assert.ok(model.includes('try await readIfServed("/v1/runs/\\(Self.encoded(runId))/graph")'));
});
