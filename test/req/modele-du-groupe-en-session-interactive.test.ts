// Tests de la feature modele-du-groupe-en-session-interactive. Ce fichier est LE
// SEUL porteur des ids `modele-du-groupe-en-session-interactive/AC-<n>` (règle
// criteria/AC-13) : chaque lot de la feature y ajoute ses preuves.
//
// Lot BR-2 — `pi.setModel` dans les sessions interactives (/req, /specs, /impl,
// /impl --fix, /review). Les handlers sont ceux de l'extension, capturés par un
// faux `pi.registerCommand` ; git et le magasin d'état sont RÉELS (dépôts jetables,
// `MEM0_PIPELINE_STATE_DIR` / `MEM0_PIPELINE_WORKTREES_DIR` vers des dossiers
// temporaires). Seuls l'hôte OMP (`setModel`, `models`, `newSession`, dialogues) est
// doublé : un journal PARTAGÉ y consigne `newSession` et `setModel:<modèle>`, ce
// qui prouve l'ORDRE des appels.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

import reqExtension, {
  MODEL_GROUP_LABELS,
  launchConversationRun,
  lotPathFor,
  lotRepoKey,
  markExhausted,
  quotaStopReason,
  readLot,
  type ConversationLaunchDeps,
  type LotFeature,
} from "../../omp-mem0-req/extension.ts";
import { quotaDeadlineLabel } from "../../omp-mem0-req/quota.ts";
import { conversationOverlayPathFor } from "../../omp-mem0-req/runs.ts";
import { hostedSettingsOverrides } from "../../omp-mem0-req/serviceSessions.ts";
import { emptyGitRepo, gitRunner } from "../support/git.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL_A = "anthropic/claude-opus-4-7";
const MODEL_B = "cerebras/llama3.1-8b";
const MODEL_F = "anthropic/claude-haiku-4";
const DEFAULT_LABEL = "défaut OMP (aucun modèle)";
const NO_FALLBACK = "aucun repli";

const KNOWN = [
  { provider: "anthropic", id: "claude-opus-4-7" },
  { provider: "cerebras", id: "llama3.1-8b" },
  { provider: "anthropic", id: "claude-haiku-4" },
];

process.env.MEM0_PIPELINE_STATE_DIR = tmpdir("modele-du-groupe-default-state-");
process.env.MEM0_PIPELINE_WORKTREES_DIR = tmpdir("modele-du-groupe-default-wt-");

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Ce que `pi.setModel` fait du modèle reçu : rend true, rend false ou jette. */
type SetModelBehavior = "true" | "false" | "throw";

type App = {
  commands: Map<string, (args: string, ctx: never) => Promise<void>>;
  displayed: Array<{ customType?: string; content: string }>;
  seeds: string[];
  journal: string[];
  behavior: { setModel: SetModelBehavior };
  received: Array<{ provider: string; id: string }>;
  reset: () => void;
};

function mkApp(): App {
  const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const displayed: Array<{ customType?: string; content: string }> = [];
  const seeds: string[] = [];
  const journal: string[] = [];
  const behavior: { setModel: SetModelBehavior } = { setModel: "true" };
  const received: Array<{ provider: string; id: string }> = [];
  const pi = {
    registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
      commands.set(name, def.handler);
    },
    registerShortcut() {},
    registerFlag() {},
    getFlag: () => undefined,
    on() {},
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...(await gitRunner(args, options?.cwd ?? process.cwd())), killed: false };
    },
    sendMessage(payload: { customType?: string; content: string }) {
      displayed.push(payload);
    },
    sendUserMessage(text: string) {
      seeds.push(text);
    },
    async setModel(model: { provider: string; id: string }) {
      journal.push(`setModel:${model.provider}/${model.id}`);
      received.push(model);
      if (behavior.setModel === "throw") throw new Error("clé d'API révoquée");
      return behavior.setModel === "true";
    },
  };
  reqExtension(pi as never);
  const reset = () => {
    journal.length = 0;
    received.length = 0;
    displayed.length = 0;
    seeds.length = 0;
  };
  return { commands, displayed, seeds, journal, behavior, received, reset };
}

