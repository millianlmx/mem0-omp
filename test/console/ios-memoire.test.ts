// Les GARDES TEXTUELLES de la feature `ios-memoire` (BR-5) : chaque critère
// `ios-memoire/AC-1..AC-10` a son test ici, et c'est le SEUL fichier `test/*.test.ts`
// qui porte ce slug (invariant `criteria/AC-13`).
//
// Deux règles structurent ce fichier, comme `test/console/ios-projet.test.ts` :
//  1. tout ce qui doit ÉCHOUER est planté dans une COPIE JETABLE du dépôt (jamais
//     l'arbre réel, qui doit rester publiable) ;
//  2. les vérifications qui portent sur l'arbre réel tournent partout.
//
// Le contrat `.omp/pipeline/contract.md` est GITIGNORÉ (absent d'une copie git et
// de la CI) : ses marqueurs ne sont éprouvés que sous `fs.existsSync` ET quand il
// se nomme lui-même (`feature \`ios-memoire\``).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, sharedRepo } from "../support/repo.ts";
import { readIfExists, stripFullLineComments } from "../support/swift-source.ts";

/** La copie du dépôt où l'on plante les fautes, remise à neuf à chaque `fresh()`. */
const shared = sharedRepo("ios-memoire-copie-");
const CONTRACT = path.join(ROOT, ".omp", "pipeline", "contract.md");

/** Le source débarrassé de ses commentaires `/* … *\/` et de ses lignes `//`. */
function code(file: string): string {
  return stripFullLineComments(fs.readFileSync(file, "utf8"));
}

/** Le source d'un fichier, commentaires retirés, ou la chaîne vide s'il est absent. */
function source(file: string): string {
  return stripFullLineComments(readIfExists(file));
}

/** La source d'un fichier de l'app iOS (vide s'il est absent). */
function appFile(root: string, name: string): string {
  return source(path.join(root, "omp-console", "ios", "OMPConsoleIOS", name));
}

/** Les sources Swift de la SECTION Mémoire de l'app, commentaires retirés. */
function memoryAppCode(root: string = ROOT): string {
  const appDir = path.join(root, "omp-console", "ios", "OMPConsoleIOS");
  const files = fs
    .readdirSync(appDir)
    .filter((name) => name.startsWith("IOSMemory") && name.endsWith(".swift"))
    .sort();
  assert.ok(files.length > 0, "aucune source de la section Mémoire dans l'app iOS");
  return files.map((name) => code(path.join(appDir, name))).join("\n");
}

/** La source d'un fichier du noyau macOS, commentaires retirés. */
function shellCode(root: string, ...rest: string[]): string {
  return source(path.join(root, "omp-console", "Sources", "OMPConsole", ...rest));
}

/** La source d'un fichier du client, commentaires retirés. */
function clientCode(root: string, name: string): string {
  return source(path.join(root, "omp-console", "Sources", "ConsoleClient", name));
}

