// Panneau : rangs, modèle, gestes et aperçus.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { realpathOr, toSlug } from "./git.ts";
import { lotFeature, lotOwnerAlive, lotPathFor, lotRepoKey, lotStateLabel, lotTotals, lotWaitLabel, readLot, rowReply, runnable } from "./lot.ts";
import type { Lot, LotFeature, LotFeatureState } from "./lot.ts";
import type { AddFeatureInput } from "./lotController.ts";
import type { PanelTui } from "./panelHost.ts";
import { LIST_MODE_MAX_LINES, PANEL_NOTICE_MAX_LINES, PANEL_WRAP_MAX_LINES, ROW_PADDING_X, displayWidth, sectionSelection, serviceRow, textWindow, wrapVisible } from "./panelWidth.ts";
import type { TextWindow } from "./panelWidth.ts";
import type { WorktreeFate } from "./runs.ts";
import { asStringOrNull, elapsedLabel, pidAlive, reconcileStore } from "./store.ts";
import type { HistoryEntry, PipelineRunState, RunningEntry } from "./store.ts";



// ---------------------------------------------------------------------------
// Panneau des pipelines — un plein écran, pilotable au clavier ET à la souris.
// ---------------------------------------------------------------------------
// C'est un `ctx.ui.custom` avec `overlay: true` et `fullscreen: true` : le seul
// point de montage d'un composant maison en TUI (cf. `## Documentation` §1). Le
// plein écran emprunte le buffer alterné — le chat n'est plus visible derrière, et
// rien de l'écran normal n'est modifié. L'overlay prend le FOCUS : aucune touche
// n'atteint l'éditeur tant qu'il est ouvert, et `done` est le seul moyen de rendre
// le focus et le texte de l'éditeur.
//
// Le plein écran ouvre la SOURIS : `pi-tui` capture les rapports dès que l'overlay
// visible du dessus est plein écran et que `mouseTracking` n'est pas désactivé, et
// les remet à `handleInput` en SGR. Le décodage est local (`parseSgrMouse`, aucun
// import de valeur `@oh-my-pi/*`) et la résolution rang → rang sélectionnable passe
// par `PanelRow.target`, posé par le constructeur de rangs : la correspondance
// n'est jamais devinée à l'écran. Conséquence assumée : tant que le panneau est
// ouvert, la sélection de texte native du terminal est capturée par le panneau.
//
// La mise en page est une fonction PURE de rangs `{text, tone}` (aucun état, aucun
// accès disque), construite hors du composant et testable avec des glyphes ASCII —
// même séparation que `renderRecallRows` du plugin mémoire. Le composant ne fait
// que colorier EN BLOC : un rang, une couleur, donc aucun calcul ANSI — et il
// remplit la hauteur de l'écran, ce que le constructeur de rangs ne fait pas (son
// contrat « au plus `budget` rangs » est verrouillé par les tests).
//
// Le panneau est STRICTEMENT lecteur du magasin et du lot : il n'écrit ni entrée,
// ni lot, et n'arrête aucun run (hors `c`, l'annulation explicite).

export type PanelTone = "border" | "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text";

export type PanelRow = {
  /**
   * Le CONTENU du rang, jamais une ligne déjà mise au cadre (S-1) : le repli à la
   * largeur est le fait du `Text` de l'hôte, qui reçoit la largeur au rendu. Les
   * rangs de SERVICE (titre, pied, notice, zone) sont, eux, mesurés en amont par
   * `fit`/`clip` — ce sont des garde-fous, pas une composition concurrente.
   */
  text: string;
  tone: PanelTone;
  /**
   * L'index de SÉLECTION que ce rang représente (S-4) : posé par le constructeur
   * de rangs sur les rangs sélectionnables (feature du lot, entrée en cours,
   * entrée d'historique), absent partout ailleurs (cadre, titres, marqueurs,
   * notice, rangs de saisie, pied). Le clic résout sa cible par ce champ : la
   * correspondance rang → ligne n'est jamais devinée à l'écran.
   */
  target?: number;
  /**
   * La cible CLIQUABLE que ce rang représente (S-7) : l'index de l'OPTION dans la
   * zone de saisie (la correspondance rang → option n'est jamais devinée à
   * l'écran, comme pour `target`), ou la MENTION de pliage — le rang qui annonce
   * `ctrl+o déplier/replier` bascule l'état global de dépliage, exactement comme
   * la touche (S-4).
   */
  choice?: number | { kind: "expand" };
  /**
   * Le rang SÉLECTIONNÉ (S-1) : c'est lui que le composant peint avec le fond
   * `selectedBg` du thème — le curseur de sélection, lui, reste un préfixe de rang,
   * donc le curseur du terminal n'est jamais utilisé.
   */
  selected?: boolean;
  /**
   * Une RÈGLE du cadre (S-1) : le composant la rend en `DynamicBorder` coloré par
   * le thème ACTIF, jamais en `Text` — `frame` pour le haut et le bas du panneau,
   * `separator` pour la frontière entre « en cours » et « historique ».
   */
  rule?: "frame" | "separator";
  /**
   * Le rang de REMPLISSAGE : le composant le rend en `Spacer(n)`, la seule façon
   * d'occuper la hauteur sans peindre de blanc (le `Text` d'un texte vide ne rend
   * aucun rang). Il est posé juste avant le pied, pour que le pied soit en bas.
   */
  fill?: boolean;
};


/** Les glyphes injectés (S-1) : le curseur de sélection vient de `theme.nav.cursor`. */
export type PanelGlyphs = { cursor: string };


/**
 * L'état du PILOTE d'un lot (PANEL-4), tel que le panneau le calcule : `self` —
 * c'est cette session qui conduit ; `foreign` — un pid VIVANT et différent du
 * nôtre conduit (le panneau consulte) ; `dead` — personne ne conduit, le lot est
 * à l'arrêt et se reprend.
 */
export type PanelDriver = { kind: "self" } | { kind: "foreign"; pid: number } | { kind: "dead" };


/**
 * L'état du pilote d'un lot : notre pid, sinon la vivacité du propriétaire
 * (`lotOwnerAlive`, battement compris — un pid réutilisé après un redémarrage
 * n'est pas un pilote). Pur : il ne lit rien, il ne reprend rien.
 */
export function panelDriver(lot: Lot | null, now: number): PanelDriver | null {
  if (lot === null) return null;
  if (lot.owner.pid === process.pid) return { kind: "self" };
  return lotOwnerAlive(lot.owner, now) ? { kind: "foreign", pid: lot.owner.pid } : { kind: "dead" };
}


/** Le mot du pilote dans l'en-tête du lot (PANEL-4) : jamais un silence. */
export function driverLabel(driver: PanelDriver): string {
  switch (driver.kind) {
    case "self":
      return "pilote : cette session";
    case "foreign":
      return `piloté par pid ${driver.pid} — consultation`;
    case "dead":
      return "pilote absent — l reprend";
  }
}


export type PanelModel = {
  /**
   * Les entrées en cours NON appariées à une feature du lot : les runs d'autres
   * dépôts, les sessions hors lot. Une entrée appariée n'est pas ici — elle est
   * absorbée par le rang de sa feature (`live`), pour qu'une feature n'occupe
   * qu'une seule ligne.
   */
  running: RunningEntry[];
  /**
   * Les entrées en cours APPARIÉES à une feature du lot, indexées par
   * `feature.slug` : c'est le run qui écrit la session de ce rang, et c'est lui
   * qui lui donne son maillon, son état et son temps (S-1).
   */
  live: Record<string, RunningEntry>;
  history: HistoryEntry[];
  /**
   * Le lot du dépôt de la session, `null` s'il n'y en a pas : dans ce cas le
   * panneau rend exactement ce qu'il rendait avant les lots.
   */
  lot?: Lot | null;
  /** Le mode de saisie courant (`browse` : aucune saisie en cours). */
  mode?: LotPanelMode;
  /**
   * QUI PILOTE le lot (PANEL-4) : `null` quand il n'y a pas de lot. Sans cet
   * état, un lot à l'arrêt (pilote mort) se lisait comme un lot qui travaille —
   * horloge qui tourne comprise —, et le panneau d'une autre session annonçait
   * des gestes que le pilote refusait ensuite.
   */
  driver?: PanelDriver | null;
  /**
   * Index sur la liste concaténée
   * `[...features du lot, ...running NON appariés, ...history]`, borné, `-1` si vide.
   */
  selection: number;
  notice: string | null;
  unreadable: number;
};