type MkCtxOptions = {
  answers?: Array<string | undefined>;
  hasUI?: boolean;
  /** `ok` : réussi ; `cancel` : `{cancelled: true}` ; `throw` : jette. */
  session?: "ok" | "cancel" | "throw";
  /** Les sélecteurs que `ctx.models.resolve` connaît (défaut : tout le catalogue). */
  resolvable?: string[];
};

function mkCtx(app: App, cwd: string, options: MkCtxOptions = {}) {
  const notices: Array<{ message: string; type?: string }> = [];
  const moved: string[] = [];
  const answers = [...(options.answers ?? [])];
  const hasUI = options.hasUI ?? true;
  const known = options.resolvable ?? KNOWN.map((m) => `${m.provider}/${m.id}`);
  const ui: Record<string, unknown> = {
    notify: (message: string, type?: string) => notices.push({ message, type }),
  };
  if (hasUI) ui.select = async () => answers.shift();
  const ctx: Record<string, unknown> = {
    cwd,
    hasUI,
    ui,
    waitForIdle: async () => {},
    models: {
      list: () => KNOWN,
      resolve: (selector: string) => KNOWN.find((m) => known.includes(selector) && `${m.provider}/${m.id}` === selector),
    },
    newSession: async (opts?: { setup?: (sm: { moveTo: (cwd: string) => Promise<void> }) => Promise<void> }) => {
      app.journal.push("newSession");
      if (options.session === "throw") throw new Error("hôte occupé");
      if (opts?.setup) {
        await opts.setup({
          moveTo: async (target: string) => {
            moved.push(target);
          },
        });
      }
      return { cancelled: options.session === "cancel" };
    },
  };
  return { ctx, notices, moved };
}

type Env = { root: string; stateDir: string };

/** Un dépôt et un magasin neufs, posés dans l'environnement le temps de `fn`. */
async function inRepo<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  const root = emptyGitRepo("modele-du-groupe-repo-");
  const stateDir = tmpdir("modele-du-groupe-state-");
  const base = tmpdir("modele-du-groupe-wt-");
  return withEnv({ MEM0_PIPELINE_STATE_DIR: stateDir, MEM0_PIPELINE_WORKTREES_DIR: base }, () => fn({ root, stateDir }));
}

const featureOf = (env: Env, slug: string): LotFeature | undefined =>
  readLot(env.stateDir, lotRepoKey(env.root))?.features.find((f) => f.slug === slug);

/** Marque un modèle épuisé pour une heure ; rend l'échéance. */
function exhaust(env: Env, selector: string): number {
  const provider = selector.split("/")[0] ?? "";
  const until = Date.now() + 3_600_000;
  markExhausted(env.stateDir, { model: selector, provider, until, announced: true, at: Date.now(), reason: "429" });
  return until;
}

const warnings = (notices: Array<{ message: string; type?: string }>) => notices.filter((n) => n.type === "warning");
const lastWelcome = (app: App) => app.displayed.filter((d) => d.customType === "req").at(-1)?.content ?? "";
const modelLine = (welcome: string) => welcome.split("\n").at(-1) ?? "";
const REQ_LABEL = MODEL_GROUP_LABELS.modelReqSpecs;
const IMPL_LABEL = MODEL_GROUP_LABELS.modelImplReview;

/** Ouvre une feature par le VRAI /req (succès) ; rend son worktree. */
async function openFeature(
  app: App,
  env: Env,
  slug: string,
  answers: Array<string | undefined>,
  hasUI = true,
): Promise<string> {
  await app.commands.get("req")!(slug, mkCtx(app, env.root, { answers, hasUI }).ctx as never);
  const created = featureOf(env, slug);
  assert.ok(created, `la feature ${slug} est enrôlée`);
  app.reset();
  return created.worktree;
}

// ---------------------------------------------------------------------------
// /req (S-3) — AC-1 à AC-6
// ---------------------------------------------------------------------------

