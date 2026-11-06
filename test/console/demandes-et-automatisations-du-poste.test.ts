// Feature demandes-et-automatisations-du-poste : les blocs « Demandes » et « Automatisations »
// de la section Poste, dans l'app Mac et dans l'app iOS. Le modèle est prouvé par les tests
// Swift (`WorkstationModelTests.swift`) ; ici, sur Linux, les vues sont lues comme du texte —
// chaque geste appelle le bon appel du modèle, aucun libellé n'est écrit en dur — et le
// prérequis serveur, la documentation et le glossaire sont vérifiés.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, apiRoutes } from "../../omp-harness/http.ts";
import { ROOT } from "../support/repo.ts";

const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

/** Le code d'une source Swift, sans ses commentaires de ligne. */
const code = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

type View = {
  label: string;
  source: string;
  /** Préfixe des identifiants d'accessibilité. */
  prefix: string;
  requests: string;
  automations: string;
  screen: string;
  profile: string;
  approvals: string;
  gestures: string;
};

const VIEWS: View[] = [
  {
    label: "Mac",
    source: code(read("omp-console", "Sources", "OMPConsole", "Server", "WorkstationViews.swift")),
    prefix: "workstation.",
    requests: "WorkstationRequestsSection",
    automations: "WorkstationAutomationsSection",
    screen: "WorkstationView",
    profile: "WorkstationProfileSections",
    approvals: "WorkstationApprovalsSection",
    gestures: "WorkstationGestures",
  },
  {
    label: "iOS",
    source: code(read("omp-console", "ios", "OMPConsoleIOS", "IOSWorkstationScreen.swift")),
    prefix: "ios.workstation.",
    requests: "IOSWorkstationRequestsSection",
    automations: "IOSWorkstationAutomationsSection",
    screen: "IOSWorkstationScreen",
    profile: "IOSWorkstationProfileSections",
    approvals: "IOSWorkstationApprovalsSection",
    gestures: "IOSWorkstationGestures",
  },
];

