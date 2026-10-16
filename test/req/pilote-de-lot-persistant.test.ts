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

type Script = (prompt: string) => ArbiterDecision | "throw" | null;

/**
 * Un hôte scripté : chaque `open` est compté, chaque prompt rend la décision du
 * script par `arbiter_decide` (ou lève, ou ne décide rien). `disposed` se résout à
 * la libération, comme la session réelle.
 */
function scriptedHost(script: Script) {
  const opens: Array<{ id: string; cwd: string; purpose: string; model: string | null; fallback: string | null }> = [];
  const prompts: string[] = [];
  let disposed = 0;
  const host = {
    open: async (o: { cwd: string; purpose: string; model?: string | null; fallback?: string | null; arbiter?: { decision: ArbiterDecision | null } }) => {
      const id = `pilote-${opens.length + 1}`;
      opens.push({ id, cwd: o.cwd, purpose: o.purpose, model: o.model ?? null, fallback: o.fallback ?? null });
      const messages: Array<Record<string, unknown>> = [];
      const release = Promise.withResolvers<void>();
      const session = {
        get messages() {
          return messages;
        },
        subscribe: () => () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          messages.push({ role: "user", content: [{ type: "text", text }] });
          const params = script(text);
          if (params === "throw") throw new Error("session perdue");
          if (params !== null && o.arbiter) recordArbiterDecision(o.arbiter as never, params);
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

function world(script: Script) {
  const repoRoot = emptyGitRepo("pilote-repo-");
  const stateDir = path.join(tmpdir("pilote-state-"), "pipeline");
  const arb = scriptedHost(script);
  // Horloge MONOTONE : une entrée de journal écrite après la construction d'un tour lui est postérieure.
  let clock = T0;
  const now = () => (clock += 1);
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: pendingRunner,
    arbiter: createArbiterRunner({ host: arb.host, log: () => {}, now }),
    runGit: gitRunner,
    notify: () => {},
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
    for (const slug of slugs) assert.equal(await controller.add({ name: slug, description: `Faire ${slug}.`, deps: [], auditSession: CTX }), null);
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
  return { controller, stateDir, repoRoot, repoKey, arb, read, until, add, park };
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
