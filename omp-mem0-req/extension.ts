import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { createAuditRelay } from "./audit.ts";
import { buildNextStepNotice, buildReqHandoff, isPipelineNotice, nextStepFor, saysFin } from "./contract.ts";
import type { NextStep } from "./contract.ts";
import { GIT_TIMEOUT_MS, branchFor, branchTaken, buildSweepMessage, buildWelcome, contractPathFor, createFeatureWorktree, linkGate, resolveFeatureRoot, sweepFeatureWorktrees, toSlug, worktreesBaseDir } from "./git.ts";
import type { GitResult, GitRunner } from "./git.ts";
import { armInbox, conversationPhaseOf, registerAskTool } from "./inbox.ts";
import { lotOmpBin, lotRunTimeoutMs } from "./lot.ts";
import type { Lot } from "./lot.ts";
import { createLotController } from "./lotController.ts";
import type { LotController } from "./lotController.ts";
import { pipelinesPanelFactory } from "./panel.ts";
import { hostComponents } from "./panelHost.ts";
import { diskProbe, joinEntry } from "./panelSession.ts";
import type { SwitchCtx } from "./panelSession.ts";
import type { PipelinesPanelDeps } from "./panelView.ts";
import { armPipeline, closePipeline, ensureHeartbeat, isSubagentSession, pendingApprovals, pendingAsks, publishCurrentCwd, reportStateWriteFailure, resetStateWriteWarning, sessionFileOf, sessionIdOf } from "./publish.ts";
import type { PublishDeps } from "./publish.ts";
import { runState } from "./runState.ts";
import { SELF_MODULE_URL, buildConversationRunArgv, conversationRefusal, handOverCollecte, lotDriverFor, repoRootOf, selfExtensionArg, workerModeOf } from "./runs.ts";
import type { WorkerMode } from "./runs.ts";
import { SYSTEM_DIRECTIVE_REQ, buildAuditSeed, buildImplSeed, buildReviewSeed, buildSpecsSeed } from "./seeds.ts";
import { stateOfCwd } from "./state.ts";
import { deleteRunningEntry, pipelineStateDir, runningIdFor } from "./store.ts";
import type { PipelineCtx } from "./store.ts";



/** Le strict nécessaire de `ctx.ui` : l'éditeur, qui n'existe qu'en mode interactif. */
export type EditorUI = {
  getEditorText?: () => string;
  setEditorText?: (text: string) => void;
};


/**
 * Préremplit la zone de saisie avec la commande de la suite. Les quatre
 * conditions sont nécessaires : hors TUI les méthodes sont des no-op (et la
 * commande n'aurait nulle part où s'afficher), et un brouillon déjà saisi est du
 * travail de l'utilisateur — jamais écrasé. Échec = éditeur inchangé, en silence :
 * l'annonce dans le transcript porte déjà l'information.
 */