/** Le texte d'une déclaration `struct Nom` jusqu'à son accolade fermante en colonne 0. */
function structBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^(?:private )?struct ${name}\\b`, "m"));
  assert.ok(start >= 0, `struct ${name} introuvable`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `struct ${name} : fin introuvable`);
  return source.slice(start, end + 3);
}

/** Les sections Demandes et Automatisations, avec leurs lignes (iOS : `IOSWorkstationRequestRow`). */
function newBlocks(view: View): string {
  const start = view.source.search(new RegExp(`^struct ${view.requests}\\b`, "m"));
  assert.ok(start >= 0, `${view.label} : ${view.requests} introuvable`);
  const automations = structBody(view.source, view.automations);
  const end = view.source.indexOf(automations, start) + automations.length;
  return view.source.slice(start, end);
}

const textSource = read("omp-console", "Sources", "ConsoleCore", "Design", "WorkstationText.swift");

for (const view of VIEWS) {
  const blocks = newBlocks(view);
  const tag = (ac: string) => `demandes-et-automatisations-du-poste/${ac} (${view.label})`;

  test(`${tag("AC-1")} : les deux blocs s'insèrent sous le drapeau, entre les envois à approuver et le profil ; le geste « Demander » appelle ask`, () => {
    const screen = structBody(view.source, view.screen);
    const gate = screen.indexOf("if workstation.requestsEnabled {");
    assert.ok(gate > 0, "les blocs sont sous workstation.requestsEnabled");
    const approvals = screen.indexOf(`${view.approvals}(`);
    const requests = screen.indexOf(`${view.requests}(`);
    const automations = screen.indexOf(`${view.automations}(`);
    const profile = screen.indexOf(`${view.profile}(`);
    assert.ok(approvals < gate && gate < requests && requests < automations && automations < profile, "ordre des sections");
    assert.ok(blocks.includes("TextField(WorkstationText.instructionLabel, text: $drafts.workstationInstruction") || blocks.includes("WorkstationText.instructionLabel,"));
    assert.ok(blocks.includes("prompt: Text(WorkstationText.instructionPrompt)"));
    assert.ok(blocks.includes("Button(WorkstationText.ask)"));
    assert.ok(blocks.includes("await workstation.ask(drafts.workstationInstruction)"));
    assert.ok(blocks.includes(`"${view.prefix}ask"`) && blocks.includes(`"${view.prefix}instruction"`));
    assert.ok(blocks.includes(`"${view.prefix}requests"`) && blocks.includes("WorkstationText.requestsTitle"));
    assert.ok(blocks.includes("WorkstationText.requestsHint"));
  });

  test(`${tag("AC-3")} : « Demander » est désactivé pour une consigne vide ou d'espaces, et pour un lecteur`, () => {
    assert.match(
      blocks,
      /\.disabled\(!workstation\.canAct \|\| workstation\.isAsking \|\| !WorkstationModel\.canAsk\(drafts\.workstationInstruction\)\)/,
    );
  });

  test(`${tag("AC-4")} : la consigne n'est vidée que lorsque la demande est posée`, () => {
    assert.match(blocks, /if await workstation\.ask\(drafts\.workstationInstruction\) \{ drafts\.workstationInstruction = "" \}/);
    assert.equal(blocks.split('drafts.workstationInstruction = ""').length - 1, 1);
    assert.ok(!/\/v1\/runs|\/v1\/projects|startRun|launchRun/.test(blocks), "aucune exécution de pipeline");
  });

  test(`${tag("AC-5")} : l'échec de « Demander » (poste en pause, 409) s'affiche dans le bloc Demandes`, () => {
    const requests = structBody(view.source, view.requests);
    assert.ok(requests.includes("workstation.requestsFailure"));
    assert.ok(requests.includes(view.label === "Mac" ? "HarnessFailureLabel(failure:" : "failure.message"));
  });

  test(`${tag("AC-7")} : chaque demande montre son état, sa raison d'attente ou d'échec`, () => {
    assert.ok(blocks.includes("WorkstationText.requestState(request.state)"));
    assert.ok(blocks.includes("WorkstationText.reason("));
    assert.ok(blocks.includes(`"${view.prefix}request.\\(id)"`));
  });

  test(`${tag("AC-9")} : le détail se déplie dans la ligne (une demande à la fois) : actions avec leur raison, compte rendu`, () => {
    assert.ok(blocks.includes("DisclosureGroup("));
    assert.ok(blocks.includes("WorkstationText.requestDetails"));
    assert.ok(blocks.includes("workstation.openRequestId == id"));
    assert.ok(blocks.includes("await workstation.open(request: id)"));
    assert.ok(blocks.includes("workstation.closeRequest()"));
    assert.ok(blocks.includes(`"${view.prefix}requestDetail.\\(id)"`));
    for (const symbol of [
      "WorkstationText.requestActionsTitle",
      "WorkstationText.noRequestAction",
      "WorkstationText.kind(action.kind)",
      "action.rationale",
      "WorkstationText.state(action.state)",
      "WorkstationText.reportTitle",
    ])
      assert.ok(blocks.includes(symbol), `${symbol} absent`);
  });

  test(`${tag("AC-10")} : l'état d'une demande passe par WorkstationText.requestState, sans libellé écrit en dur`, () => {
    assert.ok(blocks.includes("WorkstationText.requestState("));
    assert.ok(!/Text\("(En file|En cours|Terminée|Échouée|Annulée)/.test(blocks));
  });

  test(`${tag("AC-11")} : « Annuler » ouvre une confirmation, et seul son bouton destructif appelle cancel`, () => {
    const gestures = structBody(view.source, view.gestures);
    assert.ok(gestures.includes("WorkstationText.cancelRequestConfirm"));
    assert.match(
      gestures,
      /Button\(WorkstationText\.cancelRequest, role: \.destructive\) \{\s*Task \{ await workstation\.cancel\(request\) \}\s*\}/,
    );
    assert.ok(gestures.includes("Button(WorkstationText.keepRequest, role: .cancel) {}"));
    assert.ok(gestures.includes("WorkstationText.cancelRequestMessage"));
    if (view.label === "iOS") assert.match(gestures, /WorkstationText\.cancelRequestConfirm,[^]*?titleVisibility: \.visible/);
  });

  test(`${tag("AC-12")} : aucun bouton « Annuler » sur une demande qui n'est ni en file ni en cours`, () => {
    assert.match(
      blocks,
      /if WorkstationModel\.canCancel\(request\.phase\) \{\s*Button\(PipelineServerText\.cancel, role: \.destructive\) \{/,
    );
    assert.ok(blocks.includes(`"${view.prefix}cancelRequest.\\(id)"`));
    assert.ok(blocks.includes("workstation.busyRequests.contains(id)"));
  });

  test(`${tag("AC-13")} : le bouton de la ligne ne fait que poser le brouillon ; ne pas confirmer n'appelle rien`, () => {
    assert.ok(blocks.includes("drafts.workstationCancelRequest = request"));
    assert.ok(!blocks.includes("workstation.cancel("), "la ligne n'annule pas elle-même");
    assert.equal(view.source.split("workstation.cancel(").length - 1, 1, "un seul appel : le bouton de la confirmation");
  });

  test(`${tag("AC-14")} : « Automatiser » envoie l'indice servi de la tâche, dans l'ordre du profil`, () => {
    const profile = structBody(view.source, view.profile);
    assert.ok(profile.includes("ForEach(Array(profile.repetitiveTasks.enumerated()), id: \\.offset)"));
    assert.ok(profile.includes("await workstation.automate(taskAt: offset, of: profile)"));
    assert.ok(profile.includes(`"${view.prefix}automate.\\(offset)"`));
  });

  test(`${tag("AC-15")} : « Automatiser » n'est proposé que sur une tâche automatisable, et seulement sous le drapeau`, () => {
    const profile = structBody(view.source, view.profile);
    const button = profile.indexOf("Button(WorkstationText.automate)");
    assert.ok(button > 0);
    const before = profile.slice(0, button);
    const gate = before.lastIndexOf("task.automatable");
    assert.ok(gate > 0, "sous task.automatable");
    assert.ok(profile.slice(gate, button).includes("workstation.requestsEnabled"), "et sous requestsEnabled");
    assert.equal(profile.split("Button(WorkstationText.automate)").length - 1, 1);
  });

  test(`${tag("AC-17")} : « Lancer » appelle launch ; sur iOS chaque Button des sections a son .buttonStyle(`, () => {
    assert.ok(blocks.includes("Button(PipelineServerText.launch)"));
    assert.ok(blocks.includes("await workstation.launch(automation)"));
    assert.ok(blocks.includes(`"${view.prefix}launchAutomation.\\(id)"`));
    assert.ok(blocks.includes("workstation.busyAutomations.contains(id)"));
    if (view.label === "iOS") {
      const chunks = blocks.split("Button(").slice(1);
      for (const chunk of chunks) {
        const upToNext = chunk;
        assert.ok(upToNext.includes(".buttonStyle("), `un Button sans .buttonStyle( : Button(${chunk.slice(0, 60)}`);
      }
    }
  });

  test(`${tag("AC-18")} : « Supprimer » demande confirmation, et seul le bouton destructif du dialogue appelle delete`, () => {
    assert.ok(blocks.includes("drafts.workstationAutomationRemoval = automation"));
    assert.ok(blocks.includes(`"${view.prefix}deleteAutomation.\\(id)"`));
    assert.ok(!blocks.includes("workstation.delete("));
    const gestures = structBody(view.source, view.gestures);
    assert.ok(gestures.includes("WorkstationText.deleteAutomationConfirm"));
    assert.match(
      gestures,
      /Button\(WorkstationText\.deleteAutomation, role: \.destructive\) \{\s*Task \{ await workstation\.delete\(automation\) \}\s*\}/,
    );
    assert.ok(gestures.includes("Button(PipelineServerText.cancel, role: .cancel) {}"));
    assert.ok(gestures.includes("WorkstationText.deleteAutomationMessage"));
    assert.equal(view.source.split("workstation.delete(").length - 1, 1);
    assert.ok(blocks.includes('automation.steps.joined(separator: " → ")'));
  });

  test(`${tag("AC-19")} : sans automatisation, le bloc dit comment en créer une`, () => {
    assert.match(blocks, /if (?:workstation\.)?automations\.isEmpty \{\s*Text\(WorkstationText\.noAutomation\)/);
    assert.ok(blocks.includes("WorkstationText.automationsHint") && blocks.includes("WorkstationText.automationsTitle"));
    assert.ok(blocks.includes(`"${view.prefix}automations"`) && blocks.includes(`"${view.prefix}automation.\\(id)"`));
  });

  test(`${tag("AC-20")} : le refus approbateur se dit dans les deux blocs et en tête des tâches répétitives du profil`, () => {
    const approver = view.label === "Mac" ? "HarnessFailureLabel(failure:" : "IOSApproverOnlyNotice()";
    const requests = structBody(view.source, view.requests);
    const automations = structBody(view.source, view.automations);
    assert.ok(requests.includes("workstation.requestsFailure") && requests.includes(approver), "Demandes : refus approbateur");
    assert.ok(automations.includes("workstation.automationsFailure") && automations.includes(approver), "Automatisations : refus approbateur");
    const profile = structBody(view.source, view.profile);
    const head = profile.indexOf("workstation.automateFailure");
    assert.ok(head > 0 && head < profile.indexOf("ForEach(Array(profile.repetitiveTasks.enumerated())"), "avant la liste des tâches");
    assert.ok(profile.includes(approver));
    // Les gestes restent offerts à un jeton ordinaire : seul le rôle lecteur les désactive.
    assert.ok(blocks.includes("!workstation.canAct"));
  });

  test(`${tag("AC-21")} : sans le drapeau workstation-requests, ni blocs ni bouton « Automatiser »`, () => {
    const screen = structBody(view.source, view.screen);
    const gate = screen.indexOf("if workstation.requestsEnabled {");
    const close = screen.indexOf("}", screen.indexOf(`${view.automations}(`));
    assert.ok(gate > 0 && close > gate);
    assert.ok(!screen.slice(0, gate).includes(`${view.requests}(`) && !screen.slice(close).includes(`${view.requests}(`));
    assert.ok(!screen.slice(0, gate).includes(`${view.automations}(`) && !screen.slice(close).includes(`${view.automations}(`));
  });

  test(`${tag("AC-22")} : aucun libellé écrit en dur dans les blocs ; chaque symbole cité existe dans WorkstationText`, () => {
    // Un constructeur visible reçoit un symbole de vocabulaire, une variable ou une valeur du modèle.
    for (const [, constructor, argument] of blocks.matchAll(/\b(Button|Text|TextField|DisclosureGroup|confirmationDialog|Section)\(([^\n]*)/g)) {
      const first = (argument as string).trimStart();
      if (first === "" || first.startsWith("{")) continue;
      const allowed =
        /^(WorkstationText\.|PipelineServerText\.|request\.|automation\.|action\.|report|failure\.|reason|detail|open|workstation\.|drafts\.|isExpanded)/;
      const literal = /^"[^"]*\p{L}[^"]*"/u.test(first);
      assert.ok(!literal, `${view.label} : libellé en dur dans ${constructor}(${first.slice(0, 50)}`);
      assert.ok(first.startsWith('"') || allowed.test(first) || first.startsWith("!") || first.startsWith("."), `${constructor}(${first.slice(0, 50)} : symbole inattendu`);
    }
    const symbols = new Set([...(blocks + structBody(view.source, view.gestures)).matchAll(/WorkstationText\.(\w+)/g)].map((m) => m[1] as string));
    for (const symbol of symbols)
      assert.ok(
        new RegExp(`public (?:static let|static func) ${symbol}\\b`).test(textSource),
        `WorkstationText.${symbol} n'existe pas`,
      );
  });
}

test("demandes-et-automatisations-du-poste/AC-22 : chaque nouveau libellé de WorkstationText a sa traduction anglaise, aux bonnes clés", () => {
  const strings = read("omp-console", "Sources", "ConsoleCore", "Resources", "en.lproj", "Localizable.strings");
  const nbsp = "\u00a0";
  const expected: [string, string][] = [
    ["Demandes", "Requests"],
    ["Consigne", "Instruction"],
    ["Demander", "Ask"],
    ["Actions déposées", "Actions Taken"],
    ["Compte rendu", "Report"],
    [`Annuler cette demande${nbsp}?`, "Cancel this request?"],
    ["Annuler la demande", "Cancel Request"],
    ["Garder la demande", "Keep Request"],
    ["Annulée par vous", "Cancelled by you"],
    ["Automatisations", "Automations"],
    ["Automatiser", "Automate"],
    [`Supprimer cette automatisation${nbsp}?`, "Delete this automation?"],
  ];
  for (const [fr, en] of expected) {
    assert.ok(strings.includes(`"${fr}" = "${en}";`), `traduction absente : ${fr} → ${en}`);
    assert.ok(textSource.includes(`L10n.text("${fr}")`), `${fr} : absent de WorkstationText`);
  }
  // Les mots communs viennent de PipelineServerText ou de clés déjà traduites.
  assert.ok(textSource.includes('requestDetails = L10n.text("Détails")'));
  assert.ok(textSource.includes('deleteAutomation = L10n.text("Supprimer")'));
  assert.ok(textSource.includes("public static func requestState(_ raw: String) -> String"));
});

test("demandes-et-automatisations-du-poste/AC-23 : le glossaire nomme demande, consigne, automatisation et compte rendu", () => {
  const glossary = read("omp-console", "GLOSSAIRE.md");
  const nbsp = "\u00a0";
  for (const [term, forms, retained] of [
    ["request", "`request`, `requests`", "demande"],
    ["prompt", "`prompt`, `prompts`", "consigne"],
    ["automation", "`automation`, `automations`", "automatisation"],
    ["report", "`report`, `reports`", "compte rendu"],
  ] as const)
    assert.ok(
      new RegExp(`^\\| ${term} \\| ${forms.replace(/[`,]/g, (c) => `\\${c}`)} \\| ${retained} \\| «${nbsp}.+${nbsp}» \\|$`, "m").test(glossary),
      `ligne de glossaire absente : ${term}`,
    );
});

test("demandes-et-automatisations-du-poste/AC-26 : le README décrit les deux blocs, leurs routes et leurs identifiants Mac et iOS, tous présents dans les vues", () => {
  const readme = read("omp-console", "README.md");
  const start = readme.indexOf("### Poste de travail");
  assert.ok(start >= 0);
  const next = readme.indexOf("\n### ", start + 5);
  const section = readme.slice(start, next < 0 ? undefined : next);
  for (const needle of [
    "**Demandes**",
    "**Automatisations**",
    "POST /v1/workstation/requests",
    "GET /v1/workstation/requests",
    "/v1/workstation/requests/{id}/cancel",
    "/v1/workstation/automations",
    "/v1/workstation/automations/{id}/launch",
    "DELETE /v1/workstation/automations/{id}",
    "workstation-requests",
    "/v1/health",
    "workstation_request",
    "workstation_automation",
    "ios.",
  ])
    assert.ok(section.includes(needle), `README § Poste de travail : ${needle} absent`);
  const ids = [
    "workstation.requests",
    "workstation.instruction",
    "workstation.ask",
    "workstation.request.<id>",
    "workstation.requestDetail.<id>",
    "workstation.cancelRequest.<id>",
    "workstation.automate.<n>",
    "workstation.automations",
    "workstation.automation.<id>",
    "workstation.launchAutomation.<id>",
    "workstation.deleteAutomation.<id>",
  ];
  const mac = code(read("omp-console", "Sources", "OMPConsole", "Server", "WorkstationViews.swift"));
  const ios = code(read("omp-console", "ios", "OMPConsoleIOS", "IOSWorkstationScreen.swift"));
  for (const id of ids) {
    assert.ok(section.includes(`\`${id}\``), `README § Poste de travail : identifiant ${id} absent`);
    const literal = id.replace("<id>", "\\(id)").replace("<n>", "\\(offset)");
    assert.ok(mac.includes(`"${literal}"`), `vue Mac : ${literal} absent`);
    assert.ok(ios.includes(`"ios.${literal}"`), `vue iOS : ios.${literal} absent`);
  }
});

test("demandes-et-automatisations-du-poste/AC-29 : le contrat serveur dont dépendent les blocs est présent (routes, événements, drapeau, doc, types Swift)", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const served: [string, string][] = [
    ["POST", "/v1/workstation/requests"],
    ["GET", "/v1/workstation/requests"],
    ["GET", "/v1/workstation/requests/r1"],
    ["POST", "/v1/workstation/requests/r1/cancel"],
    ["GET", "/v1/workstation/automations"],
    ["POST", "/v1/workstation/automations"],
    ["POST", "/v1/workstation/automations/a1/launch"],
    ["DELETE", "/v1/workstation/automations/a1"],
  ];
  const missing: string[] = [];
  for (const [method, sample] of served)
    if (!routes.some((route) => route.method === method && route.pattern.test(sample))) missing.push(`route ${method} ${sample}`);
  const events = read("omp-harness", "events.ts");
  for (const name of ["workstation_request", "workstation_automation"])
    if (!events.includes(name)) missing.push(`événement ${name} (omp-harness/events.ts)`);
  if (!API_FEATURES.includes("workstation-requests")) missing.push("drapeau workstation-requests (API_FEATURES)");
  const harnessReadme = read("omp-harness", "README.md");
  for (const prefix of ["/v1/workstation/requests", "/v1/workstation/automations"])
    if (!harnessReadme.includes(prefix)) missing.push(`${prefix} dans omp-harness/README.md`);
  const wire = read("omp-console", "Sources", "ConsoleClient", "WorkstationWire.swift");
  for (const type of ["WorkstationRequest", "WorkstationRequestState", "WorkstationRequestDetail", "WorkstationAutomation"])
    if (!new RegExp(`public (?:struct|enum) ${type}\\b`).test(wire)) missing.push(`type Swift ${type}`);
  if (!wire.includes("requestId")) missing.push("requestId sur WorkstationAction");
  assert.deepEqual(missing, [], `prérequis serveur manquant : ${missing.join(" ; ")}`);
});
