// Feature reorganisation-ranger-les-tests-du-serve : les tests du serveur de pipelines (omp-harness/) sont rangés dans
// test/harness/<dossier du serveur>/, sous le même nom de fichier. La racine de test/harness/ ne garde que des
// transverses nommés. La garde est une fonction pure des chemins : elle juge l'arbre réel pour l'état de la branche
// et des listes fabriquées pour chaque cas d'échec, et le test n'écrit jamais rien sous le dépôt (criteria.test.ts
// et ci-macos-jobs-paralleles.test.ts relisent la liste des tests en parallèle, copyRepo recopie test/).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, listTestFiles } from "../support/repo.ts";

const FEATURE = "reorganisation-ranger-les-tests-du-serve";
const SUFFIX = ".test.ts";
const HARNESS = "test/harness";

/** Les transverses de la racine de test/harness/ : point d'entrée, déploiement, structure du serveur, rangement. */
const TRANSVERSE: string[] = [
  "cli-run",
  "deploiement-continu",
  "harness-container",
  "harness-deploy",
  "harness-install",
  "harness-nixos",
  "harness-portainer",
  "reorganisation-de-la-base-de-code",
  FEATURE,
];

/** Dossier du serveur → noms (sans .test.ts) des tests qui l'éprouvent. */
const PLACED: Record<string, string[]> = {
  api: [
    "appairage-qr",
    "apps-temps-reel",
    "harness-clients",
    "harness-events",
    "harness-health",
    "harness-http",
    "harness-issues-mcp",
    "harness-securite-api",
    "harness-sse",
    "idempotence",
    "premier-chargement",
  ],
  atlassian: ["atlassian", "atlassian-agents"],
  autonomy: ["autonomie-par-paliers", "os-autonomie"],
  browser: ["moli-poste", "moli-qa", "moli-socle"],
  config: [
    "harness-check",
    "harness-oauth",
    "harness-politique",
    "harness-providers",
    "harness-repos",
    "local-model",
    "reglages-depots",
  ],
  corporate: ["pont-corpo-usine"],
  db: ["harness-db-decoupe", "harness-store"],
  forge: ["harness-forges", "harness-git", "issues-auto-par-label"],
  heavy: ["ci-juge", "harness-heavy", "preuves-revue", "rouge-de-base"],
  human: ["harness-gestes-clients", "harness-gestures", "harness-pilote", "os-propositions"],
  intake: ["demande", "demande-ancree", "demande-voies"],
  jobs: ["declencheur-entrant", "harness-audits", "harness-planification", "harness-reves"],
  memory: ["harness-memory", "harness-oracle"],
  notify: ["harness-notify", "os-telecommande", "push-alertes"],
  operations: [
    "etape-lente",
    "harness-backups",
    "harness-monitoring",
    "harness-observabilite",
    "harness-plafond-cout",
  ],
  reports: ["accueil-tableau-de-bord", "annulations-mesurees", "rapport-du-matin"],
  runners: [
    "harness-isolation-runners",
    "harness-proc",
    "harness-rpc",
    "harness-runner",
    "harness-runner-session",
    "harness-scheduler",
    "pret-slot-runner",
    "runner-journal-moteur",
  ],
  runs: [
    "commit-conventionnel-sans-vide",
    "file-de-merge",
    "harness-contradicteur",
    "harness-decisions",
    "harness-decoupage",
    "harness-fairness",
    "harness-machine",
    "harness-merger",
    "harness-pipeline",
    "harness-planner",
    "harness-prompts",
    "harness-raison-de-file",
    "harness-safefs",
    "harness-specs-gelees",
    "harness-steps",
    "harness-verdict",
    "oom-runner",
    "os-boucle",
    "os-clarte",
    "questions-en-contexte",
    "refaire-express",
    "reorganisation-3-4-decouper-l-orchestrat",
    "reste-sur-la-meme-branche",
    "set-modules-refuse-les-artefacts",
    "usine-autonome",
    "voie-directe-avec-criteres",
    "voie-express",
  ],
  sessions: ["harness-session-feed", "harness-session-rendu", "os-sessions-locales", "session-graph"],
  spaces: ["mc-etancheite", "mc-portee", "mc-poste", "mc-savoir", "os-espaces"],
  vigie: ["vigie", "vigie-runners"],
  workstation: [
    "poste-agent",
    "poste-demandes",
    "poste-navigateurs",
    "poste-securite",
    "poste-serveur",
    "poste-visibilite",
  ],
};

