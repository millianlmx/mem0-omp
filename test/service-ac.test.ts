// Les DIX critères d'acceptation de la feature, un test par critère, dans UN
// SEUL fichier : l'invariant `criteria/AC-13` (test/criteria.test.ts) impose
// qu'un slug qualifié ne vive que dans un fichier, et /review retrouve ainsi
// `replace-rpc-mode-by-native-rest-api/AC-<n>` par grep.
//
// Chaque test prouve le critère par les MÊMES coutures publiques que le service
// utilise en production (hôte de sessions, runner en process, pilot, client du
// panneau), avec des doublures — aucun modèle, aucun réseau, aucun process `omp`.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  SERVICE_DOWN_REFUSAL,
  ServiceError,
  createMaillonRunner,
  createServiceClient,
  createServiceLotActions,
  createServicePilot,
  createSessionHost,
  driverLabel,
  lotRepoKey,
  maillonIdentityOf,
  panelDriver,
  registerMaillonIdentity,
  readLot,
  readService,
  resolveLaunchdOmpBinary,
  readStore,
  renderServicePlist,
  serviceJobArgv,
  servicePort,
  startService,
  writeLot,
  writeService,
} from "../omp-mem0-req/extension.ts";
import type { HostedSession, LotRunSpec, SessionHost } from "../omp-mem0-req/extension.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* déjà retiré */
    }
  }
});

const git = async (args: string[], cwd: string) => {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

function mkRepo(): string {
  const repo = mktmp("ac-repo-");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["commit", "-q", "--allow-empty", "-m", "init"],
  ]) {
    if (spawnSync("git", args, { cwd: repo, encoding: "utf8" }).status !== 0) {
      throw new Error(`git ${args.join(" ")} a échoué`);
    }
  }
  return repo;
}

/** Un hôte de sessions de doublure : il inscrit l'identité, comme le vrai (S-3). */
function stubHost(options: { hold?: boolean } = {}) {
  const prompts: string[] = [];
  const identities: Array<{ slug: string; phase: string } | null> = [];
  const opens: Array<{ cwd: string; purpose: string; resume: string | null }> = [];
  let disposed = 0;
  const host = {
    open: async (openOptions: { cwd: string; identity?: Parameters<typeof registerMaillonIdentity>[1]; purpose: string; resume?: string | null }) => {
      const id = `sess-${prompts.length + 1}`;
      opens.push({ cwd: openOptions.cwd, purpose: openOptions.purpose, resume: openOptions.resume ?? null });
      if (openOptions.identity) registerMaillonIdentity(id, openOptions.identity);
      identities.push(
        (() => {
          const known = maillonIdentityOf(id);
          return known === null ? null : { slug: known.slug, phase: known.phase };
        })(),
      );
      const hosted = {
        id,
        cwd: openOptions.cwd,
        purpose: openOptions.purpose,
        sessionFile: path.join(openOptions.cwd, `${id}.jsonl`),
        state: "idle",
        dialogs: new Map(),
        listeners: new Set(),
        aborting: false,
        transcript: ["le maillon a travaillé"],
        dispose: async () => {
          disposed += 1;
        },
        session: {
          isStreaming: true,
          messages: [],
          model: undefined,
          subscribe: () => () => {},
          prompt: async (text: string) => {
            prompts.push(text);
            if (!options.hold) return true;
            const { promise, reject } = Promise.withResolvers<never>();
            hosted.session.abort = async () => reject(new Error("run interrompu"));
            return promise;
          },
          waitForIdle: async () => {},
          abort: async () => {},
        },
      } as unknown as HostedSession & { session: { abort: () => Promise<void> } };
      return hosted;
    },
    require: () => {
      throw new Error("non utilisé");
    },
    sessions: new Map(),
    list: () => [],
    view: () => null,
    prompt: async () => ({ accepted: true, state: "running" }),
    abort: async () => ({ state: "idle" }),
    answer: async () => {},
    close: async () => {},
    subscribe: () => null,
    conduiteFor: () => null,
    disposeAll: async () => {},
    now: () => Date.now(),
  } as unknown as SessionHost;
  return { host, prompts, identities, opens, disposedCount: () => disposed };
}

/** Ce que les preuves interrogent du contexte UI servi par l'API (S-6). */
type CapturedUI = { select: (title: string, options: string[]) => Promise<string | undefined> };

