// Les GARDES TEXTUELLES de la feature `audit-ui-redesign` (BR-4) : le
// vocabulaire et les identifiants des vues de la section Audit (S-13, AC-15) et
// la section Audit du README d'omp-console (S-14, AC-16). C'est le SEUL fichier
// qui porte les ids `audit-ui-redesign/AC-n` (invariant `criteria/AC-13`).
//
// Fonctions pures sur les sources lues sous une racine ; chaque faute est plantée
// dans une COPIE JETABLE du dépôt (`copyRepo`), jamais dans l'arbre réel.
//
// Périmètre Mac : `Sources/OMPConsole/Audit/*.swift`, SAUF `AuditConsoleModel.swift`
// — le modèle, pas une vue, figé par S-15 (« AuditConsoleModel : AUCUNE
// modification ») et qui compare un schéma d'URL (`"https"`, `"http"`), un
// littéral qui n'est pas un texte affiché. Périmètre iOS :
// `ios/OMPConsoleIOS/IOSAudit*.swift`, SAUF `IOSAuditRecipeText.swift`, qui porte
// les drapeaux de recette, les symboles (`IOSAuditSymbol`) et les identifiants
// (`IOSAuditAccessibility`).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ROOT, copyRepo } from "../support/repo.ts";
import { braceBlock, stripComments, swiftTextUnits } from "../support/swift-source.ts";

const MAC_DIR = path.join("omp-console", "Sources", "OMPConsole", "Audit");
const MAC_MODEL = "AuditConsoleModel.swift";
const MAC_ENUM_FILE = path.join(MAC_DIR, "AuditView.swift");
const IOS_DIR = path.join("omp-console", "ios", "OMPConsoleIOS");
const IOS_ENUM_FILE = path.join(IOS_DIR, "IOSAuditRecipeText.swift");
const README = path.join("omp-console", "README.md");

/** Un chemin relatif en forme posix (messages stables). */
const posix = (rel: string) => rel.split(path.sep).join("/");

/** Les vues Audit du Mac, chemins relatifs à la racine. */
function macViews(root: string): string[] {
  return fs
    .readdirSync(path.join(root, MAC_DIR))
    .filter((name) => name.endsWith(".swift") && name !== MAC_MODEL)
    .sort()
    .map((name) => path.join(MAC_DIR, name));
}

/** Les vues Audit de l'iPhone et de l'iPad, chemins relatifs à la racine. */
function iosViews(root: string): string[] {
  return fs
    .readdirSync(path.join(root, IOS_DIR))
    .filter((name) => /^IOSAudit.*\.swift$/.test(name) && name !== path.basename(IOS_ENUM_FILE))
    .sort()
    .map((name) => path.join(IOS_DIR, name));
}

/** Les lignes (1 = première, bornes comprises) du bloc `enum <name> { … }`, ou null. */
function enumLines(source: string, name: string): [number, number] | null {
  const head = new RegExp(`\\benum\\s+${name}\\s*\\{`).exec(source);
  if (!head) return null;
  const open = head.index + head[0].length - 1;
  const block = braceBlock(source, open);
  const lineOf = (at: number) => source.slice(0, at).split("\n").length;
  return [lineOf(head.index), lineOf(open + block.length)];
}