export function prefillEditor(ctx: { hasUI: boolean; ui?: EditorUI }, step: NextStep): void {
  if (step.kind !== "command") return; // fin de cycle : rien à valider
  if (!ctx.hasUI) return;
  const ui = ctx.ui;
  if (typeof ui?.getEditorText !== "function" || typeof ui.setEditorText !== "function") return;
  let current = "";
  try {
    current = ui.getEditorText();
  } catch {
    return;
  }
  if (typeof current !== "string" || current.trim() !== "") return;
  ui.setEditorText(step.command);
}


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function reqExtension(pi: ExtensionAPI) {
  // Toute la git du plugin passe par là : jamais node:child_process dans
  // l'extension, et le runner est injectable dans les tests. `killed` (timeout)
  // devient un échec, comme un code ≠ 0 — aucune porte d'approbation sur pi.exec.
  const run: GitRunner = async (args, cwd) => {
    try {
      const res = await pi.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
      return {
        code: res.killed ? 124 : res.code,
        stdout: res.stdout ?? "",
        stderr: res.killed ? `git ${args[0]} : délai dépassé (${GIT_TIMEOUT_MS} ms)` : (res.stderr ?? ""),
      };
    } catch (err) {
      return { code: 127, stdout: "", stderr: (err as Error).message };
    }
  };

  // Balayage en tête de CHAQUE maillon, avant toute autre action : le worktree
  // d'une feature poussée et propre est retiré au déclenchement suivant. Un
  // balayage impossible est signalé et ne retire rien.
  const sweep = async (ctx: ExtensionContext) => {
    try {
      const result = await sweepFeatureWorktrees({
        run,
        baseDir: worktreesBaseDir(),
        currentCwd: ctx.cwd,
        repoRoot: ctx.cwd,
      });
      const message = buildSweepMessage(result);
      if (message) {
        pi.sendMessage(
          { customType: "pipeline", content: message, display: true, attribution: "user" },
          { triggerTurn: false },
        );
      }
    } catch (err) {
      ctx.ui?.notify?.(`[pipeline] balayage des worktrees ignoré : ${(err as Error).message}.`, "warning");
    }
  };

  // Une notice DURABLE (message d'affichage, jamais un toast qui disparaît au
  // redraw) est le seul canal de signalement du registre : le panneau, lui, ne
  // parle à l'utilisateur que dans son propre rang de notice.
  const notifyDurable = (text: string) =>
    pi.sendMessage({ customType: "pipeline", content: text, display: true, attribution: "user" }, { triggerTurn: false });

  const pipelineDeps = (ctx: PipelineCtx): PublishDeps => ({ ctx, notify: notifyDurable, stateDir: storeDir() });

  // `gh` : même doctrine que git (jamais node:child_process, runner câblé sur
  // `pi.exec`), avec un budget plus large — c'est du réseau, pas une commande
  // locale (cf. `## Documentation` §4).
  const GH_TIMEOUT_MS = 60_000;
  const runGh = async (args: string[], cwd: string): Promise<GitResult> => {
    try {
      const res = await pi.exec("gh", args, { cwd, timeout: GH_TIMEOUT_MS });
      return {
        code: res.killed ? 124 : res.code,
        stdout: res.stdout ?? "",
        stderr: res.killed ? `gh ${args[0]} : délai dépassé (${GH_TIMEOUT_MS} ms)` : (res.stderr ?? ""),
      };
    } catch (err) {
      return { code: 127, stdout: "", stderr: (err as Error).message };
    }
  };

  // --- drapeaux du mode worker, et pilote du lot ----------------------------
  // Les drapeaux sont déclarés AU CHARGEMENT : un drapeau inconnu du CLI est une
  // erreur dure, et un run de lot est lancé avec ces quatre-là (`buildLotRunArgv`,
  // cf. `## Documentation` §2).
  pi.registerFlag("pipeline-lot", { type: "string", description: "Lot propriétaire de ce run (mode worker)" });
  pi.registerFlag("pipeline-feature", { type: "string", description: "Feature de ce run (mode worker)" });
  pi.registerFlag("pipeline-phase", {
    type: "string",
    description: "Maillon de ce run : req, specs, impl, review ou release",
  });
  pi.registerFlag("pipeline-state-dir", {
    type: "string",
    description: "Répertoire du magasin d'état des pipelines",
  });
  // Le drapeau d'un run ARMÉ par le panneau (`/pipelines`) : sans lui, aucune
  // écriture n'atteint une session vivante (cf. `## Documentation` §4).
  pi.registerFlag("panel-inbox", {
    type: "string",
    description: "Boîte de réception d'un run lancé par le panneau (/pipelines)",
  });
  // Borne DURE d'un run enfant (epoch ms), posée par le pilote : le délai de
  // `pi.exec` ne s'applique qu'au process parent, donc un enfant qui survit à un
  // pilote tué n'aurait aucune échéance (l'outil ask attendrait indéfiniment).
  // Le mécanisme principal reste le chien de garde sur le parent (`process.ppid`).
  pi.registerFlag("pipeline-deadline", {
    type: "string",
    description: "Échéance absolue (epoch ms) d'un run de lot, au-delà de laquelle il rend la main",
  });

  // Mode worker : ce process EST un maillon du lot. Il publie son état, exécute le
  // prompt reçu en argv et n'annonce rien — la chaîne appartient au pilote.
  //
  // Les drapeaux sont relus À CHAQUE FOIS, jamais au chargement : le CLI applique
  // les drapeaux d'extension APRÈS avoir chargé les extensions (`## Documentation`
  // §2), donc un `pi.getFlag` évalué à l'import rend toujours `undefined`.
  const workerMode = (): WorkerMode | null => workerModeOf(pi);

  /**
   * Le magasin d'état de CE process : le drapeau d'un run de lot fait autorité
   * (le pilote peut avoir un magasin que l'environnement de l'enfant ne dit pas),
   * sinon `MEM0_PIPELINE_STATE_DIR` puis `~/.omp/agent/pipeline`. Toutes les
   * écritures du registre passent par ici — sans quoi un run de lot publierait
   * dans le magasin par défaut de la machine au lieu de celui de son lot.
   */
  const storeDir = (): string => {
    // Le drapeau fait autorité même HORS mode worker : un run de conversation
    // (S-9) n'est pas un maillon, mais il doit publier dans le magasin de son
    // panneau — sinon son rang ne redevient jamais vivant.
    const flag = pi.getFlag("pipeline-state-dir");
    if (typeof flag === "string" && path.isAbsolute(flag)) return workerMode()?.stateDir ?? flag;
    return workerMode()?.stateDir ?? pipelineStateDir();
  };

  // Un pilote PAR DÉPÔT (S-1) : rejoindre la session d'un autre dépôt puis
  // revenir ne doit pas recréer un pilote — ses runs en vol, son registre de
  // boîtes et ses fins de run vivent dans les Maps du contrôleur, donc un
  // contrôleur neuf jugerait « pilote disparu » des runs qui tournent encore
  // dans le même process (AC-19).
  const lotControllers = new Map<string, LotController>();

  /** Le dernier contexte de session vu : ce que consultent les pilotes. */
  let liveCtxRef: ExtensionContext | undefined;
  const liveCtx = (): ExtensionContext => liveCtxRef as ExtensionContext;

  /**
   * Le pilote du dépôt de cette session. Le lot n'a qu'un écrivain : deux
   * sessions du même dépôt ne se marchent pas dessus — la seconde ne reprend la
   * main que si le pid de la première est mort (ou son battement périmé).
   */
  const controllerFor = (ctx: ExtensionContext): LotController => {
    liveCtxRef = ctx;
    const root = resolveFeatureRoot(ctx.cwd);
    const repoRoot = root.primary ?? root.dir;
    const known = lotControllers.get(repoRoot);
    if (known) return known;
    const controller = createLotController({
      stateDir: storeDir(),
      repoRoot,
      run: async ({ argv, cwd, timeout, signal }) => {
        const res = await pi.exec(argv[0] ?? "omp", argv.slice(1), { cwd, timeout, signal });
        return {
          code: res.killed ? 124 : res.code,
          killed: res.killed === true,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
        };
      },
      runGit: run,
      runGh,
      notify: notifyDurable,
      // Le pilote survit aux bascules de session (un contrôleur par dépôt) : ses
      // sorties visibles et sa session d'écriture sont donc lues DYNAMIQUEMENT
      // sur le dernier contexte vu, jamais figées sur celui qui l'a créé — sinon
      // un toast s'adresserait à une session morte et l'owner du lot
      // nommerait un fichier de session périmé.
      toast: (text, tone) => liveCtx().ui?.notify?.(text, tone),
      session: () => ({ file: sessionFileOf(liveCtx() as PipelineCtx), id: sessionIdOf(liveCtx() as PipelineCtx) }),
      selfPath: selfExtensionArg(SELF_MODULE_URL),
      schedule: (callback, ms) => {
        // Minuterie GÉRÉE : nettoyée au `session_shutdown`, jamais orpheline. Un
        // contexte dégradé (hors OMP complet) n'a pas de minuterie : le pilote
        // tourne alors à la demande (chaque action relance une passe).
        const ctx = liveCtx();
        if (typeof ctx.setInterval !== "function" || typeof ctx.clearTimer !== "function") return () => {};
        const timer = ctx.setInterval(callback, ms);
        return () => ctx.clearTimer(timer);
      },
    });
    lotControllers.set(repoRoot, controller);
    return controller;
  };

  // --- /audit : le relais des questions et jalons d'une pipeline /audit -------
  // Armé seulement dans une session ouverte par `/audit` (ou qui a lancé une
  // feature /audit encore vivante) : aucune autre session ne voit ses outils ni
  // sa minuterie.
  const auditRelay = createAuditRelay({ pi, stateDir: storeDir, controllerFor, notify: notifyDurable });

  // --- /pipelines et alt+w : le panneau des pipelines en cours --------------
  // Un seul panneau par processus : tant qu'un overlay est monté, une seconde
  // ouverture ne monte rien (aucun overlay empilé, aucun doublon).
  let panelOpen = false;
  let panelUnavailableNotified = false;

  const openPanel = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
      // RPC / print : rien à monter, et l'utilisateur doit l'apprendre UNE fois.
      if (!panelUnavailableNotified) {
        panelUnavailableNotified = true;
        notifyDurable("[pipeline] panneau indisponible hors session interactive");
      }
      return;
    }
    if (panelOpen) return;
    // Le kit de composants de l'hôte (S-1) : sans lui, le panneau ne s'ouvre pas —
    // il n'existe AUCUN rendu de repli, et un écran à moitié peint serait pire
    // qu'un refus. Le message est celui de S-1, sur le même canal que le refus hors
    // session interactive.
    const components = hostComponents(pi);
    if (!components) {
      notifyDurable("[pipeline] panneau indisponible : composants de l'hôte absents (OMP)");
      return;
    }
    panelOpen = true;
    const stateDir = storeDir();
    const deps: PipelinesPanelDeps = {
      stateDir,
      components,
      repoRoot: (() => {
        const root = resolveFeatureRoot(ctx.cwd);
        return root.primary ?? root.dir;
      })(),
      lot: workerMode() ? undefined : controllerFor(ctx),
      // La session VIVANTE de ce process : viser sa propre session est refusé (S-3).
      currentSessionFile: sessionFileOf(ctx as PipelineCtx),
      /**
       * Reprendre une session TERMINÉE hors lot (S-9) : les deux refus d'abord
       * (rien n'est lancé), la boîte ensuite, puis le run — jamais attendu, sa
       * durée n'est pas celle du panneau, et sa fin se lit dans le magasin.
       */
      sessionReply: async (target, text) => {
        const refusal = conversationRefusal(target, diskProbe);
        if (refusal) return refusal;
        const argv = buildConversationRunArgv({
          ompBin: lotOmpBin(),
          target,
          stateDir,
          prompt: text,
          selfPath: selfExtensionArg(SELF_MODULE_URL),
        });
        try {
          fs.mkdirSync(target.inbox, { recursive: true });
        } catch (err) {
          return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
        }
        try {
          void Promise.resolve(
            pi.exec(argv[0] ?? "omp", argv.slice(1), { cwd: target.cwd, timeout: lotRunTimeoutMs() }),
          ).catch((err: unknown) => {
            notifyDurable(
              `[pipeline] run de conversation interrompu : ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        } catch (err) {
          return `écriture impossible : ${err instanceof Error ? err.message : String(err)}`;
        }
        return null;
      },
      join: (entry, close, showNotice) => {
        // `switchSession` vit sur le contexte de COMMANDE : le runtime appelle
        // `createCommandContext()` pour les commandes ET pour les raccourcis, donc
        // le même `ctx` porte la bascule dans les deux cas (cf. `## Documentation` §3).
        // Le cast est DOUBLE parce que la façade publique masque les méthodes de
        // relocalisation du gestionnaire (`## Documentation` §2) : elles sont bien
        // là au runtime, le type ne les déclare pas.
        void joinEntry(entry, {
          ctx: ctx as unknown as SwitchCtx,
          close,
          showNotice,
          notify: notifyDurable,
        });
      },
    };
    try {
      void ctx.ui
        .custom(pipelinesPanelFactory(deps), {
          overlay: true,
          // Plein écran, PLEINE LARGEUR et souris (S-3) : le cadre EST l'écran, et
          // `mouseTracking` est ce qui fait émettre les rapports de clic et de
          // molette. `width` est REQUIS — un `overlayOptions` fourni REMPLACE le
          // défaut de l'hôte (`{anchor: "bottom-center", width: "100%", …}`), et
          // sans lui `#resolveOverlayLayout` plafonne l'overlay à `min(80,
          // disponible)` colonnes (`## Documentation` §1) : sur un terminal de 120
          // colonnes, le panneau était rendu à 80. `maxHeight` et `margin: 0` sont
          // les deux autres termes du défaut, repris tels quels ; l'ancre reste
          // absente (le plein écran ne s'ancre pas).
          overlayOptions: { fullscreen: true, mouseTracking: true, width: "100%", maxHeight: "100%", margin: 0 },
        })
        .catch(() => {
          /* le panneau ne doit jamais faire échouer la commande qui l'ouvre */
        })
        .finally(() => {
          panelOpen = false;
        });
    } catch {
      panelOpen = false;
      ctx.ui?.notify?.("[pipeline] affichage du panneau impossible.", "warning");
    }
  };

  pi.registerCommand("pipelines", {
    description: "Affiche le panneau des pipelines en cours (tous les processus OMP, tous dépôts) — Échap ferme",
    handler: async (_args, ctx) => {
      openPanel(ctx);
    },
  });

  pi.registerShortcut("alt+w", {
    description: "Panneau des pipelines en cours",
    handler: async (ctx) => {
      openPanel(ctx);
    },
  });

  // --- registre des pipelines : battement et republication -------------------
  // Le propriétaire SEUL écrit ses entrées : les lecteurs du magasin (le panneau,
  // y compris celui d'un autre processus) ne font que constater.
  // Ce process est un RUN lancé par le panneau (S-9) : armé, mais pas un maillon
  // de lot. Il publie son entrée et n'annonce rien — une notice de fin de maillon
  // (« commande suivante : /review ») n'a aucun sens dans une session que
  // l'utilisateur a lui-même reprise, et il meurt à la fin de son tour.
  let runOnly = false;

  pi.on("session_start", async (_event, ctx) => {
    resetStateWriteWarning();
    // Un SOUS-AGENT (`task`) rebinde la fabrique avec un runtime neuf et reçoit
    // ce `session_start` : sans garde, il volerait le battement de son process
    // (sa minuterie est nettoyée à sa fin), publierait SA session dans l'entrée
    // du worktree, et adopterait le lot depuis une session jetable. Le fichier de
    // session d'un sous-agent porte `parentSession` : c'est ce qui le distingue,
    // et rien de ce qui suit ne le concerne.
    if (isSubagentSession(sessionFileOf(ctx as PipelineCtx))) return;
    liveCtxRef = ctx;
    ensureHeartbeat(ctx as PipelineCtx, { notify: notifyDurable, stateDir: storeDir() });
    // Un run lancé par le panneau est ARMÉ (`--panel-inbox`) : il consomme sa
    // boîte et expose un vrai outil `ask` (S-6, S-7). Une session interactive n'a
    // jamais ce drapeau : rien n'est armé ici, et l'outil `ask` de l'hôte — avec
    // son dialogue riche — garde la main.
    const armed = armInbox(pi, ctx as PipelineCtx);
    if (armed) registerAskTool(pi, { notify: notifyDurable, stateDir: storeDir() });
    // Un run de lot arme SON maillon et le publie : il apparaît dans /pipelines
    // dès le démarrage, et un maillon `req` reçoit la directive de collecte.
    const mode = workerMode();
    if (mode) {
      stateOfCwd(ctx.cwd).reqMode = mode.phase === "req";
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, mode.phase);
      return;
    }
    // Run de CONVERSATION ou run de panneau (S-9) : aucun drapeau de lot, donc
    // pas un maillon — mais il publie son entrée, sinon son rang resterait un
    // rang d'historique pendant tout le run et une seconde écriture lancerait un
    // second run sur la même session. Un process `-p` ne pilote RIEN : il meurt à
    // la fin de son tour, donc adopter un lot depuis lui laisserait des runs
    // orphelins (c'est le `return`, ici, qui l'interdit).
    if (armed) {
      runOnly = true;
      const phase = conversationPhaseOf(pi);
      if (phase) armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, phase);
      return;
    }
    // Session ordinaire : si le lot de ce dépôt n'a plus de pilote, on le reprend.
    const controller = controllerFor(ctx);
    if (controller.adopt()) controller.start();
    auditRelay.sync(ctx);
  });

  // Une bascule de session (`/new`, `/resume`, `/req`, `/audit`…) ouvre ou ferme
  // le relais /audit : il suit la session COURANTE du process (S-6).
  pi.on("session_switch", async (_event, ctx) => {
    if (isSubagentSession(sessionFileOf(ctx as PipelineCtx)) || workerMode() || runOnly) return;
    auditRelay.sync(ctx);
  });

  // Fermer la session pilote ne doit pas laisser des runs VIVANTS derrière elle :
  // `pi.exec` ne tue pas ses enfants à la sortie du process, et le délai d'un run
  // n'existe que dans son `pi.exec` — un enfant survivant attendrait une réponse
  // qu'aucun lot ne porte plus. On les tue donc explicitement, et la fin de
  // chaque run clôt son entrée (la reprise du lot repart d'un état propre).
  pi.on("session_shutdown", async () => {
    auditRelay.disarm();
    try {
      runState.pumpStop?.();
      runState.pumpStop = null;
    } catch {
      /* une minuterie déjà nettoyée n'est pas une erreur */
    }
    for (const controller of lotControllers.values()) {
      try {
        controller.abortAll("session fermée");
      } catch {
        /* l'arrêt ne doit jamais jeter */
      }
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  // L'outil `ask` en vol est le cas le plus visible de « suspendu à une question » :
  // l'état est publié dès le démarrage de l'appel, pas à la fin du tour.
  pi.on("tool_execution_start", async (event, ctx) => {
    if (event.toolName === "ask") pendingAsks.add(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Par identifiant d'appel : un `end` manquant ne fige pas le compteur, et un
    // `end` d'un autre appel non plus.
    pendingAsks.delete(event.toolCallId);
    pendingApprovals.delete(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  pi.on("tool_approval_requested", async (event, ctx) => {
    pendingApprovals.add(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  pi.on("tool_approval_resolved", async (event, ctx) => {
    pendingApprovals.delete(event.toolCallId);
    publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
  });

  // --- /req : ouvre la feature dans son worktree, puis arme la collecte ------
  // L'isolation passe AVANT tout envoi de texte : l'agent doit écrire le contrat
  // dans le worktree, pas dans le dépôt principal.
  pi.registerCommand("req", {
    description: "Ouvre la feature dans son worktree git dédié et active la collecte de besoins",
    handler: async (args, ctx) => {
      await sweep(ctx);

      const root = resolveFeatureRoot(ctx.cwd);
      if (root.primary) {
        ctx.ui?.notify?.(
          `[req] déjà dans le worktree d'une feature (${root.dir}) — /req s'ouvre depuis le dépôt principal (${root.primary}).`,
          "warning",
        );
        return;
      }
      if (!fs.existsSync(path.join(root.dir, ".git"))) {
        ctx.ui?.notify?.(
          `[req] ${ctx.cwd} n'est pas dans un dépôt git — /req isole chaque feature dans son worktree.`,
          "warning",
        );
        return;
      }

      const typed = String(args ?? "").trim();
      let name = typed.split(/\s+/).filter(Boolean)[0] ?? "";
      if (!name && ctx.hasUI && typeof ctx.ui?.input === "function") {
        name = ((await ctx.ui.input("Nom de la feature", "ex. isolation-worktree")) ?? "").trim();
      }
      if (!name) {
        ctx.ui?.notify?.("[req] nom de feature requis : /req <nom-de-feature> (ex. isolation-worktree).", "warning");
        return;
      }
      const slug = toSlug(name);
      if (!slug) {
        ctx.ui?.notify?.(
          `[req] nom invalide : « ${name} » — lettres minuscules, chiffres et tirets (ex. isolation-worktree).`,
          "warning",
        );
        return;
      }

      const branch = branchFor(slug);
      if (await branchTaken(run, root.dir, branch)) {
        ctx.ui?.notify?.(`[req] la branche ${branch} existe déjà — choisis un autre nom.`, "warning");
        return;
      }

      const created = await createFeatureWorktree({
        run,
        primaryRoot: root.dir,
        slug,
        baseDir: worktreesBaseDir(),
      });
      if (!created.ok) {
        ctx.ui?.notify?.(`[req] création du worktree impossible : ${created.error}`, "warning");
        return;
      }

      // Rollback : l'arbre vient d'être créé, il est vierge — `worktree remove`
      // sans `--force` suffit, et la branche reste.
      const rollback = async () => {
        await run(["worktree", "remove", created.path], root.dir);
      };

      if (typeof ctx.newSession !== "function") {
        await rollback();
        ctx.ui?.notify?.(
          "[req] session dans le worktree impossible : nouvelle session indisponible — worktree annulé, relance /req.",
          "warning",
        );
        return;
      }

      let failure = "";
      try {
        const res = await ctx.newSession({
          setup: async (sm) => {
            await sm.moveTo(created.path);
          },
        });
        if (res?.cancelled) failure = "nouvelle session annulée";
      } catch (err) {
        failure = (err as Error).message;
      }
      if (failure) {
        await rollback();
        ctx.ui?.notify?.(
          `[req] session dans le worktree impossible : ${failure} — worktree annulé, relance /req.`,
          "warning",
        );
        return;
      }

      // La feature entre dans le lot APRÈS la relocalisation réussie : sa collecte
      // se déroule dans cette session (`origin: "session"`), et le pilote prend la
      // main à sa clôture (S-14). Inscrite AVANT, un échec de bascule laissait une
      // feature fantôme dans le lot — en cours, sans fin possible, et sa branche
      // restante interdisait de relancer /req sous le même nom.
      const lotDriver = controllerFor(ctx);
      const refused = lotDriver.enrol({ slug, name: typed || slug, branch: created.branch, worktree: created.path });
      // Un lot conduit par une session vivante ne s'écrit pas (S-1) : la feature
      // n'y entre pas, et cette session le dit au lieu de laisser croire qu'elle
      // est pilotée par le lot de l'autre (elle garde la chaîne manuelle, S-14).
      if (refused) ctx.ui?.notify?.(`[req] ${refused} — cette feature garde la chaîne manuelle.`, "warning");

      // La collecte suit le WORKTREE (clé = cwd), pas la session : la session
      // vient d'être remplacée, le worktree est l'identité de la feature.
      const st = stateOfCwd(created.path);
      st.reqMode = true;
      st.closing = false;
      // Maillon armé après la bascule de session : l'annonce partira à la
      // retombée qui SUIT un « fin » de l'utilisateur, jamais pendant la collecte.
      // L'armement publie AUSSI l'entrée du magasin : elle existe dès la commande,
      // et c'est la session d'APRÈS la bascule qui y est publiée (la session
      // d'avant est celle du dépôt principal : elle ne conduit pas cette
      // collecte).
      liveCtxRef = ctx;
      armPipeline(pipelineDeps(ctx as PipelineCtx), created.path, "req");
      // Le pilote tourne : les AUTRES features du lot (s'il y en a) avancent
      // pendant cette collecte, et celle-ci sera prise en charge à sa clôture.
      // Une feature refusée n'appartient à aucun lot : aucun pilote à faire tourner.
      if (!refused) lotDriver.start();
      pi.sendMessage(
        {
          customType: "req",
          content: buildWelcome({ slug, branch: created.branch, path: created.path }),
          display: true,
          attribution: "user",
        },
        { triggerTurn: false },
      );
    },
  });

  // --- /audit : audite le dépôt, propose des features, lance et relaie -------
  // L'analyse est celle du modèle (cadrée par AUDIT_DIRECTIVE) ; le choix, la
  // validation de l'intention et le lancement passent par l'outil `audit_propose`,
  // armé avec le relais sur la session neuve.
  pi.registerCommand("audit", {
    description:
      "Audite le dépôt, propose des features et lance la pipeline de celle que tu choisis — questions et jalons relayés dans cette session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify?.("[audit] indisponible hors session interactive", "warning");
        return;
      }
      const root = resolveFeatureRoot(ctx.cwd);
      if (root.primary) {
        ctx.ui?.notify?.(
          `[audit] déjà dans le worktree d'une feature (${root.dir}) — /audit s'ouvre depuis le dépôt principal (${root.primary})`,
          "warning",
        );
        return;
      }
      if (!fs.existsSync(path.join(root.dir, ".git"))) {
        ctx.ui?.notify?.(`[audit] ${root.dir} n'est pas un dépôt git`, "warning");
        return;
      }
      const seed = buildAuditSeed(root.dir, String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[audit] nouvelle session impossible (${(err as Error).message}) — audit dans la session courante.`,
            "warning",
          );
        }
      }
      const sessionFile = sessionFileOf(ctx as PipelineCtx);
      if (sessionFile !== null) {
        auditRelay.markCreated(sessionFile);
        auditRelay.sync(ctx);
      }
      pi.sendUserMessage(seed);
    },
  });

  // --- /specs : session de spécification ---------------------------------
  // newSession n'existe que sur le contexte de commande (pas sur celui d'un
  // event) — d'où une commande plutôt qu'une détection de mot-clé. Les besoins
  // ne sont pas portés dans l'amorce : ils vivent dans le contrat, écrit par la
  // clôture de /req.
  pi.registerCommand("specs", {
    description: "Ouvre une session de spécification qui lit le contrat de besoins (specs one-shot)",
    handler: async (args, ctx) => {
      await sweep(ctx);
      // Le contrat est celui du CWD : hors du worktree d'une feature (et sans
      // contrat hérité), il n'y a rien à spécifier.
      const gate = linkGate(ctx.cwd);
      if (!gate.ok) {
        ctx.ui?.notify?.(`[specs] : ${gate.reason}`, "warning");
        return;
      }
      // Un seul acteur écrit un contrat à la fois : si le lot pilote cette feature,
      // la commande manuelle s'efface (S-14).
      const driving = lotDriverFor(storeDir(), repoRootOf(ctx.cwd), ctx.cwd);
      if (driving) {
        ctx.ui?.notify?.(
          `[specs] cette feature est pilotée par le lot ${path.basename(driving.repoRoot)} — ` +
            "pilote-la depuis /pipelines (ou annule-la pour reprendre à la main).",
          "warning",
        );
        return;
      }
      const seed = buildSpecsSeed(String(args ?? "").trim());
      stateOfCwd(ctx.cwd).reqMode = false;
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[specs] nouvelle session impossible (${(err as Error).message}) — spécification dans la session courante.`,
            "warning",
          );
        }
      }
      // Armé juste avant l'envoi de l'amorce : la suite (/impl, ou /specs si le
      // contrat n'a pas de specs) sera annoncée à la retombée de CE maillon, pas
      // à celle du tour précédent.
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "specs");
      pi.sendUserMessage(seed);
    },
  });

  // --- /impl : session d'implémentation ----------------------------------
  pi.registerCommand("impl", {
    description: "Ouvre une session d'implémentation one-shot ; --fix lève les bloquants de la dernière /review",
    handler: async (args, ctx) => {
      await sweep(ctx);
      const gate = linkGate(ctx.cwd);
      if (!gate.ok) {
        ctx.ui?.notify?.(`[impl] : ${gate.reason}`, "warning");
        return;
      }
      const driving = lotDriverFor(storeDir(), repoRootOf(ctx.cwd), ctx.cwd);
      if (driving) {
        ctx.ui?.notify?.(
          `[impl] cette feature est pilotée par le lot ${path.basename(driving.repoRoot)} — ` +
            "pilote-la depuis /pipelines (ou annule-la pour reprendre à la main).",
          "warning",
        );
        return;
      }
      const raw = String(args ?? "").trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      const fix = tokens.includes("--fix");
      const focus = tokens.filter((t) => t !== "--fix").join(" ");
      const seed = buildImplSeed(focus, fix);
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[impl] nouvelle session impossible (${(err as Error).message}) — implémentation dans la session courante.`,
            "warning",
          );
        }
      }
      // Armé juste avant l'envoi de l'amorce : la suite (/review, ou /specs si le
      // contrat n'a pas de specs) sera annoncée à la retombée de ce maillon.
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "impl");
      pi.sendUserMessage(seed);
    },
  });

  // --- /review : session de revue ----------------------------------------
  pi.registerCommand("review", {
    description: "Ouvre une session de revue one-shot (contrat de feature + git diff)",
    handler: async (args, ctx) => {
      await sweep(ctx);
      const gate = linkGate(ctx.cwd);
      if (!gate.ok) {
        ctx.ui?.notify?.(`[review] : ${gate.reason}`, "warning");
        return;
      }
      const driving = lotDriverFor(storeDir(), repoRootOf(ctx.cwd), ctx.cwd);
      if (driving) {
        ctx.ui?.notify?.(
          `[review] cette feature est pilotée par le lot ${path.basename(driving.repoRoot)} — ` +
            "pilote-la depuis /pipelines (ou annule-la pour reprendre à la main).",
          "warning",
        );
        return;
      }
      const seed = buildReviewSeed(String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[review] nouvelle session impossible (${(err as Error).message}) — revue dans la session courante.`,
            "warning",
          );
        }
      }
      // Armé juste avant l'envoi de l'amorce : à la retombée, le verdict lu dans
      // `## Revue` décidera entre /impl --fix et la fin de cycle.
      armPipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "review");
      pi.sendUserMessage(seed);
    },
  });

  // --- before_agent_start : directive + détection de « fin » -------------
  pi.on("before_agent_start", async (event, ctx) => {
    const st = stateOfCwd(ctx.cwd);
    if (!st.reqMode) {
      return { systemPrompt: event.systemPrompt };
    }

    const prompt = event.prompt.trim();
    // Nos propres notices ([req] … et [pipeline] …) retraversent ce hook ; ne
    // jamais les traiter comme une entrée utilisateur, sinon le « fin » du message
    // d'accueil (buildWelcome) clôturerait la collecte, et celui d'une notice de
    // fin de maillon (un chemin de worktree peut contenir « fin ») aussi. Défense
    // en profondeur : elles sont déjà postées sans démarrer de tour, mais un echo
    // ou une régression resteraient sûrs.
    if (isPipelineNotice(prompt)) {
      // Une notice n'est pas une entrée de l'utilisateur : jamais de clôture sur
      // son contenu — mais la directive reste due, le mode collecte étant actif.
      return { systemPrompt: [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ] };
    }

    if (saysFin(prompt)) {
      // « fin » dit : le maillon /req peut se clore. C'est la seule clôture que le
      // handler session_stop acceptera d'annoncer pour cette phase — sans elle, la
      // collecte est en cours et l'agent vient simplement de rendre la main.
      st.closing = true;
      // Post the handoff as a display message (NO turn started) to break the notice-posting loop.
      // Keep reqMode = true so before_agent_start keeps filtering notices instead of unfiltering them.
      pi.sendMessage(
        { customType: "req", content: buildReqHandoff(), display: true, attribution: "user" },
        { triggerTurn: false },
      );
      // Le contrat n'est PAS écrit ici : `pi.fs` n'existe pas sur ExtensionAPI
      // (vérifié dans les types OMP : ni fs, ni readFile, ni writeFile), et un
      // dump brut des messages n'est de toute façon pas le contrat attendu —
      // `## Besoins` doit porter des phrases d'action et `## Critères
      // d'acceptation` des Given/When/Then. C'est l'agent, dans ce
      // même tour, qui lit le handoff et écrit le fichier avec son outil write.
      return { systemPrompt: event.systemPrompt };
    }

    // Pas d'accusé de réception par sendUserMessage : il DÉMARRE un tour
    // supplémentaire à chaque message (deux tours par échange, pour rien). La
    // directive suffit à faire répondre l'agent, et la conversation est déjà
    // dans son contexte — inutile de la recopier dans un état local vide.
    return { systemPrompt: [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ] };
  });

  // --- session_stop : fin de maillon, la commande de la suite est annoncée ---
  // OMP n'émet `session_stop` que sur la retombée TERMINALE du fil principal :
  // toutes les retombées non terminales (retry, compaction, todo, job asynchrone)
  // sortent avant par un `willContinue: true`, et une session de sous-agent `task`
  // est écartée par la garde `agentKind` du harness. C'est donc le seul instant où
  // « la phase est finie » est vrai — d'où ce hook, et pas `agent_end`.
  //
  // Le handler ne demande AUCUNE continuation et ne relance AUCUN tour : il poste
  // un message d'affichage et rend `undefined`. C'est la faute qui avait produit
  // la boucle infinie de la v0.4.5 — un `sendUserMessage` d'ici démarre un tour
  // dont la fin redéclenche ce hook. Corps sous try/catch : une annonce ne doit
  // jamais perturber la retombée.
  pi.on("session_stop", async (event, ctx) => {
    try {
      // La retombée d'un SOUS-AGENT (`task`) n'est pas celle du maillon : elle
      // clôturerait l'entrée du run vivant et annoncerait une fin de maillon qui
      // n'a pas eu lieu (le sous-agent partage le cwd de son parent).
      if (isSubagentSession(sessionFileOf(ctx as PipelineCtx))) return;
      // Un run (maillon de lot ou run lancé par le panneau) : il libère son entrée
      // du magasin et n'annonce RIEN — la chaîne appartient au pilote (S-13), et
      // une notice « commande suivante » n'a aucun sens dans une session reprise.
      if (workerMode() || runOnly) {
        // Un maillon de lot n'entre PAS dans l'historique : sa ligne du lot porte
        // déjà son maillon, son état et sa raison d'arrêt, et chaque tour de la
        // boucle /review ⇄ /impl --fix poussait une entrée « terminé » de plus —
        // même pour une revue bloquante ou un run en erreur — dans une section
        // bornée à vingt rangs, chassant les vraies sessions. Un run de
        // CONVERSATION (S-9), lui, EST une session de l'utilisateur : il garde son
        // entrée d'historique, et son issue réelle (un tour en erreur n'est pas
        // « terminé »).
        const failed = (event.last_assistant_message as { stopReason?: string } | undefined)?.stopReason;
        const state = failed === "error" || failed === "aborted" ? "failed" : "done";
        const deps = pipelineDeps(ctx as PipelineCtx);
        try {
          if (workerMode()) deleteRunningEntry(deps.stateDir ?? pipelineStateDir(), runningIdFor(ctx.cwd));
          else closePipeline(deps, ctx.cwd, state);
        } catch (err) {
          reportStateWriteFailure(deps, err);
        }
        return;
      }
      const st = stateOfCwd(ctx.cwd);
      const phase = st.phase;
      // L'agent rend la main : l'état publié bascule sur « attend » (S-4), même
      // quand ce maillon n'a rien à annoncer (retombée d'une collecte en cours).
      publishCurrentCwd(pipelineDeps(ctx as PipelineCtx));
      if (!phase || st.announced) return;
      // /req ne se clôt que sur « fin » : sans elle, la collecte est en cours et
      // l'agent vient simplement de rendre la main.
      if (phase === "req" && !st.closing) return;
      // Marqué AVANT les effets : une annonce qui échoue ne doit pas se rejouer à
      // chaque retombée suivante.
      st.announced = true;

      // Contrat du cwd, `""` s'il est absent ou illisible : lu comme « pas de
      // specs » → /specs, ce qui est le rattrapage voulu et non un échec.
      let contract = "";
      try {
        contract = fs.readFileSync(contractPathFor(ctx.cwd), "utf8");
      } catch {
        /* contrat absent : routage sur chaîne vide */
      }

      // BASCULE VERS LE LOT (S-14) : la collecte d'une feature de lot est close
      // (besoins écrits) — le pilote prend la main sur /specs, et cette session
      // n'annonce plus rien pour elle. La bascule n'a de sens qu'à la CLÔTURE de
      // la collecte : un /specs lancé à la main (autorisé tant qu'aucun lot ne
      // pilote la feature) ne doit pas inscrire la feature au lot et faire
      // relancer un second /specs par le pilote.
      const controller = controllerFor(ctx);
      const handed =
        phase === "req" &&
        handOverCollecte({
          stateDir: storeDir(),
          repoRoot: repoRootOf(ctx.cwd),
          cwd: ctx.cwd,
          contract,
          closing: st.closing === true,
          sessionFile: sessionFileOf(ctx as PipelineCtx),
          notify: notifyDurable,
        });
      if (handed) {
        // Le mode collecte s'ARRÊTE ici : la session de l'utilisateur reste dans
        // le worktree, et une directive de collecte encore active la ferait
        // réécrire `## Besoins` (et reposter le handoff) pendant que le pilote
        // travaille dans le même worktree.
        st.reqMode = false;
        st.closing = false;
        try {
          closePipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "done");
        } catch (err) {
          reportStateWriteFailure(pipelineDeps(ctx as PipelineCtx), err);
        }
        controller.start();
        pi.sendMessage(
          {
            customType: "pipeline",
            content: "[pipeline] la chaîne du lot prend la main — avancement dans /pipelines",
            display: true,
            attribution: "user",
          },
          { triggerTurn: false },
        );
        return;
      }

      const step = nextStepFor(phase, contract);
      pi.sendMessage(
        {
          customType: "pipeline",
          content: buildNextStepNotice(phase, step),
          display: true,
          attribution: "user",
        },
        { triggerTurn: false },
      );
      prefillEditor(ctx, step);

      // Fin de CYCLE (S-6) : le verdict de /review ne laisse aucun bloquant — la
      // pipeline quitte la liste des pipelines en cours et rejoint l'historique en
      // « terminé ». Une revue bloquante la laisse en cours (la suite est
      // /impl --fix), et un verdict illisible n'est jamais un « terminé » par
      // défaut : `nextStepFor` ne rend `cycle-end` que sur un verdict propre.
      if (step.kind === "cycle-end") {
        try {
          closePipeline(pipelineDeps(ctx as PipelineCtx), ctx.cwd, "done");
        } catch (err) {
          // Historique non écrit ⇒ l'entrée en cours reste (aucune perte
          // silencieuse) ; l'échec est signalé au plus une fois par session.
          reportStateWriteFailure(pipelineDeps(ctx as PipelineCtx), err);
        }
      }
    } catch {
      /* une annonce ne doit jamais perturber la fin de maillon */
    }
  });
}

export * from "./audit.ts";
export * from "./chain.ts";
export * from "./contract.ts";
export * from "./git.ts";
export * from "./inbox.ts";
export * from "./lot.ts";
export * from "./lotController.ts";
export * from "./panel.ts";
export * from "./panelHost.ts";
export * from "./panelRows.ts";
export * from "./panelSession.ts";
export * from "./panelView.ts";
export * from "./panelWidth.ts";
export * from "./publish.ts";
export * from "./runs.ts";
export * from "./seeds.ts";
export * from "./state.ts";
export * from "./store.ts";
