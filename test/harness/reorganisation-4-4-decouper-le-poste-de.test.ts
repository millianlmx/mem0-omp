// Feature reorganisation-4-4-decouper-le-poste-de : le poste de travail du serveur, un fichier de plus de 2000 lignes,
// est rangé en cinq modules de omp-harness/workstation/ qui portent chacun une seule responsabilité (entrées, profil,
// navigateurs et espaces, file d'actions et garde d'envoi, meetings et demandes). La table de CORRESPONDANCE.md dit le
// morceau de chaque responsabilité ; le test juge l'état courant (jamais un commit de base) : qui déclare quoi, ce que
// chaque importeur importe, quels membres publics Workstation garde, ce que chaque ligne cite.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeWorld } from "../support/harness-fixtures.ts";
import { ROOT } from "../support/repo.ts";
import { Workstation } from "../../omp-harness/workstation/workstation.ts";

const LABELS = {
  input: "formes et validation des entrées du poste",
  profile: "profil de travail",
  presence: "navigateurs, présence et espaces",
  queue: "file d'actions et garde d'envoi",
  errands: "meetings, demandes et automatisations",
};

/** Le délégué de la classe Workstation pour chaque responsabilité qu'elle ne porte pas elle-même. */
const DESKS: Record<string, string> = {
  [LABELS.profile]: "profileDesk",
  [LABELS.presence]: "browserDesk",
  [LABELS.errands]: "errandDesk",
};

const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

/**
 * La table d'affectation : chaque déclaration de premier niveau et chaque méthode de la classe du poste, à la base,
 * vers la responsabilité qui porte son corps. Un nom en dièse (membre privé) est cherché sous son nom sans dièse.
 */
const ASSIGNED: Record<string, string[]> = {
  input: words(`
    Autonomy EffectiveAutonomy AUTONOMIES WorkstationSettings BrowserHello NO_HELLO BrowserView
    WorkstationStatus ActionInput ResultInput MAX_OBSERVATIONS MAX_SEGMENTS MAX_LABEL MAX_TITLE MAX_PREVIEW
    MAX_SUMMARY MAX_RATIONALE MAX_SEGMENT_TEXT MAX_RESULT_TEXT MAX_RESULT_DATA DAY_MS FINGERPRINT NAMED_KEYS
    MODIFIERS isKeyCombo isUploadName SETTINGS_KEY OBSERVED_KEY BROWSER_ID MAX_BROWSER_LABEL MAX_ALLOWED_HOSTS
    HOST_NAME REQUEST_OUT_OF_SPACE bad clip clean parseBrowserHello browserRef parseSchedule parseRequestStates
    redactDeep stripUrl identity isSelfOnly parseObservation parseObservations tabId webUrl ref optionalText
    PARAMS checkParams parseActionInput parseResult describeGesture parseSegments parseAllowedHosts
    SettingsPatch parseSettings strings nullableString parseProfile parseDigest Presence
  `),
  profile: words(`
    ProfileStats SEQUENCE_GAP_MS SEQUENCE_MIN_COUNT SEQUENCE_MAX_STEPS SEQUENCE_KEEP TOP_SITES isIdSegment
    normalizePath pageKey recurringSequences profileStats recordObservations listObservations stats profileView
    profileOf writeProfile recordShift
  `),
  presence: words(`
    LEGACY_BROWSER ONLINE_MS ACCOUNTS_KEY VPS_JAR_KEY NO_SPACE_BROWSER ACTION_OUT_OF_SPACE effectiveAutonomy
    settings updateSettings observed effective defaultBrowserId #known spaceOfBrowser browserOfSpace browserIn
    outsideSpaces #spaceRef assignBrowser #strayError #closeStrayActions mirrorSource #vpsJar vpsPurgeDue
    vpsPurged identitiesIn #browserOf touch #isOnline online forget onHalt vpsAccounts setVpsAccount
    markMirrored browsers nextShiftAt status
  `),
  queue: words(`
    MAX_WAIT_SEC PURGE_EVERY_MS ORPHAN_MEETING_MS SESSION_JOBS SessionJob posteDir uploadDir MAX_UPLOAD_BYTES
    MIME_TYPES APPROVER_ONLY workstationFor approverFor LEASE_LOST APPROVAL_EXPIRED QUEUE_EXPIRED Waiter #event
    #transition createAction #retain #guards #uploadPath uploadFile #reportAgentTabs getAction listActions
    #lease next waitAction submitResult #awaiting #decide approve refuse cancel #cancel stop capture sessionView
    maintain #park #wakeQueue #changed close
  `),
  errands: words(`
    MAX_INSTRUCTION MAX_REPORT MAX_REQUEST_REASON REQUEST_CANCELLED AUTOMATION_OUT_OF_SPACE MEETING_OUT_OF_SPACE
    automationInstruction reasonKind #meetingEvent getMeeting createMeeting addSegments endMeeting listMeetings
    meetingView finishDigest #requestEvent #closedRequestError #closeRequestActions getRequest #enqueue
    createRequest listRequests requestView cancelRequest startRequest rejectRequest waitRequest finishRequest
    getAutomation listAutomations createAutomation runAutomation deleteAutomation
  `),
};

