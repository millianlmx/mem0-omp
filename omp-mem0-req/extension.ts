// Le plugin des pipelines : un client du harness (omp-harness, sur le VPS).
//
// /req et /project se tiennent ICI, dans la session, avec l'utilisateur : le
// dialogue cerne les besoins (ou découpe le projet), puis un outil crée le run
// (ou le projet) sur le serveur, qui conduit specs → impl → review → merge. /audit
// lance l'audit sur le serveur et y choisit les propositions ; /pipelines résume la
// boîte de l'humain. Les gestes de la boucle humaine se font dans OMP Console.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HarnessCallError, harnessCall, inboxSummary, parsePicks, proposalList, resolveTarget } from "./harness.ts";
import type { HarnessTarget, Inbox } from "./harness.ts";


type Ctx = {
  cwd: string;
  hasUI: boolean;
  ui?: { notify?: (message: string, level?: "info" | "warning" | "error") => void; input?: (title: string, placeholder?: string) => Promise<string | undefined> };
};

type FeatureParams = { title: string; request: string; modules?: string[] };
type LaunchParams = FeatureParams & { req: string };
type ProjectParams = { title: string; features: FeatureParams[] };
type Audit = { id: string; focus: string; state: string; proposals: { title: string; kind: string; rationale: string }[] };


/**
 * La validation d'un geste qui crée du travail sur le serveur : demandée à chaque
 * appel, même en mode yolo. Seule une politique `deny` l'emporte.
 */
export const LAUNCH_APPROVAL = { tier: "write", policy: "prompt", reason: "crée du travail sur le harness" } as const;


export const REQ_SEED = (demand: string, repo: string) => `# /req — besoins d'une feature du dépôt « ${repo} »

Demande : ${demand || "(à recueillir auprès de l'utilisateur)"}

Cerne les BESOINS avec l'utilisateur, sans concevoir la solution : pose tes questions avec \`ask\`, une à la fois, jusqu'à pouvoir écrire le compte rendu. Lis le code juste assez pour comprendre le contexte.

Le compte rendu a exactement ces sections :
## Besoins
(numérotés B-1, B-2… : ce que l'utilisateur doit pouvoir faire, observable)
## Hors périmètre
## Contraintes

Montre-le à l'utilisateur. Quand il le valide, appelle \`harness_launch\` (titre court, demande d'origine, compte rendu) : le harness conduira /specs, /impl, /review et le merge sur le serveur. Ne modifie AUCUN fichier.`;


export const PROJECT_SEED = (description: string, repo: string) => `# /project — un projet du dépôt « ${repo} »

Projet : ${description || "(à recueillir auprès de l'utilisateur)"}

Cerne le projet avec l'utilisateur (\`ask\`, une question à la fois), puis découpe-le en FEATURES autonomes : chacune livrable seule en moins de ~300 lignes de diff, avec sa demande rédigée comme une demande /req et, si tu les connais, les chemins du dépôt qu'elle touchera (\`modules\` : c'est ce qui décide du parallélisme). Montre le plan ; quand l'utilisateur le valide, appelle \`harness_project\`. Ne modifie AUCUN fichier.`;


function target(ctx: Ctx, tag: string): HarnessTarget | null {
  const resolved = resolveTarget(ctx.cwd);
  if ("refusal" in resolved) {
    ctx.ui?.notify?.(`[${tag}] ${resolved.refusal}`, "warning");
    return null;
  }
  return resolved;
}


function text(content: string, isError = false) {
  return { content: [{ type: "text" as const, text: content }], ...(isError ? { isError: true } : {}) };
}


/** Un appel au harness depuis une commande : l'erreur devient un avertissement nommé. */
async function guarded(ctx: Ctx, tag: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof HarnessCallError)) throw err;
    ctx.ui?.notify?.(`[${tag}] ${err.message}`, "warning");
  }
}


