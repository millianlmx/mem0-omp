// La Demande d'omp-harness (`/v1/intake*`) vue du plugin : une phrase en langage
// naturel que le serveur classe en plan (run, audit, planification, demande au poste),
// en question de clarification ou en réponse directe. Rien n'est créé avant la
// confirmation : `/demande` la demande à l'humain dans la session, et l'outil
// `harness_intake` exige son accord (approbation de l'hôte) pour confirmer.
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HarnessCallError, harnessCall, resolveTarget } from "./harness.ts";
import type { HarnessTarget } from "./harness.ts";
import { isRecord } from "./wire.ts";

/** La relecture de `GET /v1/intake/{id}` pendant le classement : toutes les 500 ms, 3 min au plus. */
export const INTAKE_POLL_MS = 500;
export const INTAKE_WAIT_MS = 180_000;

export type IntakePlanSummary = {
  kind: string;
  repo: string | null;
  title: string;
  statement: string;
  focus: string | null;
  schedule: { cron: string; target: string; focus: string | null; label: string | null } | null;
  creates: string;
};

export type IntakeSummary = {
  id: string;
  state: string;
  kind: string | null;
  plan: IntakePlanSummary | null;
  question: string | null;
  answer: string | null;
  reason: string | null;
  created: { kind: string; id: string } | null;
};

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function strOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function planOf(raw: unknown): IntakePlanSummary | null {
  if (!isRecord(raw)) return null;
  const schedule = raw.schedule;
  return {
    kind: str(raw, "kind"),
    repo: strOrNull(raw, "repo"),
    title: str(raw, "title"),
    statement: str(raw, "statement"),
    focus: strOrNull(raw, "focus"),
    schedule: isRecord(schedule)
      ? {
          cron: str(schedule, "cron"),
          target: str(schedule, "target"),
          focus: strOrNull(schedule, "focus"),
          label: strOrNull(schedule, "label"),
        }
      : null,
    creates: str(raw, "creates"),
  };
}

/** La demande lue dans `{intake}` ; `null` si la réponse ne porte ni `intake.id` ni `intake.state`. */
export function parseIntake(raw: unknown): IntakeSummary | null {
  const intake = isRecord(raw) ? raw.intake : null;
  if (!isRecord(intake) || typeof intake.id !== "string" || typeof intake.state !== "string") return null;
  const created = intake.created;
  return {
    id: intake.id,
    state: intake.state,
    kind: strOrNull(intake, "kind"),
    plan: planOf(intake.plan),
    question: strOrNull(intake, "question"),
    answer: strOrNull(intake, "answer"),
    reason: strOrNull(intake, "reason"),
    created:
      isRecord(created) && typeof created.kind === "string" && typeof created.id === "string"
        ? { kind: created.kind, id: created.id }
        : null,
  };
}

const KIND_LABELS: Record<string, string> = {
  feature: "feature",
  bug: "bug",
  audit: "audit",
  workstation_request: "demande au poste",
  schedule: "planification",
};

/** La demande en texte : le plan, la question, la réponse directe ou l'échec. */
export function renderIntake(intake: IntakeSummary): string {
  const head = `Demande ${intake.id}`;
  switch (intake.state) {
    case "classifying":
      return `${head} : classement en cours sur le harness.`;
    case "clarifying":
      return `${head} : le harness pose une question.\n${intake.question ?? ""}`;
    case "answered":
      return `${head} : réponse directe, rien à créer.\n${intake.answer ?? ""}`;
    case "failed":
      return `${head} : échec du classement — ${intake.reason ?? "raison inconnue"}.`;
    case "cancelled":
      return `${head} : annulée${intake.reason ? ` (${intake.reason})` : ""}.`;
    case "confirmed":
      return `${head} : confirmée${intake.created ? ` — ${intake.created.kind} ${intake.created.id} créé` : ""}.`;
  }
  const plan = intake.plan;
  if (intake.state !== "planned" || plan === null) return `${head} : état ${intake.state}.`;
  const lines = [
    `${head} : plan prêt, rien n'est créé avant confirmation.`,
    `Création : ${plan.creates}`,
    `Type : ${KIND_LABELS[plan.kind] ?? plan.kind}`,
  ];
  if (plan.repo) lines.push(`Dépôt : ${plan.repo}`);
  lines.push(`Titre : ${plan.title}`, `Énoncé : ${plan.statement}`);
  if (plan.focus) lines.push(`Focus : ${plan.focus}`);
  if (plan.schedule) {
    const { cron, target, focus, label } = plan.schedule;
    lines.push(
      `Cron : ${cron}`,
      `Cible : ${target}${focus ? ` (focus ${focus})` : ""}${label ? ` (label ${label})` : ""}`,
    );
  }
  return lines.join("\n");
}

