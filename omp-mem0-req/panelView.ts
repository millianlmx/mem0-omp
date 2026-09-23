// Panneau : état de la vue de session et de sa zone de saisie.
import type { KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import type { PipelinePhase } from "./contract.ts";
import { lotReplyRefusal, runnable } from "./lot.ts";
import type { Lot, LotFeature } from "./lot.ts";
import type { LotPanelActions } from "./lotController.ts";
import type { HostComponents, SessionAssembly } from "./panelHost.ts";
import { pendingDeps, replyPreview } from "./panelRows.ts";
import type { PanelGlyphs, PanelRow } from "./panelRows.ts";
import type { SessionEntryLike, SessionTail } from "./panelSession.ts";
import { clip, displayWidth, serviceRow } from "./panelWidth.ts";
import type { TextWindow } from "./panelWidth.ts";
import type { PanelAskOption } from "./store.ts";



/**
 * Surface de `KeybindingsManager` réellement utilisée par le panneau. Le nom du
 * keybinding est DÉRIVÉ de la signature de l'hôte (jamais réinventé) : un
 * paramètre plus large rendrait la fabrique non assignable à `ctx.ui.custom`.
 */
export type HostKeybinding = Parameters<KeybindingsManager["matches"]>[1];

export type PanelKeybindings = { matches?: (data: string, keybinding: HostKeybinding) => boolean };


export type PanelComponent = {
  render(width: number): string[];
  handleInput(data: string): void;
  /** Relecture du magasin — c'est exactement ce que déclenche le rafraîchissement périodique. */
  refresh(): void;
  dispose(): void;
};


export type PipelinesPanelDeps = {
  stateDir: string;
  /**
   * Le kit de composants de l'hôte (S-1) : le panneau ne rend RIEN sans lui, et
   * c'est la seule source du rendu. `null` (kit incomplet, ou `pi.pi` absent) fait
   * refuser l'ouverture, avec le message de S-1 — jamais un rendu de repli.
   */
  components: HostComponents | null;
  /** Racine du dépôt : c'est elle qui identifie le lot que le panneau pilote. */
  repoRoot?: string;
  /**
   * Les actions du lot ; absentes, le panneau reste en consultation (comportement
   * d'avant les lots). `adopt` (PANEL-4) reprend un lot dont le pilote est mort : le
   * panneau l'appelle au battement, parce que c'est le seul endroit qui relit le lot
   * en continu.
   */
  lot?: LotPanelActions & { adopt?: () => boolean };
  /** Horloge du temps écoulé : injectée, le temps affiché est donc testable. */
  now?: () => number;
  /** Ordonnanceur du rafraîchissement ; renvoie de quoi l'arrêter. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /**
   * Rejoint la session d'un rang (feature du lot, entrée en cours, historique) :
   * la bascule réelle de `o`, qui ne reçoit qu'un fichier de session.
   */
  join: (entry: { sessionFile?: string | null }, close: () => void, showNotice: (message: string) => void) => void;
  /**
   * Le fichier de la session COURANTE de ce process (`ctx.sessionManager`), capturé
   * au montage : viser sa propre session est refusé (S-3, garde 2), parce que
   * `switchSession` avorte le tour courant avant même de regarder la cible. Absent
   * (contexte dégradé), la garde ne se déclenche pas.
   */
  currentSessionFile?: string | null;
  /**
   * Reprend une session TERMINÉE hors lot par un nouveau run (S-9) : lance
   * `omp --resume <session>` sur ce cwd, avec la boîte passée dans la cible, et
   * rend `null` une fois le run parti — sinon le motif du refus, affiché dans la
   * zone. Absente (panneau de consultation), un rang d'historique reste fermé.
   */
  sessionReply?: (
    target: { cwd: string; sessionFile: string; label: string; phase: PipelinePhase; inbox: string },
    text: string,
  ) => Promise<string | null>;
};


/**
 * La sélection du panneau, mémorisée par RACINE DE DÉPÔT (S-5) et par CLÉ DE RANG
 * (PANEL-3) : fermer puis rouvrir rend le panneau sur la même ligne, sans commande à
 * retaper — et une liste qui bouge toute seule (une entrée d'historique par fin de
 * maillon, un run qui change de maillon et repasse en fin de liste) ne fait plus
 * glisser la sélection sur la ligne voisine, ce qui faisait supprimer une entrée
 * jamais visée. En mémoire de process seulement — aucun fichier, aucune config,
 * aucun partage entre process.
 */
export const panelSelections = new Map<string, string>();


/**
 * L'état d'un rang de LOT qui n'accepte aucune écriture (S-10) : la raison exacte,
 * écrite en toutes lettres dans la zone. Jamais un champ grisé — un champ absent
 * est plus honnête qu'un champ qui refuse.
 */
export function readOnlyReason(lot: Lot | null, feature: LotFeature): string {
  if (feature.state === "pending" && lot && !runnable(lot, feature)) {
    // Une feature qui attend ses dépendances nomme la TOUCHE qui la lance : c'est le
    // seul état où le refus porte une action.
    return `en attente de ${pendingDeps(lot, feature).join(",")} : L la lance, R la relance`;
  }
  if (feature.state === "waiting") {
    if (feature.waitKind === "specs") return "les spécifications attendent ta validation (v)";
    if (feature.waitKind === "review") return "la revue attend ton accord (y)";
  }
  // Tous les autres états passent par le libellé PARTAGÉ du refus d'écriture : une
  // seule phrase décide du texte, et elle est grammaticale dans tous les cas —
  // l'ancien gabarit `la feature est ${lotStateLabel}` produisait « la feature est
  // échouée », « la feature est attend ».
  return lotReplyRefusal(feature.state);
}


/**
 * Où part une livraison de la vue (S-6, S-9) : dans le lot (une réponse qui met
 * en file ou relance un maillon), dans la BOÎTE d'un run vivant (un texte injecté
 * dans son tour, ou la réponse à sa question), ou dans une session terminée (un
 * nouveau run qui la reprend). C'est la cible qui décide du chemin d'écriture, et
 * elle vient de la règle unique (`rowReply`, ou l'état du rang).
 */
export type ViewTarget =
  | { kind: "lot"; slug: string }
  | { kind: "inbox"; dir: string }
  | { kind: "session"; cwd: string; sessionFile: string; label: string };


/**
 * L'état de la zone de saisie d'une vue (S-3, S-4, S-6, S-7, S-8, S-10) : fermée
 * (la raison est écrite), ouverte (liste d'options, éditeur libre), ou en aperçu.
 */
export type ViewInputZone = {
  kind: "input";
  /** Le libellé de la cible : c'est lui que la livraison nomme. */
  slug: string;
  phase: PipelinePhase;
  /**
   * Les options proposées ; vide ⇒ éditeur libre (S-4). Une option d'un `ask`
   * porte la DESCRIPTION que le maillon a fournie (S-5) : la zone la rend sous le
   * libellé, et la livraison n'envoie jamais que le libellé.
   */
  options: PanelAskOption[];
  /** L'option courante ; `options.length` = la ligne « autre — saisir ma réponse ». */
  cursor: number;
  /** L'éditeur de texte a le focus (état « libre ») ; sinon la liste d'options l'a. */
  free: boolean;
  buffer: string;
  /** La livraison part dans la FILE (run en vol, S-5) au lieu d'être une réponse. */
  queue: boolean;
  /** La question en vol, affichée en tête de zone (S-7) ; `null` hors d'une question `ask`. */
  question: string | null;
  /** L'appel `ask` auquel la réponse répond (S-7) ; `null` pour un texte. */
  toolCallId: string | null;
  /** La fenêtre de la zone (S-2, S-4) : `PageUp`/`PageDown` la remontent. */
  scroll: TextWindow;
  target: ViewTarget;
};


export type ViewZone = { kind: "closed"; reason: string } | ViewInputZone | { kind: "preview"; input: ViewInputZone; text: string };


/** L'état de la zone a-t-il CHANGÉ DE SOURCE ? Le tampon, lui, appartient à l'utilisateur. */
export function sameZoneSource(a: ViewZone, b: ViewZone): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "closed" && b.kind === "closed") return a.reason === b.reason;
  if (a.kind === "input" && b.kind === "input") {
    // Les options se comparent par COUPLE `(label, description)` : une description
    // qui apparaît ou change est un changement de source, une simple réécriture du
    // même libellé n'en est pas un (S-5).
    const sameOptions =
      a.options.length === b.options.length &&
      a.options.every((option, index) => {
        const other = b.options[index];
        return other !== undefined && option.label === other.label && (option.description ?? "") === (other.description ?? "");
      });
    return (
      a.slug === b.slug &&
      a.queue === b.queue &&
      a.question === b.question &&
      a.toolCallId === b.toolCallId &&
      a.target.kind === b.target.kind &&
      sameOptions
    );
  }
  return true; // deux aperçus : rien à rafraîchir, l'aperçu ne se réécrit pas sous les doigts
}


