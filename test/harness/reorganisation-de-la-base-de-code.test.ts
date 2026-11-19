// Feature reorganisation-de-la-base-de-code : le serveur de pipelines (omp-harness/) est rangé en dossiers de
// domaine. La racine ne garde que ses deux points d'entrée, une carte (DEVELOPPEMENT.md) dit la responsabilité de
// chaque dossier, une table (omp-harness/CORRESPONDANCE.md) renvoie chaque ancien chemin au nouveau, aucun chemin
// cité ne meurt, et les images déployées ne perdent aucun module. Le test ne juge que les fichiers de la
// réorganisation (LAYOUT) : un fichier créé ou découpé plus tard par une autre feature n'a pas à y figurer.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MEMORY_EXTENSION } from "../../omp-harness/runners/runner.ts";
import { ROOT, childEnv, tmpdir } from "../support/repo.ts";

/** Les dossiers de domaine du serveur : dossier → noms de base des fichiers rangés dedans (B-1). */
const LAYOUT: Record<string, string[]> = {
  api: [
    "http.ts",
    "mcp.ts",
    "auth.ts",
    "pairing.ts",
    "input.ts",
    "idempotency.ts",
    "errors.ts",
    "queries.ts",
    "inspect.ts",
    "events.ts",
  ],
  runs: [
    "orchestrator.ts",
    "machine.ts",
    "steps.ts",
    "context.ts",
    "planner.ts",
    "split.ts",
    "prompts.ts",
    "host-tools.ts",
    "decisions.ts",
    "verdict.ts",
    "challenge.ts",
    "merger.ts",
    "ids.ts",
    "safefs.ts",
    "collections.ts",
  ],
  human: ["gestures.ts", "pilot.ts", "card.ts", "card-reader.ts", "briefing.ts", "standing-rules.ts", "proposals.ts"],
  autonomy: ["autonomy-rules.ts", "autonomy-gates.ts", "autonomy-learning.ts"],
  runners: ["runner.ts", "runner-session.ts", "rpc.ts", "scheduler.ts", "proc.ts"],
  sessions: ["session-feed.ts", "session-graph.ts", "tool-view.ts", "local-sessions.ts"],
  heavy: ["heavy.ts", "baseline.ts", "ci-judge.ts", "tap.ts", "test-feed.ts", "test-report.ts", "proofs.ts"],
  forge: ["git.ts", "forge.ts", "forge-github.ts", "forge-gitlab.ts", "issues.ts"],
  config: ["config.ts", "repos.ts", "policy.ts", "providers.ts", "oauth.ts", "local-model.ts", "check.ts"],
  memory: ["oracle.ts", "scope.ts"],
  operations: [
    "logger.ts",
    "metrics.ts",
    "monitor.ts",
    "observability.ts",
    "prometheus.ts",
    "build-info.ts",
    "backup.ts",
  ],
  reports: ["digest.ts", "brief.ts", "stats.ts", "scoreboard.ts", "space-usage.ts"],
  notify: ["notify.ts", "push.ts", "push-alerts.ts"],
  workstation: ["workstation.ts", "workstation-agent.ts", "workstation-guards.ts"],
  intake: ["intake.ts", "intake-create.ts"],
  jobs: ["audits.ts", "dreams.ts", "schedules.ts", "cron.ts"],
  spaces: ["spaces.ts", "isolation.ts"],
  db: ["db.ts"],
};

/** Les points d'entrée lancés par leur chemin : ils restent à la racine du serveur. */
const ENTRY_POINTS = ["cli.ts", "main.ts"];
/** Les dossiers qui existaient avant la réorganisation, gardés tels quels. */
const EXISTING = ["atlassian", "browser", "corporate", "db", "vigie"];
/** Les trois fichiers que des sous-features découpent ensuite : ils dépassent encore 2000 lignes. */
const TO_SPLIT = ["api/http.ts", "runs/orchestrator.ts", "workstation/workstation.ts"];

const SERVER = path.join(ROOT, "omp-harness");
const OLD_NAMES = [...ENTRY_POINTS, ...Object.values(LAYOUT).flat()];

/** Un chemin du système en chemin à `/`. */
const posix = (file: string): string => file.split(path.sep).join("/");