type CallOptions = { fetcher?: typeof fetch; pollMs?: number; waitMs?: number };

async function call(
  target: HarnessTarget,
  method: "GET" | "POST",
  route: string,
  body: unknown,
  fetcher: typeof fetch | undefined,
): Promise<IntakeSummary> {
  const raw = await harnessCall<unknown>(target, method, route, body, { fetcher });
  const intake = parseIntake(raw);
  if (intake === null) throw new HarnessCallError("harness : demande illisible");
  return intake;
}

const route = (id: string, action = "") => `/v1/intake/${encodeURIComponent(id)}${action}`;

/** Relit la demande jusqu'à un état autre que `classifying`, ou jusqu'au délai (rend alors l'état courant). */
export async function followIntake(
  target: HarnessTarget,
  intake: IntakeSummary,
  options: CallOptions = {},
): Promise<IntakeSummary> {
  const deadline = Date.now() + (options.waitMs ?? INTAKE_WAIT_MS);
  let current = intake;
  while (current.state === "classifying" && Date.now() < deadline) {
    await sleep(options.pollMs ?? INTAKE_POLL_MS);
    current = await call(target, "GET", route(current.id), undefined, options.fetcher);
  }
  return current;
}

/** Pose la demande (`source: "cli"`, dépôt courant) et la suit jusqu'au classement. */
export async function postIntake(target: HarnessTarget, text: string, options: CallOptions = {}) {
  const posted = await call(target, "POST", "/v1/intake", { text, source: "cli", repo: target.repo }, options.fetcher);
  return followIntake(target, posted, options);
}

/** Répond à la question de clarification : la même demande repasse en classement, suivie jusqu'au nouveau plan. */
export async function answerIntake(target: HarnessTarget, id: string, text: string, options: CallOptions = {}) {
  return followIntake(target, await call(target, "POST", route(id, "/answer"), { text }, options.fetcher), options);
}

export async function confirmIntake(target: HarnessTarget, id: string, options: CallOptions = {}) {
  return call(target, "POST", route(id, "/confirm"), {}, options.fetcher);
}

export async function cancelIntake(target: HarnessTarget, id: string, options: CallOptions = {}) {
  return call(target, "POST", route(id, "/cancel"), {}, options.fetcher);
}

export async function readIntake(target: HarnessTarget, id: string, options: CallOptions = {}) {
  return call(target, "GET", route(id), undefined, options.fetcher);
}

type IntakeUi = {
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  confirm?: (title: string, message: string) => Promise<boolean>;
};

/**
 * Le dialogue de `/demande` : pose, suit, fait répondre l'humain aux questions dans la
 * session (même demande reclassée), puis ne confirme qu'avec son accord explicite.
 */