const TABLE: Record<string, string> = {};
for (const [key, names] of Object.entries(ASSIGNED)) {
  for (const name of names) TABLE[name.replace(/^#/, "")] = LABELS[key as keyof typeof LABELS];
}

/** Ce que la classe Workstation garde au titre de son squelette, dans le morceau de la file d'actions. */
const SKELETON = ["Workstation", "constructor", "enabled"];

/** Les types de rappels et les classes des morceaux : les seuls noms nouveaux hors de la table. */
const NEW_NAMES = ["PresenceDesk", "ProfileDesk", "ErrandDesk", "PresenceHooks", "ErrandHooks"];

/** Les 24 membres témoins, par responsabilité. */
const WITNESSES: Record<string, string[]> = {
  [LABELS.input]: words("parseActionInput parseResult parseObservations parseProfile describeGesture isSelfOnly"),
  [LABELS.profile]: words("profileStats profileView writeProfile"),
  [LABELS.presence]: words("assignBrowser browsers touch status"),
  [LABELS.queue]: words("createAction next submitResult approve refuse"),
  [LABELS.errands]: words("createMeeting endMeeting createRequest finishRequest createAutomation runAutomation"),
};

/** Les 54 noms exportés par le poste à la base : chacun reste exporté, par le seul morceau qui le déclare. */
const FIFTY_FOUR = words(`
    Autonomy EffectiveAutonomy AUTONOMIES WorkstationSettings BrowserHello NO_HELLO LEGACY_BROWSER BrowserView
    ProfileStats WorkstationStatus ActionInput ResultInput ONLINE_MS MAX_WAIT_SEC MAX_OBSERVATIONS MAX_SEGMENTS
    MAX_LABEL ORPHAN_MEETING_MS SESSION_JOBS SessionJob NAMED_KEYS isKeyCombo posteDir uploadDir
    MAX_UPLOAD_BYTES isUploadName MAX_INSTRUCTION REQUEST_CANCELLED NO_SPACE_BROWSER REQUEST_OUT_OF_SPACE
    ACTION_OUT_OF_SPACE AUTOMATION_OUT_OF_SPACE MEETING_OUT_OF_SPACE APPROVER_ONLY workstationFor approverFor
    clip parseBrowserHello automationInstruction parseRequestStates stripUrl normalizePath pageKey
    effectiveAutonomy isSelfOnly parseObservations parseActionInput parseResult describeGesture parseSegments
    parseProfile parseDigest profileStats Workstation
  `);

/** Les 67 méthodes publiques de Workstation et leur length (paramètres avant le premier défaut). */
const METHODS: Record<string, number> = {
  settings: 0,
  updateSettings: 2,
  observed: 1,
  effective: 0,
  defaultBrowserId: 0,
  spaceOfBrowser: 1,
  browserOfSpace: 1,
  browserIn: 2,
  outsideSpaces: 1,
  assignBrowser: 3,
  mirrorSource: 0,
  vpsPurgeDue: 0,
  vpsPurged: 0,
  identitiesIn: 1,
  touch: 0,
  online: 0,
  forget: 1,
  onHalt: 1,
  vpsAccounts: 0,
  setVpsAccount: 2,
  markMirrored: 0,
  browsers: 0,
  nextShiftAt: 4,
  status: 0,
  recordObservations: 1,
  listObservations: 1,
  stats: 0,
  createAction: 3,
  uploadFile: 1,
  getAction: 2,
  listActions: 1,
  next: 2,
  waitAction: 4,
  submitResult: 2,
  approve: 2,
  refuse: 3,
  cancel: 2,
  stop: 1,
  capture: 2,
  sessionView: 2,
  maintain: 0,
  close: 0,
  getMeeting: 1,
  createMeeting: 1,
  addSegments: 2,
  endMeeting: 1,
  listMeetings: 2,
  meetingView: 2,
  finishDigest: 2,
  getRequest: 2,
  createRequest: 2,
  listRequests: 1,
  requestView: 2,
  cancelRequest: 2,
  startRequest: 1,
  rejectRequest: 2,
  waitRequest: 2,
  finishRequest: 2,
  getAutomation: 1,
  listAutomations: 1,
  createAutomation: 2,
  runAutomation: 2,
  deleteAutomation: 1,
  profileView: 0,
  profileOf: 1,
  writeProfile: 1,
  recordShift: 1,
};

/** Les plafonds de types des fichiers du serveur à la base : une baisse est permise, une hausse non. */
const BASE_CAPS: Record<string, number> = {
  "omp-harness/heavy/heavy.ts": 2,
  "omp-harness/heavy/tap.ts": 3,
  "omp-harness/memory/oracle.ts": 1,
  "omp-harness/runs/verdict.ts": 4,
};

const SERVER = path.join(ROOT, "omp-harness");

const KINDS = "(?:function\\*?|const|let|var|class|abstract\\s+class|type|interface|enum)";
const TOP_LEVEL = new RegExp("^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?" + KINDS + "\\s+([A-Za-z_$][\\w$]*)");
const MEMBER = /^ {2}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\(/;
const NOT_MEMBERS = new Set(["if", "for", "switch", "while", "return", "catch"]);
const REEXPORT = /^export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*"([^"]+)"/gm;
const NAMED_REEXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/gm;
const NAMED_IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/gm;
const OTHER_IMPORT = /^import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s+from\s*"([^"]+)"/gm;
const RELATIVE_FROM = /\bfrom\s*"(\.[^"]+)"/g;
const LOCAL_EXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm;
const EXPORTED_NAME =
  /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Le nom de la marque que le dépôt cesse de nommer, écrit sans la nommer. */