/** Une zone ouverte, dans son état initial : options s'il y en a, éditeur libre sinon. */
export function inputZone(input: {
  slug: string;
  phase: PipelinePhase;
  options: PanelAskOption[];
  queue: boolean;
  target: ViewTarget;
  question?: string | null;
  toolCallId?: string | null;
}): ViewInputZone {
  return {
    kind: "input",
    slug: input.slug,
    phase: input.phase,
    options: input.options,
    cursor: 0,
    free: input.options.length === 0,
    buffer: "",
    queue: input.queue,
    question: input.question ?? null,
    toolCallId: input.toolCallId ?? null,
    scroll: { follow: true, offset: 0 },
    target: input.target,
  };
}


/** L'aperçu d'une livraison, tel que la zone le rend (S-6, S-7, S-8) — une seule source du texte. */
export function zonePreview(zone: { input: ViewInputZone; text: string }): { head: string; hint: string } {
  const input = zone.input;
  if (input.target.kind === "inbox") {
    // Une boîte : le message entre dans le TOUR en cours (texte), ou répond à la
    // question en vol (`ask`) — deux formulations, jamais l'une pour l'autre.
    return replyPreview({
      slug: input.slug,
      phase: input.phase,
      text: zone.text,
      queue: false,
      mode: input.toolCallId === null ? "steer" : "ask",
    });
  }
  return replyPreview({ slug: input.slug, phase: input.phase, text: zone.text, queue: input.queue });
}