test("modele-du-groupe-en-session-interactive/AC-1 : /req applique le principal non épuisé après newSession et le nomme dans l'accueil", async () => {
  await inRepo(async (env) => {
    const app = mkApp();
    const { ctx, notices } = mkCtx(app, env.root, { answers: [MODEL_A, MODEL_F, MODEL_B, NO_FALLBACK] });
    await app.commands.get("req")!("alpha", ctx as never);

    assert.deepEqual(app.journal, ["newSession", `setModel:${MODEL_A}`], "un seul setModel, APRÈS newSession");
    assert.deepEqual(app.received, [KNOWN[0]], "setModel reçoit le modèle résolu de P");
    const line = modelLine(lastWelcome(app));
    assert.ok(line.startsWith("Modèle : "), "dernière ligne de l'accueil");
    assert.ok(line.includes(MODEL_A) && line.includes(REQ_LABEL), line);
    assert.deepEqual(warnings(notices), [], "aucun avertissement");
  });
});

test("modele-du-groupe-en-session-interactive/AC-2 : /req applique le repli quand le principal est épuisé", async () => {
  await inRepo(async (env) => {
    const until = exhaust(env, MODEL_A);
    const app = mkApp();
    const { ctx, notices } = mkCtx(app, env.root, { answers: [MODEL_A, MODEL_F, MODEL_B, NO_FALLBACK] });
    await app.commands.get("req")!("alpha", ctx as never);

    assert.deepEqual(app.journal, ["newSession", `setModel:${MODEL_F}`], "le repli, jamais le principal");
    const line = modelLine(lastWelcome(app));
    assert.ok(line.includes(MODEL_F) && line.includes("repli"), line);
    assert.ok(line.includes(quotaStopReason({ model: MODEL_A, provider: "anthropic", until, announced: true })), line);
    assert.deepEqual(warnings(notices), [], "un repli appliqué n'est pas un avertissement");
  });
});

test("modele-du-groupe-en-session-interactive/AC-3 : /req garde le modèle de la session quand ni principal ni repli n'est disponible", async () => {
  for (const withFallback of [false, true]) {
    await inRepo(async (env) => {
      const until = exhaust(env, MODEL_A);
      if (withFallback) exhaust(env, MODEL_F);
      const app = mkApp();
      const { ctx, notices, moved } = mkCtx(app, env.root, {
        answers: [MODEL_A, withFallback ? MODEL_F : NO_FALLBACK, MODEL_B, NO_FALLBACK],
      });
      await app.commands.get("req")!("alpha", ctx as never);

      assert.deepEqual(app.journal, ["newSession"], "aucun setModel");
      const reason = quotaStopReason({ model: MODEL_A, provider: "anthropic", until, announced: true });
      const warned = warnings(notices);
      assert.equal(warned.length, 1);
      assert.ok(warned[0]!.message.startsWith("[req] ") && warned[0]!.message.includes(reason), warned[0]!.message);
      assert.ok(modelLine(lastWelcome(app)).includes(MODEL_A));
      assert.equal(moved.length, 1, "la session relocalisée est conservée");
      const enrolled = featureOf(env, "alpha");
      assert.equal(enrolled?.modelReqSpecs, MODEL_A, "la feature est enrôlée comme aujourd'hui");
      assert.equal(enrolled?.fallbackReqSpecs ?? null, withFallback ? MODEL_F : null);
    });
  }
});

test("modele-du-groupe-en-session-interactive/AC-4 : /req sur défaut OMP n'appelle pas setModel et le dit", async () => {
  await inRepo(async (env) => {
    const app = mkApp();
    const { ctx, notices } = mkCtx(app, env.root, { answers: [DEFAULT_LABEL, NO_FALLBACK, MODEL_B, NO_FALLBACK] });
    await app.commands.get("req")!("alpha", ctx as never);

    assert.deepEqual(app.journal, ["newSession"], "aucun setModel");
    const line = modelLine(lastWelcome(app));
    assert.ok(line.startsWith("Modèle : modèle de la session conservé"), line);
    assert.deepEqual(warnings(notices), []);
  });
});

