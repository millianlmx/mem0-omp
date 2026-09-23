// Boîte de réception d'un run vivant, et l'outil `ask` qui la consomme.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { LOT_EDITOR_MAX } from "./lot.ts";
import { publishCurrentCwd } from "./publish.ts";
import { runState } from "./runState.ts";
import type { FlagReader } from "./runs.ts";
import { PANEL_INBOX_POLL_MS, PIPELINE_PHASES, consumeDelivery, readDeliveries } from "./store.ts";
import type { PanelAskOption, PanelDelivery, PanelPendingAsk, PipelineCtx } from "./store.ts";



// --- le run ARMÉ : consommer sa boîte et poser de vraies questions (S-6, S-7) -
// Un run lancé par le panneau reçoit `--panel-inbox <dossier>` : c'est le seul
// canal qui atteint une session VIVANTE (aucune API de l'hôte ne voit la session
// d'un autre process). L'extension de l'ENFANT consomme les livraisons et les
// injecte dans le tour en cours (`deliverAs: "steer"`), et enregistre — pour ce
// run seulement — un outil `ask` dont la réponse arrive par la même boîte. Sans
// le drapeau (toute session interactive), rien n'est armé : l'outil `ask` de
// l'hôte garde la main, aucun timer ne tourne.

/** Bornes de la question publiée (S-7) : ce qui tient dans une zone de panneau. */
export const ASK_QUESTION_MAX = 400;

export const ASK_LABEL_MAX = 120;

export const ASK_DESCRIPTION_MAX = 200;

export const ASK_OPTIONS_MAX = 9;


export const ASK_TOOL_DESCRIPTION =
  "Pose UNE question à l'utilisateur avec 1 à 9 options et attends sa réponse. " +
  "La question s'affiche dans le panneau de la pipeline, où l'utilisateur choisit une option " +
  "ou saisit sa propre réponse. Ta question doit être bloquante : pose-la seule, sans continuer le travail.";


/** Une question validée, prête à publier (S-7). */
export type AskQuestion = { id: string; question: string; options: PanelAskOption[] };


/** Le verdict d'un appel `ask` : la question nettoyée, ou le résultat d'erreur rendu au modèle. */
export type AskCheck = { ok: true; ask: AskQuestion } | { ok: false; error: string };


/** Le nettoyage d'un texte publié : contrôles et `\r` → espace, puis clip à la borne. */
export function cleanAskText(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}


/**
 * La validation d'un appel `ask` (S-7) : PURE, sans exception, et dans l'ordre
 * des refus consignés — questions absentes, plusieurs questions, multi-sélection,
 * nombre d'options, puis `id` et libellés. Le texte rendu au modèle est celui du
 * contrat, mot pour mot : le maillon doit pouvoir comprendre et reformuler.
 */
export function checkAsk(input: unknown): AskCheck {
  const record = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const questions = record.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { ok: false, error: "Error: questions must not be empty" };
  }
  if (questions.length > 1) return { ok: false, error: "Error: ask one question at a time" };
  const raw = questions[0];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Error: questions must not be empty" };
  }
  const question = raw as Record<string, unknown>;
  if (question.multi === true) return { ok: false, error: "Error: multi-select is not supported" };
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  if (rawOptions.length === 0 || rawOptions.length > ASK_OPTIONS_MAX) {
    return { ok: false, error: `Error: ask needs 1 to ${ASK_OPTIONS_MAX} options` };
  }
  const id = typeof question.id === "string" ? question.id.trim() : "";
  if (id === "") return { ok: false, error: "Error: question id must not be empty" };
  const options: PanelAskOption[] = [];
  const labels = new Set<string>();
  for (const raw of rawOptions) {
    const option = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const label = typeof option.label === "string" ? cleanAskText(option.label, ASK_LABEL_MAX).trim() : "";
    if (label === "") return { ok: false, error: `Error: option ${options.length + 1} has no label` };
    if (labels.has(label)) return { ok: false, error: `Error: duplicate option label ${JSON.stringify(label)}` };
    labels.add(label);
    const description =
      typeof option.description === "string" ? cleanAskText(option.description, ASK_DESCRIPTION_MAX).trim() : "";
    options.push(description === "" ? { label } : { label, description });
  }
  const text = cleanAskText(typeof question.question === "string" ? question.question : "", ASK_QUESTION_MAX);
  return { ok: true, ask: { id, question: text, options } };
}


/** La réponse attendue d'une question en vol : une option choisie, ou un texte libre. */
export type AskAnswer = { selected?: string; custom?: string };


