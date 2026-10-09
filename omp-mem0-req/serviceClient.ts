// Le CLIENT HTTP du panneau (S-11) : les gestes du lot passent par l'API du
// service — le panneau n'écrit plus jamais le lot lui-même, et c'est le service
// qui exécute le travail.
//
// Il ne dépend d'aucun `Bun` : `fetch` est celui du runtime (Bun comme Node), et
// les tests injectent leur propre implémentation (Doc-1 §11).
import type { PipelineCommand, PipelineCommandAck } from "./commands.ts";
import type { AddFeatureInput, LotPanelActions } from "./lotController.ts";
import type { WorktreeFate } from "./runs.ts";
import { readService, serviceBaseUrl } from "./serviceState.ts";
import type { ServiceRecord } from "./serviceState.ts";
import { pipelineStateDir } from "./store.ts";


/** Le refus d'un geste quand le service n'est pas joignable, mot pour mot (S-11). */
export const SERVICE_DOWN_REFUSAL = "service OMP arrêté — les pipelines n'avancent plus (/service status)";


export type ServicePostResult =
  | { ok: true; ack: PipelineCommandAck }
  | { ok: false; reason: string };


export type ServiceClientDeps = {
  stateDir?: string;
  /** Le `fetch` du runtime, injectable pour les tests (jamais un socket en test). */
  fetchImpl?: typeof fetch;
  /** L'horloge des identifiants de commande. */
  now?: () => number;
};


/** Un identifiant de commande neuf : le motif du canal, jamais un séparateur de chemin. */
function commandId(prefix: string, at: number, seq: number): string {
  return `${prefix}-${at.toString(36)}-${seq.toString(36)}`;
}


/**
 * Le client du service : lecture de `service.json`, POST des commandes, réveil
 * d'un dépôt. Chaque échec de transport rend un MOTIF, jamais une exception : le
 * panneau affiche le texte tel quel (S-9, S-11).
 */