export async function intakeDialog(
  target: HarnessTarget,
  text: string,
  ui: IntakeUi | undefined,
  hasUI: boolean,
  options: CallOptions = {},
): Promise<IntakeSummary> {
  const notify = (message: string, level: "info" | "warning" = "info") => ui?.notify?.(`[demande] ${message}`, level);
  let intake = await postIntake(target, text, options);
  while (intake.state === "clarifying" && hasUI && ui?.input) {
    notify(renderIntake(intake));
    const reply = ((await ui.input(intake.question ?? "Ta réponse", "réponse au harness")) ?? "").trim();
    if (reply === "") break;
    intake = await answerIntake(target, intake.id, reply, options);
  }
  notify(renderIntake(intake), intake.state === "failed" ? "warning" : "info");
  if (intake.state === "clarifying") {
    notify(`réponds par l'outil harness_intake (action « repondre », id ${intake.id}).`);
    return intake;
  }
  if (intake.state !== "planned") return intake;
  const go = hasUI && ui?.confirm ? await ui.confirm("Confirmer la demande ?", renderIntake(intake)) : false;
  if (!go) {
    notify(
      `rien n'a été créé. Confirme plus tard par harness_intake (action « confirmer », id ${intake.id}) ou dans OMP Console.`,
    );
    return intake;
  }
  intake = await confirmIntake(target, intake.id, options);
  notify(renderIntake(intake));
  return intake;
}

/** L'accord que l'hôte demande pour `harness_intake` : écriture pour confirmer (crée du travail), lecture sinon. */
export function intakeApproval(args: unknown): { tier: "read" | "write"; policy?: "prompt"; reason: string } {
  const action = isRecord(args) && typeof args.action === "string" ? args.action : "";
  return action === "lire" || action === "poser" || action === "repondre"
    ? { tier: "read", reason: "pose ou lit une demande sur le harness sans rien créer" }
    : { tier: "write", policy: "prompt", reason: "confirme la demande : crée du travail sur le harness" };
}

type IntakeParams = { action: "poser" | "lire" | "repondre" | "confirmer" | "annuler"; text?: string; id?: string };

function result(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], ...(isError ? { isError: true } : {}) };
}

/** Enregistre `harness_intake` sur `pi`. */
export function registerIntakeTool(pi: ExtensionAPI, deps: { fetcher?: typeof fetch } = {}): void {
  const { z } = pi.zod;
  pi.registerTool({
    name: "harness_intake",
    label: "Harness — Demande",
    loadMode: "essential",
    approval: intakeApproval,
    description:
      "La Demande du harness : une phrase en langage naturel que le serveur classe en plan (feature, bug, audit, planification, demande au poste), en question ou en réponse directe. " +
      "`poser` (text) pose la demande sur le dépôt courant et rend le plan ; `repondre` (id, text) répond à la question, la même demande est reclassée ; `lire` (id) relit ; " +
      "`confirmer` (id) crée l'objet du plan, SEULEMENT après accord explicite de l'utilisateur sur ce plan ; `annuler` (id).",
    parameters: z.object({
      action: z.enum(["poser", "lire", "repondre", "confirmer", "annuler"]).describe("Le geste sur la demande"),
      text: z.string().optional().describe("La demande (poser) ou la réponse à la question (repondre)"),
      id: z.string().optional().describe("L'id de la demande (sauf pour poser)"),
    }),
    async execute(
      _id: string,
      params: IntakeParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const target = resolveTarget(ctx?.cwd ?? process.cwd());
      if ("refusal" in target) return result(target.refusal, true);
      const text = (params.text ?? "").trim();
      const id = params.id ?? "";
      if (params.action !== "poser" && id === "")
        return result(`harness_intake : \`id\` requis pour ${params.action}.`, true);
      if ((params.action === "poser" || params.action === "repondre") && text === "")
        return result(`harness_intake : \`text\` requis pour ${params.action}.`, true);
      const options = { fetcher: deps.fetcher };
      try {
        const intake =
          params.action === "poser"
            ? await postIntake(target, text, options)
            : params.action === "repondre"
              ? await answerIntake(target, id, text, options)
              : params.action === "confirmer"
                ? await confirmIntake(target, id, options)
                : params.action === "annuler"
                  ? await cancelIntake(target, id, options)
                  : await readIntake(target, id, options);
        const hint =
          intake.state === "planned"
            ? "\nMontre ce plan à l'utilisateur ; ne confirme (action « confirmer ») qu'avec son accord explicite."
            : intake.state === "clarifying"
              ? "\nPose cette question à l'utilisateur, puis transmets sa réponse (action « repondre »)."
              : "";
        return result(renderIntake(intake) + hint);
      } catch (err) {
        return result(err instanceof Error ? err.message : String(err), true);
      }
    },
  });
}
