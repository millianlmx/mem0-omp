// Feature autonomie-par-paliers, partie S : la porte des specs (AC-6, AC-27, AC-28, AC-13, AC-1, AC-3, AC-34).
import test from "node:test";
import assert from "node:assert/strict";
import { humanWaitOf, WAIT_REASON } from "../../omp-harness/machine.ts";
import type { AutonomyRule } from "../../omp-harness/autonomy-rules.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import {
  autonomyDecisions,
  configure,
  eventsOf,
  implOf,
  lines,
  reviewOf,
  stateOf,
  until,
} from "../support/autonomie-fixtures.ts";

const SPECS_S = String(OK.specs[0]?.content);

/** La règle de référence de la porte des specs : tout run `docs`, specs en auto. */
const DOCS_SPECS_RULE_S: AutonomyRule = { match: { kind: "docs" }, require: {}, gates: { specs: "auto", review: "human" } };

const HUMAN_RULES_S: AutonomyRule[] = [
  { match: { kind: "docs" }, require: {}, gates: { specs: "human", review: "human" } },
  { match: { kind: "bug" }, require: {}, gates: { specs: "human", review: "human" } },
];

const BLOQUANT_S = {
  target: "AC-1",
  kind: "critere_faible",
  severity: "bloquant",
  claim: "un CSV vide satisfait AC-1 : le critère ne prouve pas l'export des données",
  evidence: "AC-1 (B-1) : … Then un CSV est produit",
  suggestion: "Then le CSV a une ligne par enregistrement",
};

const BLOCKED_IMPL_S = [[{ sleep: 60_000 }]];

type SpecsGateS = true | "auto";

/** Un monde dont /specs écrit `specs` ; /impl, s'il part, dort (le test juge la porte, pas la suite). */
function worldS(options: {
  rules: AutonomyRule[] | null;
  gate: SpecsGateS;
  specs?: string;
  challenge?: boolean;
  impl?: unknown[];
}): FakeWorld {
  const specs = options.specs === undefined ? OK.specs : [{ write: ".harness/specs.md", content: options.specs }];
  return fakeWorld(
    {
      req: [OK.req],
      specs: options.challenge === true ? [specs, specs] : [specs],
      ...(options.challenge === true ? { contradicteur: [[{ tool: "challenge_report", args: { findings: [BLOQUANT_S] } }]] } : {}),
      impl: options.impl ?? BLOCKED_IMPL_S,
      review: [reviewOf()],
    },
    {
      patch: configure(options.rules, (config: HarnessConfig) => {
        config.review.specsGate = options.gate;
        if (options.challenge === true) config.challenge.steps = ["specs"];
      }),
    },
  );
}

function docsRunS(world: FakeWorld, extra: { projectId?: string; projectOrder?: number } = {}) {
  return world.orchestrator.createRun({
    repo: "demo",
    title: "Documenter l'export",
    request: "Documenter",
    kind: "docs",
    lane: "full",
    ...extra,
  });
}

/** Laisse passer quelques tours : l'autonomie a eu toute occasion d'agir. */
async function ticksS(world: FakeWorld): Promise<void> {
  for (let i = 0; i < 6; i++) await world.orchestrator.tick();
}

/** Le run attend l'humain à la porte des specs, sans aucune trace d'autonomie, et `specs_ready` est parti. */
async function assertHumanSpecsS(world: FakeWorld, runId: string, wait: "specs" | "irreversible", label: string) {
  await until(world, runId, ["awaiting_human", "merged", "failed"]);
  await ticksS(world);
  const run = world.store.getRun(runId);
  assert.equal(run?.state, "awaiting_human", `${label} : ${stateOf(world, runId)}`);
  assert.equal(run?.step, "specs", label);
  assert.equal(humanWaitOf(run as never), wait, label);
  assert.equal(autonomyDecisions(world, runId).length, 0, `${label} : aucune décision d'autonomie`);
  assert.equal(eventsOf(world, runId, "autonomy").length, 0, `${label} : aucun événement autonomy`);
  assert.equal(eventsOf(world, runId, "specs_ready").length, 1, `${label} : specs_ready publié une fois`);
  assert.equal(eventsOf(world, runId, "specs_ready")[0]?.payload.reason, run?.reason, label);
  assert.equal(world.store.listRuns({}).length, 1, `${label} : aucun run enfant`);
}

