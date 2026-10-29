// Le plugin des pipelines : un client du harness (omp-harness, sur le VPS).
//
// /req et /project se tiennent ICI, dans la session, avec l'utilisateur : le
// dialogue cerne les besoins (ou découpe le projet), puis un outil crée le run
// (ou le projet) sur le serveur, qui conduit specs → impl → review → merge. /audit
// lance l'audit sur le serveur et y choisit les propositions ; /pipelines résume la
// boîte de l'humain. Les gestes de la boucle humaine se font depuis la session
// (outils harness_*, tools.ts) quand l'utilisateur les demande en clair, ou dans
// OMP Console ; /harness-follow (follow.ts) pousse les moments d'attente dans la
// conversation.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createFollower, FOLLOW_MESSAGE_TYPE } from "./follow.ts";
import {
  HarnessCallError,
  decodePairing,
  harnessCall,
  inboxSummary,
  parsePicks,
  proposalList,
  resolveTarget,
  writePairing,
} from "./harness.ts";
import type { HarnessTarget, Inbox } from "./harness.ts";
import { registerHarnessTools } from "./tools.ts";
import { registerWorkstationTools } from "./workstation.ts";

export { LAUNCH_APPROVAL } from "./tools.ts";

type Ctx = {
  cwd: string;
  hasUI: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
    input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
};

type Audit = {
  id: string;
  focus: string;
  state: string;
  proposals: { title: string; kind: string; rationale: string }[];
};

/** Les règles de questionnement communes à /req et /project : un `ask` groupé, des options franches, deux tours au plus. */
const ASK_RULES = `Questions : UN SEUL appel \`ask\` groupé par tour, qui porte TOUTES les questions de l'enjeu (jamais une question à la fois). Chaque question offre 2 à 3 options, ta recommandation EN TÊTE et marquée « (recommandé) » ; jamais d'option « peu importe », « à toi de voir » ou « autre » : si tu ne sais pas trancher, dis ce que tu recommandes et pourquoi. Au plus 2 tours de questions : au-delà, tranche toi-même les points restants et dis-le dans le compte rendu.`;

export const REQ_SEED = (demand: string, repo: string) => `# /req — besoins d'une feature du dépôt « ${repo} »

Demande : ${demand || "(à recueillir auprès de l'utilisateur)"}

Cerne les BESOINS avec l'utilisateur, sans concevoir la solution. Lis le code juste assez pour comprendre le contexte (grep, glob, read).

${ASK_RULES}

Le compte rendu a exactement ces sections :
## Besoins
(numérotés B-1, B-2… : ce que l'utilisateur doit pouvoir faire, observable)
## Critères d'acceptation
(numérotés AC-1 (B-1), AC-2 (B-1), AC-3 (B-2)… : chacun cite son besoin et s'écrit Given / When / Then ; l'utilisateur les co-signe avec les besoins, le harness les vérifie un par un en revue)
## Hors périmètre
## Contraintes

Montre-le à l'utilisateur. Quand il le valide : repère avec grep/glob les chemins du dépôt que la feature touchera (dossiers ou fichiers existants), puis appelle \`harness_launch\` (titre court, demande d'origine, \`modules\` = ces chemins, obligatoire et jamais vide, compte rendu) : le harness conduira /specs, /impl, /review et le merge sur le serveur. Ne modifie AUCUN fichier.`;

export const PROJECT_SEED = (description: string, repo: string) => `# /project — un projet du dépôt « ${repo} »

Projet : ${description || "(à recueillir auprès de l'utilisateur)"}

Cerne le projet avec l'utilisateur, puis découpe-le en FEATURES autonomes : chacune livrable seule en moins de ~300 lignes de diff, avec sa demande rédigée comme une demande /req et ses \`modules\` : les chemins du dépôt qu'elle touchera, repérés par grep/glob, obligatoires et jamais vides (c'est ce qui décide du parallélisme).

${ASK_RULES}

Montre le plan (titre, demande, modules de chaque feature) ; quand l'utilisateur le valide, appelle \`harness_project\`. Ne modifie AUCUN fichier.`;

