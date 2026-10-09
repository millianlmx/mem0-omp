// LE PILOTAGE du service (S-4, S-5, S-7, S-9) : le service balaie le magasin,
// adopte chaque lot et chaque projet, et fait avancer toutes les chaînes de la
// machine dans SON process — aucun `omp` enfant, aucune session terminale pilote.
//
// Un contrôleur par dépôt (`controllerFor`), créé paresseusement : c'est lui qui
// tient les runs en vol, les boîtes et les fins de run d'un dépôt. Le service ne
// fait que le balayage, l'adoption et la remise en route.
import type { GitResult, GitRunner } from "./git.ts";
import { realpathOr } from "./git.ts";
import { LOT_TICK_MS, lotRepoKey, lotStateDir, readLot } from "./lot.ts";
import { createLotController } from "./lotController.ts";
import type { LotController } from "./lotController.ts";
import { readProject, writeProject } from "./project.ts";
import type { Project } from "./project.ts";
import { conduiteBusyRefusal } from "./projectRelay.ts";
import { asCommand, commandShapeRefusal } from "./commands.ts";
import type { CommandOutcome, ServiceHealth } from "./serviceApi.ts";
import { badRequest, conflict, notFound } from "./serviceApi.ts";
import type { SessionHost } from "./serviceSessions.ts";
import type { ArbiterRunner, LotRunner } from "./serviceRuns.ts";
import { SERVICE_VERSION } from "./serviceState.ts";
import { pipelineStateDir } from "./store.ts";
import * as fs from "node:fs";
import * as path from "node:path";


export type PilotDeps = {
  stateDir: string;
  host: SessionHost;
  run: LotRunner;
  /** Le lanceur d'arbitre (S-9) : absent = aucun arbitrage, les éléments restent à l'utilisateur. */
  arbiter?: ArbiterRunner;
  runGit: GitRunner;
  runGh?: (args: string[], cwd: string) => Promise<GitResult>;
  notify?: (text: string) => void;
  toast?: (text: string, tone: "info" | "warning" | "error") => void;
  log?: (line: string) => void;
  now?: () => number;
  startedAt?: number;
  /** La minuterie du balayage : injectable pour que les tests n'attendent pas. */
  schedule?: (callback: () => void, ms: number) => () => void;
};

/** Ce que le routeur appelle pour piloter : l'API du service côté dépôts. */
export interface ServicePilot {
  start: () => void;
  stop: () => void;
  sweep: () => void;
  controllerFor: (repoRoot: string) => LotController;
  pilot: (repo: string) => Promise<{ repoKey: string; lotId: string | null; state: "piloting" }>;
  command: (repo: string, body: unknown) => Promise<CommandOutcome>;
  health: () => ServiceHealth;
  startConduite: (repo: string, body: unknown) => Promise<{ sessionId: string; state: "idle" | "running" }>;
  stopConduite: (repo: string) => Promise<void>;
}


/**
 * Le dépôt visé par une route : chemin absolu EXISTANT. Un chemin relatif ou
 * disparu est un 404 nommé (S-2, cas limites) — jamais un lot créé ailleurs.
 */
function requireRepo(repo: string): string {
  if (!path.isAbsolute(repo)) throw notFound(`chemin de dépôt non absolu : ${repo}`);
  if (!fs.existsSync(repo)) throw notFound(`dépôt introuvable : ${repo}`);
  return realpathOr(repo);
}


/** Les fichiers `*.json` d'un dossier du magasin, dans l'ordre stable des noms. */
function storeFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(name => name.endsWith(".json")).sort().map(name => path.join(dir, name));
}