// La question EN VOL de ce process vit dans `runState.askWaiters`, une entrée par
// identifiant d'appel : un run peut poser deux questions (`concurrency` de notre
// outil est `exclusive`, l'hôte peut néanmoins les enchaîner), et deux instances
// de l'extension dans le même process — plugin installé + `-e` — partagent ainsi
// la même table : la pompe de l'une résout la question posée par l'autre.


/** Le dossier armé de ce process (`--panel-inbox`), ou `null` : absent, vide ou relatif. */
export function panelInboxFlagOf(pi: FlagReader): string | null {
  if (typeof pi.getFlag !== "function") return null;
  const raw = pi.getFlag("panel-inbox");
  return typeof raw === "string" && path.isAbsolute(raw) ? raw : null;
}


/** Le maillon d'un run de conversation (`--pipeline-phase`), ou `null` s'il n'est pas déclaré. */
export function conversationPhaseOf(pi: FlagReader): PipelinePhase | null {
  if (typeof pi.getFlag !== "function") return null;
  const raw = pi.getFlag("pipeline-phase");
  return typeof raw === "string" && PIPELINE_PHASES.includes(raw as PipelinePhase)
    ? (raw as PipelinePhase)
    : null;
}


/** Une livraison de réponse atterrit-elle sur la question en vol ? Une seule fois, par identifiant. */
export function resolveAskDelivery(delivery: Extract<PanelDelivery, { kind: "ask" }>): void {
  const waiter = runState.askWaiters.get(delivery.toolCallId);
  if (!waiter) return;
  runState.askWaiters.delete(delivery.toolCallId);
  waiter("selected" in delivery ? { selected: delivery.selected } : { custom: delivery.custom });
}


/**
 * La pompe de la boîte : les livraisons dans l'ordre des noms, un fichier par
 * livraison, supprimé dès qu'il a produit son effet. Un texte n'est PAS consommé
 * tant que la session est au repos (le déposant le reprendra à la fin du run) ;
 * une réponse `ask` est toujours consommée — sans question en vol elle n'a plus
 * d'objet (S-7). Ne lève jamais : la pompe travaille sur un timer.
 */
export function pumpInbox(pi: ExtensionAPI, ctx: PipelineCtx, dir: string): void {
  for (const entry of readDeliveries(dir)) {
    const delivery = entry.delivery;
    if (delivery === null) {
      consumeDelivery(entry.file);
      continue;
    }
    if (delivery.kind === "ask") {
      resolveAskDelivery(delivery);
      consumeDelivery(entry.file);
      continue;
    }
    // `isIdle` absent ⇒ session considérée au repos : on ne réveille pas un run
    // dont on ne sait rien, et le message part au run suivant (S-6).
    if (ctx.isIdle?.() !== false) return;
    try {
      pi.sendUserMessage(delivery.text, { deliverAs: "steer" });
    } catch {
      return; // run en cours d'arrêt : le fichier reste, il n'est pas perdu
    }
    consumeDelivery(entry.file);
  }
}


/**
 * Arme la consommation de la boîte de ce run (`--panel-inbox`) : une minuterie
 * `ctx.setInterval` — jamais un `setInterval` brut, qui tuerait la session en
 * jetant — et rien du tout hors d'un run armé. Rend `true` quand le run est
 * effectivement armé : c'est ce que `session_start` publie dans l'entrée.
 *
 * UNE SEULE pompe par process (S-6) : quand l'extension est chargée deux fois,
 * la seconde instance s'efface — sans quoi elle consommerait les livraisons
 * destinées à l'outil `ask` de la première (la livraison est supprimée au
 * passage, et la question restait sans réponse).
 */
export function armInbox(pi: ExtensionAPI, ctx: PipelineCtx): boolean {
  const dir = panelInboxFlagOf(pi);
  if (dir === null || typeof ctx.setInterval !== "function") return false;
  runState.inbox = dir;
  runState.armed = true;
  if (runState.pumpStop !== null) return true;
  const timer = ctx.setInterval(() => {
    // Une pompe qui jette sur un timer détruirait la session (une exception non
    // capturée est fatale, `## Documentation` §1) : aucun échec de lecture ne
    // doit remonter au-delà de ce point.
    try {
      pumpInbox(pi, ctx, dir);
    } catch {
      /* boîte illisible : on retente à la prochaine passe */
    }
  }, PANEL_INBOX_POLL_MS);
  runState.pumpStop = () => {
    try {
      ctx.clearTimer?.(timer);
    } catch {
      /* minuterie déjà nettoyée par la session */
    }
  };
  return true;
}


