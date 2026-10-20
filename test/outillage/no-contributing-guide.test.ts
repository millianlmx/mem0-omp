// Garde de dérive du guide de contribution (CONTRIBUTING.md) : chaque règle
// garde son titre et nomme son juge, chaque chemin cité existe, chaque titre de
// section cité existe dans le fichier visé, chaque option passée à un script est
// une branche du `case` de ce script. Le vérificateur `guideFaults` est pur
// (texte → fautes) : les tests l'éprouvent sur le guide réel et sur des copies
// mutées EN MÉMOIRE de ce guide, jamais sur un texte écrit en dur.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, childEnv, tmpdir } from "../support/repo.ts";
import { AGENTS_BLOCK, MARKER_CLOSE, MARKER_OPEN, ensureBrief } from "../../omp-mem0-memory/brief.ts";

const GUIDE = "CONTRIBUTING.md";
// Constantes plutôt que littéraux : un tableau réduit au seul chemin de check.sh
// classerait ce fichier hors de `--scope=changed` (motif OUTILLAGE de test-files.sh).
const CHECK = "scripts/check.sh";
const TEST_FILES = "scripts/test-files.sh";

type Rule = { heading: string; judges: string[] };

// Les six règles, dans l'ordre du guide. Le juge de la règle 2 est le script
// seul : son option est jugée par le contrôle des options, ce qui laisse la garde
// verte pour toute option que le script accepte.
const RULES: Rule[] = [
  {
    heading: "1. Un fichier de test par slug, un id unique par critère",
    judges: ["test/outillage/criteria.test.ts", "criteria/AC-13"],
  },
  { heading: "2. Lancer les tests touchés", judges: [TEST_FILES] },
  { heading: "3. Respecter les verrous de documentation", judges: ["test/outillage/docs.test.ts"] },
  {
    heading: "4. Aucun bump de version à la main",
    judges: ["scripts/no-manual-bump.sh", "PUBLISHING.md § « Mettre à jour »"],
  },
  {
    heading: "5. Deux catalogues identiques octet pour octet",
    judges: ["diff -q .omp-plugin/marketplace.json .claude-plugin/marketplace.json", CHECK],
  },
  { heading: "6. Un seul juge avant de pousser", judges: [CHECK] },
];

const PATH_WORD = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:md|sh|ts|json|yml)$/;
const SECTION_CITE = /([A-Za-z0-9_./-]+\.md)`?\s*§\s*«\s*([^»]+?)\s*»/g;
const CASE_BRANCH = /^\s*(--[^\s|)]+(?:\s*\|\s*--[^\s|)]+)*)\)/;
const LINK = /\[[^\]]*\]\(CONTRIBUTING\.md\)/;

/** Le guide sous `root`, ou null s'il n'existe pas. */
function readGuide(root: string): string | null {
  const file = path.join(root, GUIDE);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** La section d'une règle, de sa ligne de titre (incluse) à la ligne suivante
 * commençant par `## ` (exclue) ou à la fin ; null si le titre manque. */
function ruleSection(text: string, heading: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end += 1;
  return lines.slice(start, end).join("\n") + (end < lines.length ? "\n" : "");
}

/** Les codes inline `…` d'un texte, avec leur position. */
function inlineCodes(text: string): { index: number; words: string[] }[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => ({
    index: m.index ?? 0,
    words: m[1].split(/\s+/).filter((word) => word !== ""),
  }));
}

/** Les motifs d'option acceptés par un script : les branches `--…)` de son `case`. */
function acceptedOptions(script: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const line of script.split("\n")) {
    const m = CASE_BRANCH.exec(line);
    if (m === null) continue;
    for (const alt of m[1].split("|")) {
      const glob = alt
        .trim()
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      patterns.push(new RegExp(`^${glob}$`));
    }
  }
  return patterns;
}

/** Les fautes du guide, ordonnées (fichier, règles, chemins, titres, options) et
 * dédoublonnées ; vide si le guide est sain. Les chemins sont jugés sous `root`. */