/** Les modes du panneau : consulter, ajouter, choisir le sort d'un worktree, confirmer. */
export type LotPanelMode =
  | { kind: "browse" }
  | {
      kind: "add";
      step: "name" | "description" | "deps";
      draft: { name: string; description: string; deps: string };
      buffer: string;
      /**
       * La fenêtre du champ (S-2) : `follow` colle à la fin du tampon — là où le
       * curseur écrit —, `PageUp`/`PageDown` la remontent jusqu'à sa première ligne.
       */
      scroll?: TextWindow;
    }
  | { kind: "cancel"; slug: string; scroll?: TextWindow }
  | {
      /**
       * L'APERÇU (S-8) : le seul endroit d'où part une action. `back` est l'état
       * antérieur — `Échap` y revient, tampon compris (le champ d'un ajout, le
       * choix du devenir d'un worktree).
       */
      kind: "confirm";
      gesture: PanelGesture;
      back: LotPanelMode;
      /** La fenêtre de la tête d'aperçu (S-2), comme celle d'un champ. */
      scroll?: TextWindow;
    };


/**
 * Un geste qui change l'état du lot (S-8). Sa forme est une donnée pure : l'aperçu
 * est calculé sans monter le panneau, et c'est la MÊME description qui décide de
 * ce qui s'affiche et de ce qui part.
 */
export type PanelGesture =
  | { kind: "launch" }
  | { kind: "remove"; slug: string }
  | { kind: "relaunch"; slug: string; phase: PipelinePhase }
  | { kind: "validate"; slug: string }
  | { kind: "accept"; slug: string }
  | { kind: "cancel"; slug: string; fate: WorktreeFate }
  | { kind: "add"; input: AddFeatureInput };


/** Le libellé du devenir d'un worktree, tel qu'il s'annonce dans l'aperçu. */
export function fateLabel(fate: WorktreeFate): string {
  return fate === "keep" ? "gardé" : fate === "archive" ? "archivé" : "supprimé";
}


/** L'état d'une feature dans les mots du panneau (S-7, S-10) : jamais un état inventé. */
export function featureStateLabel(lot: Lot | null, feature: LotFeature): string {
  // Une feature `pending` que ses dépendances retiennent dit son ATTENTE, sans les
  // nommer : le libellé du rang les porte déjà (`lotFeatureLabel`), et la colonne
  // de droite ne les répète jamais (S-10) — les dépendances n'apparaissent qu'UNE
  // fois sur le rang.
  if (feature.state === "pending" && lot && !runnable(lot, feature)) return "en attente";
  return lotWaitLabel(feature.waitKind) ?? lotStateLabel(feature.state);
}


/** Le libellé de la feature d'un geste : son slug suffit à nommer la cible. */
export function gestureFeature(lot: Lot | null, slug: string): LotFeature | undefined {
  return lot?.features.find((feature) => feature.slug === slug);
}


/**
 * Le motif pour lequel l'aperçu d'un geste n'est PLUS valable (PANEL-9), ou `null`.
 * Entre l'ouverture de l'aperçu et l'`Entrée` qui le confirme, la liste se relit
 * (une fois par seconde) et le pilote agit : la feature peut avoir changé d'état ou
 * quitté le lot. Un aperçu qui décrit un état périmé fait croire que le geste fera
 * ce qu'il annonce — « valider les specs » d'une feature déjà annulée, par exemple.
 * Pur : il décide, il ne referme rien lui-même.
 */
export function staleGestureNotice(gesture: PanelGesture, lot: Lot | null): string | null {
  if (gesture.kind === "add") return null;
  if (gesture.kind === "launch") return lot === null ? "lot indisponible — aperçu fermé" : null;
  const feature = gestureFeature(lot, gesture.slug);
  if (!feature) return `${gesture.slug} a quitté le lot — aperçu fermé`;
  const holds =
    gesture.kind === "validate"
      ? feature.state === "waiting" && feature.waitKind === "specs"
      : gesture.kind === "accept"
        ? feature.state === "waiting" && feature.waitKind === "review"
        : gesture.kind === "relaunch"
          ? feature.state === "blocked" || feature.state === "failed"
          : gesture.kind === "remove"
            ? feature.state === "pending"
            : feature.state !== "done" && feature.state !== "cancelled";
  if (holds) return null;
  return `${gesture.slug} a changé d'état (${lotStateLabel(feature.state)}) — aperçu fermé`;
}


/**
 * L'aperçu d'un geste de la liste (S-8) : le rang de tête (ce qui va se passer) et
 * son aide (les touches). Pur : il ne lit rien et n'écrit rien — c'est ce que le
 * panneau rend AVANT d'agir, et rien n'a encore changé quand il s'affiche.
 */
export function gesturePreview(gesture: PanelGesture, lot: Lot | null): { head: string; hint: string } {
  const feature = "slug" in gesture ? gestureFeature(lot, gesture.slug) : undefined;
  const state = feature ? featureStateLabel(lot, feature) : "état inconnu";
  switch (gesture.kind) {
    case "launch": {
      const starting = (lot?.features ?? []).filter((f) => f.state === "pending" && (!lot || runnable(lot, f))).length;
      return {
        head: `Lancer le lot ? · ${starting} feature(s) à venir démarrent`,
        hint: "Entrée lancer · Échap annuler",
      };
    }
    case "remove":
      return {
        head: `Retirer ${gesture.slug} du lot ? · la feature quitte le lot, aucun run n'est lancé`,
        hint: "Entrée retirer · Échap annuler",
      };
    case "relaunch":
      return {
        head: `Relancer ${gesture.slug} ? · un nouveau run /${gesture.phase} démarre · ${state} → en cours`,
        hint: "Entrée relancer · Échap annuler",
      };
    case "validate":
      return {
        head: `Valider les specs de ${gesture.slug} ? · le maillon /impl démarre · ${state} → en cours`,
        hint: "Entrée valider · Échap annuler",
      };
    case "accept":
      return {
        head: `Accepter la revue de ${gesture.slug} ? · le maillon /release démarre : commit, push et PR · ${state} → en cours`,
        hint: "Entrée accepter · Échap annuler",
      };
    case "cancel":
      return {
        head: `Annuler ${gesture.slug} ? · ${state} → annulé · worktree ${fateLabel(gesture.fate)} · la branche reste`,
        hint: "Entrée annuler · Échap retour",
      };
    case "add": {
      const slug = toSlug(gesture.input.name) ?? gesture.input.name.trim();
      const description = gesture.input.description.trim();
      const deps = `${gesture.input.deps.length} dépendance(s)`;
      return {
        head: [`Créer ${slug} ?`, description, deps].filter((part) => part !== "").join(" · "),
        hint: "Entrée créer · Échap annuler",
      };
    }
  }
}


/**
 * L'aperçu d'une livraison depuis la VUE (S-6, S-7, S-8) : la réponse à une
 * question, le texte injecté dans un tour en cours, ou la mise en file quand un
 * run est en vol. Même contrat que `gesturePreview` — c'est la seule porte d'où
 * part une écriture vers le lot ou vers un run.
 *
 * `mode` ne vaut que pour une écriture dans une BOÎTE : `steer` (le message entre
 * dans le tour en cours) ou `ask` (il répond à la question en vol). Sans lui, les
 * deux formulations d'avant, à l'octet près.
 */
export function replyPreview(input: {
  slug: string;
  phase: PipelinePhase;
  text: string;
  queue: boolean;
  mode?: "steer" | "ask";
}): { head: string; hint: string } {
  const body = `« ${input.text} »`;
  if (input.mode === "steer") {
    // Le texte envoyé se LIT dans l'aperçu (VIEW-3) : on confirme ce qui part —
    // « injecté dans son tour en cours » sans le message laissait confirmer à
    // l'aveugle, et un reste de boîte partait au mauvais rang sans se voir.
    return {
      head: `Envoyer au maillon — injecté dans son tour en cours : ${body}`,
      hint: "Entrée envoyer · Échap revenir",
    };
  }
  if (input.mode === "ask") {
    return { head: `Répondre au maillon : ${input.text}`, hint: "Entrée envoyer · Échap revenir" };
  }
  if (input.queue) {
    return {
      head:
        `Mettre en file pour ${input.slug} · /${input.phase} : ${body} — le run en cours continue, ` +
        "le message part au prochain maillon",
      hint: "Entrée mettre en file · Échap modifier",
    };
  }
  return {
    head: `Envoyer à ${input.slug} · /${input.phase} : ${body}`,
    hint: "Entrée envoyer · Échap modifier",
  };
}