async function withWorldS<T>(world: FakeWorld, body: () => Promise<T>): Promise<T> {
  await world.orchestrator.start();
  try {
    return await body();
  } finally {
    await world.orchestrator.stop();
  }
}

test("autonomie-par-paliers/AC-6 : specsGate true, règle docs en specs: auto, specs sans raison de porte → /impl part seul, décision citant la règle", async () => {
  const world = worldS({ rules: [DOCS_SPECS_RULE_S], gate: true });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await waitFor(
      () => autonomyDecisions(world, run.id).length > 0 && world.store.getRun(run.id)?.step === "impl",
      () => stateOf(world, run.id),
      60_000,
    );
    const live = world.store.getRun(run.id);
    assert.notEqual(live?.state, "awaiting_human", stateOf(world, run.id));
    const [decision, ...others] = autonomyDecisions(world, run.id);
    assert.equal(others.length, 0);
    assert.equal(decision?.status, "auto");
    assert.equal(decision?.autonomy?.gate, "specs");
    assert.equal(decision?.autonomy?.rule.rank, 1);
    assert.deepEqual(decision?.autonomy?.rule.match, { kind: "docs" });
    assert.equal(decision?.autonomy?.rule.gates.specs, "auto");
    assert.equal(decision?.autonomy?.proofs.kind, "docs");
    assert.deepEqual(decision?.autonomy?.proofs.gateReasons, []);
    assert.match(decision?.question ?? "", /Valider les specs sans geste humain/);
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy").map((event) => event.payload.action),
      ["hold", "validate"],
    );
    assert.equal(eventsOf(world, run.id, "specs_ready").length, 0, "la notification est retenue");
    const states = eventsOf(world, run.id, "run_state").map((event) => event.payload);
    const validated = states.find((payload) => payload.reason === "specs validées par l'autonomie");
    assert.ok(validated, `une transition « specs validées par l'autonomie » : ${JSON.stringify(states)}`);
    assert.equal(validated.by, "autonomie:demo#1");
    const validation = eventsOf(world, run.id, "validation")[0];
    assert.equal(validation?.payload.gate, "specs");
    assert.equal(validation?.payload.approve, true);
    assert.equal(validation?.payload.liftable, true);
  });
});

test("autonomie-par-paliers/AC-27 : découpage, modules vides, première feature, désaccord ouvert → l'humain, sous specsGate auto comme true", async () => {
  const cases = [
    {
      reason: "découpage proposé",
      specs: SPECS_S.replace(
        "## Découpage\naucun\n",
        "## Découpage\n- Export JSON — Exporter aussi en JSON — src/api, docs\n- Export XML — Exporter en XML\n",
      ),
    },
    { reason: "modules vides", specs: SPECS_S.replace("## Modules\n- src/api\n", "## Modules\n") },
    { reason: "première feature d'un projet", project: true },
    { reason: "désaccord avec le contradicteur", challenge: true },
  ];
  const gates: SpecsGateS[] = ["auto", true];
  await Promise.all(
    cases.flatMap((entry) =>
      gates.map(async (gate) => {
        const label = `${entry.reason} (specsGate ${String(gate)})`;
        const world = worldS({
          rules: [DOCS_SPECS_RULE_S],
          gate,
          ...(entry.specs !== undefined ? { specs: entry.specs } : {}),
          ...(entry.challenge === true ? { challenge: true } : {}),
        });
        await withWorldS(world, async () => {
          if (entry.project === true) world.store.createProject({ id: "proj-s", repo: "demo", title: "Projet" });
          const run = docsRunS(world, entry.project === true ? { projectId: "proj-s", projectOrder: 0 } : {});
          await assertHumanSpecsS(world, run.id, "specs", label);
          const reason = world.store.getRun(run.id)?.reason ?? "";
          if (gate === "auto") assert.ok(reason.includes(entry.reason), `${label} : raison « ${reason} »`);
        });
      }),
    ),
  );
});