export function createServiceClient(deps: ServiceClientDeps = {}) {
  const stateDir = deps.stateDir ?? pipelineStateDir();
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  let seq = 0;

  const record = (): ServiceRecord | null => readService(stateDir);

  async function post(path: string, body: unknown): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> {
    const service = record();
    if (service === null) return { ok: false, reason: SERVICE_DOWN_REFUSAL };
    if (typeof doFetch !== "function") return { ok: false, reason: "service OMP injoignable (fetch absent)" };
    try {
      const response = await doFetch(`${serviceBaseUrl(service)}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OMP-Service-Token": service.token },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const payload = text === "" ? null : (JSON.parse(text) as unknown);
      if (!response.ok) {
        const reason =
          payload && typeof payload === "object" && typeof (payload as { reason?: unknown }).reason === "string"
            ? (payload as { reason: string }).reason
            : `service OMP : erreur ${response.status}`;
        return { ok: false, reason };
      }
      return { ok: true, payload };
    } catch (err) {
      return { ok: false, reason: `service OMP injoignable : ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return {
    record,
    baseUrl: () => {
      const service = record();
      return service === null ? null : serviceBaseUrl(service);
    },

    /** Poste une commande et rend son accusé, ou le motif du refus de transport. */
    async postCommand(repo: string, body: PipelineCommand): Promise<ServicePostResult> {
      const sent = await post(`/repos/${encodeURIComponent(repo)}/commands`, body);
      if (!sent.ok) return sent;
      const ack = (sent.payload as { ack?: unknown } | null)?.ack;
      if (!ack || typeof ack !== "object") return { ok: false, reason: "service OMP : accusé illisible" };
      return { ok: true, ack: ack as PipelineCommandAck };
    },

    /** Réveille un dépôt : contrôleur créé au besoin, adoption, tick (S-9). */
    async pilot(repo: string): Promise<{ ok: true } | { ok: false; reason: string }> {
      const sent = await post(`/repos/${encodeURIComponent(repo)}/pilot`, {});
      return sent.ok ? { ok: true } : sent;
    },

    /** L'identifiant neuf d'une commande du panneau. */
    nextId: (): string => commandId("panel", now(), (seq += 1)),
  };
}

export type ServiceClient = ReturnType<typeof createServiceClient>;


/** Le corps d'une commande, sans l'enveloppe que le client pose lui-même. */
type CommandBody = PipelineCommand extends infer C
  ? C extends PipelineCommand
    ? Omit<C, "version" | "id" | "sentAt" | "repo">
    : never
  : never;


export type ServiceLotActionsDeps = {
  repoRoot: string;
  client: ServiceClient;
};

/**
 * Les gestes du panneau servis par l'API (S-11) : chaque méthode construit la
 * MÊME commande que le canal de fichiers, la poste, et rend `null` quand elle est
 * prise en charge — sinon le motif rendu par le service, affiché tel quel.
 *
 * `adopt()` devient le réveil du dépôt (`POST /pilot`) : le panneau ne reprend
 * plus jamais un lot localement.
 */
export function createServiceLotActions(deps: ServiceLotActionsDeps): LotPanelActions & { adopt?: () => boolean } {
  const { client, repoRoot } = deps;

  async function send(command: CommandBody): Promise<string | null> {
    // L'enveloppe est posée ICI (identité, instant, dépôt) : le corps ne porte que
    // le kind et ses champs. L'assertion est nommée faute de pouvoir unifier le
    // spread d'une union discriminée ; la forme est validée par `asCommand` côté
    // service, jamais devinée.
    const full = {
      version: 1 as const,
      id: client.nextId(),
      sentAt: Date.now(),
      repo: repoRoot,
      ...command,
    } as PipelineCommand;
    const sent = await client.postCommand(repoRoot, full);
    if (!sent.ok) return sent.reason;
    return sent.ack.state === "refused" ? (sent.ack.reason ?? "commande refusée") : null;
  }

  return {
    adopt: () => {
      // Un réveil est un effet de bord du rafraîchissement : jamais attendu, jamais
      // bloquant pour le rendu du panneau.
      void client.pilot(repoRoot).catch(() => undefined);
      return true;
    },
    add: (input: AddFeatureInput) =>
      send({
        kind: "add",
        title: input.name,
        description: input.description,
        deps: input.deps,
        modelReqSpecs: input.modelReqSpecs ?? null,
        modelImplReview: input.modelImplReview ?? null,
        ...(input.fallbackReqSpecs !== undefined ? { fallbackReqSpecs: input.fallbackReqSpecs } : {}),
        ...(input.fallbackImplReview !== undefined ? { fallbackImplReview: input.fallbackImplReview } : {}),
      }),
    editModels: (slug, input) =>
      send({
        kind: "models",
        slug,
        modelReqSpecs: input.modelReqSpecs,
        modelImplReview: input.modelImplReview,
        ...(input.fallbackReqSpecs !== undefined ? { fallbackReqSpecs: input.fallbackReqSpecs } : {}),
        ...(input.fallbackImplReview !== undefined ? { fallbackImplReview: input.fallbackImplReview } : {}),
      }),
    // Le canal ne porte pas de portée : la commande vise les features que AUCUNE
    // session ouverte ne porte — exactement le rang de /pipelines (S-5).
    resolveQuota: (provider, model) => send({ kind: "quota", provider, model }),
    launch: () => send({ kind: "start" }),
    remove: slug => send({ kind: "remove", slug }),
    // Une réponse à une question en vol part dans la boîte du run par le canal
    // (`answer`) ; un texte à un maillon terminé part en `reply` (S-9).
    answer: (slug, text) => send({ kind: "reply", slug, text }),
    reply: () => ({ kind: "closed", reason: "la réponse passe par le service OMP — rouvre le rang pour écrire" }),
    validate: slug => send({ kind: "verdict", slug, verdict: "v" }),
    accept: slug => send({ kind: "verdict", slug, verdict: "y" }),
    relaunch: slug => send({ kind: "relaunch", slug }),
    cancel: (slug, fate: WorktreeFate) => send({ kind: "cancel", slug, fate }),
  };
}