function guideFaults(text: string | null, root: string): string[] {
  if (text === null) return [`fichier absent : ${GUIDE}`];
  const exists = (rel: string) => fs.existsSync(path.join(root, rel));
  const faults: string[] = [];

  for (const rule of RULES) {
    const body = ruleSection(text, rule.heading);
    if (body === null) {
      faults.push(`règle manquante : ${rule.heading}`);
      continue;
    }
    for (const judge of rule.judges) {
      if (!body.includes(judge)) faults.push(`règle « ${rule.heading} » : juge absent : ${judge}`);
    }
  }

  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, "");
  const codes = inlineCodes(prose);
  const cites = [...prose.matchAll(SECTION_CITE)].map((m) => ({
    index: m.index ?? 0,
    file: m[1],
    title: m[2],
  }));

  const cited: { index: number; rel: string }[] = [];
  for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
    const rel = target.split("#")[0];
    if (rel !== "") cited.push({ index: m.index ?? 0, rel });
  }
  for (const code of codes) {
    for (const word of code.words) if (PATH_WORD.test(word)) cited.push({ index: code.index, rel: word });
  }
  for (const cite of cites) cited.push({ index: cite.index, rel: cite.file });
  cited.sort((a, b) => a.index - b.index);
  for (const { rel } of cited) if (!exists(rel)) faults.push(`chemin absent : ${rel}`);

  for (const { file, title } of cites) {
    if (!exists(file)) continue;
    const titled = fs
      .readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .some((line) => /^#{1,6} /.test(line.trim()) && line.trim().replace(/^#{1,6} /, "") === title);
    if (!titled) faults.push(`titre absent : ${file} § « ${title} »`);
  }

  for (const code of codes) {
    code.words.forEach((word, i) => {
      if (!word.endsWith(".sh") || !PATH_WORD.test(word) || !exists(word)) return;
      const accepted = acceptedOptions(fs.readFileSync(path.join(root, word), "utf8"));
      for (let j = i + 1; j < code.words.length && code.words[j].startsWith("--"); j += 1) {
        const option = code.words[j];
        if (!accepted.some((pattern) => pattern.test(option))) {
          faults.push(`option non acceptée par ${word} : ${option}`);
        }
      }
    });
  }

  return [...new Set(faults)];
}

/** Le guide réel ; échoue tout de suite s'il manque. */
function realGuide(): string {
  const text = readGuide(ROOT);
  assert.ok(text !== null, `fichier absent : ${GUIDE}`);
  return text;
}

/** Une copie mutée du guide réel ; la mutation doit avoir pris. */
function mutate(real: string, from: string, to: string): string {
  const copy = real.replace(from, to);
  assert.notEqual(copy, real, `mutation sans effet : ${from}`);
  return copy;
}

test("no-contributing-guide/AC-1 : le guide énonce les six règles, chacune avec son juge réel", () => {
  const real = realGuide();
  assert.deepEqual(guideFaults(real, ROOT), []);
  const scoped = ruleSection(real, RULES[1].heading);
  assert.ok(scoped?.includes(`${TEST_FILES} --scope=changed`), "règle 2 : juge absent");
  for (const rule of RULES) {
    const body = ruleSection(real, rule.heading);
    assert.ok(body !== null, `règle manquante : ${rule.heading}`);
    for (const judge of rule.judges)
      assert.ok(body.includes(judge), `règle « ${rule.heading} » : juge absent : ${judge}`);
  }
  assert.ok(!real.includes("test/docs.test.ts"), "le guide cite test/docs.test.ts");
});

test("no-contributing-guide/AC-2 : les renvois du guide visent des fichiers et des titres présents", () => {
  const real = realGuide();
  for (const link of [
    "[README.md § « Tests et scripts »](README.md)",
    "[README.md § « CI et release »](README.md)",
    "[PUBLISHING.md](PUBLISHING.md)",
  ]) {
    assert.ok(real.includes(link), `renvoi absent : ${link}`);
  }
  const broken = guideFaults(real, ROOT).filter(
    (fault) => fault.startsWith("chemin absent") || fault.startsWith("titre absent"),
  );
  assert.deepEqual(broken, []);
});