export const PANEL_REFRESH_MS = 1000;

export const PANEL_MIN_ROWS = 8;


/**
 * Le panneau occupe tout l'écran (S-4) : le budget est la hauteur du terminal,
 * sans plafond ni facteur — le TUI n'a plus rien à couper puisque le cadre EST
 * l'écran. Le plancher reste : sous `PANEL_MIN_ROWS`, le contenu déborde et c'est
 * le TUI qui coupe par le bas (dégradation admise, terminal minuscule). Un
 * `rows` absent, nul ou non fini retombe sur 24.
 */
export function panelBudget(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : 24;
  return Math.max(PANEL_MIN_ROWS, Math.floor(rows));
}


/**
 * La hauteur du cadre, en rangs : celle du terminal, ou le repli de 24. C'est elle
 * que le COMPOSANT remplit (S-1) : le constructeur de rangs, lui, ne connaît que
 * son budget et pose le rang de remplissage.
 */
export function panelHeight(tui: PanelTui): number {
  const rows = tui.terminal?.rows;
  return Number.isFinite(rows) && (rows as number) > 0 ? Math.floor(rows as number) : 24;
}


/** Rapport SGR de souris décodé (S-4) : `row`/`col` sont 0-based et indexent les rangs rendus. */
export type SgrMouseEvent = {
  row: number;
  col: number;
  /** -1 = vers le haut, 1 = vers le bas, `null` = pas une molette verticale. */
  wheel: -1 | 1 | null;
  leftClick: boolean;
  motion: boolean;
  release: boolean;
};


/** `ESC [ < bouton ; colonne ; ligne M|m` — la seule forme émise par `pi-tui`. */
export const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;


/**
 * Décodage LOCAL d'un rapport de souris (## Documentation §1) : le dépôt interdit
 * tout import de VALEUR depuis `@oh-my-pi/*`, donc le format et les bitwise de
 * `pi-tui/src/mouse.ts` sont réimplémentés ici, en fonction pure. `null` pour
 * toute autre donnée : le clavier suit alors son chemin normal.
 *
 * Les molettes HORIZONTALES (boutons 66/67) ne sont pas une direction : `wheel`
 * reste `null`, et le rapport est ignoré.
 */
export function parseSgrMouse(data: string): SgrMouseEvent | null {
  const match = SGR_MOUSE.exec(data);
  if (!match) return null;
  const button = Number(match[1]);
  const release = match[4] === "m";
  const wheel = (button & 64) !== 0 && (button & 2) === 0 ? ((button & 1) !== 0 ? 1 : -1) : null;
  return {
    row: Number(match[3]) - 1,
    col: Number(match[2]) - 1,
    wheel,
    motion: (button & 32) !== 0 && wheel === null,
    leftClick: !release && wheel === null && (button & 32) === 0 && (button & 3) === 0,
    release,
  };
}


export function clampSelection(selection: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isFinite(selection)) return 0;
  return Math.min(Math.max(Math.trunc(selection), 0), count - 1);
}


/** Déplacement borné, sans bouclage : on ne sort pas de la liste. */
export function moveSelection(selection: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  // `-1` = « rien de sélectionné » : se déplacer entre alors par le premier rang.
  const current = selection < 0 ? -1 : clampSelection(selection, count);
  return clampSelection(current + delta, count);
}


/**
 * Modèle du panneau : lecture du magasin, réconciliation des propriétaires morts,
 * lecture du lot du dépôt de la session, appariement lot ↔ entrées en cours, puis
 * borne de la sélection. C'est la seule fonction qui touche le disque (deux petits
 * fichiers : le magasin et le lot).
 */
export function readPanelModel(input: {
  stateDir: string;
  /** Racine du dépôt : absente, il n'y a pas de lot à afficher (rendu d'avant les lots). */
  repoRoot?: string;
  selection?: number;
  notice?: string | null;
  mode?: LotPanelMode;
  /** L'instant de la lecture : il départage le pilote (battement périmé). */
  now?: number;
}): PanelModel {
  const snapshot = reconcileStore(input.stateDir);
  const lotPath = input.repoRoot ? lotPathFor(input.stateDir, lotRepoKey(input.repoRoot)) : null;
  const lot = input.repoRoot ? readLot(input.stateDir, lotRepoKey(input.repoRoot)) : null;
  // Un fichier de lot PRÉSENT mais rejeté (JSON tronqué, `version` étrangère,
  // champ manquant) est un fichier illisible comme un autre : le panneau le dit
  // au lieu de retomber silencieusement sur son rendu d'avant les lots (S-1).
  const lotUnreadable = lot === null && lotPath !== null && fs.existsSync(lotPath) ? 1 : 0;
  const features = lot?.features ?? [];
  // APPARIEMENT (S-1) : l'entrée en cours du worktree d'une feature est absorbée
  // par son rang de lot — une feature n'occupe qu'une ligne, à tout instant de sa
  // vie. `worktree !== ""` n'est pas cosmétique : `realpathOr("")` vaut le cwd du
  // process, donc une feature `pending` (worktree vide) absorberait l'entrée du
  // dépôt principal et la ferait disparaître de la section « en cours ».
  // Au plus une entrée par feature (un fichier d'entrée par cwd) : si deux
  // features pointaient le même worktree, la première absorbe et l'entrée n'est
  // rendue qu'une fois.
  const live: Record<string, RunningEntry> = {};
  const running: RunningEntry[] = [];
  // Les worktrees réels sont calculés UNE fois (c'est un appel disque chacun) : le
  // panneau se rafraîchit à la seconde, un `realpathOr` par entrée × feature se
  // paierait à chaque passe pour rien.
  const worktrees = features
    .filter((f) => f.worktree !== "")
    .map((f) => ({ slug: f.slug, real: realpathOr(f.worktree) }));
  for (const entry of snapshot.running) {
    const real = realpathOr(entry.cwd);
    const feature = worktrees.find((w) => w.real === real);
    if (feature && !(feature.slug in live)) live[feature.slug] = entry;
    else running.push(entry);
  }
  const count = features.length + running.length + snapshot.history.length;
  return {
    running,
    live,
    history: snapshot.history,
    lot,
    // Le pilote se lit ICI, à chaque passe : la reprise d'un lot orphelin
    // (`adopt`) appartient au panneau monté, pas au modèle (PANEL-4).
    driver: panelDriver(lot, input.now ?? Date.now()),
    mode: input.mode ?? { kind: "browse" },
    selection: clampSelection(input.selection ?? 0, count),
    notice: input.notice ?? null,
    unreadable: snapshot.unreadable + lotUnreadable,
  };
}


// --- le rang sélectionnable : sa session, son cwd, la vivacité de son écrivain --

/** Un rang SÉLECTIONNABLE du panneau : une feature du lot, ou une entrée du magasin. */
export type PanelRowRef = LotFeature | RunningEntry | HistoryEntry;


/** Une feature du lot se reconnaît à son worktree ; une entrée du magasin a un `cwd`. */
export function isLotFeature(row: PanelRowRef): row is LotFeature {
  return "worktree" in row;
}


/** Le nombre de rangs sélectionnables : features du lot, puis entrées non appariées, puis historique. */
export function panelRowCount(model: PanelModel): number {
  return (model.lot?.features.length ?? 0) + model.running.length + model.history.length;
}


/** Le rang sélectionnable d'index `selection`, dans l'ordre de la liste. Pur, sans allocation. */
export function panelRowAt(model: PanelModel, selection: number): PanelRowRef | undefined {
  if (selection < 0) return undefined;
  const features = model.lot?.features ?? [];
  if (selection < features.length) return features[selection];
  const index = selection - features.length;
  if (index < model.running.length) return model.running[index];
  return model.history[index - model.running.length];
}


