// Panneau : largeur visible, repli, fenêtres de texte.
import type { PanelRow, PanelTone } from "./panelRows.ts";



// --- largeur d'affichage et repli : les primitives du cadre (S-9) -----------
//
// Le cadre se cale en COLONNES VISIBLES, jamais en unités de code : un libellé
// CJK, un emoji ou une marque combinante ne se mesurent pas en `.length`, et
// l'hôte exige des lignes qui n'excèdent jamais `width` (`## Documentation` §2).
// `visibleWidth`/`wrapTextWithAnsi` de l'hôte sont INACCESSIBLES (le dépôt interdit
// tout import de VALEUR `@oh-my-pi/*`, et ces primitives sont natives côté Bun) :
// elles sont donc réimplémentées ici, en JS pur — `Bun.stringWidth` quand il existe
// (OMP tourne sous Bun), et la table locale UAX #11 sinon. C'est la table locale que
// les tests exercent : `node --test` n'a pas de `Bun`.

/** Bornes Large/Fullwidth de la table UAX #11 (`## Documentation` §3). */
export const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];


/** Marques combinantes, format, ZWJ, sélecteurs de variante : 0 colonne. */
export const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];


export function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return true;
  }
  return false;
}


/** Une séquence CSI (`ESC [ … m` et consorts) : 0 colonne. */
export const ANSI_AT = /^\u001b\[[0-9;?]*[A-Za-z]/;

export const ANSI_GLOBAL = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Tabulations et contrôles : rendus comme un espace, donc mesurés comme lui. */
export const CONTROL_GLOBAL = /[\u0000-\u001f\u007f]/g;


/** L'atome qui commence à `index` : une séquence ANSI (0) ou un point de code. */
export function scanAtom(text: string, index: number, out: { next: number; width: number }): void {
  if (text.charCodeAt(index) === 0x1b) {
    const ansi = ANSI_AT.exec(text.slice(index, index + 32));
    if (ansi) {
      out.next = index + ansi[0].length;
      out.width = 0;
      return;
    }
  }
  const cp = text.codePointAt(index) as number;
  out.next = index + (cp > 0xffff ? 2 : 1);
  if (cp < 0x20 || cp === 0x7f) out.width = 1;
  else if (inRanges(cp, WIDE_RANGES)) out.width = 2;
  else if (inRanges(cp, ZERO_RANGES)) out.width = 0;
  else out.width = 1;
}


/**
 * Texte mesurable et rendable : séquences ANSI RETIRÉES (0 colonne, et rien
 * d'un fichier externe n'atteint le terminal), puis contrôles → espaces.
 */
export function sanitizeForWidth(text: string): string {
  return text.replace(ANSI_GLOBAL, "").replace(CONTROL_GLOBAL, " ");
}


/** Table locale de largeur : le chemin de `node --test`, et le repli de Bun. */
export function localWidth(text: string): number {
  const out = { next: 0, width: 0 };
  let index = 0;
  let width = 0;
  while (index < text.length) {
    scanAtom(text, index, out);
    width += out.width;
    index = out.next;
  }
  return width;
}


/** `Bun.stringWidth` s'il existe — lu une fois : OMP tourne sous Bun, pas les tests. */
export const BUN_STRING_WIDTH: ((text: string) => number) | null = (() => {
  const bun = (globalThis as { Bun?: { stringWidth?: (text: string) => number } }).Bun;
  return typeof bun?.stringWidth === "function" ? bun.stringWidth.bind(bun) : null;
})();


/**
 * Largeur d'AFFICHAGE d'un texte, en colonnes de terminal (S-9) : ANSI = 0,
 * combinantes = 0, Large/Fullwidth = 2, autres = 1, tabulations et contrôles = 1.
 * Rapide sur l'ASCII pur (`text.length`), puis `Bun.stringWidth` (la mesure de
 * l'hôte), puis la table locale — jamais d'exception.
 */
export function displayWidth(text: string): number {
  if (text === "") return 0;
  let plain = true;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      plain = false;
      break;
    }
  }
  if (plain) return text.length;
  const sanitized = sanitizeForWidth(text);
  if (BUN_STRING_WIDTH) {
    try {
      const measured = BUN_STRING_WIDTH(sanitized);
      if (Number.isFinite(measured) && measured >= 0) return measured;
    } catch {
      /* repli : la table locale reste le dernier mot */
    }
  }
  return localWidth(sanitized);
}


