// Critères de la feature ci-without-cache : les caches `actions/cache` des jobs de
// `.github/workflows/check.yml` et de `.github/workflows/release-simulation.yml`
// (hôte OMP par `~/.npm`, registre et cible cargo, scratchs SwiftPM ; jamais le
// DerivedData iOS), leurs clés calées sur les lockfiles et les toolchains, et ce que le cache
// ne doit jamais changer : les contextes de statut requis, l'absence de toute
// relance et le verdict de `scripts/check.sh`.
//
// Ces gardes lisent le YAML comme du texte, sans dépendance : les parseurs sont
// locaux (sur le modèle de test/outillage/ci-macos-jobs-paralleles.test.ts) et
// les commentaires sont retirés avant toute assertion, puisqu'ils nomment
// justement ce qui est interdit (`restore-keys`, `~/.cargo/bin`…).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEPTH = Number(process.env.MEM0_CHECK_DEPTH ?? "0");
const NESTED = "copie jetable — l'historique git est éprouvé au premier niveau";

const CHECK_FILE = ".github/workflows/check.yml";
const SIMULATION_FILE = ".github/workflows/release-simulation.yml";
/** Dernier commit de `main` avant la feature : la référence des invariants d'AC-2. */
const BASE = "df1f645";

const readFile = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
/** Le YAML sans ses lignes de commentaire. */
const uncommented = (yaml: string) => yaml.replace(/^\s*#.*$\n?/gm, "");

/** Les jobs d'un workflow, dans l'ordre du fichier : identifiant → texte du job sans commentaires. */
function workflowJobs(workflow: string): Map<string, string> {
  const body = workflow.split(/^jobs:\s*$/m)[1] ?? "";
  const jobs = new Map<string, string>();
  for (const chunk of body.split(/^(?= {2}[A-Za-z0-9_-]+:$)/m)) {
    const id = /^ {2}([A-Za-z0-9_-]+):$/m.exec(chunk);
    if (id) jobs.set(id[1] as string, uncommented(chunk));
  }
  return jobs;
}

/** L'en-tête d'un job : ses lignes jusqu'à `steps:` (nom, matrice, needs, if, runs-on…). */
const jobHeader = (job: string) => (job.split(/^ {4}steps:\s*$/m)[0] ?? "").split("\n").filter((line) => line.trim() !== "");

/** Les étapes d'un job, une par bloc (`      - ` ouvre une étape), sans lignes vides. */
function stepsOf(job: string): string[][] {
  const lines = (job.split(/^ {4}steps:\s*$/m)[1] ?? "").split("\n").filter((line) => line.trim() !== "");
  const steps: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("      - ")) steps.push([line]);
    else steps.at(-1)?.push(line);
  }
  return steps;
}

const isCache = (step: string[]) => step.some((line) => /^\s+(- )?uses: actions\/cache/.test(line));
const stepName = (step: string[]) => /^ {6}- name: (.*)$/.exec(step[0] ?? "")?.[1] ?? null;

/** L'étape d'empreinte, texte exact de S-1. */
const FINGERPRINT_STEP = [
  "      - name: Empreinte des toolchains (clés de cache)",
  "        id: toolchain",
  "        run: |",
  "          {",
  '            echo "node=$(node --version 2>/dev/null || echo absent)"',
  '            echo "rust=$( (rustc -vV 2>&1 || echo absent) | shasum -a 256 | cut -c1-16)"',
  '            echo "swift=$( (swift --version 2>&1 || echo absent; xcode-select -p 2>&1 || echo absent) | shasum -a 256 | cut -c1-16)"',
  '          } >> "$GITHUB_OUTPUT"',
];