/** Les dossiers de test que le rangement a supprimés : ils ne reviennent pas. */
const FORBIDDEN = ["ci-judge", "oom-runner", "session-graph"];

/** Chemins de test cités comme données, pas comme fichiers : fichier qui les porte → chemins. */
const DATA_PATHS: Record<string, string[]> = {
  "test/harness/heavy/harness-heavy.test.ts": ["test/harness/a.test.ts"],
  "test/harness/runs/harness-planner.test.ts": ["test/harness/x.test.ts"],
};

const posix = (p: string): string => p.split(path.sep).join("/");
const baseName = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Tous les fichiers sous test/, en chemins `test/…`, triés. */
function testTree(): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(ROOT, "test"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(posix(path.relative(ROOT, path.join(entry.parentPath, entry.name))));
  }
  return out.sort();
}

/** Les sous-dossiers directs de omp-harness/ (deploy/ exclu) qui contiennent un `.ts` à un niveau quelconque. */
function serverDirs(): Set<string> {
  const server = path.join(ROOT, "omp-harness");
  const dirs = new Set<string>();
  for (const entry of fs.readdirSync(server, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const rel = posix(path.relative(server, path.join(entry.parentPath, entry.name)));
    const head = rel.split("/")[0] ?? "";
    if (rel.includes("/") && head !== "deploy") dirs.add(head);
  }
  return dirs;
}

/** Écarts de placement des fichiers de test. Liste triée ; vide = conforme. */
function placementGaps(files: readonly string[], dirs: ReadonlySet<string>): string[] {
  const gaps: string[] = [];
  const misplaced = new Set<string>();

  for (const d of FORBIDDEN) {
    const first = files.find((f) => f.startsWith(`test/${d}/`));
    if (first !== undefined) gaps.push(`test/${d}/ : dossier retiré par le rangement, revenu (${first})`);
  }

  const expectations: Array<[string, string]> = [];
  for (const [dir, names] of Object.entries(PLACED)) {
    for (const name of names) expectations.push([name, `${HARNESS}/${dir}/${name}${SUFFIX}`]);
  }
  for (const name of TRANSVERSE) expectations.push([name, `${HARNESS}/${name}${SUFFIX}`]);
  const present = new Set(files);
  for (const [name, expected] of expectations) {
    if (present.has(expected)) continue;
    const elsewhere = files.filter((f) => baseName(f) === `${name}${SUFFIX}`);
    if (elsewhere.length === 0) gaps.push(`${expected} : absent`);
    for (const f of elsewhere) {
      misplaced.add(f);
      gaps.push(`${f} : rangé hors de sa place, attendu ${expected}`);
    }
  }

  const named = new Set(TRANSVERSE);
  const hint = [...dirs].sort().join(", ");
  for (const f of files) {
    const root = /^test\/harness\/([^/]+)\.test\.ts$/.exec(f);
    if (root !== null && !named.has(root[1] ?? "") && !misplaced.has(f)) {
      gaps.push(
        `${f} : test non nommé à la racine de ${HARNESS}/ — à ranger dans ${HARNESS}/<dossier du serveur>/ ` +
          `(${hint}), le dossier de ce que promet son en-tête`,
      );
    }
    const sub = /^test\/harness\/([^/]+)\/.+/.exec(f);
    if (sub !== null && !dirs.has(sub[1] ?? "")) {
      gaps.push(`${f} : ${HARNESS}/${sub[1]}/ ne nomme aucun dossier du serveur`);
    }
  }
  return gaps.sort();
}

/** Écarts de la carte des tests (DEVELOPPEMENT.md § « Tests et scripts ») et des sous-dossiers de test/harness/. */
function mapGaps(markdown: string, subdirs: ReadonlySet<string>): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l === "## Tests et scripts");
  if (start === -1) return ["DEVELOPPEMENT.md : section « Tests et scripts » absente"];
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  const section = lines.slice(start + 1, end);

  const gaps: string[] = [];
  const mentioned = new Set<string>();
  for (const line of section) {
    const m = /^\|\s*`test\/harness\/([\w-]+)\/`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m === null) continue;
    const dir = m[1] ?? "";
    const phrase = m[2] ?? "";
    mentioned.add(dir);
    if (!subdirs.has(dir)) gaps.push(`${HARNESS}/${dir}/ : phrase de la carte sans sous-dossier`);
    if (phrase === "" || phrase === "-") gaps.push(`${HARNESS}/${dir}/ : phrase vide`);
    if (/mem0/i.test(phrase)) gaps.push(`${HARNESS}/${dir}/ : la phrase nomme mem0`);
  }
  for (const dir of subdirs) {
    if (!mentioned.has(dir)) gaps.push(`${HARNESS}/${dir}/ : sous-dossier sans phrase dans la carte des tests`);
  }

  const rootLine = section
    .map((l) => /^\|\s*`test\/harness\/`\s*\|\s*(.*?)\s*\|\s*$/.exec(l))
    .find((m) => m !== null);
  const rootPhrase = rootLine?.[1] ?? "";
  if (rootPhrase === "" || rootPhrase === "-") {
    gaps.push(`${HARNESS}/ : ligne de la racine absente ou vide`);
  } else {
    if (!/racine/i.test(rootPhrase)) gaps.push(`${HARNESS}/ : la ligne ne dit pas ce que garde la racine`);
    if (/mem0/i.test(rootPhrase)) gaps.push(`${HARNESS}/ : la ligne de la racine nomme mem0`);
  }
  return gaps.sort();
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

