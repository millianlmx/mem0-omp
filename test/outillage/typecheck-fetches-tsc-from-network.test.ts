// Tests de la feature typecheck-fetches-tsc-from-network : scripts/typecheck.sh
// lance le TypeScript épinglé installé dans .typecheck/typescript, sans réseau,
// et rougit (sans rien télécharger) quand il manque ou n'a pas la bonne version.
//
// npm et npx sont DOUBLÉS par un dossier `bin/` placé en tête de PATH : chaque
// appel est journalisé, `npx` et toute sous-commande non prévue sortent 97, `npm
// root` délègue au vrai npm (ou imprime FAKE_NPM_ROOT), et `npm install` copie le
// TypeScript préparé dans ROOT au lieu de le télécharger. Les cas rouges
// (absent, autre version) sont plantés dans des COPIES jetables, jamais dans
// l'arbre réel.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { GIT_ENV, emptyGitRepo } from "../support/git.ts";
import { outilEpingleAbsent } from "../support/prerequis.ts";
import { ROOT, childEnv, copyRepo as copyRepoAs, sharedRepo, tmpdir } from "../support/repo.ts";

const TS_DIR = ".typecheck/typescript";
const PREPARE = "bash scripts/typecheck.sh --prepare";
const HOST_TYPES_ABSENT = "types de l'hôte absents";
const TYPES_PASS = "✓ les types de l'hôte encaissent le type-check des 2 plugins et des tests";

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/** Une copie élaguée à un seul fichier de test : la section `types` type-checke tout `test/**`. */
function copyRepo(): string {
  return copyRepoAs("typecheck-tsc-", { keepTest: (rel) => rel === "test/memoire/dedupe.test.ts" });
}

/**
 * Le TypeScript 5.9.3 préparé dans ROOT, source de la doublure `npm install` ; `null`
 * (test sauté par prerequisAbsent, échec nommé sous `check.sh --strict`) dans un
 * clone où `npm run setup` n'a pas encore tourné.
 */
function pinnedSource(t: { skip(message: string): void }): string | null {
  if (outilEpingleAbsent(t, "typescript")) return null;
  return fs.realpathSync(path.join(ROOT, TS_DIR, "node_modules", "typescript"));
}

type Doubles = { env: Record<string, string>; npmLog: string; npxLog: string };

/** Le dossier `bin/` doublant npm et npx, et l'environnement qui le met en tête de PATH. */
function npmDoubles(extra: Record<string, string> = {}): Doubles {
  const dir = tmpdir("typecheck-tsc-doubles-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // Résolu AVANT de modifier PATH : la doublure ne doit pas se rappeler elle-même.
  const realNpm = spawnSync("bash", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim();
  const npmLog = path.join(dir, "npm.log");
  const npxLog = path.join(dir, "npx.log");
  fs.writeFileSync(npmLog, "");
  fs.writeFileSync(npxLog, "");
  fs.writeFileSync(
    path.join(bin, "npm"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_LOG"
case "\${1:-}" in
  root)
    if [ -n "\${FAKE_NPM_ROOT:-}" ]; then printf '%s\\n' "$FAKE_NPM_ROOT"; exit 0; fi
    [ -n ${JSON.stringify(realNpm)} ] || exit 1
    exec ${JSON.stringify(realNpm)} "$@" ;;
  install)
    prefix=""; pinned=0; prev=""
    for arg in "$@"; do
      [ "$prev" = "--prefix" ] && prefix="$arg"
      [ "$arg" = "typescript@5.9.3" ] && pinned=1
      prev="$arg"
    done
    { [ "$pinned" = 1 ] && [ -n "$prefix" ]; } || exit 1
    mkdir -p "$prefix/node_modules" && cp -R "$PINNED_SRC" "$prefix/node_modules/typescript" ;;
  *) exit 97 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "npx"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$NPX_LOG"\nexit 97\n`, {
    mode: 0o755,
  });
  return {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, NPM_LOG: npmLog, NPX_LOG: npxLog, ...extra },
    npmLog,
    npxLog,
  };
}