/** Grammaire des clés (S-1) : `<famille>-<job>-<index>-<os>-<arch>-<toolchain>-<contenu>`. */
const KEY_HEAD = "${{ github.job }}-${{ strategy.job-index }}-${{ runner.os }}-${{ runner.arch }}";
const FAMILIES = {
  npm: {
    toolchain: "node-${{ steps.toolchain.outputs.node }}",
    content: "omp-${{ env.OMP_HOST_VERSION }}-types-node-${{ env.OMP_HOST_TYPES_NODE }}",
  },
  cargo: {
    toolchain: "rustc-${{ steps.toolchain.outputs.rust }}",
    content: "${{ hashFiles('mem0-stack/mem0-rs/Cargo.lock', 'mem0-stack/mem0-rs/Cargo.toml') }}",
  },
  swiftpm: {
    toolchain: "swift-${{ steps.toolchain.outputs.swift }}",
    content: "${{ hashFiles('omp-console/Package.swift') }}",
  },
} as const;
type Family = keyof typeof FAMILIES;
const keyOf = (family: Family) => `${family}-${KEY_HEAD}-${FAMILIES[family].toolchain}-${FAMILIES[family].content}`;

const CARGO_REGISTRY = ["~/.cargo/registry/index", "~/.cargo/registry/cache", "~/.cargo/git/db"];

/** Le texte exact d'une étape de cache. */
function cacheStep(name: string, family: Family, paths: string[], condition?: string): string[] {
  return [
    `      - name: ${name}`,
    ...(condition ? [`        if: ${condition}`] : []),
    "        uses: actions/cache@v6",
    "        with:",
    ...(paths.length === 1 ? [`          path: ${paths[0]}`] : ["          path: |", ...paths.map((p) => `            ${p}`)]),
    `          key: ${keyOf(family)}`,
  ];
}

const NPM = cacheStep("Cache npm (hôte OMP)", "npm", ["~/.npm"]);
const CARGO = (target: string, condition?: string) =>
  cacheStep("Cache cargo (mem0-rs)", "cargo", [...CARGO_REGISTRY, target], condition);
const INSTALL =
  '          npm install --no-save --prefix "$RUNNER_TEMP/omp-host" "@oh-my-pi/pi-coding-agent@$OMP_HOST_VERSION" "@types/node@$OMP_HOST_TYPES_NODE"';

interface Expected {
  file: string;
  job: string;
  /** Première ligne de l'étape après laquelle l'empreinte s'insère. */
  anchor: string;
  /** Les étapes de cache, dans l'ordre npm → cargo → swiftpm, juste après l'empreinte. */
  caches: { family: Family; step: string[] }[];
  /** Ligne de l'étape qui consomme les chemins cachés (hors npm). */
  consumer: string;
}

/** Tableau de S-2/S-3 : chaque job qui cache, ses étapes et leur consommateur. */
const EXPECTED: Expected[] = [
  {
    file: CHECK_FILE,
    job: "check",
    anchor: "      - uses: actions/setup-node@v4",
    caches: [
      { family: "npm", step: NPM },
      { family: "cargo", step: CARGO("mem0-stack/mem0-rs/target") },
    ],
    consumer: "        run: ./scripts/check.sh",
  },
  {
    file: CHECK_FILE,
    job: "macos-app-swift",
    anchor: "      - uses: actions/checkout@v4",
    caches: [
      { family: "cargo", step: CARGO("mem0-stack/mem0-rs/target") },
      { family: "swiftpm", step: cacheStep("Cache SwiftPM (.build-app)", "swiftpm", ["omp-console/.build-app"]) },
    ],
    consumer: "        run: ./scripts/check.sh --sections=app-swift",
  },
  {
    file: CHECK_FILE,
    job: "macos-tests",
    anchor: "      - uses: actions/setup-node@v4",
    caches: [
      { family: "npm", step: NPM },
      { family: "cargo", step: CARGO("mem0-stack/mem0-rs/target", "matrix.part == '1/2' || github.event_name == 'push'") },
      {
        family: "swiftpm",
        step: cacheStep("Cache SwiftPM (.build-node)", "swiftpm", ["omp-console/.build-node"], "matrix.part == '1/2'"),
      },
    ],
    consumer: "        run: ./scripts/check.sh --sections=",
  },
  {
    file: SIMULATION_FILE,
    job: "release-simulation",
    anchor: "      - uses: actions/setup-node@v4",
    caches: [{ family: "cargo", step: CARGO("${{ runner.temp }}/cargo-target") }],
    consumer: "        run: bash scripts/release-simulation.sh",
  },
];

