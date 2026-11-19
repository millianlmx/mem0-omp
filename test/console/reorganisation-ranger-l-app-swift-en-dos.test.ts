// Feature reorganisation-ranger-l-app-swift-en-dos : le client (ConsoleClient) et les écrans partagés (ConsoleUI) des
// apps Mac et iOS sont rangés en dossiers de domaine. Chaque racine ne garde que ses transverses, une carte
// (DEVELOPPEMENT.md) dit la responsabilité de chaque dossier, et aucun chemin de source Swift cité (documentation,
// commentaires, tests) ne meurt ni ne désigne, par un nom nu, un fichier qui a changé de dossier.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

type Target = "ConsoleClient" | "ConsoleUI";

/** Les dossiers du client et les noms de base rangés dedans (B-1). */
const CLIENT_LAYOUT: Record<string, string[]> = {
  Autonomy: ["HarnessAutonomy.swift", "HarnessLoop.swift", "HarnessStandingRules.swift"],
  Connection: [
    "ClientPreferences.swift",
    "HarnessAppLifecycle.swift",
    "HarnessErrorReporter.swift",
    "HarnessFailureText.swift",
    "HarnessReadGate.swift",
    "HarnessShellReads.swift",
    "HarnessTransport.swift",
    "KeychainTokenStore.swift",
  ],
  Control: [
    "HarnessControlModels.swift",
    "HarnessControlWire.swift",
    "HarnessMCP.swift",
    "HarnessProviders.swift",
    "HarnessServices.swift",
  ],
  Intake: ["HarnessIntake.swift"],
  Memory: ["MemoryAccess.swift", "MemoryPayloads.swift", "MemoryReader.swift", "MemoryWriter.swift"],
  Notifications: [
    "HarnessLiveActivity.swift",
    "HarnessNotificationCenter.swift",
    "HarnessNotifications.swift",
    "HarnessWidget.swift",
  ],
  OS: [
    "HarnessBrief.swift",
    "HarnessDashboard.swift",
    "HarnessLocalSessions.swift",
    "HarnessProposals.swift",
    "OSDecisions.swift",
    "OSPulse.swift",
    "OSSpaces.swift",
    "OSThreadStore.swift",
    "OSThreads.swift",
  ],
  Pairing: ["HarnessPairLink.swift", "HarnessPairing.swift"],
  Palette: ["HarnessPalette.swift"],
  Runs: [
    "HarnessDrafts.swift",
    "HarnessLaunch.swift",
    "HarnessMonitoring.swift",
    "HarnessProofsBoard.swift",
    "HarnessQuestion.swift",
    "HarnessRunsHistory.swift",
    "HarnessSession.swift",
    "HarnessSessionGraph.swift",
  ],
  Spaces: ["ConsoleSpacePreference.swift", "HarnessScope.swift", "HarnessSpaceFrontier.swift", "HarnessSpaces.swift"],
  Workstation: [
    "Atlassian.swift",
    "ServerBrowserModel.swift",
    "ServerBrowserWire.swift",
    "WorkstationControl.swift",
    "WorkstationControlWire.swift",
    "WorkstationModel.swift",
    "WorkstationWire.swift",
  ],
};

/** Les dossiers des écrans partagés et les noms de base rangés dedans (B-2). */
const UI_LAYOUT: Record<string, string[]> = {
  Autonomy: ["AutonomyViews.swift"],
  Control: ["ControlTowerSections.swift", "RepoSettingsViews.swift", "ServicesViews.swift"],
  Inbox: ["DecisionCardViews.swift", "InboxFeed.swift", "QuestionViews.swift", "RunPendingCard.swift"],
  Intake: ["IntakeViews.swift"],
  Memory: ["MemoryEditSheet.swift"],
  Notifications: ["NotificationRoutes.swift"],
  Palette: ["CommandPalette.swift", "CreationSheets.swift"],
  Pairing: ["PairDeviceViews.swift", "PairQRCode.swift"],
  Runs: [
    "LaunchViews.swift",
    "RunControlViews.swift",
    "RunMenuItems.swift",
    "RunProofsViews.swift",
    "RunViews.swift",
    "SessionGraphViews.swift",
  ],
  Workstation: ["AtlassianViews.swift", "WorkstationControlSections.swift", "WorkstationSections.swift"],
};

