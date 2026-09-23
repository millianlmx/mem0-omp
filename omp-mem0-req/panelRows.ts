// Panneau : rangs, modèle, gestes et aperçus.
import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelinePhase } from "./contract.ts";
import { realpathOr, toSlug } from "./git.ts";
import { lotFeature, lotPathFor, lotRepoKey, lotStateLabel, lotStateTerminal, lotTotals, lotWaitLabel, readLot, runnable } from "./lot.ts";
import type { Lot, LotFeature, LotFeatureState } from "./lot.ts";
import type { AddFeatureInput } from "./lotController.ts";
import type { PanelTui } from "./panelHost.ts";
import { LIST_MODE_MAX_LINES, PANEL_NOTICE_MAX_LINES, PANEL_WRAP_MAX_LINES, ROW_PADDING_X, displayWidth, sectionSelection, serviceRow, textWindow, windowStart, wrapVisible } from "./panelWidth.ts";
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
    return { head: "Envoyer au maillon — injecté dans son tour en cours", hint: "Entrée envoyer · Échap revenir" };
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
    if (live) return live.state === "waiting" ? "attend" : "tourne";
    return featureStateLabel(model.lot ?? null, row);
  }
  if ("finalState" in row) return row.finalState === "done" ? "terminé" : "échoué";
  return row.state === "waiting" ? "attend" : "tourne";
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


/** La colonne de droite : maillon, état (le jalon nommé quand il y en a un), temps. */
export function lotFeatureRight(lot: Lot, feature: LotFeature, now: number): string {
  const state = featureStateLabel(lot, feature);
  return `/${feature.phase} · ${state} · ${elapsedLabel((feature.endedAt ?? now) - feature.sinceAt)}`;
}


/**
 * La colonne de droite d'une ENTRÉE en cours : même format que celle d'un rang de
 * lot, pour qu'une feature appariée à son run ne change pas de forme (S-1).
 */
export function entryRight(entry: { phase: PipelinePhase; state: PipelineRunState; phaseStartedAt: number }, now: number): string {
  return `/${entry.phase} · ${entry.state === "waiting" ? "attend" : "tourne"} · ${elapsedLabel(now - entry.phaseStartedAt)}`;
}


/**
 * La colonne de droite d'une feature APPARIÉE à son run (S-9) : le jalon de la
 * feature prime sur l'état du run (même ordre que `rowStateLabel`), et le temps
 * part de l'instant le PLUS ANCIEN des deux — publier une entrée ne fait jamais
 * reculer l'horloge, le rang garde donc le même motif d'attente et un temps qui ne
 * recule pas.
 */
