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
import { lotContextThresholds } from "./lot.ts";
import type { ContextThresholds } from "./lot.ts";
import { closePipeline } from "./publish.ts";
import { exhaustedUntil, isQuotaFailure, isQuotaMessage, markExhausted, quotaHitFor, quotaStopReason } from "./quota.ts";
import type { QuotaHit } from "./quota.ts";
import { runCompact } from "./serviceRuntime.ts";
import { createContextMeter, forgetMaillonIdentity } from "./serviceSessions.ts";
import { readStore, runningIdFor } from "./store.ts";
import type { PanelPendingAsk } from "./store.ts";
import type { ContextMeter, HostedSession, MaillonIdentity, SessionHost } from "./serviceSessions.ts";


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
  /** Les compactions réussies du run (S-2) ; les deux runners réels le renseignent toujours (0 sans compaction). */
  compactions?: number;
  /** La mesure qui a coupé le run au plafond de contexte (S-4) ; absent pour toute autre issue. */
  contextExceeded?: number;
  /** Le modèle EFFECTIVEMENT utilisé au dernier tour (après replis), `null` quand la session n'en expose pas ; le runner réel le renseigne toujours. */
  model?: string | null;
  /**
   * La question `ask` en vol à la coupure au plafond, relevée AVANT que la clôture
   * du run retire son entrée du magasin : c'est elle qui fait `blocked` le run
   * coupé (S-4). Présente seulement avec `contextExceeded`.
   */
  pendingAsk?: PanelPendingAsk;
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

/** Le motif d'un run dont le dernier tour finit en `stopReason: "error"` sans message d'erreur (S-1). */
export const RUN_TURN_ERROR_WITHOUT_MESSAGE = "dernier tour du run en stopReason error, sans message d'erreur";


/** `true` quand l'échéance est passée : le runner coupe et rend 124. */
function expired(deadline: number | null, now: number): boolean {
  return deadline !== null && Number.isFinite(deadline) && now >= deadline;
}


/** Le sélecteur `provider/id` d'un modèle d'hôte, ou `null`. */
function selectorOf(model: { provider: string; id: string } | undefined): string | null {
  return model ? `${model.provider}/${model.id}` : null;
}


/** La question `ask` publiée par le run du worktree, ou `null` : lue au moment de la coupure, avant la clôture. */
function pendingAskOf(stateDir: string, worktree: string): PanelPendingAsk | null {
  const id = runningIdFor(worktree);
  return readStore(stateDir).running.find(entry => entry.id === id)?.pendingAsk ?? null;
}


/** Le motif exact d'un run coupé au plafond de contexte (S-4) : `n` est la mesure entière brute. */
function contextExceededReason(measure: number): string {
  return `contexte dépassé (${measure} tokens)`;
}


/** Le livrable d'un maillon, par phase : ce que la consigne de compaction et le dernier tour forcé lui rappellent. */
export function phaseDeliverable(phase: PipelinePhase): string {
  switch (phase) {
    case "req":
      return "`## Besoins` et `## Critères d'acceptation`";
    case "specs":
      return "`## Spécifications` et `## Lots`";
    case "impl":
      return "le code et les tests du lot (ou `## Corrections` en --fix)";
    case "review":
      return "`## Revue`";
    case "release":
      return "la PR de la feature";
  }
}


/**
 * La consigne renvoyée à un run après la compaction de fin de tour (S-3) : minimale,
 * sans réinjecter la directive — l'extrait du contrat du prompt initial survit à la
 * compaction, et la directive de phase est déjà dans la session.
 */
export function compactionReminder(deliverable: string): string {
  return `[compaction] Le contexte a été compacté. Reprends à l'étape où tu étais ; livrable attendu : ${deliverable}. L'extrait du contrat de ton prompt initial reste valable.`;
}


