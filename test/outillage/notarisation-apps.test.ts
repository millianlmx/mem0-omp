// Feature notarisation-apps : quand les secrets de signature existent, l'app Mac
// jointe aux releases est signée Developer ID avec le runtime renforcé, notarisée
// et agrafée, et l'IPA est signée (archive + export) ; sans eux, le mode d'avant
// (ad hoc, IPA non signée) reste entier, avec un `⚠`.
//
// `scripts/release-assets.sh` tourne ici pour de vrai, dans une copie jetable de
// `scripts/` : `--plan` et `nettoyer` sans aucune doublure (ils tournent sur tout
// OS), la construction avec des doublures de `uname`, `xcodebuild`,
// `scripts/swift-app.sh`, `security`, `codesign`, `xcrun`, `spctl` et `ditto`, qui
// consignent leurs appels dans un journal. base64, python3, zip et shasum sont les
// vrais.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, tmpdir } from "../support/repo.ts";

const SCRIPT = path.join(ROOT, "scripts", "release-assets.sh");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release-assets.yml"), "utf8");

const b64 = (texte: string) => Buffer.from(texte).toString("base64");

const SHA = "0123456789ABCDEF0123456789ABCDEF01234567";
const EQUIPE = "ABCDE12345";

/** Les cinq secrets Mac, aux valeurs reconnaissables dans une sortie. */
const SECRETS_MAC = {
  MACOS_DEVELOPER_ID_P12_BASE64: b64("p12-developer-id-secret"),
  MACOS_DEVELOPER_ID_P12_PASSWORD: "mdp-p12-mac-secret",
  NOTARY_API_KEY_ID: "CLE-ID-SECRETE",
  NOTARY_API_ISSUER_ID: "EMETTEUR-SECRET",
  NOTARY_API_KEY_P8_BASE64: b64("-----BEGIN PRIVATE KEY-----\ncle-p8-secrete\n-----END PRIVATE KEY-----\n"),
};

/** Un profil de provisionnement tel que `security cms -D` le rend : un plist XML. */
function profil(uuid: string, bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>OMP ${bundleId}</string>
<key>UUID</key><string>${uuid}</string>
<key>TeamIdentifier</key><array><string>${EQUIPE}</string></array>
<key>Entitlements</key><dict><key>application-identifier</key><string>${EQUIPE}.${bundleId}</string></dict>
</dict></plist>
`;
}
const UUID_APP = "11111111-2222-3333-4444-555555555555";
const UUID_WIDGETS = "66666666-7777-8888-9999-AAAAAAAAAAAA";

const SECRETS_IOS = {
  IOS_SIGNING_P12_BASE64: b64("p12-distribution-secret"),
  IOS_SIGNING_P12_PASSWORD: "mdp-p12-ios-secret",
  IOS_PROFILE_APP_BASE64: b64(profil(UUID_APP, "com.omp.console.ios")),
  IOS_PROFILE_WIDGETS_BASE64: b64(profil(UUID_WIDGETS, "com.omp.console.ios.widgets")),
  IOS_TEAM_ID: EQUIPE,
};

/** `--plan <app>` du script du dépôt, sous l'environnement donné et rien d'autre. */
function plan(app: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, "--plan", app], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
}

/** Doublures communes : chacune consigne `<outil> <arguments>` dans $LOG. */
const DOUBLURES: Record<string, string> = {
  uname: "echo Darwin",
  xcodebuild: `
[ "$1" = -showsdks ] && { echo "iOS 26.0 -sdk iphoneos26.0"; exit 0; }
echo "xcodebuild $*" >> "$LOG"
case "$1" in
  archive)
    while [ $# -gt 0 ]; do [ "$1" = -archivePath ] && archive="$2"; shift; done
    mkdir -p "$archive/Products/Applications/OMPConsoleIOS.app"
    ls "$HOME/Library/MobileDevice/Provisioning Profiles" > "$DEVELOPER_DIR/profils-vus.txt" ;;
  -exportArchive)
    while [ $# -gt 0 ]; do
      [ "$1" = -exportOptionsPlist ] && cp "$2" "$DEVELOPER_DIR/ExportOptions.vu.plist"
      [ "$1" = -exportPath ] && export_dir="$2"; shift
    done
    stage="$(mktemp -d)" && mkdir -p "$stage/Payload/OMPConsoleIOS.app" && echo signee > "$stage/Payload/OMPConsoleIOS.app/OMPConsoleIOS"
    mkdir -p "$export_dir" && (cd "$stage" && zip -qry "$export_dir/OMPConsoleIOS.ipa" Payload) ;;
  build)
    while [ $# -gt 0 ]; do [ "$1" = -derivedDataPath ] && derived="$2"; shift; done
    app="$derived/Build/Products/Release-iphoneos/OMPConsoleIOS.app"
    mkdir -p "$app" && echo non-signee > "$app/OMPConsoleIOS" ;;
esac`,
  "scripts/swift-app.sh": `
echo "swift-app $* OMP_CODESIGN_IDENTITY=\${OMP_CODESIGN_IDENTITY:-}" >> "$LOG"
app="$(dirname "$0")/../omp-console/build/OMP Console.app/Contents"
mkdir -p "$app/MacOS" "$app/Resources" && echo binaire > "$app/MacOS/OMPConsole" && echo service > "$app/Resources/mem0-rs"`,
  security: `
echo "security $*" >> "$LOG"
case "$1" in
  create-keychain) touch "$4" ;;
  find-identity) printf '  1) %s "%s"\\n     1 valid identities found\\n' "${SHA}" "$IDENTITE" ;;
  list-keychains) [ $# -eq 3 ] && echo '    "/Users/runner/Library/Keychains/login.keychain-db"' ;;
  cms) cat "$4" ;;
  delete-keychain) rm -f "$2" ;;