/**
 * Les touches de la vue que les keybindings de l'hôte ne nomment pas (S-6, S-7).
 * `matchesKey` de pi-tui vit dans un module NATIF, hors de portée d'une extension
 * (`## Documentation` §2) : les séquences sont donc locales, et couvrent les deux
 * encodages que les terminaux envoient — `CSI 1;2 A/B` (xterm, kitty, VTE) et
 * `CSI 2 A/B` (terminaux historiques) pour le défilement rapide, `CSI H/F`,
 * `CSI 1~/4~` et `SS3 H/F` pour début et fin.
 */
export const FAST_SCROLL_LINES = 5;

/** Le facteur de la molette : 3 rangs par cran, comme le lecteur plein écran de l'hôte. */
export const WHEEL_SCROLL_LINES = 3;

/** Le repli de `app.tools.expand` quand les keybindings ne le résolvent pas (S-4). */
export const EXPAND_KEY = "\u000f";

export const SHIFT_UP_KEYS = ["\u001b[1;2A", "\u001b[2A"];

export const SHIFT_DOWN_KEYS = ["\u001b[1;2B", "\u001b[2B"];

export const HOME_KEYS = ["\u001b[H", "\u001b[1~", "\u001bOH", "\u001b[7~"];

export const END_KEYS = ["\u001b[F", "\u001b[4~", "\u001bOF", "\u001b[8~"];


/**
 * Les rangs de la zone de saisie de la vue, selon son état (S-2, S-4, S-5) : ce
 * sont des rangs de SERVICE — le texte se replie EN ENTIER, et le budget du cadre
 * les compte à cette hauteur. La fonction rend aussi le FOCUS : l'index de la
 * DERNIÈRE ligne de l'élément actif (le bloc de l'option sélectionnée, description
 * comprise ; la dernière ligne du tampon en éditeur libre ; la dernière ligne de la
 * tête en aperçu) — c'est lui qui ancre la fenêtre (S-4).
 */