/** Le dossier (relatif à omp-harness/) que la réorganisation donne à un nom de base ; "" à la racine. */
function homeOf(name: string): string | null {
  if (ENTRY_POINTS.includes(name)) return "";
  for (const [dir, names] of Object.entries(LAYOUT)) if (names.includes(name)) return dir;
  return null;
}

/** Les `.ts` du serveur, hors deploy/, en chemins relatifs à omp-harness/. */
function serverTs(): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(SERVER, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const rel = posix(path.relative(SERVER, path.join(entry.parentPath, entry.name)));
    if (!rel.startsWith("deploy/")) found.push(rel);
  }
  return found.sort();
}

/** Les sous-dossiers directs du serveur qui contiennent un `.ts` à un niveau quelconque, deploy/ exclu. */
function serverDirs(): string[] {
  const dirs = new Set<string>();
  for (const file of serverTs()) if (file.includes("/")) dirs.add(file.split("/")[0] ?? "");
  return [...dirs].sort();
}

type Row = { old: string; new: string; role: string };

/** Les lignes du tableau de CORRESPONDANCE.md : ancien chemin, nouveau chemin, responsabilité. */
function table(): Row[] {
  const file = path.join(SERVER, "CORRESPONDANCE.md");
  assert.ok(fs.existsSync(file), "omp-harness/CORRESPONDANCE.md absent");
  const rows: Row[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*$/.exec(line);
    if (match) rows.push({ old: match[1] ?? "", new: match[2] ?? "", role: match[3] ?? "" });
  }
  assert.ok(rows.length > 0, "CORRESPONDANCE.md n'a aucune ligne de table");
  return rows;
}

