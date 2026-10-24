// Feature harness-contradicteur : en fin de /req et de /specs, un agent neuf (autre
// contexte, autre fournisseur si la chaîne en a un) relit l'artefact en lecture seule et
// rend ses constats ; l'auteur corrige ou réfute chacun dans l'artefact ; un constat
// bloquant non corrigé est un désaccord que la porte des specs soumet à l'humain.
// La revue, elle, tourne de préférence chez un autre fournisseur que l'implémenteur.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import {
  CHALLENGE_ARTIFACT,
  MAX_FINDINGS,
  disputes,
  parseAnswers,
  parseFindings,
  unanswered,
} from "../../omp-harness/challenge.ts";
import type { Finding } from "../../omp-harness/challenge.ts";
import { defaultConfig, validateConfig } from "../../omp-harness/config.ts";
import { nextAfter } from "../../omp-harness/machine.ts";
import { chainStart, providerOfLabel } from "../../omp-harness/runner-session.ts";
import { challengeUnit, gateReasons } from "../../omp-harness/steps.ts";

const SPECS = OK.specs[0]?.content ?? "";

const BLOQUANT = {
  target: "AC-1",
  kind: "critere_faible",
  severity: "bloquant",
  claim: "un CSV vide satisfait AC-1 : le critère ne prouve pas l'export des données",
  evidence: "AC-1 (B-1) : … Then un CSV est produit",
  suggestion: "Then le CSV a une ligne par enregistrement",
};

function report(findings: Record<string, unknown>[]): Record<string, unknown>[] {
  return [{ tool: "challenge_report", args: { findings } }];
}

function answered(line: string): Record<string, unknown>[] {
  return [{ write: ".harness/specs.md", content: `${SPECS}## Contradicteur\n${line}\n` }];
}

function finding(patch: Partial<Finding>): Finding {
  return {
    id: "C-1",
    target: "",
    kind: "ambiguite",
    severity: "majeur",
    claim: "c",
    evidence: "e",
    suggestion: "",
    ...patch,
  };
}

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

async function settle(world: FakeWorld, runId: string): Promise<void> {
  await waitFor(
    () => ["awaiting_human", "merged", "failed"].includes(world.store.getRun(runId)?.state ?? ""),
    () => stateOf(world, runId),
    30_000,
  );
}

// -- règles pures -------------------------------------------------------------

test("harness-contradicteur/AC-1 : challenge_report — type et gravité connus, preuve obligatoire, cible B-n/AC-n/S-n ; bloquants d'abord, ids C-n, au plus 8", () => {
  const minor = { ...BLOQUANT, severity: "mineur", claim: "mineur" };
  const parsed = parseFindings({ findings: [minor, BLOQUANT] });
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.findings.map((f) => [f.id, f.severity]),
    [
      ["C-1", "bloquant"],
      ["C-2", "mineur"],
    ],
  );
  assert.deepEqual(parseFindings({ findings: [] }), { ok: true, findings: [] });
  assert.equal(parseFindings({}).ok, false);
  const noEvidence = parseFindings({ findings: [{ ...BLOQUANT, evidence: " " }] });
  assert.ok(!noEvidence.ok && /evidence/.test(noEvidence.error));
  assert.equal(parseFindings({ findings: [{ ...BLOQUANT, kind: "style" }] }).ok, false);
  assert.equal(parseFindings({ findings: [{ ...BLOQUANT, severity: "critique" }] }).ok, false);
  assert.equal(parseFindings({ findings: [{ ...BLOQUANT, target: "ligne 3" }] }).ok, false);
  const many = parseFindings({ findings: Array.from({ length: 12 }, () => BLOQUANT) });
  assert.ok(many.ok && many.findings.length === MAX_FINDINGS);
});