/**
 * La CLÉ STABLE d'un rang (PANEL-3) : son identité, pas sa position. La liste est
 * relue chaque seconde et son ordre bouge tout seul — une entrée d'historique
 * arrive à chaque fin de maillon (la plus récente en tête), un run qui change de
 * maillon repasse en fin de liste. Une sélection mémorisée par INDEX glissait donc
 * sur la ligne voisine, et `d` supprimait une entrée que l'utilisateur n'avait
 * jamais visée.
 */
export function panelRowKey(row: PanelRowRef): string {
  if (isLotFeature(row)) return `feature:${row.slug}`;
  return "finalState" in row ? `hist:${row.id}` : `run:${row.id}`;
}


/** La clé du rang SÉLECTIONNÉ, ou `null` (sélection vide). C'est elle qu'on mémorise. */
export function panelSelectionKey(model: PanelModel): string | null {
  const row = panelRowAt(model, model.selection);
  return row ? panelRowKey(row) : null;
}


/**
 * L'index du rang qui porte cette CLÉ, dans le modèle FRAIS : `fallback` (borné)
 * quand la ligne a disparu — on retombe alors sur la voisine, jamais sur rien.
 */
export function panelIndexForKey(model: PanelModel, key: string | null | undefined, fallback = 0): number {
  const count = panelRowCount(model);
  if (count <= 0) return -1;
  if (key !== null && key !== undefined) {
    for (let i = 0; i < count; i += 1) {
      const row = panelRowAt(model, i);
      if (row && panelRowKey(row) === key) return i;
    }
  }
  return clampSelection(fallback, count);
}


/** Le cwd d'un rang : le worktree de la feature, le cwd de l'entrée. `null` si indéterminé. */
export function rowCwd(row: PanelRowRef): string | null {
  if (!isLotFeature(row)) return asStringOrNull(row.cwd);
  return row.worktree === "" ? null : row.worktree;
}


/**
 * La session COURANTE d'un rang, quelle que soit sa section (S-1) : celle du run
 * apparié quand il y en a un, sinon celle portée par la feature, sinon celle de
 * l'entrée. `null` = ce rang n'a aucune session à montrer.
 */
export function rowSessionFile(model: PanelModel, row: PanelRowRef): string | null {
  if (!isLotFeature(row)) return asStringOrNull(row.sessionFile);
  return asStringOrNull(model.live[row.slug]?.sessionFile) ?? asStringOrNull(row.sessionFile);
}


/**
 * Le pid du process qui écrit DÉJÀ la session de ce rang, ou `null` (S-1) : c'est
 * lui que le refus nomme, et c'est la question dont dépendent les deux gardes de
 * `o` et la mention « run en cours » de la vue. Un run d'un AUTRE process — le
 * nôtre ne se concurrence pas lui-même — qui vise le même fichier de session, ou,
 * quand le run ne publie pas de fichier, le même cwd (refus par prudence : c'est
 * le worktree d'un run vivant).
 */
export function liveWriterPid(model: PanelModel, row: PanelRowRef): number | null {
  const file = rowSessionFile(model, row);
  const cwd = rowCwd(row);
  for (const entry of [...model.running, ...Object.values(model.live)]) {
    if (entry.owner.pid === process.pid || !pidAlive(entry.owner.pid)) continue;
    const target = asStringOrNull(entry.sessionFile);
    if (target !== null) {
      if (file !== null && realpathOr(target) === realpathOr(file)) return entry.owner.pid;
      continue;
    }
    if (cwd !== null && realpathOr(entry.cwd) === realpathOr(cwd)) return entry.owner.pid;
  }
  return null;
}


/** Un run VIVANT écrit-il la session de ce rang ? C'est la question des deux gardes de `o`. */
export function hasLiveWriter(model: PanelModel, row: PanelRowRef): boolean {
  return liveWriterPid(model, row) !== null;
}


/**
 * Le libellé d'un rang, tel que le panneau l'écrit : la ligne du lot, ou celle de
 * l'entrée du magasin.
 */
export function rowLabel(row: PanelRowRef): string {
  return isLotFeature(row) ? lotFeatureLabel(row) : row.label;
}


/** Le maillon d'un rang : celui du run apparié quand il y en a un, sinon le sien. */
export function rowPhase(model: PanelModel, row: PanelRowRef): PipelinePhase {
  return isLotFeature(row) ? (model.live[row.slug]?.phase ?? row.phase) : row.phase;
}


/**
 * L'état d'un run VIVANT dans les mots du panneau (PANEL-6) : une question `ask`
 * en vol est une ATTENTE DE RÉPONSE, pas l'inactivité d'un agent — « attend » est
 * le mot des runs qui n'attendent rien, et c'est celui qui cachait la question.
 */
export function liveStateLabel(live: Pick<RunningEntry, "state" | "pendingAsk">): string {
  if (live.pendingAsk) return "attend réponse";
  return live.state === "waiting" ? "attend" : "tourne";
}


/**
 * L'état d'un rang, dans les mots du panneau (S-1, S-9) : jamais un état inventé.
 * L'ordre est celui de S-9 — le JALON de la feature prime sur l'état de son run
 * apparié : une feature `waiting` dit ce qu'elle attend, que son run ait publié son
 * entrée ou non. Sans ça, le libellé basculait sous les yeux de l'utilisateur au
 * moment où le maillon publiait son entrée (« attend réponse » → « attend »).
 */
export function rowStateLabel(model: PanelModel, row: PanelRowRef): string {
  if (isLotFeature(row)) {
    const wait = lotWaitLabel(row.waitKind);
    if (wait !== null) return wait;
    const live = model.live[row.slug];
    if (live) return liveStateLabel(live);
    return featureStateLabel(model.lot ?? null, row);
  }
  if ("finalState" in row) return row.finalState === "done" ? "terminé" : "échoué";
  return liveStateLabel(row);
}


/** La notice d'un rang sans session (S-2) : le texte existant, par section. */
export function noSessionNotice(row: PanelRowRef): string {
  return isLotFeature(row)
    ? "cette feature n'a pas encore de session — attends son premier maillon"
    : "session introuvable — entrée non reprenable";
}


// --- la section « Lot » du panneau ------------------------------------------

/** Les dépendances d'une feature qui ne sont pas TERMINÉES, dans l'ordre déclaré. */
export function pendingDeps(lot: Lot, feature: LotFeature): string[] {
  return feature.deps.filter((dep) => lotFeature(lot, dep)?.state !== "done");
}


/**
 * Une feature que `l lancer` démarre (PANEL-8) : une feature `pending` que ses
 * dépendances laissent partir, ou une feature `running` SANS run vivant — la passe
 * du pilote relance celle-ci comme les autres, et l'annoncer comme « rien à
 * lancer » était faux.
 */
export function isLaunchable(lot: Lot, feature: LotFeature, live?: RunningEntry | null): boolean {
  if (feature.state === "pending") return runnable(lot, feature);
  return feature.state === "running" && !live;
}


/**
 * `<slug> ← deps` : la ligne d'une feature dit de quoi elle dépend — et, quand des
 * messages attendent leur prochain run, combien (S-5/S-7) : la file se voit dans
 * la LISTE, sans ouvrir la vue.
 */
export function lotFeatureLabel(feature: LotFeature): string {
  const base = feature.deps.length > 0 ? `${feature.slug} ← ${feature.deps.join(",")}` : feature.slug;
  const queued = feature.pendingTexts.length;
  if (queued === 0) return base;
  return `${base} · ${queued} message${queued > 1 ? "s" : ""} en attente`;
}


/**
 * Le TOUR de la boucle `/review` ⇄ `/impl --fix` (PANEL-5), quand il y a quelque
 * chose à lire : un tour de CORRECTION en cours dit lequel et sur quel plafond
 * (`fixes` passes consommées), une revue en cours dit son tour (`reviewRuns`).
 * Pur : tout vient du lot, rien d'une horloge.
 */
export function reviewLoopLabel(lot: Lot, feature: LotFeature): string | null {
  if (feature.state !== "running" && feature.state !== "waiting") return null;
  if (feature.phase === "impl" && feature.fixes > 0) return `--fix · tour ${feature.fixes + 1}/${lot.reviewCap}`;
  if (feature.phase === "review") return `tour ${feature.reviewRuns + 1}/${lot.reviewCap}`;
  return null;
}


