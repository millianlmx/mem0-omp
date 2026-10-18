// Tests de pilote-de-lot-persistant : UNE session d'arbitre par lot et par contexte,
// ouverte au premier élément avec le corpus du lot, gardée entre les tours, et fermée
// avec le lot. Ce fichier est LE SEUL porteur des ids `pilote-de-lot-persistant/AC-<n>`.
//
// Artefacts RÉELS (dépôts git, pilote de lot réel, runner d'arbitre réel) ; doublures
// injectées : l'hôte des sessions (scripté : un prompt ⇒ une décision) et le runner des
// runs (en vol, jamais fini).
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  ARBITER_DIRECTIVE,
  TURN_REMINDER,
  createArbiterRunner,
  createLotController,
  journalOfContext,
  lotFeature,
  lotRepoKey,
  readLot,
  recordArbiterDecision,
  writeBrief,
  writeLot,
  type ArbiterDecision,
  type ArbiterRunner,
  type HostedSession,
  type LotRunnerResult,
  type LotRunSpec,
  type SessionHost,
} from "../../omp-mem0-req/extension.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";

const T0 = 1_700_000_000_000;
const CTX = "/sessions/audit-pilote.jsonl";
const FORMAT_FACT = "Le format de sortie est YAML.";
const DATE_FACT = "Les dates sont en ISO 8601.";