/** Le plus long préfixe de `text` tenant dans `max` colonnes visibles. */
export function takeByWidth(text: string, max: number): string {
  const out = { next: 0, width: 0 };
  let index = 0;
  let used = 0;
  while (index < text.length) {
    scanAtom(text, index, out);
    if (used + out.width > max) break;
    used += out.width;
    index = out.next;
  }
  return text.slice(0, index);
}


/** Le plus long suffixe de `text` tenant dans `max` colonnes visibles. */
export function takeTailByWidth(text: string, max: number): string {
  const starts: number[] = [];
  const widths: number[] = [];
  const out = { next: 0, width: 0 };
  let index = 0;
  while (index < text.length) {
    starts.push(index);
    scanAtom(text, index, out);
    widths.push(out.width);
    index = out.next;
  }
  let used = 0;
  let at = starts.length;
  while (at > 0 && used + (widths[at - 1] as number) <= max) {
    used += widths[at - 1] as number;
    at -= 1;
  }
  return text.slice(starts[at] ?? text.length);
}


/**
 * Replie un texte : chaque ligne rendue a une largeur d'affichage ≤ `width`.
 * Coupure aux espaces, jamais au milieu d'un mot qui tient sur une ligne ; un mot
 * plus large que la place disponible est coupé dur ; les espaces de tête d'une
 * ligne de continuation sont absorbés ; une ligne vide du texte source reste une
 * ligne vide ; les séquences ANSI sont retirées (0 colonne — et rien d'un fichier
 * externe n'atteint le terminal), tabulations et contrôles valent un espace.
 * `width <= 0` ⇒ aucun rang.
 *
 * Seule exception à l'invariant : un point de code plus large que `width` (un CJK
 * dans une colonne) est rendu seul — le perdre serait pire, et le `fit` du cadre
 * rogne de toute façon le rang à la largeur reçue.
 */
export function wrapVisible(text: string, width: number): string[] {
  const limit = Math.floor(width);
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const rows: string[] = [];
  for (const source of text.split("\n")) {
    const line = sanitizeForWidth(source);
    if (line === "") {
      rows.push("");
      continue;
    }
    let rest = line;
    while (rest !== "") {
      if (displayWidth(rest) <= limit) {
        rows.push(rest);
        break;
      }
      const cut = breakIndex(rest, limit);
      const head = rest.slice(0, cut);
      const trimmed = head.replace(/ +$/, "");
      rows.push(trimmed === "" ? head : trimmed);
      rest = rest.slice(cut).replace(/^ +/, "");
    }
  }
  return rows;
}


/**
 * L'index de coupe d'une ligne trop longue : à la dernière espace qui tient, sinon
 * dur. Rend toujours > 0 (un caractère plus large que la ligne est rendu seul).
 */
export function breakIndex(text: string, limit: number): number {
  const out = { next: 0, width: 0 };
  let index = 0;
  let used = 0;
  let lastSpace = -1;
  while (index < text.length) {
    scanAtom(text, index, out);
    if (used + out.width > limit) break;
    used += out.width;
    index = out.next;
    if (out.width === 1 && text.charCodeAt(index - 1) === 0x20) lastSpace = index;
  }
  if (index === 0) {
    const cp = text.codePointAt(0) as number;
    return cp > 0xffff ? 2 : 1;
  }
  return lastSpace > 0 ? lastSpace : index;
}


/** Le nombre de lignes qu'un rang de la LISTE peut occuper avant le repli (S-1). */
export const PANEL_WRAP_MAX_LINES = 3;


/** La fenêtre d'une notice (S-2) : borne de sécurité du budget, jamais atteinte. */
export const PANEL_NOTICE_MAX_LINES = 4;


/**
 * La fenêtre de la ZONE DE SAISIE de la vue (S-2, S-4) : au plus dix lignes, et
 * jamais moins de trois — le pied et la règle basse restent payés d'abord. C'est
 * une FONCTION (et non une constante) parce que la borne dépend de la hauteur du
 * terminal, relue à chaque peinture : le nom est celui de la spec.
 */
export function VIEW_ZONE_MAX_LINES(height: number): number {
  return Math.max(3, Math.min(10, Math.floor(height) - 7));
}


/** La fenêtre de la région de SAISIE de la liste (S-2), même règle que la zone. */
export function LIST_MODE_MAX_LINES(height: number): number {
  return Math.max(3, Math.min(6, Math.floor(height) - 16));
}


/**
 * L'ancre de FIN d'une fenêtre de texte (S-2, S-4) : la vue colle à la dernière ligne
 * de l'élément actif. Déplacer le curseur ou insérer un caractère RÉARME cette ancre —
 * c'est ce qui fait suivre la sélection à l'écran.
 */
