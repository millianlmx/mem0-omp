// Le RUN D'UN MAILLON, en process (S-3) : plus aucun `omp -p` enfant pour la
// chaîne — le service ouvre une session, lui donne l'identité du maillon, envoie
// le prompt et rend le MÊME contrat qu'avant (`{code, killed, stdout, stderr}`),
// pour que la chaîne, les jalons et la boucle de correction ne changent pas.
//
// Le contrat d'entrée n'est plus un argv mais une SPÉCIFICATION : un argv décrit
// un process à lancer, et il n'y a plus de process (S-12 §1 interdit d'en
// construire un). Les champs sont ceux que l'ancien argv transportait.
import type { PipelinePhase } from "./contract.ts";
import { closePipeline } from "./publish.ts";
import { forgetMaillonIdentity } from "./serviceSessions.ts";
import type { HostedSession, SessionHost } from "./serviceSessions.ts";


/** Ce qu'un run de maillon rend : la sortie du tour et son issue (contrat figé). */
export type LotRunnerResult = { code: number; killed: boolean; stdout: string; stderr: string };

/** Le maillon à exécuter, décrit sans argv : identité, prompt, session, boîte. */
export type LotRunSpec = {
  lotId: string;
  slug: string;
  phase: PipelinePhase;
  stateDir: string;
  worktree: string;
  prompt: string;
  /** La session à REPRENDRE (réponse à une question, relance) — `null` sinon. */
  sessionFile: string | null;
  /** Le modèle du couple de la phase, ou `null` (défaut OMP). */
  model: string | null;
  /** La boîte du run (S-3) : `null` quand elle n'a pas pu être créée. */
  inbox: string | null;
  /** La borne dure du run (epoch ms) : au-delà, le service `abort` et rend 124. */
  deadline: number | null;
};

export type LotRunnerInput = { spec: LotRunSpec; cwd: string; timeout: number; signal: AbortSignal };

export type LotRunner = (input: LotRunnerInput) => Promise<LotRunnerResult>;

/** Le code d'un run coupé par le budget ou l'échéance (S-3) : `124` + `killed`. */
export const RUN_KILLED_CODE = 124;


/** `true` quand l'échéance est passée : le runner coupe et rend 124. */
function expired(deadline: number | null, now: number): boolean {
  return deadline !== null && Number.isFinite(deadline) && now >= deadline;
}


export type MaillonRunnerDeps = {
  host: SessionHost;
  log?: (line: string) => void;
  now?: () => number;
};

/**
 * Le runner des maillons : une session en process par run, libérée à la fin du
 * tour (S-3). L'identité du maillon est inscrite AVANT le prompt — c'est elle que
 * la branche de session du plugin lit pour publier l'entrée du run, armer sa
 * boîte et appliquer les amorces de phase, sans adopter de lot.
 *
 * L'échéance et le signal coupent le tour par `abort()` : le résultat est alors
 * `{code:124, killed:true}`, exactement ce que la chaîne attend d'un dépassement.
 */
export function createMaillonRunner(deps: MaillonRunnerDeps): LotRunner {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  return async ({ spec, signal }) => {
    let hosted: HostedSession | null = null;
    let killed = false;
    let timer: NodeJS.Timeout | undefined;
    const cut = (reason: string) => {
      if (killed) return;
      killed = true;
      log(`[service] run ${spec.slug}/${spec.phase} coupé : ${reason}`);
      void Promise.resolve(hosted?.session.abort({ reason })).catch(() => {});
    };
    const onSignal = () => cut("budget du run dépassé");
    try {
      hosted = await deps.host.open({
        cwd: spec.worktree,
        purpose: "run",
        resume: spec.sessionFile,
        identity: {
          lotId: spec.lotId,
          slug: spec.slug,
          phase: spec.phase,
          stateDir: spec.stateDir,
          worktree: spec.worktree,
          inbox: spec.inbox,
          deadlineAt: spec.deadline,
        },
        model: spec.model,
        // Un maillon tourne sans personne pour approuver un outil : c'est
        // l'équivalent du `--auto-approve` d'aujourd'hui (runs.ts, S-13).
        autoApprove: true,
      });
      if (signal.aborted) cut("budget du run dépassé");
      signal.addEventListener("abort", onSignal, { once: true });
      // L'échéance est vérifiée à la seconde : un tour qui attend une réponse
      // humaine n'est pas du travail, mais la borne dure reste la borne dure.
      timer = setInterval(() => {
        if (expired(spec.deadline, now())) cut("échéance du run atteinte");
      }, 1000);
      await hosted.session.prompt(spec.prompt);
      await hosted.session.waitForIdle();
      const stdout = hosted.transcript.join("\n\n");
      if (killed) return { code: RUN_KILLED_CODE, killed: true, stdout, stderr: "run interrompu (budget ou échéance)" };
      return { code: 0, killed: false, stdout, stderr: "" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (killed) return { code: RUN_KILLED_CODE, killed: true, stdout: hosted?.transcript.join("\n\n") ?? "", stderr: message };
      return { code: 1, killed: false, stdout: hosted?.transcript.join("\n\n") ?? "", stderr: message };
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", onSignal);
      // L'entrée du run est RETIRÉE à la fin du maillon (S-8) : la session du
      // maillon est libérée juste après, donc plus rien ne la republierait, et
      // l'app verrait une pipeline « en cours » sans run. Le magasin garde
      // l'entrée d'historique du lot, comme pour un maillon terminé.
      try {
        closePipeline({ stateDir: spec.stateDir }, spec.worktree, killed ? "failed" : "done");
      } catch {
        /* une écriture impossible ne doit pas masquer la fin du run */
      }
      if (hosted !== null) {
        forgetMaillonIdentity(hosted.id);
        await hosted.dispose();
      }
    }
  };
}