/** Le corps de la section « Le serveur, dossier par dossier » de DEVELOPPEMENT.md, avec les numéros de ligne. */
function mapLines(): { line: number; text: string }[] {
  const lines = fs.readFileSync(path.join(ROOT, "DEVELOPPEMENT.md"), "utf8").split("\n");
  const start = lines.indexOf("### Le serveur, dossier par dossier");
  assert.ok(start >= 0, "carte absente de DEVELOPPEMENT.md");
  const body: { line: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length && !/^#{2,3} /.test(lines[i] ?? ""); i++)
    body.push({ line: i + 1, text: lines[i] ?? "" });
  return body;
}

test("reorganisation-de-la-base-de-code/AC-1 : la racine du serveur ne garde que ses deux points d'entrée, chaque fichier est dans son dossier de domaine, et la table le dit", () => {
  const all = serverTs();
  const atRoot = all.filter((file) => !file.includes("/"));
  assert.deepEqual(atRoot, ENTRY_POINTS, "les .ts à la racine de omp-harness/");

  const expected = [...new Set([...Object.keys(LAYOUT), ...EXISTING])].sort();
  assert.deepEqual(serverDirs(), expected, "les dossiers de omp-harness/ qui contiennent du .ts");

  for (const [dir, names] of Object.entries(LAYOUT))
    for (const name of names) assert.ok(all.includes(`${dir}/${name}`), `omp-harness/${dir}/${name} absent`);

  const rows = table();
  for (const row of rows) {
    const home = homeOf(row.old);
    if (home === null) continue;
    const dir = path.posix.dirname(row.new);
    const placed = dir === "." ? "" : dir;
    assert.equal(placed, home, `${row.old} → ${row.new} : rangé hors de son dossier (${home || "racine"})`);
  }
  for (const old of new Set(rows.map((row) => row.old))) {
    const same = rows.filter((row) => row.old === old && path.posix.basename(row.new) === old);
    assert.equal(same.length, 1, `${old} : une seule cible doit garder le nom de base (${same.length})`);
  }
});

test("reorganisation-de-la-base-de-code/AC-2 : la carte des dossiers de DEVELOPPEMENT.md et les dossiers du serveur qui contiennent du .ts sont les mêmes, chacun avec sa phrase", () => {
  const entries = new Map<string, string>();
  for (const { text } of mapLines()) {
    const match = /^\|\s*`([\w-]+)\/`\s*\|\s*(.*?)\s*\|\s*$/.exec(text);
    if (match) entries.set(match[1] ?? "", match[2] ?? "");
  }
  const dirs = serverDirs();
  for (const dir of dirs) assert.ok(entries.has(dir), `${dir}/ sans entrée dans la carte`);
  for (const dir of entries.keys()) assert.ok(dirs.includes(dir), `${dir}/ dans la carte mais sans .ts`);
  for (const [dir, sentence] of entries)
    assert.ok(sentence !== "" && !/^[-–—]+$/.test(sentence), `${dir}/ : phrase de responsabilité vide`);
});

/** Les options de node des installations : `--experimental-strip-types`, sans build. */
const NODE_FLAGS = ["--experimental-strip-types", "--no-warnings"];

test("reorganisation-de-la-base-de-code/AC-6 : `main.ts --check` rend 0 ou 1 sans module introuvable, le serveur répond 200 sur /v1/health avec sa version et s'arrête sur SIGTERM, `cli.ts` sans argument rend son usage", async () => {
  assert.ok(fs.existsSync(MEMORY_EXTENSION), `MEMORY_EXTENSION n'existe pas : ${MEMORY_EXTENSION}`);
  const main = path.join("omp-harness", "main.ts");
  const missing = /ERR_MODULE_NOT_FOUND|Cannot find module/;

  // (1) --check : 0 ou 1 selon l'environnement, jamais un import mort.
  const checkDir = tmpdir("reorganisation-check-");
  const checkConfig = path.join(checkDir, "config.json");
  fs.writeFileSync(checkConfig, JSON.stringify({ dataDir: checkDir, repos: [] }));
  const check = spawnSync(process.execPath, [...NODE_FLAGS, main, "--config", checkConfig, "--check"], {
    cwd: ROOT,
    env: childEnv(),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.doesNotMatch(check.stderr, missing, `--check : module introuvable\n${check.stderr}`);
  assert.ok(check.status === 0 || check.status === 1, `--check : code ${check.status}\n${check.stderr}`);
  const lines = check.stdout.split("\n").filter((line) => line.trim() !== "");
  assert.ok(lines.length > 0, `--check n'a rien imprimé\n${check.stderr}`);
  for (const line of lines) assert.ok(/^(✓ |! |✗ | {4}→ )/.test(line), `--check : ligne inattendue « ${line} »`);

  // (2) le serveur lui-même : à l'écoute, en bonne santé, arrêté par SIGTERM.
  const dir = tmpdir("reorganisation-serveur-");
  const config = path.join(dir, "config.json");
  const listen = { host: "127.0.0.1", port: 0 };
  fs.writeFileSync(config, JSON.stringify({ dataDir: dir, repos: [], listen, health: { minFreeMiB: 0 } }));
  const child = spawn(process.execPath, [...NODE_FLAGS, main, "--config", config], {
    cwd: ROOT,
    env: childEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  const exit = Promise.withResolvers<number | null>();
  child.once("exit", (code) => exit.resolve(code));
  const exited = exit.promise;
  const ready = Promise.withResolvers<number>();
  // Un vrai serveur démarre en un temps que rien ne rend déterministe : seule la borne de l'attente est un minuteur.
  const timer = setTimeout(() => ready.reject(new Error(`le serveur n'écoute pas après 30 s\n${stderr}`)), 30_000);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    const match = /à l'écoute sur 127\.0\.0\.1:(\d+)/.exec(stderr);
    if (!match) return;
    clearTimeout(timer);
    ready.resolve(Number(match[1]));
  });
  void exited.then((code) => {
    clearTimeout(timer);
    ready.reject(new Error(`le serveur s'est arrêté (code ${code}) avant d'écouter\n${stderr}`));
  });
  const listening = ready.promise;
  try {
    const port = await listening;
    assert.doesNotMatch(stderr, missing, `le serveur : module introuvable\n${stderr}`);
    const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(health.status, 200);
    const pkg: { version: string } = JSON.parse(fs.readFileSync(path.join(SERVER, "package.json"), "utf8"));
    const body = (await health.json()) as { version?: string }; // le corps de /v1/health, lu pour sa seule version
    assert.equal(body.version, pkg.version);
    child.kill("SIGTERM");
    assert.equal(await exited, 0, `arrêt propre sur SIGTERM\n${stderr}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  // (3) la CLI de script sans argument : son usage, code 2.
  const cli = spawnSync(process.execPath, [...NODE_FLAGS, path.join("omp-harness", "cli.ts")], {
    cwd: ROOT,
    env: childEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(cli.status, 2, cli.stderr);
  assert.match(cli.stderr, /commande attendue/);
  assert.match(cli.stderr, /usage : cli\.ts/);
});

test("reorganisation-de-la-base-de-code/AC-7 : chaque nom, chemin et chemin lancé que cite omp-harness/deploy/ existe encore, et `repoName` est déclaré dans config/repos.ts", () => {
  // Un nom seul est juste si un `.ts` du serveur le porte, ceux de deploy/ compris (moli-gate.ts).
  const everyTs = fs.readdirSync(SERVER, { recursive: true, withFileTypes: true });
  const known = new Set(everyTs.filter((entry) => entry.name.endsWith(".ts")).map((entry) => entry.name));
  for (const entry of fs.readdirSync(path.join(SERVER, "deploy"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const buffer = fs.readFileSync(file);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    const text = buffer.toString("utf8");
    const label = posix(path.relative(ROOT, file));
    for (const match of text.matchAll(/(?<![\w/.*-])([\w-]+\.ts)\b/g))
      assert.ok(known.has(match[1] ?? ""), `${label} cite ${match[1]}, qu'aucun .ts du serveur ne porte`);
    for (const match of text.matchAll(/(?<![\w/.*:$}-])(\w[\w-]*\/(?:[\w-]+\/)*[\w-]+\.ts)\b/g)) {
      const rel = match[1] ?? "";
      const exists = fs.existsSync(path.join(SERVER, rel)) || fs.existsSync(path.join(ROOT, rel));
      assert.ok(exists, `${label} cite le chemin ${rel}, qui n'existe pas`);
    }
    for (const match of text.matchAll(/(?:\/opt\/omp-harness|\$\{src\})\/((?:[\w-]+\/)*[\w-]+\.ts)/g))
      assert.ok(fs.existsSync(path.join(ROOT, match[1] ?? "")), `${label} lance ${match[1]}, qui n'existe pas`);
  }
  assert.match(fs.readFileSync(path.join(SERVER, "config", "repos.ts"), "utf8"), /export function repoName\(/);
});

test("reorganisation-de-la-base-de-code/AC-8 : la table de correspondance a une ligne par fichier de la réorganisation, vers un chemin qui existe", () => {
  const rows = table();
  const olds = [...new Set(rows.map((row) => row.old))].sort();
  assert.deepEqual(olds, [...OLD_NAMES].sort(), "les anciens chemins de la table et les fichiers de la réorganisation");
  for (const row of rows)
    assert.ok(fs.existsSync(path.join(SERVER, row.new)), `${row.old} → ${row.new} : le nouveau chemin n'existe pas`);
  for (const [dir, names] of Object.entries(LAYOUT)) {
    for (const name of names) {
      const target = `${dir}/${name}`;
      const listed = rows.some((row) => row.old === name && row.new === target);
      assert.ok(listed, `${target} n'est le nouveau chemin d'aucune ligne dont l'ancien chemin est ${name}`);
    }
  }
  for (const name of ENTRY_POINTS)
    assert.ok(
      rows.some((row) => row.old === name && row.new === name),
      `${name} reste à la racine : une ligne ${name} → ${name} manque`,
    );
  for (const old of olds) {
    const own = rows.filter((row) => row.old === old);
    if (own.length === 1) {
      assert.equal(path.posix.basename(own[0]?.new ?? ""), old, `${old} → ${own[0]?.new} : le nom de base change`);
      continue;
    }
    for (const row of own) assert.notEqual(row.role, "", `${old} → ${row.new} : un morceau sans responsabilité`);
  }
});

test("reorganisation-de-la-base-de-code/AC-9 : aucun chemin omp-harness/…/x.ts cité dans un fichier suivi ne meurt, et chaque ancien nom de fichier est encore le nom d'un .ts du serveur", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr.toString());
  const files = listed.stdout.toString("utf8").split("\0");
  const oldNames = new Set(OLD_NAMES);
  const dead: string[] = [];
  for (const file of files) {
    if (file === "" || file === "CHANGELOG.md" || file === "omp-harness/CORRESPONDANCE.md") continue;
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    const buffer = fs.readFileSync(absolute);
    if (buffer.subarray(0, 8000).includes(0)) continue;
    // Dans un test, le reste est de la donnée figée (chemins fictifs, emplacements de pile) : seuls les commentaires comptent.
    const commentsOnly = file.startsWith("test/");
    const lines = buffer.toString("utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const head = line.trimStart();
      if (commentsOnly && !head.startsWith("//") && !head.startsWith("/*") && !head.startsWith("*")) continue;
      for (const match of line.matchAll(/(?<![\w.-])omp-harness\/((?:[\w-]+\/)*[\w-]+\.ts)/g)) {
        let cited = match[1] ?? "";
        while (cited.startsWith("omp-harness/")) cited = cited.slice("omp-harness/".length);
        if (!oldNames.has(path.posix.basename(cited)) || fs.existsSync(path.join(SERVER, cited))) continue;
        dead.push(`${file}:${index + 1} → ${match[0]}`);
      }
    }
  }
  assert.deepEqual(dead, [], `chemins morts :\n${dead.join("\n")}`);

  const basenames = new Set(serverTs().map((file) => path.posix.basename(file)));
  for (const name of OLD_NAMES) assert.ok(basenames.has(name), `${name} : aucun .ts du serveur ne porte plus ce nom`);
});

test("reorganisation-de-la-base-de-code/AC-10 : les plafonds de types des fichiers du serveur suivent leur déplacement, sans hausse", () => {
  const file = path.join(ROOT, "scripts", "types-ratchet-baseline.json");
  const baseline: { files: Record<string, number> } = JSON.parse(fs.readFileSync(file, "utf8"));
  // Les plafonds de la base, sous leur nouveau chemin : un plafond ne peut que baisser.
  const ceilings: Record<string, number> = {
    "omp-harness/heavy/heavy.ts": 2,
    "omp-harness/heavy/tap.ts": 3,
    "omp-harness/memory/oracle.ts": 1,
    "omp-harness/runs/verdict.ts": 4,
  };
  for (const [key, ceiling] of Object.entries(baseline.files)) {
    if (!key.startsWith("omp-harness/")) continue;
    const base = ceilings[key];
    assert.ok(fs.existsSync(path.join(ROOT, key)), `${key} : fichier disparu`);
    assert.ok(base !== undefined, `${key} : plafond que la base n'avait pas, ou ancien chemin de la racine`);
    assert.ok(ceiling <= (base ?? 0), `${key} : plafond relevé à ${ceiling} (base ${base})`);
  }
});

/** Les modules relatifs qu'un fichier charge à l'exécution : `import type` et `export type … from` sont effacés. */
function runtimeImports(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:import|export)(\s[^"';]*?)from\s+"(\.[^"]+)"/g))
    if (!/^\s*type\s/.test(match[1] ?? "")) specifiers.push(match[2] ?? "");
  for (const match of source.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g)) specifiers.push(match[1] ?? "");
  return specifiers.map((specifier) => {
    const target = path.resolve(path.dirname(file), specifier);
    assert.ok(fs.existsSync(target), `${posix(path.relative(ROOT, file))} importe ${specifier}, qui n'existe pas`);
    return target;
  });
}

/** Les fichiers atteints depuis `entry` par les seuls imports chargés à l'exécution, entrée comprise. */
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dep of runtimeImports(file)) visit(dep);
  };
  visit(entry);
  return [...seen];
}

