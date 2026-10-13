// Les AUDITS DE L'APP côté service (S-1 à S-4) : démarrer une analyse, lancer
// les propositions cochées, répondre aux escalades, arrêter un audit, et suivre
// l'avancement à chaque balayage.
//
// Le service est le SEUL écrivain de `<stateDir>/audits/<id>.json` (DV-1) ; toute
// transition passe par `transitionAudit`. Le relais `/audit` du terminal n'est ni
// armé ni lu : les features lancées portent la clé de l'audit dans
// `auditSession`, et c'est le contrôleur du SERVICE qui les ajoute — celui qui a
// l'arbitre (S-2, AC-5).
import * as crypto from "node:crypto";
import { auditRepoRootOf, enrolElements } from "./audit.ts";
import { AUDIT_BRIEF_SECTIONS, AUDIT_VERSION, auditKeyOf, listAudits, newAuditId, readAudit, transitionAudit, writeAudit } from "./auditRecord.ts";
import type { AuditLaunchOutcome, AuditRecord, AuditStatus } from "./auditRecord.ts";
import type { PipelineCommand } from "./commands.ts";
import { briefRubricsMissing, writeBrief } from "./context.ts";
import { realpathOr } from "./git.ts";
import { lotFeature, lotRepoKey, readLot } from "./lot.ts";
import type { LotFeature } from "./lot.ts";
import { buildAppAuditSeed } from "./seeds.ts";
import { badRequest, conflict, notFound } from "./serviceApi.ts";
import type { AuditAnswerResult, AuditLaunchResult, AuditStartResult, AuditStopResult, ServiceFrame } from "./serviceApi.ts";
import type { ServicePilot } from "./servicePilot.ts";
import { requireRepo } from "./servicePilot.ts";
import type { HostedSession, SessionHost } from "./serviceSessions.ts";


/** Borne de l'orientation, une fois rognée (S-1). */
export const AUDIT_ORIENTATION_MAX = 2000;

/** Les textes d'échec d'une analyse (S-1). */
export const AUDIT_FAILURE_COMPLETED = "l'analyse s'est terminée sans appeler audit_report";
export const AUDIT_FAILURE_ABORTED = "l'analyse a été interrompue";
export const AUDIT_FAILURE_RESTART = "l'analyse a été interrompue par l'arrêt du service OMP";

export function auditFailureOfError(message: string | null): string {
  return `l'analyse a échoué : ${message ?? "cause inconnue"}`;
}


export type AuditServiceDeps = {
  stateDir: string;
  host: SessionHost;
  /** Le pilotage du service : son contrôleur par dépôt (avec l'arbitre) et ses commandes. */
  pilot: Pick<ServicePilot, "controllerFor" | "command">;
  log?: (line: string) => void;
  now?: () => number;
};

export interface AuditService {
  /** `POST /v1/audits` (S-1). */
  start: (body: unknown) => Promise<AuditStartResult>;
  /** `POST /v1/audits/{id}/launch` (S-2). */
  launch: (id: string, body: unknown) => Promise<AuditLaunchResult>;
  /** `POST /v1/audits/{id}/escalations` (S-3). */
  answer: (id: string, body: unknown) => Promise<AuditAnswerResult>;
  /** `DELETE /v1/audits/{id}` (S-4). */
  stop: (id: string) => Promise<AuditStopResult>;
  /**
   * Une passe du balayage du service : au PREMIER seulement, les analyses
   * interrompues par l'arrêt du service passent en échec ; puis le suivi des
   * features lancées (S-1, S-2).
   */
  sweep: (first: boolean) => void;
}


/** Un corps JSON objet, sinon `{}` : un champ absent est refusé par son propre motif. */
function fieldsOf(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}


/** La sorte d'une escalade : le préfixe de sa clé avant le premier `:` (S-3). */
function escalationKindOf(key: string): "ask" | "question" | "specs" | "review" | null {
  const at = key.indexOf(":");
  const kind = at < 0 ? key : key.slice(0, at);
  return kind === "ask" || kind === "question" || kind === "specs" || kind === "review" ? kind : null;
}


/** Le dernier état connu d'une feature, recopié dans `launches` (S-2 « suivi »). */
function progressOf(feature: LotFeature | undefined): Pick<AuditLaunchOutcome, "state" | "phase" | "prUrl"> {
  if (feature === undefined) return { state: null, phase: null, prUrl: null };
  return { state: feature.state, phase: feature.phase, prUrl: feature.prUrl };
}