/** Chemins de test cités par les fichiers `sources` qui ne désignent plus rien. */
function citationGaps(
  sources: ReadonlyArray<{ file: string; text: string }>,
  exists: (rel: string) => boolean,
  testFiles: readonly string[],
): string[] {
  const gaps: string[] = [];
  for (const { file, text } of sources) {
    const data = (Object.hasOwn(DATA_PATHS, file) ? DATA_PATHS[file] : undefined) ?? [];
    text.split("\n").forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      for (const m of line.matchAll(/(?<![\w.-])test\/(ci-judge|oom-runner|session-graph)\//g)) {
        gaps.push(`${at} → test/${m[1]}/ : dossier retiré par le rangement`);
      }
      for (const m of line.matchAll(/(?<![\w.-])test\/harness\/((?:[\w-]+\/)?[\w*-]+\.test\.ts)/g)) {
        const cited = `${HARNESS}/${m[1]}`;
        if (data.includes(cited)) continue;
        const alive = cited.includes("*")
          ? testFiles.some((t) => globToRegExp(cited).test(t))
          : exists(cited);
        if (!alive) gaps.push(`${at} → ${cited} : chemin mort`);
      }
    });
  }
  return gaps.sort();
}

/** Les fichiers suivis lisibles en texte, hors CHANGELOG.md et hors ce fichier (qui cite des chemins fabriqués). */
function trackedSources(): Array<{ file: string; text: string }> {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr.toString());
  const out: Array<{ file: string; text: string }> = [];
  for (const file of listed.stdout.toString("utf8").split("\0")) {
    if (file === "" || file === "CHANGELOG.md" || file === `${HARNESS}/${FEATURE}${SUFFIX}`) continue;
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) continue;
    out.push({ file, text: buf.toString("utf8") });
  }
  return out;
}

/** Les dossiers de la carte « Le serveur, dossier par dossier » de DEVELOPPEMENT.md. */
function serverMapDirs(): Set<string> {
  const lines = read("DEVELOPPEMENT.md").split("\n");
  const start = lines.findIndex((l) => l === "### Le serveur, dossier par dossier");
  assert.notEqual(start, -1, "carte absente de DEVELOPPEMENT.md");
  let end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  if (end === -1) end = lines.length;
  const dirs = new Set<string>();
  for (const line of lines.slice(start + 1, end)) {
    const m = /^\|\s*`([\w-]+)\/`\s*\|/.exec(line);
    if (m !== null) dirs.add(m[1] ?? "");
  }
  return dirs;
}