esac
exit 0`,
  codesign: `
echo "codesign $*" >> "$LOG"
if [ "$1" = -dv ]; then
  echo "CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1" >&2
  echo "TeamIdentifier=${EQUIPE}" >&2
fi
exit 0`,
  xcrun: `
echo "xcrun $*" >> "$LOG"
case "$1 $2" in
  "notarytool submit")
    cp "$3" "$DEVELOPER_DIR/soumis.zip"
    while [ $# -gt 0 ]; do [ "$1" = --key ] && cp "$2" "$DEVELOPER_DIR/cle-vue.p8"; shift; done
    printf '%s\\n' "$NOTARY_REPONSE" ;;
  "notarytool log") echo '{"issues":[{"path":"OMP Console.app/Contents/Resources/mem0-rs","message":"The signature does not include a secure timestamp."}]}' ;;
  "stapler staple") echo ticket > "$3/Contents/CodeResources" ;;
esac
exit 0`,
  spctl: 'echo "spctl $*" >> "$LOG"; echo "$4: accepted" >&2; echo "source=Notarized Developer ID" >&2',
  // ditto -c -k --keepParent <source> <archive> : le bundle sous son propre nom.
  ditto: 'echo "ditto $*" >> "$LOG"; cd "$(dirname "$4")" && zip -qry "$5" "$(basename "$4")"',
};

/** Une racine jetable : le script copié sous scripts/, les doublures dans bin/. */
function sandbox() {
  const dir = tmpdir("notarisation-apps-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(dir, "scripts", "release-assets.sh"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const [nom, corps] of Object.entries(DOUBLURES)) {
    const fichier = nom.startsWith("scripts/") ? path.join(dir, nom) : path.join(bin, nom);
    fs.writeFileSync(fichier, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
  }
  const runnerTemp = path.join(dir, "runner-temp");
  const home = path.join(dir, "home");
  fs.mkdirSync(runnerTemp);
  fs.mkdirSync(home);
  const log = path.join(dir, "appels.log");
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [path.join(dir, "scripts", "release-assets.sh"), ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        DEVELOPER_DIR: dir,
        HOME: home,
        RUNNER_TEMP: runnerTemp,
        LOG: log,
        ...env,
      },
    });
  const appels = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  return {
    dir,
    home,
    signing: path.join(runnerTemp, "omp-release-signing"),
    out: path.join(dir, "omp-console", "build", "release-assets"),
    run,
    appels,
  };
}

/** L'indice du premier appel, après `apres`, qui commence par `debut` ; -1 s'il n'y en a aucun. */
const indice = (appels: string[], debut: string, apres = -1) =>
  appels.findIndex((a, i) => i > apres && a.startsWith(debut));

/** Les entrées d'une archive zip, par `unzip -Z1`. */
function entries(zip: string): string[] {
  const listed = spawnSync("unzip", ["-Z1", zip], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\n").filter(Boolean);
}

/** Aucune valeur de secret dans la sortie. */
function sansSecret(sortie: string, secrets: Record<string, string>) {
  for (const [nom, val] of Object.entries(secrets)) {
    assert.ok(!sortie.includes(val), `la valeur de ${nom} apparaît dans la sortie`);
  }
}

test("notarisation-apps/AC-1 : --plan dit, sur tout OS et d'après les seuls secrets, le mode de chaque app ; un jeu partiel ou une méthode inconnue échoue en nommant le manquant", () => {
  const sans = plan("mac");
  assert.equal(sans.status, 0, sans.stderr);
  assert.match(sans.stdout, /^mac : ad hoc — non notarisée$/m);
  assert.match(sans.stdout, /^ {2}⚠ app Mac NON notarisée/m);
  const ios = plan("ios");
  assert.equal(ios.status, 0, ios.stderr);
  assert.match(ios.stdout, /^ios : non signée$/m);
  assert.match(ios.stdout, /^ {2}⚠ IPA NON signée/m);

  const mac = plan("mac", SECRETS_MAC);
  assert.equal(mac.status, 0, mac.stderr);
  assert.match(mac.stdout, /^mac : notarisée/m);
  assert.doesNotMatch(mac.stdout, /⚠/);
  sansSecret(mac.stdout + mac.stderr, SECRETS_MAC);

  // Méthode d'export : ad-hoc par défaut, development sur demande, au nom d'Xcode 26.
  assert.match(plan("ios", SECRETS_IOS).stdout, /^ios : signée .*méthode release-testing\)$/m);
  assert.match(plan("ios", { ...SECRETS_IOS, IOS_EXPORT_METHOD: "development" }).stdout, /méthode debugging\)$/m);
  const inconnue = plan("ios", { ...SECRETS_IOS, IOS_EXPORT_METHOD: "app-store" });
  assert.equal(inconnue.status, 1);
  assert.match(inconnue.stderr, /IOS_EXPORT_METHOD inconnue/);

  // Chaque secret retiré d'un jeu complet : échec, et le message le nomme.
  for (const [app, secrets] of [
    ["mac", SECRETS_MAC],
    ["ios", SECRETS_IOS],
  ] as const) {
    for (const nom of Object.keys(secrets)) {
      const partiel = plan(app, { ...secrets, [nom]: "" });
      assert.equal(partiel.status, 1, `${app} sans ${nom}`);
      assert.match(partiel.stderr, new RegExp(`incomplète : .*${nom}`));
      sansSecret(partiel.stdout + partiel.stderr, secrets);
    }
  }
  // Les secrets d'une app ne changent pas le mode de l'autre.
  assert.match(plan("ios", SECRETS_MAC).stdout, /^ios : non signée$/m);
});

test("notarisation-apps/AC-2 : avec les secrets Mac, trousseau temporaire, signature Developer ID au runtime renforcé, notarisation, agrafage et vérifications précèdent l'archive jointe, puis le trousseau disparaît", () => {
  const box = sandbox();
  const result = box.run(["mac"], {
    ...SECRETS_MAC,
    IDENTITE: `Developer ID Application: Test (${EQUIPE})`,
    NOTARY_REPONSE: '{"id":"sub-42","status":"Accepted","message":"Processing complete"}',
    GITHUB_ACTIONS: "true",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const appels = box.appels();
  const keychain = path.join(box.signing, "omp-release.keychain-db");
  const bundle = path.join(box.dir, "omp-console", "build", "OMP Console.app");
  const etapes = [
    `security create-keychain -p `,
    `security unlock-keychain -p `,
    `security import ${path.join(box.signing, "certificat.p12")} -k ${keychain} -P ${SECRETS_MAC.MACOS_DEVELOPER_ID_P12_PASSWORD}`,
    `security set-key-partition-list `,
    `security list-keychains -d user -s ${keychain} /Users/runner/Library/Keychains/login.keychain-db`,
    `swift-app --no-tests OMP_CODESIGN_IDENTITY=${SHA}`,
    `codesign --force --timestamp --options runtime --sign ${SHA} ${bundle}/Contents/Resources/mem0-rs`,
    `codesign --force --timestamp --options runtime --sign ${SHA} ${bundle}`,
    `codesign --verify --strict --deep ${bundle}`,
    `xcrun notarytool submit `,
    `xcrun stapler staple ${bundle}`,
    `xcrun stapler validate ${bundle}`,
    `spctl --assess --type execute -vv ${bundle}`,
    `ditto -c -k --keepParent ${bundle} ${path.join(box.out, "OMP-Console-macOS.zip")}`,
    `security delete-keychain ${keychain}`,
  ];
  let precedent = -1;
  for (const etape of etapes) {
    const i = indice(appels, etape, precedent);
    assert.ok(i !== -1, `« ${etape} » absent ou hors d'ordre :\n${appels.join("\n")}`);
    precedent = i;
  }
  // Soumission par clé d'API App Store Connect, jamais par identifiant Apple.
  const soumission = appels[indice(appels, "xcrun notarytool submit ")] ?? "";
  for (const attendu of [
    `--key-id ${SECRETS_MAC.NOTARY_API_KEY_ID}`,
    `--issuer ${SECRETS_MAC.NOTARY_API_ISSUER_ID}`,
    "--wait",
  ])
    assert.ok(soumission.includes(attendu), `${attendu} absent de : ${soumission}`);
  assert.doesNotMatch(soumission, /--apple-id|--password/);
  assert.equal(
    fs.readFileSync(path.join(box.dir, "cle-vue.p8"), "utf8"),
    Buffer.from(SECRETS_MAC.NOTARY_API_KEY_P8_BASE64, "base64").toString(),
  );

  // Le bundle soumis n'a pas encore son ticket ; l'archive jointe l'a.
  assert.ok(!entries(path.join(box.dir, "soumis.zip")).includes("OMP Console.app/Contents/CodeResources"));
  const jointe = path.join(box.out, "OMP-Console-macOS.zip");
  assert.ok(entries(jointe).includes("OMP Console.app/Contents/CodeResources"), "archive jointe sans le ticket agrafé");
  assert.equal(spawnSync("shasum", ["-a", "256", "-c", "OMP-Console-macOS.zip.sha256"], { cwd: box.out }).status, 0);

  // Aucun secret imprimé ; le mot de passe aléatoire du trousseau est masqué.
  const sortie = result.stdout + result.stderr;
  sansSecret(sortie, SECRETS_MAC);
  const mdp = /^security create-keychain -p (\S+) /m.exec(appels.join("\n"))?.[1] ?? "";
  assert.ok(mdp.length >= 32, "mot de passe du trousseau trop court");
  assert.ok(result.stdout.includes(`::add-mask::${mdp}\n`), "mot de passe du trousseau non masqué");
  assert.equal(sortie.split(mdp).length - 1, 1, "le mot de passe du trousseau n'apparaît que dans ::add-mask::");
  assert.equal(fs.existsSync(box.signing), false, "dossier de signature laissé derrière");
});