/**
 * Le rang de la DERNIÈRE REVUE (PANEL-5) : le verdict BLOQUANT et son compte, tels
 * que le pilote les a posés. C'est ce qui rend la boucle lisible AVANT son
 * blocage — sans lui, chaque tour de correction se lisait comme un `/impl` neuf.
 */
export function reviewVerdictRow(feature: LotFeature): string | null {
  if (feature.lastVerdict !== "blockers") return null;
  const count = feature.lastBlockers ?? 0;
  return `dernière revue : ${count} bloquant${count > 1 ? "s" : ""}`;
}


/** Le rang de l'URL de PR d'une feature livrée (PANEL-7) : le README la promet. */
export function prRow(feature: LotFeature): string | null {
  if (feature.state !== "done") return null;
  const url = asStringOrNull(feature.prUrl);
  return url === null ? null : `PR : ${url}`;
}


/** La colonne de droite : maillon, état (le jalon nommé quand il y en a un), temps. */
export function lotFeatureRight(lot: Lot, feature: LotFeature, now: number): string {
  const state = featureStateLabel(lot, feature);
  const loop = reviewLoopLabel(lot, feature);
  const parts = [`/${feature.phase}`, state, elapsedLabel((feature.endedAt ?? now) - feature.sinceAt)];
  if (loop !== null) parts.push(loop);
  return parts.join(" · ");
}


/**
 * La colonne de droite d'une ENTRÉE en cours : même format que celle d'un rang de
 * lot, pour qu'une feature appariée à son run ne change pas de forme (S-1).
 */
export function entryRight(
  entry: { phase: PipelinePhase; state: PipelineRunState; phaseStartedAt: number; pendingAsk?: RunningEntry["pendingAsk"] },
  now: number,
): string {
  return `/${entry.phase} · ${liveStateLabel(entry)} · ${elapsedLabel(now - entry.phaseStartedAt)}`;
}


/**
 * La colonne de droite d'une feature APPARIÉE à son run (S-9) : le jalon de la
 * feature prime sur l'état du run (même ordre que `rowStateLabel`), et le temps
 * part de l'instant le PLUS ANCIEN des deux — publier une entrée ne fait jamais
 * reculer l'horloge, le rang garde donc le même motif d'attente et un temps qui ne
 * recule pas. Le tour de la boucle s'ajoute à la fin quand il y en a un (PANEL-5).
 */
export function pairedRight(lot: Lot, feature: LotFeature, live: RunningEntry, now: number): string {
  const state = lotWaitLabel(feature.waitKind) ?? liveStateLabel(live);
  const loop = reviewLoopLabel(lot, feature);
  const parts = [`/${live.phase}`, state, elapsedLabel(now - Math.min(feature.sinceAt, live.phaseStartedAt))];
  if (loop !== null) parts.push(loop);
  return parts.join(" · ");
}


export function lotStateTone(state: LotFeatureState): PanelTone {
  switch (state) {
    case "running":
      return "success";
    case "waiting":
      return "warning";
    case "blocked":
    case "failed":
      return "error";
    case "cancelled":
      return "muted";
    default:
      return "dim";
  }
}


/**
 * Le titre de la section du lot (S-10) : le dépôt, le nombre de features, puis la
 * RÉPARTITION — les cinq comptes d'états, toujours présents, dans l'ordre du récap
 * de fin de lot (`lotTotals`) et avec la convention de pluriel du dépôt
 * (`1 terminée`, `2 terminées`). Le titre dit donc la répartition, jamais un
 * sous-ensemble. Il dit aussi QUI PILOTE (PANEL-4) : un lot à l'arrêt et un lot
 * conduit ne se lisent pas de la même façon.
 */
export function lotSectionTitle(lot: Lot, driver?: PanelDriver | null): string {
  const totals = lotTotals(lot);
  const counted = (n: number, label: string) => `${n} ${label}${n > 1 ? "s" : ""}`;
  const parts = [`Lot · ${path.basename(lot.repoRoot)} · ${lot.features.length} features`];
  // Le pilote vient APRÈS la taille du lot : la RÉPARTITION reste la fin du titre
  // (elle est le contrat de `lot-ask/AC-22`), et « qui conduit » se lit avant elle.
  if (driver) parts.push(driverLabel(driver));
  parts.push(
    counted(totals.done, "terminée"),
    counted(totals.blocked, "bloquée"),
    counted(totals.failed, "échouée"),
    counted(totals.cancelled, "annulée"),
    `${totals.live} en cours`,
  );
  return parts.join(" · ");
}


/**
 * Le CONTENU et l'AIDE d'un mode de saisie (S-2) : le contenu se replie et se
 * FENÊTRE (`LIST_MODE_MAX_LINES`), l'aide se replie toujours EN ENTIER — elle
 * annonce les touches, elle n'est ni coupée ni fenêtrée. `browse` n'a ni l'un ni
 * l'autre. Une seule source pour le rendu et pour la fenêtre des touches de
 * défilement : les deux mesurent le MÊME texte.
 */
export function lotModeText(mode: LotPanelMode, lot: Lot | null): { content: string; tone: PanelTone; help: string[] } | null {
  if (mode.kind === "browse") return null;
  if (mode.kind === "confirm") {
    const preview = gesturePreview(mode.gesture, lot);
    return { content: preview.head, tone: "warning", help: [preview.hint] };
  }
  if (mode.kind === "cancel") {
    return {
      content: `Annuler ${mode.slug} ? worktree : 1 gardé · 2 archivé · 3 supprimé`,
      tone: "warning",
      help: ["la branche reste · 2 copie les ignorés · Échap annuler"],
    };
  }
  const field =
    mode.step === "name"
      ? "Nom"
      : mode.step === "description"
        ? "Description"
        : "Dépendances (slugs séparés par des virgules)";
  const next = mode.step === "deps" ? "créer la feature" : "champ suivant";
  return { content: `${field} : ${mode.buffer}▏`, tone: "text", help: [`Entrée ${next} · Échap annuler`] };
}


/**
 * Les rangs de la RÉGION DE SAISIE de la liste (S-2) : le contenu du mode courant,
 * fenêtré et ancré sur son curseur, puis ses lignes d'aide. Ce sont des rangs de
 * SERVICE : le budget du cadre les compte à leur hauteur repliée, et `PageUp` /
 * `PageDown` remontent la fenêtre du contenu quand elle déborde (S-2, BR-2).
 */
export function lotModeRows(mode: LotPanelMode, lot: Lot | null, innerW: number, height: number): PanelRow[] {
  if (mode.kind === "browse") return [];
  const parts = lotModeText(mode, lot);
  if (parts === null) return [];
  const content = serviceRow(parts.content, parts.tone, innerW);
  const rows = textWindow(content, LIST_MODE_MAX_LINES(height), content.length - 1, mode.scroll);
  for (const line of parts.help) rows.push(...serviceRow(line, "dim", innerW));
  return rows;
}


/**
 * Les touches qui s'appliquent à la ligne sélectionnée, dans l'ordre du pied. Ce
 * que la ligne ACCEPTE comme écriture vient de la règle unique (`rowReply`, S-11) :
 * une attente de réponse, une feature BLOQUÉE (sa réponse relance le maillon) et
 * une question `ask` en vol se répondent ; un run vivant armé reçoit un texte, et
 * sans boîte il le met en file. `live` est facultatif — sans lui, la règle est
 * celle d'avant le canal (une file), et l'appel à deux arguments reste valide.
 */
export function lotFooterActions(
  features: LotFeature[],
  selection: number,
  live?: Record<string, RunningEntry | undefined> | null,
): string {
  const feature = selection >= 0 && selection < features.length ? features[selection] : undefined;
  if (!feature) return "aucune action";
  const actions: string[] = [];
  const reply = rowReply(feature, live?.[feature.slug] ?? null);
  if (reply.kind === "reply" || reply.kind === "text" || reply.kind === "ask") actions.push("Entrée répondre");
  else if (reply.kind === "steer" || reply.kind === "queue") actions.push("Entrée écrire");
  if (feature.state === "waiting" && feature.waitKind === "specs") actions.push("v valider");
  if (feature.state === "waiting" && feature.waitKind === "review") actions.push("y accepter");
  if (feature.state === "blocked" || feature.state === "failed") actions.push("R relancer");
  if (feature.state === "pending") actions.push("x retirer");
  // L'abandon reste ouvert sur tout état qui n'est pas DÉJÀ clos (PANEL-11) : au
  // plafond de la boucle, `R` était la seule issue — et `R` remet les compteurs à
  // zéro, donc rouvre une boucle entière au lieu d'abandonner la feature.
  if (feature.state !== "done" && feature.state !== "cancelled") actions.push("c annuler");
  return actions.length > 0 ? actions.join(" · ") : "aucune action";
}