test("reorganisation-ranger-les-tests-du-serve/AC-1 : les trois dossiers isolés ont disparu et leurs tests sont rangés dans test/harness/", () => {
  for (const d of FORBIDDEN) {
    assert.equal(fs.existsSync(path.join(ROOT, "test", d)), false, `test/${d}/ existe encore`);
  }
  for (const rel of [
    "test/harness/heavy/ci-juge.test.ts",
    "test/harness/runs/oom-runner.test.ts",
    "test/harness/sessions/session-graph.test.ts",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} : absent`);
  }

  const tree = testTree();
  const dirs = serverDirs();
  const real = placementGaps(tree, dirs).filter((g) => FORBIDDEN.some((d) => g.startsWith(`test/${d}/`)));
  assert.deepEqual(real, []);

  const revenu = placementGaps([...tree, "test/ci-judge/ci-juge.test.ts"], dirs);
  assert.ok(
    revenu.some((g) => g.startsWith("test/ci-judge/")),
    `un dossier retiré revenu doit être nommé : ${revenu.join(" | ")}`,
  );
});

test("reorganisation-ranger-les-tests-du-serve/AC-2 : chaque test est dans son dossier, la racine ne garde que les transverses, chaque sous-dossier nomme un dossier du serveur", () => {
  const tree = testTree();
  const dirs = serverDirs();
  assert.deepEqual(
    [...dirs].sort(),
    [...serverMapDirs()].sort(),
    "les dossiers du serveur ne sont pas ceux de la carte",
  );
  for (const d of Object.keys(PLACED)) assert.ok(dirs.has(d), `PLACED : ${d}/ ne nomme aucun dossier du serveur`);

  const gaps = placementGaps(tree, dirs);
  assert.deepEqual(gaps, [], `écarts de rangement :\n  ${gaps.join("\n  ")}`);

  const swapped = tree.map((f) =>
    f === "test/harness/runs/harness-pipeline.test.ts" ? "test/harness/api/harness-pipeline.test.ts" : f,
  );
  const misplaced = placementGaps(swapped, dirs);
  assert.ok(
    misplaced.some(
      (g) =>
        g.includes("test/harness/api/harness-pipeline.test.ts") &&
        g.includes("attendu test/harness/runs/harness-pipeline.test.ts"),
    ),
    `un test mal rangé doit être nommé avec sa place : ${misplaced.join(" | ")}`,
  );

  const loose = placementGaps([...tree, "test/harness/nouveau.test.ts"], dirs);
  assert.ok(
    loose.some(
      (g) =>
        g.includes("test/harness/nouveau.test.ts") && g.includes("à ranger dans test/harness/<dossier du serveur>/"),
    ),
    `un test non nommé à la racine doit prescrire le geste : ${loose.join(" | ")}`,
  );

  const alien = placementGaps([...tree, "test/harness/tests/x.test.ts"], dirs);
  assert.ok(
    alien.some((g) => g.includes("test/harness/tests/x.test.ts") && g.includes("test/harness/tests/")),
    `un sous-dossier sans dossier du serveur doit être nommé : ${alien.join(" | ")}`,
  );
});

test("reorganisation-ranger-les-tests-du-serve/AC-3 : un test neuf est accepté dans un dossier du serveur, refusé à la racine et hors carte", () => {
  const tree = testTree();
  const dirs = serverDirs();
  const base = placementGaps(tree, dirs);

  assert.deepEqual(placementGaps([...tree, "test/harness/api/nouveau.test.ts"], dirs), base);

  const root = placementGaps([...tree, "test/harness/nouveau.test.ts"], dirs);
  assert.equal(root.length, base.length + 1);
  assert.ok(root.some((g) => g.startsWith("test/harness/nouveau.test.ts")));

  const deploy = placementGaps([...tree, "test/harness/deploy/nouveau.test.ts"], dirs);
  assert.equal(deploy.length, base.length + 1);
  assert.ok(
    deploy.some((g) => g.includes("test/harness/deploy/nouveau.test.ts") && g.includes("test/harness/deploy/")),
  );
});

test("reorganisation-ranger-les-tests-du-serve/AC-4 : la carte des tests de DEVELOPPEMENT.md décrit chaque sous-dossier de test/harness/ et ce que garde la racine", () => {
  const subdirs = new Set<string>();
  for (const f of testTree()) {
    const m = /^test\/harness\/([^/]+)\/.+\.test\.ts$/.exec(f);
    if (m !== null) subdirs.add(m[1] ?? "");
  }
  assert.ok(subdirs.size > 0, "aucun sous-dossier de test/harness/ : le scan serait aveugle");
  const doc = read("DEVELOPPEMENT.md");
  const gaps = mapGaps(doc, subdirs);
  assert.deepEqual(gaps, [], `carte des tests : ${gaps.join(" ; ")}`);

  const lines = doc.split("\n");
  const noVigie = lines.filter((l) => !l.startsWith("| `test/harness/vigie/` |")).join("\n");
  assert.ok(mapGaps(noVigie, subdirs).some((g) => g.includes("test/harness/vigie/")));

  const withZz = lines.flatMap((l) =>
    l.startsWith("| `test/harness/vigie/` |") ? [l, "| `test/harness/zz/` | rien |"] : [l],
  );
  assert.ok(mapGaps(withZz.join("\n"), subdirs).some((g) => g.includes("test/harness/zz/")));

  const mem0 = lines
    .map((l) => (l.startsWith("| `test/harness/api/` |") ? "| `test/harness/api/` | Mem0 |" : l))
    .join("\n");
  assert.ok(mapGaps(mem0, subdirs).some((g) => g.includes("test/harness/api/") && g.includes("mem0")));

  assert.deepEqual(mapGaps("# rien\n", subdirs), ["DEVELOPPEMENT.md : section « Tests et scripts » absente"]);
});

test("reorganisation-ranger-les-tests-du-serve/AC-8 : chaque clé test/ du plafond de types désigne un fichier existant", () => {
  const baseline = JSON.parse(read("scripts/types-ratchet-baseline.json")) as { files: Record<string, number> };
  const keys = Object.keys(baseline.files).filter((k) => k.startsWith("test/"));
  assert.ok(
    keys.some((k) => k.startsWith("test/harness/")),
    "aucune clé test/harness/ : le scan serait aveugle",
  );
  const dead = keys.filter((k) => !fs.existsSync(path.join(ROOT, k)));
  assert.deepEqual(dead, [], `clés mortes : ${dead.join(", ")}`);
});

test("reorganisation-ranger-les-tests-du-serve/AC-9 : chaque exclusion Biome test/ désigne un fichier existant", () => {
  const lines = read("scripts/biome-rules/baseline.jsonc").split("\n");
  const cited: Array<{ line: number; rel: string }> = [];
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/"!\*\*\/(test\/[^"]+)"/g)) cited.push({ line: i + 1, rel: m[1] ?? "" });
  });
  assert.ok(
    cited.some((c) => c.rel.startsWith("test/harness/")),
    "aucune exclusion test/harness/ : le scan serait aveugle",
  );
  const dead = cited
    .filter((c) => !fs.existsSync(path.join(ROOT, c.rel)))
    .map((c) => `baseline.jsonc:${c.line} → ${c.rel}`);
  assert.deepEqual(dead, []);
});

test("reorganisation-ranger-les-tests-du-serve/AC-10 : aucun chemin de test cité dans un fichier suivi ne meurt", () => {
  const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));
  const gaps = citationGaps(trackedSources(), exists, listTestFiles());
  assert.deepEqual(gaps, [], `chemins morts :\n  ${gaps.join("\n  ")}`);

  const fake = (text: string) => citationGaps([{ file: "a.md", text }], exists, listTestFiles());
  assert.deepEqual(fake("voir test/harness/moli-socle.test.ts"), [
    "a.md:1 → test/harness/moli-socle.test.ts : chemin mort",
  ]);
  assert.deepEqual(fake("voir test/harness/browser/moli-*.test.ts"), []);
  assert.equal(fake("voir test/harness/zz/moli-*.test.ts").length, 1);
  assert.deepEqual(fake("voir test/session-graph/x"), [
    "a.md:1 → test/session-graph/ : dossier retiré par le rangement",
  ]);
});
