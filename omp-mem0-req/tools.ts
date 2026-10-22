// Les outils du harness exposés au MODÈLE : lire la boîte, un run et son journal ;
// lancer une feature ou un projet ; et les GESTES de la boucle humaine (valider,
// répondre, renverser, relancer, annuler, accepter les décisions).
//
// Les gestes ne demandent aucune approbation à OMP : la conversation vaut autorisation.
// Le modèle n'appelle un geste que si l'utilisateur l'a demandé en clair ; la
// description de chaque outil le dit. Un geste lit d'abord la révision du run et
// l'envoie en `If-Match` : si la boîte a changé entre-temps (412), le geste est refusé
// et le modèle relit `harness_run`.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readEvents } from "./events.ts";
import type { HarnessEvent } from "./events.ts";
import { HarnessCallError, harnessCall, inboxSummary, resolveTarget } from "./harness.ts";
import type { HarnessTarget, Inbox } from "./harness.ts";
import { parseRunView } from "./wire.ts";
import type { RunView } from "./wire.ts";

/**
 * La validation d'un geste qui crée du travail sur le serveur : demandée à chaque
 * appel, même en mode yolo. Seule une politique `deny` l'emporte.
 */
export const LAUNCH_APPROVAL = { tier: "write", policy: "prompt", reason: "crée du travail sur le harness" } as const;

/** La règle de chaque geste, dans sa description : la conversation vaut autorisation. */
export const GESTURE_RULE = "N'appelle cet outil que si l'utilisateur l'a demandé en clair dans la conversation.";

/** Ce que rend un geste quand la révision envoyée en `If-Match` n'est plus celle du serveur. */
export const STALE_MESSAGE = "la boîte a changé, relis harness_run";

/** Les artefacts montrés par `harness_run`, tronqués à cette longueur chacun. */
export const ARTIFACT_LIMIT = 6_000;
const SHOWN_ARTIFACTS = ["req.md", "specs.md", "impl.md"];

type Launched = { id: string; title: string };

export type ToolDeps = {
  /** Après un lancement réussi en session interactive : les runs à suivre. */
  onLaunched?: (target: HarnessTarget, runs: Launched[]) => void;
  fetcher?: typeof fetch;
};

type FeatureParams = { title: string; request: string; modules: string[] };
type LaunchParams = FeatureParams & { req: string };
type ProjectParams = { title: string; features: FeatureParams[] };
type IdParams = { id: string };
type ValidateParams = IdParams & { approve: boolean; reason?: string };
type AnswerParams = IdParams & { answers: { id: number; answer: string; reason?: string }[] };
type ReverseParams = IdParams & { seq: number; option: string; reason: string };
type EventsParams = { run?: string; since?: number };

export function text(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], ...(isError ? { isError: true } : {}) };
}

function truncate(content: string, limit: number): string {
  return content.length <= limit ? content : `${content.slice(0, limit)}\n… (tronqué à ${limit} caractères)`;
}

/** La vue d'un run en Markdown lisible : ce que le modèle lit avant de proposer un geste. */
export function renderRun(view: RunView): string {
  const { run } = view;
  const open = view.escalations.filter((item) => item.status === "open");
  const lines = [
    `# ${run.title} [${run.id}]`,
    `- état : ${run.state}${run.step ? ` (étape /${run.step})` : ""}`,
    `- raison : ${run.reason ?? "—"}`,
    `- rev : ${run.rev}`,
    `- branche : ${run.branch || "—"}${run.prUrl ? ` — PR ${run.prUrl}` : ""}`,
    `- modules : ${run.modules.length > 0 ? run.modules.join(", ") : "(aucun)"}`,
    `- corrections : ${run.fixes}, tentatives : ${run.attempts}${run.lastFailCause ? `, dernière cause d'échec : ${run.lastFailCause}` : ""}`,
    ...(run.notBefore !== null ? [`- relance prévue : ${new Date(run.notBefore).toISOString()}`] : []),
    "",
    `## Décisions (${view.decisions.length})`,
    ...(view.decisions.length === 0
      ? ["(aucune)"]
      : view.decisions.map(
          (item) =>
            `- #${item.seq} [${item.status}${item.status === "auto" || item.status === "auto_timeout" ? ", choix de l'agent non validé" : ""}] ${item.question} → ${item.chosen}`,
        )),
    "",
    `## Escalades ouvertes (${open.length})`,
    ...(open.length === 0
      ? ["(aucune)"]
      : open.flatMap((item) => [
          `- #${item.id} (${item.category}) ${item.question}`,
          `  options : ${item.options.join(" | ") || "—"}`,
          `  recommandée : ${item.recommended ?? "—"}`,
          ...(item.context ? [`  contexte : ${truncate(item.context, 600)}`] : []),
        ])),
    "",
    "## Verdict",
    ...(view.verdict === null
      ? ["(pas encore de verdict)"]
      : [
          `- risque : ${view.verdict.risk}, confiance : ${view.verdict.confidence || "—"}`,
          `- résumé : ${view.verdict.summary}`,
          `- bloquants (${view.verdict.blockers.length}) : ${view.verdict.blockers.join(" ; ") || "aucun"}`,
          `- risques : ${view.verdict.risks.join(" ; ") || "aucun"}`,
          `- non vérifié : ${view.verdict.unverified.join(" ; ") || "rien"}`,
          `- critères (${view.verdict.criteria.length}) :`,
          ...view.verdict.criteria.map((item) => `  - ${item.id} [${item.status}] ${item.test}`),
        ]),
  ];
  for (const name of SHOWN_ARTIFACTS) {
    const artifact = view.artifacts.find((item) => item.name === name);
    if (!artifact) continue;
    lines.push("", `## ${name}`, truncate(artifact.content, ARTIFACT_LIMIT));
  }
  return lines.join("\n");
}