test("harness-contradicteur/AC-2 : les réponses se lisent dans `## Contradicteur` seulement ; un bloquant non corrigé (réfuté ou muet) est un désaccord, un majeur réfuté non, un mineur n'attend pas de réponse", () => {
  const md =
    "## Spécifications\nC-3 : corrigé — hors section, ignoré\n## Contradicteur\n- C-1 : **réfuté** — le test vérifie le contenu\nC-2 : Corrige : AC-2 précisé\nC-4: refutée\n";
  const answers = parseAnswers(md);
  assert.deepEqual(Object.fromEntries(answers), {
    "C-1": { status: "réfuté", note: "le test vérifie le contenu" },
    "C-2": { status: "corrigé", note: "AC-2 précisé" },
    "C-4": { status: "réfuté", note: "" },
  });
  const findings = [
    finding({ id: "C-1", severity: "bloquant" }),
    finding({ id: "C-2", severity: "bloquant" }),
    finding({ id: "C-3", severity: "bloquant" }),
    finding({ id: "C-4", severity: "majeur" }),
    finding({ id: "C-5", severity: "mineur" }),
  ];
  assert.deepEqual(unanswered(findings, answers), ["C-3"]);
  assert.deepEqual(disputes(findings, answers), ["C-1", "C-3"]);
});

test("harness-contradicteur/AC-3 : la porte « auto » nomme ses raisons ; un désaccord avec le contradicteur en est une", () => {
  const solo = { projectId: null, projectOrder: 0 };
  assert.deepEqual(gateReasons(solo, SPECS), []);
  assert.deepEqual(
    gateReasons({ projectId: "p", projectOrder: 0 }, SPECS.replace("## Modules\n- src/api\n", "## Modules\n")),
    ["modules vides", "première feature d'un projet"],
  );
  const limits = { fixCap: 3, retryBackoffSec: [], specsGate: "auto" as const, mergeRetries: 3 };
  const gated = nextAfter(
    { step: "specs", fixes: 0, attempts: 0 },
    { kind: "done", escalations: 0, gateNeeded: true, gateReasons: ["désaccord avec le contradicteur (/specs C-1)"] },
    limits,
  );
  assert.equal(gated.state, "awaiting_human");
  assert.equal(gated.reason, "specs à valider avant /impl : désaccord avec le contradicteur (/specs C-1)");
});

test("harness-contradicteur/AC-4 : le fournisseur d'un regard indépendant — premier modèle d'un autre fournisseur de la chaîne, sinon le début ; l'unité du contradicteur passe le lanceur", () => {
  const chain = [
    { provider: "alpha", model: "a1" },
    { provider: "alpha", model: "a2" },
    { provider: "beta", model: "b1" },
  ];
  assert.equal(chainStart(chain, null), 0);
  assert.equal(chainStart(chain, "alpha"), 2);
  assert.equal(chainStart(chain, "beta"), 0);
  assert.equal(chainStart(chain.slice(0, 2), "alpha"), 0);
  assert.equal(providerOfLabel("openrouter/anthropic/claude"), "openrouter");
  assert.equal(providerOfLabel(null), null);
  assert.match(challengeUnit("r_ab12", 7), /^omp-runner-[A-Za-z0-9_-]+$/);
});