const FORMER_BRAND = new RegExp("mem" + "0", "i");

/** Les .ts de dir (récursif), en chemins relatifs à ROOT. */
function tsUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

/** Les .ts du serveur, hors deploy/, en chemins relatifs à omp-harness/. */
function serverTs(): string[] {
  const inServer = tsUnder("omp-harness").map((file) => file.slice("omp-harness/".length));
  return inServer.filter((file) => !file.startsWith("deploy/"));
}

type Chunk = { path: string; role: string; line: string };

/** Les lignes de CORRESPONDANCE.md dont l'ancien chemin est le fichier du poste : un morceau et sa responsabilité. */
function chunks(): Chunk[] {
  const found: Chunk[] = [];
  const file = path.join(SERVER, "CORRESPONDANCE.md");
  assert.ok(fs.existsSync(file), "omp-harness/CORRESPONDANCE.md absent");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (match?.[1] === "workstation.ts") found.push({ path: match[2] ?? "", role: match[3] ?? "", line });
  }
  return found;
}

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Le numéro de ligne (à partir de 1) d'un décalage dans un texte. */
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Les noms d'une liste { a, type b, c as d } : sans type, avec leur alias éventuel. */
const namesOf = (list: string): string[] =>
  list
    .split(",")
    .map((spec) => spec.trim().replace(/^type\s+/, ""))
    .filter((name) => name !== "");