function target(ctx: Ctx, tag: string): HarnessTarget | null {
  const resolved = resolveTarget(ctx.cwd);
  if ("refusal" in resolved) {
    ctx.ui?.notify?.(`[${tag}] ${resolved.refusal}`, "warning");
    return null;
  }
  return resolved;
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
  const follower = createFollower(pi);
  registerHarnessTools(pi, { onLaunched: (resolved, runs) => follower.start(resolved, runs) });
  registerWorkstationTools(pi);
  pi.on("session_shutdown", () => follower.stop());

  pi.registerCommand("req", {
    description:
      "Cerne les besoins d'une feature avec toi, puis la lance sur le harness (specs, impl, review et merge sur le serveur)",
    handler: async (args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "req");
      if (resolved) pi.sendUserMessage(REQ_SEED(String(args ?? "").trim(), resolved.repo));
    },
  });

  pi.registerCommand("project", {
    description:
      "Cerne un projet avec toi, le découpe en features, puis le lance sur le harness — en parallèle quand les modules sont disjoints",
    handler: async (args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "project");
      if (resolved) pi.sendUserMessage(PROJECT_SEED(String(args ?? "").trim(), resolved.repo));
    },
  });

  pi.registerCommand("audit", {
    description:
      "Audite le dépôt sur le harness (/audit [focus]) ; /audit lancer <id> <n,n…> lance les propositions retenues en projet",
    handler: async (args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "audit");
      if (!resolved) return;
      const words = String(args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      await guarded(ctx, "audit", async () => {
        if (words[0] === "lancer" && words[1]) {
          const { audit } = await harnessCall<{ audit: Audit }>(
            resolved,
            "GET",
            `/v1/audits/${encodeURIComponent(words[1])}`,
          );
          let picksText = words.slice(2).join(" ");
          if (picksText === "" && ctx.hasUI && ctx.ui?.input)
            picksText = (await ctx.ui.input(`Propositions à lancer :\n${proposalList(audit)}`, "ex. 1,3")) ?? "";
          const picks = parsePicks(picksText, audit.proposals.length);
          if (picks === null) {
            ctx.ui?.notify?.(
              `[audit] numéros attendus entre 1 et ${audit.proposals.length} :\n${proposalList(audit)}`,
              "warning",
            );
            return;
          }
          const { projectId } = await harnessCall<{ projectId: string }>(
            resolved,
            "POST",
            `/v1/audits/${encodeURIComponent(audit.id)}/launch`,
            { items: picks },
          );
          ctx.ui?.notify?.(`[audit] ${picks.length} proposition(s) lancée(s) — projet ${projectId}.`, "info");
          return;
        }
        if (words[0] === "liste") {
          const { audits } = await harnessCall<{ audits: Audit[] }>(resolved, "GET", "/v1/audits");
          const open = audits.filter((audit) => audit.state === "proposed");
          ctx.ui?.notify?.(
            open.length === 0
              ? "[audit] aucun audit à trier."
              : open
                  .map((audit) => `Audit ${audit.id} (${audit.focus || "dépôt entier"}) :\n${proposalList(audit)}`)
                  .join("\n\n"),
            "info",
          );
          return;
        }
        const { audit } = await harnessCall<{ audit: Audit }>(resolved, "POST", "/v1/audits", {
          repo: resolved.repo,
          focus: words.join(" "),
        });
        ctx.ui?.notify?.(
          `[audit] audit ${audit.id} lancé sur le harness. Ses propositions arriveront dans OMP Console, ou par /audit liste.`,
          "info",
        );
      });
    },
  });

  pi.registerCommand("pair", {
    description:
      "Relie cette machine au harness : colle le code d'appairage que donne `harness.sh pair` sur le serveur",
    handler: async (args: unknown, ctx: Ctx) => {
      const pairing = decodePairing(String(args ?? ""));
      if (!pairing) {
        ctx.ui?.notify?.(
          "[pair] code illisible : copie la ligne `omp1:…` qu'affiche `harness.sh pair` sur le serveur.",
          "error",
        );
        return;
      }
      // Le code approbateur (`harness.sh approver`) : son jeton n'entre jamais dans ~/.omp.
      if ("refusal" in pairing) {
        ctx.ui?.notify?.(
          `[pair] ${pairing.refusal} — ce code-ci se colle dans OMP Console. Rien n'a été écrit.`,
          "error",
        );
        return;
      }
      try {
        const inbox = await harnessCall<Inbox>(
          { url: pairing.url, token: pairing.token, repo: "" },
          "GET",
          "/v1/inbox",
        );
        const written = writePairing(pairing);
        ctx.ui?.notify?.(
          `[pair] relié à ${pairing.url} (${inbox.runs.length} feature(s) sur le serveur) — ${written.join(", ")} écrit(s). Relance omp et OMP Console pour qu'ils le prennent.`,
          "info",
        );
      } catch (err) {
        ctx.ui?.notify?.(
          `[pair] ${pairing.url} ne répond pas avec ce jeton : ${err instanceof Error ? err.message : String(err)}. Rien n'a été écrit.`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("pipelines", {
    description:
      "Résume la boîte de l'humain du harness : escalades, specs et verdicts à valider, features en cours, audits à trier",
    handler: async (_args: unknown, ctx: Ctx) => {
      const resolved = target(ctx, "pipelines");
      if (!resolved) return;
      await guarded(ctx, "pipelines", async () => {
        const inbox = await harnessCall<Inbox>(resolved, "GET", "/v1/inbox");
        const summary = inboxSummary(inbox, resolved.url);
        ctx.ui?.notify?.(summary, "info");
        // Posté aussi dans la conversation : le modèle le voit, et peut proposer le geste.
        pi.sendMessage({ customType: FOLLOW_MESSAGE_TYPE, content: summary, display: true }, { triggerTurn: false });
      });
    },
  });

  pi.registerCommand("harness-follow", {
    description:
      "Suit le harness dans cette session : specs prêtes, verdicts, questions et fins de feature arrivent en messages « [harness] » ; /harness-follow stop l'arrête",
    handler: async (args: unknown, ctx: Ctx) => {
      const word = String(args ?? "")
        .trim()
        .toLowerCase();
      if (word === "stop") {
        const was = follower.active();
        follower.stop();
        ctx.ui?.notify?.(was ? "[harness-follow] suivi arrêté." : "[harness-follow] aucun suivi en cours.", "info");
        return;
      }
      const resolved = target(ctx, "harness-follow");
      if (!resolved) return;
      follower.stop();
      follower.start(resolved, []);
      ctx.ui?.notify?.(
        `[harness-follow] suivi de ${resolved.repo} sur ${resolved.url} : les moments d'attente arriveront ici. /harness-follow stop pour l'arrêter.`,
        "info",
      );
    },
  });
}
