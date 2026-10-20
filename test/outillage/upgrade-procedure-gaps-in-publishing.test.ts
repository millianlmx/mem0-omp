// Gestes de mise à jour prescrits par PUBLISHING.md § « Mettre à jour » : chaque
// sous-section doit citer ses commandes dans l'ordre où on les tape, et le README
// de la console doit renvoyer à cette procédure au lieu d'en porter une partielle.
// La règle d'ordre est une fonction pure ; sa capacité à échouer est prouvée sur
// des copies mutées EN MÉMOIRE des sous-sections réelles, sans écrire de fichier.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../support/repo.ts";

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Section `## <titre>` d'un document, jusqu'à la section suivante. */
function section(doc: string, title: string): string {
  const lines = doc.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  assert.notEqual(start, -1, `section « ${title} » absente du document`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Sous-section `### <titre>` de la section, jusqu'au titre `###`/`##` suivant. */
function subsection(sectionText: string, title: string): string {
  const lines = sectionText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${title}`);
  assert.notEqual(start, -1, `sous-section « ${title} » absente de PUBLISHING.md § Mettre à jour`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("### ") || line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Texte aplati : un retour à la ligne dans un paragraphe ne sépare pas un geste. */
const flat = (text: string) => text.replace(/\s+/g, " ");

type Gesture = { label: string; marker: string };

const MARKETPLACE_UPDATE: Gesture = {
  label: "marketplace update",
  marker: "omp plugin marketplace update mem0-omp",
};
const UPGRADE: Gesture = { label: "omp plugin upgrade", marker: "omp plugin upgrade omp-mem0-req@mem0-omp" };
const SERVICE_INSTALL: Gesture = { label: "/service install", marker: "/service install" };
const PLUGIN_LIST: Gesture = { label: "vérification plugin (omp plugin list)", marker: "omp plugin list" };
const PLUGIN_LINK_TARGET: Gesture = {
  label: "vérification plugin (lien node_modules)",
  marker: "ls -la ~/.omp/plugins/node_modules/omp-mem0-req",
};
const SERVICE_STATUS: Gesture = { label: "vérification service (/service status)", marker: "/service status" };
const LINK: Gesture = { label: "omp plugin link", marker: "omp plugin link <worktree>" };

const INSTALL_SEQUENCE: Gesture[] = [
  MARKETPLACE_UPDATE,
  UPGRADE,
  SERVICE_INSTALL,
  PLUGIN_LIST,
  PLUGIN_LINK_TARGET,
  SERVICE_STATUS,
];

const BRANCH_SEQUENCE: Gesture[] = [
  LINK,
  SERVICE_INSTALL,
  PLUGIN_LIST,
  PLUGIN_LINK_TARGET,
  SERVICE_STATUS,
  MARKETPLACE_UPDATE,
  UPGRADE,
  SERVICE_INSTALL,
  PLUGIN_LIST,
  PLUGIN_LINK_TARGET,
  SERVICE_STATUS,
];

/**
 * Violations de la règle d'ordre : chaque geste doit apparaître après le
 * précédent. Un marker absent du texte est « manquant » ; présent seulement
 * avant sa place, il est « mal ordonné ».
 */
function procedureViolations(text: string, sequence: Gesture[]): string[] {
  const body = flat(text);
  const violations: string[] = [];
  let cursor = 0;
  let previous: Gesture | undefined;
  for (const gesture of sequence) {
    const at = body.indexOf(gesture.marker, cursor);
    if (at !== -1) {
      cursor = at + gesture.marker.length;
      previous = gesture;
    } else if (body.includes(gesture.marker)) {
      // Atteignable seulement si le curseur a avancé, donc après un geste trouvé.
      const before = previous ? previous.label : "début de la procédure";
      violations.push(`geste mal ordonné : « ${before} » doit précéder « ${gesture.label} »`);
    } else {
      violations.push(`geste manquant : « ${gesture.label} »`);
    }
  }
  return violations;
}

/** Fenêtre aplatie entre la fin de `from` et la première occurrence de `to` qui suit. */
function windowBetween(text: string, from: string, to: string): string {
  const body = flat(text);
  const start = body.indexOf(from);
  assert.notEqual(start, -1, `« ${from} » absent`);
  const end = body.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `« ${to} » absent après « ${from} »`);
  return body.slice(start + from.length, end);
}

/** Sous-section de PUBLISHING.md § « Mettre à jour », relue à chaque test. */
const procedure = (title: string) => subsection(section(read("PUBLISHING.md"), "Mettre à jour"), title);
const INSTALL = "Installer une nouvelle version";
const BRANCH = "Tester une branche avant sa release";

test("upgrade-procedure-gaps-in-publishing/AC-1 : l'installation enchaîne marketplace update, upgrade, /service install puis les vérifications plugin et service", () => {
  assert.deepEqual(procedureViolations(procedure(INSTALL), INSTALL_SEQUENCE), []);
});

test("upgrade-procedure-gaps-in-publishing/AC-2 : le pas /service install exige une session ouverte après l'upgrade et aucun run en cours", () => {
  const step = windowBetween(procedure(INSTALL), UPGRADE.marker, SERVICE_INSTALL.marker);
  for (const phrase of [
    "session OMP ouverte après l'upgrade",
    "aucun run de pipeline ne tourne",
    "interrompt le maillon en cours",
  ]) {
    assert.ok(step.includes(phrase), `pas /service install sans « ${phrase} » : ${step}`);
  }
});

test("upgrade-procedure-gaps-in-publishing/AC-3 : le pas marketplace update dit que l'upgrade seul réinstalle l'ancienne version", () => {
  const step = windowBetween(procedure(INSTALL), MARKETPLACE_UPDATE.marker, UPGRADE.marker);
  for (const phrase of ["réinstalle l'ancienne version", "« Upgraded »", "sans erreur"]) {
    assert.ok(step.includes(phrase), `pas marketplace update sans « ${phrase} » : ${step}`);
  }
});

test("upgrade-procedure-gaps-in-publishing/AC-5 : tester une branche par link puis revenir à la version publiée, chaque fois suivi de /service install et des vérifications", () => {
  assert.deepEqual(procedureViolations(procedure(BRANCH), BRANCH_SEQUENCE), []);
});

test("upgrade-procedure-gaps-in-publishing/AC-6 : le README de la console renvoie à PUBLISHING.md sans procédure de mise à jour", () => {
  const readme = flat(read("omp-console/README.md"));
  assert.ok(
    readme.includes("`PUBLISHING.md` § « Mettre à jour »"),
    "omp-console/README.md ne renvoie pas à PUBLISHING.md § « Mettre à jour »",
  );
  const partial = readme.match(/plugin upgrade|marketplace upgrade|plugin link/);
  assert.equal(partial, null, `omp-console/README.md porte encore un geste de mise à jour : ${partial?.[0]}`);
});

test("upgrade-procedure-gaps-in-publishing/AC-8 : retirer un geste ou placer marketplace update après l'upgrade fait échouer le contrôle en nommant le geste", () => {
  const procedures: [string, Gesture[]][] = [
    [INSTALL, INSTALL_SEQUENCE],
    [BRANCH, BRANCH_SEQUENCE],
  ];
  for (const [title, sequence] of procedures) {
    const text = procedure(title);
    // (c) Témoin : la sous-section réelle est conforme.
    assert.deepEqual(procedureViolations(text, sequence), [], `${title} : témoin non conforme`);

    // (a) Un geste retiré partout est nommé « manquant ».
    for (const gesture of new Set(sequence)) {
      const mutated = text.split(gesture.marker).join("");
      const violations = procedureViolations(mutated, sequence);
      assert.ok(
        violations.includes(`geste manquant : « ${gesture.label} »`),
        `${title} sans « ${gesture.marker} » : ${JSON.stringify(violations)}`,
      );
    }

    // (b) marketplace update déplacé juste après le premier upgrade : « mal ordonné ».
    const stripped = text.split(MARKETPLACE_UPDATE.marker).join("");
    const after = stripped.indexOf(UPGRADE.marker) + UPGRADE.marker.length;
    assert.ok(after >= UPGRADE.marker.length, `${title} : « ${UPGRADE.marker} » absent`);
    const reordered = `${stripped.slice(0, after)}\n${MARKETPLACE_UPDATE.marker}${stripped.slice(after)}`;
    const violations = procedureViolations(reordered, sequence);
    assert.ok(
      violations.includes("geste mal ordonné : « marketplace update » doit précéder « omp plugin upgrade »"),
      `${title} avec marketplace update après l'upgrade : ${JSON.stringify(violations)}`,
    );
  }
});
