// Tests de arbitre-jalons-et-visibilite : la décision refusée par le pilote revient à
// l'arbitre DANS le tour (il la corrige au lieu d'escalader à l'aveugle) ; une feature
// arbitrée n'appelle l'utilisateur qu'à l'escalade, motif compris ; la marque
// d'arbitrage dit « en file » ou « décide » dès la sauvegarde qui met la feature en
// attente, et le lot dit qu'il est arbitré.
//
// Artefacts RÉELS (dépôts git, pilote de lot réel, runner d'arbitre réel) ; doublures :
// l'hôte des sessions (scripté) et le runner des runs (gardé ouvert par une porte).
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import {
  ARBITER_RETRY_MAX,
  createArbiterRunner,
  createLotController,
  journalOfContext,
  lotFeature,
  lotRepoKey,
  readLot,
  recordArbiterDecision,
  writeBrief,
  type ArbiterCapture,
  type ArbiterDecision,
  type HostedSession,
  type LotRunnerResult,
  type LotRunSpec,
  type SessionHost,
} from "../../omp-mem0-req/extension.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { tmpdir } from "../support/repo.ts";

const T0 = 1_700_000_000_000;
const CTX = "/sessions/audit-visibilite.jsonl";
const FORMAT_FACT = "Le format de sortie est YAML.";

process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("visibilite-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("visibilite-default-wt-");

/**
 * Ce qu'un tour scripté fait : une PORTE éventuelle (le tour reste en vol tant
 * qu'elle n'est pas ouverte), puis les appels successifs de `arbiter_decide` — le
 * suivant n'est fait que si le précédent a été refusé, comme un modèle qui corrige.
 */
type Turn = { gate?: Promise<void>; calls: ArbiterDecision[] };

function scriptedHost(script: (prompt: string) => Turn) {
  const opens: string[] = [];
  const prompts: string[] = [];
  /** Le texte rendu par l'outil à chaque appel, dans l'ordre. */
  const toolResults: string[] = [];
  const host = {
    open: async (o: { cwd: string; purpose: string; arbiter?: ArbiterCapture }) => {
      const id = `pilote-${opens.length + 1}`;
      opens.push(id);
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
          const turn = script(text);
          if (turn.gate) await turn.gate;
          for (const call of turn.calls) {
            const recorded = recordArbiterDecision(o.arbiter!, call);
            toolResults.push(recorded.text);
            if (!recorded.isError) break;
          }
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
        dispose: async () => release.resolve(),
        disposed: release.promise,
        session,
      } as unknown as HostedSession;
    },
  } as unknown as SessionHost;
  return { host, opens, prompts, toolResults };
}

