// Les GARDES TEXTUELLES de la feature `ios-session-omp` (BR-6) : les quatre routes
// de la session hébergée existent des deux côtés, l'état complet est servi (le nom
// du dépôt), le lancement est exclusif, le sélecteur ne prend que des dépôts
// connus, l'écran relit à l'apparition, et le fil est le composant RÉUTILISÉ.
//
// Mêmes règles structurelles que `test/ios-sessions.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// `test/criteria.test.ts` exige qu'un id qualifié `<slug>/AC-<n>` ne désigne qu'un
// seul test : ce fichier est le seul de `test/` à porter le slug
// `ios-session-omp`. Les preuves de COMPORTEMENT des autres critères vivent dans
// les suites Swift, que ce fichier NOMME sans les remplacer :
//  - AC-1/AC-7/AC-13 (`RemoteSessionRouteTests.swift`), AC-14
//    (`IOSSessionOmpRecipeTests.swift`, gated) ;
//  - AC-1/AC-2/AC-3/AC-6/AC-9/AC-10/AC-11/AC-12/AC-13 (`IOSSessionOmpTests.swift`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const EXCLUDED_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  ".typecheck": true,
  qdrant_storage: true,
  build: true,
};

const dirs: string[] = [];
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Une copie du dépôt où l'on peut planter une faute. */
function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "ios-session-omp-copie-"));
  dirs.push(dir);
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((segment) => EXCLUDED_DIRS[segment] === true || segment.startsWith(".build"))) {
        return false;
      }
      if (rel === path.join("test", "check.test.ts")) return false;
      return true;
    },
  });
  return dir;
}

/** Le source débarrassé de ses commentaires `//` et `/* … *\/`. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inBlock = false;
  while (i < source.length) {
    if (inBlock) {
      if (source.startsWith("*/", i)) {
        inBlock = false;
        i += 2;
      } else i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      continue;
    }
    if (source.startsWith("/*", i)) {
      inBlock = true;
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function code(file: string): string {
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, "utf8")) : "";
}

// ---------------------------------------------------------------------------
// Les gardes (vides quand tout est là).