test("autonomie-par-paliers/AC-28 : une règle docs portant paths, maxDiffLines ou require ne lève pas les specs ; une seconde règle docs le fait", async () => {
  const variants: { name: string; rule: AutonomyRule }[] = [
    { name: "match.paths", rule: { ...DOCS_SPECS_RULE_S, match: { kind: "docs", paths: ["docs/"] } } },
    { name: "match.maxDiffLines", rule: { ...DOCS_SPECS_RULE_S, match: { kind: "docs", maxDiffLines: 50 } } },
    { name: "require.reproTest", rule: { ...DOCS_SPECS_RULE_S, require: { reproTest: true } } },
    { name: "require.greenChecks", rule: { ...DOCS_SPECS_RULE_S, require: { greenChecks: true } } },
    { name: "require.proofs", rule: { ...DOCS_SPECS_RULE_S, require: { proofs: true } } },
  ];
  await Promise.all(
    variants.map(async ({ name, rule }) => {
      const alone = worldS({ rules: [rule], gate: true });
      await withWorldS(alone, async () => {
        const run = docsRunS(alone);
        await assertHumanSpecsS(alone, run.id, "specs", `${name}, seule`);
      });
      const followed = worldS({ rules: [rule, DOCS_SPECS_RULE_S], gate: true });
      await withWorldS(followed, async () => {
        const run = docsRunS(followed);
        await waitFor(
          () => autonomyDecisions(followed, run.id).length > 0 && followed.store.getRun(run.id)?.step === "impl",
          () => `${name}, suivie : ${stateOf(followed, run.id)}`,
          60_000,
        );
        assert.notEqual(followed.store.getRun(run.id)?.state, "awaiting_human", `${name}, suivie`);
        const [decision] = autonomyDecisions(followed, run.id);
        assert.equal(decision?.autonomy?.rule.rank, 2, `${name} : la seconde règle s'applique`);
        const validated = eventsOf(followed, run.id, "run_state").find(
          (event) => event.payload.reason === "specs validées par l'autonomie",
        );
        assert.equal(validated?.payload.by, "autonomie:demo#2", name);
        assert.equal(eventsOf(followed, run.id, "specs_ready").length, 0, name);
      });
    }),
  );
});

test("autonomie-par-paliers/AC-13 : des specs à geste irréversible restent à l'humain, sous specsGate auto (irreversible) comme true", async () => {
  const specs = SPECS_S.replace(
    "S-1 (AC-1) : export CSV",
    "S-1 (AC-1) : export CSV, puis supprimer les données exportées",
  );
  const auto = worldS({ rules: [DOCS_SPECS_RULE_S], gate: "auto", specs });
  await withWorldS(auto, async () => {
    const run = docsRunS(auto);
    await assertHumanSpecsS(auto, run.id, "irreversible", "specsGate auto");
    assert.match(auto.store.getRun(run.id)?.reason ?? "", /geste irréversible/);
  });
  const strict = worldS({ rules: [DOCS_SPECS_RULE_S], gate: true, specs });
  await withWorldS(strict, async () => {
    const run = docsRunS(strict);
    await assertHumanSpecsS(strict, run.id, "specs", "specsGate true");
    const reason = strict.store.getRun(run.id)?.reason ?? "";
    assert.equal(reason, WAIT_REASON.specs, "la raison de l'attente ne nomme pas le geste irréversible");
    assert.doesNotMatch(reason, /irréversible/);
  });
});

test("autonomie-par-paliers/AC-1 : sans champ autonomy, specsGate true, un run docs attend l'humain aux specs comme avant, sans décision", async () => {
  const world = worldS({ rules: null, gate: true });
  assert.equal(world.config.repos.find((repo) => repo.name === "demo")?.autonomy, undefined);
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await assertHumanSpecsS(world, run.id, "specs", "sans autonomy");
    assert.equal(world.store.getRun(run.id)?.reason, WAIT_REASON.specs);
  });
});

test("autonomie-par-paliers/AC-3 : des règles toutes human laissent les specs à l'humain, specs_ready publié", async () => {
  const world = worldS({ rules: HUMAN_RULES_S, gate: true });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await assertHumanSpecsS(world, run.id, "specs", "règles human");
    assert.equal(world.store.getRun(run.id)?.reason, WAIT_REASON.specs);
  });
});