test("modele-du-groupe-en-session-interactive/AC-5 : /req avertit quand setModel rend false, jette ou que le modèle est inconnu, sans rien casser", async () => {
  const cases: Array<{ name: string; behavior: SetModelBehavior; resolvable?: string[]; reason: string }> = [
    { name: "false", behavior: "false", reason: "aucune clé d'API" },
    { name: "jette", behavior: "throw", reason: "clé d'API révoquée" },
    { name: "inconnu", behavior: "true", resolvable: [MODEL_B], reason: "modèle inconnu" },
  ];
  for (const c of cases) {
    await inRepo(async (env) => {
      const app = mkApp();
      app.behavior.setModel = c.behavior;
      const { ctx, notices, moved } = mkCtx(app, env.root, {
        answers: [MODEL_A, MODEL_F, MODEL_B, NO_FALLBACK],
        resolvable: c.resolvable,
      });
      await app.commands.get("req")!("alpha", ctx as never);

      const warned = warnings(notices);
      assert.equal(warned.length, 1, c.name);
      assert.equal(warned[0]!.message, `[req] modèle ${MODEL_A} non appliqué (${c.reason}) — modèle de la session conservé`, c.name);
      assert.equal(app.journal.includes(`setModel:${MODEL_A}`), c.name !== "inconnu", `${c.name} : setModel seulement si le modèle est résolu`);
      assert.equal(moved.length, 1, "la session relocalisée est conservée");
      const enrolled = featureOf(env, "alpha");
      assert.deepEqual(
        [enrolled?.modelReqSpecs, enrolled?.fallbackReqSpecs, enrolled?.modelImplReview, enrolled?.fallbackImplReview ?? null],
        [MODEL_A, MODEL_F, MODEL_B, null],
        `${c.name} : les quatre clés de modèle`,
      );
      assert.ok(modelLine(lastWelcome(app)).includes(MODEL_A), "l'accueil nomme P");
    });
  }
});

test("modele-du-groupe-en-session-interactive/AC-6 : /req n'appelle pas setModel quand newSession échoue ou est annulé", async () => {
  for (const session of ["cancel", "throw"] as const) {
    await inRepo(async (env) => {
      const app = mkApp();
      const { ctx, notices } = mkCtx(app, env.root, { answers: [MODEL_A, MODEL_F, MODEL_B, NO_FALLBACK], session });
      await app.commands.get("req")!("alpha", ctx as never);

      assert.deepEqual(app.journal, ["newSession"], `${session} : aucun setModel`);
      assert.equal(featureOf(env, "alpha"), undefined, "la feature n'est pas enrôlée");
      assert.ok(notices.some((n) => n.message.includes("session dans le worktree impossible")), session);
    });
  }
});

// ---------------------------------------------------------------------------
// /specs, /impl, /impl --fix, /review (S-4) — AC-7 à AC-10
// ---------------------------------------------------------------------------

const PHASES: Array<{ command: string; args: string; tag: string; label: string; model: string }> = [
  { command: "specs", args: "", tag: "specs", label: REQ_LABEL, model: MODEL_A },
  { command: "impl", args: "", tag: "impl", label: IMPL_LABEL, model: MODEL_B },
  { command: "impl", args: "--fix", tag: "impl", label: IMPL_LABEL, model: MODEL_B },
  { command: "review", args: "", tag: "review", label: IMPL_LABEL, model: MODEL_B },
];

test("modele-du-groupe-en-session-interactive/AC-7 : /specs applique le groupe req+specs, /impl, /impl --fix et /review le groupe impl+review, après newSession", async () => {
  await inRepo(async (env) => {
    const app = mkApp();
    const worktree = await openFeature(app, env, "alpha", [MODEL_A, NO_FALLBACK, MODEL_B, NO_FALLBACK]);
    for (const phase of PHASES) {
      app.reset();
      const { ctx, notices } = mkCtx(app, worktree);
      await app.commands.get(phase.command)!(phase.args, ctx as never);

      const name = `${phase.command} ${phase.args}`.trim();
      assert.deepEqual(app.journal, ["newSession", `setModel:${phase.model}`], name);
      assert.deepEqual(
        notices.map((n) => n.message),
        [`[${phase.tag}] modèle ${phase.label} appliqué : ${phase.model}`],
        name,
      );
      assert.equal(app.seeds.length, 1, `${name} : l'amorce part toujours`);
    }
  });
});