/** (AC-1) Les 4 routes existent des deux côtés, la section route, le client porte les méthodes. */
function routeFaults(root: string): string[] {
  const faults: string[] = [];
  const router = code(path.join(root, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteRouter.swift"));
  const catalog = code(path.join(root, "omp-console", "Sources", "ConsoleClient", "ClientRoute.swift"));
  const pairs = [
    ['"v1/session/launch"', '"hosted.launch"', "/v1/session/launch", "hosted.launch"],
    ['"v1/session/relaunch"', '"hosted.relaunch"', "/v1/session/relaunch", "hosted.relaunch"],
    ['"v1/session/stop"', '"hosted.stop"', "/v1/session/stop", "hosted.stop"],
    ['"v1/session/dialogs/:id"', '"hosted.dialog"', "/v1/session/dialogs/{id}", "hosted.dialog"],
  ];
  for (const [routerPath, routerName, clientPath, clientName] of pairs) {
    if (!router.includes(routerPath) || !router.includes(routerName)) {
      faults.push(`RemoteRouter.routes ne porte pas ${routerName}`);
    }
    if (!catalog.includes(`"${clientPath}"`) || !catalog.includes(`"${clientName}"`)) {
      faults.push(`ClientRoute.all ne porte pas ${clientName}`);
    }
  }
  const view = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSectionView.swift"));
  if (!/section\s*==\s*\.session\b/.test(view)) faults.push("IOSSectionView ne teste pas `section == .session`");
  if (!view.includes("IOSSessionOmpScreen(")) faults.push("IOSSectionView ne monte pas IOSSessionOmpScreen");
  const model = code(path.join(root, "omp-console", "Sources", "ConsoleClient", "ConsoleClientModel.swift"));
  for (const name of ["launchHostedSession", "relaunchHostedSession", "stopHostedSession", "answerHostedDialog"]) {
    if (!model.includes(`func ${name}(`)) faults.push(`ConsoleClientModel ne porte pas ${name}`);
  }
  return faults;
}

/** (AC-2) Le nom du dépôt et les champs neufs sont servis des DEUX côtés, et l'écran les lit. */
function hostedStateFaults(root: string): string[] {
  const faults: string[] = [];
  const server = code(path.join(root, "omp-console", "Sources", "OMPConsole", "Remote", "Payloads.swift"));
  const client = code(path.join(root, "omp-console", "Sources", "ConsoleClient", "ClientPayloads.swift"));
  const stream = code(path.join(root, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteStream.swift"));
  if (!/RemoteHostedSessionPayload[\s\S]*?var projectName: String\?/.test(server)) {
    faults.push("Payloads.swift : RemoteHostedSessionPayload n'a pas projectName");
  }
  if (!/RemoteHostedSessionPayload[\s\S]*?var projectName: String\?/.test(client)) {
    faults.push("ClientPayloads.swift : RemoteHostedSessionPayload n'a pas projectName");
  }
  for (const field of ["stateLabel", "sessionFile", "projectName"]) {
    if (!new RegExp(`RemoteHostedEvent[\\s\\S]*?var ${field}: String\\?`).test(stream)) {
      faults.push(`RemoteHostedEvent (serveur) n'a pas ${field}`);
    }
    if (!new RegExp(`RemoteHostedEvent[\\s\\S]*?var ${field}: String\\?`).test(client)) {
      faults.push(`RemoteHostedEvent (client) n'a pas ${field}`);
    }
  }
  const screen = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpScreen.swift"));
  for (const token of ["client.hosted?.projectName", "client.hosted?.stateLabel"]) {
    if (!screen.includes(token)) faults.push(`IOSSessionOmpScreen ne lit pas ${token}`);
  }
  const model = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpModel.swift"));
  if (!model.includes("client.hosted?.sessionFile")) faults.push("IOSSessionOmpModel ne lit pas client.hosted?.sessionFile");
  return faults;
}

/** (AC-3) Le lancement est exclusif côté serveur, et l'écran n'en offre aucun pendant une session. */
function launchExclusivityFaults(root: string): string[] {
  const faults: string[] = [];
  const actions = code(path.join(root, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteActions.swift"));
  if (!/guard\s+session\.canStart\s+else\s*\{\s*throw\s+ConsoleAPIError\.conflict\(SessionConsoleText\.launchBusy\)/.test(actions)) {
    faults.push("RemoteActions ne refuse pas un second lancement avec SessionConsoleText.launchBusy");
  }
  const model = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpModel.swift"));
  if (!/static func canLaunch\(_ hosted: RemoteHostedEvent\?\)[\s\S]*?case \.idle, \.stopped, \.failed: return true/.test(model)) {
    faults.push("IOSSessionOmpModel.canLaunch n'exclut pas launching/running/stopping");
  }
  const screen = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpScreen.swift"));
  if (!screen.includes("if model.canLaunch")) {
    faults.push("l'écran n'offre le lancement que sous `model.canLaunch`");
  }
  return faults;
}

/** (AC-4) Le sélecteur ne liste que les dépôts connus, et n'envoie que la clé. */
function pickerFaults(root: string): string[] {
  const faults: string[] = [];
  const sheetPath = path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpLaunchSheet.swift");
  if (!fs.existsSync(sheetPath)) return ["IOSSessionOmpLaunchSheet.swift absent"];
  const sheet = code(sheetPath);
  if (!sheet.includes("client.repos()")) faults.push("la feuille de lancement ne lit pas client.repos()");
  if (!sheet.includes("onLaunch(repoKey)")) faults.push("la feuille n'envoie que le repoKey choisi");
  if (sheet.includes("TextField")) faults.push("la feuille de lancement offre une saisie de texte (chemin ?)");
  if (sheet.includes("lastPathComponent")) faults.push("la feuille calcule un nom de dépôt (jeton interdit)");
  return faults;
}

/** (AC-5, AC-12) L'écran relit l'état servi à l'apparition et à chaque retour de connexion. */
function reconnectFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpScreen.swift"));
  if (!/\.onAppear\s*\{\s*model\.appeared\(\)\s*\}/.test(screen)) {
    faults.push("IOSSessionOmpScreen ne relit pas à l'apparition");
  }
  if (!/\.onChange\(of: client\.state\)[\s\S]*?model\.refresh\(\)/.test(screen)) {
    faults.push("IOSSessionOmpScreen ne relit pas au retour de la connexion");
  }
  const model = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpModel.swift"));
  if (!/func appeared\(\)\s*\{\s*refresh\(\)\s*\}/.test(model)) faults.push("appeared() ne relit pas l'état");
  if (!model.includes("client.hostedSession()")) faults.push("refresh() n'appelle pas hostedSession()");
  return faults;
}

/** (AC-8) Le fil est le composant RÉUTILISÉ, aucune ligne de conversation re-dérivée. */
function threadReuseFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpScreen.swift"));
  if (!screen.includes("IOSSessionThreadView(model:")) {
    faults.push("IOSSessionOmpScreen ne monte pas IOSSessionThreadView");
  }
  const model = code(path.join(root, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpModel.swift"));
  if (!model.includes("IOSSessionThreadModel(")) faults.push("le modèle ne monte pas IOSSessionThreadModel");
  for (const { name, src } of [
    { name: "IOSSessionOmpScreen.swift", src: screen },
    { name: "IOSSessionOmpModel.swift", src: model },
  ]) {
    if (/SessionRowBuilder|SessionRow\(/.test(src)) faults.push(`${name} re-dérive les lignes du fil`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Les tests, un par critère STRUCTUREL. Chacun exige l'arbre réel sain PUIS
// plante une faute dans une copie jetable et exige que la garde rougisse.

test("ios-session-omp/AC-1 : les quatre routes existent des deux côtés, la section route et le client porte les méthodes", () => {
  assert.deepEqual(routeFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const router = path.join(copy, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteRouter.swift");
  fs.writeFileSync(router, fs.readFileSync(router, "utf8").replace('"v1/session/launch"', '"v1/session/start"'));
  assert.ok(
    routeFaults(copy).some((f) => f.includes("hosted.launch")),
    "une route serveur manquante doit faire rougir la garde",
  );

  const replant = copyRepo();
  const view = path.join(replant, "omp-console", "ios", "OMPConsoleIOS", "IOSSectionView.swift");
  fs.writeFileSync(view, fs.readFileSync(view, "utf8").replace("section == .session {", "section == .memory {"));
  assert.ok(
    routeFaults(replant).some((f) => f.includes(".session")),
    "un mauvais aiguillage de section doit faire rougir la garde",
  );
});

test("ios-session-omp/AC-2 : le nom du dépôt est servi des deux côtés et l'écran le lit", () => {
  assert.deepEqual(hostedStateFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const payloads = path.join(copy, "omp-console", "Sources", "OMPConsole", "Remote", "Payloads.swift");
  fs.writeFileSync(
    payloads,
    fs.readFileSync(payloads, "utf8").replace("    var projectName: String?\n", ""),
  );
  assert.ok(
    hostedStateFaults(copy).some((f) => f.includes("projectName")),
    "un champ manquant doit faire rougir la garde",
  );
});

test("ios-session-omp/AC-3 : le lancement est exclusif côté serveur et l'écran n'en offre aucun en marche", () => {
  assert.deepEqual(launchExclusivityFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const actions = path.join(copy, "omp-console", "Sources", "OMPConsole", "Remote", "RemoteActions.swift");
  fs.writeFileSync(
    actions,
    fs.readFileSync(actions, "utf8").replace("guard session.canStart else", "guard true else"),
  );
  assert.ok(
    launchExclusivityFaults(copy).some((f) => f.includes("second lancement")),
    "un lancement non exclusif doit faire rougir la garde",
  );
});

test("ios-session-omp/AC-4 : le sélecteur ne liste que les dépôts connus et n'envoie que la clé", () => {
  assert.deepEqual(pickerFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const sheet = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpLaunchSheet.swift");
  fs.writeFileSync(sheet, `${fs.readFileSync(sheet, "utf8")}\nlet saisie = TextField("chemin", text: $x)\n`);
  assert.ok(
    pickerFaults(copy).some((f) => f.includes("saisie")),
    "une saisie de chemin doit faire rougir la garde",
  );
});

test("ios-session-omp/AC-5 : l'écran relit l'état servi à l'apparition et au retour de connexion", () => {
  assert.deepEqual(reconnectFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const screen = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpScreen.swift");
  fs.writeFileSync(screen, fs.readFileSync(screen, "utf8").replace(".onAppear { model.appeared() }", ""));
  assert.ok(
    reconnectFaults(copy).some((f) => f.includes("apparition")),
    "une relecture absente doit faire rougir la garde",
  );
});

test("ios-session-omp/AC-8 : le fil est le composant réutilisé, aucune ligne re-dérivée", () => {
  assert.deepEqual(threadReuseFaults(ROOT), [], "l'arbre réel doit être sain");

  const copy = copyRepo();
  const model = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSSessionOmpModel.swift");
  fs.writeFileSync(model, `${fs.readFileSync(model, "utf8")}\nlet lignes = SessionRowBuilder()\n`);
  assert.ok(
    threadReuseFaults(copy).some((f) => f.includes("re-dérive")),
    "une re-dérivation des lignes doit faire rougir la garde",
  );
});