process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("pilote-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("pilote-default-wt-");

/** Un runner dont les runs restent EN VOL : aucun process, aucune fin. */
const pendingRunner = ({ signal }: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) =>
  new Promise<LotRunnerResult>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

/**
 * Ce qu'un tour scripté fait : une décision (ou aucune), lever (session perdue),
 * émettre une compaction native d'OMP avant de décider, attendre une porte.
 */
type Step = { decision?: ArbiterDecision | null; throws?: boolean; compact?: boolean; gate?: Promise<void> };
type Script = (prompt: string) => ArbiterDecision | "throw" | null | Step;

function stepOf(raw: ArbiterDecision | "throw" | null | Step): Step {
  if (raw === "throw") return { throws: true };
  if (raw === null) return { decision: null };
  return "decision" in raw && typeof raw.decision === "string" ? { decision: raw as ArbiterDecision } : (raw as Step);
}

/**
 * Un hôte scripté : chaque `open` est compté, chaque prompt rend la décision du
 * script par `arbiter_decide` (ou lève, ou ne décide rien). `disposed` se résout à
 * la libération, comme la session réelle.
 */
function scriptedHost(script: Script): Arb {
  const opens: Array<{ id: string; cwd: string; purpose: string; model: string | null; fallback: string | null }> = [];
  const prompts: string[] = [];
  let disposed = 0;
  const host = {
    open: async (o: { cwd: string; purpose: string; model?: string | null; fallback?: string | null; arbiter?: { decision: ArbiterDecision | null } }) => {
      const id = `pilote-${opens.length + 1}`;
      opens.push({ id, cwd: o.cwd, purpose: o.purpose, model: o.model ?? null, fallback: o.fallback ?? null });
      const messages: Array<Record<string, unknown>> = [];
      const listeners = new Set<(event: unknown) => void>();
      const release = Promise.withResolvers<void>();
      const session = {
        get messages() {
          return messages;
        },
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        prompt: async (text: string) => {
          prompts.push(text);
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const step = stepOf(script(text));
          if (step.gate) await step.gate;
          if (step.throws) throw new Error("session perdue");
          if (step.compact) for (const listener of listeners) listener({ type: "auto_compaction_end", result: { summary: "résumé" } });
          if (step.decision && o.arbiter) recordArbiterDecision(o.arbiter as never, step.decision);
          messages.push({ role: "assistant", provider: "prov", model: "p", stopReason: "stop", content: [{ type: "text", text: "décidé" }] });
          return true;
        },
        waitForIdle: async () => {},
        abort: async () => {},
      };
      return {
        id,
        cwd: o.cwd,
        purpose: o.purpose,
        sessionFile: path.join(o.cwd, `${id}.jsonl`),
        state: "idle",
        dispose: async () => {
          disposed += 1;
          release.resolve();
        },
        disposed: release.promise,
        session,
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, opens, prompts, disposed: () => disposed };
}

/** L'hôte scripté : ce que les tests observent (ouvertures, tours, libérations). */
type Arb = { host: SessionHost; opens: Array<{ id: string; cwd: string; purpose: string; model: string | null; fallback: string | null }>; prompts: string[]; disposed: () => number };

/**
 * Un monde : dépôt, magasin, pilote de lot réel et runner d'arbitre réel sur un hôte
 * scripté. `share` : réutiliser le runner (et l'hôte) d'un autre monde, comme le
 * service partage UN runner entre ses contrôleurs.
 */
function world(script: Script, options: { context?: (slug: string) => string; share?: { arb: Arb; runner: ArbiterRunner; repoRoot: string; stateDir: string } } = {}) {
  const repoRoot = options.share?.repoRoot ?? emptyGitRepo("pilote-repo-");
  const stateDir = options.share?.stateDir ?? path.join(tmpdir("pilote-state-"), "pipeline");
  const arb = options.share?.arb ?? scriptedHost(script);
  const notices: string[] = [];
  // Horloge MONOTONE : une entrée de journal écrite après la construction d'un tour lui est postérieure.
  let clock = T0;
  const now = () => (clock += 1);
  const runner = options.share?.runner ?? createArbiterRunner({ host: arb.host, log: () => {}, now });
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: pendingRunner,
    arbiter: runner,
    runGit: gitRunner,
    notify: (text) => notices.push(text),
    toast: () => {},
    session: () => ({ file: null, id: null }),
    now,
    schedule: () => () => {},
    slots: 4,
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const repoKey = lotRepoKey(repoRoot);
  const read = () => readLot(stateDir, repoKey)!;
  const until = async (done: () => boolean, what: string) => {
    for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(done(), what);
  };
  const add = async (...slugs: string[]) => {
    for (const slug of slugs) assert.equal(await controller.add({ name: slug, description: `Faire ${slug}.`, deps: [], auditSession: options.context?.(slug) ?? CTX }), null);
    await controller.launch();
  };
  /** Parque une feature à une question /req, comme le fait la fin d'un run. */
  const park = (slug: string, question: string) => {
    const lot = read();
    const feature = lotFeature(lot, slug)!;
    feature.state = "waiting";
    feature.waitKind = "answer";
    feature.phase = "req";
    feature.waitPrompt = question;
    feature.sessionFile = `/x/${slug}.jsonl`;
    feature.lastRunSessionFile = `/x/${slug}.jsonl`;
    writeLot(stateDir, lot);
  };
  return { controller, stateDir, repoRoot, repoKey, arb, runner, notices, read, until, add, park };
}

const answer = (text: string, citation: string): ArbiterDecision => ({ decision: "answer", answer: text, source: "contexte", citations: [citation], reason: "le brief le dit" });

test("pilote-de-lot-persistant/AC-1 : deux questions de deux features du même lot passent par UNE session ouverte sur le dépôt principal — l'ouverture porte directive, brief et journal du lot ; le second tour n'a que son élément, le worktree de sa feature et la décision du premier tour", async () => {
  const w = world((prompt) => {
    if (prompt.includes("question : Quel format de sortie ?")) return answer("YAML", FORMAT_FACT);
    if (prompt.includes("question : Quel format de date ?")) return answer("ISO 8601", DATE_FACT);
    return null;
  });
  await w.add("alpha", "bravo");
  writeBrief(w.stateDir, CTX, `## But\n${FORMAT_FACT}\n${DATE_FACT}\n`);
  w.park("alpha", "Quel format de sortie ?");
  w.park("bravo", "Quel format de date ?");
  await w.controller.tick();
  await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === 2, "les deux questions sont tranchées");

  // Une seule session, sur le dépôt principal, jamais libérée tant que le lot vit.
  assert.equal(w.arb.opens.length, 1);
  assert.equal(w.arb.opens[0]!.cwd, w.repoRoot);
  assert.equal(w.arb.opens[0]!.purpose, "arbiter");
  assert.equal(w.arb.disposed(), 0);
  assert.equal(w.arb.prompts.length, 2);

  const alpha = lotFeature(w.read(), "alpha")!;
  const bravo = lotFeature(w.read(), "bravo")!;
  const [first, second] = w.arb.prompts as [string, string];
  // Ouverture + premier tour : directive, corpus du lot, puis l'élément et son worktree.
  assert.ok(first.startsWith(ARBITER_DIRECTIVE));
  for (const piece of ["## Corpus du lot", `### Brief\n## But\n${FORMAT_FACT}`, "### Journal du lot\n- (aucune décision consignée)", "## Élément à arbitrer", "feature : alpha", `worktree : ${alpha.worktree}`, "question : Quel format de sortie ?", "### Journal du lot depuis le dernier tour\n- (aucune décision nouvelle)"]) {
    assert.ok(first.includes(piece), piece);
  }
  assert.ok(first.endsWith(TURN_REMINDER));
  // Second tour : ni directive ni brief ; l'élément de bravo et ce qui a été décidé depuis.
  assert.equal(second.includes("Tu es le pilote d'un LOT"), false, "la directive n'est pas répétée");
  assert.equal(second.includes("### Brief"), false, "le brief n'est pas répété");
  for (const piece of ["## Élément à arbitrer", "feature : bravo", `worktree : ${bravo.worktree}`, "question : Quel format de date ?", "### Journal du lot depuis le dernier tour\n- [alpha /req] Q : Quel format de sortie ? → R : YAML (source : contexte)"]) {
    assert.ok(second.includes(piece), piece);
  }
  assert.ok(second.endsWith(TURN_REMINDER));
  // La citation du second tour vient de l'ouverture : elle est vérifiée là aussi.
  const entries = journalOfContext(w.stateDir, w.repoKey, CTX);
  assert.deepEqual(entries.map((e) => [e.slug, e.answer, e.source]), [["alpha", "YAML", "contexte"], ["bravo", "ISO 8601", "contexte"]]);
  // Les deux tours sont enregistrés sur la MÊME session.
  const files = [alpha, bravo].map((f) => f.runs?.find((r) => r.step === "arbitre")?.sessionFile ?? null);
  assert.deepEqual(files, [w.arb.opens[0]!.id, w.arb.opens[0]!.id].map((id) => path.join(w.repoRoot, `${id}.jsonl`)));
});

test("pilote-de-lot-persistant/AC-2 : une session dont le tour échoue est fermée et l'élément escaladé ; l'élément suivant rouvre une session avec l'ouverture complète", async () => {
  let turns = 0;
  const w = world((prompt) => {
    turns += 1;
    if (turns === 1) return "throw";
    return prompt.includes("question : Quel format de date ?") ? answer("ISO 8601", DATE_FACT) : null;
  });
  await w.add("alpha", "bravo");
  writeBrief(w.stateDir, CTX, `## But\n${DATE_FACT}\n`);
  w.park("alpha", "Quel format de sortie ?");
  w.park("bravo", "Quel format de date ?");
  await w.controller.tick();
  await w.until(() => lotFeature(w.read(), "alpha")!.escalation !== undefined && journalOfContext(w.stateDir, w.repoKey, CTX).length === 1, "alpha escaladée, bravo tranchée");

  assert.equal(w.arb.opens.length, 2, "la session perdue est remplacée");
  assert.equal(w.arb.disposed(), 1, "la session perdue est libérée");
  assert.ok(w.arb.prompts[1]!.startsWith(ARBITER_DIRECTIVE), "la session neuve reçoit l'ouverture");
  assert.ok(w.arb.prompts[1]!.includes("feature : bravo"));
});

test("pilote-de-lot-persistant/AC-3 : la session du pilote est libérée avec le récap de fin de lot, et à l'arrêt du contrôleur", async () => {
  const ended = world((prompt) => (prompt.includes("question : Quel format de sortie ?") ? answer("YAML", FORMAT_FACT) : null));
  await ended.add("alpha");
  writeBrief(ended.stateDir, CTX, `## But\n${FORMAT_FACT}\n`);
  ended.park("alpha", "Quel format de sortie ?");
  await ended.controller.tick();
  await ended.until(() => journalOfContext(ended.stateDir, ended.repoKey, CTX).length === 1, "la question est tranchée");
  assert.equal(ended.arb.disposed(), 0);
  assert.equal(await ended.controller.cancel("alpha", "keep"), null);
  await ended.controller.tick();
  await ended.until(() => ended.arb.disposed() === 1, "le récap de fin de lot ferme la session");
  assert.notEqual(ended.read().recapAt, null);

  const stopped = world((prompt) => (prompt.includes("question : Quel format de sortie ?") ? answer("YAML", FORMAT_FACT) : null));
  await stopped.add("alpha");
  writeBrief(stopped.stateDir, CTX, `## But\n${FORMAT_FACT}\n`);
  stopped.park("alpha", "Quel format de sortie ?");
  await stopped.controller.tick();
  await stopped.until(() => journalOfContext(stopped.stateDir, stopped.repoKey, CTX).length === 1, "la question est tranchée");
  stopped.controller.stop();
  await stopped.until(() => stopped.arb.disposed() === 1, "l'arrêt ferme la session");
});

test("pilote-de-lot-persistant/AC-4 : les tours sont sériels PAR SESSION — un tour lent d'un contexte ne retient pas le tour d'un autre contexte du même lot, et dans un même contexte le second tour attend le premier", async () => {
  const OTHER = "/sessions/audit-autre.jsonl";
  const gate = Promise.withResolvers<void>();
  const w = world(
    (prompt) => {
      if (prompt.includes("question : Lente ?")) return { gate: gate.promise, decision: answer("oui", FORMAT_FACT) };
      if (prompt.includes("question : Quel format de date ?")) return answer("ISO 8601", DATE_FACT);
      if (prompt.includes("question : Quel format de sortie ?")) return answer("YAML", FORMAT_FACT);
      return null;
    },
    { context: (slug) => (slug === "charlie" ? OTHER : CTX) },
  );
  await w.add("alpha", "bravo", "charlie");
  writeBrief(w.stateDir, CTX, `## But\n${FORMAT_FACT}\n${DATE_FACT}\n`);
  writeBrief(w.stateDir, OTHER, `## But\n${DATE_FACT}\n`);
  w.park("alpha", "Lente ?");
  w.park("bravo", "Quel format de sortie ?");
  w.park("charlie", "Quel format de date ?");
  await w.controller.tick();
  // charlie (autre contexte) est tranchée pendant que le tour d'alpha est retenu ; bravo (même contexte qu'alpha) attend.
  await w.until(() => journalOfContext(w.stateDir, w.repoKey, OTHER).length === 1, "l'autre contexte n'attend pas");
  assert.equal(journalOfContext(w.stateDir, w.repoKey, CTX).length, 0, "bravo attend la fin du tour d'alpha");
  assert.equal(w.arb.opens.length, 2, "une session par contexte");
  assert.equal(w.arb.prompts.filter((p) => p.includes("feature : bravo")).length, 0);
  gate.resolve();
  await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === 2, "alpha puis bravo");
  const ctx = journalOfContext(w.stateDir, w.repoKey, CTX).map((e) => e.slug);
  assert.deepEqual(ctx, ["alpha", "bravo"]);
  assert.equal(w.arb.opens.length, 2);
});

test("pilote-de-lot-persistant/AC-5 : un contrôleur neuf sur le même lot (runner partagé) ne reprend pas une session dont il n'a pas l'ouverture — elle est fermée et rouverte, et les citations du brief restent vérifiables", async () => {
  const script: Script = (prompt) => {
    if (prompt.includes("question : Quel format de sortie ?")) return answer("YAML", FORMAT_FACT);
    if (prompt.includes("question : Quel format de date ?")) return answer("ISO 8601", DATE_FACT);
    return null;
  };
  const first = world(script);
  await first.add("alpha", "bravo");
  writeBrief(first.stateDir, CTX, `## But\n${FORMAT_FACT}\n${DATE_FACT}\n`);
  first.park("alpha", "Quel format de sortie ?");
  await first.controller.tick();
  await first.until(() => journalOfContext(first.stateDir, first.repoKey, CTX).length === 1, "alpha tranchée par le premier contrôleur");
  assert.equal(first.arb.opens.length, 1);
  // Un second contrôleur (service recréé, même dépôt, même runner) prend le lot : sa table d'ouvertures est vide,
  // et la session du runner est VIVANTE et orpheline (le premier n'a pas été arrêté).
  const second = world(script, { share: { arb: first.arb, runner: first.runner, repoRoot: first.repoRoot, stateDir: first.stateDir } });
  second.park("bravo", "Quel format de date ?");
  await second.controller.tick();
  await second.until(() => journalOfContext(second.stateDir, second.repoKey, CTX).length === 2, "bravo tranchée par le second contrôleur");
  assert.equal(first.arb.disposed(), 1, "la session orpheline est fermée");
  assert.equal(first.arb.opens.length, 2, "et rouverte");
  const reopened = first.arb.prompts.at(-1)!;
  assert.ok(reopened.startsWith(ARBITER_DIRECTIVE), "avec son ouverture");
  assert.ok(reopened.includes("- [alpha /req] Q : Quel format de sortie ? → R : YAML (source : contexte)"), "l'ouverture porte la décision du premier contrôleur");
  const bravo = journalOfContext(second.stateDir, second.repoKey, CTX).at(-1)!;
  assert.equal(bravo.answer, "ISO 8601");
  assert.equal(bravo.source, "contexte", "la citation du brief a été vérifiée dans la nouvelle ouverture");
});

test("pilote-de-lot-persistant/AC-6 : après une compaction de la session, le tour suivant reporte le journal du lot ENTIER, puis la suite seule ; le rappel de chaque tour porte le digest des règles", async () => {
  const w = world((prompt) => {
    if (prompt.includes("question : Q1 ?")) return answer("R1", FORMAT_FACT);
    if (prompt.includes("question : Q2 ?")) return { compact: true, decision: answer("R2", FORMAT_FACT) };
    if (prompt.includes("question : Q3 ?")) return answer("R3", FORMAT_FACT);
    if (prompt.includes("question : Q4 ?")) return answer("R4", FORMAT_FACT);
    return null;
  });
  await w.add("alpha", "bravo", "charlie", "delta");
  writeBrief(w.stateDir, CTX, `## But\n${FORMAT_FACT}\n`);
  const ask = async (slug: string, question: string, expected: number) => {
    w.park(slug, question);
    await w.controller.tick();
    await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === expected, `${slug} tranchée`);
  };
  await ask("alpha", "Q1 ?", 1);
  await ask("bravo", "Q2 ?", 2); // ce tour est compacté
  await ask("charlie", "Q3 ?", 3);
  await ask("delta", "Q4 ?", 4);
  assert.equal(w.arb.opens.length, 1, "la compaction ne rouvre pas la session");
  const [, second, third, fourth] = w.arb.prompts as [string, string, string, string];
  const since = (p: string) => p.split("### Journal du lot depuis le dernier tour\n")[1]!.split("\n\n")[0]!.split("\n");
  assert.deepEqual(since(second), ["- [alpha /req] Q : Q1 ? → R : R1 (source : contexte)"], "avant la compaction : la suite seule");
  assert.deepEqual(since(third), ["- [alpha /req] Q : Q1 ? → R : R1 (source : contexte)", "- [bravo /req] Q : Q2 ? → R : R2 (source : contexte)"], "après la compaction : le journal entier");
  assert.deepEqual(since(fourth), ["- [charlie /req] Q : Q3 ? → R : R3 (source : contexte)"], "puis la suite seule");
  for (const piece of ["Rappel des règles", "justification vérifiable", "libellé exact ou son numéro", "décision `utilisateur` prévaut", "si le pilote la refuse, l'outil te rend son motif"]) {
    assert.ok(TURN_REMINDER.includes(piece), piece);
  }
  assert.ok(fourth.endsWith(TURN_REMINDER));
});