/** Les seuls `.swift` qui restent à la racine de chaque cible. */
const ROOTS_KEPT: Record<Target, string[]> = {
  ConsoleClient: ["HarnessModel.swift", "HarnessWire.swift"],
  ConsoleUI: ["ConsoleShell.swift"],
};

/** Les 28 fichiers de ConsoleUI/OS/, qui ne bougent pas. */
const UI_OS = [
  "OSAutomationsView",
  "OSAutonomyPicker",
  "OSBriefSections",
  "OSDecideLogic",
  "OSDecideProof",
  "OSDecisionCard",
  "OSGlyphs",
  "OSHomeView",
  "OSKnowledgeView",
  "OSLabels",
  "OSLocalSessionCard",
  "OSLocalSessionClipboard",
  "OSProposalsView",
  "OSRadar",
  "OSRunBlockedCard",
  "OSRunGestures",
  "OSRunRedoMenu",
  "OSRunStopSheet",
  "OSScoreTiles",
  "OSSpaceMark",
  "OSSpaceViews",
  "OSSystemHub",
  "OSThreadList",
  "OSThreadView",
  "OSTriageView",
  "OSUnderstandView",
  "OSVisuals",
  "OSWorkspace",
].map((name) => `${name}.swift`);

/** Nom de base → cible et dossier, pour les 80 fichiers déplacés. */
const MOVED = new Map<string, { target: Target; dir: string }>();
for (const [target, layout] of [
  ["ConsoleClient", CLIENT_LAYOUT],
  ["ConsoleUI", UI_LAYOUT],
] as const)
  for (const [dir, names] of Object.entries(layout)) for (const name of names) MOVED.set(name, { target, dir });

const LAYOUTS: Record<Target, Record<string, string[]>> = { ConsoleClient: CLIENT_LAYOUT, ConsoleUI: UI_LAYOUT };
const TARGETS: Target[] = ["ConsoleClient", "ConsoleUI"];
const SOURCES = path.join(ROOT, "omp-console", "Sources");
const SELF = "test/console/reorganisation-ranger-l-app-swift-en-dos.test.ts";

/** Un chemin du système en chemin à `/`. */
const posix = (file: string): string => file.split(path.sep).join("/");

/** Les `.swift` sous `omp-console/Sources/<cible>/`, en chemins relatifs à la cible, triés. Une racine absente lève. */
function targetFiles(target: string): string[] {
  const root = path.join(SOURCES, target);
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
    found.push(posix(path.relative(root, path.join(entry.parentPath, entry.name))));
  }
  return found.sort();
}

