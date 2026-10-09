// Le RUN D'UN MAILLON, en process (S-3) : plus aucun `omp -p` enfant pour la
// chaîne — le service ouvre une session, lui donne l'identité du maillon, envoie
// le prompt et rend le MÊME contrat qu'avant (`{code, killed, stdout, stderr}`),
// pour que la chaîne, les jalons et la boucle de correction ne changent pas.
//
// Le contrat d'entrée n'est plus un argv mais une SPÉCIFICATION : un argv décrit
// un process à lancer, et il n'y a plus de process (S-12 §1 interdit d'en
// construire un). Les champs sont ceux que l'ancien argv transportait.
//
// Un run tourne sur le modèle principal P et le repli R CHOISIS PAR L'UTILISATEUR,
// et aucun autre : le repli se fait dans la MÊME session (chaîne native d'OMP, puis
// rattrapage ici quand OMP ne bascule pas), et un quota épuisé des deux côtés est
// rendu tel quel au contrôleur, jamais déguisé en échec.
import type { ArbiterCapture, ArbiterDecision } from "./arbiter.ts";
import type { PipelinePhase } from "./contract.ts";
import { closePipeline } from "./publish.ts";
import { exhaustedUntil, isQuotaFailure, isQuotaMessage, markExhausted, quotaHitFor, quotaStopReason } from "./quota.ts";
import type { QuotaHit } from "./quota.ts";
import { forgetMaillonIdentity } from "./serviceSessions.ts";
import type { HostedSession, MaillonIdentity, SessionHost } from "./serviceSessions.ts";


/**
 * Ce qu'un run de maillon rend : la sortie du tour et son issue (contrat figé).
 * `quota` : le run s'est arrêté faute de modèle disponible (S-2) — le contrôleur
 * bloque alors la feature au lieu de la marquer échouée. `peakContext` : le pic de
 * contexte du run (S-12), `null` quand il n'a pas pu être mesuré.
 */
export type LotRunnerResult = {
  code: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  quota?: QuotaHit;
  peakContext?: number | null;
};

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
  /**
   * Le modèle de DÉPART du run, choisi par la garde de quota (S-4) : le principal,
   * ou le repli quand le principal est épuisé ; `null` = défaut OMP.
   */
  model: string | null;
  /** Le modèle principal du groupe de la phase (P), `null` = défaut OMP. */
  primary: string | null;
  /** Le repli du groupe de la phase (R), `null` = aucun repli. */
  fallback: string | null;
  /** La boîte du run (S-3) : `null` quand elle n'a pas pu être créée. */
  inbox: string | null;
  /** La borne dure du run (epoch ms) : au-delà, le service `abort` et rend 124. */
  deadline: number | null;
};

export type LotRunnerInput = { spec: LotRunSpec; cwd: string; timeout: number; signal: AbortSignal };

export type LotRunner = (input: LotRunnerInput) => Promise<LotRunnerResult>;

/** Le code d'un run coupé par le budget ou l'échéance (S-3) : `124` + `killed`. */
export const RUN_KILLED_CODE = 124;

/** Le nombre maximal de reprises sur l'autre modèle après un quota, par run (S-2). */
export const MAX_QUOTA_RESUMES = 3;


/** `true` quand l'échéance est passée : le runner coupe et rend 124. */
function expired(deadline: number | null, now: number): boolean {
  return deadline !== null && Number.isFinite(deadline) && now >= deadline;
}


/** Le sélecteur `provider/id` d'un modèle d'hôte, ou `null`. */
function selectorOf(model: { provider: string; id: string } | undefined): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}


/**
 * Le suivi du pic de contexte d'un run (S-12) : à chaque fin de message assistant
 * portant `usage`, le contexte du tour est `input + cacheRead + cacheWrite` (Doc-4) ;
 * le pic est le maximum, `null` sans aucun usage. Aucune coupure n'en dépend.
 */
function createPeakTracker(): { observe: (event: unknown) => void; peak: () => number | null } {
  let peak: number | null = null;
  const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    observe(event) {
      if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "message_end") return;
      const message = (event as { message?: unknown }).message;
      if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return;
      const usage = (message as { usage?: unknown }).usage;
      if (!usage || typeof usage !== "object") return;
      const fields = usage as Record<string, unknown>;
      const turn = count(fields.input) + count(fields.cacheRead) + count(fields.cacheWrite);
      if (peak === null || turn > peak) peak = turn;
    },
    peak: () => peak,
  };
}


/**
 * Le quota qui a arrêté le DERNIER tour assistant du prompt (S-2), ou `null`.
 * Le modèle fautif est celui du message en erreur — pas celui que le runner croit
 * actif —, et l'échéance se lit dans son `errorMessage`.
 */
