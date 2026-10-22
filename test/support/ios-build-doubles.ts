// Doublures de l'outillage Xcode pour les tests qui exécutent le vrai
// scripts/ios-build.sh dans une copie jetable (feature recette-siri-de-bout-en-bout,
// S-5).
//
// `xcodebuild build` comme `xcodebuild test` y écrivent le
// `Metadata.appintents/extract.actionsdata` de l'app là où le vrai l'écrit (à la
// RACINE du `.app`) : le contenu conforme vient de la liste attendue
// (`actionsData("ios")`), ou du fichier désigné par `FAUX_ACTIONSDATA`. Aucun
// outil Apple réel n'est requis : les tests tournent aussi sous ubuntu (doublure
// `uname`). Par défaut `xcrun` ne connaît aucun simulateur, donc l'assemblage
// complet se réduit à la compilation générique, comme sur un poste sans
// simulateur iOS 26 ; avec `FAUX_SIMULATEUR=<udid>`, il en annonce un sur un
// runtime iOS 26 et journalise `simctl boot`/`bootstatus`.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { ROOT, tmpdir } from "./repo.ts";
import { actionsData } from "./app-intents-doubles.ts";

export function montageIosBuild(): {
  root: string;
  journal: string;
  run(args: string[], env?: Record<string, string>): SpawnSyncReturns<string>;
} {
  const root = tmpdir("ios-build-copie-");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(ROOT, "scripts", "ios-build.sh"), path.join(root, "scripts", "ios-build.sh"));
  fs.cpSync(path.join(ROOT, "scripts", "app-intents"), path.join(root, "scripts", "app-intents"), { recursive: true });
  fs.mkdirSync(path.join(root, "xcode-factice"));

  const outils = tmpdir("ios-build-outils-");
  const bin = path.join(outils, "bin");
  fs.mkdirSync(bin);
  const journal = path.join(outils, "journal.txt");
  const conforme = path.join(outils, "conforme.actionsdata");
  fs.writeFileSync(conforme, actionsData("ios"));
  // Sous macOS, /usr/bin/python3 est un relais `xcrun` qui suit DEVELOPER_DIR :
  // avec le Xcode factice, il échouerait. La doublure exécute donc l'interpréteur
  // réel, résolu ici avec l'environnement du test.
  const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  if (!python) throw new Error("python3 introuvable : le comparateur des intents Siri l'exige");

  const doublures: Record<string, string> = {
    uname: "printf 'Darwin\\n'",
    xcrun: `printf 'xcrun %s\\n' "$*" >> '${journal}'
case "$2" in
  list)
    if [ -z "\${FAUX_SIMULATEUR:-}" ]; then printf '{}\\n'; exit 0; fi
    case "$3" in
      runtimes)
        printf '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-0","version":"26.0","isAvailable":true}]}\\n'
        ;;
      devices)
        printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-0":[{"udid":"%s","name":"Doublure"}]}}\\n' "$FAUX_SIMULATEUR"
        ;;
    esac
    ;;
esac
exit 0`,
    python3: `exec '${python}' "$@"`,
    xcodebuild: `printf 'xcodebuild %s\\n' "$*" >> '${journal}'
case "$1" in
  -showsdks)
    printf 'iOS SDKs:\\n'
    ;;
  build | test)
    derived=""
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-derivedDataPath" ]; then derived="$a"; fi
      prev="$a"
    done
    if [ "\${FAUX_APPINTENTS:-}" != "absent" ]; then
      meta="$derived/Build/Products/Debug-iphonesimulator/OMPConsoleIOS.app/Metadata.appintents"
      mkdir -p "$meta"
      cp "\${FAUX_ACTIONSDATA:-${conforme}}" "$meta/extract.actionsdata"
    fi
    ;;
esac
exit 0`,
  };
  for (const [nom, corps] of Object.entries(doublures)) {
    const fichier = path.join(bin, nom);
    fs.writeFileSync(fichier, `#!/usr/bin/env bash\n${corps}\n`);
    fs.chmodSync(fichier, 0o755);
  }

  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const cle of ["FAUX_APPINTENTS", "FAUX_ACTIONSDATA", "FAUX_SIMULATEUR", "DEVELOPER_DIR"]) delete base[cle];

  const run = (args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> => {
    fs.rmSync(journal, { force: true });
    return spawnSync("bash", ["scripts/ios-build.sh", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...base,
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        DEVELOPER_DIR: path.join(root, "xcode-factice"),
        ...env,
      },
      timeout: 60_000,
    });
  };

  return { root, journal, run };
}
