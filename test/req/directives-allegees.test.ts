// Tests de l'audit pertinence × rapidité, volet DIRECTIVES : un seul « lis le
// contrat » par directive (plus de relecture post-écriture), l'extrait du contrat
// et le résumé du run précédent injectés dans le prompt (omp-mem0-req/contract.ts,
// runs.ts), la revue lance tous les AC en un appel et borne sa lecture directe,
// le bloc de contexte est borné (omp-mem0-req/context.ts). Un test par critère,
// titre `directives-allegees/AC-<n> : …`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENTATION_EXCERPT_MAX,
  contractEditRule,
  contractReadRule,
  lotContractExcerpt,
} from "../../omp-mem0-req/contract.ts";
import {
  BRIEF_CONTEXT_MAX,
  JOURNAL_CONTEXT_MAX,
  appendJournal,
  contextBlock,
  renderBrief,
  writeBrief,
} from "../../omp-mem0-req/context.ts";
import { LOT_WORKER_DIRECTIVE, PREVIOUS_SUMMARY_MAX, RELEASE_DIRECTIVE, buildLotPrompt, lotPromptLine } from "../../omp-mem0-req/runs.ts";
import {
  IMPL_DIRECTIVE,
  IMPL_FIX_DIRECTIVE,
  REVIEW_DIRECTIVE,
  REVIEW_DIRECT_READ_MAX_LINES,
  SPECS_DIRECTIVE,
  SYSTEM_DIRECTIVE_REQ,
  buildImplSeed,
  buildReviewSeed,
} from "../../omp-mem0-req/seeds.ts";
import { tmpdir } from "../support/repo.ts";

const CONTRACT = [
  "## Besoins",
  "",
  "B-1 : faire.",
  "",
  "## Critères d'acceptation",
  "",
  "AC-1 (B-1) : un.",
  "AC-2 (B-1) : deux.",
  "",
  "## Documentation",
  "",
  "### Relevé du dépôt",
  "- runs.ts:1",
  "",
  "## Spécifications",
  "",
  "### S-1 (AC-1) — première",
  "corps S-1",
  "",
  "### S-2 (AC-2) — seconde",
  "corps S-2",
  "",
  "### S-3 (AC-2) — troisième",
  "corps S-3",
  "",
  "## Lots",
  "",
  "### BR-1 — type: archi — sert AC-1",
  "porte S-1",
  "",
  "### BR-2 — type: ui — sert AC-2",
  "porte S-2 et S-3",
  "",
  "### BR-3 — type: aucun — sert AC-2",
  "brief sans S nommée",
  "",
  "## Revue",
  "",
  "- BLOQUANTS :",
  "1. x",
  "",
  "## Corrections",
  "",
  "- levé x",
  "",
].join("\n");