test("harness-contradicteur/AC-5 : configuration — relit /req et /specs en heavy par défaut, revue chez un autre fournisseur ; une étape ou un tier inconnus sont refusés", () => {
  const config = defaultConfig("/tmp/harness-contradicteur");
  assert.deepEqual(config.challenge, { steps: ["req", "specs"], tier: "heavy" });
  assert.equal(config.review.crossProvider, true);
  const bad = (patch: (c: ReturnType<typeof defaultConfig>) => void): string => {
    const candidate = defaultConfig("/tmp/harness-contradicteur");
    patch(candidate);
    try {
      validateConfig(candidate);
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  assert.match(
    bad((c) => (c.challenge.steps = ["impl" as "req"])),
    /challenge\.steps/,
  );
  assert.match(
    bad((c) => (c.challenge.tier = "giant" as "heavy")),
    /challenge\.tier/,
  );
  assert.match(
    bad((c) => (c.review.crossProvider = "oui" as unknown as boolean)),
    /review\.crossProvider/,
  );
  assert.equal(
    bad((c) => (c.challenge.steps = [])),
    "",
  );
});

// -- conduite -----------------------------------------------------------------

test("harness-contradicteur/AC-6 : un bloquant réfuté par l'auteur arrête le run à la porte des specs, avec le rapport ; ce que le contradicteur a écrit est jeté", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs, answered("C-1 : réfuté — le test AC-1 vérifie le contenu du CSV")],
      contradicteur: [
        [
          { write: "src/api/pirate.ts", content: "// écrit par le contradicteur\n" },
          { write: ".harness/specs.md", content: "saboté" },
          ...report([BLOQUANT, { ...BLOQUANT, severity: "mineur", target: "", claim: "pour mémoire" }]),
        ],
      ],
      impl: [OK.impl],
      review: [OK.review],
    },
    {
      patch: (config) => {
        config.review.specsGate = "auto";
        config.challenge.steps = ["specs"];
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settle(world, run.id);
    const gated = world.store.getRun(run.id);
    assert.deepEqual([gated?.state, gated?.step], ["awaiting_human", "specs"], stateOf(world, run.id));
    assert.match(gated?.reason ?? "", /désaccord avec le contradicteur \(\/specs C-1\)/);

    const log = world.log();
    const critic = log.find((entry) => entry.kind === "prompt" && entry.step === "contradicteur");
    assert.match(String(critic?.message), /^# \/contradicteur — relecture de `specs\.md` de « Export CSV »/);
    assert.match(String(critic?.message), /LECTURE SEULE/);
    const criticTools = log.find(
      (entry) => entry.kind === "command" && entry.type === "set_host_tools" && entry.pid === critic?.pid,
    );
    assert.deepEqual(criticTools?.tools, ["progress", "oracle_recall", "challenge_report"]);
    const answer = log.find(
      (entry) => entry.kind === "prompt" && String(entry.message).startsWith("# /specs — réponse au contradicteur"),
    );
    assert.ok(answer, "l'auteur reçoit les constats");
    assert.notEqual(answer.pid, critic?.pid, "l'auteur et le contradicteur sont deux runners");
    assert.match(String(answer.message), /\*\*C-1\*\* \(bloquant, critere_faible, AC-1\)/);
    assert.doesNotMatch(String(answer.message), /pour mémoire/, "un mineur n'attend pas de réponse");

    const worktree = gated?.worktree ?? "";
    assert.equal(fs.existsSync(path.join(worktree, "src/api/pirate.ts")), false);
    const specs = world.store.getArtifact(run.id, "specs.md") ?? "";
    assert.doesNotMatch(specs, /saboté/);
    assert.match(specs, /## Contradicteur\nC-1 : réfuté/);
    const rendered = world.store.getArtifact(run.id, CHALLENGE_ARTIFACT) ?? "";
    assert.match(rendered, /\*\*C-1\*\* \(bloquant, critere_faible, AC-1\)/);
    assert.match(rendered, /réponse de l'auteur : réfuté — le test AC-1 vérifie le contenu du CSV/);
    assert.match(rendered, /Désaccord à trancher : C-1\./);
    const event = world.store.eventsSince(0, run.id).find((item) => item.type === "challenge");
    assert.deepEqual([event?.payload.step, event?.payload.findings, event?.payload.disputes], ["specs", 2, ["C-1"]]);

    // L'humain arbitre : la feature reprend jusqu'au merge.
    await world.orchestrator.validate(run.id, true, "le test suffit", { by: "test" });
    await settle(world, run.id);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-contradicteur/AC-7 : un constat corrigé ne retient pas le run ; /req sans constat n'appelle pas de réponse ; le rapport garde les deux passages", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs, answered("C-1 : corrigé — AC-1 exige une ligne par enregistrement")],
      contradicteur: [report([]), report([{ ...BLOQUANT, severity: "majeur" }])],
      impl: [OK.impl],
      review: [OK.review],
    },
    {
      patch: (config) => {
        config.review.specsGate = "auto";
        config.challenge.steps = ["req", "specs"];
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settle(world, run.id);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const log = world.log();
    assert.equal(log.filter((entry) => entry.kind === "prompt" && entry.step === "contradicteur").length, 2);
    const answers = log.filter(
      (entry) => entry.kind === "prompt" && / — réponse au contradicteur/.test(String(entry.message)),
    );
    assert.deepEqual(
      answers.map((entry) => entry.step),
      ["specs"],
    );
    const events = world.store.eventsSince(0, run.id).filter((item) => item.type === "challenge");
    assert.deepEqual(
      events.map((item) => [item.payload.step, item.payload.findings, item.payload.disputes]),
      [
        ["req", 0, []],
        ["specs", 1, []],
      ],
    );
    const rendered = world.store.getArtifact(run.id, CHALLENGE_ARTIFACT) ?? "";
    assert.match(rendered, /## \/req — relu par/);
    assert.match(rendered, /Rien à redire\./);
    assert.match(rendered, /réponse de l'auteur : corrigé/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-contradicteur/AC-8 : un bloquant laissé sans réponse est relancé une fois, puis compte comme un désaccord", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs, OK.specs],
      contradicteur: [report([BLOQUANT])],
    },
    {
      patch: (config) => {
        config.review.specsGate = "auto";
        config.challenge.steps = ["specs"];
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settle(world, run.id);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    assert.match(world.store.getRun(run.id)?.reason ?? "", /désaccord avec le contradicteur \(\/specs C-1\)/);
    const nudges = world.log().filter((entry) => entry.kind === "prompt" && entry.step === "specs" && entry.nudge);
    assert.equal(nudges.length, 1);
    assert.match(String(nudges[0]?.message), /C-1 sans réponse dans la section `## Contradicteur`/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-contradicteur/AC-9 : un contradicteur qui ne rend rien (même après une relance) dégrade l'étape sans la bloquer", async () => {
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], contradicteur: [[]], impl: [OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.review.specsGate = "auto";
        config.challenge.steps = ["specs"];
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await settle(world, run.id);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const critic = world.log().filter((entry) => entry.kind === "prompt" && entry.step === "contradicteur");
    assert.equal(critic.length, 2, "une relance");
    const event = world.store.eventsSince(0, run.id).find((item) => item.type === "challenge");
    assert.equal(event?.payload.status, "failed");
    assert.match(String(event?.payload.reason), /challenge_report/);
    assert.equal(world.store.getArtifact(run.id, CHALLENGE_ARTIFACT), null);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-contradicteur/AC-10 : le contradicteur et la revue tournent chez un autre fournisseur que l'auteur relu ; `crossProvider: false` garde la revue en tête de chaîne", async () => {
  const models = (config: ReturnType<typeof defaultConfig>) => {
    config.models.heavy = [
      { provider: "alpha", model: "h1" },
      { provider: "beta", model: "h2" },
    ];
    config.models.standard = [{ provider: "alpha", model: "s1" }];
  };
  for (const crossProvider of [true, false]) {
    const world = fakeWorld(
      { req: [OK.req], specs: [OK.specs], contradicteur: [report([])], impl: [OK.impl], review: [OK.review] },
      {
        patch: (config) => {
          models(config);
          config.challenge.steps = ["specs"];
          config.review.crossProvider = crossProvider;
        },
      },
    );
    await world.orchestrator.start();
    try {
      const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
      await settle(world, run.id);
      assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
      const log = world.log();
      const modelOf = new Map<unknown, string>();
      for (const entry of log) {
        if (entry.kind !== "argv") continue;
        const argv = entry.argv as string[];
        modelOf.set(entry.pid, argv[argv.indexOf("--model") + 1] ?? "");
      }
      const modelFor = (step: string): string | undefined =>
        modelOf.get(log.find((entry) => entry.kind === "prompt" && entry.step === step)?.pid);
      assert.equal(modelFor("specs"), "alpha/h1");
      assert.equal(modelFor("contradicteur"), "beta/h2");
      assert.equal(modelFor("impl"), "alpha/s1");
      assert.equal(modelFor("review"), crossProvider ? "beta/h2" : "alpha/h1");
    } finally {
      await world.orchestrator.stop();
    }
  }
});