test("pilote-de-lot-persistant/AC-7 : le récap de fin de lot porte la mesure de l'arbitrage — décisions par source, sessions de pilote, tours", async () => {
  const w = world((prompt) => {
    if (prompt.includes("question : Quel format de sortie ?")) return answer("YAML", FORMAT_FACT);
    if (prompt.includes("question : Quel format de date ?")) return { decision: "escalate", reason: "choix de produit" };
    return null;
  });
  await w.add("alpha", "bravo");
  writeBrief(w.stateDir, CTX, `## But\n${FORMAT_FACT}\n`);
  w.park("alpha", "Quel format de sortie ?");
  w.park("bravo", "Quel format de date ?");
  await w.controller.tick();
  await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === 1 && lotFeature(w.read(), "bravo")!.escalation !== undefined, "une tranchée, une escaladée");
  // L'utilisateur tranche l'escalade, puis le lot se termine.
  assert.equal(await w.controller.answer("bravo", "ISO 8601"), null);
  await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === 2, "la réponse de l'utilisateur est au journal");
  assert.equal(await w.controller.cancel("alpha", "keep"), null);
  assert.equal(await w.controller.cancel("bravo", "keep"), null);
  await w.controller.tick();
  await w.until(() => w.read().recapAt !== null, "le récap est posté");
  const recap = w.notices.find((n) => n.includes("terminé —"))!;
  assert.ok(recap.includes("\narbitrage : 2 décisions (contexte 1, arbitrage 0, utilisateur 1) — 1 session de pilote, 2 tours"), recap);
});

