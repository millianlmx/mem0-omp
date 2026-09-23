// Les 8 commandes de l'extension : état et amorçage mémoire, brief, dédup, relance d'écriture, phases.
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { initPrompt, scanStack } from "./bootstrap.ts";
import { BRIEF_REF_PATH, BRIEF_VERSION, checkBrief } from "./brief.ts";
import { discussionNudgeText, nudgeText } from "./checkpoint.ts";
import { GLOBAL_SCOPE, MEM0_HTTP_URL } from "./config.ts";
import {
  contentTokens,
  DEDUPE_SWEEP_CONTAINED,
  DEDUP_CONTAINED,
  findSimilar,
  planDedupe,
  planMerge,
  renderDedupePreview,
} from "./dedupe.ts";
import type { DedupeEntry } from "./dedupe.ts";
import { mem0, mem0Fetch, memoryLine, rows } from "./mem0Client.ts";
import { DEFAULT_PHASES, mutatePhases, phaseWriteError, phases } from "./phases.ts";
import { projectId, rootOf, stateOf } from "./state.ts";
import type { Mem0Runtime } from "./state.ts";

/**
 * Les 8 commandes, chacune avec sa description — recopiée dans le tableau
 * `commands` du catalogue marketplace, que scripts/check.sh compare à ces
 * appels. `pi` sert à mem0-init et mem0-save, qui démarrent un tour.
 */
