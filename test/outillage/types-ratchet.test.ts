// Tests du plafond d'erreurs TypeScript par fichier : scripts/types-ratchet.ts, sa baseline
// (scripts/types-ratchet-baseline.json) et la section `plafond-types` de scripts/check.sh.
//
// Le verdict (comparaison, `--write`, saut) est éprouvé sur un arbre jetable dont `scripts/typecheck.sh` est une
// doublure qui rend une sortie de tsc fixée : aucun test n'attend de tsc pour la logique. Deux tests lancent le VRAI
// tsc épinglé — un mini-projet pour la forme réelle des erreurs et la livraison de l'option, puis l'arbre livré —,
// et se sautent en le disant (outilEpingleAbsent, prérequis) quand il manque.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { outilEpingleAbsent, prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, sharedRepo, tmpdir } from "../support/repo.ts";

const OPTION = "noUncheckedIndexedAccess";
const BASELINE = "scripts/types-ratchet-baseline.json";
const TS_VERSION = /^TS_VERSION=(\S+)$/m.exec(fs.readFileSync(path.join(ROOT, "scripts", "typecheck.sh"), "utf8"))![1]!;
const RUN = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/types-ratchet.ts"];

const output = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/** Une erreur tsc, dans la forme que le compilateur imprime. */
const err = (file: string, line: number, code = "TS2532") =>
  `${file}(${line},5): error ${code}: Object is possibly 'undefined'.`;

type Fake = {
  /** La sortie et le code de sortie que rend la doublure de typecheck.sh. */
  tsc: string;
  status?: number;
  /** La baseline posée (absente si `null`). */
  baseline: object | string | null;
  /** Un TypeScript épinglé « installé » (par défaut oui). */
  installed?: boolean;
};

/** Un arbre jetable : le vrai script, une doublure de typecheck.sh, une baseline. Rend le dossier et le journal des appels. */
function fakeTree(fake: Fake): { dir: string; log: string } {
  const dir = tmpdir("plafond-");
  const log = path.join(tmpdir("plafond-journal-"), "options.txt");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "types-ratchet.ts"), path.join(dir, "scripts", "types-ratchet.ts"));
  fs.writeFileSync(path.join(dir, "canned.txt"), fake.tsc);
  fs.writeFileSync(
    path.join(dir, "scripts", "typecheck.sh"),
    [
      "#!/usr/bin/env bash",
      "TS_VERSION=9.9.9",
      `echo "\${MEM0_OMP_TSC_ARGS:-}" >> "${log}"`,
      'cat "$(dirname "$0")/../canned.txt"',
      `exit ${fake.status ?? 0}`,
      "",
    ].join("\n"),
  );
  if (fake.installed !== false) {
    const pkg = path.join(dir, ".typecheck", "typescript", "node_modules", "typescript");
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "9.9.9" }));
  }
  if (fake.baseline !== null) {
    const body = typeof fake.baseline === "string" ? fake.baseline : JSON.stringify(fake.baseline);
    fs.writeFileSync(path.join(dir, BASELINE), body);
  }
  return { dir, log };
}

const run = (dir: string, ...args: string[]) =>
  spawnSync("node", [...RUN, ...args], { cwd: dir, encoding: "utf8", timeout: 120_000 });

/** L'arbre jetable à plat (chemin → contenu), hors le journal qui vit dehors. */
function snapshotOf(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(dir, file)] = fs.readFileSync(file, "utf8");
  }
  return files;
}

const baselineOf = (counts: Record<string, number>) => ({ option: OPTION, files: counts });

test("types-ratchet/AC-1 : un arbre à son plafond passe, l'option stricte est bien transmise, et rien n'est écrit sans --write", () => {
  const { dir, log } = fakeTree({
    // La même erreur vue par deux programmes tsc (src/ est dans tsconfig.json ET importée par les tests) compte une fois.
    tsc: [
      err("omp-harness/a.ts", 3),
      err("omp-harness/a.ts", 3),
      err("omp-harness/a.ts", 9),
      err("test/b.test.ts", 1),
      "",
    ].join("\n"),
    status: 2,
    baseline: baselineOf({ "omp-harness/a.ts": 2, "test/b.test.ts": 1 }),
  });
  const before = snapshotOf(dir);
  const r = run(dir);
  assert.equal(r.status, 0, output(r));
  assert.match(
    r.stdout,
    /^ {2}✓ plafond noUncheckedIndexedAccess tenu : 3 erreur\(s\) pour un plafond de 3$/m,
    output(r),
  );
  assert.doesNotMatch(r.stdout, /--write/, "rien à resserrer");
  assert.deepEqual(snapshotOf(dir), before, "aucune écriture dans l'arbre");
  assert.equal(
    fs.readFileSync(log, "utf8"),
    `--${OPTION}\n`,
    "scripts/typecheck.sh reçoit l'option par MEM0_OMP_TSC_ARGS",
  );
});