/**
 * Un `pi` de doublure (jamais le vrai binaire) : une session inerte dont le
 * contexte UI est CAPTURÉ — c'est par lui que se prouvent un dialogue et la vie
 * d'une session sans client (S-6, S-7).
 */
function fakePiSession(
  cwd: string,
  captured: { ui: CapturedUI | null },
  sessionId = "sess-1",
): Parameters<typeof createSessionHost>[0] {
  const manager = () => ({
    getSessionId: () => sessionId,
    getSessionFile: () => path.join(cwd, "s.jsonl"),
    getCwd: () => cwd,
  });
  const session = {
    isStreaming: false,
    extensionRunner: null,
    sessionManager: manager(),
    subscribeRunState: () => () => {},
    subscribe: () => () => {},
    prompt: async () => true,
    followUp: async () => {},
    abort: async () => {},
    dispose: () => {},
  };
  return {
    pi: {
      pi: {
        Settings: { isolated: () => ({}) },
        AgentRegistry: class {},
        SessionManager: { create: manager, open: async () => manager() },
        createAgentSession: async () => ({
          session,
          setToolUIContext: (ui: CapturedUI) => {
            captured.ui = ui;
          },
        }),
      },
    } as never,
    stateDir: cwd,
    selfPath: null,
    log: () => {},
  };
}

function feature(slug: string, worktree: string, state: "pending" | "running" = "pending") {
  return {
    slug,
    name: slug,
    branch: `feat/${slug}`,
    worktree,
    deps: [],
    origin: "panneau" as const,
    state,
    phase: "impl" as const,
    waitKind: null,
    waitPrompt: null,
    sessionFile: null,
    pendingTexts: [],
    prUrl: null,
    stopReason: null,
    fixes: 0,
    reviewRuns: 0,
    unreadableRuns: 0,
    reviewHash: null,
    lastVerdict: null,
    lastBlockers: 0,
    lastRunSessionFile: null,
    contractHash: null,
    addedAt: 1,
    sinceAt: 1,
    updatedAt: 1,
    endedAt: null,
  };
}

function seedLot(stateDir: string, repoRoot: string, features: unknown[]) {
  writeLot(stateDir, {
    version: 1,
    id: lotRepoKey(repoRoot),
    repoRoot,
    status: "running",
    reviewCap: 3,
    slotCap: 4,
    recapAt: null,
    owner: { pid: 0, sessionFile: null, sessionId: null, heartbeatAt: 0 },
    createdAt: 1,
    launchedAt: 1,
    features,
  } as never);
}

/** Une condition atteinte en microtâches/`setImmediate` : jamais une durée devinée. */
async function eventually(condition: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (condition()) return;
    await Promise.resolve();
    if (i % 50 === 49) await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail(message);
}