export function pairedRight(feature: LotFeature, live: RunningEntry, now: number): string {
  const state = lotWaitLabel(feature.waitKind) ?? (live.state === "waiting" ? "attend" : "tourne");
  return `/${live.phase} · ${state} · ${elapsedLabel(now - Math.min(feature.sinceAt, live.phaseStartedAt))}`;
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
 * sous-ensemble.
 */
export function lotSectionTitle(lot: Lot): string {
  const totals = lotTotals(lot);
  const counted = (n: number, label: string) => `${n} ${label}${n > 1 ? "s" : ""}`;
  return [
    `Lot · ${path.basename(lot.repoRoot)} · ${lot.features.length} features`,
    counted(totals.done, "terminée"),
    counted(totals.blocked, "bloquée"),
    counted(totals.failed, "échouée"),
    counted(totals.cancelled, "annulée"),
    `${totals.live} en cours`,
  ].join(" · ");
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


/** Les touches qui s'appliquent à la ligne sélectionnée, dans l'ordre du pied. */
export function lotFooterActions(features: LotFeature[], selection: number): string {
  const feature = selection >= 0 && selection < features.length ? features[selection] : undefined;
  if (!feature) return "aucune action";
  // La collecte d'une feature de lot se répond DANS la session, jamais au panneau
  // (`rowReply` refuse cet état) : l'annoncer serait une touche morte — pour la
  // réponse comme pour l'écriture, la zone de saisie de sa vue est fermée.
  const collecte = feature.origin === "session" && feature.phase === "req";
  const actions: string[] = [];
  if (!collecte && feature.state === "waiting" && feature.waitKind === "answer") actions.push("Entrée répondre");
  if (!collecte && feature.state === "running") actions.push("Entrée écrire");
  if (feature.state === "waiting" && feature.waitKind === "specs") actions.push("v valider");
  if (feature.state === "waiting" && feature.waitKind === "review") actions.push("y accepter");
  if (feature.state === "blocked" || feature.state === "failed") actions.push("R relancer");
  if (feature.state === "pending") actions.push("x retirer");
  if (!lotStateTerminal(feature.state)) actions.push("c annuler");
  return actions.length > 0 ? actions.join(" · ") : "aucune action";
}


/**
 * La seconde ligne du pied : ce qui s'applique à la LIGNE SÉLECTIONNÉE, quelle
 * qu'elle soit. Un rang de lot passe par `lotFooterActions` ; une entrée
 * d'historique est le seul rang que `d` supprime ; un rang « en cours » n'offre
 * aucune action de ligne — et une sélection vide n'annonce rien. La bascule `o`
 * s'ajoute à la fin dès que le rang a une session (S-3) : elle existe sur les
 * trois sections, elle doit donc s'annoncer partout où elle mène quelque part.
 */
export function panelFooterActions(model: PanelModel, runningCount: number): string {
  const features = model.lot?.features.length ?? 0;
  const selection = model.selection;
  const base =
    selection < features
      ? lotFooterActions(model.lot?.features ?? [], selection)
      : selection < features + runningCount
        ? "aucune action"
        : selection < features + runningCount + model.history.length
          ? "d supprimer"
          : "aucune action";
  const row = panelRowAt(model, selection);
  if (!row || rowSessionFile(model, row) === null) return base;
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
 * (`frameRows`) sont comptés à leur hauteur repliée, pas pour un. Le minimum d'une
 * section non vide reste une entrée complète, jamais un demi-rang, et une section
 * tronquée le dit par son marqueur `… <n> de plus <section>`. Le surplus va par
 * priorité au lot (la salle de contrôle), puis aux pipelines en cours (vivants),
 * puis à l'historique, la plus récente d'abord.
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

  // Les rangs de CADRE, construits d'abord : leur hauteur RÉELLE (repliée) est ce
  // que le budget doit réserver avant de servir la moindre entrée.
  const titleRows = serviceRow(`Pipelines · ${processes} processus`, "accent", innerW);
  const lotHeaderRows = lot ? serviceRow(lotSectionTitle(lot), "accent", innerW) : [];
  const outHeaderRows = serviceRow(`Hors lot · ${runningCount}`, "accent", innerW);
  const historyHeaderRows = serviceRow(`Historique · ${historyCount}`, "accent", innerW);
  // La notice est un rang de SERVICE : elle se replie, bornée à
  // `PANEL_NOTICE_MAX_LINES` pour ne pas manger le budget de la liste — les
  // producteurs de notice n'atteignent pas cette borne (motifs de refus et messages
  // d'état plus courts), c'est une borne de sécurité.
  const noticeRows = notice ? serviceRow(notice, "warning", innerW, undefined, PANEL_NOTICE_MAX_LINES) : [];
  // Le pied a TOUJOURS trois rangs (S-7) : les touches du panneau, celles de la
  // LIGNE SÉLECTIONNÉE, et `Échap fermer`. `a` et `l` n'existent que si le panneau
  // peut réellement conduire un lot (`canDrive` : le pilote est injecté) — sans
  // lui, les deux touches refusent et ne s'annoncent donc pas.
  const footTop = lot
    ? "a ajouter · l lancer · Entrée session"
    : `↑↓ naviguer · Entrée session${opts.canDrive === true ? " · a ajouter" : ""}`;
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
        const right = live ? pairedRight(feature, live, opts.now) : lotFeatureRight(lot, feature, opts.now);
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
        // La RAISON D'ARRÊT d'une feature bloquée ou échouée se lit dans la liste
        // (S-9) : un second rang, même cible de clic et même surlignage que celui de
        // la feature, replié en entier — « échoué » ne dit pas pourquoi.
        if ((feature.state === "blocked" || feature.state === "failed") && (feature.stopReason ?? "") !== "") {
          entry.push(...serviceRow(`arrêt : ${feature.stopReason}`, "error", innerW, { target: index, selected }));
        }
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
   * Répartit une section dans `room` LIGNES : toutes ses entrées si elles tiennent,
   * sinon autant d'entrées complètes que possible en gardant la dernière ligne pour
   * le marqueur `… n de plus` — une section tronquée le dit toujours, elle ne
   * disparaît jamais en silence (S-7), et elle ne montre jamais un demi-rang.
   */
  const take = (entries: PanelRow[][], room: number): { shown: number; marker: boolean } => {
    if (entries.length === 0) return { shown: 0, marker: false };
    if (room <= 0) return { shown: 0, marker: false };
    if (rowsOf(entries) <= room) return { shown: entries.length, marker: false };
    let used = 0;
    let shown = 0;
    for (const entry of entries) {
      if (used + linesOf(entry) > room - 1) break;
      used += linesOf(entry);
      shown += 1;
    }
    return { shown, marker: true };
  };

  let left = Math.max(0, opts.budget - frameRows);
  const credit = (want: number): number => {
    const paid = Math.min(want, Math.max(0, left));
    left -= paid;
    return paid;
  };

  // 1. Le minimum de chaque section NON VIDE : une ENTRÉE complète (ses rangs de
  //    repli compris), ou son marqueur. Réservé avant de servir la première
  //    section, le budget servait auparavant les entrées du lot jusqu'à laisser la
  //    section « en cours » sans un rang ni un marqueur : un pipeline vivant
  //    disparaissait de l'écran alors que le titre en annonçait le compte
  //    (BLOQUANT 4 de la revue n°3).
  const lotRows = rowsOf(lotEntries);
  const runningRows = rowsOf(runningEntries);
  const historyRows = rowsOf(historyEntries);
  const minLot = credit(lotEntries.length > 0 ? Math.min(PANEL_WRAP_MAX_LINES, linesOf(lotEntries[0] as PanelRow[])) : 0);
  const minRunning = credit(
    runningEntries.length > 0 ? Math.min(PANEL_WRAP_MAX_LINES, linesOf(runningEntries[0] as PanelRow[])) : 0,
  );
  const minHistory = credit(
    historyEntries.length > 0 ? Math.min(PANEL_WRAP_MAX_LINES, linesOf(historyEntries[0] as PanelRow[])) : 0,
  );
  // 2. Le surplus, par priorité : le lot (la salle de contrôle), puis les
  //    pipelines en cours (vivants), puis l'historique.
  const lotShown = take(lotEntries, minLot + credit(Math.max(0, lotRows - minLot)));
  const runningShown = take(runningEntries, minRunning + credit(Math.max(0, runningRows - minRunning)));
  const historyShown = take(historyEntries, minHistory + credit(Math.max(0, historyRows - minHistory)));
  // 3. Les rangs d'ÉTAT VIDE (« aucune pipeline en cours », « aucun historique »)
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
  rows.push({ text: "", tone: "border", rule: "frame" });
  rows.push(...titleRows);

  if (lot) {
    rows.push(...lotHeaderRows);
    const start = windowStart(sectionSelection(model.selection, lotOffset, features), lotShown.shown, lotEntries.length);
    for (const entry of lotEntries.slice(start, start + lotShown.shown)) rows.push(...entry);
    if (lotShown.marker) {
      rows.push(...serviceRow(`… ${lotEntries.length - lotShown.shown} de plus dans le lot`, "dim", innerW));
    }
  }

  rows.push(...outHeaderRows);
  if (runningCount === 0) {
    if (runningEmpty) rows.push(...runningEmptyRows);
  } else {
    const start = windowStart(sectionSelection(model.selection - features, 0, runningCount), runningShown.shown, runningCount);
    for (const entry of runningEntries.slice(start, start + runningShown.shown)) rows.push(...entry);
    if (runningShown.marker) {
      rows.push(...serviceRow(`… ${runningCount - runningShown.shown} de plus hors lot`, "dim", innerW));
    }
  }

  rows.push({ text: "", tone: "border", rule: "separator" });

  rows.push(...historyHeaderRows);
  if (historyCount === 0) {
    if (historyEmpty) rows.push(...historyEmptyRows);
  } else {
    const start = windowStart(
      sectionSelection(model.selection - features - runningCount, 0, historyCount),
      historyShown.shown,
      historyCount,
    );
    for (const entry of historyEntries.slice(start, start + historyShown.shown)) rows.push(...entry);
    if (historyShown.marker) {
      rows.push(...serviceRow(`… ${historyCount - historyShown.shown} de plus dans l'historique`, "dim", innerW));
    }
  }

  for (const row of noticeRows) rows.push(row);
  for (const row of modeRows) rows.push(row);

  // Le REMPLISSAGE (S-1) : le composant le rend en `Spacer`, juste avant le pied —
  // le pied reste ainsi collé au bas de l'écran, comme la règle basse d'avant. Il
  // n'existe que s'il reste de la place : au-delà du budget, rien n'est inséré et
  // le TUI coupe par le bas (terminal plus court que le panneau).
  const used =
    rows.reduce((lines, row) => lines + Math.max(1, wrapVisible(row.text, innerW).length), 0) + footRows.length + 1;
  if (opts.budget - used >= 1) rows.push({ text: "", tone: "dim", fill: true });

  for (const row of footRows) rows.push(row);
  rows.push({ text: "", tone: "border", rule: "frame" });

  return rows;
}