test("types-ratchet/AC-2 : une erreur en plus dans un fichier, ou dans un fichier neuf, échoue (code 1) en nommant le fichier et les comptes", () => {
  const baseline = baselineOf({ "omp-harness/a.ts": 1 });
  const more = fakeTree({ tsc: `${err("omp-harness/a.ts", 3)}\n${err("omp-harness/a.ts", 4)}\n`, baseline });
  const r = run(more.dir);
  assert.equal(r.status, 1, output(r));
  assert.match(
    r.stdout,
    /^ {2}✗ omp-harness\/a\.ts : 2 erreur\(s\) noUncheckedIndexedAccess pour un plafond de 1$/m,
    output(r),
  );
  assert.match(r.stdout, /omp-harness\/a\.ts\(4,5\): error TS2532/, "l'erreur elle-même est montrée");
  assert.doesNotMatch(r.stdout, /✓/, output(r));

  const fresh = fakeTree({ tsc: `${err("omp-harness/a.ts", 3)}\n${err("omp-mem0-req/neuf.ts", 8)}\n`, baseline });
  const n = run(fresh.dir);
  assert.equal(n.status, 1, output(n));
  assert.match(
    n.stdout,
    /^ {2}✗ omp-mem0-req\/neuf\.ts : 1 erreur\(s\) noUncheckedIndexedAccess pour un plafond de 0$/m,
    output(n),
  );
  assert.doesNotMatch(n.stdout, /^ {2}✗ omp-harness\/a\.ts/m, "le fichier à son plafond n'est pas accusé");
});

test("types-ratchet/AC-3 : une baisse passe (code 0) et invite à --write, sans réécrire la baseline", () => {
  const { dir } = fakeTree({
    tsc: `${err("omp-harness/a.ts", 3)}\n`,
    baseline: baselineOf({ "omp-harness/a.ts": 3, "test/disparu.test.ts": 2 }),
  });
  const before = snapshotOf(dir);
  const r = run(dir);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /2 fichier\(s\) sous leur plafond/, output(r));
  assert.match(r.stdout, /omp-harness\/a\.ts 3 → 1/, output(r));
  assert.match(r.stdout, /test\/disparu\.test\.ts 2 → 0/, output(r));
  assert.match(r.stdout, /relance avec --write/, output(r));
  assert.deepEqual(snapshotOf(dir), before, "la baseline reste telle quelle");
});

test("types-ratchet/AC-4 : --write réécrit la baseline (clés triées, fichiers propres retirés), un plafond relevé est signalé", () => {
  const { dir } = fakeTree({
    tsc: [
      err("test/z.test.ts", 1),
      err("omp-harness/a.ts", 3),
      err("omp-harness/a.ts", 4),
      err("omp-harness/a.ts", 5),
      "",
    ].join("\n"),
    status: 2,
    baseline: baselineOf({ "omp-harness/a.ts": 2, "test/vieux.test.ts": 4 }),
  });
  const r = run(dir, "--write");
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /plafond RELEVÉ : omp-harness\/a\.ts 2 → 3/, output(r));
  assert.match(r.stdout, /réécrit : 4 erreur\(s\) noUncheckedIndexedAccess dans 2 fichier\(s\)/, output(r));
  const written = fs.readFileSync(path.join(dir, BASELINE), "utf8");
  assert.deepEqual(JSON.parse(written), baselineOf({ "omp-harness/a.ts": 3, "test/z.test.ts": 1 }));
  assert.deepEqual(Object.keys(JSON.parse(written).files), ["omp-harness/a.ts", "test/z.test.ts"]);
  assert.ok(written.endsWith("}\n"), "newline final");
  // Et le rejeu simple est vert : la baseline écrite est ce que le script relit.
  assert.equal(run(dir).status, 0);
});