/**
 * La seconde ligne du pied : ce qui s'applique à la LIGNE SÉLECTIONNÉE, quelle
 * qu'elle soit. Un rang de lot passe par `lotFooterActions` ; une entrée
 * d'historique est le seul rang que `d` supprime ; un rang « en cours » n'offre
 * aucune action de ligne — et une sélection vide n'annonce rien. La bascule `o`
 * s'ajoute à la fin dès que le rang a une session ET qu'aucun run VIVANT ne
 * l'écrit déjà (PANEL-8 : la bascule refuserait, l'annoncer serait une touche
 * morte).
 */
export function panelFooterActions(model: PanelModel, runningCount: number): string {
  const features = model.lot?.features.length ?? 0;
  const selection = model.selection;
  const base =
    selection < features
      ? lotFooterActions(model.lot?.features ?? [], selection, model.live)
      : selection < features + runningCount
        ? "aucune action"
        : selection < features + runningCount + model.history.length
          ? "d supprimer"
          : "aucune action";
  const row = panelRowAt(model, selection);
  if (!row || rowSessionFile(model, row) === null || hasLiveWriter(model, row)) return base;
  // « aucune action » n'est pas une action : la ligne ne se contredit pas en
  // annonçant la bascule à côté d'un « aucune action ».
  return base === "aucune action" ? "o rejoindre" : `${base} · o rejoindre`;
}


/**
 * Le contenu d'un rang de pipeline (S-1, S-10) : `<label>` à gauche, `<droite>`
 * aligné à droite, curseur de sélection en tête. Le REPLI n'est pas fait ici —
 * c'est le `Text` de l'hôte qui replie à la largeur qu'il reçoit — donc la colonne
 * de droite reste sur la première ligne du rang, et un libellé plus long que la
 * place disponible passe simplement à la ligne au lieu d'être tronqué.
 *
 * Quand `<libellé>` + 1 + `<droite>` ne tient PAS dans la largeur de contenu,
 * l'entrée rend DEUX rangs : le libellé, puis la colonne de droite (préfixe de
 * sélection compris) — l'état et le temps ne sont jamais coupés en deux, et les
 * deux rangs portent la même cible de clic et le même surlignage (S-10).
 */
export function entryContent(label: string, right: string, selected: boolean, glyphs: PanelGlyphs, innerW: number): string[] {
  const prefix = selected ? `${glyphs.cursor} ` : " ".repeat(glyphs.cursor.length + 1);
  if (right === "") return [prefix + label];
  const room = Math.max(1, innerW - displayWidth(prefix));
  if (displayWidth(label) + 1 + displayWidth(right) > room) return [prefix + label, prefix + right];
  const gap = Math.max(1, room - displayWidth(label) - displayWidth(right));
  return [`${prefix}${label}${" ".repeat(gap)}${right}`];
}


/** Le rang de notice, unique, compose l'illisible et le message d'action. */
export function noticeText(model: PanelModel): string | null {
  const parts: string[] = [];
  if (model.unreadable > 0) {
    parts.push(`${model.unreadable} fichier(s) d'état illisible(s) — entrée(s) ignorée(s)`);
  }
  if (model.notice) parts.push(model.notice);
  return parts.length > 0 ? parts.join(" · ") : null;
}


/**
 * Une SECTION de la liste — le lot, les pipelines hors lot, l'historique : ses
 * entrées (une par rang sélectionnable, chacune avec ses rangs de service), son
 * indice de sélection (`-1` quand la sélection porte sur une autre section), la
 * place en LIGNES qu'elle paie au budget (`room`) et la FENÊTRE qu'elle en tire
 * (`plan`).
 */
type Section = { entries: PanelRow[][]; sel: number; name: string; room: number; plan: Plan };


/** La fenêtre d'une section : les entrées montrées, et les marqueurs qui se paient. */
type Plan = { start: number; end: number; above: boolean; below: boolean };


const EMPTY_PLAN: Plan = { start: 0, end: 0, above: false, below: false };


/**
 * Tous les rangs du panneau, DANS L'ORDRE : règle d'ouverture, titre, section du
 * lot, section « hors lot », séparateur, section « historique », notice (absente
 * si aucune), rangs de saisie, remplissage, pied (trois rangs), règle de
 * fermeture. Pur : le temps écoulé vient de `now`, jamais d'une horloge implicite.
 *
 * Chaque rang est SÉMANTIQUE (S-1) : `text` est le CONTENU du rang, pas une ligne
 * déjà mise au cadre — c'est le composant de l'hôte qui le rend (`DynamicBorder`
 * pour une règle, `Spacer` pour le remplissage, `Text` sinon), et le `Text` qui le
 * replie à la largeur qu'il reçoit.
 *
 * CHAQUE SECTION EST NOMMÉE (S-8) : un rang d'en-tête ouvre le lot, « hors lot » et
 * l'historique, et chaque marqueur de troncature nomme la section qu'il tronque.
 *
 * Le panneau tient dans `budget` LIGNES — le pied compris, c'est lui que le TUI
 * couperait par le bas. Le budget compte des lignes de TERMINAL, donc des rangs
 * repliés : `linesOf` mesure ce que le `Text` occupera, et les rangs de cadre
 * (`frameRows`) sont comptés à leur hauteur repliée, pas pour un. Une section
 * tronquée le dit par son marqueur, placé DU CÔTÉ des lignes masquées
 * (`… n au-dessus` / `… n de plus`) — jamais sous la liste quand elles sont
 * au-dessus (PANEL-12). Le surplus va par priorité au lot (la salle de contrôle),
 * puis aux pipelines en cours (vivants), puis à l'historique.
 *
 * La fenêtre de chaque section est construite AUTOUR de l'entrée sélectionnée
 * (PANEL-1, PANEL-2) : la ligne sélectionnée est TOUJOURS peinte, et la hauteur
 * rendue ne dépasse jamais le budget.
 */