export function createAuditService(deps: AuditServiceDeps): AuditService {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const stateDir = deps.stateDir;
  /** Les sessions d'analyse vivantes, par audit : ce que l'arrêt coupe (S-4). */
  const live = new Map<string, { hosted: HostedSession; off: () => void }>();
  /**
   * Les lancements en vol, par audit : un second appel concurrent ne double pas
   * les features, et un arrêt attend leur fin avant de lire le lot (S-4).
   */
  const launching = new Map<string, Promise<unknown>>();
  /** Les arrêts en vol : un lancement qui tombe pendant l'un d'eux est refusé. */
  const stopping = new Set<string>();

  /** Écrit l'audit passé à `to`, avec les champs donnés ; une transition refusée n'écrit rien. */
  function moveAudit(audit: AuditRecord, to: AuditStatus, fields: Partial<AuditRecord> = {}): AuditRecord | null {
    const moved = transitionAudit(audit, to, now());
    if (!moved.ok) {
      log(`[service] audit ${audit.id} : ${moved.error}`);
      return null;
    }
    const next = { ...moved.audit, ...fields };
    writeAudit(stateDir, next);
    return next;
  }

  function requireAudit(id: string): AuditRecord {
    const audit = readAudit(stateDir, id);
    if (audit === null) throw notFound(`audit inconnu : ${id}`);
    return audit;
  }

  /** Une commande de pipeline du service, sous l'enveloppe du canal (S-3, S-4). */
  async function sendCommand(audit: AuditRecord, command: Record<string, unknown>) {
    const body = {
      version: 1,
      id: `audit-${audit.id}-${crypto.randomBytes(6).toString("hex")}`,
      sentAt: now(),
      repo: audit.repoRoot,
      ...command,
    } as unknown as PipelineCommand;
    return (await deps.pilot.command(audit.repoRoot, body)).ack;
  }

  /**
   * La fin de l'analyse (S-1) : au `prompt_end`, quel que soit son statut, ou à
   * la mort de la session. Un audit encore `analysing` passe `failed` avec son
   * motif ; la session est toujours libérée.
   */
  async function endAnalysis(auditId: string, failure: string): Promise<void> {
    const entry = live.get(auditId);
    if (entry === undefined) return;
    live.delete(auditId);
    entry.off();
    const audit = readAudit(stateDir, auditId);
    if (audit !== null && audit.status === "analysing") moveAudit(audit, "failed", { failure });
    try {
      await entry.hosted.dispose();
    } catch (err) {
      log(`[service] libération de l'analyse ${auditId} en échec : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Suivi (S-2) : recopie `state`, `phase`, `prUrl` des features lancées, seulement s'ils changent. */
  function followLaunches(audit: AuditRecord): void {
    if (audit.status !== "launched" && audit.status !== "stopped") return;
    const lot = readLot(stateDir, audit.repoKey);
    if (lot === null) return;
    let changed = false;
    const launches = audit.launches.map(entry => {
      if (!entry.launched) return entry;
      const feature = lotFeature(lot, entry.slug);
      if (feature === undefined || feature.auditSession !== audit.key) return entry;
      const progress = progressOf(feature);
      if (progress.state === entry.state && progress.phase === entry.phase && progress.prUrl === entry.prUrl) return entry;
      changed = true;
      return { ...entry, ...progress };
    });
    if (changed) writeAudit(stateDir, { ...audit, launches, updatedAt: now() });
  }

  return {
    async start(body) {
      const fields = fieldsOf(body);
      if (typeof fields.repo !== "string" || fields.repo === "") throw badRequest("champ « repo » manquant");
      if (typeof fields.orientation !== "string") throw badRequest("champ « orientation » manquant");
      const orientation = fields.orientation.trim();
      if (orientation === "") throw badRequest("orientation vide");
      if ([...orientation].length > AUDIT_ORIENTATION_MAX) {
        throw badRequest(`orientation trop longue (max ${AUDIT_ORIENTATION_MAX} caractères)`);
      }
      const resolved = auditRepoRootOf(requireRepo(fields.repo));
      if (!resolved.ok) throw conflict(resolved.refusal);
      const repoRoot = realpathOr(resolved.repoRoot);
      const id = newAuditId();
      const at = now();
      const audit: AuditRecord = {
        version: AUDIT_VERSION,
        id,
        repoRoot,
        repoKey: lotRepoKey(repoRoot),
        key: auditKeyOf(stateDir, id),
        orientation,
        status: "analysing",
        createdAt: at,
        updatedAt: at,
        proposal: null,
        launches: [],
        failure: null,
      };
      // 1. L'enregistrement AVANT la session : l'outil `audit_report` le lit.
      writeAudit(stateDir, audit);
      // 2. La session d'analyse, invisible de l'API et inscrite au registre.
      let hosted: HostedSession;
      try {
        hosted = await deps.host.open({ cwd: repoRoot, purpose: "audit", audit: { auditId: id, stateDir } });
      } catch (err) {
        moveAudit(audit, "failed", { failure: auditFailureOfError(err instanceof Error ? err.message : String(err)) });
        throw err;
      }
      let lastError: string | null = null;
      const subscription = deps.host.subscribe(hosted.id);
      const off =
        subscription?.subscribe((frame: ServiceFrame) => {
          if (frame.event === "notice" && frame.data.level === "error") {
            lastError = frame.data.message;
            return;
          }
          if (frame.event !== "prompt_end") return;
          const status = frame.data.status;
          void endAnalysis(
            id,
            status === "completed" ? AUDIT_FAILURE_COMPLETED : status === "aborted" ? AUDIT_FAILURE_ABORTED : auditFailureOfError(lastError),
          );
        }) ?? (() => {});
      live.set(id, { hosted, off });
      // La mort de la session sans `prompt_end` (arrêt de son runner) est une interruption.
      void hosted.disposed.then(() => endAnalysis(id, AUDIT_FAILURE_ABORTED));
      // 3. L'amorce : la réponse n'attend pas la fin de l'analyse.
      try {
        await deps.host.prompt(hosted.id, { text: buildAppAuditSeed(repoRoot, orientation) });
      } catch (err) {
        await endAnalysis(id, auditFailureOfError(err instanceof Error ? err.message : String(err)));
      }
      log(`[service] audit ${id} ouvert pour ${repoRoot} (session ${hosted.id})`);
      return { id, status: "analysing" };
    },

    async launch(id, body) {
      const audit = requireAudit(id);
      if (audit.status !== "proposed" || launching.has(id) || stopping.has(id)) {
        throw conflict(`l'audit n'attend pas de validation (état : ${audit.status})`);
      }
      const fields = fieldsOf(body);
      const raw = fields.selected;
      if (!Array.isArray(raw) || raw.some(entry => typeof entry !== "string")) {
        throw badRequest("champ « selected » : liste de noms attendue");
      }
      const selected = [...new Set(raw as string[])];
      if (selected.length === 0) throw badRequest("sélection vide : cochez au moins une proposition");
      const elements = audit.proposal?.elements ?? [];
      const unknown = selected.find(slug => !elements.some(element => element.slug === slug));
      if (unknown !== undefined) throw badRequest(`proposition inconnue : ${unknown}`);
      if (typeof fields.brief !== "string") throw badRequest("champ « brief » manquant");
      const brief = fields.brief;
      const missing = briefRubricsMissing(brief, AUDIT_BRIEF_SECTIONS);
      if (missing !== null) throw badRequest(`brief incomplet : rubrique « ${missing} » absente`);

      const run = (async () => {
        writeBrief(stateDir, audit.key, brief);
        const controller = deps.pilot.controllerFor(audit.repoRoot);
        const outcomes = await enrolElements({
          add: feature => controller.add(feature),
          lotOf: () => readLot(stateDir, audit.repoKey),
          contextKey: audit.key,
          elements: elements
            .filter(element => selected.includes(element.slug))
            .map(element => ({ slug: element.slug, intention: element.intention, deps: element.deps })),
        });
        const lot = readLot(stateDir, audit.repoKey);
        const launches: AuditLaunchOutcome[] = outcomes.map(outcome =>
          outcome.launched
            ? { slug: outcome.slug, launched: true, reason: null, ...progressOf(lot === null ? undefined : lotFeature(lot, outcome.slug)) }
            : { slug: outcome.slug, launched: false, reason: outcome.reason, state: null, phase: null, prUrl: null },
        );
        const current = readAudit(stateDir, id) ?? audit;
        if (current.status === "proposed" && launches.some(entry => entry.launched)) {
          moveAudit(current, "launched", { launches });
        } else {
          writeAudit(stateDir, { ...current, launches, updatedAt: now() });
        }
        return { launches };
      })();
      launching.set(id, run);
      try {
        return await run;
      } finally {
        launching.delete(id);
      }
    },

    async answer(id, body) {
      const audit = requireAudit(id);
      const fields = fieldsOf(body);
      const slug = fields.slug;
      const lot = readLot(stateDir, audit.repoKey);
      const feature = typeof slug === "string" && lot !== null ? lotFeature(lot, slug) : undefined;
      if (feature === undefined || feature.auditSession !== audit.key) {
        throw notFound(`feature inconnue dans cet audit : ${String(slug)}`);
      }
      const key = fields.key;
      const kind = typeof key === "string" ? escalationKindOf(key) : null;
      if (typeof key !== "string" || feature.escalation?.key !== key || kind === null) {
        throw conflict("question déjà répondue ou périmée");
      }
      const escalation = feature.escalation;
      let command: Record<string, unknown>;
      if (kind === "ask" || kind === "question") {
        const answer = fields.answer;
        if (typeof answer !== "string" || answer.trim() === "") throw badRequest("réponse vide");
        if (fields.decision !== undefined) throw badRequest("une question attend une réponse, pas une décision");
        command =
          kind === "ask"
            ? {
                kind: "answer",
                slug: feature.slug,
                toolCallId: key.slice(`ask:${feature.slug}:`.length),
                ...(escalation.options.includes(answer) ? { selected: answer } : { custom: answer }),
              }
            : { kind: "reply", slug: feature.slug, text: answer };
      } else {
        const decision = fields.decision;
        if (decision !== "approve" && decision !== "abandon") throw badRequest("décision attendue : approve ou abandon");
        command =
          decision === "abandon"
            ? { kind: "cancel", slug: feature.slug, fate: "keep" }
            : { kind: "verdict", slug: feature.slug, verdict: kind === "specs" ? "v" : "y" };
      }
      const ack = await sendCommand(audit, command);
      if (ack.state === "refused") throw conflict(ack.reason ?? "commande refusée");
      return { accepted: true };
    },

    async stop(id) {
      const audit = requireAudit(id);
      if (audit.status === "stopped") throw conflict("audit déjà arrêté");
      stopping.add(id);
      try {
        // 0. Un lancement en vol finit d'abord : ses features sont alors toutes au lot.
        await launching.get(id)?.catch(() => {});
        // 1. L'analyse vivante : abort puis dispose, sans motif d'échec (l'audit s'arrête).
        const entry = live.get(id);
        if (entry !== undefined) {
          live.delete(id);
          entry.off();
          try {
            await deps.host.abort(entry.hosted.id);
          } catch (err) {
            log(`[service] abort de l'analyse ${id} en échec : ${err instanceof Error ? err.message : String(err)}`);
          }
          await entry.hosted.dispose();
        }
        // 2-3. Les features de CET audit : annulées en gardant dossier et branche ; les livrées restent.
        const result: AuditStopResult = { cancelled: [], kept: [], refused: [] };
        const lot = readLot(stateDir, audit.repoKey);
        for (const feature of lot?.features ?? []) {
          if (feature.auditSession !== audit.key) continue;
          if (feature.state === "done") {
            result.kept.push(feature.slug);
            continue;
          }
          if (feature.state === "cancelled") continue;
          const ack = await sendCommand(audit, { kind: "cancel", slug: feature.slug, fate: "keep" });
          if (ack.state === "taken") result.cancelled.push(feature.slug);
          else result.refused.push({ slug: feature.slug, reason: ack.reason ?? "commande refusée" });
        }
        // 4. L'audit arrêté, relu : la fin d'analyse ou le lancement attendu a pu l'écrire.
        const current = readAudit(stateDir, id) ?? audit;
        moveAudit(current, "stopped");
        log(`[service] audit ${id} arrêté`);
        return result;
      } finally {
        stopping.delete(id);
      }
    },

    sweep(first) {
      for (const audit of listAudits(stateDir)) {
        try {
          if (first && audit.status === "analysing" && !live.has(audit.id)) {
            moveAudit(audit, "failed", { failure: AUDIT_FAILURE_RESTART });
            continue;
          }
          followLaunches(audit);
        } catch (err) {
          log(`[service] suivi de l'audit ${audit.id} en échec : ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