function quotaOfLastTurn(session: HostedSession["session"], since: number, at: number): QuotaHit | null {
  const messages: readonly unknown[] = session.messages;
  // Seuls les messages de CE prompt comptent : une session reprise garde l'erreur
  // du run précédent, qui n'est pas celle de celui-ci.
  for (let index = messages.length - 1; index >= since; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
    if (!isQuotaFailure(message)) return null;
    const provider = "provider" in message && typeof message.provider === "string" ? message.provider : "";
    const model = "model" in message && typeof message.model === "string" ? message.model : "";
    const reason = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : "";
    if (provider === "" || model === "") return null;
    return quotaHitFor(`${provider}/${model}`, reason, at);
  }
  return null;
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
    let unsubscribe: (() => void) | undefined;
    const peaks = createPeakTracker();
    const cut = (reason: string) => {
      if (killed) return;
      killed = true;
      log(`[service] run ${spec.slug}/${spec.phase} coupé : ${reason}`);
      void Promise.resolve(hosted?.session.abort({ reason })).catch(() => {});
    };
    const onSignal = () => cut("budget du run dépassé");
    // Un seul objet d'identité : le service y inscrit le P EFFECTIF (S-2) quand
    // le principal est « défaut OMP », et le crochet de retour au principal (S-3)
    // le relit à chaque résultat d'outil.
    const identity: MaillonIdentity = {
      lotId: spec.lotId,
      slug: spec.slug,
      phase: spec.phase,
      stateDir: spec.stateDir,
      worktree: spec.worktree,
      inbox: spec.inbox,
      deadlineAt: spec.deadline,
      primary: spec.primary,
      fallback: spec.fallback,
    };
    const exhausted = (selector: string): QuotaHit | null => exhaustedUntil(spec.stateDir, selector, now());
    /** L'AUTRE modèle de {P effectif, R} que `current` — présent et non épuisé —, ou `null`. */
    const alternativeTo = (current: string): string | null => {
      for (const candidate of [identity.primary, identity.fallback]) {
        if (candidate !== null && candidate !== current && exhausted(candidate) === null) return candidate;
      }
      return null;
    };
    /** Bascule la session sur `selector` (jamais persistée : `setModel` sans `persist`). */
    const switchTo = async (session: HostedSession["session"], selector: string): Promise<boolean> => {
      const slash = selector.indexOf("/");
      const model = slash < 0 ? undefined : session.modelRegistry.find(selector.slice(0, slash), selector.slice(slash + 1));
      if (!model) {
        log(`[service] run ${spec.slug}/${spec.phase} : modèle inconnu ${selector}`);
        return false;
      }
      try {
        await session.setModel(model);
        return true;
      } catch (err) {
        log(`[service] run ${spec.slug}/${spec.phase} : ${selector} inutilisable (${err instanceof Error ? err.message : String(err)})`);
        return false;
      }
    };
    const quotaResult = (hit: QuotaHit): LotRunnerResult => ({
      code: 1,
      killed: false,
      stdout: hosted?.transcript.join("\n\n") ?? "",
      stderr: quotaStopReason(hit),
      quota: hit,
    });
    try {
      hosted = await deps.host.open({
        cwd: spec.worktree,
        purpose: "run",
        resume: spec.sessionFile,
        identity,
        model: spec.model,
        fallback: spec.fallback,
        // Un maillon tourne sans personne pour approuver un outil : c'est
        // l'équivalent du `--auto-approve` d'aujourd'hui (runs.ts, S-13).
        autoApprove: true,
      });
      const session = hosted.session;
      // Le repli natif d'OMP suspend le modèle quitté : le registre du service le
      // retient pour que ni ce run ni un autre ne le relance avant l'échéance.
      unsubscribe = session.subscribe(event => {
        peaks.observe(event);
        if (event.type !== "retry_fallback_applied") return;
        const reason = event.reason ?? "";
        if (!isQuotaMessage(reason)) return;
        markExhausted(spec.stateDir, quotaHitFor(event.from, reason, now()));
      });
      // Quand P est « défaut OMP », le P effectif est le modèle que la session a
      // résolu : c'est lui que la garde et le retour au principal visent.
      const resolved = selectorOf(session.model);
      if (identity.primary === null) identity.primary = resolved;
      if (resolved !== null) {
        const blockedStart = exhausted(resolved);
        if (blockedStart !== null) {
          const alternative = alternativeTo(resolved);
          // Aucun prompt n'est envoyé à un modèle épuisé (S-4).
          if (alternative === null || !(await switchTo(session, alternative))) return quotaResult(blockedStart);
        }
      }
      if (signal.aborted) cut("budget du run dépassé");
      signal.addEventListener("abort", onSignal, { once: true });
      // L'échéance est vérifiée à la seconde : un tour qui attend une réponse
      // humaine n'est pas du travail, mais la borne dure reste la borne dure.
      timer = setInterval(() => {
        if (expired(spec.deadline, now())) cut("échéance du run atteinte");
      }, 1000);
      let text = spec.prompt;
      let quota: QuotaHit | null = null;
      for (let resumes = 0; ; resumes += 1) {
        const before = session.messages.length;
        await session.prompt(text);
        await session.waitForIdle();
        if (killed) break;
        const hit = quotaOfLastTurn(session, before, now());
        if (hit === null) break;
        markExhausted(spec.stateDir, hit);
        const next = resumes < MAX_QUOTA_RESUMES ? alternativeTo(hit.model) : null;
        if (next === null || !(await switchTo(session, next))) {
          quota = hit;
          break;
        }
        // Même session, mêmes messages : le modèle repart de ce qu'il a déjà fait.
        text = `[reprise] Le modèle ${hit.model} a atteint son quota : le run continue sur ${next}. Reprends exactement où tu t'es arrêté.`;
      }
      const stdout = hosted.transcript.join("\n\n");
      if (killed) return { code: RUN_KILLED_CODE, killed: true, stdout, stderr: "run interrompu (budget ou échéance)", peakContext: peaks.peak() };
      if (quota !== null) return { ...quotaResult(quota), peakContext: peaks.peak() };
      return { code: 0, killed: false, stdout, stderr: "", peakContext: peaks.peak() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (killed) return { code: RUN_KILLED_CODE, killed: true, stdout: hosted?.transcript.join("\n\n") ?? "", stderr: message, peakContext: peaks.peak() };
      return { code: 1, killed: false, stdout: hosted?.transcript.join("\n\n") ?? "", stderr: message, peakContext: peaks.peak() };
    } finally {
      clearInterval(timer);
      unsubscribe?.();
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


// --- le run d'ARBITRE (S-9) --------------------------------------------------

/** Ce que le contrôleur demande à l'arbitre : un prompt, un dossier, les modèles du groupe, une borne. */
export type ArbiterRunInput = {
  stateDir: string;
  cwd: string;
  prompt: string;
  /** Le modèle de départ choisi par la garde de quota (S-4) ; `null` = défaut OMP. */
  model: string | null;
  fallback: string | null;
  deadline: number;
  signal: AbortSignal;
};

/** Ce qu'un run d'arbitre rend : la décision retenue (ou `null`) et la session qui l'a produite. */
export type ArbiterRunResult = {
  decision: ArbiterDecision | null;
  sessionId: string | null;
  sessionFile: string | null;
  startedAt: number;
  endedAt: number;
  peakContext?: number | null;
};

export type ArbiterRunner = (input: ArbiterRunInput) => Promise<ArbiterRunResult>;


/**
 * Le lanceur d'arbitre (S-9) : une session NEUVE par élément, jamais reprise, ni
 * publiée, ni historisée, ni armée d'une boîte. Le tour est borné par l'échéance et
 * le signal ; un quota constaté est inscrit au registre (S-4) et le run rend alors
 * sans décision — le contrôleur escalade.
 */
export function createArbiterRunner(deps: { host: SessionHost; log?: (line: string) => void; now?: () => number }): ArbiterRunner {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  return async ({ stateDir, cwd, prompt, model, fallback, deadline, signal }) => {
    const startedAt = now();
    const capture: ArbiterCapture = { decision: null };
    const peaks = createPeakTracker();
    let hosted: HostedSession | null = null;
    let timer: NodeJS.Timeout | undefined;
    const cut = (reason: string) => {
      log(`[service] arbitre coupé : ${reason}`);
      void Promise.resolve(hosted?.session.abort({ reason })).catch(() => {});
    };
    const onSignal = () => cut("arbitrage annulé");
    try {
      hosted = await deps.host.open({ cwd, purpose: "arbiter", model, fallback, autoApprove: true, arbiter: capture });
      if (signal.aborted) cut("arbitrage annulé");
      signal.addEventListener("abort", onSignal, { once: true });
      timer = setInterval(() => {
        if (expired(deadline, now())) cut("échéance de l'arbitre atteinte");
      }, 1000);
      const before = hosted.session.messages.length;
      const unsubscribe = hosted.session.subscribe(event => peaks.observe(event));
      try {
        await hosted.session.prompt(prompt);
        await hosted.session.waitForIdle();
      } finally {
        unsubscribe();
      }
      const hit = quotaOfLastTurn(hosted.session, before, now());
      if (hit !== null) markExhausted(stateDir, hit);
    } catch (err) {
      log(`[service] arbitre en échec : ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearInterval(timer);
      signal.removeEventListener("abort", onSignal);
    }
    const result: ArbiterRunResult = {
      decision: capture.decision,
      sessionId: hosted?.id ?? null,
      sessionFile: hosted?.sessionFile ?? null,
      startedAt,
      endedAt: now(),
      peakContext: peaks.peak(),
    };
    if (hosted !== null) await hosted.dispose();
    return result;
  };
}