export const WINDOW_FOLLOW: TextWindow = { follow: true, offset: 0 };


/**
 * L'état de défilement d'une fenêtre de TEXTE (S-2) : le couple `{follow, offset}`
 * de la transcription (S-5), appliqué aux fenêtres bornées — `follow` colle la
 * fenêtre à son ancre (la fin du texte, le curseur), `offset` la fige sur la
 * première ligne affichée quand l'utilisateur a remonté.
 */
export type TextWindow = { follow: boolean; offset: number };


/**
 * La fenêtre d'une liste de rangs (S-2, S-4) : au plus `max` lignes CONSÉCUTIVES,
 * ancrées sur `focus` (la dernière ligne de l'élément actif) quand le suivi est
 * armé, sinon sur `offset`. Une liste plus courte que sa fenêtre est rendue telle
 * quelle — il n'y a rien à faire défiler.
 */
export function textWindow(rows: PanelRow[], max: number, focus: number, scroll?: TextWindow): PanelRow[] {
  if (rows.length <= max) return rows;
  const top = Math.max(0, rows.length - max);
  const start =
    scroll && !scroll.follow
      ? Math.min(Math.max(scroll.offset, 0), top)
      : Math.min(Math.max(focus - (max - 1), 0), top);
  return rows.slice(start, start + max);
}


export function clip(s: string, n: number): string {
  if (n <= 0) return "";
  if (displayWidth(s) <= n) return s;
  if (n === 1) return takeByWidth(s, 1);
  return `${takeByWidth(s, n - 1)}…`;
}


/**
 * Les `n` DERNIÈRES colonnes (S-4) : dans la sortie d'un maillon, ce qui compte
 * est la fin — l'agent y pose ses questions et sa conclusion —, pas l'en-tête du
 * récapitulatif qui la précède.
 */
export function clipTail(s: string, n: number): string {
  if (n <= 0) return "";
  if (displayWidth(s) <= n) return s;
  if (n === 1) return "…";
  return `…${takeTailByWidth(s, n - 1)}`;
}


/**
 * La fenêtre d'une section tronquée : celle qui CONTIENT le rang sélectionné, au
 * plus près (S-4). `sel` est l'index de la sélection DANS la section (`-1` quand
 * elle n'y est pas) : une section tronquée ne cache jamais la ligne qu'on regarde,
 * et les autres sections gardent leur début.
 */
export function windowStart(sel: number, shown: number, count: number): number {
  if (sel < 0 || shown >= count) return 0;
  return Math.min(Math.max(sel - shown + 1, 0), Math.max(0, count - shown));
}


/** L'index de la sélection DANS une section, ou `-1` si elle porte sur une autre. */
export function sectionSelection(selection: number, offset: number, count: number): number {
  return selection >= 0 && selection < count ? selection + offset : -1;
}


/**
 * Les rangs du panneau et de la vue sont rendus par un `Text` de l'hôte, qui
 * réserve `paddingX` colonnes de chaque côté : la largeur de CONTENU d'un rang —
 * celle sur laquelle se mesurent les garde-fous de largeur — en découle.
 */
export const ROW_PADDING_X = 1;


/**
 * Un rang de SERVICE (S-1, S-2) : titre, titre de section, en-tête, notice, rang de
 * saisie, pied, rang d'état du corps. Le texte est REPLIÉ EN ENTIER (`wrapVisible`,
 * mesuré en colonnes visibles) — jamais coupé par `…` : un rang de service rend
 * AUTANT DE LIGNES que son texte en demande, et le budget les compte à cette
 * hauteur (S-2). `max` borne les seuls textes qui viennent de l'extérieur (une
 * notice) : au-delà, le reliquat est signalé par `…` sur la dernière ligne rendue.
 */
export function serviceRow(
  text: string,
  tone: PanelTone,
  innerW: number,
  marks?: { target?: number; choice?: PanelRow["choice"]; selected?: boolean },
  max = Number.POSITIVE_INFINITY,
): PanelRow[] {
  const lines = innerW > 0 ? wrapVisible(text, innerW) : [""];
  const kept =
    lines.length <= max ? lines : [...lines.slice(0, max - 1), clip(lines.slice(max - 1).join(" "), innerW)];
  return kept.map((line) => {
    const row: PanelRow = { text: line, tone };
    if (marks?.target !== undefined) row.target = marks.target;
    if (marks?.choice !== undefined) row.choice = marks.choice;
    if (marks?.selected !== undefined) row.selected = marks.selected;
    return row;
  });
}