/** Les cibles `new URL("<rel>", import.meta.url)` à extension d'un fichier, en `fichier → cible` relatifs à ROOT. */
function urlTargets(file: string): string[] {
  const found: string[] = [];
  for (const match of fs.readFileSync(file, "utf8").matchAll(/new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url/g)) {
    const rel = match[1] ?? "";
    if (!/\.\w+$/.test(rel)) continue;
    const target = path.relative(ROOT, path.resolve(path.dirname(file), rel));
    found.push(`${posix(path.relative(ROOT, file))} → ${posix(target)}`);
  }
  return found;
}

type Image = {
  dockerfile: string;
  entry: string;
  /** Les chemins que l'image ouvre à l'exécution : ils doivent exister et être sous un dossier copié. */
  reads: string[];
  /** Les chemins calculés que l'image n'ouvre jamais : ils doivent seulement exister. */
  notRead: string[];
};

const IMAGES: Image[] = [
  {
    dockerfile: "Dockerfile.harness",
    entry: "omp-harness/main.ts",
    reads: [
      "omp-harness/api/http-io.ts → omp-harness/package.json",
      "omp-harness/runners/runner.ts → omp-mem0-memory/extension.ts",
    ],
    notRead: [],
  },
  {
    dockerfile: "Dockerfile.vigie",
    entry: "omp-harness/vigie/main.ts",
    reads: ["omp-harness/vigie/main.ts → omp-harness/package.json"],
    notRead: ["omp-harness/runners/runner.ts → omp-mem0-memory/extension.ts"],
  },
];