const lines = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", args, { cwd, encoding: "utf8", env, timeout: 900_000 });
}

/** `bash scripts/check.sh --sections=types` dans `cwd`. */
function runTypesSection(cwd: string, env: NodeJS.ProcessEnv) {
  return run(cwd, ["scripts/check.sh", "--sections=types"], env);
}

/** Remplace le TypeScript de la copie par un 5.8.3 dont le bin/tsc laisse une trace s'il est lancé. */
function plantMisaligned(copy: string): void {
  const pkg = path.join(copy, TS_DIR, "node_modules", "typescript");
  fs.rmSync(path.join(copy, TS_DIR), { recursive: true, force: true });
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "typescript", version: "5.8.3" }));
  fs.writeFileSync(
    path.join(pkg, "bin", "tsc"),
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.TSC_MARKER, "tsc lancé");\n`,
    { mode: 0o755 },
  );
}

test("typecheck-fetches-tsc-from-network/AC-1 : le tsc épinglé type-checke l'arbre sans réseau ni npm exec", (t) => {
  if (pinnedSource(t) === null) return;
  const doubles = npmDoubles({
    npm_config_cache: tmpdir("typecheck-tsc-cache-"),
    npm_config_offline: "true",
  });
  const r = run(ROOT, ["scripts/typecheck.sh"], childEnv(doubles.env));
  const out = output(r);
  if (out.includes(HOST_TYPES_ABSENT)) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.equal(r.status, 0, out);
  assert.ok(out.includes("· tsc : .typecheck/typescript/node_modules/typescript/bin/tsc (TypeScript 5.9.3)"), out);
  assert.ok(!out.includes("error TS"), out);
  const npmCalls = lines(doubles.npmLog);
  assert.deepEqual(
    npmCalls.filter((line) => /^(exec|install)\b/.test(line)),
    [],
    `npm appelé hors de \`npm root\` : ${npmCalls.join(" | ")}`,
  );
  assert.deepEqual(lines(doubles.npxLog), []);
});

test("typecheck-fetches-tsc-from-network/AC-3 : TypeScript absent ⇒ ✗ citant --prepare, rien téléchargé", () => {
  const copy = copyRepo();
  fs.rmSync(path.join(copy, TS_DIR), { recursive: true, force: true });
  const doubles = npmDoubles({
    BUN_INSTALL: tmpdir("typecheck-tsc-bun-"),
    FAKE_NPM_ROOT: tmpdir("typecheck-tsc-npmroot-"),
  });
  const env = childEnv(doubles.env);
  delete env.MEM0_OMP_HOST_TYPES;
  const r = runTypesSection(copy, env);
  const out = output(r);
  assert.notEqual(r.status, 0, out);
  assert.ok(out.includes("✗ TypeScript 5.9.3 absent de .typecheck/typescript"), out);
  assert.ok(out.includes(PREPARE), out);
  assert.ok(!out.includes("✓"), out);
  assert.ok(!out.includes(HOST_TYPES_ABSENT), out);
  assert.deepEqual(lines(doubles.npmLog), []);
  assert.deepEqual(lines(doubles.npxLog), []);
  assert.equal(fs.existsSync(path.join(copy, TS_DIR)), false);
});

test("typecheck-fetches-tsc-from-network/AC-4 : TypeScript d'une autre version ⇒ ✗ attendu/trouvé, tsc non lancé", () => {
  const copy = copyRepo();
  plantMisaligned(copy);
  const marker = path.join(tmpdir("typecheck-tsc-marker-"), "tsc-lance");
  const doubles = npmDoubles({ TSC_MARKER: marker });
  const r = runTypesSection(copy, childEnv(doubles.env));
  const out = output(r);
  assert.notEqual(r.status, 0, out);
  assert.ok(out.includes("✗ TypeScript 5.9.3 attendu, 5.8.3 trouvé dans .typecheck/typescript"), out);
  assert.ok(out.includes(PREPARE), out);
  assert.ok(!out.includes("✓"), out);
  assert.equal(fs.existsSync(marker), false, "bin/tsc a été lancé");
  assert.deepEqual(lines(doubles.npxLog), []);
});

