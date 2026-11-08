// Les sessions omp de la vigie (protocole RPC, le `RpcRunner` des runners du harness) :
// le tri d'un signal (`vigie_verdict` : bruit ou bug, et pour un bug ce que dira l'issue)
// et le pilotage d'un run de correction qui attend l'humain (`vigie_act`). Chaque session
// est bornée dans le temps, coûte ce que rapporte omp (`usage.cost` de chaque message),
// et ne reçoit ni le jeton de la vigie, ni celui de GitHub, ni celui de la mémoire : son
// contexte est dans le prompt, ses gestes passent par la vigie, sous les gardes du serveur.
import type { HostToolDefinition, HostToolResult, RunnerProcess } from "../rpc.ts";
import { RpcRunner } from "../rpc.ts";
import { usageOf } from "../session-feed.ts";
import type { VigieTriage } from "../db.ts";

export type SpawnOmp = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => RunnerProcess;

/** Le binaire omp, son modèle (`fournisseur/modèle`, sinon celui d'omp) et l'échéance d'une session. */
export type OmpSettings = { bin: string; model: string | null; timeoutMs: number };

/** Les secrets que la vigie garde pour elle : jamais dans l'environnement d'une session. */
const WITHHELD_ENV = [
  "VIGIE_TOKEN",
  "HARNESS_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "MEM0_HTTP_TOKEN",
] as const;

const STRINGS = { type: "array", items: { type: "string" } } as const;

export const VERDICT_TOOL: HostToolDefinition = {
  name: "vigie_verdict",
  label: "Vigie — verdict",
  description:
    "Rend TON verdict sur le signal, une fois. `noise` : attendu, passager ou hors de notre code (un test rouge d'une feature en cours, une panne passagère du fournisseur). " +
    "`bug` : un dysfonctionnement à corriger ; remplis alors tous les champs, ils deviennent l'issue publique (jamais de secret, d'e-mail ni de contenu du poste).",
  parameters: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["noise", "bug"] },
      title: { type: "string", description: "Le titre de l'issue : le symptôme en une ligne." },
      symptom: { type: "string", description: "Ce qui se passe, observable, en deux ou trois phrases." },
      evidence: { ...STRINGS, description: "Les preuves : lignes du contexte citées (journal, événements, run)." },
      hypothesis: { type: "string", description: "L'hypothèse de cause la plus probable, et pourquoi." },
      files: { ...STRINGS, description: "Les fichiers probables (chemins du dépôt)." },
      criteria: {
        ...STRINGS,
        description:
          "1 à 5 critères d'acceptation vérifiables par un test, sans leur id (la vigie les numérote `AC-n`).",
      },
      repo: {
        type: ["string", "null"],
        description: "Le dépôt à corriger, parmi ceux du prompt ; null : celui du prompt.",
      },
    },
    required: ["verdict", "title", "symptom", "evidence", "hypothesis", "files", "criteria", "repo"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

export const ACT_TOOL: HostToolDefinition = {
  name: "vigie_act",
  label: "Vigie — geste sur le run de correction",
  description:
    "Rend TA décision sur le run de correction qui attend, une fois : la vigie l'applique par le même geste que l'humain. " +
    "`approve` : valide les specs ou le verdict. `refuse` : renvoie en reprise — `reason` est la consigne, précise et vérifiable. " +
    "`retry` : relance l'étape en panne — `instructions` dit ce qu'elle doit faire autrement. " +
    "`defer` : laisse la décision à l'humain — `reason` est la question, avec ta recommandation. Seuls les gestes listés dans le prompt sont permis.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["approve", "refuse", "retry", "defer"] },
      reason: { type: "string", description: "Pourquoi ce geste, en une ou deux phrases qui citent les faits." },
      instructions: {
        type: ["string", "null"],
        description: "Avec `retry` : la consigne de l'étape relancée. Sinon null.",
      },
    },
    required: ["action", "reason", "instructions"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

/** L'environnement d'une session : celui de la vigie (clés des fournisseurs) sans ses secrets à elle. */
export function sessionEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, PI_PY: "0" };
  for (const key of WITHHELD_ENV) delete env[key];
  return env;
}

/**
 * Une session : omp lancé dans `cwd`, ses outils hôtes, un prompt, puis une relance
 * (`nudge`) si la décision n'est pas rendue ; arrêtée à l'échéance. Rend son coût, et
 * l'erreur qui l'a arrêtée s'il y en a une.
 */
