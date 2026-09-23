// Les 4 tools mem0 offerts au modèle : recherche, écriture, réécriture, suppression.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { GLOBAL_SCOPE, SEARCH_POOL_MAX, SEARCH_THRESHOLD } from "./config.ts";
import { findSimilar, planMerge } from "./dedupe.ts";
import { mem0, memoryId, memoryLine, rows, selectRelevant } from "./mem0Client.ts";
import { projectId, stateOf } from "./state.ts";
import type { Mem0Runtime, SessionState } from "./state.ts";
import { redact } from "./write.ts";

// Formes des paramètres : le schéma zod est déclaré ici, à l'enregistrement, et
// son type statique n'est pas résolu par le type de l'hôte (Static<TParams>
// vaut `unknown`). Ces alias reprennent donc le schéma, champ par champ.
type SearchParams = { query: string; scope?: "project" | "global"; limit?: number };
type AddParams = {
  text: string;
  kind?: "fact" | "procedure";
  scope?: "project" | "global";
  tags?: string;
  dedupe?: boolean;
  infer?: boolean;
};
type UpdateParams = { memory_id: string; text: string };
type ForgetParams = { memory_id: string };

// Toute écriture périme le cache local et le sommaire : ils seront rechargés au
// tour suivant. Le chemin `skip` n'écrit rien, donc n'invalide rien.
function wrote(st: SessionState): void {
  st.adds += 1;
  st.mem = null;
  st.index = null;
  st.explorationSinceLastWrite = 0;
}