for (const [label, plant] of [
  ["absent", (copy: string) => fs.rmSync(path.join(copy, TS_DIR), { recursive: true, force: true })],
  ["5.8.3", plantMisaligned],
] as const) {
  test(`typecheck-fetches-tsc-from-network/AC-5 : TypeScript ${label} ⇒ la commande citée le réinstalle et la section redevient ✓`, (t) => {
    const pinned = pinnedSource(t);
    if (pinned === null) return;
    const copy = copyRepo();
    plant(copy);
    const marker = path.join(tmpdir("typecheck-tsc-marker-"), "tsc-lance");
    const doubles = npmDoubles({ PINNED_SRC: pinned, TSC_MARKER: marker });
    const env = childEnv(doubles.env);

    const red = runTypesSection(copy, env);
    const redOut = output(red);
    assert.notEqual(red.status, 0, redOut);
    assert.ok(!redOut.includes("✓"), redOut);
    const command = /bash scripts\/typecheck\.sh --prepare/.exec(redOut);
    assert.ok(command, redOut);

    const prepare = run(copy, ["-c", command[0]], env);
    const prepareOut = output(prepare);
    assert.equal(prepare.status, 0, prepareOut);
    assert.ok(prepareOut.includes("✓ TypeScript 5.9.3 installé dans .typecheck/typescript"), prepareOut);
    const installs = lines(doubles.npmLog).filter((line) => line.startsWith("install"));
    assert.equal(installs.length, 1, installs.join(" | "));
    assert.ok(installs[0].includes("--prefix .typecheck/typescript"), installs[0]);
    assert.ok(installs[0].includes("typescript@5.9.3"), installs[0]);

    const green = runTypesSection(copy, env);
    const greenOut = output(green);
    if (greenOut.includes(HOST_TYPES_ABSENT)) {
      t.skip("types de l'hôte absents — type-check non vérifié");
      return;
    }
    assert.equal(green.status, 0, greenOut);
    assert.ok(greenOut.includes(TYPES_PASS), greenOut);
    assert.deepEqual(lines(doubles.npxLog), []);
  });
}

test("typecheck-fetches-tsc-from-network/AC-2 : une erreur de type dans une copie jetable sort ✗ avec sa ligne error TS, par le tsc relié", (t) => {
  const pinned = pinnedSource(t);
  if (pinned === null) return;
  const copy = copyRepo();
  // La copie n'emporte pas .typecheck/ : son TypeScript est le lien vers ROOT.
  assert.ok(fs.lstatSync(path.join(copy, TS_DIR)).isSymbolicLink(), "la copie ne relie pas le TypeScript épinglé");
  assert.equal(fs.realpathSync(path.join(copy, TS_DIR, "node_modules", "typescript")), pinned);
  fs.writeFileSync(path.join(copy, "omp-mem0-req", "typecheck-ac2-faute.ts"), 'export const q: number = "boom";\n');
  const doubles = npmDoubles({ npm_config_cache: tmpdir("typecheck-tsc-cache-"), npm_config_offline: "true" });
  const r = runTypesSection(copy, childEnv(doubles.env));
  const out = output(r);
  if (out.includes(HOST_TYPES_ABSENT)) {
    t.skip("types de l'hôte absents — type-check non vérifié");
    return;
  }
  assert.notEqual(r.status, 0, out);
  assert.ok(out.includes("· tsc : .typecheck/typescript/node_modules/typescript/bin/tsc (TypeScript 5.9.3)"), out);
  assert.ok(out.includes("✗ type-check : "), out);
  assert.match(out, /typecheck-ac2-faute\.ts\(1,14\): error TS2322/);
  assert.ok(!out.includes(TYPES_PASS), out);
  assert.deepEqual(
    lines(doubles.npmLog).filter((line) => /^(exec|install)\b/.test(line)),
    [],
  );
  assert.deepEqual(lines(doubles.npxLog), []);
});