test("replace-rpc-mode-by-native-rest-api/AC-1 : les maillons sont exécutés par le service, sans aucun `omp` enfant", async () => {
  const stateDir = path.join(mktmp("ac1-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("ac1-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree)]);
  const stub = stubHost();
  const pilot = createServicePilot({
    stateDir,
    host: stub.host,
    run: createMaillonRunner({ host: stub.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  // Le balayage du service démarre le maillon : il AVANCE (feature lancée), et il
  // tourne dans CE process — aucun argv, aucun `pi.exec` sur un binaire `omp`.
  pilot.sweep();
  await eventually(() => stub.prompts.length === 1, "le maillon doit démarrer dans le service");
  assert.equal(stub.identities[0]?.slug, "alpha", "le service inscrit l'identité du maillon avant son prompt");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.owner.pid, process.pid, "le lot est conduit par le service");
  const sources = ["runs.ts", "lotController.ts", "extension.ts"]
    .map(file => fs.readFileSync(path.join(ROOT, "omp-mem0-req", file), "utf8"))
    .join("\n");
  assert.equal(sources.includes("buildLotRunArgv("), false, "aucun argv de maillon n'est construit");
  assert.equal(/pi\.exec\(\s*["'`]omp/.test(sources), false, "aucun `omp` n'est lancé pour un maillon");
  pilot.stop();
});

test("replace-rpc-mode-by-native-rest-api/AC-2 : l'app ne lance plus de mode RPC et ses trois surfaces passent par l'API", () => {
  const sourcesDir = path.join(ROOT, "omp-console", "Sources");
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith(".swift")) out.push(full);
    }
    return out;
  };
  const files = walk(sourcesDir);
  assert.ok(files.length > 0);
  const joined = files.map(file => fs.readFileSync(file, "utf8")).join("\n");
  for (const token of ["--mode", "rpc-ui", "RpcTransport", "SessionHost", "RpcFrames", "RpcChunkDecoder"]) {
    assert.equal(joined.includes(token), false, `l'app ne doit plus nommer ${token}`);
  }
  for (const segment of ['"sessions"', '"prompt"', '"dialogs"', '"events"', '"conduite"', '"pilot"', '"commands"']) {
    assert.ok(joined.includes(segment), `l'app appelle ${segment}`);
  }
  assert.ok(joined.includes("service.json") && joined.includes("X-OMP-Service-Token"));

  // --- Alignement app ⇄ service (revue du 2026-10-08) -------------------------
  // Trois défauts MESURÉS sur l'app : une reprise qui envoyait `resume: true` là
  // où le service exige un CHEMIN (400 mesuré), une conduite déjà vivante que
  // l'app ne savait pas rejoindre, et une conduite SUPPRIMÉE à la fermeture de
  // l'app. Les preuves de COMPORTEMENT vivent dans les suites Swift de
  // `omp-console` (`coque-service : …`, `conduite-de-projet : …`, qui portent les
  // cas rejoués : chemin de reprise, rattachement et question en vol, détachement
  // sans `DELETE`) ; ces gardes-ci pinnent l'ALIGNEMENT des deux côtés.
  const serviceHost = fs.readFileSync(path.join(ROOT, "omp-mem0-req", "serviceHost.ts"), "utf8");
  assert.match(serviceHost, /typeof record\.resume !== "string"/, "le service n'accepte qu'un CHEMIN de reprise");
  const client = fs.readFileSync(path.join(sourcesDir, "OMPConsole", "Service", "ServiceClient.swift"), "utf8");
  assert.match(client, /func createSession\(cwd: String, resume: String\?/, "l'app poste un CHEMIN, jamais un booléen");
  assert.match(client, /body\["resume"\] = resume/, "le champ `resume` ne part que pour une reprise");
  assert.match(
    client,
    /func sessions\(\) async throws -> \[ServiceSessionInfo\]/,
    "l'app liste les sessions servies (GET /v1/sessions, rejoindre une conduite vivante)",
  );
  const sessionModel = fs.readFileSync(path.join(sourcesDir, "OMPConsole", "Service", "ServiceSessionModel.swift"), "utf8");
  assert.match(sessionModel, /liveConduite\(/, "un 409 de conduite se rattache à la session vivante");
  assert.match(sessionModel, /private func detach\(/, "la fermeture de l'app DÉTACHE la conduite au lieu de la supprimer");
  assert.match(sessionModel, /func terminateForQuit\(\) async/, "le chemin de fermeture de l'app reste nommé");
});

test("replace-rpc-mode-by-native-rest-api/AC-3 : un dialogue de l'extension atteint l'app et la réponse poursuit le tour", async () => {
  const cwd = mktmp("ac3-");
  // Le contexte UI est capturé par une PROPRIÉTÉ (jamais une liaison réassignée) :
  // l'affectation vient d'un rappel, donc l'analyse de flux figerait `null`.
  const captured: { ui: CapturedUI | null } = { ui: null };
  const host = createSessionHost(fakePiSession(cwd, captured));
  const hosted = await host.open({ cwd, purpose: "session" });
  const frames: string[] = [];
  const dialogs: Array<{ id: string; options: string[] }> = [];
  const subscription = host.subscribe(hosted.id);
  assert.ok(subscription);
  subscription.subscribe(frame => {
    frames.push(frame.event);
    if (frame.event === "dialog") dialogs.push({ id: frame.data.id, options: frame.data.options });
  });
  const ui = captured.ui;
  assert.ok(ui, "le service pose un contexte UI servi par l'API");

  const asked = ui.select("Couleur", ["rouge", "bleu"]);
  const dialog = dialogs[0];
  assert.ok(dialog, "le dialogue est publié vers l'app");
  assert.deepEqual(dialog.options, ["rouge", "bleu"]);
  await host.answer(hosted.id, dialog.id, { value: "bleu" });
  assert.equal(await asked, "bleu", "la réponse saisie revient à la session, qui poursuit son tour");
  assert.deepEqual(frames, ["dialog"]);
  // Une seule conduite VIVANTE par dépôt, par la porte de l'API (S-6, cas
  // limites) : `POST /v1/sessions {purpose:"project"}` ne contourne pas
  // l'unicité de la route `/conduite` — deux conduites rendraient `conduiteFor`
  // menteur (statut faux, second pilote de projet).
  const conduite = await host.open({ cwd, purpose: "project" });
  await assert.rejects(
    () => host.open({ cwd, purpose: "project" }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.status, 409);
      assert.match(err.reason, /une conduite vit déjà pour/);
      return true;
    },
  );
  await host.close(conduite.id);
  await host.disposeAll();
});

test("replace-rpc-mode-by-native-rest-api/AC-4 : le service fait avancer un maillon app fermée", async () => {
  const stateDir = path.join(mktmp("ac4-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("ac4-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree)]);
  const stub = stubHost();
  const pilot = createServicePilot({
    stateDir,
    host: stub.host,
    run: createMaillonRunner({ host: stub.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  // AUCUNE session cliente : ni app, ni terminal. La chaîne avance quand même —
  // le suivant démarre dès que le premier rend la main (le tour est immédiat ici).
  pilot.sweep();
  await eventually(() => readLot(stateDir, lotRepoKey(repoRoot))?.features[0]?.state !== "pending", "le maillon doit avancer");
  assert.equal(stub.prompts.length, 1);
  assert.equal(pilot.health().sessions, 0, "aucune session servie n'était nécessaire");
  // La CONDUITE d'un projet vit dans le service et reçoit l'AMORCE `/project`
  // (S-7) — la COMMANDE, celle dont le handler cerne le projet, arme le relais et
  // écrit l'état ; un texte de cadrage la laisserait inerte.
  await git(["remote", "add", "origin", "https://github.com/test/repo.git"], repoRoot);
  const conduite = await pilot.startConduite(repoRoot, { name: "mon projet" });
  assert.match(conduite.sessionId, /^sess-/);
  assert.deepEqual(stub.prompts.slice(1), ["/project mon projet"], "la conduite reçoit la commande /project");
  pilot.stop();

  // La conduite VIT dans le service (S-7) : le DÉPART du client — l'app qui se
  // ferme, sans aucun `DELETE` — ne la ferme pas, et sa question en attente reste
  // là où elle est. La réouverture la rejoue par l'instantané de son flux (S-6).
  const captured: { ui: CapturedUI | null } = { ui: null };
  const conduiteCwd = mktmp("ac4-conduite-");
  const realHost = createSessionHost(fakePiSession(conduiteCwd, captured));
  const live = await realHost.open({ cwd: conduiteCwd, purpose: "project" });
  const subscription = realHost.subscribe(live.id);
  assert.ok(subscription);
  const seen: string[] = [];
  const unsubscribe = subscription.subscribe(frame => seen.push(frame.event));
  const ui = captured.ui;
  assert.ok(ui, "le service pose un contexte UI servi par l'API");
  const asked = ui.select("Le plan du projet vous convient-il ?", ["Valider", "Corriger"]);
  assert.deepEqual(seen, ["dialog"], "la question part vers le client qui écoute");
  unsubscribe();
  assert.ok(
    realHost.list().some(session => session.id === live.id),
    "sans client, la conduite reste vivante dans le service",
  );
  const pending = realHost.view(live.id)?.dialogs ?? [];
  assert.equal(pending.length, 1, "la question attend la réouverture, elle n'est pas annulée");
  await realHost.answer(live.id, pending[0]!.id, { value: "Valider" });
  assert.equal(await asked, "Valider", "la réponse saisie à la réouverture poursuit le tour");
  await realHost.disposeAll();
});

test("replace-rpc-mode-by-native-rest-api/AC-5 : un lot repris après un arrêt brutal repart seul", async () => {
  const stateDir = path.join(mktmp("ac5-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("ac5-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree, "running")]);
  // Le service précédent a été tué : son enregistrement porte un pid MORT, et le
  // lot son pid périmé — les deux sont ignorés, la reprise est admise.
  writeService(
    { version: 1, pid: 999_999, port: 8788, token: "d".repeat(32), startedAt: 1, stateDir, sessionFile: null },
    stateDir,
  );
  assert.equal(readService(stateDir), null, "un service mort ne se lit pas comme vivant");
  // La CONDUITE d'un projet en marche, elle, est recréée depuis son fichier de
  // session (`hostSession`, S-5) : sa session rouverte arme son relais au
  // `session_start`, et le pilote de segments repart sans aucun geste.
  const hostSession = path.join(stateDir, "conduite.jsonl");
  fs.writeFileSync(hostSession, "{}\n", "utf8");
  const projectsDir = path.join(stateDir, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
  const repoKey = lotRepoKey(repoRoot);
  fs.writeFileSync(
    path.join(projectsDir, `${repoKey}.json`),
    `${JSON.stringify({
      version: 1,
      repoKey,
      repoRoot,
      relayKey: path.join(projectsDir, `${repoKey}@1`),
      purpose: "un projet du magasin",
      function: "faire avancer ses segments",
      status: "running",
      segments: [
        {
          name: "segment 1",
          features: [
            { slug: "alpha", intention: "démarrer la chaîne", status: "merged", prUrl: null, failure: null, removedReason: null, updatedAt: 1 },
          ],
        },
      ],
      current: 0,
      base: null,
      hostSession,
      createdAt: 1,
      updatedAt: 1,
    })}\n`,
    "utf8",
  );
  const stub = stubHost();
  const pilot = createServicePilot({
    stateDir,
    host: stub.host,
    run: createMaillonRunner({ host: stub.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  pilot.start();
  await eventually(() => stub.prompts.length === 1, "la reprise doit relancer le maillon interrompu");
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.owner.pid, process.pid, "le nouveau service a repris le lot");
  assert.deepEqual(
    stub.opens.filter(entry => entry.purpose === "project").map(entry => entry.resume),
    [hostSession],
    "la conduite est recréée depuis hostSession, et rien ne la ré-invite",
  );
  // La reprise « sans aucun geste » suppose que le service RE-démarre : c'est le
  // job launchd (S-1). Son binaire doit être un CHEMIN ABSOLU — launchd résout un
  // premier argument relatif via `_PATH_STDPATH`, le job mourrait en
  // `78: EX_CONFIG` (mesuré) et la relance n'aurait jamais lieu.
  const ompAbs = path.join(mktmp("ac5-bin-"), "omp");
  assert.deepEqual(
    resolveLaunchdOmpBinary({ PATH: path.dirname(ompAbs) }, file => file === ompAbs),
    { bin: ompAbs, problem: null },
    "le binaire du job launchd est résolu en chemin ABSOLU",
  );
  assert.equal(
    resolveLaunchdOmpBinary({ PATH: "/usr/bin:/bin" }, () => false).bin,
    null,
    "un `omp` introuvable est refusé, jamais écrit nu dans le plist",
  );
  pilot.stop();
});

test("replace-rpc-mode-by-native-rest-api/AC-6 : deux dépôts progressent en même temps", async () => {
  const stateDir = path.join(mktmp("ac6-"), "pipeline");
  const first = mkRepo();
  const second = mkRepo();
  seedLot(stateDir, first, [feature("alpha", mktmp("ac6-wt-a-"))]);
  seedLot(stateDir, second, [feature("beta", mktmp("ac6-wt-b-"))]);
  const stub = stubHost({ hold: true });
  const pilot = createServicePilot({
    stateDir,
    host: stub.host,
    run: createMaillonRunner({ host: stub.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  pilot.sweep();
  await eventually(() => stub.prompts.length === 2, "les deux dépôts doivent démarrer ensemble");
  assert.equal(pilot.health().lots, 2, "chaque dépôt porte son lot");
  for (const repoRoot of [first, second]) {
    assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.owner.pid, process.pid, "chacun a son statut exact");
  }
  pilot.stop();
});

test("replace-rpc-mode-by-native-rest-api/AC-7 : une pipeline arrêtée n'est plus « en cours » dès la réponse", async () => {
  const stateDir = path.join(mktmp("ac7-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("ac7-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree)]);
  const stub = stubHost({ hold: true });
  const pilot = createServicePilot({
    stateDir,
    host: stub.host,
    run: createMaillonRunner({ host: stub.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  pilot.sweep();
  await eventually(() => stub.prompts.length === 1, "le maillon doit être en vol");
  assert.equal(pilot.health().lots, 1);
  const outcome = await pilot.command(repoRoot, {
    version: 1,
    id: "c-stop",
    sentAt: 1,
    repo: repoRoot,
    kind: "stop",
  });
  assert.equal(outcome.ack.state, "taken");
  const lot = readLot(stateDir, lotRepoKey(repoRoot));
  assert.notEqual(lot?.features[0]?.state, "done");
  assert.deepEqual(readStore(stateDir).running, [], "plus aucune entrée « en cours » au retour de la réponse");
  pilot.stop();
});

test("replace-rpc-mode-by-native-rest-api/AC-8 : une session en cours est « en cours », jamais « interrompue »", async () => {
  const stateDir = path.join(mktmp("ac8-"), "pipeline");
  const worktree = mktmp("ac8-wt-");
  const stub = stubHost();
  const runner = createMaillonRunner({ host: stub.host, log: () => {} });
  const spec: LotRunSpec = {
    lotId: "abc",
    slug: "iso",
    phase: "impl",
    stateDir,
    worktree,
    prompt: "travaille",
    sessionFile: null,
    model: null,
    primary: null,
    fallback: null,
    inbox: path.join(stateDir, "inbox", "iso"),
    deadline: null,
  };
  const result = await runner({ spec, cwd: worktree, timeout: 60_000, signal: new AbortController().signal });
  // Le run a publié son entrée (S-8) avec un pid VIVANT — celui du service — puis
  // l'a retirée en rendant la main : à aucun instant l'app ne peut lire
  // « interrompue » sur une session qui travaille.
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "le maillon a travaillé");
  assert.equal(stub.disposedCount(), 1);
  assert.equal(readStore(stateDir).running.length, 0);
  writeService(
    { version: 1, pid: process.pid, port: 8899, token: "e".repeat(32), startedAt: 1, stateDir, sessionFile: null },
    stateDir,
  );
  assert.equal(readService(stateDir)?.pid, process.pid, "tant que le service vit, ses runs vivent");
});

test("replace-rpc-mode-by-native-rest-api/AC-9 : chaque action rend son nouvel état, sans statut périmé", async () => {
  const stateDir = path.join(mktmp("ac9-"), "pipeline");
  const repoRoot = mkRepo();
  const worktree = mktmp("ac9-wt-");
  seedLot(stateDir, repoRoot, [feature("alpha", worktree, "running")]);
  const stub = stubHost();
  const pilot = createServicePilot({
    stateDir,
    host: stub.host,
    run: createMaillonRunner({ host: stub.host, log: () => {} }),
    runGit: git,
    now: () => 1_700_000_000_000,
    schedule: () => () => {},
  });
  await pilot.pilot(repoRoot);
  const outcome = await pilot.command(repoRoot, {
    version: 1,
    id: "c-models",
    sentAt: 1,
    repo: repoRoot,
    kind: "models",
    slug: "alpha",
    modelReqSpecs: "m1",
    modelImplReview: "m2",
  });
  assert.equal(outcome.ack.state, "taken");
  // Le magasin porte DÉJÀ le nouvel état au retour de la réponse (S-9) : aucune
  // attente locale, aucun statut périmé.
  assert.equal(readLot(stateDir, lotRepoKey(repoRoot))?.features[0]?.modelReqSpecs, "m1");
  const refused = await pilot.command(repoRoot, {
    version: 1,
    id: "c-verdict",
    sentAt: 1,
    repo: repoRoot,
    kind: "verdict",
    slug: "alpha",
    verdict: "v",
  });
  assert.equal(refused.ack.state, "refused");
  assert.equal(typeof refused.ack.reason, "string", "un refus s'affiche avec le motif du service");
  pilot.stop();
});

test("replace-rpc-mode-by-native-rest-api/AC-10 : le panneau commande le service, et le nomme", async () => {
  const stateDir = mktmp("ac10-");
  writeService(
    { version: 1, pid: process.pid, port: 8899, token: "f".repeat(32), startedAt: 1, stateDir, sessionFile: null },
    stateDir,
  );
  const calls: Array<{ url: string; kind: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, kind: typeof parsed.kind === "string" ? parsed.kind : null });
    if (url.endsWith("/pilot")) return new Response(JSON.stringify({ repoKey: "k", lotId: null, state: "piloting" }), { status: 200 });
    return new Response(
      JSON.stringify({ ack: { version: 1, id: parsed.id, repo: parsed.repo, kind: parsed.kind, state: "taken", reason: null, at: 1 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  const actions = createServiceLotActions({ repoRoot: "/repo", client: createServiceClient({ stateDir, fetchImpl }) });
  // Les gestes du panneau partent en COMMANDES (lancer, répondre, valider) : la
  // session terminale n'écrit plus rien elle-même (S-11).
  assert.equal(await actions.launch(), null);
  assert.equal(await actions.validate("alpha"), null);
  assert.equal(await actions.answer("alpha", "ma réponse"), null);
  assert.deepEqual(calls.map(call => call.kind), ["start", "verdict", "reply"]);
  actions.adopt?.();
  assert.match(calls.at(-1)!.url, /\/pilot$/);
  // Et l'en-tête nomme le pilote : le service, jamais la session.
  const lot = { owner: { pid: process.pid, sessionFile: null, sessionId: null, heartbeatAt: 1 } } as never;
  assert.equal(driverLabel(panelDriver(lot, 1, process.pid)!), `pilote : le service (pid ${process.pid})`);
  // Sans service, les gestes sont refusés avec le mot du service arrêté.
  const down = createServiceLotActions({
    repoRoot: "/repo",
    client: createServiceClient({ stateDir: path.join(stateDir, "absent"), fetchImpl }),
  });
  assert.equal(await down.launch(), SERVICE_DOWN_REFUSAL);
  // AUCUNE prise de relais locale ne subsiste (S-4, S-11) : le relais ne reprend
  // jamais un lot (`adopt`), et la bascule de collecte d'une session terminale
  // n'arme plus de boucle de pilote (`controller.start`) — hors du service, les
  // pipelines n'avancent plus, le panneau le dit, personne ne s'y substitue.
  const relaySource = fs.readFileSync(path.join(ROOT, "omp-mem0-req", "relay.ts"), "utf8");
  const extensionSource = fs.readFileSync(path.join(ROOT, "omp-mem0-req", "extension.ts"), "utf8");
  assert.equal(/\.adopt\(\)/.test(relaySource), false, "le relais n'adopte plus aucun lot");
  assert.equal(/controller\.start\(\)/.test(extensionSource), false, "aucune session terminale n'arme un pilote");
});

test("service : le socle du service est complet (port, singleton, plist)", async () => {
  // Faits de S-1 vérifiés sans l'hôte : le port lu dans l'environnement, le refus
  // du doublon, et la ligne de commande du job launchd (jamais un mode RPC).
  assert.equal(servicePort({}), 8788);
  assert.equal(servicePort({ MEM0_SERVICE_PORT: "0" }), 0);
  assert.deepEqual(serviceJobArgv("/usr/local/bin/omp"), [
    "/usr/local/bin/omp",
    "-p",
    "--no-session",
    "--pipeline-service",
    "/service start",
  ]);
  const plist = renderServicePlist({
    label: "com.millianlmx.mem0-omp-service",
    argv: serviceJobArgv("/usr/local/bin/omp"),
    home: "/Users/test",
    stateDir: "/tmp/state",
    ompBin: "/usr/local/bin/omp",
  });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/, "la relance après SIGKILL est dans le plist");
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  // Le singleton : un enregistrement vivant fait sortir le second service.
  const stateDir = mktmp("ac19-");
  writeService(
    { version: 1, pid: process.pid, port: 8899, token: "a".repeat(32), startedAt: 1, stateDir, sessionFile: null },
    stateDir,
  );
  const lines: string[] = [];
  const started = await startService({ api: {} as never, stateDir, log: line => lines.push(line) });
  assert.deepEqual(started, { kind: "already-running", pid: process.pid });
  assert.deepEqual(lines, [`un service tourne déjà (pid ${process.pid})`]);
  assert.equal(readService(stateDir)?.port, 8899, "le port et le jeton du premier sont intacts");
  void ServiceError;
});
