// Tests de HANDLER : les corps des handlers ne sont exercés par aucun autre test
// (la suite ne couvre que les fonctions pures exportées, ni esbuild ni
// `node --test` ne type-checkent). C'est exactement par là qu'est passé le bug de
// la v0.6 : le handler /specs avait perdu `const seed = buildSpecsSeed(...)` en
// gardant `pi.sendUserMessage(seed)` → ReferenceError, commande morte, CI verte.
//
// Ici l'extension est importée pour de vrai, les handlers sont capturés par un
// `pi` factice, et `pi.exec` exécute du git RÉEL dans un dépôt temporaire : c'est
// le seul niveau où l'on voit un identifiant indéfini, un enchaînement cassé ou un
// rollback mal ordonné. Les dépôts sont réels (comme dans worktree.test.ts), donc
// les décisions testées reposent sur des sorties git véritables.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import reqExtension, { CONTRACT_PATH, worktreePathFor, type GitResult } from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Dépôt git réel sous dossier temporaire
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

function git(args: string[], cwd: string): GitResult {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(cwd, ".gitconfig-absent"),
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function mkRepo(): string {
  const dir = mktmp("hw-repo-");
  git(["init", "-q", "-b", "main"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# dépôt de test\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

// ---------------------------------------------------------------------------
// `pi` et `ctx` factices
// ---------------------------------------------------------------------------

type MoveTo = { moveTo: (cwd: string) => Promise<void> };
type NewSession = (opts?: { setup?: (sm: MoveTo) => Promise<void> }) => Promise<{ cancelled: boolean }>;

type FakeUI = {
  notify: (message: string, type?: string) => void;
  /** Éditeur de la TUI — absent des `ui` qui ne l'exposent pas (cas S-4 §6). */
  getEditorText?: () => string;
  setEditorText?: (text: string) => void;
};

type FakeCtx = {
  cwd: string;
  hasUI: boolean;
  ui: FakeUI;
  waitForIdle: () => Promise<void>;
  newSession?: NewSession;
};

type Displayed = { customType?: string; content: string; display?: boolean; attribution?: string };

/** Ce que l'extension enregistre auprès du `pi` factice, et ce qu'elle émet. */
type FakeApp = {
  handlers: Map<string, (args: string, ctx: never) => Promise<void>>;
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  seeds: string[];
  displayed: Displayed[];
};

function mkApp(): FakeApp {
  const handlers = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const hooks = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
  const seeds: string[] = [];
  const displayed: Displayed[] = [];

  const pi = {
    registerCommand(name: string, def: { handler: (args: string, ctx: never) => Promise<void> }) {
      handlers.set(name, def.handler);
    },
    on(name: string, def: (event: never, ctx: never) => Promise<unknown>) {
      hooks.set(name, def);
    },
    async exec(_command: string, args: string[], options?: { cwd?: string }) {
      return { ...git(args, options?.cwd ?? process.cwd()), killed: false };
    },
    sendMessage(payload: Displayed) {
      displayed.push(payload);
    },
    sendUserMessage(text: string) {
      seeds.push(text);
    },
  };

  reqExtension(pi as unknown as Parameters<typeof reqExtension>[0]);
  return { handlers, hooks, seeds, displayed };
}

function mkCtx(
  cwd: string,
  options: { newSession?: boolean; hasUI?: boolean; editor?: string; editorApi?: boolean } = {},
) {
  const notices: Array<{ message: string; type?: string }> = [];
  const moved: string[] = [];
  let sessions = 0;
  let editor = options.editor ?? "";
  let editorWrites = 0;

  const ui: FakeUI = { notify: (message, type) => notices.push({ message, type }) };
  if (options.editorApi !== false) {
    // Éditeur en mémoire : c'est lui qui dit si un brouillon a été écrasé.
    ui.getEditorText = () => editor;
    ui.setEditorText = (text) => {
      editor = text;
      editorWrites += 1;
    };
  }

  const ctx: FakeCtx = {
    cwd,
    hasUI: options.hasUI ?? false,
    ui,
    waitForIdle: async () => {},
  };
  if (options.newSession !== false) {
    ctx.newSession = async (opts) => {
      sessions += 1;
      if (opts?.setup) {
        await opts.setup({
          moveTo: async (target: string) => {
            moved.push(target);
          },
        });
      }
      return { cancelled: false };
    };
  }

  return {
    ctx,
    notices,
    moved,
    sessions: () => sessions,
    editor: () => editor,
    editorWrites: () => editorWrites,
  };
}

// `worktreesBaseDir()` lit l'environnement à chaque appel : un test ne doit pas
// laisser sa base derrière lui.
async function withWorktreesDir<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.MEM0_PIPELINE_WORKTREES_DIR;
  process.env.MEM0_PIPELINE_WORKTREES_DIR = base;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.MEM0_PIPELINE_WORKTREES_DIR;
    else process.env.MEM0_PIPELINE_WORKTREES_DIR = previous;
  }
}

// ---------------------------------------------------------------------------
// AC-1 — le handler /req isole la feature et installe la collecte dans le worktree
// ---------------------------------------------------------------------------

test("AC-1 : le handler /req ouvre le worktree, accueille et arme la collecte du worktree", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");
  const mainBranch = git(["branch", "--show-current"], root).stdout.trim();

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const { ctx, notices, moved } = mkCtx(root);

    await app.handlers.get("req")!("iso-handler", ctx as never);

    // Le worktree de la feature, atteint par la session relocalisée
    const worktree = worktreePathFor(base, root, "iso-handler");
    assert.deepEqual(moved, [worktree], "la session est relocalisée dans le worktree");
    assert.ok(fs.existsSync(worktree), "le répertoire du worktree existe");
    assert.equal(git(["branch", "--show-current"], worktree).stdout.trim(), "feat/iso-handler");

    // L'accueil est un message d'AFFICHAGE (jamais un sendUserMessage : il
    // contient « fin » et démarrerait un tour qui clôturerait la collecte)
    const welcome = app.displayed.filter((m) => m.customType === "req");
    assert.equal(welcome.length, 1, "un accueil, posté une fois");
    assert.match(welcome[0]!.content, /\[req\] Feature « iso-handler »/);
    assert.ok(welcome[0]!.content.includes(worktree), "l'accueil nomme le worktree");
    assert.equal(app.seeds.length, 0, "aucune seed envoyée par /req");
    assert.equal(notices.length, 0, "aucun refus");

    // Dépôt principal intact
    assert.equal(git(["status", "--porcelain"], root).stdout, "");
    assert.equal(git(["branch", "--show-current"], root).stdout.trim(), mainBranch);

    // La collecte est armée POUR LE WORKTREE (clé = cwd), pas pour la session
    // d'origine : la directive n'est injectée que là.
    const hook = app.hooks.get("before_agent_start")!;
    const inWorktree = (await hook({ prompt: "je veux isoler les features", systemPrompt: ["base"] }, {
      cwd: worktree,
    } as never)) as { systemPrompt: string[] };
    assert.equal(inWorktree.systemPrompt.length, 2, "directive de collecte injectée dans le worktree");
    const inMain = (await hook({ prompt: "je veux isoler les features", systemPrompt: ["base"] }, {
      cwd: root,
    } as never)) as { systemPrompt: string[] };
    assert.equal(inMain.systemPrompt.length, 1, "rien n'est armé dans le dépôt principal");
  });
});