/** Le détail publié d'une réponse `ask` (S-7) : la question, ses options, ce qui a été répondu. */
export type AskToolDetails = {
  id: string;
  question: string;
  options: PanelAskOption[];
  selected?: string;
  custom?: string;
};


/**
 * L'outil `ask` du maillon (S-7) : enregistré TARDIVEMENT (`session_start`), et
 * seulement pour un run armé. Dans une session interactive, l'outil de l'hôte —
 * avec son dialogue riche — garde la main : l'extension n'enregistre rien.
 *
 * Le schéma vient du builder injecté (`pi.arktype`, dialecte omptype) : aucun
 * import de valeur depuis `@oh-my-pi/*`, comme tout le reste du dépôt.
 */
export function registerAskTool(pi: ExtensionAPI, deps: { notify?: (text: string) => void; stateDir: string }): void {
  // Une seule inscription par process : la seconde instance de l'extension
  // (plugin installé + `-e`) écraserait l'outil de la première, et une question
  // posée par l'une ne serait jamais résolue par la pompe de l'autre.
  if (runState.askTool) return;
  runState.askTool = true;
  const option = pi.arktype({ label: "string", "description?": "string" });
  const question = pi.arktype({
    id: "string",
    question: "string",
    "header?": "string",
    options: option.array(),
    "multi?": "boolean",
    "recommended?": "number",
  });
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description: ASK_TOOL_DESCRIPTION,
    approval: "read",
    // `essential` : la question part au premier niveau du schéma. Un outil
    // `discoverable` serait démonté sous `xd://` (réglage `tools.xdev`, actif par
    // défaut) et le maillon, qui n'a personne à qui demander, ne le trouverait pas.
    loadMode: "essential",
    parameters: pi.arktype({ questions: question.array() }),
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ExtensionContext) {
      const checked = checkAsk(params);
      if (!checked.ok) return { content: [{ type: "text" as const, text: checked.error }], isError: true };
      // Une seule question EN VOL à la fois : l'exécuteur de l'hôte peut lancer
      // deux appels `ask` dans le même tour, et le second écraserait le premier
      // (sa promesse ne serait jamais résolue, et le maillon attendrait jusqu'au
      // délai du run). `ToolDefinition` n'expose pas `concurrency` — l'`ask` de
      // l'hôte, lui, est `exclusive` — donc le refus est explicite, et le modèle
      // repose sa question après la réponse.
      if (runState.askWaiters.size > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: une question est déjà en vol — attends la réponse de l'utilisateur avant d'en poser une autre",
            },
          ],
          isError: true,
        };
      }
      const asked: PanelPendingAsk = { toolCallId, ...checked.ask };
      const publish = () =>
        publishCurrentCwd({ ctx: ctx as PipelineCtx, notify: deps.notify, stateDir: deps.stateDir });
      const answer = await new Promise<AskAnswer>((resolve, reject) => {
        const onAbort = () => {
          runState.askWaiters.delete(toolCallId);
          reject(new Error("ask interrompu : le run a été annulé"));
        };
        const settle = (value: AskAnswer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        runState.askWaiters.set(toolCallId, settle);
        if (signal?.aborted === true) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        runState.pendingAsk = asked;
        publish();
      }).finally(() => {
        runState.askWaiters.delete(toolCallId);
        runState.pendingAsk = null;
        publish();
      });
      if (answer.selected !== undefined) {
        const chosen = asked.options.find((candidate) => candidate.label === answer.selected);
        if (!chosen) {
          return { content: [{ type: "text" as const, text: `Error: unknown option ${answer.selected}` }], isError: true };
        }
        const details: AskToolDetails = {
          id: asked.id,
          question: asked.question,
          options: asked.options,
          selected: chosen.label,
        };
        return {
          content: [
            { type: "text" as const, text: `Question : ${asked.question}\nRéponse de l'utilisateur : ${chosen.label}` },
          ],
          details,
        };
      }
      const custom = (answer.custom ?? "").slice(0, LOT_EDITOR_MAX);
      const details: AskToolDetails = { id: asked.id, question: asked.question, options: asked.options, custom };
      return {
        content: [
          { type: "text" as const, text: `Question : ${asked.question}\nRéponse de l'utilisateur (texte libre) : ${custom}` },
        ],
        details,
      };
    },
  });
}
