// Feature decoupage-serveur-http : le serveur HTTP du harness, un seul fichier de plus de 2000 lignes, est rangé en
// modules d'omp-harness/api/ qui portent chacun une seule responsabilité (le transport, la table des routes, les
// routes des runs, du poste, de l'administration, des espaces). La table de CORRESPONDANCE.md dit le morceau de chaque
// responsabilité ; le test juge l'état courant (jamais un commit de base) : qui déclare quoi, où vit chaque route, ce
// que chaque importeur importe, ce que chaque ligne cite.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/api/auth.ts";
import { apiRoutes } from "../../omp-harness/api/route-table.ts";
import { ROOT } from "../support/repo.ts";

const LABELS = {
  transport: "transport",
  table: "table des routes",
  runs: "routes des runs et de l'usine",
  poste: "routes du poste",
  admin: "routes d'administration et d'exploitation du serveur",
  spaces: "routes des espaces et des intégrations",
};

/** La famille d'une route (`/v1/<famille>…`, ou `/metrics`) → le libellé de la responsabilité qui la porte. */
const FAMILIES: Record<string, string> = {
  runs: LABELS.runs,
  projects: LABELS.runs,
  audits: LABELS.runs,
  decisions: LABELS.runs,
  escalations: LABELS.runs,
  inbox: LABELS.runs,
  brief: LABELS.runs,
  digest: LABELS.runs,
  proposals: LABELS.runs,
  rules: LABELS.runs,
  autonomy: LABELS.runs,
  dreams: LABELS.runs,
  schedules: LABELS.runs,
  status: LABELS.runs,
  stats: LABELS.runs,
  scoreboard: LABELS.runs,
  mcp: LABELS.runs,
  workstation: LABELS.poste,
  clients: LABELS.admin,
  pair: LABELS.admin,
  providers: LABELS.admin,
  oauth: LABELS.admin,
  models: LABELS.admin,
  repos: LABELS.admin,
  reload: LABELS.admin,
  pause: LABELS.admin,
  vigie: LABELS.admin,
  metrics: LABELS.admin,
  "client-errors": LABELS.admin,
  me: LABELS.admin,
  "/metrics": LABELS.admin,
  spaces: LABELS.spaces,
  atlassian: LABELS.spaces,
  signals: LABELS.spaces,
  intake: LABELS.spaces,
  "local-sessions": LABELS.spaces,
  push: LABELS.spaces,
};

/** Les neuf fichiers d'api/ que le rangement du serveur a laissés entiers. */
const LOT1_API = [
  "mcp.ts",
  "auth.ts",
  "pairing.ts",
  "input.ts",
  "idempotency.ts",
  "errors.ts",
  "queries.ts",
  "inspect.ts",
  "events.ts",
];

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
const NAMED_IMPORT = /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/gm;
const OTHER_IMPORT = /^import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\w+)\s+from\s*"([^"]+)"/gm;
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

/** Les `.ts` que lisent les contrôles d'import : le serveur (deploy/ compris), test/ et scripts/, relatifs à ROOT. */
function importersTs(): string[] {
  return [...tsUnder("omp-harness"), ...tsUnder("test"), ...tsUnder("scripts")];
}

type Chunk = { path: string; role: string; line: string };

/** Les lignes de CORRESPONDANCE.md dont l'ancien chemin est `http.ts` : un morceau et sa responsabilité. */
function chunks(): Chunk[] {
  const found: Chunk[] = [];
  const file = path.join(SERVER, "CORRESPONDANCE.md");
  assert.ok(fs.existsSync(file), "omp-harness/CORRESPONDANCE.md absent");
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (match?.[1] === "http.ts") found.push({ path: match[2] ?? "", role: match[3] ?? "", line });
  }
  return found;
}

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

/** Le numéro de ligne (à partir de 1) d'un décalage dans un texte. */
const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