/** Le corps d'une déclaration `struct <nom> … { … }`. */
function structBlock(text: string, name: string): string {
  const start = text.indexOf(`struct ${name}`);
  if (start === -1) return "";
  const end = text.indexOf("\n}", start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

/** Le contrat de CETTE feature, ou "" : gitignoré, et jamais celui d'une autre. */
function contractText(): string {
  if (!fs.existsSync(CONTRACT)) return "";
  const text = fs.readFileSync(CONTRACT, "utf8");
  return text.includes("feature `ios-memoire`") ? text : "";
}

/** Le contrat trace son critère (`AC-<n> (…)`), quand il est là ET se nomme. */
function contractFaults(...ids: string[]): string[] {
  const contract = contractText();
  if (contract === "") return [];
  return ids.filter((id) => !contract.includes(`${id} (`)).map((id) => `le contrat ne trace pas ${id}`);
}

// ---------------------------------------------------------------------------
// AC-1 : le sommaire est lu par pages bornées sur la mémoire du serveur, et rendu
// par les mots du noyau.

/** Les manques de la lecture du sommaire (AC-1). Vide quand tout est là. */
function relayFaults(root: string): string[] {
  const faults: string[] = [];
  const payloads = clientCode(root, "MemoryPayloads.swift");
  const page = structBlock(payloads, "RemoteMemoryPagePayload");
  if (!page.includes("scope: String?")) faults.push("MemoryPayloads.swift : RemoteMemoryPagePayload sans scope");
  if (!page.includes("nextOffset: Int?")) faults.push("MemoryPayloads.swift : RemoteMemoryPagePayload sans nextOffset");
  const reader = clientCode(root, "MemoryReader.swift");
  if (!/public static let pageSize = 100/.test(reader)) faults.push("MemoryReader.pageSize n'est pas figé à 100");
  if (!reader.includes("Self.pageSize")) faults.push("MemoryReader.page ne borne pas par MemoryReader.pageSize");
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (!screen.includes("MemoryText.summaryCount(")) faults.push("l'écran n'emploie pas MemoryText.summaryCount");
  if (!screen.includes("IOSMemoryText.loadingMore"))
    faults.push("l'écran ne dit pas le chargement de la page suivante");
  const model = appFile(root, "IOSMemoryModel.swift");
  if (
    !/static func screen\(\s*connection: IOSConnectionStatus,\s*load: IOSMemoryLoad,\s*mode: IOSMemoryMode,\s*summary: IOSMemorySummary\?\s*\)/.test(
      model,
    )
  ) {
    faults.push("IOSMemoryModel.screen(connection:load:mode:summary:) absent");
  }
  // Parité macOS : les trois « rien trouvé » portent les mêmes noms des deux côtés.
  const shellModel = shellCode(root, "Memory", "MemoryModel.swift");
  for (const stateCase of ["searchEmptyNoMatch", "searchEmptyNoScore", "searchEmptyBelowThreshold"]) {
    if (!shellModel.includes(stateCase)) faults.push(`MemoryModel (macOS) ne porte pas ${stateCase}`);
    if (!model.includes(stateCase)) faults.push(`IOSMemoryModel ne porte pas ${stateCase}`);
  }
  faults.push(...contractFaults("AC-1"));
  return faults;
}

test("ios-memoire/AC-1 : le sommaire est lu par pages bornées sur la mémoire du serveur, et rendu par les mots du noyau", () => {
  assert.deepEqual(relayFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleClient", "MemoryReader.swift");
  fs.writeFileSync(target, code(target).replaceAll("Self.pageSize", "Int.max"));
  assert.ok(relayFaults(copy).length > 0, "une borne de sommaire retirée doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-2 : la feuille rend les cinq faits, sans aucun geste d'écriture.

/** Les manques de la feuille de détail (AC-2). */
function detailFaults(root: string): string[] {
  const faults: string[] = [];
  const detail = appFile(root, "IOSMemoryDetailView.swift");
  for (const token of [
    "MemoryText.identifierLabel",
    "MemoryText.scopeLabel",
    "MemoryText.scoreLabel",
    "Self.text(row)",
  ]) {
    if (!detail.includes(token)) faults.push(`la feuille n'emploie pas ${token}`);
  }
  if (!detail.includes("DisclosureGroup(MemoryText.technicalDetails)"))
    faults.push("les détails techniques ne sont pas repliés");
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (!screen.includes(".sheet(item:")) faults.push("la feuille n'est pas montée par .sheet(item:)");
  for (const forbidden of [
    "memoryGraph(",
    "MemoryText.edit",
    "MemoryText.delete",
    "MemoryText.save",
    "MemoryText.createMemory",
  ]) {
    if (detail.includes(forbidden)) faults.push(`la feuille porte un geste interdit : ${forbidden}`);
  }
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryDetailTests.swift"));
  if (!tests.includes('"ios-memoire/AC-2')) faults.push("IOSMemoryDetailTests ne porte pas le titre ios-memoire/AC-2");
  return faults;
}

test("ios-memoire/AC-2 : la feuille rend les cinq faits, sans aucun geste d'écriture", () => {
  assert.deepEqual(detailFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryDetailView.swift");
  fs.writeFileSync(target, code(target).replace("MemoryText.identifierLabel", "MemoryText.emptyRow"));
  assert.ok(detailFaults(copy).length > 0, "un fait retiré de la feuille doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-3 : vider la requête revient au sommaire déjà lu, sans requête.

/** Les manques du retour au sommaire sans requête (AC-3). */
function blankQueryFaults(root: string): string[] {
  const faults: string[] = [];
  const model = appFile(root, "IOSMemoryModel.swift");
  if (!model.includes("func updateQuery(")) faults.push("updateQuery absent");
  if (!model.includes("trimmingCharacters(in: .whitespacesAndNewlines).isEmpty")) {
    faults.push("updateQuery ne reconnaît pas une requête blanche");
  }
  if (!model.includes("showSummary()")) faults.push("une requête blanche ne revient pas au sommaire");
  if (!model.includes("summaryPage"))
    faults.push("le sommaire lu n'est pas conservé : le retour coûterait une requête");
  const memory = memoryAppCode(root);
  for (const token of [".onChange(of:", ".task(id:"]) {
    if (memory.includes(token)) faults.push(`la section Mémoire relirait à la frappe : ${token}`);
  }
  if (!model.includes("client.memorySearch(")) faults.push("la recherche n'est soumise que dans submitQuery");
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryModelTests.swift"));
  if (!tests.includes('"ios-memoire/AC-3')) faults.push("IOSMemoryModelTests ne porte pas le titre ios-memoire/AC-3");
  return faults;
}

test("ios-memoire/AC-3 : vider la requête revient au sommaire déjà lu, sans requête", () => {
  assert.deepEqual(blankQueryFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryModel.swift");
  const text = code(target).replace(
    "guard text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }",
    "",
  );
  fs.writeFileSync(target, text);
  assert.ok(blankQueryFaults(copy).length > 0, "un blanc qui ne revient pas au sommaire doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-4 : la recherche est EXACTEMENT celle de l'outil `mem0_search`.

/** Les manques de la parité de recherche (AC-4). */
function searchParityFaults(root: string): string[] {
  const faults: string[] = [];
  const config = fs.readFileSync(path.join(root, "omp-mem0-memory", "config.ts"), "utf8");
  const tools = fs.readFileSync(path.join(root, "omp-mem0-memory", "tools.ts"), "utf8");
  const threshold = /SEARCH_THRESHOLD\s*=\s*([0-9.]+)/.exec(config)?.[1];
  const poolMax = /SEARCH_POOL_MAX\s*=\s*([0-9]+)/.exec(config)?.[1];
  const defaultLimit = /params\.limit\s*\?\?\s*([0-9]+)/.exec(tools)?.[1];
  if (threshold !== "0.55") faults.push(`config.ts : SEARCH_THRESHOLD ≠ 0.55 (${threshold})`);
  if (poolMax !== "50") faults.push(`config.ts : SEARCH_POOL_MAX ≠ 50 (${poolMax})`);
  if (defaultLimit !== "6") faults.push(`tools.ts : le défaut de limit n'est pas 6 (${defaultLimit})`);
  const search = source(path.join(root, "omp-console", "Sources", "ConsoleCore", "Memory", "MemoryWire.swift"));
  if (!search.includes(`static let threshold: Double = ${threshold}`))
    faults.push("MemorySearch.threshold ≠ SEARCH_THRESHOLD");
  if (!search.includes(`static let poolMax = ${poolMax}`)) faults.push("MemorySearch.poolMax ≠ SEARCH_POOL_MAX");
  if (!search.includes(`static let defaultLimit = ${defaultLimit}`))
    faults.push("MemorySearch.defaultLimit ≠ le défaut de tools.ts");
  const reader = clientCode(root, "MemoryReader.swift");
  if (!reader.includes("MemorySearch.select(")) faults.push("le lecteur n'emploie pas MemorySearch.select");
  if (!reader.includes("MemorySearch.pool(requested:"))
    faults.push("le lecteur n'emploie pas MemorySearch.pool(requested:)");
  const access = clientCode(root, "MemoryAccess.swift");
  if (!access.includes("public func memorySearch(query: String, scope: String?, limit: Int?)")) {
    faults.push("l'accès n'expose pas memorySearch(query:scope:limit:)");
  }
  if (!appFile(root, "IOSMemoryModel.swift").includes("client.memorySearch(query: query, scope: nil, limit: nil)")) {
    faults.push("l'écran ne cherche pas par client.memorySearch");
  }
  faults.push(...contractFaults("AC-4"));
  return faults;
}

test("ios-memoire/AC-4 : la recherche est exactement celle de l'outil mem0_search", () => {
  assert.deepEqual(searchParityFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-mem0-memory", "config.ts");
  fs.writeFileSync(
    target,
    fs.readFileSync(target, "utf8").replace("SEARCH_THRESHOLD = 0.55", "SEARCH_THRESHOLD = 0.6"),
  );
  assert.ok(searchParityFaults(copy).length > 0, "un seuil divergen du plugin doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-5 : trois « rien trouvé » distincts, jamais le sommaire à la place.

/** Les manques des trois états vides de recherche (AC-5). */
function searchEmptyFaults(root: string): string[] {
  const faults: string[] = [];
  const screen = appFile(root, "IOSMemoryScreen.swift");
  for (const token of ["MemoryText.noMatch", "MemoryText.noSemanticScore", "MemoryText.belowThreshold"]) {
    if (!screen.includes(token)) faults.push(`l'écran n'emploie pas ${token}`);
  }
  const model = appFile(root, "IOSMemoryModel.swift");
  for (const stateCase of ["searchEmptyNoMatch", "searchEmptyNoScore", "searchEmptyBelowThreshold"]) {
    if (!model.includes(stateCase)) faults.push(`la dérivation ne rend pas ${stateCase}`);
  }
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryModelTests.swift"));
  for (const title of ["ios-memoire/AC-3", "ios-memoire/AC-5"]) {
    if (!tests.includes(`"${title}`)) faults.push(`IOSMemoryModelTests ne porte pas le titre ${title}`);
  }
  faults.push(...contractFaults("AC-5"));
  return faults;
}

test("ios-memoire/AC-5 : trois « rien trouvé » distincts, jamais le sommaire à la place", () => {
  assert.deepEqual(searchEmptyFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
  fs.writeFileSync(target, code(target).replaceAll("MemoryText.belowThreshold", "MemoryText.noMatch"));
  assert.ok(searchEmptyFaults(copy).length > 0, "un état vide confondu avec un autre doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-6 : « Mémoire indisponible » se dit sans adresse ni détail amont, avec son remède.

/** Les manques de la panne de la mémoire (AC-6). */
function unavailableFaults(root: string): string[] {
  const faults: string[] = [];
  const reader = clientCode(root, "MemoryReader.swift");
  if (!/case 503: throw MemoryReadError\.unavailable/.test(reader)) {
    faults.push("le lecteur ne distingue pas le service indisponible (503)");
  }
  const translator = appFile(root, "IOSMemoryErrorText.swift");
  if (!/case \.unavailable: \.serviceUnavailable/.test(translator))
    faults.push("le traducteur ne rend pas « service indisponible »");
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (!screen.includes("MemoryText.retry")) faults.push("l'écran n'offre pas « Réessayer »");
  if (!screen.includes("tone: .danger")) faults.push("le bandeau d'indisponibilité n'est pas rouge");
  if (!screen.includes("IOSMemoryErrorText.message(for:")) faults.push("l'écran ne lit pas le message du traducteur");
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryModelTests.swift"));
  if (!tests.includes('"ios-memoire/AC-6')) faults.push("IOSMemoryModelTests ne porte pas le titre ios-memoire/AC-6");
  faults.push(...contractFaults("AC-6"));
  return faults;
}

test("ios-memoire/AC-6 : « Mémoire indisponible » se dit sans adresse ni détail amont, avec son remède", () => {
  assert.deepEqual(unavailableFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
  fs.writeFileSync(target, code(target).replaceAll("IOSMemoryErrorText.message(for:", "String(describing:"));
  assert.ok(unavailableFaults(copy).length > 0, "une panne sans traducteur doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-7 : sans projet, la page est vide ET le service n'est pas appelé.

/** Les manques du cas « aucun projet » (AC-7). */
function noProjectFaults(root: string): string[] {
  const faults: string[] = [];
  const reads = clientCode(root, "MemoryReader.swift");
  const early = reads.indexOf("scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil");
  const firstAll = reads.indexOf("try await all(scope: scope)");
  if (early === -1) faults.push("MemoryReader.page ne rend pas la page vide sans portée");
  if (firstAll === -1) faults.push("la lecture de la portée est absente de MemoryReader");
  if (early !== -1 && firstAll !== -1 && early > firstAll) {
    faults.push("la page vide est rendue APRÈS l'appel au service");
  }
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (!screen.includes("MemoryText.noProjectTitle"))
    faults.push("l'écran n'emploie pas le titre partagé noProjectTitle");
  if (!screen.includes("IOSMemoryText.noProjectDetail"))
    faults.push("l'écran n'emploie pas le détail reformulé de l'app");
  const model = appFile(root, "IOSMemoryModel.swift");
  if (!/guard let scope = payload\.scope else \{ return \.noProject \}/.test(model)) {
    faults.push("une page à portée nulle ne rend pas noProject");
  }
  if (/case \.noProject:[\s\S]{0,120}searchable/.test(screen))
    faults.push("le champ de recherche est offert en noProject");
  faults.push(...contractFaults("AC-7"));
  return faults;
}

test("ios-memoire/AC-7 : sans projet, la page est vide et le service n'est pas appelé", () => {
  assert.deepEqual(noProjectFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "Sources", "ConsoleClient", "MemoryReader.swift");
  fs.writeFileSync(
    target,
    code(target).replace(
      "scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil",
      "scope: scope, total: 0, offset: 0, rows: [], nextOffset: nil",
    ),
  );
  assert.ok(noProjectFaults(copy).length > 0, "un retour anticipé supprimé doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-8 : quand le serveur ne répond plus, une panne de TRANSPORT n'est jamais une
// cause mémoire. L'écran « mémoire non reliée » lui-même est le composant partagé
// (feature etats-non-connecte-heterogenes-ios, IOSConnectionStatusTests).

/** Les manques de la classification des pannes du client (AC-8). */
function clientStateFaults(root: string): string[] {
  const faults: string[] = [];
  const model = appFile(root, "IOSMemoryModel.swift");
  if (!/IOSMemoryFailure\.of\(/.test(model)) faults.push("le modèle ne classe pas l'erreur par le traducteur");
  if (model.includes("api.message")) faults.push("le modèle relaie un détail brut");
  faults.push(...contractFaults("AC-8"));
  return faults;
}

test("ios-memoire/AC-8 : quand le serveur ne répond plus, la panne est dite par le traducteur", () => {
  assert.deepEqual(clientStateFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryModel.swift");
  fs.writeFileSync(target, code(target).replaceAll("IOSMemoryFailure.of(", "classifyLocally("));
  assert.ok(
    clientStateFaults(copy).length > 0,
    "une panne classée hors du traducteur partagé doit faire rougir la garde",
  );
});

// ---------------------------------------------------------------------------
// AC-9 : rafraîchir à l'ouverture et sur GESTE, jamais en continu.

/** Les manques du rafraîchissement (AC-9). */
function refreshFaults(root: string): string[] {
  const faults: string[] = [];
  const memory = memoryAppCode(root);
  // Le geste de relecture est le tirage système `.refreshable` (ios-gestes-et-retours-natifs,
  // S-2) : seule une scrutation reste interdite.
  for (const token of ["Timer", "Task.sleep", "DispatchQueue"]) {
    if (memory.includes(token)) faults.push(`la section Mémoire porte ${token}`);
  }
  const screen = appFile(root, "IOSMemoryScreen.swift");
  if (!screen.includes(".refreshable { await model.refresh() }"))
    faults.push("le tirage pour actualiser de la liste manque");
  if (!screen.includes(".task {")) faults.push("l'apparition de l'écran ne charge pas");
  const model = appFile(root, "IOSMemoryModel.swift");
  if (!model.includes("inFlight?.cancel()")) faults.push("un chargement en vol n'est pas annulé avant le suivant");
  if (!model.includes("guard Self.gesturesEnabled(client.isConfigured) else { return }")) {
    faults.push("une lecture est possible sans mémoire reliée");
  }
  const tests = source(path.join(root, "omp-console", "ios", "OMPConsoleIOSTests", "IOSMemoryModelTests.swift"));
  if (!tests.includes('"ios-memoire/AC-9')) faults.push("IOSMemoryModelTests ne porte pas le titre ios-memoire/AC-9");
  faults.push(...contractFaults("AC-9"));
  return faults;
}

test("ios-memoire/AC-9 : rafraîchir à l'ouverture et sur geste, jamais en continu", () => {
  assert.deepEqual(refreshFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
  fs.writeFileSync(target, `${code(target)}\nlet minuterie = Timer()\n`);
  assert.ok(refreshFaults(copy).length > 0, "une scrutation ajoutée doit faire rougir la garde");
});

// ---------------------------------------------------------------------------
// AC-10 : lecture seule — ni écriture, ni graphe.

/** Les manques du périmètre de lecture (AC-10). */
function readOnlyFaults(root: string): string[] {
  const faults: string[] = [];
  const memory = memoryAppCode(root);
  // Le graphe est désormais un SECOND mode de la section : seuls les jetons
  // d'ÉCRITURE restent interdits (le mode graphe lit `memoryGraph(`).
  for (const token of ["MemoryText.createMemory", "MemoryText.edit", "MemoryText.delete", "MemoryText.save"]) {
    if (memory.includes(token)) faults.push(`la section Mémoire porte ${token}`);
  }
  const client = clientCode(root, "MemoryReader.swift") + clientCode(root, "MemoryAccess.swift");
  for (const token of [
    "func memoryAdd",
    "func memoryUpdate",
    "func memoryDelete",
    "func memoryWrite",
    '"POST", body: ["text"',
  ]) {
    if (client.includes(token)) faults.push(`le lecteur de la mémoire expose ${token}`);
  }
  const app = memoryAppCode(root);
  if (!app.includes("model.refresh()")) faults.push("aucune lecture n'est déclenchée depuis l'écran");
  if (!app.includes("model.submitQuery()")) faults.push("la recherche n'est pas soumise depuis l'écran");
  faults.push(...contractFaults("AC-10"));
  return faults;
}

test("ios-memoire/AC-10 : lecture seule — aucune écriture, ni sommaire ni graphe", () => {
  assert.deepEqual(readOnlyFaults(ROOT), []);

  const copy = shared.fresh();
  const target = path.join(copy, "omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
  fs.writeFileSync(target, `${code(target)}\nlet fuite = MemoryText.delete\n`);
  assert.ok(readOnlyFaults(copy).length > 0, "un geste d'écriture ajouté doit faire rougir la garde");
});
