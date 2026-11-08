// Les touches que l'agent peut presser (`key`), et leur traduction en événements : CDP
// (`Input.dispatchKeyEvent`, geste de confiance) ou DOM (`KeyboardEvent`, repli).
//
// LISTE BLANCHE : une touche nommée seule (Enter, Tab, flèches…), éventuellement avec
// Shift ; une lettre ou un chiffre seulement avec Control, Meta ou Alt (un raccourci :
// Control+a, Meta+k) — taper du texte passe par `type`. Forme canonique :
// `Control+Alt+Shift+Meta+<touche>` (modificateurs dans cet ordre, lettre en minuscule).

export const NAMED_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

export const MODIFIERS = ["Control", "Alt", "Shift", "Meta"] as const;
export type Modifier = (typeof MODIFIERS)[number];

export type KeyCombo = { key: string; modifiers: Modifier[] };

/** Le code virtuel Windows (`windowsVirtualKeyCode`) et le `code` DOM de chaque touche nommée. */
const NAMED: Record<NamedKey, { code: string; vk: number; text?: string; key?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Space: { code: "Space", vk: 32, text: " ", key: " " },
};

/** Les bits de `modifiers` du protocole CDP. */
const CDP_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const isNamed = (key: string): key is NamedKey => (NAMED_KEYS as readonly string[]).includes(key);

/** La combinaison lue dans `"Control+Enter"`, `"Shift+Tab"`, `"Meta+k"` ; `null` hors liste blanche. */
export function parseKeyCombo(raw: unknown): KeyCombo | null {
  if (typeof raw !== "string" || raw.length > 60) return null;
  const parts = raw.split("+");
  const base = parts.pop() ?? "";
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS.find((candidate) => candidate === part);
    if (modifier === undefined || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }
  modifiers.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  if (isNamed(base)) return { key: base, modifiers };
  // Une lettre ou un chiffre : un raccourci, jamais de la saisie (Shift seul tape une majuscule).
  if (/^[a-z0-9]$/i.test(base) && modifiers.some((modifier) => modifier !== "Shift")) {
    return { key: base.toLowerCase(), modifiers };
  }
  return null;
}

/** La forme canonique d'une combinaison (`Control+Shift+k`). */
export function comboText(combo: KeyCombo): string {
  return [...combo.modifiers, combo.key].join("+");
}

/** Ce que la liste blanche permet, pour un message d'erreur. */
export const KEY_HELP = `une touche parmi ${NAMED_KEYS.join(", ")}, éventuellement précédée de ${MODIFIERS.join("+, ")}+ ; une lettre ou un chiffre seulement avec Control, Alt ou Meta (Control+a)`;

/** La valeur `key` de l'événement : la lettre en majuscule avec Shift, l'espace pour Space. */
function eventKey(combo: KeyCombo): string {
  if (isNamed(combo.key)) return NAMED[combo.key].key ?? combo.key;
  return combo.modifiers.includes("Shift") ? combo.key.toUpperCase() : combo.key;
}

function codeOf(key: string): string {
  if (isNamed(key)) return NAMED[key].code;
  return /\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`;
}

/** Le texte que la touche produit ; aucun sous Control, Alt ou Meta (un raccourci n'écrit rien). */
function textOf(combo: KeyCombo): string | undefined {
  if (combo.modifiers.some((modifier) => modifier !== "Shift")) return undefined;
  return isNamed(combo.key) ? NAMED[combo.key].text : eventKey(combo);
}

export type CdpKeyEvent = {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
};

/** Les paramètres de `Input.dispatchKeyEvent` : l'appui (avec son texte s'il en produit), puis le relâchement. */
export function cdpKeyEvents(combo: KeyCombo): CdpKeyEvent[] {
  const key = eventKey(combo);
  const code = codeOf(combo.key);
  const vk = isNamed(combo.key) ? NAMED[combo.key].vk : combo.key.toUpperCase().charCodeAt(0);
  const modifiers = combo.modifiers.reduce((bits, modifier) => bits | CDP_BITS[modifier], 0);
  const text = textOf(combo);
  const base = { key, code, windowsVirtualKeyCode: vk, modifiers };
  return [
    text === undefined ? { type: "rawKeyDown", ...base } : { type: "keyDown", ...base, text },
    { type: "keyUp", ...base },
  ];
}

/** L'initialisation d'un `KeyboardEvent` synthétique (repli DOM). */
export function domKeyInit(combo: KeyCombo): {
  key: string;
  code: string;
  keyCode: number;
  which: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  bubbles: true;
  cancelable: true;
  composed: true;
} {
  const vk = isNamed(combo.key) ? NAMED[combo.key].vk : combo.key.toUpperCase().charCodeAt(0);
  return {
    key: eventKey(combo),
    code: codeOf(combo.key),
    keyCode: vk,
    which: vk,
    ctrlKey: combo.modifiers.includes("Control"),
    altKey: combo.modifiers.includes("Alt"),
    shiftKey: combo.modifiers.includes("Shift"),
    metaKey: combo.modifiers.includes("Meta"),
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}