test("pilote-de-lot-persistant/AC-8 : les features d'un même contexte aux modèles ou replis différents (ou sans modèle) partagent la session — le modèle du pilote est fixé par contexte, par la première feature qui en déclare un", async () => {
  const w = world((prompt) => {
    if (prompt.includes("question : Quel format de sortie ?")) return answer("YAML", FORMAT_FACT);
    if (prompt.includes("question : Quel format de date ?")) return answer("ISO 8601", DATE_FACT);
    if (prompt.includes("question : Quelle langue ?")) return answer("fr", FORMAT_FACT);
    if (prompt.includes("question : Quel encodage ?")) return answer("UTF-8", FORMAT_FACT);
    return null;
  });
  await w.add("alpha", "bravo", "charlie", "delta");
  writeBrief(w.stateDir, CTX, `## But\n${FORMAT_FACT}\n${DATE_FACT}\n`);
  const lot = w.read();
  // alpha : aucun modèle ; bravo : opus + repli sonnet ; charlie : opus sans repli ; delta : un AUTRE modèle de départ.
  Object.assign(lotFeature(lot, "bravo")!, { modelReqSpecs: "prov/opus", fallbackReqSpecs: "prov/sonnet" });
  Object.assign(lotFeature(lot, "charlie")!, { modelReqSpecs: "prov/opus", fallbackReqSpecs: null });
  Object.assign(lotFeature(lot, "delta")!, { modelReqSpecs: "prov/haiku", fallbackReqSpecs: null });
  writeLot(w.stateDir, lot);
  const ask = async (slug: string, question: string, expected: number) => {
    w.park(slug, question);
    await w.controller.tick();
    await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === expected, `${slug} tranchée`);
  };
  await ask("alpha", "Quel format de sortie ?", 1);
  await ask("bravo", "Quel format de date ?", 2);
  await ask("delta", "Quel encodage ?", 3);
  await ask("charlie", "Quelle langue ?", 4);
  assert.equal(w.arb.opens.length, 1, "aucune alternance de modèle ne rouvre la session");
  assert.deepEqual(w.arb.opens.map((o) => [o.model, o.fallback]), [["prov/opus", "prov/sonnet"]], "le modèle et le repli de la première feature qui en déclare un");
  assert.equal(w.arb.disposed(), 0);
});