/** sharedRepo().fresh() garde et recrée le lien vers le TypeScript de ROOT sans jamais toucher la cible. */
function sharedRepoKeepsPinnedLink(t: { skip(message: string): void }): void {
  const pinned = pinnedSource(t);
  if (pinned === null) return;
  const shared = sharedRepo("typecheck-tsc-partage-", { keepTest: () => false });
  const copy = shared.fresh();
  const link = path.join(copy, TS_DIR);
  assert.equal(fs.readlinkSync(link), path.join(ROOT, TS_DIR));

  // Un type-check dans la copie pose .typecheck/node_modules vers l'hôte : la
  // remise à neuf ne doit ni le parcourir ni supprimer quoi que ce soit dessous.
  const host = tmpdir("typecheck-tsc-hote-");
  fs.writeFileSync(path.join(host, "intact"), "");
  fs.symlinkSync(host, path.join(copy, ".typecheck", "node_modules"), "dir");
  assert.equal(shared.fresh(), copy);
  assert.equal(fs.readlinkSync(link), path.join(ROOT, TS_DIR));
  assert.ok(fs.existsSync(path.join(host, "intact")));

  // Le lien retiré (`--prepare` dans la copie commence par `rm -rf`) est recréé ;
  // la cible, le TypeScript de ROOT, est intacte.
  fs.rmSync(link, { recursive: true, force: true });
  shared.fresh();
  assert.equal(fs.readlinkSync(link), path.join(ROOT, TS_DIR));
  assert.equal(fs.realpathSync(path.join(link, "node_modules", "typescript")), pinned);
  assert.ok(fs.existsSync(path.join(pinned, "package.json")));
}

/** Le worktree de release-simulation.sh relie le TypeScript de sa source, et rien quand elle n'en a pas. */
function releaseSimulationLinksPinned(): void {
  // Un dépôt minimal : le vrai script, et un moteur doublé qui dit ce que le
  // worktree voit à .typecheck/typescript (le vrai moteur relancerait check.sh).
  const probe = (withTypescript: boolean) => {
    const repo = emptyGitRepo("typecheck-tsc-simu-");
    fs.mkdirSync(path.join(repo, "scripts"));
    fs.copyFileSync(
      path.join(ROOT, "scripts", "release-simulation.sh"),
      path.join(repo, "scripts", "release-simulation.sh"),
    );
    fs.writeFileSync(
      path.join(repo, "scripts", "release.ts"),
      'import * as fs from "node:fs";\n' +
        'const ts = ".typecheck/typescript";\n' +
        'console.log(`ts: ${fs.existsSync(ts) ? fs.realpathSync(ts) : "absent"} lien=${fs.lstatSync(ts, { throwIfNoEntry: false })?.isSymbolicLink() === true}`);\n',
    );
    fs.writeFileSync(path.join(repo, ".gitignore"), ".typecheck/\n");
    spawnSync("git", ["add", "-A"], { cwd: repo, env: GIT_ENV });
    assert.equal(spawnSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo, env: GIT_ENV }).status, 0);
    if (withTypescript) fs.mkdirSync(path.join(repo, TS_DIR), { recursive: true });
    const r = spawnSync("bash", ["scripts/release-simulation.sh"], { cwd: repo, env: GIT_ENV, encoding: "utf8" });
    assert.equal(r.status, 0, output(r));
    return { repo: fs.realpathSync(repo), out: output(r) };
  };

  const linked = probe(true);
  assert.ok(linked.out.includes(`ts: ${path.join(linked.repo, TS_DIR)} lien=true`), linked.out);
  const bare = probe(false);
  assert.ok(bare.out.includes("ts: absent lien=false"), bare.out);
}

