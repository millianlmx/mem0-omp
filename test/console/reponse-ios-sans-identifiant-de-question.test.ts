// Les GARDES TEXTUELLES de la feature `reponse-ios-sans-identifiant-de-question` :
// c'est le SEUL fichier qui porte ce slug côté node (invariant `criteria/AC-13`).
//
// Fonctions pures sur le texte source de l'app iOS et du CLI ; chaque faute est
// plantée EN MÉMOIRE (`source.replace(…)`) et doit rougir. Les preuves de
// comportement sont les tests Swift `OMPConsoleIOSTests/IOSAnswerFlowTests.swift`
// (flux de réponse sur un faux Mac) et ceux du paquet (route, version).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { braceBlock, stripComments } from "../support/swift-source.ts";

const APP = path.join(ROOT, "omp-console", "ios", "OMPConsoleIOS");
const CLI = path.join(ROOT, "scripts", "omp-console-api.ts");

const HOME_SHEET = "HomeAnswerSheet.swift";
const CARD_SHEET = "PipelinesCardSheet.swift";
const SHEETS = [HOME_SHEET, CARD_SHEET];
const SCREENS = ["HomeView.swift", "PipelinesScreen.swift"];

/** Plante une faute : le remplacement DOIT changer le source. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

/** Les arguments `( … )` de chaque appel ouvert par `head` (`head` finit par `(`). */
function callsOf(code: string, head: string): string[] {
  const out: string[] = [];
  for (let at = code.indexOf(head); at >= 0; at = code.indexOf(head, at + head.length)) {
    let depth = 0;
    let end = code.length;
    for (let i = at + head.length - 1; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    out.push(code.slice(at, end));
  }
  return out;
}

/** S-3 : chaque réponse à une carte part avec l'identifiant de la question affichée, par le flux partagé. */
function idFaults(sources: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const name of SHEETS) {
    const code = sources.get(name) ?? "";
    const calls = callsOf(code, "client.answer(");
    if (calls.length === 0) faults.push(`${name} : aucun client.answer(`);
    calls.forEach((call, i) => {
      if (!call.includes("toolCallId: toolCallId")) faults.push(`${name} : client.answer( n°${i + 1} sans toolCallId: toolCallId`);
    });
    if (!code.includes("IOSAnswerFlow.submit(")) faults.push(`${name} : la réponse ne passe pas par IOSAnswerFlow.submit(`);
  }
  return faults;
}

/** S-5 : la feuille prévient son écran puis se ferme ; l'écran pose l'alerte dans `onDismiss`. */
function goneFaults(sources: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const name of SCREENS) {
    const code = sources.get(name) ?? "";
    if (!code.includes("onQuestionGone:")) faults.push(`${name} : la feuille ne reçoit pas onQuestionGone:`);
    const at = code.indexOf("onDismiss: {");
    if (at < 0) {
      faults.push(`${name} : la feuille n'a pas d'onDismiss:`);
      continue;
    }
    if (!braceBlock(code, at + "onDismiss: ".length).includes("IOSHomeText.answerQuestionGone")) {
      faults.push(`${name} : l'alerte « question partie » n'est pas posée dans onDismiss`);
    }
  }
  for (const name of SHEETS) {
    if (!/onQuestionGone\(\)\s*\n\s*dismiss\(\)/.test(sources.get(name) ?? "")) {
      faults.push(`${name} : onQuestionGone() n'est pas suivi de dismiss()`);
    }
  }
  return faults;
}

/** S-4 : les deux feuilles adoptent la nouvelle question et ne vident jamais le texte de la réponse. */
function adoptFaults(sources: Map<string, string>): string[] {
  const faults: string[] = [];
  for (const name of SHEETS) {
    const code = sources.get(name) ?? "";
    if (!code.includes(".adopt(")) faults.push(`${name} : la nouvelle question n'est pas adoptée (.adopt()`);
    for (const reset of [/\banswer\.text\s*=\s*""/, /\bdraft\.text\s*=\s*""/]) {
      if (reset.test(code)) faults.push(`${name} : le texte saisi est vidé (${reset.source})`);
    }
  }
  return faults;
}

/** S-3 : la branche `answer` du CLI exige `--question` et l'envoie comme `toolCallId`. */
function cliFaults(script: string): string[] {
  const at = script.indexOf('case "answer": {');
  if (at < 0) return ["omp-console-api.ts : pas de branche answer"];
  const branch = braceBlock(script, at + 'case "answer": '.length);
  const faults: string[] = [];
  if (!branch.includes('"--question est requis"')) faults.push("omp-console-api.ts : answer n'exige pas --question");
  if (!branch.includes("toolCallId")) faults.push("omp-console-api.ts : answer n'envoie pas toolCallId");
  return faults;
}

