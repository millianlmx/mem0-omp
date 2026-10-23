// Feature release-assets : chaque release GitHub publiée reçoit les apps OMP Console,
// le bundle macOS et l'IPA iOS, construits depuis le code du tag par
// `scripts/release-assets.sh` et joints par `.github/workflows/release-assets.yml`.
// Le script tourne ici pour de vrai, dans une copie jetable de `scripts/` ; seuls
// `uname`, `xcodebuild`, `ditto` et `scripts/swift-app.sh` sont doublés.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, tmpdir } from "../support/repo.ts";

const SCRIPT = path.join(ROOT, "scripts", "release-assets.sh");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release-assets.yml"), "utf8");

/** Une racine jetable : le script copié sous scripts/, et des doublures dans bin/. */
function sandbox(doubles: Record<string, string>) {
  const dir = tmpdir("release-assets-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "release-assets.sh"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(doubles)) {
    const file = name.startsWith("scripts/") ? path.join(dir, name) : path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [path.join(dir, "scripts", "release-assets.sh"), ...args], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, DEVELOPER_DIR: dir, ...env },
    });
  return { dir, out: path.join(dir, "omp-console", "build", "release-assets"), run };
}

const DARWIN = "echo Darwin";

/** Les entrées d'une archive zip, par `unzip -Z1`. */
function entries(zip: string): string[] {
  const listed = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\n").filter(Boolean);
}

/** Vrai si `<fichier>.sha256` vérifie le fichier, depuis son dossier. */
function checksumOk(dir: string, name: string): boolean {
  return spawnSync("shasum", ["-a", "256", "-c", `${name}.sha256`], { cwd: dir }).status === 0;
}

test("release-assets/AC-1 : l'IPA est l'app iOS Release pour un appareil, non signée, sous Payload/, avec son empreinte", () => {
  const box = sandbox({
    uname: DARWIN,
    xcodebuild: `
[ "$1" = -showsdks ] && { echo "iOS 26.0 -sdk iphoneos26.0"; exit 0; }
echo "$*" > "$DEVELOPER_DIR/xcodebuild.args"
while [ $# -gt 0 ]; do [ "$1" = -derivedDataPath ] && derived="$2"; shift; done
app="$derived/Build/Products/Release-iphoneos/OMPConsoleIOS.app"
mkdir -p "$app" && echo binaire > "$app/OMPConsoleIOS"`,
  });
  const result = box.run(["ios"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const args = fs.readFileSync(path.join(box.dir, "xcodebuild.args"), "utf8");
  for (const expected of ["-configuration Release", "-destination generic/platform=iOS ", "CODE_SIGNING_ALLOWED=NO"])
    assert.ok(args.includes(expected), `${expected} absent de : ${args}`);
  assert.ok(entries(path.join(box.out, "OMP-Console-iOS.ipa")).includes("Payload/OMPConsoleIOS.app/OMPConsoleIOS"));
  assert.ok(checksumOk(box.out, "OMP-Console-iOS.ipa"));
});

test("release-assets/AC-2 : l'app Mac est le bundle de swift-app.sh --no-tests, archivé par ditto, avec son empreinte", () => {
  const box = sandbox({
    uname: DARWIN,
    xcodebuild: 'echo "macOS 26.0 -sdk macosx26.0"',
    "scripts/swift-app.sh": `
echo "$*" > "$DEVELOPER_DIR/swift-app.args"
app="$(dirname "$0")/../omp-console/build/OMP Console.app/Contents/MacOS"
mkdir -p "$app" && echo binaire > "$app/OMPConsole"`,
    // ditto -c -k --keepParent <source> <archive> : le bundle sous son propre nom.
    ditto: 'cd "$(dirname "$4")" && zip -qry "$5" "$(basename "$4")"',
  });
  const result = box.run(["mac"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(box.dir, "swift-app.args"), "utf8").trim(), "--no-tests");
  assert.ok(entries(path.join(box.out, "OMP-Console-macOS.zip")).includes("OMP Console.app/Contents/MacOS/OMPConsole"));
  assert.ok(checksumOk(box.out, "OMP-Console-macOS.zip"));

  // Un assemblage tombé n'écrit aucune archive.
  fs.rmSync(box.out, { recursive: true });
  fs.writeFileSync(path.join(box.dir, "scripts", "swift-app.sh"), "#!/bin/sh\nexit 1\n");
  const failed = box.run(["mac"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /swift-app\.sh --no-tests/);
  assert.equal(fs.existsSync(path.join(box.out, "OMP-Console-macOS.zip")), false);
});

test("release-assets/AC-3 : hors macOS ou sans Xcode utilisable, « non exécuté » (code 2) ; une cible inconnue est refusée", () => {
  const linux = sandbox({ uname: "echo Linux" }).run(["ios"]);
  assert.equal(linux.status, 2);
  assert.match(linux.stdout, /non exécuté/);
  const noXcode = sandbox({ uname: DARWIN, xcodebuild: "exit 1" }).run(["mac"]);
  assert.equal(noXcode.status, 2);
  assert.match(noXcode.stdout, /Xcode inutilisable/);
  const unknown = sandbox({ uname: DARWIN }).run(["windows"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /usage : scripts\/release-assets\.sh mac\|ios/);
});

test("release-assets/AC-4 : le workflow suit chaque release publiée, construit les deux apps depuis le tag et les joint à la release", () => {
  const on = WORKFLOW.split(/^permissions:/m)[0] ?? "";
  assert.match(on, /^ {2}release:\n {4}types: \[published\]$/m);
  assert.match(on, /^ {2}workflow_dispatch:$/m, "une release déjà publiée se complète à la main");
  // Lecture seule par défaut ; seul le job qui téléverse écrit.
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m);
  const job = WORKFLOW.split(/^jobs:$/m)[1] ?? "";
  assert.match(job, /^ {4}runs-on: macos-latest$/m);
  assert.match(job, /^ {6}contents: write$/m);
  assert.match(job, /^ {8}app: \[mac, ios\]$/m);
  assert.match(job, /^ {6}fail-fast: false$/m);
  assert.match(job, /ref: refs\/tags\/\$\{\{ env\.TAG \}\}/, "le code du tag, jamais celui de main");
  const build = job.indexOf("bash scripts/release-assets.sh ${{ matrix.app }}");
  const upload = job.indexOf('gh release upload "$TAG" omp-console/build/release-assets/* --clobber');
  assert.ok(build !== -1 && upload > build, "construction, puis téléversement");
  // Le tag passe par l'environnement, jamais interpolé dans le shell.
  assert.doesNotMatch(job, /run:.*\$\{\{ (github\.event\.release\.tag_name|inputs\.tag) \}\}/);
});