test("autonomie-par-paliers/AC-34 : validation des specs renversée pendant /impl → l'humain aux specs, travail gardé ; la revue qui suit n'est plus levée seule", async () => {
  const partial = [{ write: "src/api/export.ts", content: lines(40) }, { sleep: 60_000 }];
  const rules: AutonomyRule[] = [
    { match: { kind: "docs", maxDiffLines: 50 }, require: {}, gates: { specs: "human", review: "auto" } },
    DOCS_SPECS_RULE_S,
  ];
  const world = worldS({ rules, gate: true, impl: [partial, implOf(40, "added")] });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    // La règle 2 lève les specs ; /impl démarre, écrit son travail et dort.
    await waitFor(
      () => {
        const live = world.store.getRun(run.id);
        return (
          autonomyDecisions(world, run.id).length === 1 &&
          live?.step === "impl" &&
          live.state === "running"
        );
      },
      () => stateOf(world, run.id),
      60_000,
    );
    await waitFor(
      () => world.store.getRun(run.id)?.worktree != null,
      () => stateOf(world, run.id),
    );
    const [decision] = autonomyDecisions(world, run.id);
    assert.equal(decision?.autonomy?.gate, "specs");
    assert.equal(decision?.autonomy?.rule.rank, 2, "la règle 1 ne correspond jamais à la porte specs");
    const worktree = world.store.getRun(run.id)?.worktree as string;
    await waitFor(
      () => git(worktree, "status", "--porcelain").includes("src/api/export.ts") || tracked(worktree),
      () => "le travail de /impl n'est pas écrit",
    );

    // Le renversement, avant le merge.
    const reversed = await world.orchestrator.reverseDecision(
      run.id,
      decision?.seq as number,
      "laisser à l'humain",
      "je relis les specs",
      { by: "humain" },
    );
    assert.equal(reversed.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(humanWaitOf(reversed), "specs");
    assert.equal(eventsOf(world, run.id, "specs_ready").length, 1, "un seul specs_ready (celui du renversement)");
    assert.equal(world.store.getDecision(run.id, decision?.seq as number)?.status, "reversed");
    const rework = eventsOf(world, run.id, "decision_reversed");
    assert.equal(rework.length, 1);
    assert.equal(rework[0]?.payload.mode, "rework");
    assert.match(world.store.instructions(run.id) ?? "", /renversé la validation des specs par l'autonomie/);
    assert.ok(tracked(worktree), "le travail de /impl est commité sur la branche");
    assert.equal(git(worktree, "status", "--porcelain").trim(), "", "rien n'est défait ni laissé sale");

    // L'humain valide les specs : /impl reprend sur la branche gardée, puis la revue juge 40 > 30 lignes.
    await world.orchestrator.validate(run.id, true, "specs relues", { by: "humain" });
    await waitFor(
      () => {
        const live = world.store.getRun(run.id);
        if (live?.state === "merged" || live?.state === "failed") throw new Error(`le run ne devait pas finir : ${stateOf(world, run.id)}`);
        return live?.state === "awaiting_human" && humanWaitOf(live) === "verdict";
      },
      () => stateOf(world, run.id),
      60_000,
    );
    await ticksS(world);
    const waiting = world.store.getRun(run.id);
    assert.equal(waiting?.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(humanWaitOf(waiting as never), "verdict");
    const evidence = JSON.parse(world.store.getArtifact(run.id, "_review-evidence.json") ?? "null") as {
      merge: { auto: boolean };
      evidence: { diffLines: number; maxDiffLines: number; fullTests: string };
    };
    assert.equal(evidence.merge.auto, false);
    assert.equal(evidence.evidence.diffLines, 40);
    assert.equal(evidence.evidence.maxDiffLines, 30);
    assert.equal(evidence.evidence.fullTests, "pass");
    assert.equal(eventsOf(world, run.id, "verdict").length, 1, "le verdict est notifié à l'humain");
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy").map((event) => event.payload.action),
      ["hold", "validate"],
      "aucun nouveau hold ni validate depuis le renversement",
    );
    assert.equal(autonomyDecisions(world, run.id).length, 1, "aucune nouvelle décision d'autonomie");
  });
});

/** Le fichier de /impl est dans l'arbre de `HEAD` (commité). */
function tracked(worktree: string): boolean {
  return git(worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes("src/api/export.ts");
}