test("decoupage-serveur-http/AC-1 : chaque morceau de http.ts est un api/<nom>.ts qui existe, tient en 2000 lignes, a un nom que personne d'autre ne porte et une seule responsabilité ; api/ ne contient que les neuf fichiers entiers et les morceaux", () => {
  const rows = chunks();
  assert.ok(rows.length > 0, "CORRESPONDANCE.md : aucune ligne `http.ts`");
  const everyTs = importersTs().filter((file) => file.startsWith("omp-harness/"));
  const problems: string[] = [];
  for (const { path: chunk } of rows) {
    if (!/^api\/[\w-]+\.ts$/.test(chunk)) problems.push(`${chunk} : n'est pas un api/<nom>.ts`);
    const file = path.join(SERVER, chunk);
    if (!fs.existsSync(file)) {
      problems.push(`${chunk} absent`);
      continue;
    }
    const lines = fs.readFileSync(file, "utf8").split("\n").length;
    if (lines > 2000) problems.push(`${chunk} : ${lines} lignes`);
    if (chunk === "api/http.ts") continue;
    const name = path.posix.basename(chunk);
    const same = everyTs.filter((other) => path.posix.basename(other) === name);
    if (same.length !== 1) problems.push(`${name} : nom déjà porté par ${same.join(", ")}`);
  }
  if (!rows.some((row) => row.path === "api/http.ts")) problems.push("api/http.ts n'est pas un morceau");
  for (const label of Object.values(LABELS)) {
    if (!rows.some((row) => row.role === label)) problems.push(`aucun morceau pour ${label}`);
  }
  for (const row of rows) {
    const roles = new Set(rows.filter((other) => other.path === row.path).map((other) => other.role));
    if (roles.size > 1) problems.push(`${row.path} sous deux responsabilités`);
  }
  const expected = new Set([...LOT1_API.map((name) => `api/${name}`), ...rows.map((row) => row.path)]);
  const present = new Set(serverTs().filter((file) => file.startsWith("api/")));
  for (const file of present) {
    if (!expected.has(file)) problems.push(`${file} n'est pas dans la table`);
  }
  for (const file of expected) {
    if (!present.has(file)) problems.push(`${file} absent`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("decoupage-serveur-http/AC-2 : la responsabilité de chaque ligne http.ts est exactement l'un des six libellés, et aucune ligne ne nomme mem0", () => {
  const labels = new Set(Object.values(LABELS));
  const problems: string[] = [];
  for (const row of chunks()) {
    const where = `CORRESPONDANCE.md : \`http.ts\` → ${row.path}`;
    if (row.role === "") {
      problems.push(`${where} : responsabilité vide`);
    } else if (!labels.has(row.role)) {
      problems.push(`${where} : responsabilité « ${row.role} » inconnue`);
    }
    if (/mem0/i.test(row.line)) problems.push(`CORRESPONDANCE.md : ${row.path} nomme mem0`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("decoupage-serveur-http/AC-3 : les route(…) déclarées dans les morceaux sont exactement celles d'apiRoutes, chacune dans un morceau de la responsabilité de sa famille", () => {
  const rows = chunks();
  const declared: { key: string; chunk: string }[] = [];
  for (const row of rows) {
    const source = fs.readFileSync(path.join(SERVER, row.path), "utf8");
    for (const match of source.matchAll(/route\("(GET|POST|PUT|PATCH|DELETE)", "([^"]+)"/g)) {
      declared.push({ key: `${match[1]} ${match[2]}`, chunk: row.path });
    }
  }
  const table = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const fromRuntime = table.map((route) => `${route.method} ${route.path}`).sort();
  const fromSource = declared.map((route) => route.key).sort();
  const onlySource = fromSource.filter((key) => !fromRuntime.includes(key));
  const onlyRuntime = fromRuntime.filter((key) => !fromSource.includes(key));
  assert.deepEqual(
    fromSource,
    fromRuntime,
    `routes relevées dans les morceaux seulement : ${onlySource.join(", ")} ; dans apiRoutes seulement : ${onlyRuntime.join(", ")}`,
  );
  assert.ok(fromSource.length > 0, "aucune route relevée dans les morceaux");
  const roleOf = new Map<string, string>(rows.map((row) => [row.path, row.role]));
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  for (const { key, chunk } of declared) {
    const route = key.split(" ")[1] ?? "";
    const segment = route.split("/")[2] ?? "";
    const family = route === "/metrics" ? route : segment;
    const expected = route.startsWith("/v1/") || route === "/metrics" ? FAMILIES[family] : undefined;
    if (expected === undefined) {
      problems.push(`${key} : famille « ${family} » inconnue`);
      continue;
    }
    if (roleOf.get(chunk) !== expected) problems.push(`${key} → ${chunk} (${expected})`);
    counts[expected] = (counts[expected] ?? 0) + 1;
  }
  for (const label of [LABELS.runs, LABELS.poste, LABELS.admin, LABELS.spaces]) {
    if (!counts[label]) problems.push(`aucune route déclarée pour ${label}`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("decoupage-serveur-http/AC-4 : les sept fonctions du transport sont déclarées une fois dans un module du transport, apiRoutes une fois dans celui de la table", () => {
  const roleOf = new Map<string, string>(chunks().map((row) => [`omp-harness/${row.path}`, row.role]));
  const expected: [string, string][] = [
    ["createHandler", LABELS.transport],
    ["pulseFrame", LABELS.transport],
    ["healthChecks", LABELS.transport],
    ["ifMatch", LABELS.transport],
    ["send", LABELS.transport],
    ["readJson", LABELS.transport],
    ["readBody", LABELS.transport],
    ["apiRoutes", LABELS.table],
  ];
  const problems: string[] = [];
  const files = tsUnder("omp-harness").filter((file) => !file.startsWith("omp-harness/deploy/"));
  for (const [name, label] of expected) {
    const declaration = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`, "m");
    const where = files.filter((file) => declaration.test(read(file)));
    if (where.length !== 1) {
      problems.push(`${name} : déclarée ${where.length} fois`);
    } else if (roleOf.get(where[0] ?? "") !== label) {
      problems.push(`${name} : dans ${where[0]}, attendue dans un module ${label}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("decoupage-serveur-http/AC-5 : aucune réexportation ne vise un morceau, et chaque nom importé d'un morceau y est déclaré, sans alias ni façade", () => {
  const pieces = new Set(chunks().map((chunk) => `omp-harness/${chunk.path}`));
  const resolves = (from: string, specifier: string): string | null => {
    if (!specifier.startsWith(".")) return null;
    const target = path.normalize(path.join(path.dirname(from), specifier)).split(path.sep).join("/");
    return pieces.has(target) ? target : null;
  };
  const declares = (piece: string, name: string): boolean => {
    const declaration = new RegExp(`^export\\s+(?:declare\\s+)?(?:async\\s+)?${KINDS}\\s+${name}\\b`, "m");
    return declaration.test(read(piece));
  };
  const problems: string[] = [];
  for (const file of importersTs()) {
    const text = read(file);
    const importedFromPieces = new Set<string>();
    for (const match of text.matchAll(REEXPORT)) {
      if (resolves(file, match[1] ?? "")) problems.push(`${file}:${lineOf(text, match.index)} réexporte un morceau`);
    }
    for (const match of text.matchAll(NAMED_IMPORT)) {
      const piece = resolves(file, match[2] ?? "");
      if (!piece) continue;
      for (const spec of (match[1] ?? "").split(",")) {
        const name = spec.trim().replace(/^type\s+/, "");
        if (name === "") continue;
        importedFromPieces.add(name);
        const where = `${file}:${lineOf(text, match.index)} → ${name}`;
        if (/\sas\s/.test(name)) {
          problems.push(`${where} : alias`);
        } else if (!declares(piece, name)) {
          problems.push(where);
        }
      }
    }
    for (const match of text.matchAll(OTHER_IMPORT)) {
      if (resolves(file, match[1] ?? "")) {
        problems.push(`${file}:${lineOf(text, match.index)} importe un morceau par espace de noms ou par défaut`);
      }
    }
    for (const match of text.matchAll(LOCAL_EXPORT)) {
      for (const spec of (match[1] ?? "").split(",")) {
        const name = (spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "").trim();
        if (importedFromPieces.has(name)) problems.push(`${file}:${lineOf(text, match.index)} → ${name} : façade`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("decoupage-serveur-http/AC-6 : une ligne qui cite http.ts ou un morceau ne cite entre backticks que des identifiants exportés déclarés dans un fichier qu'elle cite", () => {
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

test("decoupage-serveur-http/AC-7 : aucun morceau n'a de plafond de types, et aucun plafond du serveur n'est relevé", () => {
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
