// Feature reorganisation-3-4-decouper-l-orchestrat : l'orchestrateur du harness, un fichier de plus de 2000 lignes, est
// rangé en cinq modules de omp-harness/runs/ qui portent chacun une seule responsabilité (conduite du service,
// admission, création, pause, vues de lecture). La table de CORRESPONDANCE.md dit le morceau de chaque
// responsabilité ; le test juge l'état courant (jamais un commit de base) : qui déclare quoi, ce que chaque
// importeur importe, quels membres publics Orchestrator garde, ce que chaque ligne cite.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeWorld } from "../../support/harness-fixtures.ts";
import { ROOT } from "../../support/repo.ts";

const LABELS = {
  service: "assemblage, cycle de vie du service et conduite des runs",
  queue: "admission équitable et file d'attente",
  creation: "création des runs et des projets",
  pause: "pause globale et par espace",
  views: "vues de lecture rendues à l'API",
};

/** Les 19 membres témoins : leur corps est déclaré dans le morceau de leur responsabilité. */
const WITNESSES: { name: string; label: string }[] = [
  ...["start", "stop", "recover", "reloadRepos", "tick"].map((name) => ({ name, label: LABELS.service })),
  ...["queueWaits", "withWait", "humanWait"].map((name) => ({ name, label: LABELS.queue })),
  ...["createRun", "createProject", "slugify"].map((name) => ({ name, label: LABELS.creation })),
  ...["pause", "setPause", "pauseView"].map((name) => ({ name, label: LABELS.pause })),
  ...["runView", "inboxView", "briefView", "sessionView", "status"].map((name) => ({ name, label: LABELS.views })),
];

/** Les 12 exports de l'orchestrateur à la base : chacun reste exporté, par le seul morceau qui le déclare. */
const TWELVE = [
  "OrchestratorDeps",
  "Orchestrator",
  "NewRunInput",
  "NewProjectInput",
  "slugify",
  "QueueBlocker",
  "QueueFacts",
  "QueueWait",
  "RunWithWait",
  "PauseState",
  "SpacePause",
  "PauseView",
];

/** Les noms que runs/orchestrator.ts réexporte, et d'où : les seuls `export … from` permis vers un morceau. */
const REEXPORTS: Record<string, string> = {
  HarnessError: "../api/errors.ts",
  Actor: "./context.ts",
  SpawnRunner: "./context.ts",
};

const FIELDS = [
  "audits",
  "pilot",
  "dreams",
  "workstation",
  "workstationAgent",
  "signals",
  "metrics",
  "issues",
  "browsers",
  "vps",
  "digest",
  "schedules",
  "intake",
  "vigie",
  "atlassian",
  "spaces",
  "localSessions",
  "proposals",
  "standing",
];

const ACCESSORS = [
  "store",
  "config",
  "providers",
  "logins",
  "alerts",
  "sessions",
  "observability",
  "lastTickAt",
  "pause",
  "monitor",
];

/** Les 46 méthodes publiques et leur `length` (paramètres avant le premier défaut). */
const METHODS: Record<string, number> = {
  start: 0,
  reloadRepos: 1,
  stop: 0,
  recover: 0,
  tick: 0,
  withWait: 1,
  humanWait: 1,
  queueWaits: 0,
  createRun: 1,
  createProject: 1,
  answerEscalations: 2,
  retry: 1,
  instruct: 2,
  setBudget: 2,
  acceptAllDecisions: 1,
  revert: 1,
  acceptDecision: 2,
  reverseDecision: 4,
  validate: 3,
  setAutonomy: 2,
  applyAutonomyRule: 2,
  cancel: 1,
  amend: 2,
  setModules: 2,
  setPriority: 2,
  pauseView: 0,
  setPause: 2,
  visibleRun: 1,
  runView: 1,
  withBriefing: 1,
  inboxView: 0,
  briefView: 2,
  briefSeen: 1,
  sessionView: 1,
  graphView: 1,
  auditSessionView: 1,
  sessionEntryView: 2,
  auditSessionEntryView: 2,
  timeline: 1,
  changes: 1,
  fileDiff: 2,
  liveTests: 1,
  proofsView: 1,
  proofContent: 2,
  status: 0,
  oracleStatus: 0,
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
const REEXPORT = /^export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*"([^"]+)"/gm;
const NAMED_REEXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/gm;
const NAMED_IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/gm;
const OTHER_IMPORT = /^import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s+from\s*"([^"]+)"/gm;
const RELATIVE_FROM = /\bfrom\s*"(\.[^"]+)"/g;
const LOCAL_EXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm;
const EXPORTED_NAME =
  /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