/** La consigne du DERNIER tour forcé au plafond HARD : livrer maintenant avec ce qu'on a. */
export function saturatedContextPrompt(deliverable: string): string {
  return `[contexte saturé] Écris MAINTENANT ta section livrable dans le contrat (${deliverable}) avec ce que tu as, puis arrête-toi.`;
}


/** La borne du dernier tour forcé au plafond (5 min) : au-delà, le run est coupé. */
export const CONTEXT_LAST_TURN_MS = 300_000;


/** Un signal « le run est coupé » : une compaction en vol ne retient jamais un run coupé. */
function createCutNotice(): { fire: () => void; promise: Promise<void> } {
  let fire: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    fire = resolve;
  });
  return { fire, promise };
}


/** `auto_compaction_end` d'OMP qui a ABOUTI : ni annulé, ni sauté, avec un résultat. */
function isNativeCompactionEnd(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const e = event as { type?: unknown; aborted?: unknown; skipped?: unknown; result?: unknown };
  return e.type === "auto_compaction_end" && e.aborted !== true && e.skipped !== true && e.result !== undefined && e.result !== null;
}


/**
 * La garde de contexte d'un run hébergé (S-2, S-4). Le franchissement de SOFT ne
 * coupe plus le tour en vol : il est NOTÉ, et la compaction part quand la boucle de
 * prompt reprend la main (`takeSoft` puis `compact`). Au plafond HARD, le run reçoit
 * un DERNIER tour forcé — une consigne injectée dans le tour en cours (`steer`,
 * livrée à la frontière d'outil suivante, sans abort) — borné à
 * {@link CONTEXT_LAST_TURN_MS} ; `overrun` dit quand cette borne est dépassée et
 * rend la mesure à citer. Une compaction échouée est journalisée, non comptée.
 */