export default function reqExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  const fields = {
    title: z.string().describe("Titre court de la feature"),
    request: z.string().describe("La demande, rédigée comme une demande /req autoportante"),
    modules: z.array(z.string()).optional().describe("Chemins du dépôt que la feature touchera, s'ils sont connus"),
  };
  const feature = z.object(fields);

  pi.registerTool({
    name: "harness_launch",
    label: "Harness — lancer la feature",
    loadMode: "essential",
    approval: LAUNCH_APPROVAL,
    description:
      "Crée la feature sur le harness avec le compte rendu de besoins VALIDÉ par l'utilisateur (sections ## Besoins, ## Hors périmètre, ## Contraintes) : " +
      "le serveur enchaîne /specs (que l'utilisateur validera dans OMP Console), /impl, /review et le merge.",
    parameters: z.object({ ...fields, req: z.string().describe("Le compte rendu de besoins validé, en Markdown") }),
    async execute(_id: string, params: LaunchParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const resolved = resolveTarget(ctx?.cwd ?? process.cwd());
      if ("refusal" in resolved) return text(resolved.refusal, true);
      try {
        const { run } = await harnessCall<{ run: { id: string; branch: string } }>(resolved, "POST", "/v1/runs", { repo: resolved.repo, ...params });
        return text(`Feature créée sur le harness : run ${run.id}, branche ${run.branch}. Les specs arriveront à valider dans OMP Console. Termine ta réponse.`);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  pi.registerTool({
    name: "harness_project",
    label: "Harness — lancer le projet",
    loadMode: "essential",
    approval: LAUNCH_APPROVAL,
    description:
      "Crée le projet VALIDÉ par l'utilisateur sur le harness : ses features partent en pipelines, en parallèle quand leurs modules sont disjoints, chacune mergée dès sa validation.",
    parameters: z.object({ title: z.string(), features: z.array(feature).min(1) }),
    async execute(_id: string, params: ProjectParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const resolved = resolveTarget(ctx?.cwd ?? process.cwd());
      if ("refusal" in resolved) return text(resolved.refusal, true);
      try {
        const created = await harnessCall<{ projectId: string; runs: { id: string; modules: string[] }[] }>(resolved, "POST", "/v1/projects", { repo: resolved.repo, ...params });
        return text(`Projet ${created.projectId} créé : ${created.runs.length} feature(s) en file sur le harness. Suivi dans OMP Console. Termine ta réponse.`);
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  pi.registerCommand("req", {
    description: "Cerne les besoins d'une feature avec toi, puis la lance sur le harness (specs, impl, review et merge sur le serveur)",
    handler: async (args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "req");
      if (resolved) pi.sendUserMessage(REQ_SEED(String(args ?? "").trim(), resolved.repo));
    },
  });

  pi.registerCommand("project", {
    description: "Cerne un projet avec toi, le découpe en features, puis le lance sur le harness — en parallèle quand les modules sont disjoints",
    handler: async (args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "project");
      if (resolved) pi.sendUserMessage(PROJECT_SEED(String(args ?? "").trim(), resolved.repo));
    },
  });

  pi.registerCommand("audit", {
    description: "Audite le dépôt sur le harness (/audit [focus]) ; /audit lancer <id> <n,n…> lance les propositions retenues en projet",
    handler: async (args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "audit");
      if (!resolved) return;
      const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      await guarded(ctx, "audit", async () => {
        if (words[0] === "lancer" && words[1]) {
          const { audit } = await harnessCall<{ audit: Audit }>(resolved, "GET", `/v1/audits/${encodeURIComponent(words[1])}`);
          let picksText = words.slice(2).join(" ");
          if (picksText === "" && ctx.hasUI && ctx.ui?.input) picksText = (await ctx.ui.input(`Propositions à lancer :\n${proposalList(audit)}`, "ex. 1,3")) ?? "";
          const picks = parsePicks(picksText, audit.proposals.length);
          if (picks === null) {
            ctx.ui?.notify?.(`[audit] numéros attendus entre 1 et ${audit.proposals.length} :\n${proposalList(audit)}`, "warning");
            return;
          }
          const { projectId } = await harnessCall<{ projectId: string }>(resolved, "POST", `/v1/audits/${encodeURIComponent(audit.id)}/launch`, { items: picks });
          ctx.ui?.notify?.(`[audit] ${picks.length} proposition(s) lancée(s) — projet ${projectId}.`, "info");
          return;
        }
        if (words[0] === "liste") {
          const { audits } = await harnessCall<{ audits: Audit[] }>(resolved, "GET", "/v1/audits");
          const open = audits.filter(audit => audit.state === "proposed");
          ctx.ui?.notify?.(open.length === 0 ? "[audit] aucun audit à trier." : open.map(audit => `Audit ${audit.id} (${audit.focus || "dépôt entier"}) :\n${proposalList(audit)}`).join("\n\n"), "info");
          return;
        }
        const { audit } = await harnessCall<{ audit: Audit }>(resolved, "POST", "/v1/audits", { repo: resolved.repo, focus: words.join(" ") });
        ctx.ui?.notify?.(`[audit] audit ${audit.id} lancé sur le harness. Ses propositions arriveront dans OMP Console, ou par /audit liste.`, "info");
      });
    },
  });

  pi.registerCommand("pipelines", {
    description: "Résume la boîte de l'humain du harness : escalades, specs et verdicts à valider, features en cours, audits à trier",
    handler: async (_args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "pipelines");
      if (!resolved) return;
      await guarded(ctx, "pipelines", async () => {
        const inbox = await harnessCall<Inbox>(resolved, "GET", "/v1/inbox");
        ctx.ui?.notify?.(inboxSummary(inbox, resolved.url), "info");
      });
    },
  });
}