test("AC-1 : sans newSession, /req annule le worktree et conserve la branche", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const { ctx, notices } = mkCtx(root, { newSession: false });

    await app.handlers.get("req")!("rollback", ctx as never);

    const worktree = worktreePathFor(base, root, "rollback");
    assert.ok(!fs.existsSync(worktree), "le worktree est annulé");
    assert.match(git(["branch", "--list", "feat/rollback"], root).stdout, /feat\/rollback/, "la branche reste");
    assert.equal(git(["status", "--porcelain"], root).stdout, "", "dépôt principal intact");
    assert.equal(app.seeds.length, 0, "aucune session ouverte");
    assert.ok(
      notices.some((n) => /session dans le worktree impossible/.test(n.message)),
      "le refus est signalé",
    );
  });
});

// ---------------------------------------------------------------------------
// AC-2 — chaque maillon vise le contrat de SON cwd (régression : /specs mort)
// ---------------------------------------------------------------------------

test("AC-2 : /specs, /impl et /review envoient leur seed depuis le worktree de la feature", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const opener = mkCtx(root);
    await app.handlers.get("req")!("maillon", opener.ctx as never);
    const worktree = worktreePathFor(base, root, "maillon");

    // Le maillon /specs exécute le contrat lignes 1-3 de sa directive (lire le
    // contrat, lever les ambiguïtés, écrire specs + lots) — ici on prouve qu'il va
    // jusqu'au bout sans ReferenceError et que sa seed désigne le contrat du cwd.
    const expected: Array<[string, string, string]> = [
      ["specs", "[specs]", "cible le module auth"],
      ["impl", "[impl]", ""],
      ["review", "[review]", ""],
    ];
    for (const [command, tag, args] of expected) {
      const { ctx } = mkCtx(worktree);
      await app.handlers.get(command)!(args, ctx as never);
    }

    assert.equal(app.seeds.length, 3, "un maillon = une seed, pour chacun des trois");
    const [specs, impl, review] = app.seeds as [string, string, string];
    assert.ok(specs.startsWith("[specs] Session de spécification"), "/specs envoie sa seed");
    assert.ok(impl.startsWith("[impl] Session d'implémentation"), "/impl envoie sa seed");
    assert.ok(review.startsWith("[review] Session de revue"), "/review envoie sa seed");
    for (const seed of app.seeds) {
      assert.ok(seed.includes(CONTRACT_PATH), "chaque seed désigne le contrat, relatif au cwd");
    }
    assert.match(specs, /Contexte ajouté : cible le module auth/, "les arguments traversent le handler");
  });
});