/** Un symbole SF passé en argument : seul littéral alphabétique toléré côté Mac. */
const SYMBOL_ARGUMENT = /(?:systemImage:|Image\(systemName:)\s*$/;

/**
 * Les littéraux alphabétiques d'un source Swift (commentaires exclus), hors des
 * lignes `allowed` et — si `symbols` — hors argument `systemImage:` ou
 * `Image(systemName:`. Une faute = « fichier:ligne "littéral" ».
 */
function literalFaults(rel: string, source: string, symbols: boolean, allowed: [number, number] | null): string[] {
  const lines = source.split("\n");
  const faults: string[] = [];
  for (const unit of swiftTextUnits(source)) {
    if (!/\p{L}/u.test(unit.text)) continue;
    if (allowed && unit.line >= allowed[0] && unit.line <= allowed[1]) continue;
    const line = lines[unit.line - 1] ?? "";
    const at = line.indexOf(`"${unit.raw}"`);
    if (symbols && at >= 0 && SYMBOL_ARGUMENT.test(line.slice(0, at))) continue;
    faults.push(`${posix(rel)}:${unit.line} "${unit.raw}"`);
  }
  return faults;
}

/** Les `.accessibilityIdentifier(…)` dont l'argument ne commence pas par `<owner>.`. */
function identifierFaults(rel: string, source: string, owner: string): string[] {
  const code = stripComments(source);
  const faults: string[] = [];
  for (const match of code.matchAll(/\.accessibilityIdentifier\(\s*([^\n]*)/g)) {
    if (match[1].startsWith(`${owner}.`)) continue;
    const line = code.slice(0, match.index).split("\n").length;
    faults.push(`${posix(rel)}:${line} .accessibilityIdentifier(${match[1].trim()}`);
  }
  return faults;
}

/**
 * Les membres d'un enum d'identifiants : `static let x = "…"` et `static func x(…)
 * -> String { "…" }`, nom → littéral tel qu'écrit (interpolations comprises).
 */
function enumMembers(source: string, name: string): Map<string, string> {
  const span = enumLines(source, name);
  const members = new Map<string, string>();
  if (!span) return members;
  const body = source.split("\n").slice(span[0] - 1, span[1]).join("\n");
  for (const m of body.matchAll(/static\s+let\s+(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) members.set(m[1], m[2]);
  for (const m of body.matchAll(/static\s+func\s+(\w+)\([^)]*\)\s*->\s*String\s*\{\s*"((?:[^"\\]|\\.)*)"\s*\}/g)) {
    members.set(m[1], m[2]);
  }
  return members;
}

/** Les identifiants Mac CONSERVÉS par S-13, valeurs inchangées depuis 68304b8. */
const MAC_PRESERVED: ReadonlyArray<[string, string]> = [
  ["start", "audit.start"],
  ["list", "audit.list"],
  ["row", "audit.row.\\(id)"],
  ["orientation", "audit.orientation"],
  ["stop", "audit.stop"],
  ["analysing", "audit.analysing"],
  ["proposal", "audit.proposal.\\(slug)"],
  ["checkedCount", "audit.checkedCount"],
  ["reviewBrief", "audit.reviewBrief"],
  ["progress", "audit.progress"],
  ["feature", "audit.feature.\\(slug)"],
  ["featurePR", "audit.feature.\\(slug).pr"],
  ["notLaunched", "audit.notLaunched.\\(slug)"],
  ["escalations", "audit.escalations"],
  ["escalation", "audit.escalation.\\(slug)"],
  ["escalationText", "audit.escalation.\\(slug).text"],
  ["escalationAnswer", "audit.escalation.\\(slug).answer"],
  ["escalationOption", "audit.escalation.\\(slug).option.\\(index)"],
  ["escalationApprove", "audit.escalation.\\(slug).approve"],
  ["escalationAbandon", "audit.escalation.\\(slug).abandon"],
  ["decisions", "audit.decisions"],
  ["decision", "audit.decision.\\(index)"],
  ["analysisFailed", "audit.analysisFailed"],
  ["analysisDiagnostic", "audit.analysisFailed.diagnostic"],
  ["loading", "audit.loading"],
  ["emptyStart", "audit.empty.start"],
  ["failure", "audit.failure"],
  ["failureDiagnostic", "audit.failure.diagnostic"],
  ["retry", "audit.retry"],
  ["launchRepository", "audit.launch.repository"],
  ["launchChoose", "audit.launch.choose"],
  ["launchOrientation", "audit.launch.orientation"],
  ["launchMessage", "audit.launch.message"],
  ["launchCancel", "audit.launch.cancel"],
  ["launchCommit", "audit.launch.commit"],
  ["briefEditor", "audit.brief.editor"],
  ["briefError", "audit.brief.error"],
  ["briefFailure", "audit.brief.failure"],
  ["briefCancel", "audit.brief.cancel"],
  ["briefCommit", "audit.brief.commit"],
];

/** Toutes les valeurs d'`IOSAuditAccessibility` à la base 68304b8 (S-13 : conservées). */
const IOS_PRESERVED: ReadonlyArray<[string, string]> = [
  ["screen", "ios.audit"],
  ["empty", "ios.audit.empty"],
  ["banner", "ios.audit.banner"],
  ["start", "ios.audit.start"],
  ["detail", "ios.audit.detail"],
  ["header", "ios.audit.header"],
  ["reviewBrief", "ios.audit.brief"],
  ["stop", "ios.audit.stop"],
  ["launchSheet", "ios.audit.launch"],
  ["launchOrientation", "ios.audit.launch.orientation"],
  ["launchConfirm", "ios.audit.launch.confirm"],
  ["launchCancel", "ios.audit.launch.cancel"],
  ["launchError", "ios.audit.launch.error"],
  ["briefSheet", "ios.audit.brief.sheet"],
  ["briefEditor", "ios.audit.brief.editor"],
  ["briefConfirm", "ios.audit.brief.confirm"],
  ["briefCancel", "ios.audit.brief.cancel"],
  ["briefError", "ios.audit.brief.error"],
  ["row", "ios.audit.row.\\(id)"],
  ["launchRepo", "ios.audit.launch.repo.\\(repoKey)"],
  ["proposal", "ios.audit.proposal.\\(slug)"],
  ["feature", "ios.audit.feature.\\(slug)"],
  ["openPR", "ios.audit.feature.\\(slug).pr"],
  ["escalation", "ios.audit.escalation.\\(key)"],
  ["option", "ios.audit.escalation.\\(key).option.\\(index)"],
  ["otherAnswer", "ios.audit.escalation.\\(key).other"],
  ["answer", "ios.audit.escalation.\\(key).answer"],
  ["approve", "ios.audit.escalation.\\(key).approve"],
  ["abandon", "ios.audit.escalation.\\(key).abandon"],
  ["decision", "ios.audit.decision.\\(index)"],
];

/** Les écarts d'un enum d'identifiants à sa liste conservée. */
function preservedFaults(owner: string, members: Map<string, string>, preserved: ReadonlyArray<[string, string]>): string[] {
  const faults: string[] = [];
  for (const [name, value] of preserved) {
    const actual = members.get(name);
    if (actual !== value) faults.push(`${owner}.${name} vaut ${actual === undefined ? "(absent)" : `"${actual}"`}, attendu "${value}"`);
  }
  return faults;
}

/** AC-15 (S-13) : toutes les fautes de vocabulaire et d'identifiants des vues Audit. */
function auditVocabularyFaults(root: string): string[] {
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const faults: string[] = [];
  const macEnumSource = read(MAC_ENUM_FILE);
  const macEnum = enumLines(macEnumSource, "AuditAccessibility");
  if (!macEnum) faults.push(`${posix(MAC_ENUM_FILE)} : enum AuditAccessibility absent`);

  // (a) et (c), Mac.
  for (const rel of macViews(root)) {
    const source = read(rel);
    faults.push(...literalFaults(rel, source, true, rel === MAC_ENUM_FILE ? macEnum : null));
    faults.push(...identifierFaults(rel, source, "AuditAccessibility"));
  }
  // (b) et (c), iOS.
  for (const rel of iosViews(root)) {
    const source = read(rel);
    faults.push(...literalFaults(rel, source, false, null));
    faults.push(...identifierFaults(rel, source, "IOSAuditAccessibility"));
  }
  // (d) les identifiants conservés, et `audit.status` supprimé.
  const mac = enumMembers(macEnumSource, "AuditAccessibility");
  faults.push(...preservedFaults("AuditAccessibility", mac, MAC_PRESERVED));
  if (mac.has("status") || [...mac.values()].includes("audit.status")) faults.push("AuditAccessibility porte encore audit.status");
  faults.push(...preservedFaults("IOSAuditAccessibility", enumMembers(read(IOS_ENUM_FILE), "IOSAuditAccessibility"), IOS_PRESERVED));
  return faults;
}

/** La section `## Section Audit (pilotage)` du README, jusqu'à la section suivante, ou "". */
function auditSection(readme: string): string {
  const start = readme.indexOf("\n## Section Audit (pilotage)\n");
  if (start === -1) return "";
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

/** Ce que la section Audit du README doit citer (S-14). */
const README_TOKENS: ReadonlyArray<[string, RegExp]> = [
  ["« En cours »", /« En cours »/],
  ["« Terminés »", /« Terminés »/],
  ["frise", /\bfrise\b/],
  ["badge", /\bbadge\b/i],
  ["« Relancer avec la même orientation »", /« Relancer avec la même orientation »/],
  ["l'onglet Audit de l'iPhone", /onglet Audit de l['’]iPhone/],
];

/** AC-16 (S-14) : les mots de la nouvelle présentation absents de la section Audit du README. */
function readmeFaults(root: string): string[] {
  const section = auditSection(fs.readFileSync(path.join(root, README), "utf8"));
  if (!section) return ["README : section « ## Section Audit (pilotage) » absente"];
  return README_TOKENS.filter(([, pattern]) => !pattern.test(section)).map(([label]) => `README, section Audit : ${label} absent`);
}

/** Une copie jetable du dépôt, partagée par les fautes plantées de ce fichier. */
let shared: string | null = null;
function copy(): string {
  shared ??= copyRepo("audit-ui-redesign-");
  return shared;
}

/** Remplace `from` par `to` dans `rel` de la copie ; `from` doit exister. */
function plant(root: string, rel: string, from: string, to: string): void {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(from), `ancre de plantation absente de ${rel} : ${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

test("audit-ui-redesign/AC-15 : les vues Audit Mac et iOS ne portent aucun mot hors AuditText, posent chaque identifiant par leur enum, et les identifiants conservés gardent leur valeur", () => {
  // Le scan n'est pas vide : une liste de fichiers cassée rendrait la garde vraie à vide.
  assert.ok(macViews(ROOT).length >= 9, `vues Mac : ${macViews(ROOT).map(posix).join(", ")}`);
  assert.ok(iosViews(ROOT).length >= 6, `vues iOS : ${iosViews(ROOT).map(posix).join(", ")}`);
  assert.deepEqual(auditVocabularyFaults(ROOT), [], "l'arbre réel doit être sain");

  const root = copy();
  const detail = path.join(MAC_DIR, "AuditDetailView.swift");
  const screen = path.join(IOS_DIR, "IOSAuditScreen.swift");
  // (a) un mot écrit dans une vue Mac ; un symbole SF reste toléré.
  plant(root, detail, "Text(AuditText.noProposal)", 'Text("Rien à proposer")');
  // (b) un symbole SF écrit en dur dans une vue iOS (hors `IOSAuditSymbol`).
  plant(root, screen, "systemImage: ConsoleSection.audit.systemImage", 'systemImage: "checklist"');
  // (c) un identifiant écrit en dur.
  plant(root, detail, ".accessibilityIdentifier(AuditAccessibility.stepper)", '.accessibilityIdentifier(stepperId)');
  // (d) un identifiant conservé renommé, et `audit.status` revenu.
  plant(root, MAC_ENUM_FILE, 'static let checkedCount = "audit.checkedCount"', 'static let checkedCount = "audit.checked"\n    static let status = "audit.status"');
  plant(root, IOS_ENUM_FILE, 'static let stop = "ios.audit.stop"', 'static let stop = "ios.audit.analysis.stop"');

  const faults = auditVocabularyFaults(root);
  const has = (needle: string) => faults.some((f) => f.includes(needle));
  assert.ok(has('AuditDetailView.swift') && has('"Rien à proposer"'), `(a) : ${faults.join(" | ")}`);
  assert.ok(!has('"exclamationmark.triangle"'), "un argument systemImage: reste toléré côté Mac");
  assert.ok(has('IOSAuditScreen.swift') && has('"checklist"'), `(b) : ${faults.join(" | ")}`);
  assert.ok(has(".accessibilityIdentifier(stepperId)"), `(c) : ${faults.join(" | ")}`);
  assert.ok(has('AuditAccessibility.checkedCount vaut "audit.checked"'), `(d) Mac : ${faults.join(" | ")}`);
  assert.ok(has("audit.status"), `(d) audit.status : ${faults.join(" | ")}`);
  assert.ok(has('IOSAuditAccessibility.stop vaut "ios.audit.analysis.stop"'), `(d) iOS : ${faults.join(" | ")}`);
  assert.equal(faults.length, 6, faults.join("\n"));
});

test("audit-ui-redesign/AC-16 : la section Audit du README décrit la nouvelle présentation — En cours, Terminés, frise, badge, Relancer avec la même orientation, onglet Audit de l'iPhone", () => {
  assert.deepEqual(readmeFaults(ROOT), [], "le README réel doit être sain");

  const root = copy();
  const section = auditSection(fs.readFileSync(path.join(root, README), "utf8"));
  plant(root, README, section, section.replaceAll("« Terminés »", "« Finis »").replaceAll("frise", "barre"));
  assert.deepEqual(readmeFaults(root), ["README, section Audit : « Terminés » absent", "README, section Audit : frise absent"]);

  plant(root, README, "## Section Audit (pilotage)", "## Section Audits");
  assert.deepEqual(readmeFaults(root), ["README : section « ## Section Audit (pilotage) » absente"]);
});
