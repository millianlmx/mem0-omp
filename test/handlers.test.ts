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

type FakeCtx = {
  cwd: string;
  hasUI: boolean;
  ui: { notify: (message: string, type?: string) => void };
  waitForIdle: () => Promise<void>;
  newSession?: NewSession;
};

type Displayed = { customType?: string; content: string };

function mkApp() {
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

function mkCtx(cwd: string, options: { newSession?: boolean } = {}) {
  const notices: Array<{ message: string; type?: string }> = [];
  const moved: string[] = [];
  let sessions = 0;

  const ctx: FakeCtx = {
    cwd,
    hasUI: false,
    ui: { notify: (message, type) => notices.push({ message, type }) },
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

  return { ctx, notices, moved, sessions: () => sessions };
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