/** Le morceau (chemin relatif à omp-harness/) qui porte une responsabilité. */
const pieceOf = (label: string): string => chunks().find((row) => row.role === label)?.path ?? "";

test("reorganisation-4-4-decouper-le-poste-de/AC-1 : la table donne cinq morceaux sous workstation/, un par responsabilité, qui existent, tiennent en 2000 lignes et portent un nom que personne d'autre ne porte", () => {
  const rows = chunks();
  const problems: string[] = [];
  if (rows.length !== 5) problems.push(`CORRESPONDANCE.md : ${rows.length} lignes du poste, 5 attendues`);
  const labels = Object.values(LABELS);
  for (const row of rows) {
    if (!labels.includes(row.role)) problems.push(`${row.line} : responsabilité « ${row.role} » inconnue`);
    if (FORMER_BRAND.test(row.line)) problems.push(`${row.line} : nomme la marque que le dépôt cesse de nommer`);
  }
  for (const label of labels) {
    const owners = rows.filter((row) => row.role === label);
    if (owners.length !== 1) problems.push(`« ${label} » : ${owners.length} lignes, une attendue`);
  }
  for (const row of rows) {
    if (!/^workstation\/[\w-]+\.ts$/.test(row.path)) problems.push(`${row.path} : n'est pas un workstation/<nom>.ts`);
    const file = path.join(SERVER, row.path);
    if (!fs.existsSync(file)) {
      problems.push(`${row.path} absent`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf8").split("\n").length;
    if (lines > 2000) problems.push(`${row.path} : ${lines} lignes`);
  }
  const kept = rows.filter((row) => path.posix.basename(row.path) === "workstation.ts");
  if (kept.length !== 1 || kept[0]?.path !== "workstation/workstation.ts") {
    problems.push(`le morceau nommé workstation.ts : ${kept.map((row) => row.path).join(", ") || "aucun"}`);
  }
  const everyTs = serverTs();
  for (const row of rows) {
    const name = path.posix.basename(row.path);
    if (name === "workstation.ts") continue;
    const same = everyTs.filter((other) => path.posix.basename(other) === name && other !== row.path);
    if (same.length > 0) problems.push(`${name} : nom déjà porté par ${same.join(", ")}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

type Declared = { name: string; cls: string | null; line: number; body: string[] | null };

/** Où finit la signature d'un membre : la ligne qui ouvre le corps, hors accolade d'un type (paramètre ou retour). */
function signatureEnd(lines: string[], start: number): number {
  let parens = 0;
  let braces = 0;
  for (let index = start; index < lines.length; index++) {
    const text = (lines[index] ?? "")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/\/\/.*$/, "")
      .trimEnd();
    const opens = text.endsWith("{");
    const before = opens ? text.slice(0, -1) : text;
    for (const char of before) {
      if (char === "(") parens++;
      else if (char === ")") parens--;
      else if (char === "{") braces++;
      else if (char === "}") braces--;
    }
    if (opens && parens === 0 && braces === 0 && !before.trimEnd().endsWith(":")) return index;
    if (opens) braces++;
  }
  return start;
}

/** Les déclarations d'un morceau : celles de premier niveau, et les méthodes des corps de classe avec leur corps. */
function declarationsOf(file: string): Declared[] {
  const lines = read(`omp-harness/${file}`).split("\n");
  const found: Declared[] = [];
  let cls: string | null = null;
  for (const [index, text] of lines.entries()) {
    const top = TOP_LEVEL.exec(text);
    if (top) {
      found.push({ name: top[1] ?? "", cls: null, line: index + 1, body: null });
      cls = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(text)?.[1] ?? null;
      continue;
    }
    if (cls === null) continue;
    if (text.startsWith("}")) {
      cls = null;
      continue;
    }
    const member = MEMBER.exec(text);
    if (!member || NOT_MEMBERS.has(member[1] ?? "")) continue;
    const signature = signatureEnd(lines, index);
    let end = signature + 1;
    while (end < lines.length && lines[end] !== "  }") end++;
    found.push({ name: member[1] ?? "", cls, line: index + 1, body: lines.slice(signature + 1, end) });
  }
  return found;
}

/** Les noms des paramètres d'un membre, dans l'ordre de sa signature, signature sur plusieurs lignes comprise. */
function parameterNames(file: string, line: number): string[] {
  const lines = read(`omp-harness/${file}`).split("\n");
  const text = lines.slice(line - 1, signatureEnd(lines, line - 1) + 1).join("\n");
  const open = text.indexOf("(");
  let depth = 0;
  let inner = "";
  for (let index = open; index < text.length; index++) {
    const char = text[index] ?? "";
    if (char === "(" && depth++ === 0) continue;
    if (char === ")" && --depth === 0) break;
    inner += char;
  }
  const parts: string[] = [];
  let current = "";
  let nesting = 0;
  for (const char of inner.replace(/=>/g, "")) {
    if ("([{<".includes(char)) nesting++;
    if (")]}>".includes(char)) nesting--;
    if (char === "," && nesting === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.flatMap((part) => /[\w$]+/.exec(part)?.slice(0, 1) ?? []);
}

test("reorganisation-4-4-decouper-le-poste-de/AC-2 : chaque nom de la table a son corps dans le morceau de sa responsabilité et nulle part ailleurs ; une délégation d'une ligne n'est pas un corps", () => {
  const problems: string[] = [];
  for (const [label, names] of Object.entries(WITNESSES)) {
    for (const name of names) {
      if (TABLE[name] !== label) problems.push(`${name} : témoin absent de la table, ou affecté à « ${TABLE[name]} »`);
    }
  }
  assert.deepEqual(
    Object.values(WITNESSES).map((names) => names.length),
    [6, 3, 4, 5, 6],
    "6, 3, 4, 5 et 6 témoins par responsabilité",
  );
  const rows = chunks();
  const bodies = new Map<string, string[]>();
  for (const row of rows) {
    const desks = Object.values(DESKS);
    for (const declared of declarationsOf(row.path)) {
      const name = declared.name.replace(/^#/, "");
      let delegation = false;
      if (declared.body !== null && declared.cls === "Workstation") {
        const owner = TABLE[name];
        const desk = owner === undefined ? undefined : DESKS[owner];
        if (desk !== undefined && desks.includes(desk)) {
          const args = parameterNames(row.path, declared.line).join(",");
          const flat = declared.body.join("").replace(/\s+/g, "");
          const expected = new RegExp(`^(?:return)?this\\.#${desk}\\.${name}\\(${args.replace(/\$/g, "\\$")},?\\);$`);
          delegation = expected.test(flat);
        }
      }
      if (delegation) continue;
      const owned = Object.hasOwn(TABLE, name);
      const skeleton = row.path === "workstation/workstation.ts" && SKELETON.includes(declared.name);
      const fresh =
        NEW_NAMES.includes(declared.name) || (declared.name === "constructor" && declared.cls !== "Workstation");
      if (!owned && !skeleton && !fresh) problems.push(`${row.path} : ${declared.name} hors de la table`);
      if (owned) bodies.set(name, [...(bodies.get(name) ?? []), row.path]);
    }
  }
  for (const [name, label] of Object.entries(TABLE)) {
    const homes = [...new Set(bodies.get(name) ?? [])];
    if (homes.length === 0) problems.push(`${name} : aucun corps`);
    else if (homes.length !== 1 || homes[0] !== pieceOf(label)) {
      problems.push(`${name} : corps dans ${homes.join(", ")}, attendu dans ${pieceOf(label)}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-4-4-decouper-le-poste-de/AC-3 : aucune réexportation ne vise un morceau, chaque nom importé d'un morceau y est déclaré, et les 54 exports ont chacun un seul exportateur", () => {
  const pieces = new Set(chunks().map((chunk) => `omp-harness/${chunk.path}`));
  const normalized = (from: string, specifier: string): string =>
    path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const resolves = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const target = normalized(from, specifier);
    return pieces.has(target) ? target : null;
  };
  const declares = (piece: string, name: string, exported: boolean): boolean => {
    const prefix = exported ? "export\\s+" : "(?:export\\s+)?";
    const declaration = new RegExp(`^${prefix}(?:declare\\s+)?(?:async\\s+)?${KINDS}\\s+${name}\\b`, "m");
    return declaration.test(read(piece));
  };
  const files = [
    ...tsUnder("omp-harness").filter((file) => !file.startsWith("omp-harness/deploy/")),
    ...tsUnder("test"),
    ...tsUnder("scripts"),
  ];
  const problems: string[] = [];
  for (const file of files) {
    const text = read(file);
    const importerIsPiece = pieces.has(file);
    for (const match of text.matchAll(REEXPORT)) {
      if (resolves(file, match[1] ?? "")) problems.push(`${file}:${lineOf(text, match.index)} réexporte un morceau`);
    }
    const imported = new Set<string>();
    for (const match of text.matchAll(NAMED_IMPORT)) {
      const piece = resolves(file, match[2] ?? "");
      if (!piece) continue;
      for (const name of namesOf(match[1] ?? "")) {
        const where = `${file}:${lineOf(text, match.index)} → ${name}`;
        imported.add(name);
        if (/\sas\s/.test(name)) problems.push(`${where} : alias`);
        else if (!declares(piece, name, true)) problems.push(`${where} : non exporté par ${piece}`);
        else if (!FIFTY_FOUR.includes(name) && !NEW_NAMES.includes(name) && !importerIsPiece) {
          problems.push(`${where} : un nom interne n'est importé que par un morceau`);
        }
      }
    }
    for (const match of text.matchAll(OTHER_IMPORT)) {
      if (resolves(file, match[1] ?? "")) {
        problems.push(`${file}:${lineOf(text, match.index)} importe un morceau par espace de noms ou par défaut`);
      }
    }
    for (const match of text.matchAll(LOCAL_EXPORT)) {
      for (const spec of namesOf(match[1] ?? "")) {
        const name = spec.split(/\s+as\s+/)[0] ?? "";
        const where = `${file}:${lineOf(text, match.index)} → ${name}`;
        if (imported.has(name)) problems.push(`${where} : façade d'une liaison importée d'un morceau`);
        else if (importerIsPiece && !declares(file, name, false)) problems.push(`${where} : façade`);
      }
    }
    for (const match of text.matchAll(RELATIVE_FROM)) {
      const specifier = match[1] ?? "";
      if (pieces.has(`${normalized(file, specifier)}.ts`)) {
        problems.push(`${file}:${lineOf(text, match.index)} → ${specifier} : import sans .ts`);
      }
    }
  }
  const exportedBy = new Map<string, string[]>();
  const note = (name: string, file: string): void => {
    exportedBy.set(name, [...(exportedBy.get(name) ?? []), file]);
  };
  for (const file of serverTs()) {
    const text = read(`omp-harness/${file}`);
    for (const match of text.matchAll(EXPORTED_NAME)) note(match[1] ?? "", file);
    for (const match of text.matchAll(LOCAL_EXPORT)) {
      for (const name of namesOf(match[1] ?? "")) note(name.split(/\s+as\s+/)[0] ?? "", file);
    }
    for (const match of text.matchAll(NAMED_REEXPORT)) {
      for (const name of namesOf(match[1] ?? "")) note(name.split(/\s+as\s+/)[0] ?? "", file);
    }
  }
  assert.equal(FIFTY_FOUR.length, 54, "la liste compte 54 noms");
  for (const name of FIFTY_FOUR) {
    const owners = exportedBy.get(name) ?? [];
    const first = owners[0] ?? "";
    if (owners.length !== 1) {
      problems.push(`${name} : exporté par ${owners.join(", ") || "aucun fichier"}`);
    } else if (!pieces.has(`omp-harness/${first}`) || !declares(`omp-harness/${first}`, name, false)) {
      problems.push(`${name} : exporté par ${first}, qui n'est pas un morceau qui le déclare`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-4-4-decouper-le-poste-de/AC-4 : une ligne qui cite workstation.ts ou un morceau ne cite entre backticks que des identifiants exportés déclarés dans un fichier qu'elle cite", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr.toString());
  const exported = new Set<string>();
  const server = serverTs();
  for (const file of server) {
    const text = read(`omp-harness/${file}`);
    for (const match of text.matchAll(EXPORTED_NAME)) exported.add(match[1] ?? "");
    for (const match of text.matchAll(LOCAL_EXPORT)) {
      for (const name of namesOf(match[1] ?? "")) exported.add(name.split(/\s+as\s+/)[0] ?? "");
    }
    for (const match of text.matchAll(NAMED_REEXPORT)) {
      for (const name of namesOf(match[1] ?? "")) exported.add(name.split(/\s+as\s+/)[0] ?? "");
    }
  }
  const watched = new Set(["workstation.ts", ...chunks().map((row) => path.posix.basename(row.path))]);
  const citedFiles = (name: string): string[] => {
    if (!name.includes("/")) return server.filter((file) => path.posix.basename(file) === name);
    const rest = name.replace(/^(?:\.\.\/)+/, "").replace(/^omp-harness\//, "");
    const exact = server.filter((file) => file === rest);
    return exact.length > 0 ? exact : server.filter((file) => file.endsWith(`/${rest}`));
  };
  const declaredIn = (file: string, id: string): boolean => {
    const escaped = id.replace(/\$/g, "\\$");
    const top = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?${KINDS}\\s+${escaped}\\b`, "m");
    const member = new RegExp(
      `^ {2}(?:(?:static|readonly|async|get|set|public|private|protected)\\s+)*#?${escaped}\\s*(?:<[^>\\n]*>)?[(:=?;]`,
      "m",
    );
    const text = read(`omp-harness/${file}`);
    return top.test(text) || member.test(text);
  };
  const problems: string[] = [];
  for (const file of listed.stdout.toString("utf8").split("\0")) {
    if (file === "" || file === "CHANGELOG.md" || file === "omp-harness/CORRESPONDANCE.md") continue;
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    for (const [index, line] of buffer.toString("utf8").split("\n").entries()) {
      if (file.startsWith("test/") && /^\s*test\(/.test(line)) continue;
      const cited = [...line.matchAll(/(?<![\w-])((?:[\w-]+\/)*[\w-]+\.ts)\b/g)].map((match) => match[1] ?? "");
      if (!cited.some((name) => watched.has(path.posix.basename(name)))) continue;
      const files = cited.flatMap((name) => citedFiles(name));
      for (const match of line.matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
        const id = match[1] ?? "";
        if (exported.has(id) && !files.some((candidate) => declaredIn(candidate, id))) {
          problems.push(`${file}:${index + 1} → ${id}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-4-4-decouper-le-poste-de/AC-6 : la classe Workstation garde ses 71 membres publics sous leur sorte, leur length et leur caractère async", async () => {
  const world = fakeWorld({});
  const workstation = world.orchestrator.workstation;
  const problems: string[] = [];
  try {
    for (const name of ["profileRequested", "spaceProfilesRequested"]) {
      const own = Object.getOwnPropertyDescriptor(workstation, name);
      if (own === undefined) problems.push(`${name} : absent`);
      else if (!("value" in own)) problems.push(`${name} : attendu un champ`);
    }
    const enabled = Object.getOwnPropertyDescriptor(Workstation.prototype, "enabled");
    if (Object.hasOwn(workstation, "enabled")) problems.push("enabled : attendu un accesseur du prototype");
    else if (typeof enabled?.get !== "function") problems.push("enabled : attendu un accesseur");
    assert.deepEqual([...Workstation.PENDING], ["queued", "running", "awaiting_approval"], "Workstation.PENDING");
    assert.equal(Object.keys(METHODS).length, 67, "la liste compte 67 méthodes");
    for (const [name, length] of Object.entries(METHODS)) {
      const descriptor = Object.getOwnPropertyDescriptor(Workstation.prototype, name);
      if (Object.hasOwn(workstation, name)) {
        problems.push(`${name} : attendu une méthode du prototype`);
      } else if (typeof descriptor?.value !== "function") {
        problems.push(`${name} : absent, ou pas une méthode`);
      } else {
        const method = descriptor.value as (...args: unknown[]) => unknown;
        if (method.length !== length) problems.push(`${name} : length ${method.length}, attendu ${length}`);
        const isAsync = method.constructor.name === "AsyncFunction";
        if (isAsync !== (name === "next" || name === "waitAction")) {
          problems.push(`${name} : ${isAsync ? "async" : "synchrone"}, ce n'est pas ce qu'il était`);
        }
      }
    }
  } finally {
    await world.orchestrator.stop();
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-4-4-decouper-le-poste-de/AC-7 : aucun morceau n'a de plafond de types, et aucun plafond du serveur n'est relevé ni ajouté", () => {
  const baseline = JSON.parse(read("scripts/types-ratchet-baseline.json")) as { files: Record<string, number> };
  const pieces = new Set(chunks().map((chunk) => `omp-harness/${chunk.path}`));
  const problems: string[] = [];
  for (const [key, cap] of Object.entries(baseline.files)) {
    if (pieces.has(key)) problems.push(`${key} : un morceau n'a pas de plafond (${cap})`);
    if (!key.startsWith("omp-harness/")) continue;
    const allowed = BASE_CAPS[key];
    if (allowed === undefined) {
      problems.push(`${key} : plafond ${cap} ajouté`);
    } else if (cap > allowed) {
      problems.push(`${key} : plafond ${cap} relevé (base ${allowed})`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-4-4-decouper-le-poste-de/AC-8 : seules les routes d'approbation et de refus du poste appellent approve et refuse, et aucun morceau ni l'agent ne les appelle", () => {
  const call = /([\w#$.]+(?:\([^()]*\))?)\.(approve|refuse)\(/g;
  const routeOf = (text: string, index: number): string => {
    const before = [...text.slice(0, index).matchAll(/route\("(\w+)",\s*"([^"]+)"/g)].pop();
    return before ? `${before[1]} ${before[2]}` : "";
  };
  const found: string[] = [];
  const problems: string[] = [];
  for (const file of serverTs()) {
    const text = read(`omp-harness/${file}`);
    for (const match of text.matchAll(call)) {
      const where = `omp-harness/${file}:${lineOf(text, match.index)}`;
      const receiver = `${match[1]}.${match[2]}`;
      found.push(receiver);
      const route = routeOf(text, match.index);
      if (receiver === "approverOf(call).approve" && route !== "POST /v1/workstation/actions/{n}/approve") {
        problems.push(`${where} : approve hors de sa route (${route})`);
      } else if (receiver === "workstation.refuse") {
        const handler = text.slice(text.lastIndexOf("route(", match.index), match.index);
        if (route !== "POST /v1/workstation/actions/{n}/refuse") problems.push(`${where} : refuse hors de sa route`);
        if (!handler.includes("const workstation = approverOf(call);")) {
          problems.push(`${where} : refuse sans approverOf`);
        }
      } else if (receiver === "desk.approve" && !route.includes(" /v1/atlassian/")) {
        problems.push(`${where} : approve d'une écriture Atlassian hors de /v1/atlassian/ (${route})`);
      }
    }
  }
  assert.deepEqual(
    [...new Set(found)].sort(),
    ["approverOf(call).approve", "desk.approve", "workstation.refuse"],
    "les seuls appelants d'approve et de refus",
  );
  for (const file of [...chunks().map((row) => row.path), "workstation/workstation-agent.ts"]) {
    if (/\.(?:approve|refuse)\(/.test(read(`omp-harness/${file}`))) {
      problems.push(`omp-harness/${file} : appelle approve ou refuse`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});