export function registerMem0Commands(pi: ExtensionAPI, rt: Mem0Runtime): void {
  pi.registerCommand("mem0-status", {
    description: "Connexion mem0, projet résolu, état du brief, nombre de souvenirs",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const st = stateOf(rt, ctx);
      const scope = projectId(ctx.cwd);
      const brief = rt.provisioned.get(rootOf(ctx.cwd).dir) ?? checkBrief(rt, ctx);
      try {
        const health = await mem0Fetch("/health");
        const [proj, glob] = await Promise.all([mem0.getAll(scope), mem0.getAll(GLOBAL_SCOPE)]);
        ctx.ui.notify(
          `[mem0] ok=${!!health.ok} · ${MEM0_HTTP_URL} · projet="${scope}" ${rows(proj).length} souvenir(s) · ` +
            `global ${rows(glob).length} · brief ref=${brief.ref} agents=${brief.agents}`,
          "info",
        );
        // Ce sont les ratios qui disent si le dispositif tient : recalls/turns et
        // pinned/explorations pour la couverture en lecture, adds/mutations en écriture.
        ctx.ui.notify(
          `[mem0] session : ${st.turns} tour(s) · ${st.recalls} rappel(s) non vide(s) · ` +
            `${st.explorations} exploration(s) · ${st.pinned} agrafage(s) · ${st.mutations} modification(s) · ` +
            `${st.adds} écriture(s) mémoire · sommaire ${st.index ? "présent" : "absent"}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message} · brief ref=${brief.ref} agents=${brief.agents}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("mem0-init", {
    description:
      "Amorce la mémoire d'un projet déjà existant : empreinte technique du dépôt + relecture guidée. " +
      "--scan-only pour l'empreinte seule, --force pour réamorcer un projet déjà en mémoire",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = String(args ?? "");
      const force = argv.includes("--force");
      const scanOnly = argv.includes("--scan-only");
      const scope = projectId(ctx.cwd);
      const { dir, isRepo } = rootOf(ctx.cwd);

      if (!isRepo && !force) {
        ctx.ui.notify(
          `[mem0] ${dir} ne ressemble pas à un projet (ni .git ni AGENTS.md). --force pour amorcer quand même.`,
          "warning",
        );
        return;
      }

      // Le brief d'abord : sans lui, l'agent ne saura pas quoi enregistrer.
      checkBrief(rt, ctx);

      // Garde anti-doublon. Réamorcer un projet déjà en mémoire crée des
      // quasi-doublons que la fusion mem0 ne rattrape pas toujours, et qui
      // diluent le recall.
      let existing = 0;
      try {
        existing = rows(await mem0.getAll(scope)).length;
      } catch (err) {
        ctx.ui.notify(`[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message}`, "error");
        return;
      }

      if (existing > 0 && !force) {
        let go = false;
        if (ctx.hasUI) {
          try {
            // `confirm` prend (titre, message) : l'appel à un seul argument passait
            // un message `undefined` au dialogue.
            go = await ctx.ui.confirm(
              `Réamorcer "${scope}" ?`,
              `Ce projet a déjà ${existing} souvenir(s). Réamorcer risque de créer des doublons.`,
            );
          } catch { go = false; }
        }
        if (!go) {
          ctx.ui.notify(`[mem0] amorçage annulé (${existing} souvenir(s) existants) — /mem0-init --force pour forcer.`, "info");
          return;
        }
      }

      // 1. Empreinte technique : lue sur disque, écrite en verbatim (infer=false).
      // Pas d'extraction LLM ici — ce sont déjà des faits, et les faire passer
      // par le modèle ne ferait que les paraphraser en perdant des détails.
      const facts = scanStack(dir, scope);
      if (!facts.length) {
        ctx.ui.notify(`[mem0] rien de détectable sur disque dans ${dir} — l'amorçage repose entièrement sur la relecture.`, "warning");
      }

      let written = 0;
      let merged = 0;
      const failures: string[] = [];
      for (const fact of facts) {
        try {
          // Même chemin que mem0_add : un réamorçage ne doit pas empiler une
          // deuxième copie de l'empreinte.
          const plan = planMerge(fact, await findSimilar(fact, scope));
          if (plan.action === "skip") continue;
          if (plan.action === "update") {
            await mem0.update(plan.target.id, plan.merged);
            merged++;
            continue;
          }
          await mem0.add(fact, scope, { infer: false, tags: "stack,init" });
          written++;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      ctx.ui.notify(
        `[mem0] empreinte de "${scope}" : ${written} nouveau(x), ${merged} complété(s), ` +
          `${facts.length - written - merged - failures.length} déjà connu(s)` +
          (failures.length ? ` · ${failures.length} échec(s) : ${failures[0]}` : ""),
        failures.length ? "warning" : "info",
      );

      if (scanOnly) return;
      if (written + merged === 0 && facts.length > 0 && failures.length > 0) {
        ctx.ui.notify("[mem0] aucune écriture n'a abouti — relecture non lancée. Vérifie /mem0-status.", "error");
        return;
      }

      // 2. Relecture guidée : la partie qui demande du jugement part au modèle,
      // en tant que message utilisateur pour que le tour démarre normalement.
      try {
        await ctx.waitForIdle?.();
        pi.sendUserMessage(initPrompt(scope, written + merged));
      } catch (err) {
        ctx.ui.notify(`[mem0] relecture non lancée : ${(err as Error).message}`, "warning");
      }
    },
  });

  pi.registerCommand("mem0-brief", {
    description: "État du brief mémoire du projet ; --update pour réécrire la version courante",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const force = String(args ?? "").includes("--update");
      const st = checkBrief(rt, ctx, force);
      ctx.ui.notify(
        `[mem0] brief ${BRIEF_VERSION} · ${st.root} · ${BRIEF_REF_PATH}=${st.ref} · AGENTS.md=${st.agents}` +
          (st.detail ? ` (${st.detail})` : ""),
        st.ref === "failed" || st.agents === "failed" ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("mem0-dedupe", {
    description:
      "Repère les souvenirs redondants du projet et supprime les moins informatifs. Simulation " +
      "par défaut : chaque paire est affichée avec son score de recouvrement, le texte intégral " +
      "du souvenir voué à la suppression et les mots qu'elle ferait perdre. --apply pour écrire, " +
      "--strict pour ne traiter que les recouvrements quasi totaux, --scope global pour la " +
      "mémoire transverse",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = String(args ?? "");
      const apply = argv.includes("--apply");
      const threshold = argv.includes("--strict") ? DEDUP_CONTAINED : DEDUPE_SWEEP_CONTAINED;
      const scope = argv.includes("--scope global") ? GLOBAL_SCOPE : projectId(ctx.cwd);

      let all: any[];
      try {
        all = rows(await mem0.getAll(scope));
      } catch (err) {
        ctx.ui.notify(`[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message}`, "error");
        return;
      }

      // Comparaison lexicale pure, sans embedding : on travaille sur une base
      // déjà chargée en mémoire, et un aller-retour vectoriel par paire coûterait
      // O(n²) requêtes pour un gain nul sur des quasi-doublons.
      const entries: DedupeEntry[] = all
        .map((m) => ({ id: String(m?.id ?? ""), text: memoryLine(m) }))
        .filter((e) => e.id)
        .map((e) => ({ ...e, tokens: contentTokens(e.text) }));

      const actions = planDedupe(entries, threshold);

      if (!actions.length) {
        ctx.ui.notify(
          `[mem0] "${scope}" : ${entries.length} souvenir(s), aucun doublon au seuil ${threshold}.`,
          "info",
        );
        return;
      }

      if (!apply) {
        ctx.ui.notify(
          `[mem0] "${scope}" : ${actions.length} doublon(s) sur ${entries.length} souvenir(s) — simulation, rien n'est écrit.\n\n` +
            `${renderDedupePreview(actions, threshold)}\n\n` +
            `/mem0-dedupe --apply supprime les ${actions.length} souvenir(s) marqués SUPPRIME.`,
          "info",
        );
        return;
      }

      const deleted: string[] = [];
      const failures: string[] = [];
      for (const action of actions) {
        try {
          await mem0.delete(action.drop.id);
          deleted.push(action.drop.id);
        } catch (err) {
          failures.push(`[${action.drop.id}] ${(err as Error).message}`);
        }
      }
      // La base a changé sous le cache local : sommaire et agrafage seraient faux.
      const st = stateOf(rt, ctx);
      st.mem = null;
      st.index = null;
      // Les ids supprimés partent dans le rapport : après coup, c'est la seule
      // trace qui permet de dire ce qui a disparu.
      ctx.ui.notify(
        `[mem0] "${scope}" : ${deleted.length} doublon(s) supprimé(s), ${entries.length - deleted.length} restant(s)` +
          (deleted.length ? `\n  supprimés : ${deleted.join(", ")}` : "") +
          (failures.length ? `\n  ${failures.length} échec(s) : ${failures.join(" · ")}` : ""),
        failures.length ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("mem0-save", {
    description: "Demande à l'agent d'écrire maintenant ce que cette session a produit de durable",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const st = stateOf(rt, ctx);
      st.nudged = true;
      await ctx.waitForIdle?.();
      pi.sendUserMessage(st.mutations > 0 ? nudgeText(st.mutations) : discussionNudgeText(st.substantiveTurns));
    },
  });

  pi.registerCommand("add-phase", {
    description: "Enregistre une phase et le brief de rôle de l'agent : /add-phase NOM BRIEF",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = String(args ?? "").trim();
      const sp = argv.indexOf(" ");
      const name = (sp === -1 ? argv : argv.slice(0, sp)).trim();
      const brief = sp === -1 ? "" : argv.slice(sp + 1).trim();
      if (!name) {
        ctx.ui.notify("[mem0] usage : /add-phase NOM BRIEF", "error");
        return;
      }
      if (phases.has(name)) {
        ctx.ui.notify(`[mem0] phase "${name}" existe déjà — /remove-phase pour la retirer d'abord.`, "warning");
        return;
      }
      if (mutatePhases((r) => r.set(name, { brief }))) {
        ctx.ui.notify(`[mem0] phase "${name}" enregistrée.`, "info");
      } else {
        ctx.ui.notify(`[mem0] phases non enregistrées : ${phaseWriteError}`, "warning");
      }
    },
  });

  pi.registerCommand("set-phase", {
    description: "Active une phase pour la session (--default réinitialise le registry) : /set-phase NOM",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = String(args ?? "").trim();
      const st = stateOf(rt, ctx);

      if (argv === "--default") {
        st.currentPhase = null;
        st.phaseTriggered = false;
        // Seule opération destructive du registry : par définition, elle retire
        // les phases des autres sessions (README §Phases).
        const ok = mutatePhases((r) => {
          r.clear();
          for (const d of DEFAULT_PHASES) r.set(d, { brief: "" });
        });
        if (!ok) {
          ctx.ui.notify(`[mem0] phases non enregistrées : ${phaseWriteError}`, "warning");
          return;
        }
        ctx.ui.notify(`[mem0] registry réinitialisé : ${DEFAULT_PHASES.join(", ")}. Aucune phase active.`, "info");
        return;
      }

      const name = argv.split(/\s+/)[0] ?? "";
      if (!name) {
        ctx.ui.notify("[mem0] usage : /set-phase NOM", "error");
        return;
      }
      if (!phases.has(name)) {
        ctx.ui.notify(`[mem0] phase "${name}" inconnue. /add-phase pour l'enregistrer, /set-phase --default pour les valeurs par défaut.`, "error");
        return;
      }
      st.currentPhase = name;
      st.phaseTriggered = false;
      const brief = phases.get(name)?.brief;
      ctx.ui.notify(`[mem0] phase "${name}" active pour cette session${brief ? ` — rôle : ${brief}` : ""}.`, "info");
    },
  });

  pi.registerCommand("remove-phase", {
    description: "Désenregistre une phase : /remove-phase NOM",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = String(args ?? "").trim().split(/\s+/)[0] ?? "";
      if (!name) {
        ctx.ui.notify("[mem0] usage : /remove-phase NOM", "error");
        return;
      }
      if (!phases.has(name)) {
        ctx.ui.notify(`[mem0] phase "${name}" inconnue.`, "warning");
        return;
      }
      if (!mutatePhases((r) => r.delete(name))) {
        ctx.ui.notify(`[mem0] phases non enregistrées : ${phaseWriteError}`, "warning");
        return;
      }
      const st = stateOf(rt, ctx);
      if (st.currentPhase === name) st.currentPhase = null;
      ctx.ui.notify(`[mem0] phase "${name}" désenregistrée.`, "info");
    },
  });
}