test("notarisation-apps/AC-3 : une notarisation refusée échoue en 1, recopie le journal de notarytool et n'écrit aucune archive ; une soumission impossible nomme les secrets de la clé d'API", () => {
  const box = sandbox();
  const env = { ...SECRETS_MAC, IDENTITE: `Developer ID Application: Test (${EQUIPE})` };
  const refus = box.run(["mac"], {
    ...env,
    NOTARY_REPONSE: '{"id":"sub-13","status":"Invalid","message":"Processing complete"}',
  });
  assert.equal(refus.status, 1, refus.stdout + refus.stderr);
  assert.match(refus.stderr, /notarisation refusée par Apple \(statut Invalid, soumission sub-13\)/);
  assert.match(refus.stderr, /does not include a secure timestamp/, "le journal d'Apple est recopié");
  assert.ok(indice(box.appels(), "xcrun notarytool log sub-13 ") !== -1);
  assert.equal(indice(box.appels(), "xcrun stapler"), -1, "rien n'est agrafé");
  assert.equal(fs.existsSync(path.join(box.out, "OMP-Console-macOS.zip")), false);
  assert.equal(fs.existsSync(box.signing), false, "trousseau retiré même après l'échec");
  sansSecret(refus.stdout + refus.stderr, SECRETS_MAC);

  const sansSoumission = box.run(["mac"], { ...env, NOTARY_REPONSE: "" });
  assert.equal(sansSoumission.status, 1);
  assert.match(
    sansSoumission.stderr,
    /aucune soumission créée — vérifie NOTARY_API_KEY_ID, NOTARY_API_ISSUER_ID, NOTARY_API_KEY_P8_BASE64/,
  );

  // Un certificat qui n'est pas Developer ID Application est refusé avant toute compilation.
  const autre = sandbox();
  const mauvais = autre.run(["mac"], { ...SECRETS_MAC, IDENTITE: `Apple Development: Test (${EQUIPE})` });
  assert.equal(mauvais.status, 1);
  assert.match(mauvais.stderr, /aucune identité « Developer ID Application »/);
  assert.equal(indice(autre.appels(), "swift-app"), -1);
});