test("modele-du-groupe-en-session-interactive/AC-8 : /review applique le repli quand le principal est épuisé, sinon garde la session et nomme le modèle épuisé", async () => {
  await inRepo(async (env) => {
    const app = mkApp();
    const worktree = await openFeature(app, env, "alpha", [MODEL_A, NO_FALLBACK, MODEL_B, MODEL_F]);
    const bare = await openFeature(app, env, "beta", [MODEL_A, NO_FALLBACK, MODEL_B, NO_FALLBACK]);
    const until = exhaust(env, MODEL_B);

    // B épuisé, repli B' disponible → B'.
    const withFallback = mkCtx(app, worktree);
    await app.commands.get("review")!("", withFallback.ctx as never);
    assert.deepEqual(app.journal, ["newSession", `setModel:${MODEL_F}`], "le repli, jamais le principal");
    assert.ok(withFallback.notices[0]!.message.includes(MODEL_F) && withFallback.notices[0]!.message.includes("repli"));
    assert.deepEqual(warnings(withFallback.notices), []);

    // B épuisé sans repli → aucun setModel, avertissement nommant B.
    app.reset();
    const without = mkCtx(app, bare);
    await app.commands.get("review")!("", without.ctx as never);
    assert.deepEqual(app.journal, ["newSession"], "aucun setModel");
    const warned = warnings(without.notices);
    assert.equal(warned.length, 1);
    assert.ok(
      warned[0]!.message.startsWith("[review] ") &&
        warned[0]!.message.includes(quotaStopReason({ model: MODEL_B, provider: "cerebras", until, announced: true })),
      warned[0]!.message,
    );
    assert.equal(app.seeds.length, 1, "l'amorce part quand même");
  });
});

test("modele-du-groupe-en-session-interactive/AC-9 : hors lot ou sans modèle de groupe, aucun setModel et la notice dit que le modèle de la session est conservé", async () => {
  await inRepo(async (env) => {
    const app = mkApp();
    const forgotten = await openFeature(app, env, "alpha", [MODEL_A, NO_FALLBACK, MODEL_B, NO_FALLBACK]);
    const headless = await openFeature(app, env, "beta", [], false);
    // `alpha` : le lot est oublié (le cwd n'est plus le worktree d'aucune feature) ;
    // `beta` : créée sans UI, donc ses groupes sont sur défaut OMP.
    // L'ordre compte : `beta` doit être lue AVANT l'oubli du lot.
    for (const [worktree, forget] of [[headless, false], [forgotten, true]] as const) {
      if (forget) fs.rmSync(lotPathFor(env.stateDir, lotRepoKey(env.root)), { force: true });
      for (const phase of PHASES) {
        app.reset();
        const { ctx, notices } = mkCtx(app, worktree);
        await app.commands.get(phase.command)!(phase.args, ctx as never);

        const name = `${forget ? "lot oublié" : "sans UI"} — ${phase.command} ${phase.args}`.trim();
        assert.deepEqual(app.journal, ["newSession"], `${name} : aucun setModel`);
        assert.deepEqual(
          notices.map((n) => n.message),
          [`[${phase.tag}] modèle de la session conservé : aucun modèle de groupe ${phase.label} pour ce worktree`],
          name,
        );
        assert.equal(app.seeds.length, 1, `${name} : l'amorce part`);
      }
    }
  });
});

test("modele-du-groupe-en-session-interactive/AC-10 : /specs avertit quand setModel rend false ou jette, sans erreur ni retour arrière", async () => {
  for (const behavior of ["false", "throw"] as const) {
    await inRepo(async (env) => {
      const app = mkApp();
      const worktree = await openFeature(app, env, "alpha", [MODEL_A, NO_FALLBACK, MODEL_B, NO_FALLBACK]);
      app.behavior.setModel = behavior;
      const { ctx, notices } = mkCtx(app, worktree);
      await app.commands.get("specs")!("", ctx as never);

      const reason = behavior === "false" ? "aucune clé d'API" : "clé d'API révoquée";
      assert.deepEqual(
        warnings(notices).map((n) => n.message),
        [`[specs] modèle ${MODEL_A} non appliqué (${reason}) — modèle de la session conservé`],
        behavior,
      );
      assert.deepEqual(app.journal, ["newSession", `setModel:${MODEL_A}`], "la nouvelle session est conservée : un seul newSession");
      assert.equal(app.seeds.length, 1, "l'amorce part dans la nouvelle session");
    });
  }
});