test("reorganisation-ranger-l-app-swift-en-dos/AC-201 : chaque racine ne garde que ses transverses et chaque fichier est dans son dossier de domaine", () => {
  const faults: string[] = [];
  for (const target of TARGETS) {
    const files = targetFiles(target);
    const kept = ROOTS_KEPT[target];
    const atRoot = files.filter((file) => !file.includes("/"));
    for (const name of atRoot) {
      if (kept.includes(name)) continue;
      const home = MOVED.get(name);
      faults.push(
        home
          ? `${target}/${name} : à la racine, attendu ${home.target}/${home.dir}/`
          : `${target}/${name} : fichier non listé à la racine`,
      );
    }
    for (const name of kept)
      if (!atRoot.includes(name)) faults.push(`${target}/${name} : transverse absent de la racine`);

    for (const [dir, names] of Object.entries(LAYOUTS[target])) {
      for (const name of names) {
        if (files.includes(`${dir}/${name}`)) continue;
        const found = files.filter((file) => file === name || file.endsWith(`/${name}`));
        const where = found.length ? found.map((file) => path.posix.dirname(file).replace(/^\.$/, "(racine)")) : null;
        faults.push(`${target}/${name} : attendu ${dir}/, trouvé ${where ? where.join(", ") : "nulle part"}`);
      }
    }

    if (target === "ConsoleUI") {
      for (const name of UI_OS) if (!files.includes(`OS/${name}`)) faults.push(`ConsoleUI/OS/${name} absent`);
    }

    const byName = new Map<string, string[]>();
    for (const file of files) {
      const name = path.posix.basename(file);
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
    for (const [name, paths] of byName)
      if (paths.length > 1) faults.push(`${target} : ${name} en double (${paths.join(", ")})`);
  }
  assert.deepEqual(faults, []);
});

/** Le corps de la section de l'app Swift dans DEVELOPPEMENT.md, avec ses numéros de ligne ; null si elle manque. */
function appMapBody(): { line: number; text: string }[] | null {
  const lines = fs.readFileSync(path.join(ROOT, "DEVELOPPEMENT.md"), "utf8").split("\n");
  const start = lines.indexOf("### L'app Swift, dossier par dossier");
  if (start < 0) return null;
  const body: { line: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length && !/^#{2,3} /.test(lines[i] ?? ""); i++)
    body.push({ line: i + 1, text: lines[i] ?? "" });
  return body;
}

test("reorganisation-ranger-l-app-swift-en-dos/AC-202 : la carte de l'app Swift et les dossiers qui contiennent du Swift sont les mêmes, chacun avec sa phrase", () => {
  const body = appMapBody();
  assert.ok(body, "carte de l'app Swift absente de DEVELOPPEMENT.md");
  const faults: string[] = [];
  const entries = new Map<string, string>();
  for (const { line, text } of body) {
    if (/mem0/i.test(text)) faults.push(`DEVELOPPEMENT.md:${line} nomme mem0`);
    const match = /^\|\s*`([A-Za-z]+\/[\w-]+)\/`\s*\|\s*(.*?)\s*\|\s*$/.exec(text);
    if (!match) continue;
    const dir = match[1] ?? "";
    if (entries.has(dir)) faults.push(`${dir}/ : deux lignes dans la carte`);
    entries.set(dir, match[2] ?? "");
  }

  const expected = new Set<string>();
  for (const target of TARGETS)
    for (const file of targetFiles(target)) if (file.includes("/")) expected.add(`${target}/${file.split("/")[0]}`);

  for (const dir of [...expected].sort()) if (!entries.has(dir)) faults.push(`${dir}/ sans ligne dans la carte`);
  for (const [dir, phrase] of entries) {
    if (!expected.has(dir)) faults.push(`${dir}/ dans la carte mais sans .swift`);
    if (/^[-–—]?$/.test(phrase)) faults.push(`${dir}/ : phrase vide`);
  }
  assert.deepEqual(faults, []);
});

/** Les fichiers suivis (`git ls-files`) lisibles comme du texte, hors CHANGELOG.md. */
function textFiles(): { file: string; text: string }[] {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `git ls-files : ${listed.stderr}`);
  const out: { file: string; text: string }[] = [];
  for (const file of new Set(listed.stdout.split("\0").filter(Boolean))) {
    if (file === "CHANGELOG.md") continue;
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const buffer = fs.readFileSync(full);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    out.push({ file, text: buffer.toString("utf8") });
  }
  return out;
}

/** Le numéro de ligne (1 = première) du décalage `offset` dans `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Tous les `.swift` sous omp-console/Sources/, en chemins relatifs à la racine du dépôt. */
function allSwiftSources(): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(SOURCES, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
    found.push(`omp-console/Sources/${posix(path.relative(SOURCES, path.join(entry.parentPath, entry.name)))}`);
  }
  return found;
}

/** Un motif de chemin (`*` : hors `/`, `**` : zéro, un ou plusieurs dossiers) en expression régulière. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) =>
      segment === "**" ? "(?:[^/]+/)*" : `${segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}/`,
    )
    .join("")
    .replace(/\/$/, "");
  return new RegExp(`^${source}$`);
}

/** Les fictions plantées dans une copie en mémoire : aucun fichier ne les porte (chemins écrits en morceaux). */
const PLANTED = [
  {
    file: "test/console/typographie-et-glossaire-francais.test.ts",
    cited: ["omp-console/Sources", "ConsoleCore", "Home", "VideText.swift"].join("/"),
    reason: "fichier fictif planté dans une copie en mémoire",
  },
  {
    file: "test/console/typographie-et-glossaire-francais.test.ts",
    cited: ["omp-console/Sources", "ConsoleCore", "Design", "PipelineServerTextStyle.swift"].join("/"),
    reason: "fichier fictif planté dans une copie en mémoire",
  },
];