export function registerMem0Tools(pi: ExtensionAPI, rt: Mem0Runtime): void {
  const { z } = pi.zod;

  // `loadMode: "essential"` sur les quatre tools. Sans ça, OMP les monte en
  // devices xd:// (les tools d'extension sont "discoverable" par défaut) : le
  // modèle doit alors écrire ses arguments dans le `content` du tool write, et
  // se trompe régulièrement d'enveloppe — d'où les
  // `Invalid args for xd://mem0_search`. En essential, le schéma part sur le fil
  // à chaque requête et l'appel est direct.
  pi.registerTool({
    name: "mem0_search",
    label: "mem0 · search",
    loadMode: "essential",
    description:
      "Cherche dans la mémoire du projet : stack, conventions, décisions d'archi, bugs déjà " +
      "corrigés, exigences incontournables. À appeler dès que le sujet se déplace hors du " +
      "rappel automatique : avant de débugger un symptôme qui ressemble à du déjà-vu, avant " +
      "de trancher une question d'architecture, avant de choisir une convention, avant de " +
      "répondre à une question sur la façon de faire dans ce dépôt. Moins cher qu'une " +
      "exploration du dépôt.",
    parameters: z.object({
      query: z.string().describe("Résumé du symptôme, du sujet ou de la décision recherchée"),
      scope: z.enum(["project", "global"]).optional().default("project"),
      // Le plafond accepte large et borne au moment de l'appel : un `limit: 100`
      // renvoyait une erreur de validation et brûlait un tour pour rien.
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(6)
        .describe("Nombre de souvenirs renvoyés, borné à 50"),
    }),
    async execute(
      _id: string,
      params: SearchParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const scope = params.scope === "global" ? GLOBAL_SCOPE : projectId(ctx?.cwd ?? process.cwd());
      const limit = Math.min(params.limit ?? 6, 50);
      // Sur-échantillonnage : le serveur classe par score combiné, donc sans marge
      // les souvenirs à fort cosinus rétrogradés hors du top servi seraient perdus.
      const result = await mem0.search(params.query, scope, Math.min(limit * 4, SEARCH_POOL_MAX), SEARCH_THRESHOLD, true);
      const sel = selectRelevant(rows(result), SEARCH_THRESHOLD, limit);
      // Des candidats mais aucun cosinus : le service tourne sans `explain`. Ne rien
      // rendre du pool courant (il n'est pas trié sémantiquement) et le dire.
      if (sel.candidates > 0 && sel.scored === 0) {
        return {
          content: [{
            type: "text",
            text:
              `[mem0] Le service mémoire ne renvoie pas de score sémantique (paramètre absent) : ` +
              `recherche indisponible. Reconstruis le conteneur : ` +
              `docker compose build mem0-http && docker compose up -d mem0-http.`,
          }],
          details: { candidates: sel.candidates, scored: sel.scored, floor: SEARCH_THRESHOLD, kept: [] },
        };
      }
      const text = sel.kept.length
        ? sel.kept.map((m) => `- [${memoryId(m)}] ${memoryLine(m)}`).join("\n")
        : "Aucun souvenir pertinent.";
      return {
        content: [{ type: "text", text }],
        details: { candidates: sel.candidates, scored: sel.scored, floor: SEARCH_THRESHOLD, kept: sel.kept },
      };
    },
  });

  pi.registerTool({
    name: "mem0_add",
    label: "mem0 · add",
    loadMode: "essential",
    description:
      "Enregistre un point durable : stack ou choix technique du projet, convention, décision " +
      "d'architecture, bug + cause racine + correctif, exigence incontournable d'une feature, " +
      "préférence de travail. Une seule idée par appel, formulée pour être comprise dans six " +
      "mois sans le contexte de cette conversation. Le texte est stocké tel quel, écris donc " +
      "la phrase finale. Un souvenir proche est cherché d'abord : s'il en existe un, il est " +
      "complété au lieu d'être dupliqué, et la version fusionnée t'est renvoyée — relis-la. " +
      "N'enregistre rien de trivial ni de temporaire.",
    parameters: z.object({
      text: z.string().describe("Le fait, autoportant. Ex: 'Auth : tokens de reset à usage unique, TTL 15 min (décision du 12/03).'"),
      kind: z
        .enum(["fact", "procedure"])
        .optional()
        .default("fact")
        .describe("'procedure' pour une méthode réutilisable en plusieurs étapes (déploiement, checklist), 'fact' sinon"),
      scope: z
        .enum(["project", "global"])
        .optional()
        .default("project")
        .describe("'global' uniquement pour une préférence valable sur tous tes projets"),
      tags: z.string().optional().describe("valeurs séparées par des virgules, ex: 'stack,swiftui'"),
      dedupe: z
        .boolean()
        .optional()
        .default(true)
        .describe("false uniquement si ce fait doit vivre séparément d'un souvenir voisin déjà en base"),
      infer: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "true pour laisser mem0 reformuler ton texte via son extraction LLM. Laisse false : " +
            "l'extraction paraphrase un fait déjà propre en énoncé vague et crée des quasi-doublons.",
        ),
    }),
    async execute(
      _id: string,
      params: AddParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const scope = params.scope === "global" ? GLOBAL_SCOPE : projectId(ctx?.cwd ?? process.cwd());
      const text = redact(params.text);

      // Les procédures vivent dans un autre espace mem0 (memory_type
      // procedural_memory) : la recherche de similarité ne les atteint pas, on
      // ne tente donc pas de fusion.
      if (params.kind === "procedure") {
        const result = await mem0.add(text, scope, { procedure: true });
        wrote(stateOf(rt, ctx));
        return { content: [{ type: "text", text: `Procédure enregistrée dans "${scope}".` }], details: result };
      }

      const similar = params.dedupe === false ? null : await findSimilar(text, scope);
      const plan = planMerge(text, similar);

      if (plan.action === "skip") {
        return {
          content: [
            {
              type: "text",
              text:
                `Déjà en mémoire (similarité ${plan.target.score.toFixed(2)}), rien écrit :\n` +
                `- [${plan.target.id}] ${plan.target.text}\n\n` +
                `Si ton fait dit vraiment autre chose, rappelle mem0_add avec dedupe: false, ` +
                `ou réécris l'entrée avec mem0_update.`,
            },
          ],
          details: plan.target,
        };
      }

      if (plan.action === "update") {
        const result = await mem0.update(plan.target.id, plan.merged);
        wrote(stateOf(rt, ctx));
        return {
          content: [
            {
              type: "text",
              text:
                `Souvenir complété (similarité ${plan.target.score.toFixed(2)}) — [${plan.target.id}] :\n` +
                `${plan.merged}\n\n` +
                `Relis la fusion. Si elle est bancale, réécris-la avec mem0_update.`,
            },
          ],
          details: result,
        };
      }

      const result = await mem0.add(text, scope, { tags: params.tags, infer: params.infer === true });
      wrote(stateOf(rt, ctx));
      return { content: [{ type: "text", text: `Enregistré dans "${scope}".` }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_update",
    label: "mem0 · update",
    loadMode: "essential",
    description:
      "Réécrit intégralement un souvenir existant, par son id (renvoyé par mem0_search, " +
      "mem0_add ou le rappel automatique). À utiliser quand un souvenir est devenu partiellement " +
      "faux, ou quand la fusion automatique de mem0_add a produit un texte bancal. Le nouveau " +
      "texte remplace l'ancien : reprends ce qui reste vrai.",
    parameters: z.object({
      memory_id: z.string(),
      text: z.string().describe("Le souvenir complet réécrit, autoportant"),
    }),
    async execute(
      _id: string,
      params: UpdateParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const result = await mem0.update(params.memory_id, redact(params.text));
      // Le texte a changé : cache local et sommaire sont périmés.
      const st = stateOf(rt, ctx);
      st.mem = null;
      st.index = null;
      return { content: [{ type: "text", text: `Souvenir [${params.memory_id}] réécrit.` }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_forget",
    label: "mem0 · forget",
    loadMode: "essential",
    description:
      "Supprime un souvenir par son id (retourné par mem0_search). À utiliser quand un souvenir " +
      "est devenu faux — pas quand il est simplement incomplet ou partiellement périmé : dans ce " +
      "cas, réécris-le avec mem0_update.",
    parameters: z.object({ memory_id: z.string() }),
    async execute(
      _id: string,
      params: ForgetParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const result = await mem0.delete(params.memory_id);
      // Le souvenir n'existe plus : cache local et sommaire sont périmés.
      const st = stateOf(rt, ctx);
      st.mem = null;
      st.index = null;
      return { content: [{ type: "text", text: "Supprimé." }], details: result };
    },
  });
}