test("AC-2 : hors worktree et sans contrat hérité, les maillons refusent sans session ni seed", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    for (const command of ["specs", "impl", "review"]) {
      const app = mkApp();
      const { ctx, notices, sessions } = mkCtx(root);

      await app.handlers.get(command)!(`--${command}`, ctx as never);

      assert.equal(app.seeds.length, 0, `${command} : aucune seed hors du worktree d'une feature`);
      assert.equal(sessions(), 0, `${command} : aucune session créée`);
      assert.ok(
        notices.some((n) => n.message.startsWith(`[${command}] : `) && /n'est pas dans le worktree/.test(n.message)),
        `${command} : le refus est signalé`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Fin de maillon — la suite est annoncée dans le transcript (AC-1 … AC-5)
// ---------------------------------------------------------------------------

// Contrats réduits à ce que le routage lit : la section `## Spécifications` et le
// champ BLOQUANTS de `## Revue`.
const SPECS_SECTION = "## Besoins\n\nB-1 : …\n\n## Spécifications\n\nS-1 (AC-1) : …\n";
const NO_SPECS_SECTION = "## Besoins\n\nB-1 : …\n";
const REVIEW_BLOCKERS = "## Revue\n\n- STATUT : BLOQUANT\n- BLOQUANTS :\n  1. Le test AC-3 manque.\n";
const REVIEW_CLEAN = "## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n";

function writeContract(cwd: string, content: string): void {
  const file = path.join(cwd, CONTRACT_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Le seul chemin qui crée un worktree de feature : /req. Rend son chemin. */
async function openFeature(app: FakeApp, root: string, base: string, slug: string): Promise<string> {
  await app.handlers.get("req")!(slug, mkCtx(root).ctx as never);
  return worktreePathFor(base, root, slug);
}

/** Les annonces de fin de maillon — le balayage poste lui aussi en customType « pipeline ». */
function announcements(app: FakeApp): Displayed[] {
  return app.displayed.filter((m) => m.customType === "pipeline" && m.content.startsWith("[pipeline] Phase /"));
}

/** Arme un maillon par son handler, puis simule la retombée terminale du fil principal. */
async function settleLink(
  app: FakeApp,
  command: string,
  cwd: string,
  stopCtx: never,
): Promise<Displayed[]> {
  await app.handlers.get(command)!("", mkCtx(cwd).ctx as never);
  const before = announcements(app).length;
  await app.hooks.get("session_stop")!({}, stopCtx);
  return announcements(app).slice(before);
}

test("AC-1 : /req, /specs et /impl annoncent chacun la commande de la suite", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "chaque-maillon");
    writeContract(worktree, SPECS_SECTION);

    // /req : la clôture est le mot « fin » de l'utilisateur, pas la fin du tour
    await app.hooks.get("before_agent_start")!({ prompt: "fin", systemPrompt: ["base"] }, {
      cwd: worktree,
    } as never);
    await app.hooks.get("session_stop")!({}, mkCtx(worktree).ctx as never);

    await settleLink(app, "specs", worktree, mkCtx(worktree).ctx as never);
    await settleLink(app, "impl", worktree, mkCtx(worktree).ctx as never);

    assert.deepEqual(
      announcements(app).map((m) => m.content),
      [
        "[pipeline] Phase /req terminée — commande suivante : /specs",
        "[pipeline] Phase /specs terminée — commande suivante : /impl",
        "[pipeline] Phase /impl terminée — commande suivante : /review",
      ],
      "les trois maillons annoncent la suite, dans l'ordre du pipeline",
    );
  });
});

test("AC-2 : l'annonce est un message d'affichage durable, jamais un toast", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "annonce-durable");
    writeContract(worktree, SPECS_SECTION);

    const stop = mkCtx(worktree, { hasUI: true });
    const notices = await settleLink(app, "specs", worktree, stop.ctx as never);

    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.equal(notice.display, true, "rendu dans le transcript : relisible après défilement/redraw");
    assert.equal(notice.attribution, "user");
    assert.equal(notice.customType, "pipeline");
    assert.ok(notice.content.includes("/impl"), "la commande suivante y est écrite en clair");
    assert.equal(stop.notices.length, 0, "un toast ne laisserait rien à relire : aucun notify");
  });
});