test("reorganisation-ranger-l-app-swift-en-dos/AC-203 : aucun chemin de source Swift cité ne meurt, et aucun test ne nomme un fichier déplacé sans son dossier", () => {
  const faults: string[] = [];
  const files = textFiles();
  const swift = new Set(allSwiftSources());
  const swiftList = [...swift];

  const check = (file: string, line: number, cited: string) => {
    if (PLANTED.some((item) => item.file === file && item.cited === cited)) return;
    if (!cited.includes("*")) {
      if (!swift.has(cited)) faults.push(`${file}:${line} → ${cited}`);
      return;
    }
    const segments = cited.split("/");
    const firstGlob = segments.findIndex((segment) => segment.includes("*"));
    const prefix = `${segments.slice(0, firstGlob).join("/")}/`;
    const lastName = segments[segments.length - 1] ?? "";
    const nameRe = globToRegExp(lastName);
    const re = globToRegExp(cited);
    const matched = swiftList.filter((candidate) => re.test(candidate));
    if (matched.length === 0) {
      faults.push(`${file}:${line} → ${cited} : aucun fichier`);
      return;
    }
    const missed = swiftList.find(
      (candidate) => candidate.startsWith(prefix) && nameRe.test(path.posix.basename(candidate)) && !re.test(candidate),
    );
    if (missed) faults.push(`${file}:${line} → ${cited} : ne désigne pas ${missed}`);
  };

  const full =
    /(?<![\w.-])((?:omp-console\/)?(?:Sources\/)?)(ConsoleClient|ConsoleUI|ConsoleCore|OMPConsole)\/((?:[\w*.-]+\/)*[\w*-]+\.swift)/g;
  const segmented =
    /"Sources",\s*"(ConsoleClient|ConsoleUI|ConsoleCore|OMPConsole)"((?:,\s*"[\w.-]+")*),\s*"([\w-]+\.swift)"/g;

  for (const { file, text } of files) {
    for (const match of text.matchAll(full)) {
      const prefix = match[1] ?? "";
      const cible = match[2] ?? "";
      if (prefix !== "omp-console/Sources/" && cible !== "ConsoleClient" && cible !== "ConsoleUI") continue;
      check(file, lineAt(text, match.index ?? 0), `omp-console/Sources/${cible}/${match[3]}`);
    }
    for (const match of text.matchAll(segmented)) {
      const middle = [...(match[2] ?? "").matchAll(/"([\w.-]+)"/g)].map((item) => item[1]);
      check(file, lineAt(text, match.index ?? 0), ["omp-console/Sources", match[1], ...middle, match[3]].join("/"));
    }
  }

  // Un test qui lit un fichier déplacé par un nom nu lirait la chaîne vide d'un fichier absent (`readIfExists`,
  // `?? ""`) : le littéral porte donc le dossier que la table donne au fichier.
  const bare = /"((?:[\w.-]+\/)*)([\w-]+\.swift)"/g;
  for (const { file, text } of files) {
    if (!/^test\/.*\.ts$/.test(file) || file === SELF) continue;
    const lines = text.split("\n");
    for (const match of text.matchAll(bare)) {
      const offset = match.index ?? 0;
      const line = lineAt(text, offset);
      const trimmed = (lines[line - 1] ?? "").trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
      const name = match[2] ?? "";
      const home = MOVED.get(name);
      if (!home) continue;
      const inLiteral = (match[1] ?? "").split("/").filter(Boolean).pop();
      const before = /"([\w.-]+)",\s*$/.exec(text.slice(0, offset))?.[1];
      const dir = inLiteral ?? before;
      if (dir !== home.dir) faults.push(`${file}:${line} → ${match[0]} (dossier attendu ${home.dir}/)`);
    }
  }
  assert.deepEqual(faults, []);
});