test("reorganisation-de-la-base-de-code/AC-12 : chaque fichier que main.ts et vigie/main.ts chargent est sous un dossier que le Dockerfile de leur image copie, et leurs chemins lus par new URL existent", () => {
  for (const image of IMAGES) {
    const dockerfile = fs.readFileSync(path.join(SERVER, "deploy", "container", image.dockerfile), "utf8");
    const copies = dockerfile.matchAll(/^COPY\s+(?!--)(\S+)\s+(\/opt\/omp-harness\/\S*)/gm);
    const copied = [...copies].map((match) => match[1] ?? "");
    const under = (rel: string) => copied.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
    assert.ok(copied.includes("omp-harness"), `${image.dockerfile} ne copie pas omp-harness`);

    const files = closure(path.join(ROOT, image.entry));
    for (const file of files) {
      const rel = posix(path.relative(ROOT, file));
      assert.ok(under(rel), `${rel} n'est sous aucun dossier copié par ${image.dockerfile}`);
    }

    const opened = files.flatMap((file) => urlTargets(file));
    const declared = [...image.reads, ...image.notRead];
    for (const pair of opened)
      assert.ok(declared.includes(pair), `new URL non déclaré pour ${image.dockerfile} : ${pair}`);
    for (const pair of declared) {
      const [from = "", to = ""] = pair.split(" → ");
      const where = `${pair} (${image.dockerfile})`;
      assert.ok(files.includes(path.join(ROOT, from)), `${where} : le fichier n'est pas dans la clôture`);
      assert.ok(opened.includes(pair), `${where} : ce new URL n'est plus dans le fichier`);
      assert.ok(fs.existsSync(path.join(ROOT, to)), `${where} : la cible n'existe pas`);
      if (image.reads.includes(pair)) assert.ok(under(to), `${where} : la cible n'est sous aucun dossier copié`);
    }
  }
});

test("reorganisation-de-la-base-de-code/AC-16 : aucun .ts du serveur ne dépasse 2000 lignes, hors les trois fichiers que des sous-features découpent", () => {
  for (const file of serverTs()) {
    if (TO_SPLIT.includes(file)) continue;
    const lines = fs.readFileSync(path.join(SERVER, file), "utf8").split("\n").length;
    assert.ok(lines <= 2000, `omp-harness/${file} : ${lines} lignes (> 2000)`);
  }
});

test("reorganisation-de-la-base-de-code/AC-17 : ni la carte des dossiers ni la table de correspondance ne nomment l'ancien projet de mémoire", () => {
  const named = /mem0/i;
  const bad: string[] = [];
  for (const { line, text } of mapLines()) if (named.test(text)) bad.push(`DEVELOPPEMENT.md:${line} nomme mem0`);
  const corr = "omp-harness/CORRESPONDANCE.md";
  assert.ok(fs.existsSync(path.join(ROOT, corr)), `${corr} absent`);
  const lines = fs.readFileSync(path.join(ROOT, corr), "utf8").split("\n");
  for (const [index, text] of lines.entries()) if (named.test(text)) bad.push(`${corr}:${index + 1} nomme mem0`);
  assert.deepEqual(bad, []);
});
