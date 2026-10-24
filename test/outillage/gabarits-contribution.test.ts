// Critères de la feature gabarits-contribution : SECURITY.md, les gabarits
// d'issue et de PR de `.github/`. Ils sont courts et en prose ; ce qui se juge,
// c'est qu'ils existent, que chaque chemin qu'ils citent existe, et que le
// signalement d'une faille passe par SECURITY.md, jamais par une issue publique.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT } from "../support/repo.ts";

const GABARITS = [
  "SECURITY.md",
  ".github/pull_request_template.md",
  ...fs
    .readdirSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE"))
    .filter((nom) => nom.endsWith(".md"))
    .map((nom) => `.github/ISSUE_TEMPLATE/${nom}`),
];

/** Les chemins du dépôt cités en code (`…`) : un dossier `x/` ou un fichier à extension connue. */
function cheminsCites(texte: string): string[] {
  return [...texte.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1]!)
    .filter((mot) => /^[\w.-]+(\/[\w.-]+)*\/$/.test(mot) || /^[\w./-]+\.(md|sh|ts|json)$/.test(mot));
}

test("gabarits-contribution/AC-1 : SECURITY.md, un gabarit de PR et au moins un gabarit d'issue existent, et chaque chemin qu'ils citent existe", () => {
  assert.ok(GABARITS.filter((g) => g.startsWith(".github/ISSUE_TEMPLATE/")).length >= 2, GABARITS.join(", "));
  for (const gabarit of GABARITS) {
    const texte = fs.readFileSync(path.join(ROOT, gabarit), "utf8");
    for (const chemin of cheminsCites(texte)) {
      assert.ok(fs.existsSync(path.join(ROOT, chemin)), `${gabarit} cite ${chemin}, absent du dépôt`);
    }
  }
  // Chaque gabarit d'issue a l'en-tête que GitHub lit pour le proposer.
  for (const gabarit of GABARITS.filter((g) => g.startsWith(".github/ISSUE_TEMPLATE/"))) {
    const tete = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(ROOT, gabarit), "utf8"))?.[1] ?? "";
    assert.match(tete, /^name: \S/m, `${gabarit} : name absent`);
    assert.match(tete, /^about: \S/m, `${gabarit} : about absent`);
  }
});

test("gabarits-contribution/AC-2 : une faille se signale en privé — le gabarit de bug renvoie à SECURITY.md, que CONTRIBUTING.md cite", () => {
  const bug = fs.readFileSync(path.join(ROOT, ".github", "ISSUE_TEMPLATE", "bug.md"), "utf8");
  assert.ok(bug.includes("SECURITY.md"), "le gabarit de bug ne renvoie pas à SECURITY.md");
  assert.ok(
    fs.readFileSync(path.join(ROOT, "CONTRIBUTING.md"), "utf8").includes("](SECURITY.md)"),
    "CONTRIBUTING.md ne lie pas SECURITY.md",
  );
  const securite = fs.readFileSync(path.join(ROOT, "SECURITY.md"), "utf8");
  assert.match(securite, /Report a\s+vulnerability/, "SECURITY.md ne nomme pas le signalement privé de GitHub");
});
