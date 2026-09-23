// Entrée de l'extension : câblage des hooks, état de l'instance ; réexporte les modules.
//
// omp-mem0-memory — mémoire mem0 (Qdrant + oMLX) intégrée nativement dans OMP.
//
// Ce que ça fait, et rien de plus :
//   1. Au premier contact avec un projet : pose le brief mémoire tout seul —
//      écrit .omp/mem0-brief.md et cite ce fichier dans AGENTS.md. Idempotent,
//      une seule fois par projet, rien à installer à la main.
//   2. Rappel à CHAQUE tour : recherche sur le prompt brut, filtrée par un
//      plancher de score, injectée silencieusement dans le même tour. Le
//      sommaire exhaustif de la mémoire du projet part dans le system prompt,
//      donc la consultation cesse d'être spéculative.
//   3. Agrafage : le souvenir qui concerne les arguments d'un read/grep/glob/
//      lsp/edit/write est posé en tête du résultat de l'outil, sans amputer
//      ce résultat et sans aucun appel réseau.
//   4. Aucune écriture automatique : c'est l'agent qui écrit. Une relance
//      unique en fin de session le rappelle quand il a modifié des fichiers
//      sans rien mémoriser.
//   5. Quatre tools explicites : mem0_search / mem0_add / mem0_update / mem0_forget.
//
// La mémoire est scopée PAR PROJET (agent_id = nom du projet), avec un scope
// "global" séparé pour les préférences transverses. Les deux sont interrogés en
// parallèle au recall.
//
// Cette entrée ne contient que le câblage : l'état de l'instance, les hooks, et
// l'appel aux modules qui portent le reste (état des sessions, client mem0,
// brief, rappel, sommaire, agrafage, checkpoint, phases, tools, commandes).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { pinToolResult } from "./attach.ts";
import { checkBrief } from "./brief.ts";
import { countToolResult, pickSessionStopNudge } from "./checkpoint.ts";
import { registerMem0Commands } from "./commands.ts";
import { phaseStopContext } from "./phases.ts";
import { handleRecall, registerRecallRenderer } from "./recall.ts";
import { createRuntime, forgetInjected, stateOf } from "./state.ts";
import { registerMem0Tools } from "./tools.ts";

export default function mem0MemoryExtension(pi: ExtensionAPI) {
  // L'état vivant (sessions, brief déjà provisionné) appartient à CETTE instance :
  // créé ici, puis passé aux modules, comme l'était la fermeture d'avant le
  // découpage. Au niveau du module, deux instances d'un même process
  // partageraient compteurs et cache de session.
  const rt = createRuntime();

  pi.setLabel("mem0 memory");

  registerRecallRenderer(pi);
  registerMem0Tools(pi, rt);

  // Les 8 commandes : la surface (nom + description, recopiée dans le
  // catalogue marketplace) et le corps vivent ensemble dans commands.ts.
  registerMem0Commands(pi, rt);

  // --- Vérification du brief au démarrage de session ------------------------
  // session_start couvre le cas normal ; le premier before_agent_start rattrape
  // les versions d'OMP où l'event ne remonte pas. checkBrief est mémoïsé, donc
  // le doublon ne coûte rien.
  pi.on("session_start", async (_event, ctx) => {
    try { checkBrief(rt, ctx); } catch { /* jamais bloquant */ }
  });

  // Après une compaction ou un changement de branche, les souvenirs déjà posés
  // ne sont plus forcément dans le contexte : on autorise leur réinjection.
  pi.on("session_compact", async (_event, ctx) => forgetInjected(rt, ctx));
  pi.on("auto_compaction_end", async (_event, ctx) => forgetInjected(rt, ctx));
  pi.on("session_branch", async (_event, ctx) => forgetInjected(rt, ctx));

  // --- Rappel à CHAQUE tour + sommaire exhaustif ----------------------------
  pi.on("before_agent_start", async (event, ctx) => handleRecall(rt, event, ctx));

  // --- Compteurs par outil + agrafage --------------------------------------
  //
  // Aucun appel réseau ici : le matching se fait sur le cache chargé au premier
  // tour. Le souvenir est posé EN TÊTE et le contenu original conservé
  // intégralement — l'outil n'est jamais amputé de son résultat.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    const st = stateOf(rt, ctx);
    countToolResult(st, event.toolName);
    return pinToolResult(st, event);
  });

  // --- Fin de session : UNE continuation, deux décisions -------------------
  //
  // session_stop n'honore qu'une continuation : le premier handler qui renvoie
  // `{ continue, additionalContext }` court-circuite les suivants (runner OMP,
  // src/extensibility/extensions/runner.ts). Deux handlers séparés — relance
  // d'écriture et fin de phase — étaient donc mutuellement exclusifs : un nudge
  // qui tirait faisait perdre les instructions de la phase active. Les deux
  // décisions sont réunies ici, la phase d'abord (intention explicite de
  // l'utilisateur), et fusionnées en une seule continuation.
  //
  // Gardes : `stop_hook_active` (le hook refire après une continuation) et un
  // flag par décision, pour qu'aucune ne se rejoue.
  pi.on("session_stop", async (event, ctx) => {
    if (event?.stop_hook_active) return;
    const st = stateOf(rt, ctx);
    const parts: string[] = [];

    // 1. Phase active + agent qui rend la main → les instructions de la phase
    //    sont cherchées en mémoire et PRÉSENTÉES à l'agent, qui les applique avec
    //    ses propres outils. L'extension n'édite jamais un fichier elle-même.
    const phasePart = await phaseStopContext(st, ctx.cwd);
    if (phasePart) parts.push(phasePart);

    // 2. Relance d'écriture — une seule par session, quand rien n'a été écrit en
    //    mémoire (adds === 0) et que la session a produit du potentiellement
    //    durable : fichiers modifiés, ou discussion substantielle sans édition
    //    (needs, specs, archi — sinon le nudge fondé sur `mutations` ne tire pas).
    if (!st.nudged) {
      const msg = pickSessionStopNudge(st);
      if (msg) { st.nudged = true; parts.push(msg); }
    }

    if (!parts.length) return;
    return { continue: true, additionalContext: parts.join("\n\n") };
  });
}

export * from "./attach.ts";
export * from "./bootstrap.ts";
export * from "./brief.ts";
export * from "./checkpoint.ts";
export * from "./commands.ts";
export * from "./config.ts";
export * from "./dedupe.ts";
export * from "./mem0Client.ts";
export * from "./phases.ts";
export * from "./recall.ts";
export * from "./state.ts";
export * from "./summary.ts";
export * from "./tools.ts";
export * from "./write.ts";