function createContextGuard(options: {
  session: HostedSession["session"];
  thresholds: ContextThresholds;
  meter: ContextMeter;
  lastTurnPrompt: string;
  label: string;
  log: (line: string) => void;
  now: () => number;
}): {
  observe: (event: unknown) => void;
  takeSoft: () => number | null;
  /** Compacte la session AU REPOS ; `true` si la compaction a abouti (comptée), `false` si elle a échoué (journalisée). */
  compact: (measure: number) => Promise<boolean>;
  /** La mesure du plafond quand le dernier tour forcé a dépassé sa borne, sinon `null`. */
  overrun: () => number | null;
  lastTurn: () => number | null;
} {
  let softPending: number | null = null;
  let lastTurn: { measure: number; at: number } | null = null;
  return {
    observe(event) {
      // La compaction NATIVE d'OMP (à son propre seuil, entre deux appels du
      // fournisseur) compte comme une compaction du run : même effet, même mesure.
      if (isNativeCompactionEnd(event)) {
        options.meter.compacted();
        options.meter.rearm();
        softPending = null;
        options.log(`${options.label} : contexte compacté par OMP`);
        return;
      }
      const step = options.meter.observe(event);
      if (step === null) return;
      if (step.measure >= options.thresholds.hard) {
        if (lastTurn !== null) return;
        lastTurn = { measure: step.measure, at: options.now() };
        softPending = null;
        options.log(`${options.label} : contexte saturé à ${step.measure}, dernier tour forcé (${CONTEXT_LAST_TURN_MS / 60_000} min)`);
        // Hors du tick de l'abonné : un `steer` qui jette (session en cours d'arrêt) ne doit pas casser la mesure.
        void Promise.resolve()
          .then(() => options.session.steer(options.lastTurnPrompt))
          .catch(err => options.log(`${options.label} : consigne du dernier tour non livrée (${err instanceof Error ? err.message : String(err)})`));
        return;
      }
      if (lastTurn !== null) return;
      // Une mesure retombée sous SOFT (compaction native) rend la compaction différée sans objet.
      if (step.measure > 0 && step.measure < options.thresholds.soft) softPending = null;
      else if (step.verdict === "compact") {
        softPending = step.measure;
        options.log(`${options.label} : seuil SOFT franchi à ${step.measure}, compaction à la fin du tour`);
      }
    },
    takeSoft() {
      const measure = softPending;
      softPending = null;
      return measure;
    },
    async compact(measure) {
      try {
        await runCompact(options.session, { suppressContinuation: true });
        options.meter.compacted();
        // La session est réduite : la mesure suivante est neuve, le palier aussi.
        options.meter.rearm();
        options.log(`${options.label} : contexte compacté à ${measure}`);
        return true;
      } catch (err) {
        options.log(`${options.label} : compaction échouée à ${measure} : ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    },
    overrun: () => (lastTurn !== null && options.now() - lastTurn.at >= CONTEXT_LAST_TURN_MS ? lastTurn.measure : null),
    lastTurn: () => lastTurn?.measure ?? null,
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


/**
 * Le dernier message assistant de la session (S-1). `getLastAssistantMessage()`
 * est la voie d'autorité : elle rend aussi un refus de classifieur élagué du
 * contexte actif, que `session.messages` ne montre plus. Repli par parcours des
 * messages quand l'hôte ne l'expose pas.
 */
function lastAssistantMessage(session: HostedSession["session"]): unknown {
  if (typeof session.getLastAssistantMessage === "function") return session.getLastAssistantMessage();
  const messages: readonly unknown[] = session.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && "role" in message && message.role === "assistant") return message;
  }
  return undefined;
}

/** Le motif d'un tour en erreur : son `errorMessage` sur une ligne, à défaut {@link RUN_TURN_ERROR_WITHOUT_MESSAGE}. */
function turnErrorText(message: object): string {
  const raw = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : "";
  const text = raw.replace(/\s+/g, " ").trim();
  return text === "" ? RUN_TURN_ERROR_WITHOUT_MESSAGE : text;
}


export type MaillonRunnerDeps = {
  host: SessionHost;
  log?: (line: string) => void;
  now?: () => number;
  /** Les variables de seuil de contexte (S-1) ; `process.env` par défaut. */
  env?: Record<string, string | undefined>;
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
    let contextExceeded: number | null = null;
    let pendingAsk: PanelPendingAsk | null = null;
    let timer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    const thresholds = lotContextThresholds(deps.env ?? process.env, spec.phase);
    const meter = createContextMeter(thresholds);
    /** Les mesures communes à tout résultat : pic, compactions, modèle EFFECTIF du dernier tour (après replis). */
    const tally = () => ({ peakContext: meter.peak(), compactions: meter.compactions(), model: hosted ? selectorOf(hosted.session.model) : null });
    const cutNotice = createCutNotice();
    const cut = (reason: string) => {
      if (killed) return;
      killed = true;
      cutNotice.fire();
      log(`[service] run ${spec.slug}/${spec.phase} coupé : ${reason}`);
      void Promise.resolve(hosted?.session.abort({ reason })).catch(() => {});
    };
    /** Le résultat d'un run coupé : l'échéance ou le budget (124), ou le plafond de contexte (même code, motif et mesure). */
    const killedResult = (stdout: string, stderr: string): LotRunnerResult => {
      const base = { code: RUN_KILLED_CODE, killed: true, stdout, ...tally() };
      if (contextExceeded === null) return { ...base, stderr };
      const exceeded = { ...base, stderr: contextExceededReason(contextExceeded), contextExceeded };
      return pendingAsk === null ? exceeded : { ...exceeded, pendingAsk };
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
      ...tally(),
    });
    let turn = 0;
    /** La coupure au plafond : le dernier tour forcé a dépassé sa borne (S-4). */
    const cutSaturated = (measure: number) => {
      contextExceeded = measure;
      pendingAsk = pendingAskOf(spec.stateDir, spec.worktree);
      cut(contextExceededReason(measure));
    };
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
      const label = `[service] run ${spec.slug}/${spec.phase}`;
      const guard = createContextGuard({
        session,
        thresholds,
        meter,
        lastTurnPrompt: saturatedContextPrompt(phaseDeliverable(spec.phase)),
        label,
        log,
        now,
      });
      // Le repli natif d'OMP suspend le modèle quitté : le registre du service le
      // retient pour que ni ce run ni un autre ne le relance avant l'échéance.
      unsubscribe = session.subscribe(event => {
        if (!killed) {
          guard.observe(event);
          const overrun = guard.overrun();
          if (overrun !== null) cutSaturated(overrun);
        }
        if (event.type !== "retry_fallback_applied") return;
        log(`${label} : repli natif ${event.from} → ${event.to} au tour ${turn}`);
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
        const overrun = guard.overrun();
        if (overrun !== null) cutSaturated(overrun);
      }, 1000);
      let text = spec.prompt;
      let quota: QuotaHit | null = null;
      for (let resumes = 0; ; ) {
        turn += 1;
        const before = session.messages.length;
        await session.prompt(text);
        await session.waitForIdle();
        if (killed) break;
        // Le quota se lit AVANT la compaction : elle remplace les messages du tour.
        const hit = quotaOfLastTurn(session, before, now());
        // La compaction différée part ICI, la session au repos : aucun tour n'est
        // interrompu. Après le dernier tour forcé, le run est fini : rien à compacter.
        const soft = guard.takeSoft();
        let compacted = false;
        if (soft !== null && guard.lastTurn() === null) {
          compacted = await Promise.race([guard.compact(soft), cutNotice.promise.then(() => false)]);
          if (killed) break;
        }
        if (hit === null) {
          // Seule une compaction ABOUTIE relance le maillon : un tour fini sans elle
          // n'a rien à reprendre. Ces reprises ne consomment pas celles du quota.
          if (!compacted) break;
          text = compactionReminder(phaseDeliverable(spec.phase));
          continue;
        }
        markExhausted(spec.stateDir, hit);
        const next = resumes < MAX_QUOTA_RESUMES ? alternativeTo(hit.model) : null;
        if (next === null || !(await switchTo(session, next))) {
          quota = hit;
          break;
        }
        resumes += 1;
        log(`${label} : repli vers ${next} au tour ${turn} (quota de ${hit.model})`);
        // Même session, mêmes messages : le modèle repart de ce qu'il a déjà fait.
        text = `[reprise] Le modèle ${hit.model} a atteint son quota : le run continue sur ${next}. Reprends exactement où tu t'es arrêté.`;
      }
      const stdout = hosted.transcript.join("\n\n");
      if (killed) return killedResult(stdout, "run interrompu (budget ou échéance)");
      if (quota !== null) return quotaResult(quota);
      // Le DERNIER tour fait foi : une erreur d'API (hors quota) qui le termine est
      // un échec du run, pas un succès muet. Une erreur plus tôt dans le run, suivie
      // d'un tour qui a abouti, n'en est pas un.
      const last = lastAssistantMessage(session);
      if (last !== null && typeof last === "object" && "stopReason" in last && last.stopReason === "error" && !isQuotaFailure(last)) {
        return { code: 1, killed: false, stdout, stderr: turnErrorText(last), ...tally() };
      }
      return { code: 0, killed: false, stdout, stderr: "", ...tally() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stdout = hosted?.transcript.join("\n\n") ?? "";
      if (killed) return killedResult(stdout, message);
      return { code: 1, killed: false, stdout, stderr: message, ...tally() };
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
  /** Les compactions réussies du run (S-2) ; les deux runners réels le renseignent toujours. */
  compactions?: number;
  /** La mesure qui a coupé l'arbitre au plafond (S-5) ; absent sinon. */
  contextExceeded?: number;
};

export type ArbiterRunner = (input: ArbiterRunInput) => Promise<ArbiterRunResult>;


/** Le livrable de l'arbitre : sa décision, par l'outil `arbiter_decide`. */
export const ARBITER_DELIVERABLE = "ta décision, par l'outil `arbiter_decide`";

/**
 * Le lanceur d'arbitre (S-9) : une session NEUVE par élément, jamais reprise, ni
 * publiée, ni historisée, ni armée d'une boîte. Le tour est borné par l'échéance et
 * le signal ; un quota constaté est inscrit au registre (S-4) et le run rend alors
 * sans décision — le contrôleur escalade. Le contexte est mesuré à chaque
 * `message_end` : SOFT franchi ⇒ compaction à la fin du tour, puis reprise ; HARD
 * atteint ⇒ un dernier tour forcé pour décider, coupé s'il dépasse sa borne.
 */
export function createArbiterRunner(deps: {
  host: SessionHost;
  log?: (line: string) => void;
  now?: () => number;
  env?: Record<string, string | undefined>;
}): ArbiterRunner {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  return async ({ stateDir, cwd, prompt, model, fallback, deadline, signal }) => {
    const startedAt = now();
    const capture: ArbiterCapture = { decision: null };
    const thresholds = lotContextThresholds(deps.env ?? process.env);
    const meter = createContextMeter(thresholds);
    let hosted: HostedSession | null = null;
    let timer: NodeJS.Timeout | undefined;
    let killed = false;
    let contextExceeded: number | null = null;
    const cutNotice = createCutNotice();
    const cut = (reason: string) => {
      if (killed) return;
      killed = true;
      cutNotice.fire();
      log(`[service] arbitre coupé : ${reason}`);
      void Promise.resolve(hosted?.session.abort({ reason })).catch(() => {});
    };
    const onSignal = () => cut("arbitrage annulé");
    try {
      hosted = await deps.host.open({ cwd, purpose: "arbiter", model, fallback, autoApprove: true, arbiter: capture });
      const session = hosted.session;
      if (signal.aborted) cut("arbitrage annulé");
      signal.addEventListener("abort", onSignal, { once: true });
      const guard = createContextGuard({
        session,
        thresholds,
        meter,
        lastTurnPrompt: `[contexte saturé] Rends MAINTENANT ${ARBITER_DELIVERABLE}, avec ce que tu as, puis arrête-toi.`,
        label: "[service] arbitre",
        log,
        now,
      });
      const cutSaturated = (measure: number) => {
        contextExceeded = measure;
        cut(contextExceededReason(measure));
      };
      const unsubscribe = session.subscribe(event => {
        if (killed) return;
        guard.observe(event);
        const overrun = guard.overrun();
        if (overrun !== null) cutSaturated(overrun);
      });
      timer = setInterval(() => {
        if (expired(deadline, now())) cut("échéance de l'arbitre atteinte");
        const overrun = guard.overrun();
        if (overrun !== null) cutSaturated(overrun);
      }, 1000);
      try {
        let text = prompt;
        for (;;) {
          const before = session.messages.length;
          await session.prompt(text);
          await session.waitForIdle();
          if (killed) break;
          // Lu AVANT la compaction, qui remplace les messages du tour.
          const hit = quotaOfLastTurn(session, before, now());
          if (hit !== null) markExhausted(stateDir, hit);
          const soft = guard.takeSoft();
          if (hit !== null || soft === null || guard.lastTurn() !== null) break;
          const compacted = await Promise.race([guard.compact(soft), cutNotice.promise.then(() => false)]);
          if (killed || !compacted) break;
          text = compactionReminder(ARBITER_DELIVERABLE);
        }
      } finally {
        unsubscribe();
      }
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
      peakContext: meter.peak(),
      compactions: meter.compactions(),
    };
    if (contextExceeded !== null) result.contextExceeded = contextExceeded;
    if (hosted !== null) await hosted.dispose();
    return result;
  };
}