test("types-ratchet/AC-5 : tsc ou les types de l'hôte absents → « plafond non vérifié » sans ✓ (code 0) ; --write refuse d'écrire", () => {
  const baseline = baselineOf({ "omp-harness/a.ts": 1 });
  const cases: Array<[string, Fake]> = [
    ["TypeScript épinglé absent", { tsc: "", baseline, installed: false }],
    ["types de l'hôte absents", { tsc: "  · types de l'hôte absents — type-check non vérifié\n", baseline }],
  ];
  for (const [label, fake] of cases) {
    const { dir } = fakeTree(fake);
    const before = snapshotOf(dir);
    const r = run(dir);
    assert.equal(r.status, 0, `${label} : ${output(r)}`);
    assert.match(r.stdout, /^ {2}· .*plafond non vérifié$/m, `${label} : ${output(r)}`);
    assert.doesNotMatch(r.stdout, /✓|✗/, label);

    const w = run(dir, "--write");
    assert.equal(w.status, 1, `${label} : ${output(w)}`);
    assert.deepEqual(snapshotOf(dir), before, `${label} : --write n'écrit rien`);
  }

  // Une autre version que celle de typecheck.sh : même saut, en nommant les deux versions.
  const { dir } = fakeTree({ tsc: "", baseline });
  const pkg = path.join(dir, ".typecheck", "typescript", "node_modules", "typescript", "package.json");
  fs.writeFileSync(pkg, JSON.stringify({ version: "1.0.0" }));
  const r = run(dir);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /TypeScript 9\.9\.9 attendu, 1\.0\.0 trouvé/, output(r));
});

test("types-ratchet/AC-6 : baseline absente, invalide ou mesurée pour une autre option, et tsc en panne, échouent (code 1)", () => {
  const ok = `${err("omp-harness/a.ts", 3)}\n`;
  const bad: Array<[string, Fake, RegExp]> = [
    ["baseline absente", { tsc: ok, baseline: null }, /baseline illisible/],
    ["JSON invalide", { tsc: ok, baseline: "{ pas du json" }, /baseline illisible/],
    [
      "forme invalide",
      { tsc: ok, baseline: { option: OPTION, files: { "omp-harness/a.ts": 0 } } },
      /doit porter un entier > 0/,
    ],
    [
      "autre option",
      { tsc: ok, baseline: { option: "exactOptionalPropertyTypes", files: {} } },
      /exactOptionalPropertyTypes.*réécris-la avec --write/,
    ],
    [
      "tsc en panne",
      { tsc: "tsc: option inconnue\n", status: 1, baseline: baselineOf({}) },
      /sans erreur TypeScript exploitable/,
    ],
  ];
  for (const [label, fake, expected] of bad) {
    const r = run(fakeTree(fake).dir);
    assert.equal(r.status, 1, `${label} : ${output(r)}`);
    assert.match(r.stdout, expected, `${label} : ${output(r)}`);
    assert.doesNotMatch(r.stdout, /✓/, label);
  }

  const unknown = run(fakeTree({ tsc: "", baseline: baselineOf({}) }).dir, "--zzz");
  assert.equal(unknown.status, 2, output(unknown));
});

test("types-ratchet/AC-7 : une erreur dans un fichier hors du dépôt (types de l'hôte, cache) n'est jamais comptée", () => {
  const { dir } = fakeTree({
    tsc: [
      err("../../.cache/mem0-omp/hote/node_modules/@oh-my-pi/x.d.ts", 1),
      err("/Users/quelquun/hote/y.d.ts", 2),
      err("omp-harness/a.ts", 3),
      "",
    ].join("\n"),
    status: 2,
    baseline: baselineOf({ "omp-harness/a.ts": 1 }),
  });
  const r = run(dir);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /tenu : 1 erreur\(s\) pour un plafond de 1/, output(r));
});