/** Un monde : dépôt, magasin, pilote réel, runner d'arbitre réel, runs gardés par des portes. */
function world(script: (prompt: string) => Turn) {
  const repoRoot = emptyGitRepo("visibilite-repo-");
  const stateDir = path.join(tmpdir("visibilite-state-"), "pipeline");
  const arb = scriptedHost(script);
  const notices: string[] = [];
  const toasts: string[] = [];
  let clock = T0;
  const now = () => (clock += 1);
  const gates = new Map<string, (result: LotRunnerResult) => void>();
  const controller = createLotController({
    stateDir,
    repoRoot,
    run: ({ spec, signal }: { spec: LotRunSpec; cwd: string; signal?: AbortSignal }) => {
      const { promise, resolve, reject } = Promise.withResolvers<LotRunnerResult>();
      gates.set(spec.slug, resolve);
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    },
    arbiter: createArbiterRunner({ host: arb.host, log: () => {}, now }),
    runGit: gitRunner,
    notify: (text) => notices.push(text),
    toast: (text) => toasts.push(text),
    session: () => ({ file: null, id: null }),
    now,
    schedule: () => () => {},
    slots: 4,
    worktreesBase: path.join(path.dirname(stateDir), "worktrees"),
    archiveBase: path.join(path.dirname(stateDir), "archive"),
  });
  const repoKey = lotRepoKey(repoRoot);
  const read = () => readLot(stateDir, repoKey)!;
  const feature = (slug: string) => lotFeature(read(), slug)!;
  const until = async (done: () => boolean, what: string) => {
    for (let i = 0; i < 4000 && !done(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(done(), what);
  };
  const add = async (...slugs: string[]) => {
    for (const slug of slugs) assert.equal(await controller.add({ name: slug, description: `Faire ${slug}.`, deps: [], auditSession: CTX }), null);
    await controller.launch();
    await until(() => slugs.every((slug) => gates.has(slug)), "chaque /req est en vol");
    writeBrief(stateDir, CTX, `## But\n${FORMAT_FACT}\n`);
  };
  /** Le /req de `slug` se termine sur une question en texte : la chaîne met la feature en attente. */
  const askInText = (slug: string, question: string) => {
    const resolve = gates.get(slug)!;
    gates.delete(slug);
    resolve({ code: 0, killed: false, stdout: question, stderr: "" });
  };
  return { controller, read, feature, until, add, askInText, arb, notices, toasts, repoRoot, repoKey, stateDir };
}

const answer = (text: string, citation: string): ArbiterDecision => ({ decision: "answer", answer: text, source: "contexte", citations: [citation], reason: "le brief le dit" });

test("arbitre-jalons-et-visibilite : une décision refusée par le pilote revient à l'arbitre avec son motif ; corrigée dans le même tour, elle est appliquée sans escalade", async () => {
  const w = world((prompt) =>
    prompt.includes("question : Quel format de sortie ?") ? { calls: [answer("YAML", "phrase inventée"), answer("YAML", FORMAT_FACT)] } : { calls: [] },
  );
  await w.add("alpha");
  w.askInText("alpha", "Quel format de sortie ?");
  await w.until(() => journalOfContext(w.stateDir, w.repoKey, CTX).length === 1, "question tranchée");

  assert.equal(w.arb.prompts.length, 1, "un seul tour : la correction se fait dans le tour");
  assert.equal(w.arb.toolResults.length, 2);
  assert.ok(
    w.arb.toolResults[0]!.startsWith(
      "Error: décision refusée par le pilote — décision d'arbitre invalide : aucune justification vérifiée — citation absente du corpus « phrase inventée ». ",
    ),
    w.arb.toolResults[0],
  );
  assert.ok(w.arb.toolResults[0]!.includes(`(essai 2/${ARBITER_RETRY_MAX + 1})`), w.arb.toolResults[0]);
  assert.equal(w.arb.toolResults[1], "décision enregistrée");
  const [entry] = journalOfContext(w.stateDir, w.repoKey, CTX);
  assert.deepEqual([entry!.answer, entry!.source, entry!.justification?.citations], ["YAML", "contexte", [FORMAT_FACT]]);
  assert.equal(w.feature("alpha").escalation, undefined);
  assert.deepEqual(w.notices, [], "rien n'appelle l'utilisateur : l'arbitre a tranché");
});

test("arbitre-jalons-et-visibilite : refusée à chaque essai, ou laissée sans nouvel appel, la décision escalade avec le VRAI motif du pilote — jamais « arbitre sans décision »", async () => {
  const bad = answer("YAML", "phrase inventée");
  const motive = "décision d'arbitre invalide : aucune justification vérifiée — citation absente du corpus « phrase inventée »";
  for (const calls of [Array.from({ length: ARBITER_RETRY_MAX + 1 }, () => bad), [bad]]) {
    const w = world((prompt) => (prompt.includes("question : Quel format de sortie ?") ? { calls } : { calls: [] }));
    await w.add("alpha");
    w.askInText("alpha", "Quel format de sortie ?");
    await w.until(() => w.feature("alpha").escalation !== undefined, "escaladée");
    assert.equal(w.feature("alpha").escalation!.reason, motive, `${calls.length} appel(s)`);
    assert.equal(w.arb.toolResults.length, calls.length);
    assert.equal(w.arb.toolResults.at(-1), calls.length > ARBITER_RETRY_MAX ? "décision enregistrée" : w.arb.toolResults[0]);
  }
  // L'outil seul : une escalade n'est jamais refusée, même quand tout le reste l'est.
  const capture: ArbiterCapture = { decision: null, check: () => "toujours refusé" };
  assert.equal(recordArbiterDecision(capture, { decision: "escalate", reason: "choix de produit" }).isError, false);
  assert.equal(capture.decision?.decision, "escalate");
});

test("arbitre-jalons-et-visibilite : une feature arbitrée est marquée « en file » dès sa mise en attente puis « décide » au départ de son tour, n'alerte personne pendant l'arbitrage, et n'alerte qu'à l'escalade, motif compris", async () => {
  const gate = Promise.withResolvers<void>();
  const w = world((prompt) => {
    if (prompt.includes("question : Quel format de sortie ?")) return { gate: gate.promise, calls: [answer("YAML", FORMAT_FACT)] };
    if (prompt.includes("question : Quelle couleur de logo ?")) return { calls: [{ decision: "escalate", reason: "identité visuelle : choix de produit" }] };
    return { calls: [] };
  });
  await w.add("alpha", "bravo");
  assert.equal(w.read().arbiter, true, "le lot dit qu'il est arbitré");

  w.askInText("alpha", "Quel format de sortie ?");
  await w.until(() => w.feature("alpha").arbitration?.status === "deciding", "le tour d'alpha a commencé");
  assert.equal(typeof w.feature("alpha").arbitration!.decidingAt, "number");

  // bravo attend derrière alpha dans la MÊME session de pilote : en file, pas « décide ».
  w.askInText("bravo", "Quelle couleur de logo ?");
  await w.until(() => w.feature("bravo").state === "waiting" && w.feature("bravo").arbitration !== undefined, "bravo marqué");
  assert.equal(w.feature("bravo").arbitration!.status, "queued");
  assert.equal(w.feature("bravo").escalation, undefined);
  assert.deepEqual(w.notices, [], "aucune alerte « attend ta réponse » pendant l'arbitrage");

  gate.resolve();
  await w.until(() => w.feature("bravo").escalation !== undefined, "bravo escaladé");
  assert.equal(w.feature("bravo").arbitration, undefined);
  const alert =
    `[pipeline] ${path.basename(w.repoRoot)}/bravo : l'arbitre te confie une question (maillon /req) — /pipelines\n` +
    "motif de l'arbitre : identité visuelle : choix de produit\nQuelle couleur de logo ?";
  assert.deepEqual(w.notices, [alert], "la seule alerte : l'escalade, avec son motif");
  assert.deepEqual(w.toasts, [alert]);
  assert.equal(journalOfContext(w.stateDir, w.repoKey, CTX)[0]!.answer, "YAML", "alpha tranché par l'arbitre, sans alerte");
});