test("AC-3 : /review terminée avec un BLOQUANT annonce /impl --fix", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "revue-bloquee");
    writeContract(worktree, SPECS_SECTION + REVIEW_BLOCKERS);

    const notices = await settleLink(app, "review", worktree, mkCtx(worktree).ctx as never);

    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.content, "[pipeline] Phase /review terminée — commande suivante : /impl --fix");
  });
});

test("AC-4 : /review terminée sans BLOQUANT signale la fin du cycle, sans correction", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "revue-propre");
    writeContract(worktree, SPECS_SECTION + REVIEW_CLEAN);

    const notices = await settleLink(app, "review", worktree, mkCtx(worktree).ctx as never);

    assert.equal(notices.length, 1);
    assert.match(notices[0]!.content, /cycle terminé/);
    assert.ok(!notices[0]!.content.includes("/impl --fix"), "aucune correction proposée");
    assert.ok(!notices[0]!.content.includes("commande suivante"), "aucune commande proposée");
  });
});

test("AC-5 : un maillon /impl sans `## Spécifications` renvoie vers /specs, pas /review", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "sans-specs");
    writeContract(worktree, NO_SPECS_SECTION);

    const notices = await settleLink(app, "impl", worktree, mkCtx(worktree).ctx as never);

    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.content, "[pipeline] Phase /impl terminée — commande suivante : /specs");
  });
});