export function viewZoneRows(zone: ViewZone, glyphs: PanelGlyphs, innerW: number): { rows: PanelRow[]; focus: number } {
  if (zone.kind === "closed") {
    const rows = serviceRow(`lecture seule — ${zone.reason}`, "dim", innerW);
    return { rows, focus: 0 };
  }
  if (zone.kind === "preview") {
    // L'aperçu ne peint que sa TÊTE (S-5) : l'indice vit au pied, peint UNE fois.
    const head = serviceRow(zonePreview(zone).head, "warning", innerW);
    return { rows: head, focus: head.length - 1 };
  }
  const rows: PanelRow[] = [];
  // La question ouvre la zone dans les DEUX états (S-5) : elle reste affichée
  // AU-DESSUS de l'éditeur libre, pas seulement au-dessus de la liste d'options —
  // on répond à CE qui est demandé pendant qu'on le rédige.
  const questionRows = zone.question === null ? [] : serviceRow(`question : ${zone.question}`, "dim", innerW);
  rows.push(...questionRows);
  if (zone.free || zone.options.length === 0) {
    const answerRows = serviceRow(`Réponse : ${zone.buffer}▏`, "text", innerW);
    rows.push(...answerRows);
    const verb = zone.queue ? "mettre en file" : "envoyer";
    // Le rang d'aide dit l'effet RÉEL d'`Échap` (S-7, VIEW-14) : devant une liste
    // d'options il REMONTE aux options, et le brouillon est conservé — « revenir au
    // panneau » était faux dans ce cas, et « annuler » l'était déjà.
    const back = zone.options.length > 0 ? "Échap revenir aux options" : "Échap revenir au panneau";
    rows.push(...serviceRow(`Entrée ${verb} · ${back}`, "dim", innerW));
    return { rows, focus: questionRows.length + answerRows.length - 1 };
  }
  const marker = (selected: boolean) => (selected ? `${glyphs.cursor} ` : " ".repeat(glyphs.cursor.length + 1));
  let focus = rows.length - 1;
  zone.options.forEach((option, index) => {
    const selected = index === zone.cursor;
    rows.push(
      ...serviceRow(`${marker(selected)}(${index + 1}) ${option.label}`, selected ? "accent" : "text", innerW, {
        choice: index,
      }),
    );
    // La description que le maillon a fournie se lit sous son libellé, repliée en
    // entier (S-5) — et le rang reste cliquable comme l'option qu'il décrit.
    if (option.description !== undefined && option.description !== "") {
      rows.push(...serviceRow(`   ${option.description}`, "dim", innerW, { choice: index }));
    }
    if (selected) focus = rows.length - 1;
  });
  const other = zone.cursor === zone.options.length;
  rows.push(
    ...serviceRow(`${marker(other)}autre — saisir ma réponse`, other ? "accent" : "text", innerW, {
      choice: zone.options.length,
    }),
  );
  if (other) focus = rows.length - 1;
  return { rows, focus };
}


/**
 * Le pied de la vue, selon l'état de sa zone (S-7) : il nomme EXACTEMENT les
 * touches actives de l'état courant, et il mentionne `ctrl+o déplier/replier` dans
 * TOUS les états — c'est ce rang qui porte la cible cliquable de la bascule globale
 * (S-4, S-7), donc le rang du pied reste cliquable partout.
 */
export function viewFooter(zone: ViewZone, overflow: boolean): string {
  const expand = "ctrl+o déplier/replier";
  if (zone.kind === "preview") return `${zonePreview(zone).hint} · ${expand}`;
  if (zone.kind === "input" && !zone.free && zone.options.length > 0) {
    return `1-9/↑↓ choisir · PageUp/PageDown défiler · ${expand} · Échap revenir au panneau`;
  }
  // Éditeur libre (et zone fermée) : le défilement de la transcription, la bascule
  // globale, la sortie — plus, quand la zone dépasse sa fenêtre, les deux touches
  // qui la font défiler elle (S-2, S-7). Devant une liste d'options, `Échap` REMONTE
  // aux options (VIEW-14) : le pied dit la touche qu'il traite, jamais l'autre.
  const back = zone.kind === "input" && zone.free && zone.options.length > 0
    ? "Échap revenir aux options"
    : "Échap revenir au panneau";
  return `↑↓/molette défiler · ${expand} · ${back}${
    overflow ? " · PageUp/PageDown défiler la réponse" : ""
  }`;
}


/**
 * La fenêtre de défilement d'une zone de la vue (S-2) : celle de son éditeur, que
 * la zone soit en saisie ou en aperçu — l'aperçu garde la fenêtre de la réponse
 * qu'il montre.
 */
export function zoneScrollOf(zone: ViewZone): TextWindow | undefined {
  if (zone.kind === "closed") return undefined;
  return zone.kind === "preview" ? zone.input.scroll : zone.scroll;
}


/**
 * La transcription d'une vue ouverte (S-3, S-5, S-8) : ce que le lecteur a chargé,
 * ce que l'assembleur en a fait, et la FENÊTRE — le suivi de queue, ou l'ancre du
 * premier rang affiché quand l'utilisateur a remonté.
 */