// ---------------------------------------------------------------------------
// Run de conversation (S-5, lot BR-3) — AC-11 à AC-14
// ---------------------------------------------------------------------------
// `launchConversationRun` est exercé avec ses I/O injectées : un `exec` espion qui
// enregistre `[commande, args, options]`, une sonde qui accepte tout, un magasin
// d'état jetable. Le quota est le VRAI quota.json (`markExhausted`).

type ExecCall = { command: string; args: string[]; cwd: string; timeout: number };

function conversationHarness() {
  const stateDir = tmpdir("modele-du-groupe-conv-state-");
  const cwd = tmpdir("modele-du-groupe-conv-cwd-");
  const inbox = `${tmpdir("modele-du-groupe-conv-inbox-")}/boite`;
  const calls: ExecCall[] = [];
  const errors: string[] = [];
  const deps: ConversationLaunchDeps = {
    stateDir,
    ompBin: "omp",
    selfPath: null,
    timeoutMs: 1000,
    now: Date.now(),
    probe: { isDirectory: () => true, isSessionFile: () => true, sessionHeader: () => null },
    exec: (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, timeout: options.timeout });
      return Promise.resolve();
    },
    onRunError: (message) => errors.push(message),
  };
  const target = (extra: { model?: string | null; fallback?: string | null } = {}) => ({
    cwd,
    sessionFile: `${cwd}/session.jsonl`,
    label: "alpha",
    phase: "specs" as const,
    inbox,
    ...extra,
  });
  const exhaustModel = (selector: string): number => {
    const until = Date.now() + 3_600_000;
    markExhausted(stateDir, { model: selector, provider: selector.split("/")[0] ?? "", until, announced: true, at: Date.now(), reason: "429" });
    return until;
  };
  return { stateDir, inbox, calls, errors, deps, target, exhaustModel };
}

const optionAfter = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

test("modele-du-groupe-en-session-interactive/AC-11 : le run de conversation part sur le principal avec le repli en chaîne native (overlay --config)", () => {
  const h = conversationHarness();
  const reason = launchConversationRun(h.deps, h.target({ model: MODEL_A, fallback: MODEL_F }), "bonjour");
  assert.equal(reason, null);
  assert.equal(h.calls.length, 1);
  const { args } = h.calls[0]!;
  const modelAt = args.indexOf("--model");
  assert.equal(args[modelAt + 1], MODEL_A);
  assert.equal(args[modelAt + 2], "--config", "l'overlay suit immédiatement --model");
  const overlay = args[modelAt + 3]!;
  assert.equal(overlay, conversationOverlayPathFor(h.stateDir, MODEL_F));
  const content = JSON.parse(fs.readFileSync(overlay, "utf8"));
  assert.deepEqual(content, {
    retry: { fallbackChains: { default: [MODEL_F] }, fallbackRevertPolicy: "cooldown-expiry" },
  });
  // L'overlay est l'imbrication de la configuration de la session hébergée.
  assert.deepEqual(hostedSettingsOverrides(null, MODEL_F), {
    "retry.fallbackChains": content.retry.fallbackChains,
    "retry.fallbackRevertPolicy": content.retry.fallbackRevertPolicy,
  });
  // Même repli : même chemin, écriture idempotente.
  assert.equal(launchConversationRun(h.deps, h.target({ model: MODEL_A, fallback: MODEL_F }), "encore"), null);
  assert.equal(optionAfter(h.calls[1]!.args, "--config"), overlay);
  assert.ok(fs.existsSync(overlay), "l'overlay n'est jamais supprimé");
});