test("directives-allegees/AC-1 : chaque directive dit « lis le contrat » une seule fois et ne relit plus après écriture", () => {
  const texts: Array<[string, string]> = [
    ["SYSTEM_DIRECTIVE_REQ", SYSTEM_DIRECTIVE_REQ],
    ["SPECS_DIRECTIVE", SPECS_DIRECTIVE],
    ["IMPL_DIRECTIVE", IMPL_DIRECTIVE],
    ["IMPL_FIX_DIRECTIVE", IMPL_FIX_DIRECTIVE],
    ["REVIEW_DIRECTIVE", REVIEW_DIRECTIVE],
    ["RELEASE_DIRECTIVE", RELEASE_DIRECTIVE],
  ];
  for (const [name, text] of texts) {
    assert.equal(text.includes("Relis ensuite le contrat APRÈS écriture"), false, name);
    assert.ok((text.match(/Lis le contrat \.omp\/pipeline\/contract\.md/g) ?? []).length <= 1, `${name} : plus d'un « lis le contrat »`);
  }
  assert.equal(contractEditRule(["Revue"]).includes("lis "), false, "la règle d'édition ne demande plus de lecture");
  assert.match(contractEditRule(["Revue"]), /remplace UNIQUEMENT `## Revue`/);
  // Les maillons qui reçoivent un extrait n'ouvrent le fichier que si une référence manque.
  for (const text of [SPECS_DIRECTIVE, IMPL_DIRECTIVE, IMPL_FIX_DIRECTIVE, RELEASE_DIRECTIVE]) {
    assert.ok(text.includes(contractReadRule("").slice(0, 30)));
    assert.match(text, /n'ouvre le fichier que si une référence y manque/);
  }
  assert.doesNotMatch(REVIEW_DIRECTIVE, /\[extrait du contrat\]/, "la revue juge le contrat entier");
});

test("directives-allegees/AC-2 : lotContractExcerpt — impl par lot, impl --fix, release, specs, revue", () => {
  const impl = lotContractExcerpt(CONTRACT, { phase: "impl", fix: false, lotId: "BR-2" })!;
  assert.ok(impl.startsWith("## Besoins\nB-1 : faire."));
  assert.ok(impl.includes("## Critères d'acceptation\nAC-1 (B-1) : un.\nAC-2 (B-1) : deux."));
  assert.ok(impl.includes("## Documentation\n### Relevé du dépôt\n- runs.ts:1"));
  assert.ok(impl.includes("## Spécifications (extrait : S-2, S-3)\n### S-2 (AC-2) — seconde\ncorps S-2\n\n### S-3 (AC-2) — troisième\ncorps S-3"));
  assert.equal(impl.includes("corps S-1"), false, "les S non citées par BR-2 ne sont pas dans l'extrait");
  assert.ok(impl.endsWith("## Lots (extrait : BR-2)\n### BR-2 — type: ui — sert AC-2\nporte S-2 et S-3"));
  assert.equal(impl.includes("## Revue"), false);
  assert.equal(impl.includes("BR-1 — type"), false);

  // Un lot qui ne cite aucune S reçoit celles qui servent ses AC.
  const br3 = lotContractExcerpt(CONTRACT, { phase: "impl", fix: false, lotId: "BR-3" })!;
  assert.ok(br3.includes("## Spécifications (extrait : S-2, S-3)"));
  // Un lot inconnu, ou pas de lot : specs et lots entiers.
  for (const lotId of ["BR-9", null]) {
    const whole = lotContractExcerpt(CONTRACT, { phase: "impl", fix: false, lotId })!;
    assert.ok(whole.includes("## Spécifications\n### S-1"), String(lotId));
    assert.ok(whole.includes("## Lots\n### BR-1"), String(lotId));
  }

  const fix = lotContractExcerpt(CONTRACT, { phase: "impl", fix: true, lotId: null })!;
  assert.equal(fix, "## Critères d'acceptation\nAC-1 (B-1) : un.\nAC-2 (B-1) : deux.\n\n## Revue\n- BLOQUANTS :\n1. x\n\n## Corrections\n- levé x");

  const release = lotContractExcerpt(CONTRACT, { phase: "release", fix: false, lotId: null })!;
  assert.equal(release, "## Besoins\nB-1 : faire.\n\n## Critères d'acceptation\nAC-1 (B-1) : un.\nAC-2 (B-1) : deux.\n\n## Revue\n- BLOQUANTS :\n1. x");

  assert.equal(lotContractExcerpt(CONTRACT, { phase: "specs", fix: false, lotId: null }), "## Besoins\nB-1 : faire.\n\n## Critères d'acceptation\nAC-1 (B-1) : un.\nAC-2 (B-1) : deux.");
  assert.equal(lotContractExcerpt(CONTRACT, { phase: "review", fix: false, lotId: null }), null);
  assert.equal(lotContractExcerpt(CONTRACT, { phase: "req", fix: false, lotId: null }), null);
  assert.equal(lotContractExcerpt("", { phase: "impl", fix: false, lotId: null }), null, "contrat vide : aucun extrait");

  // `## Documentation` est tronquée à 15 000 caractères.
  const long = CONTRACT.replace("- runs.ts:1", "x".repeat(DOCUMENTATION_EXCERPT_MAX + 100));
  const cut = lotContractExcerpt(long, { phase: "impl", fix: false, lotId: "BR-1" })!;
  const doc = cut.slice(cut.indexOf("## Documentation"), cut.indexOf("## Spécifications"));
  assert.match(doc, /^## Documentation \(tronquée à 15000 caractères — lis le fichier pour la suite\)\n/);
  assert.ok(doc.includes("…"));
  assert.ok(doc.length < DOCUMENTATION_EXCERPT_MAX + 200);
});

test("directives-allegees/AC-3 : buildLotPrompt place l'extrait et le résumé du run précédent après la graine, avant la directive de lot", () => {
  const lot = { id: "BR-2", index: 1, ids: ["BR-1", "BR-2"] };
  const prompt = buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", lot, excerpt: "## Besoins\nB-1", previousSummary: " BR-1 a écrit runs.ts " });
  assert.equal(
    prompt,
    `${buildImplSeed("", false)}\n\n${lotPromptLine(lot)}\n\n[extrait du contrat]\n## Besoins\nB-1\n\n[résumé du run précédent]\nBR-1 a écrit runs.ts\n\n${LOT_WORKER_DIRECTIVE}`,
  );
  // Sans extrait ni résumé, le prompt est inchangé.
  assert.equal(buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", lot, excerpt: "  ", previousSummary: "" }), `${buildImplSeed("", false)}\n\n${lotPromptLine(lot)}\n\n${LOT_WORKER_DIRECTIVE}`);
  // Le résumé est borné à 2 000 caractères.
  const longSummary = "s".repeat(PREVIOUS_SUMMARY_MAX + 500);
  const bounded = buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", previousSummary: longSummary });
  const at = bounded.indexOf("[résumé du run précédent]\n") + "[résumé du run précédent]\n".length;
  assert.equal(bounded.slice(at, bounded.indexOf("\n\n", at)), `${"s".repeat(PREVIOUS_SUMMARY_MAX - 1)}…`);
  // La relance porte les mêmes blocs ; la réponse et la collecte ne les portent pas.
  assert.ok(buildLotPrompt({ kind: "relaunch", phase: "specs", slug: "alpha", excerpt: "E" }).includes("\n\n[extrait du contrat]\nE\n\n" + LOT_WORKER_DIRECTIVE));
  assert.equal(buildLotPrompt({ kind: "answer", phase: "impl", slug: "alpha", text: "oui", excerpt: "E" }).includes("[extrait du contrat]"), false);
  // Le périmètre incrémental de la revue et les bloquants impliqués passent à la graine.
  const review = buildLotPrompt({ kind: "phase", phase: "review", slug: "alpha", reviewScope: { kind: "incremental", blockers: ["1. x"] } });
  assert.ok(review.startsWith(buildReviewSeed("", { incremental: { kind: "incremental", blockers: ["1. x"] } })));
  assert.ok(review.includes("[revue incrémentale]"));
  const fix = buildLotPrompt({ kind: "phase", phase: "impl", slug: "alpha", fix: true, impliedBlockers: ["AC-2 : échec en AC PAR AC"] });
  assert.ok(fix.startsWith(buildImplSeed("", true, { impliedBlockers: ["AC-2 : échec en AC PAR AC"] })));
});

test("directives-allegees/AC-4 : la revue lit elle-même un diff court, délègue au-delà, lance tous les AC en un appel, et la revue incrémentale borne sa lecture", () => {
  assert.equal(REVIEW_DIRECT_READ_MAX_LINES, 400);
  assert.match(REVIEW_DIRECTIVE, /Si le diff fait 400 lignes ou moins \(total de `git diff --stat`\), LIS toi-même chaque fichier du diff/);
  assert.match(REVIEW_DIRECTIVE, /Au-delà, délègue la lecture du diff et du code à des sous-agents \(outil task\), UN par lot \(BR-<n>\)/);
  assert.equal(REVIEW_DIRECTIVE.includes("Ne révise pas sur un résumé"), false);
  assert.equal(REVIEW_DIRECTIVE.includes("Revue découpée"), false);
  assert.equal(REVIEW_DIRECTIVE.includes("lance TOI-MÊME chaque test"), false);
  assert.match(REVIEW_DIRECTIVE, /Lance UNE fois `bash scripts\/test-ac\.sh AC-1 AC-2 …` avec TOUS les AC du contrat en un seul appel/);
  assert.match(REVIEW_DIRECTIVE, /en citant pour chaque AC l'assertion qui matérialise son Then/);
  assert.equal(REVIEW_DIRECTIVE.includes("grep AC-<n>"), false);
  assert.ok(REVIEW_DIRECTIVE.includes("`AC-<n> → fichier:ligne → pass/fail`"));
  // La table AC PAR AC est annoncée comme relue mécaniquement.
  assert.match(REVIEW_DIRECTIVE, /un AC en fail, sans test ou absent de la table vaut un bloquant même si le champ BLOQUANTS dit « aucun »/);
  // /impl : lecture directe bornée aux surfaces nommées, scouts au-delà — une seule règle.
  assert.match(IMPL_DIRECTIVE, /Lis TOI-MÊME le dépôt aux seuls points d'intégration que les specs et le lot nomment/);
  assert.match(IMPL_DIRECTIVE, /au-delà de ces surfaces, délègue l'exploration à des sous-agents scout/);
  assert.equal(IMPL_DIRECTIVE.includes("Délègue l'exploration du dépôt à des sous-agents (outil task)."), false);
  // /specs : doc externe seulement pour une API/lib absente du dépôt, section bornée.
  assert.match(SPECS_DIRECTIVE, /DOCUMENTE-toi SEULEMENT si une spec mobilise une API, bibliothèque, framework, format ou protocole EXTERNE absent du dépôt/);
  assert.match(SPECS_DIRECTIVE, /aucune recherche web pour une bibliothèque déjà utilisée/);
  assert.match(SPECS_DIRECTIVE, /`## Documentation` \(relevé du dépôt compris\) tient en 15000 caractères au plus/);

  const incremental = buildReviewSeed("", { incremental: { kind: "incremental", blockers: ["1. le test AC-2 manque", "AC-3 : échec en AC PAR AC"] } });
  assert.ok(incremental.includes("[revue incrémentale] Une correction (/impl --fix) vient de passer : ne relis pas tout le diff."));
  assert.ok(incremental.includes("Bloquants de la revue précédente :\n- 1. le test AC-2 manque\n- AC-3 : échec en AC PAR AC\n\n"));
  assert.ok(incremental.includes("`## Corrections`"));
  assert.ok(incremental.endsWith(REVIEW_DIRECTIVE), "la directive complète suit : les AC sont tous lancés, le verdict reste complet");
  assert.equal(buildReviewSeed("").includes("[revue incrémentale]"), false);
  assert.ok(buildReviewSeed("x", { incremental: { kind: "incremental", blockers: [] } }).includes("- (aucun libellé transmis"));
});

test("directives-allegees/AC-5 : contextBlock borne le brief à 8 000 caractères au prorata des rubriques et limite le journal à la phase courante + jalons", () => {
  const stateDir = tmpdir("da-context-");
  const key = "repo-key";
  const contextKey = "/x/parent.jsonl";
  // Brief court : intégral, bloc inchangé.
  const short = renderBrief({ title: "t", purpose: "But.", function: "Fonction.", decisions: ["d1"], constraints: [], nonGoals: [] });
  writeBrief(stateDir, contextKey, short);
  assert.ok(contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey }).includes(short.trim()));

  // Brief long : chaque rubrique garde sa tête, au prorata ; le total tient sous la borne.
  const long = renderBrief({
    title: "long",
    purpose: "P".repeat(12_000),
    function: "F".repeat(4_000),
    decisions: Array.from({ length: 40 }, (_, i) => `décision ${i} ${"x".repeat(80)}`),
    constraints: ["c"],
    nonGoals: [],
  });
  writeBrief(stateDir, contextKey, long);
  const block = contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey });
  const brief = block.slice(block.indexOf("# Brief — long"), block.indexOf("\n## Journal"));
  assert.ok(brief.length <= BRIEF_CONTEXT_MAX, `brief de ${brief.length} caractères`);
  const purpose = /## But\n(P+)…/.exec(brief)!;
  const fn = /## Fonction\n(F+)…/.exec(brief)!;
  assert.ok(purpose[1]!.length > fn[1]!.length * 2, "la rubrique la plus longue garde la plus grande part");
  assert.ok(brief.includes("## Décisions\n- décision 0 "));
  assert.ok(brief.includes("## Contraintes\n- c"));
  assert.ok(brief.includes("## Non-objectifs\n- (aucune)"));

  // Journal : sans phase, tout ; avec phase, ses entrées + les jalons, et le compte des autres.
  const entry = (n: number, phase: "req" | "impl", kind: "question" | "jalon") => appendJournal(stateDir, key, { at: n, slug: "alpha", phase, kind, question: `Q${n}`, answer: `R${n}`, source: "contexte", context: null });
  entry(1, "req", "question");
  entry(2, "impl", "question");
  entry(3, "req", "jalon");
  entry(4, "impl", "question");
  const all = contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey });
  assert.ok(all.endsWith("- [/req] Q : Q1 → R : R1 (source : contexte)\n- [/impl] Q : Q2 → R : R2 (source : contexte)\n- [/req] Q : Q3 → R : R3 (source : contexte)\n- [/impl] Q : Q4 → R : R4 (source : contexte)"));
  const impl = contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey, phase: "impl" });
  assert.ok(impl.endsWith("## Journal de la feature alpha\n- (1 décision d'autres maillons omise)\n- [/impl] Q : Q2 → R : R2 (source : contexte)\n- [/req] Q : Q3 → R : R3 (source : contexte)\n- [/impl] Q : Q4 → R : R4 (source : contexte)"));
  const specs = contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey, phase: "specs" });
  assert.ok(specs.endsWith("## Journal de la feature alpha\n- (3 décisions d'autres maillons omises)\n- [/req] Q : Q3 → R : R3 (source : contexte)"));
  // La borne de 50 entrées s'applique après le filtre.
  for (let n = 10; n < 10 + JOURNAL_CONTEXT_MAX + 2; n++) entry(n, "impl", "question");
  const capped = contextBlock({ stateDir, repoKey: key, slug: "alpha", contextKey, phase: "impl" }).split("\n");
  const at = capped.indexOf("## Journal de la feature alpha");
  assert.equal(capped[at + 1], "- (1 décision d'autres maillons omise)");
  assert.equal(capped[at + 2], "- (5 décisions plus anciennes omises)");
});