test("notarisation-apps/AC-4 : sans secret, l'app Mac reste signée par swift-app.sh seul (ad hoc), archivée, avec un ⚠ ; un jeu partiel échoue avant toute compilation", () => {
  const box = sandbox();
  const result = box.run(["mac"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /⚠ app Mac NON notarisée/);
  const appels = box.appels();
  assert.ok(appels.includes("swift-app --no-tests OMP_CODESIGN_IDENTITY="), appels.join("\n"));
  for (const outil of ["security", "codesign", "xcrun", "spctl"])
    assert.equal(indice(appels, `${outil} `), -1, `${outil} appelé sans secret`);
  assert.ok(entries(path.join(box.out, "OMP-Console-macOS.zip")).includes("OMP Console.app/Contents/MacOS/OMPConsole"));

  const partiel = sandbox();
  const echec = partiel.run(["mac"], { NOTARY_API_KEY_ID: "seul" });
  assert.equal(echec.status, 1);
  assert.match(echec.stderr, /signature mac incomplète/);
  assert.deepEqual(partiel.appels(), [], "rien n'est compilé");
});

test("notarisation-apps/AC-5 : avec les secrets iOS, profils installés, archive en signature manuelle sans équipe dans le pbxproj, export par ExportOptions ; l'IPA jointe est l'exportée et vérifiée", () => {
  const box = sandbox();
  const result = box.run(["ios"], { ...SECRETS_IOS, IDENTITE: `Apple Distribution: Test (${EQUIPE})` });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const appels = box.appels();
  const archive = appels.find((a) => a.startsWith("xcodebuild archive ")) ?? "";
  for (const attendu of [
    "-configuration Release",
    "-destination generic/platform=iOS ",
    "CODE_SIGN_STYLE=Manual",
    `DEVELOPMENT_TEAM=${EQUIPE}`,
    `CODE_SIGN_IDENTITY=Apple Distribution: Test (${EQUIPE})`,
    `OMP_PROFILE_OMPConsoleIOS=${UUID_APP}`,
    `OMP_PROFILE_OMPConsoleWidgets=${UUID_WIDGETS}`,
    "PROVISIONING_PROFILE_SPECIFIER=$(OMP_PROFILE_$(TARGET_NAME))",
  ])
    assert.ok(archive.includes(attendu), `${attendu} absent de : ${archive}`);
  assert.doesNotMatch(archive, /CODE_SIGNING_ALLOWED=NO/);
  assert.ok(indice(appels, "xcodebuild -exportArchive ") > indice(appels, "xcodebuild archive "));
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS.xcodeproj", "project.pbxproj"), "utf8"),
    /DEVELOPMENT_TEAM\s*=/,
    "aucune équipe en dur dans le pbxproj",
  );

  // Les deux profils étaient installés pendant l'archive, et sont retirés après.
  assert.deepEqual(fs.readFileSync(path.join(box.dir, "profils-vus.txt"), "utf8").split("\n").filter(Boolean).sort(), [
    `${UUID_APP}.mobileprovision`,
    `${UUID_WIDGETS}.mobileprovision`,
  ]);
  assert.deepEqual(fs.readdirSync(path.join(box.home, "Library", "MobileDevice", "Provisioning Profiles")), []);
  assert.equal(fs.existsSync(box.signing), false);

  const lu = spawnSync(
    "python3",
    [
      "-c",
      "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))",
      path.join(box.dir, "ExportOptions.vu.plist"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(lu.status, 0, lu.stderr);
  const options = JSON.parse(lu.stdout);
  assert.equal(options.method, "release-testing");
  assert.equal(options.teamID, EQUIPE);
  assert.equal(options.signingStyle, "manual");
  assert.deepEqual(options.provisioningProfiles, {
    "com.omp.console.ios": UUID_APP,
    "com.omp.console.ios.widgets": UUID_WIDGETS,
  });

  const ipa = path.join(box.out, "OMP-Console-iOS.ipa");
  assert.ok(entries(ipa).includes("Payload/OMPConsoleIOS.app/OMPConsoleIOS"));
  assert.equal(
    spawnSync("unzip", ["-p", ipa, "Payload/OMPConsoleIOS.app/OMPConsoleIOS"], { encoding: "utf8" }).stdout.trim(),
    "signee",
  );
  assert.ok(indice(appels, "codesign --verify --strict --deep ") !== -1, "la signature de l'IPA exportée est vérifiée");
  sansSecret(result.stdout + result.stderr, SECRETS_IOS);

  // Un profil qui vise une autre cible est refusé en nommant son secret.
  const inverse = sandbox().run(["ios"], {
    ...SECRETS_IOS,
    IOS_PROFILE_WIDGETS_BASE64: SECRETS_IOS.IOS_PROFILE_APP_BASE64,
    IDENTITE: `Apple Distribution: Test (${EQUIPE})`,
  });
  assert.equal(inverse.status, 1);
  assert.match(
    inverse.stderr,
    /IOS_PROFILE_WIDGETS_BASE64 : le profil vise « ABCDE12345\.com\.omp\.console\.ios », attendu « ABCDE12345\.com\.omp\.console\.ios\.widgets »/,
  );
});

test("notarisation-apps/AC-6 : `nettoyer` retire, sur tout OS, les profils installés, le trousseau et le dossier de signature, et repasse sans rien à retirer", () => {
  const dir = tmpdir("notarisation-nettoyer-");
  const runnerTemp = path.join(dir, "runner-temp");
  const signing = path.join(runnerTemp, "omp-release-signing");
  fs.mkdirSync(signing, { recursive: true });
  fs.writeFileSync(path.join(signing, "omp-release.keychain-db"), "");
  const profils = [path.join(dir, "a.mobileprovision"), path.join(dir, "b.mobileprovision")];
  for (const p of profils) fs.writeFileSync(p, "");
  fs.writeFileSync(path.join(signing, "profils-installes.txt"), `${profils.join("\n")}\n`);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "appels.log");
  fs.writeFileSync(path.join(bin, "security"), `#!/bin/sh\necho "security $*" >> "${log}"\n`, { mode: 0o755 });
  const nettoyer = () =>
    spawnSync("bash", [SCRIPT, "nettoyer"], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, RUNNER_TEMP: runnerTemp },
    });

  const premier = nettoyer();
  assert.equal(premier.status, 0, premier.stderr);
  assert.equal(
    fs.readFileSync(log, "utf8").trim(),
    `security delete-keychain ${path.join(signing, "omp-release.keychain-db")}`,
  );
  for (const p of [...profils, signing]) assert.equal(fs.existsSync(p), false, `${p} toujours là`);
  const second = nettoyer();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /rien à nettoyer/);
});

