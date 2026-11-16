// La GARDE TEXTUELLE du câblage de l'appairage de la feature `memoire-ios-une-seule-lecture-de-portee` :
// un seul test, `…/AC-14`, et c'est le SEUL fichier qui porte ce slug (invariant `criteria/AC-13`).
//
// Les tests Swift (IOSMemoireUneLectureTests) rejouent `configure` puis `reload` quand `pairings` a
// changé ; cette garde fixe que l'écran le fait bien : `onMemoryConfigured` observe le compteur
// `memory.pairings` (un code vers la même adresse ne change aucune autre valeur publiée), l'écran garde
// `.onMemoryConfigured(client)`, `configure` augmente le compteur et `forget()` jamais. Fonctions pures
// sur le texte source, commentaires retirés ; chaque faute est plantée EN MÉMOIRE.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";
import { memberBody, stripComments } from "../support/swift-source.ts";

const CONNECTION_VIEW = path.join("omp-console", "ios", "OMPConsoleIOS", "Design", "IOSConnectionStateView.swift");
const SCREEN = path.join("omp-console", "ios", "OMPConsoleIOS", "IOSMemoryScreen.swift");
const ACCESS = path.join("omp-console", "Sources", "ConsoleClient", "MemoryAccess.swift");

type Sources = Record<string, string>;

function wiringFaults(sources: Sources): string[] {
  const faults: string[] = [];
  const code = (file: string) => stripComments(sources[file] ?? "");

  const trigger = memberBody(code(CONNECTION_VIEW), "func onMemoryConfigured(");
  if (!trigger.includes("onChange(of: memory.pairings)"))
    faults.push("onMemoryConfigured n'observe pas memory.pairings");
  if (!trigger.includes("perform()")) faults.push("onMemoryConfigured n'appelle pas perform()");
  for (const forbidden of ["isConfigured", "baseURL"]) {
    if (trigger.includes(forbidden)) faults.push(`onMemoryConfigured observe « ${forbidden} » (un code identique ne le change pas)`);
  }

  if (!code(SCREEN).includes(".onMemoryConfigured(client)"))
    faults.push("IOSMemoryScreen sans .onMemoryConfigured(client)");

  const access = code(ACCESS);
  if (!memberBody(access, "public func configure(").includes("pairings &+= 1"))
    faults.push("MemoryAccess.configure n'augmente pas pairings");
  if (memberBody(access, "public func forget()").includes("pairings"))
    faults.push("MemoryAccess.forget() touche pairings");
  return faults;
}

/** La faute plantée doit changer le source, sinon elle ne prouve rien. */
function plant(source: string, change: (s: string) => string): string {
  const after = change(source);
  assert.notEqual(after, source, "la faute plantée n'a rien changé");
  return after;
}

test("memoire-ios-une-seule-lecture-de-portee/AC-14 : l'écran Mémoire relit à chaque code d'appairage accepté", () => {
  const sources: Sources = Object.fromEntries(
    [CONNECTION_VIEW, SCREEN, ACCESS].map((file) => [file, fs.readFileSync(path.join(ROOT, file), "utf8")]),
  );
  assert.deepEqual(wiringFaults(sources), []);

  const red = (file: string, change: (s: string) => string, needle: string) => {
    const faults = wiringFaults({ ...sources, [file]: plant(sources[file]!, change) });
    assert.ok(
      faults.some((f) => f.includes(needle)),
      `${needle} doit rougir : ${JSON.stringify(faults)}`,
    );
  };

  // Le déclencheur revient à l'observation de `isConfigured`.
  red(CONNECTION_VIEW, (s) => s.replace("memory.pairings", "memory.isConfigured"), "n'observe pas memory.pairings");

  // L'écran ne branche plus le déclencheur.
  red(SCREEN, (s) => s.replace(".onMemoryConfigured(client)", ".onAppear"), "sans .onMemoryConfigured(client)");

  // `configure` n'augmente plus le compteur.
  red(ACCESS, (s) => s.replace("pairings &+= 1", "_ = 0"), "configure n'augmente pas pairings");

  // `forget()` l'augmente.
  red(
    ACCESS,
    (s) => s.replace("public func forget() async {", "public func forget() async {\n        pairings &+= 1"),
    "forget() touche pairings",
  );
});