export function buildPanelRows(
  model: PanelModel,
  opts: { width: number; budget: number; glyphs: PanelGlyphs; now: number; canDrive?: boolean },
): PanelRow[] {
  const width = Math.max(1, Math.floor(opts.width));
  const glyphs = opts.glyphs;
  const innerW = Math.max(0, width - ROW_PADDING_X * 2);
  const rows: PanelRow[] = [];
  const lot = model.lot ?? null;
  const mode = model.mode ?? { kind: "browse" };
  const notice = noticeText(model);
  // La fenêtre d'une région de saisie se mesure en hauteur de TERMINAL : le budget
  // reçu EST cette hauteur (`panelBudget`), avec son plancher.
  const modeRows = lotModeRows(mode, lot, innerW, opts.budget);
  const runningCount = model.running.length;
  const historyCount = model.history.length;
  const features = lot?.features.length ?? 0;
  // Le titre annonce les PROCESS vivants — entrées en cours non appariées + runs
  // appariés à une feature : c'est ce qu'il mesure, et il le dit (S-10). Aucun mot
  // d'état de feature n'y figure : « N en cours » se lisait comme le compte des
  // rangs « en cours ».
  const processes = runningCount + Object.keys(model.live).length;
  // QUI PILOTE (PANEL-4) : l'en-tête du lot le dit, et un pilote ÉTRANGER retire
  // les gestes du pied — le pilote les refuserait, les annoncer serait une touche
  // morte.
  const driver = model.driver ?? panelDriver(lot, opts.now);
  const foreign = driver?.kind === "foreign";
  const driveable = lot !== null && !foreign;

  // Les rangs de CADRE, construits d'abord : leur hauteur RÉELLE (repliée) est ce
  // que le budget doit réserver avant de servir la moindre entrée.
  const titleRows = serviceRow(`Pipelines · ${processes} processus`, "accent", innerW);
  const lotHeaderRows = lot ? serviceRow(lotSectionTitle(lot, driver), "accent", innerW) : [];
  const outHeaderRows = serviceRow(`Hors lot · ${runningCount}`, "accent", innerW);
  const historyHeaderRows = serviceRow(`Historique · ${historyCount}`, "accent", innerW);
  // La notice est un rang de SERVICE : elle se replie, bornée à
  // `PANEL_NOTICE_MAX_LINES` pour ne pas manger le budget de la liste — les
  // producteurs de notice n'atteignent pas cette borne (motifs de refus et messages
  // d'état plus courts), c'est une borne de sécurité.
  const noticeRows = notice ? serviceRow(notice, "warning", innerW, undefined, PANEL_NOTICE_MAX_LINES) : [];
  // Le pied a TOUJOURS trois rangs (S-7) : les touches du panneau, celles de la
  // LIGNE SÉLECTIONNÉE, et `Échap fermer`. `a` et `l` n'existent que si le panneau
  // peut réellement conduire le lot : un pilote injecté (`canDrive`), et personne
  // d'autre à la barre (PANEL-4). `l` ne s'annonce pas non plus quand il n'y a
  // rien à lancer (PANEL-8) — son aperçu le disait déjà.
  const launchable = lot !== null && (lot.status === "draft" || lot.features.some((f) => isLaunchable(lot, f, model.live[f.slug])));
  const footTop = driveable
    ? `a ajouter · ${launchable ? "l lancer · " : ""}Entrée session`
    : `↑↓ naviguer · Entrée session${opts.canDrive === true && lot === null ? " · a ajouter" : ""}`;
  const footRows = [
    ...serviceRow(footTop, "dim", innerW),
    ...serviceRow(panelFooterActions(model, runningCount), "dim", innerW),
    ...serviceRow("Échap fermer", "dim", innerW),
  ];
  const frameRows =
    2 +
    titleRows.length +
    lotHeaderRows.length +
    outHeaderRows.length +
    // Le SÉPARATEUR entre « hors lot » et l'historique est un rang de cadre, lui
    // aussi : l'oublier faisait dépasser le budget d'un rang.
    1 +
    historyHeaderRows.length +
    noticeRows.length +
    modeRows.length +
    footRows.length;

  // Les ENTRÉES du lot, dans l'ordre d'ajout : la salle de contrôle vient en tête.
  // Une entrée = un ou DEUX rangs (S-10) : le libellé, puis la colonne de droite
  // quand les deux ne tiennent pas ensemble ; l'arrêt d'une feature bloquée ou
  // échouée s'ajoute APRÈS, dans la même entrée (S-9).
  const lotEntries: PanelRow[][] = [];
  let lotOffset = 0;
  if (lot) {
    if (lot.features.length === 0) {
      lotEntries.push(serviceRow("aucune feature — a ajouter", "muted", innerW));
    } else {
      if (lot.status === "draft") {
        lotEntries.push(serviceRow("lot non lancé — l lancer", "muted", innerW));
      }
      // Les entrées de tête (état vide, lot non lancé) précèdent les features : la
      // fenêtre d'une section tronquée compte en entrées, la sélection en features.
      lotOffset = lotEntries.length;
      lot.features.forEach((feature, index) => {
        // Une feature appariée à son run prend son maillon, son état, son temps ET
        // son ton (S-1) : c'est le run qui travaille, c'est lui qui se lit.
        const live = model.live[feature.slug];
        const right = live ? pairedRight(lot, feature, live, opts.now) : lotFeatureRight(lot, feature, opts.now);
        const tone: PanelTone = live
          ? live.state === "waiting"
            ? "warning"
            : "success"
          : lotStateTone(feature.state);
        const selected = model.selection === index;
        const entry: PanelRow[] = entryContent(lotFeatureLabel(feature), right, selected, glyphs, innerW).map((text) => ({
          text,
          tone,
          target: index,
          selected,
        }));
        // Ce que la ligne CACHE (PANEL-5, PANEL-7, S-9) s'ajoute APRÈS elle, dans la
        // même entrée, avec la même cible de clic et le même surlignage : le verdict
        // de la dernière revue, la raison d'arrêt d'une feature bloquée ou échouée,
        // et l'URL de PR d'une feature livrée (le README la promet).
        const verdict = reviewVerdictRow(feature);
        if (verdict !== null) {
          entry.push(...serviceRow(verdict, "error", innerW, { target: index, selected }));
        }
        if ((feature.state === "blocked" || feature.state === "failed") && (feature.stopReason ?? "") !== "") {
          entry.push(...serviceRow(`arrêt : ${feature.stopReason}`, "error", innerW, { target: index, selected }));
        }
        const pr = prRow(feature);
        if (pr !== null) entry.push(...serviceRow(pr, "dim", innerW, { target: index, selected }));
        lotEntries.push(entry);
      });
    }
  }

  const runningEntries: PanelRow[][] = model.running.map((entry, index) => {
    const selected = model.selection === features + index;
    return entryContent(entry.label, entryRight(entry, opts.now), selected, glyphs, innerW).map((text) => ({
      text,
      tone: entry.state === "waiting" ? ("warning" as const) : ("success" as const),
      target: features + index,
      selected,
    }));
  });

  const historyEntries: PanelRow[][] = model.history.map((entry, index) => {
    const right = `/${entry.phase} · ${entry.finalState === "done" ? "terminé" : "échoué"}`;
    const selected = model.selection === features + runningCount + index;
    return entryContent(entry.label, right, selected, glyphs, innerW).map((text) => ({
      text,
      tone: entry.finalState === "done" ? ("dim" as const) : ("error" as const),
      target: features + runningCount + index,
      selected,
    }));
  });

  /** Les LIGNES qu'une entrée occupe une fois repliée par le `Text` : jamais zéro. */
  function linesOf(entry: PanelRow[]): number {
    let lines = 0;
    for (const row of entry) lines += Math.max(1, wrapVisible(row.text, innerW).length);
    return lines;
  }

  const rowsOf = (entries: PanelRow[][]): number => entries.reduce((count, entry) => count + linesOf(entry), 0);

  /**
   * La FENÊTRE d'une section dans `room` LIGNES (PANEL-1, PANEL-2) : elle naît de
   * l'entrée SÉLECTIONNÉE — jamais de la tête —, grandit vers le haut puis vers le
   * bas, et paie un rang par côté masqué. `sel < 0` (la sélection est ailleurs)
   * repart de la tête. Une section qui n'a pas la place de montrer son entrée de
   * tête ET de dire ce qu'elle cache se tait sur son entrée, jamais sur sa
   * troncature ; celle de la SÉLECTION, elle, garde son entrée quoi qu'il arrive :
   * c'est la ligne que l'utilisateur voit, et celle sur laquelle `d` agit.
   */
  const planSection = (entries: PanelRow[][], sel: number, room: number): Plan => {
    const n = entries.length;
    if (n === 0 || room <= 0) return EMPTY_PLAN;
    const lines = entries.map(linesOf);
    // Le coût d'une fenêtre : ses lignes, plus un rang par côté masqué.
    const cost = (from: number, to: number): number => {
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += lines[i] as number;
      return sum + (from > 0 ? 1 : 0) + (to < n ? 1 : 0);
    };
    if (cost(0, n) <= room) return { start: 0, end: n, above: false, below: false };
    const anchor = sel >= 0 ? sel : 0;
    let start = anchor;
    let end = anchor + 1;
    for (;;) {
      let grew = false;
      if (start > 0 && cost(start - 1, end) <= room) {
        start -= 1;
        grew = true;
      }
      if (end < n && cost(start, end + 1) <= room) {
        end += 1;
        grew = true;
      }
      if (!grew) break;
    }
    // Un marqueur n'est peint que s'il est PAYÉ, le bas d'abord (le sens de
    // lecture). Une section qui n'a pas la place de montrer son entrée de tête ET
    // de dire ce qu'elle cache se tait sur son ENTRÉE, jamais sur sa troncature
    // (revue n°3) — sauf celle de la SÉLECTION, qui garde sa ligne quoi qu'il
    // arrive (PANEL-2).
    const used = cost(start, end) - (start > 0 ? 1 : 0) - (end < n ? 1 : 0);
    let spare = room - used;
    const below = end < n && spare >= 1;
    if (below) spare -= 1;
    const above = start > 0 && spare >= 1;
    if (sel < 0 && !below) return { start: 0, end: 0, above: false, below: true };
    return { start, end, above, below };
  };

  let left = Math.max(0, opts.budget - frameRows);
  const credit = (want: number): number => {
    const paid = Math.min(want, Math.max(0, left));
    left -= paid;
    return paid;
  };

  // Les trois sections, dans l'ordre de la liste ; la sélection se résout par
  // section (`sectionSelection` rend `-1` quand elle porte sur une autre). `room`
  // est la place, en LIGNES, que chacune paie au budget, et `plan` la fenêtre
  // qu'elle en tire.
  const sections: [Section, Section, Section] = [
    { entries: lotEntries, sel: sectionSelection(model.selection, lotOffset, features), name: "le lot", room: 0, plan: EMPTY_PLAN },
    {
      entries: runningEntries,
      sel: sectionSelection(model.selection - features, 0, runningCount),
      name: "hors lot",
      room: 0,
      plan: EMPTY_PLAN,
    },
    {
      entries: historyEntries,
      sel: sectionSelection(model.selection - features - runningCount, 0, historyCount),
      name: "l'historique",
      room: 0,
      plan: EMPTY_PLAN,
    },
  ];
  const picked = sections.find((section) => section.entries.length > 0 && section.sel >= 0) ?? null;
  // 1. L'entrée SÉLECTIONNÉE d'abord (PANEL-2) : sa section paie son entrée
  //    entière. C'est ce qui garantit qu'une ligne sélectionnée est TOUJOURS
  //    peinte — les flèches entrent dans les sections repliées, et `d` agit sur
  //    cette ligne sans aperçu.
  if (picked) picked.room = credit(linesOf(picked.entries[picked.sel] as PanelRow[]));
  // 2. Puis le minimum « jamais muet » de chaque AUTRE section non vide : une
  //    entrée complète (ses rangs de repli compris), ou son marqueur. Sans lui, le
  //    budget servait les entrées du lot jusqu'à laisser la section « en cours »
  //    sans un rang ni un marqueur : un pipeline vivant disparaissait de l'écran
  //    alors que le titre en annonçait le compte (BLOQUANT 4, revue n°3).
  for (const section of sections) {
    if (section === picked || section.entries.length === 0) continue;
    section.room = credit(Math.min(PANEL_WRAP_MAX_LINES, linesOf(section.entries[0] as PanelRow[])));
  }
  // 3. Les marqueurs de la section sélectionnée — un par côté masqué, s'il reste de
  //    la place : ils disent ce que la fenêtre ne montre pas.
  if (picked) picked.room += credit(2);
  // 4. Le surplus, par priorité : le lot (la salle de contrôle), puis les pipelines
  //    en cours (vivants), puis l'historique, la plus récente d'abord.
  for (const section of sections) {
    if (section.entries.length === 0) continue;
    section.room += credit(Math.max(0, rowsOf(section.entries) - section.room));
  }
  for (const section of sections) section.plan = planSection(section.entries, section.sel, section.room);

  /**
   * Les rangs d'une section : son marqueur AU-DESSUS quand des lignes sont masquées
   * avant la fenêtre, ses entrées, puis son marqueur EN DESSOUS (PANEL-12 : le
   * décompte se lit du côté où les lignes manquent, jamais systématiquement sous
   * la liste). Le marqueur du bas garde son texte d'origine.
   *
   * Les marqueurs se paient D'ABORD (ils disent ce qui manque), puis les rangs de
   * liste : une entrée plus haute que la place laissée s'arrête à son premier rang
   * — c'est celui qui porte le curseur quand c'est la sélection, et la ligne
   * sélectionnée passe avant le budget (PANEL-2).
   */
  const pushSection = (section: Section): void => {
    const plan = section.plan;
    if (plan.above) {
      rows.push(...serviceRow(`… ${plan.start} au-dessus dans ${section.name}`, "dim", innerW));
    }
    const space = section.room - (plan.above ? 1 : 0) - (plan.below ? 1 : 0);
    const cursorAt = section.sel >= plan.start && section.sel < plan.end ? section.sel : -1;
    let used = 0;
    let stopped = false;
    for (let i = plan.start; i < plan.end && !stopped; i += 1) {
      const entry = section.entries[i] as PanelRow[];
      for (let n = 0; n < entry.length; n += 1) {
        const row = entry[n] as PanelRow;
        const lines = Math.max(1, wrapVisible(row.text, innerW).length);
        // Seul le rang qui PORTE le curseur est protégé : les rangs suivants de la
        // même entrée (raison d'arrêt, verdict, URL) cèdent la place au budget.
        const cursor = i === cursorAt && n === 0;
        if (!cursor && used + lines > space) {
          stopped = true;
          break;
        }
        rows.push(row);
        used += lines;
      }
    }
    if (plan.below) {
      rows.push(...serviceRow(`… ${section.entries.length - plan.end} de plus dans ${section.name}`, "dim", innerW));
    }
  };

  // 5. Les rangs d'ÉTAT VIDE (« aucune pipeline en cours », « aucun historique »)
  //    se paient comme les autres : ce sont eux qui, oubliés du calcul, faisaient
  //    dépasser le budget d'un rang par section vide et coupaient le pied
  //    (BLOQUANT 3 de la revue n°3). Sans budget pour eux, le titre de section dit
  //    déjà l'essentiel.
  const runningEmptyRows = serviceRow("aucune pipeline en cours", "muted", innerW);
  const historyEmptyRows = serviceRow("aucun historique", "muted", innerW);
  const runningEmpty = runningCount === 0 && credit(runningEmptyRows.length) === runningEmptyRows.length;
  const historyEmpty = historyCount === 0 && credit(historyEmptyRows.length) === historyEmptyRows.length;

  // Le cadre s'ouvre sur une règle de l'hôte, et le titre est le premier rang —
  // la disposition des blocs de commande d'OMP (`## Documentation` §1).
  const [lotSection, runningSection, historySection] = sections;
  rows.push({ text: "", tone: "border", rule: "frame" });
  rows.push(...titleRows);

  if (lot) {
    rows.push(...lotHeaderRows);
    pushSection(lotSection);
  }

  rows.push(...outHeaderRows);
  if (runningCount === 0) {
    if (runningEmpty) rows.push(...runningEmptyRows);
  } else {
    pushSection(runningSection);
  }

  rows.push({ text: "", tone: "border", rule: "separator" });

  rows.push(...historyHeaderRows);
  if (historyCount === 0) {
    if (historyEmpty) rows.push(...historyEmptyRows);
  } else {
    pushSection(historySection);
  }

  // GARDE-FOU (PANEL-1) : la comptabilité ci-dessus borne le corps, mais un rang
  // qui se replierait au-delà de ce que `linesOf` a mesuré ne doit jamais pousser
  // le pied hors de l'écran — c'est lui que l'hôte coupe par le bas. On retire les
  // derniers rangs de LISTE, jamais le cadre, la notice, la saisie ni le pied, et
  // jamais la ligne SÉLECTIONNÉE (PANEL-2).
  const tailLines = noticeRows.length + modeRows.length + footRows.length + 1;
  while (linesOf(rows) + tailLines > opts.budget) {
    let at = -1;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] as PanelRow;
      if (row.target !== undefined && row.selected !== true) {
        at = i;
        break;
      }
    }
    if (at < 0) break;
    rows.splice(at, 1);
  }

  for (const row of noticeRows) rows.push(row);
  for (const row of modeRows) rows.push(row);

  // Le REMPLISSAGE (S-1) : le composant le rend en `Spacer`, juste avant le pied —
  // le pied reste ainsi collé au bas de l'écran, comme la règle basse d'avant. Il
  // n'existe que s'il reste de la place : au-delà du budget, rien n'est inséré et
  // le TUI coupe par le bas (terminal plus court que le panneau).
  const used = linesOf(rows) + tailLines;
  if (opts.budget - used >= 1) rows.push({ text: "", tone: "dim", fill: true });

  for (const row of footRows) rows.push(row);
  rows.push({ text: "", tone: "border", rule: "frame" });

  return rows;
}