/** Les étapes du job `app` : nom, condition, environnement et commande. */
function etapes() {
  const job = WORKFLOW.split(/^jobs:$/m)[1] ?? "";
  const corps = job.split(/^ {4}steps:$/m)[1] ?? "";
  return corps
    .split(/^ {6}- /m)
    .slice(1)
    .map((texte) => {
      const brut = `  ${texte}`.replace(/^\s*#.*$\n?/gm, "");
      const env = new Map<string, string>();
      const bloc = /^ {8}env:\n((?: {10}.*\n?)+)/m.exec(brut)?.[1] ?? "";
      for (const ligne of bloc.split("\n")) {
        const m = /^ {10}([A-Z0-9_]+): (.*)$/.exec(ligne);
        if (m) env.set(m[1]!, m[2]!);
      }
      return {
        texte: brut,
        nom: /^ {2}name: (.*)$/m.exec(brut)?.[1] ?? /^ {2}uses: (.*)$/m.exec(brut)?.[1] ?? "",
        si: /^ {8}if: (.*)$/m.exec(brut)?.[1] ?? null,
        env,
        run: /^ {8}run: (.*)$/m.exec(brut)?.[1] ?? "",
      };
    });
}

test("notarisation-apps/AC-7 : les secrets ne vont qu'à l'étape de construction, chacun au seul job de son app, et suffisent au script ; un nettoyage `if: always()` suit, aucune action tierce", () => {
  const steps = etapes();
  const build = steps.findIndex((s) => s.run === "bash scripts/release-assets.sh ${{ matrix.app }}");
  const nettoyage = steps.findIndex((s) => s.run === "bash scripts/release-assets.sh nettoyer");
  const upload = steps.findIndex((s) => s.run.startsWith("gh release upload "));
  assert.ok(build !== -1 && nettoyage > build && upload > nettoyage, "construction, nettoyage, puis téléversement");
  assert.equal(steps[nettoyage]!.si, "always()", "le nettoyage passe même après un échec");

  // Aucune autre étape ne lit un secret ; le téléversement n'a que le jeton du run.
  steps.forEach((s, i) => {
    if (i !== build) assert.doesNotMatch(s.texte, /secrets\./, `l'étape « ${s.nom} » lit un secret`);
  });
  assert.deepEqual([...steps[upload]!.env.entries()], [["GH_TOKEN", "${{ github.token }}"]]);

  // Chaque secret, sous le nom de sa variable, au seul job de son app.
  const parApp: Record<string, Record<string, string>> = { mac: {}, ios: {} };
  for (const [nom, valeur] of steps[build]!.env) {
    if (nom === "IOS_EXPORT_METHOD") {
      assert.equal(valeur, "${{ vars.IOS_EXPORT_METHOD }}");
      continue;
    }
    const m = /^\$\{\{ matrix\.app == '(mac|ios)' && secrets\.([A-Z0-9_]+) \|\| '' \}\}$/.exec(valeur);
    assert.ok(m, `${nom} : secret non limité au job de son app (${valeur})`);
    assert.equal(m[2], nom, `${nom} lit secrets.${m[2]}`);
    parApp[m[1]!]![nom] = "valeur";
  }
  // Exécution : ces secrets, et eux seuls, font passer le script en mode signé.
  assert.match(plan("mac", parApp.mac).stdout, /^mac : notarisée/m);
  assert.match(plan("ios", parApp.ios).stdout, /^ios : signée/m);
  assert.match(plan("mac", parApp.ios).stdout, /^mac : ad hoc/m);
  assert.match(plan("ios", parApp.mac).stdout, /^ios : non signée$/m);

  // Moindre privilège, et aucune action hors de l'organisation `actions`.
  assert.match(WORKFLOW.split(/^jobs:$/m)[0] ?? "", /^permissions:\n {2}contents: read$/m);
  const uses = [...WORKFLOW.matchAll(/^\s*-?\s*uses: ([\w.-]+)\//gm)].map((m) => m[1]);
  assert.ok(uses.length > 0 && uses.every((proprietaire) => proprietaire === "actions"), uses.join(", "));
  assert.doesNotMatch(steps[build]!.texte, /^ {2}uses:/m);
});

test("notarisation-apps/AC-8 : PUBLISHING.md § Apps jointes aux releases nomme chaque secret et variable que le workflow passe au script", () => {
  const doc = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  const section = doc.split(/^## Apps jointes aux releases$/m)[1]?.split(/^## /m)[0] ?? "";
  assert.ok(section.length > 0, "section « Apps jointes aux releases » absente");
  const build = etapes().find((s) => s.run === "bash scripts/release-assets.sh ${{ matrix.app }}");
  const noms = [...(build?.env.keys() ?? [])];
  assert.ok(noms.length > 0);
  for (const nom of noms)
    assert.ok(section.includes(`\`${nom}\``), `${nom} absent de PUBLISHING.md § Apps jointes aux releases`);
});