/** Les sources (sans commentaires) des feuilles et des écrans, par nom de fichier. */
const sources = () =>
  new Map([...SHEETS, ...SCREENS].map((name) => [name, stripComments(fs.readFileSync(path.join(APP, name), "utf8"))]));

test("reponse-ios-sans-identifiant-de-question/AC-5 : les deux feuilles envoient l'identifiant de la question affichée", () => {
  const all = sources();
  assert.deepEqual(idFaults(all), [], "l'arbre réel doit être sain");

  // Faute plantée : la fiche Pipelines envoie une réponse libre sans identifiant ⇒ rouge.
  const card = plant(all.get(CARD_SHEET)!, (s) => s.replace(/text: text,\s*\n\s*toolCallId: toolCallId/, "text: text"));
  assert.ok(idFaults(new Map(all).set(CARD_SHEET, card)).some((f) => f.includes(CARD_SHEET)), "une réponse sans identifiant doit rougir");

  // Faute plantée : l'Accueil contourne le flux partagé ⇒ rouge.
  const home = plant(all.get(HOME_SHEET)!, (s) => s.replace("IOSAnswerFlow.submit(", "IOSAnswerFlow.other("));
  assert.ok(idFaults(new Map(all).set(HOME_SHEET, home)).some((f) => f.includes("IOSAnswerFlow.submit")), "un envoi hors du flux doit rougir");
});

test("reponse-ios-sans-identifiant-de-question/AC-9 : la feuille se ferme et l'écran signale la question partie", () => {
  const all = sources();
  assert.deepEqual(goneFaults(all), [], "l'arbre réel doit être sain");

  // Faute plantée : l'Accueil pose l'alerte hors d'onDismiss (pendant la feuille) ⇒ rouge.
  const home = plant(all.get("HomeView.swift")!, (s) => s.replace("onDismiss: {", "onDismiss: { }, other: {"));
  assert.ok(goneFaults(new Map(all).set("HomeView.swift", home)).some((f) => f.includes("onDismiss")), "une alerte hors d'onDismiss doit rougir");

  // Faute plantée : la fiche Pipelines ne se ferme plus après avoir prévenu ⇒ rouge.
  const card = plant(all.get(CARD_SHEET)!, (s) => s.replace(/(onQuestionGone\(\)\s*\n\s*)dismiss\(\)/, "$1busy = false"));
  assert.ok(goneFaults(new Map(all).set(CARD_SHEET, card)).some((f) => f.includes(CARD_SHEET)), "une fiche qui reste ouverte doit rougir");
});

test("reponse-ios-sans-identifiant-de-question : les feuilles adoptent la nouvelle question sans vider le texte (B-4, S-4)", () => {
  const all = sources();
  assert.deepEqual(adoptFaults(all), [], "l'arbre réel doit être sain");

  // Faute plantée : la fiche vide le texte avant l'envoi ⇒ rouge.
  const card = plant(all.get(CARD_SHEET)!, (s) => s.replace("submitAnswer(.custom(answer.text))", 'submitAnswer(.custom(answer.text)); answer.text = ""'));
  assert.ok(adoptFaults(new Map(all).set(CARD_SHEET, card)).some((f) => f.includes("vidé")), "un texte vidé doit rougir");

  // Faute plantée : l'Accueil n'adopte plus la nouvelle question ⇒ rouge.
  const home = plant(all.get(HOME_SHEET)!, (s) => s.replace("draft.adopt(next)", "_ = next"));
  assert.ok(adoptFaults(new Map(all).set(HOME_SHEET, home)).some((f) => f.includes(".adopt(")), "une question non adoptée doit rougir");
});

test("reponse-ios-sans-identifiant-de-question : le CLI exige l'identifiant de question (B-1, S-3)", () => {
  const script = fs.readFileSync(CLI, "utf8");
  assert.deepEqual(cliFaults(script), [], "le CLI réel doit être sain");

  // Faute plantée : la branche answer n'exige plus --question ⇒ rouge.
  const lax = plant(script, (s) => s.replace('"--question est requis"', '"identifiant facultatif"'));
  assert.ok(cliFaults(lax).some((f) => f.includes("--question")), "un --question facultatif doit rougir");
});