export function createServicePilot(deps: PilotDeps): ServicePilot {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const stateDir = deps.stateDir;
  const controllers = new Map<string, LotController>();
  let stopSweep: (() => void) | null = null;
  let conduitesResumed = false;

  /**
   * La REPRISE des conduites (S-5) : une session `project` n'existe que tant que
   * le service vit — après un redémarrage (ou un `kill -9`), elle est recréée
   * depuis son fichier de session (`hostSession`) et son relais se réarme à son
   * `session_start` ; le pilote de segments repart sans aucun geste. Le premier
   * balayage seul s'en charge : un `DELETE /conduite` est un geste de
   * l'utilisateur, pas une panne à réparer, et le tick suivant ne doit pas le
   * défaire.
   */
  function resumeConduites(): void {
    if (conduitesResumed) return;
    conduitesResumed = true;
    for (const file of storeFiles(path.join(stateDir, "projects"))) {
      let project: Project | null = null;
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { repoRoot?: unknown };
        if (raw === null || typeof raw.repoRoot !== "string") continue;
        project = readProject(stateDir, lotRepoKey(raw.repoRoot));
      } catch {
        continue;
      }
      if (project === null || project.status !== "running" || project.hostSession === null) continue;
      if (!fs.existsSync(project.hostSession)) {
        log(`[service] conduite ignorée : fichier de session introuvable (${project.hostSession})`);
        continue;
      }
      if (deps.host.conduiteFor(project.repoRoot) !== null) continue;
      const repoRoot = project.repoRoot;
      const resumeFile = project.hostSession;
      void deps.host.open({ cwd: repoRoot, purpose: "project", resume: resumeFile }).then(
        hosted => log(`[service] conduite reprise pour ${repoRoot} (session ${hosted.id})`),
        (err: unknown) => {
          log(`[service] reprise de conduite en échec : ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    }
  }

  function controllerFor(repoRoot: string): LotController {
    const root = realpathOr(repoRoot);
    const known = controllers.get(root);
    if (known) return known;
    const controller = createLotController({
      stateDir,
      repoRoot: root,
      run: deps.run,
      arbiter: deps.arbiter,
      runGit: deps.runGit,
      runGh: deps.runGh,
      notify: deps.notify,
      toast: deps.toast,
      // Le propriétaire publié est CE process : c'est ce qui rend vrai « une
      // session en cours n'est jamais affichée interrompue » tant que le service
      // vit (S-8).
      session: () => ({ file: null, id: null }),
      schedule: deps.schedule,
      now: deps.now,
    });
    controllers.set(root, controller);
    return controller;
  }

  /**
   * Une passe de balayage : chaque lot et chaque projet du magasin est adopté puis
   * démarré. Un dépôt disparu est ignoré, nommé — jamais une panne silencieuse.
   */
  function sweep(): void {
    for (const file of storeFiles(lotStateDir(stateDir))) {
      const raw = (() => {
        try {
          return JSON.parse(fs.readFileSync(file, "utf8")) as { repoRoot?: unknown };
        } catch {
          return null;
        }
      })();
      const repoRoot = raw !== null && typeof raw.repoRoot === "string" ? raw.repoRoot : null;
      if (repoRoot === null) continue;
      if (!fs.existsSync(repoRoot)) {
        log(`[service] lot ignoré : dépôt introuvable (${repoRoot})`);
        continue;
      }
      const controller = controllerFor(repoRoot);
      controller.adopt();
      controller.start();
    }
    for (const file of storeFiles(path.join(stateDir, "projects"))) {
      const raw = (() => {
        try {
          return JSON.parse(fs.readFileSync(file, "utf8")) as { repoRoot?: unknown };
        } catch {
          return null;
        }
      })();
      const repoRoot = raw !== null && typeof raw.repoRoot === "string" ? raw.repoRoot : null;
      if (repoRoot === null || !fs.existsSync(repoRoot)) continue;
      // Un projet en cours fait avancer son lot : le contrôleur du dépôt est ce qui
      // exécute les segments (le relais vit, lui, dans la session de conduite).
      const controller = controllerFor(repoRoot);
      controller.adopt();
      controller.start();
    }
    // Les CONDUITES se recréent APRÈS l'adoption de leurs lots (S-5) : le relais
    // d'une session reprise scanne au `session_start` et doit trouver le service
    // déjà propriétaire.
    resumeConduites();
  }

  return {
    start(): void {
      if (stopSweep !== null) return;
      sweep();
      stopSweep = (deps.schedule ?? ((callback, ms) => {
        const timer = setInterval(callback, ms);
        return () => clearInterval(timer);
      }))(() => {
        try {
          sweep();
        } catch (err) {
          log(`[service] balayage en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
      }, LOT_TICK_MS);
    },

    stop(): void {
      stopSweep?.();
      stopSweep = null;
      for (const controller of controllers.values()) {
        try {
          controller.abortAll("service arrêté");
          controller.stop();
        } catch {
          /* l'arrêt ne lève jamais */
        }
      }
      controllers.clear();
    },

    sweep,
    controllerFor,

    /** Réveille un dépôt (S-9) : contrôleur créé au besoin, adoption, tick. */
    async pilot(repo) {
      const root = requireRepo(repo);
      const controller = controllerFor(root);
      controller.adopt();
      controller.start();
      await controller.tick();
      const lot = controller.read();
      return { repoKey: lotRepoKey(root), lotId: lot === null ? null : lot.id, state: "piloting" as const };
    },

    /** Une commande de pipeline : mêmes refus et même accusé que le canal (S-9). */
    async command(repo, body) {
      const root = requireRepo(repo);
      const command = asCommand(body);
      if (command === null) throw badRequest(commandShapeRefusal(body));
      if (realpathOr(command.repo) !== root) {
        throw badRequest("le corps de la commande vise un autre dépôt que la route");
      }
      const controller = controllerFor(root);
      controller.start();
      return { command, ack: await controller.acceptCommand(command) };
    },

    health(): ServiceHealth {
      return {
        version: SERVICE_VERSION,
        pid: process.pid,
        startedAt: deps.startedAt ?? now(),
        sessions: deps.host.list().length,
        lots: storeFiles(lotStateDir(stateDir)).length,
      };
    },

    /**
     * La conduite de projet (S-7) : les refus d'aujourd'hui, MOT POUR MOT, avant
     * toute création — dépôt non git, sans distant GitHub, conduite déjà vivante.
     * Sinon la session `project` vit DANS le service et reçoit l'AMORCE `/project`
     * — la COMMANDE, jamais un texte de cadrage : c'est son handler qui cerne le
     * projet, arme le relais, expose `project_plan`/`project_amend` et écrit
     * l'état.
     */
    async startConduite(repo, body) {
      const root = requireRepo(repo);
      if (!fs.existsSync(path.join(root, ".git"))) {
        throw conflict(
          `[project] ${root} n'est pas un dépôt git — crée-le (git init) et son dépôt distant GitHub, puis relance /project. Rien n'a été créé.`,
        );
      }
      const remotes = await deps.runGit(["remote", "-v"], root);
      if (remotes.code !== 0 || !/github\.com[:/]/.test(remotes.stdout)) {
        throw conflict(
          `[project] ${root} n'a aucun dépôt distant GitHub (git remote -v) — ajoute-le (git remote add origin <URL du dépôt GitHub>), puis relance /project. Rien n'a été créé.`,
        );
      }
      const name = body && typeof body === "object" && !Array.isArray(body) ? (body as { name?: unknown }).name : undefined;
      if (typeof name !== "string") throw badRequest("champ « name » manquant");
      const existing = deps.host.conduiteFor(root);
      if (existing !== null) {
        // Le texte exact d'aujourd'hui (`projectRelay.runProjectCommand`) : la
        // conduite est tenue par une session vivante — ici, le service.
        throw conflict(conduiteBusyRefusal(path.basename(root), process.pid));
      }
      const project = readProject(stateDir, lotRepoKey(root));
      const hosted = await deps.host.open({
        cwd: root,
        purpose: "project",
        resume: project?.hostSession ?? null,
      });
      // Une conduite DÉJÀ en marche ET reprise de son fichier de session (S-5)
      // n'est pas relancée : son relais est armé par son `session_start`, et lui
      // rejouer la commande ne ferait qu'un refus « conduite déjà tenue » dans sa
      // conversation. Tout le reste reçoit l'amorce — un projet `running` sans
      // fichier de session est repris par le handler lui-même (`resume`).
      const resumed = project !== null && project.status === "running" && project.hostSession !== null;
      if (!resumed) {
        const prompt = hosted.session.prompt(`/project ${name.trim()}`).catch(err => {
          log(`[service] amorce de conduite en échec : ${err instanceof Error ? err.message : String(err)}`);
        });
        // Le cadrage NEUF se joue d'un trait (aucun dialogue n'y est attendu) : la
        // réponse attend la commande, donc la session a déjà pris son fichier de
        // cadrage quand l'app lit la fiche (`GET /v1/sessions/{id}`, S-7).
        if (project === null) await prompt;
      }
      if (hosted.sessionFile !== null && project !== null) {
        project.hostSession = hosted.sessionFile;
        project.updatedAt = now();
        writeProject(stateDir, project);
      } else if (project === null) {
        // Une conduite neuve n'écrit le projet qu'au plan validé : c'est le relais
        // de la session qui le crée.
        log(`[service] conduite ouverte pour ${root} (session ${hosted.id})`);
      }
      return { sessionId: hosted.id, state: hosted.state };
    },

    /** Arrête la session de conduite : le projet reste dans le magasin (S-7). */
    async stopConduite(repo) {
      const root = requireRepo(repo);
      const hosted = deps.host.conduiteFor(root);
      if (hosted === null) throw notFound(`aucune conduite vivante pour ${root}`);
      await hosted.dispose();
    },
  };
}