test("no-contributing-guide/AC-3 : la section tests de check.sh lance la garde, sans nouvelle section", () => {
  const listed = spawnSync("bash", [TEST_FILES], { cwd: ROOT, env: childEnv(), encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.ok(
    listed.stdout.split("\n").includes("test/outillage/no-contributing-guide.test.ts"),
    "test-files.sh ne liste pas la garde",
  );

  const check = fs.readFileSync(path.join(ROOT, CHECK), "utf8");
  const lines = check.split("\n");
  const start = lines.indexOf("if section_on tests; then");
  assert.ok(start >= 0, "section tests introuvable dans check.sh");
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("if section_on ")) end += 1;
  assert.ok(
    lines.slice(start, end).join("\n").includes(`bash ${TEST_FILES}`),
    "la section tests ne lance pas test-files.sh",
  );

  const ids = /^SECTION_IDS="([^"]*)"$/m.exec(check);
  assert.ok(ids !== null, "SECTION_IDS introuvable dans check.sh");
  for (const id of ids[1].split(/\s+/)) assert.ok(!/contributing|guide/.test(id), `section ajoutée : ${id}`);
  assert.ok(!check.includes("CONTRIBUTING"), "check.sh cite CONTRIBUTING");
  assert.ok(!check.includes("no-contributing-guide"), "check.sh cite la garde");
});

test("no-contributing-guide/AC-4 : un chemin cité absent fait échouer la garde en le nommant", () => {
  const copy = mutate(realGuide(), "`test/outillage/docs.test.ts`", "`test/docs.test.ts`");
  assert.ok(guideFaults(copy, ROOT).includes("chemin absent : test/docs.test.ts"));
});

test("no-contributing-guide/AC-5 : une option refusée par test-files.sh échoue, chaque option acceptée passe", () => {
  const real = realGuide();
  assert.equal(
    real.split(`${TEST_FILES} --scope=`).length,
    2,
    "l'option de test-files.sh doit être citée une seule fois",
  );
  const cited = `${TEST_FILES} --scope=changed`;

  const copy = mutate(real, cited, `${TEST_FILES} --scope=inexistant`);
  assert.ok(guideFaults(copy, ROOT).includes(`option non acceptée par ${TEST_FILES} : --scope=inexistant`));

  for (const option of ["--scope=macos", "--scope=outillage", "--scope=changed", "--scope=changed=<base>"]) {
    assert.deepEqual(guideFaults(real.replace(cited, `${TEST_FILES} ${option}`), ROOT), [], option);
  }
});

test("no-contributing-guide/AC-6 : un titre de section cité absent fait échouer la garde en le nommant", () => {
  const real = realGuide();
  const readme = mutate(real, "« CI et release »", "« CI et publication »");
  assert.ok(guideFaults(readme, ROOT).includes("titre absent : README.md § « CI et publication »"));
  const publishing = mutate(real, "« Mettre à jour »", "« Mise à niveau »");
  assert.ok(guideFaults(publishing, ROOT).includes("titre absent : PUBLISHING.md § « Mise à niveau »"));
});

test("no-contributing-guide/AC-7 : une règle retirée, ou le guide absent, fait échouer la garde en le nommant", () => {
  const real = realGuide();
  for (const rule of RULES) {
    const body = ruleSection(real, rule.heading);
    assert.ok(body !== null, `règle manquante : ${rule.heading}`);
    const copy = mutate(real, body, "");
    assert.ok(guideFaults(copy, ROOT).includes(`règle manquante : ${rule.heading}`), rule.heading);
  }
  const empty = tmpdir("no-contributing-guide-");
  assert.deepEqual(guideFaults(readGuide(empty), ROOT), [`fichier absent : ${GUIDE}`]);
});

test("no-contributing-guide/AC-8 : AGENTS.md lie le guide hors du bloc mem0, qui survit à sa régénération", () => {
  const text = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  const outside = (body: string): string | null => {
    const open = body.indexOf("<!-- mem0:brief");
    const close = body.indexOf(MARKER_CLOSE);
    if (open < 0 || close < open) return null;
    return body.slice(0, open) + body.slice(close + MARKER_CLOSE.length);
  };

  const open = text.indexOf(MARKER_OPEN);
  const close = text.indexOf(MARKER_CLOSE);
  assert.ok(open >= 0 && close > open, "bloc mem0 introuvable dans AGENTS.md");
  assert.equal(text.slice(open, close + MARKER_CLOSE.length), AGENTS_BLOCK);
  assert.match(outside(text) ?? "", LINK);

  const dir = fs.realpathSync(tmpdir("no-contributing-guide-"));
  const stale = mutate(text, MARKER_OPEN, "<!-- mem0:brief v4 -->");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), stale);
  ensureBrief(dir, true);
  const regenerated = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(regenerated.includes(MARKER_OPEN), "bloc mem0 non régénéré");
  assert.ok(!regenerated.includes("v4 -->"), "ancien bloc mem0 conservé");
  assert.match(outside(regenerated) ?? "", LINK);
});