export type ViewTranscript = {
  /** Le fichier suivi ; `null` quand le rang n'en a pas (S-3 cas 4). */
  sessionFile: string | null;
  /** Le cwd du rang : celui des cartes d'outils (le rendu d'un diff s'y rapporte). */
  cwd: string;
  /** L'état du lecteur (identité, offset, sondes), ou `null` si rien n'a pu être lu. */
  tail: SessionTail | null;
  /** Les entrées chargées, dans l'ordre du fichier, bornées (S-8). */
  entries: SessionEntryLike[];
  /** Le DÉBUT du fichier n'est pas chargé : la vue le dit (`… début tronqué`). */
  truncated: boolean;
  /** Il reste des octets avant la fenêtre : `Début` peut les charger (S-8). */
  more: boolean;
  /** Le chemin, quand rien n'a pu être lu (absent, illisible). */
  error: string | null;
  /** L'assemblage courant : ses composants, son cache, l'état de dépliage global. */
  assembly: SessionAssembly | null;
  /** Le nombre de lignes rendues par composant, pour la largeur courante (S-8). */
  counts: number[];
  /** La largeur à laquelle `counts` a été mesuré (0 = jamais). */
  countsWidth: number;
  /** Le suivi de queue (S-5) : vrai, la fenêtre colle au bas de la transcription. */
  followBottom: boolean;
  /** Le premier rang affiché, ancré : il ne bouge pas quand du contenu arrive (S-5). */
  offsetLines: number;
  /**
   * Le rang de SERVICE du maillon suivi (VIEW-1) : non nul quand la vue a REBÂTI sa
   * transcription sur un fichier de session neuf — la chaîne a changé de maillon, et
   * la vue le dit en toutes lettres au lieu de laisser croire qu'elle suit encore le
   * précédent. `null` à l'ouverture : rien n'a encore changé sous les yeux.
   */
  link: string | null;
};


/** L'état de vue du panneau : la liste, ou la transcription d'une session (S-3). */
export type PanelView =
  | { kind: "list" }
  | {
      kind: "session";
      /** Le slug de la feature du lot visée ; `null` pour une entrée du magasin. */
      slug: string | null;
      /**
       * L'identité du rang du MAGASIN suivi (`running/<id>.json` ou
       * `history/<id>.json`), `null` pour une feature du lot (VIEW-13) : un run
       * vivant qui n'a pas encore publié de fichier de session n'a AUCUNE session à
       * nommer, et le retrouver par son seul fichier faisait perdre la vue dès la
       * première passe (« run en cours » + « session terminée »).
       */
      rowId: string | null;
      /** Le cwd du rang suivi : il départage un rang du magasin sans session (VIEW-13). */
      rowCwd: string | null;
      label: string;
      phase: string;
      state: string;
      /** `hasLiveWriter` au moment du rendu : un run écrit-il cette session ? */
      live: boolean;
      /** La transcription : le lecteur, l'assembleur et la fenêtre. */
      transcript: ViewTranscript;
      /** La zone de saisie, ou sa raison d'être fermée (S-11). */
      zone: ViewZone;
    };


/** `unref` — un rafraîchissement de panneau ne doit pas retenir le processus. */
export function unrefTimer(timer: unknown): void {
  if (timer && typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
}


/** Minuterie de rafraîchissement ; l'arrêt est rendu à l'appelant (`dispose`). */
export function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setInterval(callback, ms);
  unrefTimer(timer);
  return () => clearInterval(timer);
}


/**
 * Le rang d'erreur d'un composant qui a jeté au `render` (S-1 « Cas limites ») :
 * UNE ligne lisible, à la largeur reçue, là où le composant fautif aurait été
 * peint. Le panneau reste ouvert et ce qui a échoué se lit — jamais une sortie
 * brutale de l'overlay (l'hôte n'attrape pas : `tui.ts:2501` rend le composant à nu).
 */
export function unreadableLine(what: string, error: unknown, width: number): string {
  const message = error instanceof Error && error.message !== "" ? error.message : String(error);
  const room = Math.max(1, Math.floor(width));
  const line = clip(` entrée illisible — ${what} : ${message === "" ? "erreur sans message" : message}`, room);
  return line + " ".repeat(Math.max(0, room - displayWidth(line)));
}


/** Le nom du composant fautif, pour son rang d'erreur — jamais vide. */
export function componentLabel(component: unknown, index: number): string {
  const name = component && typeof component === "object" && "constructor" in component ? component.constructor.name : "";
  return typeof name === "string" && name !== "" ? name : `composant ${index + 1}`;
}