export async function runSession(input: {
  spawn: SpawnOmp;
  omp: OmpSettings;
  cwd: string;
  env: Record<string, string | undefined>;
  tools: HostToolDefinition[];
  prompt: string;
  nudge: string;
  onTool: (name: string, args: Record<string, unknown>) => Promise<HostToolResult>;
  decided: () => boolean;
}): Promise<{ costUsd: number; error: string | null }> {
  const args = [
    "--mode",
    "rpc",
    "--no-ui",
    "--no-session",
    "--no-lsp",
    "--no-title",
    "--auto-approve",
    "--cwd",
    input.cwd,
    ...(input.omp.model ? ["--model", input.omp.model] : []),
  ];
  let costUsd = 0;
  const proc = input.spawn(input.omp.bin, args, { cwd: input.cwd, env: input.env });
  const runner = new RpcRunner(proc, {
    onHostTool: (name, toolArgs) => input.onTool(name, toolArgs),
    onFrame: (frame) => {
      if (frame.type !== "message_end") return;
      const usage = usageOf(frame.message);
      if (usage) costUsd += usage.cost;
    },
  });
  const deadline = Date.now() + input.omp.timeoutMs;
  const bounded = async (text: string): Promise<string | null> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "échéance de la session dépassée";
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), remaining);
    });
    try {
      const pending = runner.prompt(text);
      const result = await Promise.race([pending, expired]);
      if (result === "expired") {
        pending.catch(() => {});
        return "échéance de la session dépassée";
      }
      return result.status === "completed" ? null : (result.error?.message ?? `prompt ${result.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await runner.ready();
    await runner.setHostTools(input.tools);
    let error = await bounded(input.prompt);
    if (error === null && !input.decided()) error = await bounded(input.nudge);
    return { costUsd, error };
  } catch (err) {
    return { costUsd, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await runner.stop(5000);
  }
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body.trim() === "" ? "(rien)" : body.trim()}`;
}

export type TriageContext = {
  repo: string | null;
  repos: string[];
  clone: string | null;
  signal: { source: string; location: string; message: string; context: string; count: number; firstAt: number };
  events: string[];
  logs: string[];
  run: string | null;
  gitLog: string;
  memories: string;
};

/** Le prompt du tri d'un signal (en-tête `# /vigie-triage`). */
export function triagePrompt(ctx: TriageContext): string {
  return [
    "# /vigie-triage",
    "",
    "Tu es la vigie d'omp-harness : tu surveilles le serveur de pipelines, ses clients (apps, extension Chrome), sa mémoire et sa CI. " +
      "Un signal vient d'être relevé pour la première fois. Tranche : bruit ou bug. Un run qui échoue parce que SA feature est fausse, " +
      "un fournisseur LLM passagèrement indisponible, un dépôt de tiers cassé : du bruit. Un comportement fautif du harness, des clients, " +
      "de la mémoire ou de la CI de `main` : un bug.",
    "",
    "Rends ton verdict par `vigie_verdict`, une fois, puis termine. Pour un bug, l'issue sera publique : cite les faits du contexte, " +
      "jamais un secret, un e-mail, un chemin personnel ni le contenu du poste de travail. Les critères d'acceptation doivent se " +
      "vérifier par un test automatisé : ils lancent la correction directement à /impl.",
    "",
    `Dépôt à corriger : ${ctx.repo ?? "(aucun déclaré)"}${ctx.repos.length > 1 ? ` (permis : ${ctx.repos.join(", ")})` : ""}.` +
      (ctx.clone ? ` Son clone, en lecture seule : \`${ctx.clone}\` (lis le code qui fonde ton hypothèse).` : ""),
    "",
    section(
      "Signal",
      [
        `- source : ${ctx.signal.source}`,
        `- emplacement : ${ctx.signal.location}`,
        `- message : ${ctx.signal.message}`,
        `- occurrences : ${ctx.signal.count} depuis ${new Date(ctx.signal.firstAt).toISOString()}`,
        "",
        ctx.signal.context,
      ].join("\n"),
    ),
    section("Événements du harness autour du signal (±5 min)", ctx.events.join("\n")),
    section("Journal autour du signal (±5 min)", ctx.logs.join("\n")),
    section("Run concerné", ctx.run ?? ""),
    section("Historique récent de main", ctx.gitLog),
    section("Bugs connus (mémoire du projet)", ctx.memories),
  ].join("\n\n");
}

export type PilotContext = {
  title: string;
  wait: string;
  reason: string;
  allowed: string[];
  run: string;
  triage: VigieTriage | null;
  history: string[];
};

/** Le prompt du pilotage d'un run de correction qui attend (en-tête `# /vigie-pilote`). */
export function pilotPrompt(ctx: PilotContext): string {
  const triage = ctx.triage;
  return [
    "# /vigie-pilote",
    "",
    "Tu es la vigie d'omp-harness. Le run qui corrige un bug que tu as relevé attend l'humain. Tranche ce qui est réversible, " +
      "par `vigie_act`, une fois, puis termine. Dans le doute, `defer` : l'humain reprend la main. Un geste irréversible, " +
      "un budget ou une escalade ne sont jamais à toi (le serveur les refuse).",
    "",
    `Le run : « ${ctx.title} », en attente (${ctx.wait}) : ${ctx.reason}`,
    `Gestes permis : ${ctx.allowed.join(", ")}.`,
    section(
      "Le bug",
      triage
        ? [
            `- symptôme : ${triage.symptom}`,
            `- hypothèse : ${triage.hypothesis}`,
            `- fichiers : ${triage.files.join(", ")}`,
            ...triage.criteria.map((criterion, index) => `- AC-${index + 1} : ${criterion}`),
          ].join("\n")
        : "",
    ),
    section("L'état du run", ctx.run),
    section("Tes gestes passés sur ce run", ctx.history.join("\n")),
  ].join("\n\n");
}