/** Les `.ts` de `dir` (récursif), en chemins relatifs à ROOT. */
function tsUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

/** Les `.ts` du serveur, hors deploy/, en chemins relatifs à omp-harness/. */
function serverTs(): string[] {
  const inServer = tsUnder("omp-harness").map((file) => file.slice("omp-harness/".length));
  return inServer.filter((file) => !file.startsWith("deploy/"));
}

type Chunk = { path: string; role: string; line: string };

/** Les lignes de CORRESPONDANCE.md dont l'ancien chemin est `orchestrator.ts` : un morceau et sa responsabilité. */
function chunks(): Chunk[] {
  const found: Chunk[] = [];
  const file = path.join(SERVER, "CORRESPONDANCE.md");
  assert.ok(fs.existsSync(file), "omp-harness/CORRESPONDANCE.md absent");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (match?.[1] === "orchestrator.ts") found.push({ path: match[2] ?? "", role: match[3] ?? "", line });
  }
  return found;
}

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Le numéro de ligne (à partir de 1) d'un décalage dans un texte. */
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Les noms d'une liste `{ a, type b, c as d }` : sans `type`, avec leur alias éventuel. */
const namesOf = (list: string): string[] =>
  list
    .split(",")
    .map((spec) => spec.trim().replace(/^type\s+/, ""))
    .filter((name) => name !== "");