/** Le journal d'un run (ou du dépôt), une ligne par événement, du plus ancien au plus récent. */
export function renderEvents(events: HarnessEvent[]): string {
  if (events.length === 0) return "(aucun événement)";
  return events
    .map((event) => {
      const at = event.at !== null ? new Date(event.at).toISOString() : "—";
      const details = Object.entries(event.payload)
        .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      return `${event.id ?? "·"} ${at} ${event.runId ?? "-"} ${event.type}${details ? ` ${details}` : ""}`;
    })
    .join("\n");
}

function targetOf(ctx: ExtensionContext | undefined): HarnessTarget | { refusal: string } {
  return resolveTarget(ctx?.cwd ?? process.cwd());
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchRun(target: HarnessTarget, id: string, fetcher: typeof fetch | undefined): Promise<RunView> {
  const raw = await harnessCall<unknown>(target, "GET", `/v1/runs/${encodeURIComponent(id)}`, undefined, {
    fetcher,
  });
  const view = parseRunView(raw);
  if (view === null) throw new HarnessCallError(`harness : vue du run ${id} illisible`);
  return view;
}

/**
 * Un geste sur un run : lit la révision courante, l'envoie en `If-Match`, puis rend le
 * run tel qu'il est après le geste. Un 412 devient le message « relis harness_run ».
 */
export async function gesture(
  target: HarnessTarget,
  id: string,
  route: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch | undefined,
): Promise<{ ok: boolean; text: string }> {
  try {
    const before = await fetchRun(target, id, fetcher);
    await harnessCall<unknown>(target, "POST", `/v1/runs/${encodeURIComponent(id)}${route}`, body, {
      headers: { "If-Match": String(before.run.rev) },
      fetcher,
    });
  } catch (err) {
    if (err instanceof HarnessCallError && err.status === 412) return { ok: false, text: STALE_MESSAGE };
    return { ok: false, text: message(err) };
  }
  try {
    return { ok: true, text: renderRun(await fetchRun(target, id, fetcher)) };
  } catch (err) {
    return { ok: true, text: `geste fait ; relecture impossible : ${message(err)}` };
  }
}

/** Enregistre les outils du harness sur `pi`. */
export function registerHarnessTools(pi: ExtensionAPI, deps: ToolDeps = {}): void {
  const { z } = pi.zod;
  const { fetcher } = deps;
  const fields = {
    title: z.string().describe("Titre court de la feature"),
    request: z.string().describe("La demande, rédigée comme une demande /req autoportante"),
    modules: z
      .array(z.string())
      .min(1)
      .describe(
        "Chemins du dépôt que la feature touchera (dossiers ou fichiers), repérés par grep/glob : c'est ce qui décide du parallélisme ; au moins un",
      ),
  };
  const feature = z.object(fields);
  const id = z.string().describe("L'id du run (lu dans harness_inbox ou harness_run)");

  function modulesRefusal(modules: unknown, what: string): string | null {
    if (
      !Array.isArray(modules) ||
      modules.length === 0 ||
      modules.some((item) => typeof item !== "string" || item === "")
    )
      return `${what} : \`modules\` doit lister au moins un chemin du dépôt (repère-les par grep/glob avant de lancer).`;
    return null;
  }

  pi.registerTool({
    name: "harness_launch",
    label: "Harness — lancer la feature",
    loadMode: "essential",
    approval: LAUNCH_APPROVAL,
    description:
      "Crée la feature sur le harness avec le compte rendu de besoins VALIDÉ par l'utilisateur (sections ## Besoins, ## Critères d'acceptation, ## Hors périmètre, ## Contraintes) " +
      "et les chemins du dépôt qu'elle touchera (`modules`, obligatoire) : le serveur enchaîne /specs, /impl, /review et le merge.",
    parameters: z.object({ ...fields, req: z.string().describe("Le compte rendu de besoins validé, en Markdown") }),
    async execute(
      _id: string,
      params: LaunchParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const refusal = modulesRefusal(params.modules, "harness_launch");
      if (refusal) return text(refusal, true);
      try {
        const { run } = await harnessCall<{ run: { id: string; branch: string } }>(
          target,
          "POST",
          "/v1/runs",
          { repo: target.repo, ...params },
          { fetcher },
        );
        if (ctx?.hasUI) deps.onLaunched?.(target, [{ id: run.id, title: params.title }]);
        return text(
          `Feature créée sur le harness : run ${run.id}, branche ${run.branch}. Les specs arriveront à valider (harness_run ${run.id}, puis harness_validate si l'utilisateur le demande ; ou OMP Console). Termine ta réponse.`,
        );
      } catch (err) {
        return text(message(err), true);
      }
    },
  });

  pi.registerTool({
    name: "harness_project",
    label: "Harness — lancer le projet",
    loadMode: "essential",
    approval: LAUNCH_APPROVAL,
    description:
      "Crée le projet VALIDÉ par l'utilisateur sur le harness : ses features partent en pipelines, en parallèle quand leurs modules sont disjoints, chacune mergée dès sa validation. Chaque feature porte ses `modules`.",
    parameters: z.object({ title: z.string(), features: z.array(feature).min(1) }),
    async execute(
      _id: string,
      params: ProjectParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      for (const item of params.features) {
        const refusal = modulesRefusal(item.modules, `harness_project, feature « ${item.title} »`);
        if (refusal) return text(refusal, true);
      }
      try {
        const created = await harnessCall<{ projectId: string; runs: { id: string; title?: string }[] }>(
          target,
          "POST",
          "/v1/projects",
          { repo: target.repo, ...params },
          { fetcher },
        );
        if (ctx?.hasUI)
          deps.onLaunched?.(
            target,
            created.runs.map((run, index) => ({
              id: run.id,
              title: run.title ?? params.features[index]?.title ?? run.id,
            })),
          );
        return text(
          `Projet ${created.projectId} créé : ${created.runs.length} feature(s) en file sur le harness (${created.runs.map((run) => run.id).join(", ")}). Suivi par harness_inbox ou OMP Console. Termine ta réponse.`,
        );
      } catch (err) {
        return text(message(err), true);
      }
    },
  });

  pi.registerTool({
    name: "harness_inbox",
    label: "Harness — la boîte",
    loadMode: "essential",
    description:
      "Lit la boîte de l'humain sur le harness : escalades, specs et verdicts à valider, décisions à relire, features en cours (avec leurs ids). Lecture seule.",
    parameters: z.object({}),
    async execute(
      _id: string,
      _params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      try {
        const inbox = await harnessCall<Inbox>(target, "GET", "/v1/inbox", undefined, { fetcher });
        return text(inboxSummary(inbox, target.url));
      } catch (err) {
        return text(message(err), true);
      }
    },
  });

  pi.registerTool({
    name: "harness_run",
    label: "Harness — un run",
    loadMode: "essential",
    description:
      "Lit un run du harness : état, étape, décisions, escalades ouvertes, verdict de revue, et les artefacts req.md / specs.md / impl.md. Lecture seule ; à relire avant tout geste.",
    parameters: z.object({ id }),
    async execute(
      _id: string,
      params: IdParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      try {
        return text(renderRun(await fetchRun(target, params.id, fetcher)));
      } catch (err) {
        return text(message(err), true);
      }
    },
  });

  pi.registerTool({
    name: "harness_events",
    label: "Harness — le journal",
    loadMode: "essential",
    description:
      "Lit le journal des événements du harness (un run, ou tout le dépôt), depuis un curseur. Lecture seule.",
    parameters: z.object({
      run: z.string().optional().describe("L'id d'un run ; absent : tous"),
      since: z.number().int().optional().describe("Le curseur (id du dernier événement lu) ; absent : depuis le début"),
    }),
    async execute(
      _id: string,
      params: EventsParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      try {
        const events = await readEvents(target, { run: params.run, after: params.since }, { fetcher });
        return text(renderEvents(events.filter((event) => params.run !== undefined || event.repo === target.repo)));
      } catch (err) {
        return text(message(err), true);
      }
    },
  });

  pi.registerTool({
    name: "harness_validate",
    label: "Harness — valider",
    loadMode: "essential",
    description: `Valide (approve: true) ou refuse (approve: false, reason) les specs ou le verdict d'un run en attente de l'humain. ${GESTURE_RULE}`,
    parameters: z.object({
      id,
      approve: z.boolean(),
      reason: z.string().optional().describe("Obligatoire pour un refus : ce qui doit changer"),
    }),
    async execute(
      _id: string,
      params: ValidateParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      if (!params.approve && !(params.reason ?? "").trim())
        return text("harness_validate : un refus demande `reason` (ce qui doit changer).", true);
      const result = await gesture(
        target,
        params.id,
        "/validate",
        { approve: params.approve, ...(params.reason ? { reason: params.reason } : {}) },
        fetcher,
      );
      return text(result.text, !result.ok);
    },
  });

  pi.registerTool({
    name: "harness_answer",
    label: "Harness — répondre",
    loadMode: "essential",
    description: `Répond aux escalades ouvertes d'un run (id de l'escalade, réponse choisie parmi ses options, raison facultative). ${GESTURE_RULE}`,
    parameters: z.object({
      id,
      answers: z.array(z.object({ id: z.number().int(), answer: z.string(), reason: z.string().optional() })).min(1),
    }),
    async execute(
      _id: string,
      params: AnswerParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      if (!Array.isArray(params.answers) || params.answers.length === 0)
        return text("harness_answer : `answers` doit porter au moins une réponse.", true);
      const result = await gesture(target, params.id, "/escalations", { answers: params.answers }, fetcher);
      return text(result.text, !result.ok);
    },
  });

  pi.registerTool({
    name: "harness_reverse",
    label: "Harness — renverser une décision",
    loadMode: "essential",
    description: `Renverse une décision prise par l'agent (seq lu dans harness_run) vers une autre option, avec la raison ; le serveur refait ce qui en découle. ${GESTURE_RULE}`,
    parameters: z.object({ id, seq: z.number().int(), option: z.string(), reason: z.string() }),
    async execute(
      _id: string,
      params: ReverseParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const result = await gesture(
        target,
        params.id,
        `/decisions/${encodeURIComponent(String(params.seq))}/reverse`,
        { option: params.option, reason: params.reason },
        fetcher,
      );
      return text(result.text, !result.ok);
    },
  });

  pi.registerTool({
    name: "harness_retry",
    label: "Harness — relancer",
    loadMode: "essential",
    description: `Relance un run en échec ou en attente de l'humain, à la même étape. ${GESTURE_RULE}`,
    parameters: z.object({ id }),
    async execute(
      _id: string,
      params: IdParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const result = await gesture(target, params.id, "/retry", {}, fetcher);
      return text(result.text, !result.ok);
    },
  });

  pi.registerTool({
    name: "harness_cancel",
    label: "Harness — annuler",
    loadMode: "essential",
    description: `Annule un run : son runner s'arrête, rien n'est mergé. ${GESTURE_RULE}`,
    parameters: z.object({ id }),
    async execute(
      _id: string,
      params: IdParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const result = await gesture(target, params.id, "/cancel", {}, fetcher);
      return text(result.text, !result.ok);
    },
  });

  pi.registerTool({
    name: "harness_accept_decisions",
    label: "Harness — accepter les décisions",
    loadMode: "essential",
    description: `Accepte d'un coup toutes les décisions que l'agent a prises seul sur un run (statut auto ou auto_timeout). ${GESTURE_RULE}`,
    parameters: z.object({ id }),
    async execute(
      _id: string,
      params: IdParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = targetOf(ctx);
      if ("refusal" in target) return text(target.refusal, true);
      const result = await gesture(target, params.id, "/decisions/accept", {}, fetcher);
      return text(result.text, !result.ok);
    },
  });
}