test("modele-du-groupe-en-session-interactive/AC-12 : principal épuisé et repli disponible, le run part sur le repli, jamais sur le principal", () => {
  const h = conversationHarness();
  h.exhaustModel(MODEL_A);
  const reason = launchConversationRun(h.deps, h.target({ model: MODEL_A, fallback: MODEL_F }), "bonjour");
  assert.equal(reason, null);
  const { args } = h.calls[0]!;
  assert.equal(optionAfter(args, "--model"), MODEL_F);
  assert.ok(!args.includes(MODEL_A), "le principal épuisé n'apparaît nulle part dans l'argv");
  assert.ok(!args.includes("--config"), "départ sur le repli : aucune chaîne de repli");
});

test("modele-du-groupe-en-session-interactive/AC-13 : principal épuisé sans repli utilisable, motif nommant le modèle et l'échéance, aucun process lancé", () => {
  for (const fallback of [null, MODEL_F]) {
    const h = conversationHarness();
    const until = h.exhaustModel(MODEL_A);
    if (fallback !== null) h.exhaustModel(fallback);
    const reason = launchConversationRun(h.deps, h.target({ model: MODEL_A, fallback }), "bonjour");
    assert.ok(reason !== null, `repli ${fallback}`);
    assert.ok(reason.includes(MODEL_A), reason);
    assert.ok(reason.includes(quotaDeadlineLabel(until, true)), reason);
    assert.equal(reason, `écriture impossible : ${quotaStopReason({ model: MODEL_A, provider: "anthropic", until, announced: true })}`);
    assert.equal(h.calls.length, 0, "exec n'est pas appelé");
    assert.ok(!fs.existsSync(`${h.stateDir}/conversation-overlays`), "aucun overlay écrit");
    assert.ok(!fs.existsSync(h.inbox), "la boîte n'est pas créée");
  }
});

test("modele-du-groupe-en-session-interactive/AC-14 : cible hors lot ou sans modèle de groupe, l'argv est celui d'avant et aucun refus de quota", () => {
  const h = conversationHarness();
  h.exhaustModel(MODEL_A);
  h.exhaustModel(MODEL_B);
  for (const extra of [{}, { model: null, fallback: null }, { model: null, fallback: MODEL_F }]) {
    h.calls.length = 0;
    const reason = launchConversationRun(h.deps, h.target(extra), "bonjour");
    assert.equal(reason, null, JSON.stringify(extra));
    assert.equal(h.calls.length, 1);
    const { args } = h.calls[0]!;
    assert.ok(!args.includes("--model"), "ni --model");
    assert.ok(!args.includes("--config"), "ni configuration de repli");
  }
  assert.ok(!fs.existsSync(`${h.stateDir}/conversation-overlays`), "aucun overlay écrit");
});

// ---------------------------------------------------------------------------
// Lot BR-4 — README
// ---------------------------------------------------------------------------

test("modele-du-groupe-en-session-interactive/AC-15 : le README décrit setModel en session interactive, la règle principal/repli et le run de conversation, sans la collecte en --model", () => {
  const readme = fs.readFileSync(`${ROOT}/README.md`, "utf8");
  const start = readme.indexOf("**Les modèles et leurs replis se choisissent au lancement de la feature.**");
  assert.ok(start >= 0, "puce des modèles introuvable");
  const bullet = readme.slice(start, readme.indexOf("**Chaque feature vit dans son propre worktree git.**", start));
  const heading = readme.indexOf("### Repli de modèle et quota");
  assert.ok(heading >= 0, "section « Repli de modèle et quota » introuvable");
  const rest = readme.slice(heading + 1);
  const next = rest.search(/\n##+ /);
  const section = rest.slice(0, next < 0 ? undefined : next);
  assert.ok(bullet.length > 100 && section.length > 100, "zones isolées vides");

  const text = `${bullet}\n${section}`.replace(/\s+/g, " ");
  const sentences = text.split(/(?<=[.!?:;]) /);
  const offenders = sentences.filter((s) => s.includes("collecte") && s.includes("`--model`"));
  assert.deepEqual(offenders, [], "aucune phrase ne lie la collecte à `--model`");

  for (const required of [
    "setModel",
    "/req",
    "/specs",
    "/impl --fix",
    "/review",
    "défaut OMP",
    "hors lot",
    "run de conversation",
    "--config",
    "épuisé",
  ]) {
    assert.ok(text.includes(required), `le README ne contient pas « ${required} »`);
  }
});