test("reorganisation-3-4-decouper-l-orchestrat/AC-1 : la table donne cinq morceaux sous runs/, un par responsabilité, qui existent, tiennent en 2000 lignes et portent un nom que personne d'autre ne porte", () => {
  const rows = chunks();
  const problems: string[] = [];
  if (rows.length !== 5) problems.push(`CORRESPONDANCE.md : ${rows.length} lignes orchestrator.ts, 5 attendues`);
  const labels = Object.values(LABELS);
  for (const row of rows) {
    if (!labels.includes(row.role)) problems.push(`${row.line} : responsabilité « ${row.role} » inconnue`);
  }
  for (const label of labels) {
    const owners = rows.filter((row) => row.role === label);
    if (owners.length !== 1) problems.push(`« ${label} » : ${owners.length} lignes, une attendue`);
  }
  for (const row of rows) {
    if (!/^runs\/[\w-]+\.ts$/.test(row.path)) problems.push(`${row.path} : n'est pas un runs/<nom>.ts`);
    const file = path.join(SERVER, row.path);
    if (!fs.existsSync(file)) {
      problems.push(`${row.path} absent`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf8").split("\n").length;
    if (lines > 2000) problems.push(`${row.path} : ${lines} lignes`);
  }
  const kept = rows.filter((row) => path.posix.basename(row.path) === "orchestrator.ts");
  if (kept.length !== 1 || kept[0]?.path !== "runs/orchestrator.ts") {
    problems.push(`le morceau nommé orchestrator.ts : ${kept.map((row) => row.path).join(", ") || "aucun"}`);
  }
  const everyTs = serverTs();
  for (const row of rows) {
    const name = path.posix.basename(row.path);
    if (name === "orchestrator.ts") continue;
    const same = everyTs.filter((other) => path.posix.basename(other) === name && other !== row.path);
    if (same.length > 0) problems.push(`${name} : nom déjà porté par ${same.join(", ")}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

/** Les déclarations d'un membre (`  nom(`, `  get nom(`) ou d'une fonction de module, avec leur corps. */
function declarations(file: string, name: string): { file: string; line: number; body: string[] }[] {
  const lines = read(`omp-harness/${file}`).split("\n");
  const member = new RegExp(`^  (?:async\\s+)?(?:get\\s+)?${name}(?:<[^>\\n]*>)?\\(`);
  const fn = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\(`);
  const found: { file: string; line: number; body: string[] }[] = [];
  for (const [index, text] of lines.entries()) {
    const isMember = member.test(text);
    if (!isMember && !fn.test(text)) continue;
    let signature = index;
    while (signature < lines.length) {
      const candidate = lines[signature] ?? "";
      if (candidate.includes(")") && candidate.endsWith("{")) break;
      signature++;
    }
    const closer = isMember ? "  }" : "}";
    let end = signature + 1;
    while (end < lines.length && lines[end] !== closer) end++;
    found.push({ file, line: index + 1, body: lines.slice(signature + 1, end) });
  }
  return found;
}

test("reorganisation-3-4-decouper-l-orchestrat/AC-2 : chacun des 19 membres témoins a son corps dans le morceau de sa responsabilité, ailleurs ce n'est qu'une délégation d'une instruction", () => {
  const problems: string[] = [];
  const counts = WITNESSES.reduce<Record<string, number>>((acc, { label }) => {
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(WITNESSES.length, 19, "la liste des témoins compte 19 noms");
  assert.deepEqual(
    Object.values(LABELS).map((label) => counts[label]),
    [5, 3, 3, 3, 5],
    "5, 3, 3, 3 et 5 témoins par responsabilité",
  );
  const rows = chunks();
  const pieceOf = (label: string): string => rows.find((row) => row.role === label)?.path ?? "";
  for (const { name, label } of WITNESSES) {
    const delegation = new RegExp(`^\\s*(?:return\\s+)?this\\.#?[\\w$]+\\.${name}\\b[^;]*;$`);
    const bodies: string[] = [];
    for (const row of rows) {
      for (const found of declarations(row.path, name)) {
        const statements = found.body.filter((text) => text.trim() !== "");
        if (statements.length !== 1 || !delegation.test(statements[0] ?? "")) bodies.push(row.path);
      }
    }
    if (bodies.length === 0) {
      problems.push(`${name} : aucun corps`);
    } else if (bodies.length > 1) {
      problems.push(`${name} : deux corps (${bodies.join(", ")})`);
    } else if (bodies[0] !== pieceOf(label)) {
      problems.push(`${name} : corps dans ${bodies[0]}, attendu dans ${pieceOf(label)}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-3-4-decouper-l-orchestrat/AC-3 : aucune réexportation ne vise un morceau, chaque nom importé d'un morceau y est déclaré, sans alias ni façade", () => {
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
    for (const match of text.matchAll(NAMED_IMPORT)) {
      const piece = resolves(file, match[2] ?? "");
      if (!piece) continue;
      for (const name of namesOf(match[1] ?? "")) {
        const where = `${file}:${lineOf(text, match.index)} → ${name}`;
        if (/\sas\s/.test(name)) {
          problems.push(`${where} : alias`);
        } else if (TWELVE.includes(name)) {
          if (!declares(piece, name, true)) problems.push(`${where} : non déclaré dans ${piece}`);
        } else if (Object.hasOwn(REEXPORTS, name)) {
          if (piece !== "omp-harness/runs/orchestrator.ts") problems.push(`${where} : ne vient pas de l'orchestrateur`);
        } else if (!declares(piece, name, true)) {
          problems.push(`${where} : non déclaré dans ${piece}`);
        } else if (!importerIsPiece) {
          problems.push(`${where} : un nom interne n'est importé que par un morceau`);
        }
      }
    }
    for (const match of text.matchAll(OTHER_IMPORT)) {
      if (resolves(file, match[1] ?? "")) {
        problems.push(`${file}:${lineOf(text, match.index)} importe un morceau par espace de noms ou par défaut`);
      }
    }
    if (importerIsPiece) {
      for (const match of text.matchAll(LOCAL_EXPORT)) {
        for (const spec of namesOf(match[1] ?? "")) {
          const name = spec.split(/\s+as\s+/)[0] ?? "";
          if (!declares(file, name, false)) problems.push(`${file}:${lineOf(text, match.index)} → ${name} : façade`);
        }
      }
    }
    for (const match of text.matchAll(RELATIVE_FROM)) {
      const specifier = match[1] ?? "";
      if (pieces.has(`${normalized(file, specifier)}.ts`)) {
        problems.push(`${file}:${lineOf(text, match.index)} → ${specifier} : import sans .ts`);
      }
    }
  }
  const kept = [...read("omp-harness/runs/orchestrator.ts").matchAll(NAMED_REEXPORT)].map((match) => ({
    spec: match[2] ?? "",
    names: namesOf(match[1] ?? "").sort(),
  }));
  assert.deepEqual(
    kept.sort((a, b) => (a.spec < b.spec ? -1 : 1)),
    [
      { spec: "../api/errors.ts", names: ["HarnessError"] },
      { spec: "./context.ts", names: ["Actor", "SpawnRunner"] },
    ],
    "l'orchestrateur ne garde que ses deux réexportations",
  );
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-3-4-decouper-l-orchestrat/AC-4 : les 12 exports ont un seul exportateur, un morceau qui les déclare, et l'Orchestrator garde ses 75 membres publics sous leur sorte", async () => {
  const pieces = new Set(chunks().map((chunk) => chunk.path));
  const exportedBy = new Map<string, string[]>();
  const declaredBy = new Map<string, string[]>();
  const note = (map: Map<string, string[]>, name: string, file: string): void => {
    map.set(name, [...(map.get(name) ?? []), file]);
  };
  for (const file of serverTs()) {
    const text = read(`omp-harness/${file}`);
    for (const match of text.matchAll(EXPORTED_NAME)) {
      note(exportedBy, match[1] ?? "", file);
      note(declaredBy, match[1] ?? "", file);
    }
    for (const match of text.matchAll(LOCAL_EXPORT)) {
      for (const name of namesOf(match[1] ?? "")) note(exportedBy, name.split(/\s+as\s+/)[0] ?? "", file);
    }
    for (const match of text.matchAll(NAMED_REEXPORT)) {
      for (const name of namesOf(match[1] ?? "")) note(exportedBy, name.split(/\s+as\s+/)[0] ?? "", file);
    }
  }
  const problems: string[] = [];
  for (const name of TWELVE) {
    const owners = exportedBy.get(name) ?? [];
    const first = owners[0] ?? "";
    if (owners.length !== 1) {
      problems.push(`${name} : exporté par ${owners.join(", ") || "aucun fichier"}`);
    } else if (!pieces.has(first) || !(declaredBy.get(name) ?? []).includes(first)) {
      problems.push(`${name} : exporté par ${first}, qui n'est pas un morceau qui le déclare`);
    }
  }

  const world = fakeWorld({});
  const orchestrator = world.orchestrator;
  try {
    const find = (name: string): PropertyDescriptor | undefined => {
      let proto: object | null = Object.getPrototypeOf(orchestrator);
      while (proto !== null && proto !== Object.prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor) return descriptor;
        proto = Object.getPrototypeOf(proto);
      }
      return undefined;
    };
    assert.equal(FIELDS.length + ACCESSORS.length + Object.keys(METHODS).length, 75, "la liste compte 75 membres");
    for (const name of FIELDS) {
      const own = Object.getOwnPropertyDescriptor(orchestrator, name);
      if (own === undefined) problems.push(`${name} : absent`);
      else if (!("value" in own)) problems.push(`${name} : attendu un champ`);
    }
    for (const name of ACCESSORS) {
      const descriptor = find(name);
      if (Object.hasOwn(orchestrator, name)) problems.push(`${name} : attendu un accesseur du prototype`);
      else if (descriptor === undefined) problems.push(`${name} : absent`);
      else if (typeof descriptor.get !== "function") problems.push(`${name} : attendu un accesseur`);
    }
    for (const [name, length] of Object.entries(METHODS)) {
      const descriptor = find(name);
      if (Object.hasOwn(orchestrator, name)) {
        problems.push(`${name} : attendu une méthode du prototype`);
      } else if (descriptor === undefined) {
        problems.push(`${name} : absent`);
      } else if (typeof descriptor.value !== "function") {
        problems.push(`${name} : attendu une méthode`);
      } else {
        const actual = (descriptor.value as (...args: unknown[]) => unknown).length;
        if (actual !== length) problems.push(`${name} : length ${actual}, attendu ${length}`);
      }
    }
  } finally {
    await orchestrator.stop();
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("reorganisation-3-4-decouper-l-orchestrat/AC-6 : une ligne qui cite orchestrator.ts ou un morceau ne cite entre backticks que des identifiants exportés déclarés dans un fichier qu'elle cite", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr.toString());
  const exported = new Set<string>();
  const byBase = new Map<string, string[]>();
  for (const file of tsUnder("omp-harness")) {
    const base = path.posix.basename(file);
    byBase.set(base, [...(byBase.get(base) ?? []), file]);
    for (const match of read(file).matchAll(EXPORTED_NAME)) exported.add(match[1] ?? "");
  }
  const chunkNames = new Set(chunks().map((row) => path.posix.basename(row.path)));
  const declaredIn = (file: string, id: string): boolean => {
    const escaped = id.replace(/\$/g, "\\$");
    const declaration = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?${KINDS}\\s+${escaped}\\b`, "m");
    return declaration.test(read(file));
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
      const cited = [...line.matchAll(/(?<![\w-])([\w-]+\.ts)\b/g)].map((match) => match[1] ?? "");
      if (!cited.some((name) => chunkNames.has(name))) continue;
      const files = cited.flatMap((name) => byBase.get(name) ?? []);
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

test("reorganisation-3-4-decouper-l-orchestrat/AC-9 : aucun morceau n'a de plafond de types, et aucun plafond du serveur n'est relevé ni ajouté", () => {
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