test("S-1 : hors maillon armé, maillon déjà annoncé ou collecte en cours, rien n'est posté", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();

    // Session hors pipeline : aucun maillon armé pour ce cwd
    await app.hooks.get("session_stop")!({}, mkCtx(root).ctx as never);
    assert.equal(announcements(app).length, 0, "session hors pipeline : aucun message");

    // Maillon armé : une seule annonce, quel que soit le nombre de retombées
    const oneShot = await openFeature(app, root, base, "une-seule-annonce");
    await app.hooks.get("before_agent_start")!({ prompt: "fin", systemPrompt: [] }, { cwd: oneShot } as never);
    for (let i = 0; i < 3; i++) {
      await app.hooks.get("session_stop")!({}, mkCtx(oneShot).ctx as never);
    }
    assert.equal(announcements(app).length, 1, "une seule annonce par maillon armé");

    // Collecte en cours : /req armé mais « fin » pas encore dit
    const collecting = await openFeature(app, root, base, "collecte-en-cours");
    await app.hooks.get("session_stop")!({}, mkCtx(collecting).ctx as never);
    assert.equal(announcements(app).length, 1, "aucune annonce pendant la collecte");
  });
});

// ---------------------------------------------------------------------------
// Fin de maillon — préremplissage de la zone de saisie (AC-6, AC-7, S-4)
// ---------------------------------------------------------------------------

test("AC-6 : en TUI, la zone de saisie reçoit la commande annoncée, prête à valider", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "prefill");
    writeContract(worktree, SPECS_SECTION);

    const stop = mkCtx(worktree, { hasUI: true, editor: "" });
    const notices = await settleLink(app, "specs", worktree, stop.ctx as never);

    const announced = /commande suivante : (\/\S+)/.exec(notices[0]!.content)?.[1];
    assert.equal(announced, "/impl", "présuppose la commande annoncée dans la notice");
    assert.equal(stop.editor(), announced, "l'éditeur contient EXACTEMENT la commande annoncée");
    assert.equal(stop.editorWrites(), 1, "un seul setEditorText");
  });
});

test("AC-7 : un brouillon déjà saisi reste intact — rien n'est écrasé", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "brouillon");
    writeContract(worktree, SPECS_SECTION);

    const stop = mkCtx(worktree, { hasUI: true, editor: "mon brouillon" });
    const notices = await settleLink(app, "specs", worktree, stop.ctx as never);

    assert.equal(notices.length, 1, "l'annonce part quand même : le préremplissage est un confort");
    assert.equal(stop.editor(), "mon brouillon", "le brouillon de l'utilisateur reste intact");
    assert.equal(stop.editorWrites(), 0, "aucun appel à setEditorText");
  });
});

test("S-4 : éditeur d'espaces, fin de cycle, hors TUI et API absente — l'éditeur reste tel quel", async () => {
  const root = mkRepo();
  const base = mktmp("hw-base-");

  await withWorktreesDir(base, async () => {
    const app = mkApp();
    const worktree = await openFeature(app, root, base, "prefill-limites");
    writeContract(worktree, SPECS_SECTION);

    // Un contenu d'espaces est un brouillon vide de sens : la commande est écrite
    const spaces = mkCtx(worktree, { hasUI: true, editor: "   " });
    await settleLink(app, "specs", worktree, spaces.ctx as never);
    assert.equal(spaces.editor(), "/impl");
    assert.equal(spaces.editorWrites(), 1);

    // Fin de cycle : aucune commande à préremplir
    writeContract(worktree, SPECS_SECTION + REVIEW_CLEAN);
    const cycle = mkCtx(worktree, { hasUI: true, editor: "" });
    await settleLink(app, "review", worktree, cycle.ctx as never);
    assert.equal(cycle.editor(), "");
    assert.equal(cycle.editorWrites(), 0, "rien à valider : l'éditeur n'est pas touché");

    // Non interactif (print / RPC / json)
    const headless = mkCtx(worktree, { hasUI: false, editor: "" });
    await settleLink(app, "specs", worktree, headless.ctx as never);
    assert.equal(headless.editor(), "");
    assert.equal(headless.editorWrites(), 0, "hors TUI, rien n'est tenté");

    // `ui` sans les méthodes d'éditeur
    const bare = mkCtx(worktree, { hasUI: true, editor: "", editorApi: false });
    await settleLink(app, "specs", worktree, bare.ctx as never);
    assert.equal(bare.editorWrites(), 0, "API d'éditeur absente : aucune erreur, aucun appel");
    assert.equal(bare.notices.length, 0, "et aucune erreur signalée à l'utilisateur");
  });
});