/** Index de l'étape dont une ligne commence par `prefix` (unique ; absente : erreur). */
function stepIndex(steps: string[][], prefix: string, where: string): number {
  const found = steps.flatMap((step, i) => (step.some((line) => line.startsWith(prefix)) ? [i] : []));
  assert.equal(found.length, 1, `${where} : « ${prefix.trim()} » attendu dans exactement une étape (${found.length})`);
  return found[0] as number;
}

/** Rend une clé avec des valeurs plausibles maximales, pour juger longueur et virgules. */
function renderKey(key: string, job: string): string {
  return key
    .replace("${{ github.job }}", job)
    .replace("${{ strategy.job-index }}", "1")
    .replace("${{ runner.os }}", "Windows")
    .replace("${{ runner.arch }}", "ARM64")
    .replace("${{ steps.toolchain.outputs.node }}", "v22.99.99")
    .replace(/\$\{\{ steps\.toolchain\.outputs\.(rust|swift) \}\}/g, "0123456789abcdef")
    .replace("${{ env.OMP_HOST_VERSION }}", "18.8.4")
    .replace("${{ env.OMP_HOST_TYPES_NODE }}", "22")
    .replace(/\$\{\{ hashFiles\([^)]*\) \}\}/g, "f".repeat(64));
}

test("ci-without-cache/AC-1 : chaque job qui installe l'hôte OMP, compile du Rust ou du Swift restaure un cache par famille, aux chemins et clés de S-1", () => {
  const files: Record<string, string> = { [CHECK_FILE]: readFile(CHECK_FILE), [SIMULATION_FILE]: readFile(SIMULATION_FILE) };
  const keys: string[] = [];

  for (const expected of EXPECTED) {
    const where = `${expected.file} › ${expected.job}`;
    const job = workflowJobs(files[expected.file] ?? "").get(expected.job);
    assert.ok(job, `${where} : job introuvable`);
    const steps = stepsOf(job);

    // (1)(2)(3) L'empreinte, juste après l'ancrage, puis chaque cache attendu, au
    // texte près (uses, chemins, clé, condition), d'un seul tenant et dans l'ordre.
    const anchor = stepIndex(steps, expected.anchor, where);
    assert.deepEqual(steps[anchor + 1], FINGERPRINT_STEP, `${where} : empreinte absente après l'ancrage`);
    expected.caches.forEach(({ step }, i) => assert.deepEqual(steps[anchor + 2 + i], step, `${where} : cache n°${i + 1}`));
    // Aucun autre cache que ceux du tableau.
    assert.deepEqual(
      steps.filter(isCache).map(stepName),
      expected.caches.map(({ step }) => stepName(step)),
      `${where} : caches inattendus`,
    );

    // (4) Chaque cache précède l'étape qui consomme son chemin.
    const consumer = stepIndex(steps, expected.consumer, where);
    for (const [i, { family }] of expected.caches.entries()) {
      const at = anchor + 2 + i;
      if (family === "npm") assert.ok(at < stepIndex(steps, INSTALL, where), `${where} : cache npm après l'installation`);
      else assert.ok(at < consumer, `${where} : cache ${family} après son consommateur`);
      keys.push(`${expected.job}|${keyOf(family)}`);
    }
  }

  // check-macos ne cache rien : il ne lance que ci-verdict.sh. macos-app-ios non
  // plus : un DerivedData restauré n'y fait rien gagner (mesuré, S-2).
  for (const [id, run] of [["check-macos", "scripts/ci-verdict.sh"], ["macos-app-ios", "./scripts/check.sh --sections=app-ios"]] as const) {
    const job = workflowJobs(files[CHECK_FILE] ?? "").get(id) ?? "";
    assert.ok(job.includes(run), `${id} : « ${run} » attendu\n${job}`);
    assert.ok(!job.includes("actions/cache") && !job.includes("id: toolchain"), `${id} : cache inattendu\n${job}`);
  }

  // (5) Chaque fichier passé à hashFiles existe : un hashFiles vide figerait la clé.
  const hashed = [...Object.values(files).join("\n").matchAll(/hashFiles\(([^)]*)\)/g)].flatMap((call) =>
    [...(call[1] ?? "").matchAll(/'([^']+)'/g)].map((arg) => arg[1] as string),
  );
  assert.ok(hashed.length > 0, "aucun hashFiles dans les workflows");
  for (const file of hashed) assert.ok(fs.existsSync(path.join(ROOT, file)), `hashFiles('${file}') : fichier absent`);

  // (6) La version de l'hôte : déclarée une seule fois, dans l'`env:` du workflow,
  // et lue par les deux installations (aucune version littérale).
  const check = uncommented(files[CHECK_FILE] ?? "");
  const head = check.split(/^jobs:\s*$/m)[0] ?? "";
  assert.match(head, /^env:\n {2}OMP_HOST_VERSION: "18\.8\.4"\n {2}OMP_HOST_TYPES_NODE: "22"\n/m);
  assert.equal(check.match(/OMP_HOST_VERSION:/g)?.length, 1, "OMP_HOST_VERSION déclaré plusieurs fois");
  assert.equal(check.match(/OMP_HOST_TYPES_NODE:/g)?.length, 1, "OMP_HOST_TYPES_NODE déclaré plusieurs fois");
  assert.equal(check.split("\n").filter((line) => line === INSTALL).length, 2, "les deux installations de l'hôte");
  assert.doesNotMatch(check, /pi-coding-agent@\d/, "version littérale de l'hôte");

  // (7) release-simulation : la cible cargo stable, posée sur l'étape de simulation.
  const simulation = stepsOf(workflowJobs(files[SIMULATION_FILE] ?? "").get("release-simulation") ?? "");
  assert.deepEqual(simulation.at(-1), [
    "      - name: Simuler la release sur une copie jetable",
    "        env:",
    "          CARGO_TARGET_DIR: ${{ runner.temp }}/cargo-target",
    "        run: bash scripts/release-simulation.sh",
  ]);

  // (8) Clés deux à deux distinctes par (job, famille) — `github.job` et
  // `strategy.job-index` séparent les jobs et les entrées de matrice — sans
  // virgule une fois rendues et sous 512 caractères.
  assert.equal(new Set(keys).size, keys.length, keys.join("\n"));
  for (const family of Object.keys(FAMILIES) as Family[]) {
    assert.ok(keyOf(family).startsWith(`${family}-${KEY_HEAD}-`), family);
  }
  for (const entry of keys) {
    const [job, key] = entry.split("|") as [string, string];
    const rendered = renderKey(key, job);
    assert.doesNotMatch(rendered, /,|\$\{\{/, `${job} : clé rendue invalide ${rendered}`);
    assert.ok(rendered.length < 512, `${job} : clé de ${rendered.length} caractères`);
  }
});

const ALLOWED_USES = ["actions/checkout@v4", "actions/setup-node@v4", "oven-sh/setup-bun@v2", "actions/cache@v6"];

test("ci-without-cache/AC-2 : les contextes de statut requis et les jobs restent ceux d'avant, sans relance ni contournement du cache", (t) => {
  for (const file of [CHECK_FILE, SIMULATION_FILE]) {
    const yaml = uncommented(readFile(file));
    // (1) Ni restore-keys, ni sauvegarde forcée, ni échec toléré.
    for (const forbidden of ["restore-keys", "save-always", "lookup-only", "fail-on-cache-miss", "enableCrossOsArchive", "continue-on-error"]) {
      assert.ok(!yaml.includes(forbidden), `${file} : ${forbidden}`);
    }
    assert.doesNotMatch(yaml, /actions\/cache\/(restore|save)/, `${file} : cache découpé`);
    assert.doesNotMatch(yaml, /^\s+cache:/m, `${file} : cache: de setup-node`);
    // (2) Aucun `if:` ne lit cache-hit : les commandes sont toujours rejouées.
    assert.doesNotMatch(yaml, /if:.*cache-hit/, `${file} : if sur cache-hit`);
    assert.ok(!yaml.includes("cache-hit"), `${file} : cache-hit lu`);
    // (3) Seules les actions permises.
    const uses = [...yaml.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1] as string);
    assert.ok(uses.length > 0, file);
    for (const action of uses) assert.ok(ALLOWED_USES.includes(action), `${file} : action non permise ${action}`);
    // (4) Aucune étape de relance.
    for (const [id, job] of workflowJobs(readFile(file))) {
      for (const step of stepsOf(job)) {
        const text = step.join("\n");
        assert.doesNotMatch(text, /retry|rerun/i, `${file} › ${id} : étape de relance\n${text}`);
      }
      // (5) Rien de ce qui doit rester hors cache.
      for (const step of stepsOf(job).filter(isCache)) {
        for (const forbidden of ["omp-host", ".cargo/bin", "registry/src"]) {
          assert.ok(!step.join("\n").includes(forbidden), `${file} › ${id} : ${forbidden} en cache`);
        }
      }
    }
  }

  // Contextes de statut : les identifiants, noms, matrices, needs et if des jobs,
  // la concurrence et l'agrégateur entier sont ceux de `main` avant la feature.
  // `check (ubuntu-latest)` (matrice du premier job), `check (macos-latest)`
  // (`name:` de check-macos) et `release-simulation` (identifiant sans `name:`)
  // en découlent.
  if (DEPTH > 0) {
    t.skip(NESTED);
    return;
  }
  for (const file of [CHECK_FILE, SIMULATION_FILE]) {
    const before = spawnSync("git", ["show", `${BASE}:${file}`], { cwd: ROOT, encoding: "utf8" });
    assert.equal(before.status, 0, `historique ${BASE} indisponible :\n${before.stderr}`);
    const now = workflowJobs(readFile(file));
    const old = workflowJobs(before.stdout);
    assert.deepEqual([...now.keys()], [...old.keys()], `${file} : jobs`);
    for (const [id, job] of now) assert.deepEqual(jobHeader(job), jobHeader(old.get(id) ?? ""), `${file} › ${id} : en-tête`);
    const block = (yaml: string, key: string) =>
      new RegExp(`^${key}:\\s*\\n((?: {2}.*\\n)+)`, "m").exec(uncommented(yaml))?.[1] ?? null;
    for (const key of ["on", "concurrency", "permissions"]) {
      assert.equal(block(readFile(file), key), block(before.stdout, key), `${file} : ${key}`);
    }
  }
  const check = workflowJobs(readFile(CHECK_FILE));
  const oldCheck = workflowJobs(spawnSync("git", ["show", `${BASE}:${CHECK_FILE}`], { cwd: ROOT, encoding: "utf8" }).stdout);
  assert.equal(check.get("check-macos"), oldCheck.get("check-macos"), "agrégateur check-macos modifié");
  assert.match(check.get("check-macos") ?? "", /^ {4}name: check \(macos-latest\)$/m);
  assert.match(check.get("check") ?? "", /^ {8}os: \[ubuntu-latest\]$/m);
  assert.doesNotMatch(readFile(SIMULATION_FILE), /^ {4}name:/m);
});