test("types-ratchet/AC-8 : avec le vrai tsc, l'option stricte fait apparaître l'erreur d'un accès indexé non gardé, et seulement elle", (t) => {
  if (outilEpingleAbsent(t, "typescript")) return;
  const dir = tmpdir("plafond-tsc-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.copyFileSync(path.join(ROOT, "scripts", "types-ratchet.ts"), path.join(dir, "scripts", "types-ratchet.ts"));
  // typecheck.sh de ce mini-projet : le tsc épinglé, un seul programme, les options de MEM0_OMP_TSC_ARGS.
  const tsc = path.join(ROOT, ".typecheck", "typescript", "node_modules", "typescript", "bin", "tsc");
  fs.writeFileSync(
    path.join(dir, "scripts", "typecheck.sh"),
    `#!/usr/bin/env bash\nTS_VERSION=${TS_VERSION}\nnode "${tsc}" -p tsconfig.json \${MEM0_OMP_TSC_ARGS:-}\n`,
  );
  fs.mkdirSync(path.join(dir, ".typecheck"));
  fs.symlinkSync(path.join(ROOT, ".typecheck", "typescript"), path.join(dir, ".typecheck", "typescript"), "dir");
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, lib: ["ES2023"], types: [] },
      include: ["src/**/*.ts"],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "src", "a.ts"),
    "const t: number[] = [1];\nexport const x: number = t[0];\nexport const y: number = t[1];\n",
  );
  fs.writeFileSync(
    path.join(dir, "src", "propre.ts"),
    "const t: number[] = [1];\nexport const x: number | undefined = t[0];\n",
  );
  fs.writeFileSync(path.join(dir, BASELINE), JSON.stringify(baselineOf({})));

  const sansOption = spawnSync("bash", ["scripts/typecheck.sh"], { cwd: dir, encoding: "utf8" });
  assert.equal(sansOption.status, 0, `sans l'option le projet est propre : ${output(sansOption)}`);

  const red = run(dir);
  assert.equal(red.status, 1, output(red));
  assert.match(
    red.stdout,
    /^ {2}✗ src\/a\.ts : 2 erreur\(s\) noUncheckedIndexedAccess pour un plafond de 0$/m,
    output(red),
  );
  assert.doesNotMatch(red.stdout, /propre\.ts/, "un accès indexé dont le type admet undefined est propre");

  assert.equal(run(dir, "--write").status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, BASELINE), "utf8")), baselineOf({ "src/a.ts": 2 }));
  const green = run(dir);
  assert.equal(green.status, 0, output(green));
  assert.match(green.stdout, /tenu : 2 erreur\(s\) pour un plafond de 2/, output(green));

  // Un troisième accès non gardé dans le même fichier dépasse le plafond.
  fs.appendFileSync(path.join(dir, "src", "a.ts"), "export const z: number = t[2];\n");
  const worse = run(dir);
  assert.equal(worse.status, 1, output(worse));
  assert.match(worse.stdout, /✗ src\/a\.ts : 3 erreur\(s\)/, output(worse));
});

test("types-ratchet/AC-9 : sur l'arbre livré, le plafond est tenu avec le vrai tsc", (t) => {
  if (outilEpingleAbsent(t, "typescript")) return;
  const r = spawnSync("node", [...RUN], { cwd: ROOT, encoding: "utf8", timeout: 280_000 });
  if (/plafond non vérifié/.test(r.stdout)) {
    prerequisAbsent(t, "types de l'hôte OMP", "plafond de types non éprouvé sur l'arbre livré");
    return;
  }
  assert.equal(r.status, 0, output(r));
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), "utf8")) as {
    option: string;
    files: Record<string, number>;
  };
  assert.equal(baseline.option, OPTION);
  const ceiling = Object.values(baseline.files).reduce((sum, count) => sum + count, 0);
  const measured = Number(/tenu : (\d+) erreur/.exec(r.stdout)?.[1]);
  assert.ok(measured <= ceiling, output(r));
  // L'option est bel et bien appliquée : tant que la baseline porte des erreurs, la mesure en voit.
  if (ceiling > 0) assert.ok(measured > 0, `aucune erreur mesurée pour un plafond de ${ceiling} : ${output(r)}`);
});

/** La copie où check.sh tourne : le dépôt sans aucun fichier de test, remise à neuf par cas. */
const repo = sharedRepo("plafond-check-", { keepTest: () => false });

const section = (cwd: string) =>
  spawnSync("bash", ["scripts/check.sh", "--sections=plafond-types"], { cwd, encoding: "utf8", timeout: 280_000 });

test("types-ratchet/AC-10 : la section plafond-types de check.sh rougit sur un plafond dépassé, en désignant le fichier", (t) => {
  if (outilEpingleAbsent(t, "typescript")) return;
  const dir = repo.fresh();
  fs.writeFileSync(
    path.join(dir, "omp-harness", "zz-indexe.ts"),
    "const t: number[] = [1];\nexport const x: number = t[0];\n",
  );
  const r = section(dir);
  if (/plafond non vérifié/.test(r.stdout)) {
    prerequisAbsent(t, "types de l'hôte OMP", "section plafond-types non éprouvée");
    return;
  }
  assert.equal(r.status, 1, output(r));
  assert.match(r.stdout, /^── Plafond de types$/m, output(r));
  assert.match(
    r.stdout,
    /^ {2}✗ plafond de types : omp-harness\/zz-indexe\.ts \(relance : node --experimental-strip-types scripts\/types-ratchet\.ts\)$/m,
    output(r),
  );
});

test("types-ratchet/AC-11 : sans TypeScript épinglé, la section plafond-types se saute en le disant — ni ✓ ni ✗, code 0", () => {
  const dir = repo.fresh();
  fs.rmSync(path.join(dir, ".typecheck"), { recursive: true, force: true });
  const r = section(dir);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /^── Plafond de types$/m, output(r));
  assert.match(r.stdout, /^ {2}· TypeScript .* absent de \.typecheck .*plafond non vérifié$/m, output(r));
  assert.doesNotMatch(r.stdout, /✓|✗/, output(r));
});