/** Les étapes (sans commentaires) du job `job` de `.github/workflows/<file>`, chacune en un bloc de lignes. */
function workflowSteps(file: string, job: string): string[][] {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf8");
  const body = (text.split(/^jobs:\s*$/m)[1] ?? "")
    .split(/^(?= {2}[A-Za-z0-9_-]+:$)/m)
    .find((c) => c.startsWith(`  ${job}:\n`));
  assert.ok(body, `job ${job} introuvable dans ${file}`);
  const steps = (body.split(/^ {4}steps:$/m)[1] ?? "").split(/^(?= {6}- )/m).slice(1);
  return steps.map((step) => step.split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("#")));
}

const TS_STEP = ["      - name: Installer le TypeScript épinglé du type-check", `        run: ${PREPARE}`];

/** La CI installe le TypeScript épinglé, sans condition, avant chaque check.sh qui lance la section types. */
function workflowsPreparePinned(): void {
  const HOST = "      - name: Installer l'hôte OMP (types et SDK)";
  const cases: { file: string; job: string; runs: string; after: "host" | "before-run" }[] = [
    { file: "check.yml", job: "check", runs: "        run: ./scripts/check.sh", after: "host" },
    { file: "check.yml", job: "macos-tests", runs: "        run: ./scripts/check.sh --sections=", after: "host" },
    {
      file: "release.yml",
      job: "release",
      runs: "          node --experimental-strip-types scripts/release.ts \\",
      after: "before-run",
    },
    {
      file: "release-simulation.yml",
      job: "release-simulation",
      runs: "        run: bash scripts/release-simulation.sh",
      after: "before-run",
    },
  ];
  for (const { file, job, runs, after } of cases) {
    const steps = workflowSteps(file, job);
    const where = `${file} › ${job}`;
    const ts = steps.flatMap((step, i) => (step.some((line) => line.includes(PREPARE)) ? [i] : []));
    assert.equal(ts.length, 1, `${where} : une seule étape ${PREPARE} attendue`);
    const at = ts[0] ?? -1;
    // Exactement les deux lignes : ni `if:` (macos-tests 1/2 et 2/2), ni env.
    assert.deepEqual(steps[at], TS_STEP, where);
    const run = steps.findIndex((step) => step.some((line) => line.startsWith(runs)));
    assert.ok(run > at, `${where} : l'étape lançant check.sh doit suivre ${PREPARE}`);
    if (after === "host") assert.equal(steps[at - 1]?.[0], HOST, `${where} : juste après l'étape de l'hôte`);
    else assert.equal(run, at + 1, `${where} : juste avant l'étape lançant check.sh`);
  }
  // Les jobs macOS qui ne lancent pas `types` n'installent rien.
  for (const job of ["macos-app-swift", "macos-app-ios", "check-macos"]) {
    assert.ok(
      !workflowSteps("check.yml", job)
        .flat()
        .some((line) => line.includes(PREPARE)),
      job,
    );
  }
}

// Un seul test porte l'id (invariant criteria/AC-13) : ses trois volets en sous-tests.
test("typecheck-fetches-tsc-from-network/AC-6 : en CI, check.sh type-checke avec le tsc épinglé de .typecheck/ — workflows, copies partagées et worktree de simulation", async (t) => {
  await t.test(
    "la CI installe le TypeScript épinglé, sans condition, avant chaque check.sh qui lance la section types",
    workflowsPreparePinned,
  );
  await t.test(
    "sharedRepo().fresh() garde et recrée le lien vers le TypeScript de ROOT sans jamais toucher la cible",
    sharedRepoKeepsPinnedLink,
  );
  await t.test(
    "le worktree de release-simulation.sh relie le TypeScript de sa source, et rien quand elle n'en a pas",
    releaseSimulationLinksPinned,
  );
});
