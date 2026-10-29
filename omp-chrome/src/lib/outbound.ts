// La garde d'envoi côté extension : avant chaque `click`, `type` avec `submit` et `key`
// Enter, le geste est classé. S'il peut envoyer un message à quelqu'un, il n'est exécuté
// qu'avec l'approbation humaine (`approved: true`) ; sinon l'action rend
// `needs_approval`. Le doute vaut garde : un geste qu'on ne sait pas classer est traité
// comme un envoi.
//
// Module PUR : le contexte (hôte, description de l'élément visé, texte du compositeur,
// indices de destinataires) est collecté dans la page par lib/composer.ts.

import { clip } from "./observation.ts";
import { sha256Hex } from "./sha256.ts";

/** `type-submit` : saisie suivie d'un envoi (`type` avec `submit: true`). */
export type Gesture = "click" | "type-submit" | "key-enter";

export type ElementDescriptor = {
  tag: string;
  role: string;
  /** `type` d'un `<input>` / `<button>` (`submit`, `search`, `text`…), vide sinon. */
  type: string;
  label: string;
  /** Dans un éditeur de message : élément éditable riche, `<textarea>`, ou conteneur (dialogue, formulaire) qui en porte un. */
  inComposer: boolean;
  /** L'élément est lui-même éditable (`contenteditable`, `<textarea>`, champ texte, `role=textbox`). */
  editable: boolean;
  /**
   * Le formulaire englobant porte un texte libre : `<textarea>` ou éditable riche, champ texte
   * nommé comme un message (`COMPOSER_LABEL` / `SEND_LABEL`), ou seul champ texte visible
   * (hors recherche) d'un formulaire sans mot de passe.
   */
  formHasFreeText: boolean;
  /** Le formulaire englobant est une recherche (`role=search`, `type=search`, action ou libellé de recherche). */
  formIsSearch: boolean;
  /** Le bouton soumet son formulaire (bouton submit d'un `<form>`). */
  submitsForm: boolean;
};

export type OutboundContext = {
  host: string;
  /** Le chemin de l'onglet (sans query ni fragment) et son titre (la conversation) : montrés à l'humain. */
  path: string;
  title: string;
  gesture: Gesture;
  target: ElementDescriptor;
  /** TOUT le texte qui partirait (éditeurs, champs texte du compositeur), ou celui que l'action `type` va saisir. */
  composerText: string;
  /** Textes où chercher les destinataires (puces À / Cc / Cci de Gmail et d'Outlook). */
  recipientHints: string[];
};

export type OutboundVerdict = { outbound: boolean; summary: string; recipients: string[]; preview: string };

export const MAX_PREVIEW = 2000;

/** Les messageries connues : hôte exact ou sous-domaine, et le nom montré à l'humain. */
const MESSAGING: readonly { host: string; name: string }[] = [
  { host: "mail.google.com", name: "Gmail" },
  { host: "chat.google.com", name: "Google Chat" },
  { host: "outlook.live.com", name: "Outlook" },
  { host: "outlook.office.com", name: "Outlook" },
  { host: "outlook.office365.com", name: "Outlook" },
  { host: "slack.com", name: "Slack" },
  { host: "teams.microsoft.com", name: "Teams" },
  { host: "teams.live.com", name: "Teams" },
  { host: "web.whatsapp.com", name: "WhatsApp" },
  { host: "messenger.com", name: "Messenger" },
  { host: "facebook.com", name: "Facebook" },
  { host: "instagram.com", name: "Instagram" },
  { host: "linkedin.com", name: "LinkedIn" },
  { host: "discord.com", name: "Discord" },
  { host: "web.telegram.org", name: "Telegram" },
  { host: "x.com", name: "X" },
  { host: "twitter.com", name: "X" },
  { host: "mail.proton.me", name: "Proton Mail" },
  { host: "mail.yahoo.com", name: "Yahoo Mail" },
  { host: "app.fastmail.com", name: "Fastmail" },
];

/** Hôtes dont les puces de destinataires sont lues (`recipientHints`). */
const RECIPIENT_HOSTS: readonly string[] = [
  "mail.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "outlook.office365.com",
];

/** Libellés de bouton qui envoient, publient ou répondent (français et anglais). */
export const SEND_LABEL =
  /\b(envoyer|send|reply|répondre|repondre|transférer|transferer|forward|post|poster|publier|publish|commenter|submit|soumettre|tweet|tweeter|share|partager)\b/i;

/** Libellés d'un champ qui rédige pour quelqu'un : Enter y envoie le plus souvent. */
export const COMPOSER_LABEL = /\b(message|messages|commentaire|comment|réponse|reponse|reply|chat|tweet|post)\b/i;

/** Libellés qui désignent une recherche ou un filtre, jamais un envoi. */
export const SEARCH_LABEL = /\b(rechercher|recherche|search|chercher|filtrer|filter|find|trouver)\b/i;

const BUTTON_ROLES: Record<string, true> = { button: true, menuitem: true, option: true };

/** Une adresse e-mail (drapeau `g` : n'employer qu'avec `match` / `replace`, jamais `test`). */
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function matchHost(host: string, entry: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return h === entry || h.endsWith(`.${entry}`);
}

/** Le nom de la messagerie connue de `host`, ou `null`. */
export function messagingService(host: string): string | null {
  return MESSAGING.find((entry) => matchHost(host, entry.host))?.name ?? null;
}

/**
 * Les adresses des indices de destinataires, dédoublonnées, en minuscules. Un indice non
 * vide sans adresse lisible (un nom seul, un brouillon de saisie) rend la liste
 * INCOMPLÈTE : on rend alors `[]`, car une liste partielle pourrait faire passer un
 * message pour un message à soi (le serveur dispense d'approbation quand TOUS les
 * destinataires sont des identités de l'utilisateur).
 */
export function extractRecipients(hints: readonly string[]): string[] {
  const out = new Set<string>();
  for (const hint of hints) {
    const text = hint.trim();
    if (text === "") continue;
    const found = text.match(EMAIL);
    if (found === null) return [];
    for (const address of found) out.add(address.toLowerCase());
  }
  return [...out];
}

function isButtonLike(target: ElementDescriptor): boolean {
  const tag = target.tag.toLowerCase();
  const type = target.type.toLowerCase();
  if (tag === "button" || tag === "summary") return true;
  if (tag === "input" && (type === "submit" || type === "button" || type === "image")) return true;
  return BUTTON_ROLES[target.role.toLowerCase()] === true;
}

/** Un clic (ou Enter sur un élément non éditable, qui l'active) envoie-t-il ? */
function clickSends(target: ElementDescriptor, messaging: boolean): boolean {
  const label = target.label.trim();
  if (SEND_LABEL.test(label) && !SEARCH_LABEL.test(label)) return true;
  // Un bouton sans nom dans l'éditeur d'une messagerie : le doute vaut garde.
  if (messaging && target.inComposer && isButtonLike(target) && label === "") return true;
  if (target.submitsForm && !target.formIsSearch) return target.formHasFreeText || label === "";
  return false;
}

/** Le geste peut-il envoyer quelque chose à quelqu'un ? Vrai dans le doute. */
function sends(context: OutboundContext, messaging: boolean): boolean {
  const { gesture, target } = context;
  if (gesture === "click" || (gesture === "key-enter" && !target.editable)) return clickSends(target, messaging);

  // Enter dans un champ, ou saisie suivie d'un envoi.
  const label = target.label.trim();
  const searchField =
    target.type.toLowerCase() === "search" || target.role.toLowerCase() === "searchbox" || SEARCH_LABEL.test(label);
  if ((target.formIsSearch || searchField) && !target.inComposer) return false;
  if (messaging) return true;
  // Un éditeur riche (textarea, `role=textbox` hors <input>, compositeur) : Enter ou la soumission y envoie.
  const tag = target.tag.toLowerCase();
  if (tag === "textarea" || (tag !== "input" && target.role.toLowerCase() === "textbox") || target.inComposer)
    return true;
  return target.formHasFreeText || COMPOSER_LABEL.test(label) || SEND_LABEL.test(label);
}

/** La destination montrée à l'humain : hôte, chemin et titre de l'onglet (la conversation). */
function destination(context: Pick<OutboundContext, "host" | "path" | "title">): string {
  const title = context.title.trim();
  return `${context.host}${clip(context.path, 200)}${title !== "" ? ` · « ${clip(title, 150)} »` : ""}`;
}

/** Le verdict de la garde pour un geste. */
export function classifyOutbound(context: OutboundContext): OutboundVerdict {
  const service = messagingService(context.host);
  const outbound = sends(context, service !== null);
  const recipients =
    outbound && RECIPIENT_HOSTS.some((entry) => matchHost(context.host, entry))
      ? extractRecipients(context.recipientHints)
      : [];
  const preview = clip(context.composerText, MAX_PREVIEW);
  const label = context.target.label.trim();
  const summary = outbound
    ? `Envoyer ${service !== null ? "un message" : "un texte"}${recipients.length > 0 ? ` à ${recipients.join(", ")}` : ""} sur ${service ?? context.host}${label !== "" ? ` (« ${clip(label, 60)} »)` : ""} — ${destination(context)}`
    : "";
  return { outbound, summary, recipients, preview };
}

/**
 * Le classement sans exception : une erreur du classifieur vaut envoi (le doute vaut garde),
 * et l'humain voit tout de même le texte qui partirait. C'est l'entrée qu'emploie la page.
 */
export function guardGesture(context: OutboundContext): OutboundVerdict {
  try {
    return classifyOutbound(context);
  } catch {
    return {
      outbound: true,
      summary: `Geste non classé sur ${destination(context)} : approbation requise`,
      recipients: [],
      preview: clip(context.composerText, MAX_PREVIEW),
    };
  }
}

/**
 * Ce qu'un envoi engage : l'onglet (origine et chemin sans query ni fragment, titre = la
 * conversation), les destinataires et TOUT le texte qui partirait, jamais coupé.
 */
export type SendTarget = { origin: string; path: string; title: string; recipients: readonly string[]; text: string };

/** L'empreinte d'un envoi (Révision 2 §1) : SHA-256 hex de `[origine, chemin, titre, destinataires triés, texte complet]`. */
export function sendFingerprint(target: SendTarget): string {
  return sha256Hex(
    JSON.stringify([target.origin, target.path, target.title, [...target.recipients].sort(), target.text]),
  );
}

/**
 * L'approbation portée par l'action : l'empreinte de l'envoi que l'humain a vu. `approval`
 * et `fingerprint` peuvent ARRIVER ABSENTS : Chrome retire les `null` des objets passés à
 * `executeScript` (`args`).
 */
export type ApprovedGesture = {
  approved: boolean;
  approval?: { fingerprint?: string | null } | null;
};

export type NeedsApproval = {
  outcome: "needs_approval";
  approval: { summary: string; recipients: string[]; preview: string; fingerprint: string | null };
};

/**
 * `null` : le geste peut partir. Sinon le résultat `needs_approval`, et le geste n'est
 * PAS exécuté. Un envoi ne part qu'approuvé ET d'empreinte identique à celle que l'humain
 * a approuvée (`fingerprint`, recalculée par l'appelant au moment du geste) : texte,
 * destinataires, onglet ou conversation changés redemandent l'accord. Une approbation sans
 * empreinte (celle d'une action du mode proposer) n'autorise aucun envoi.
 */
export function approvalGate(
  verdict: OutboundVerdict,
  gate: ApprovedGesture,
  fingerprint: string,
): NeedsApproval | null {
  if (!verdict.outbound) return null;
  if (gate.approved === true && fingerprint !== "" && gate.approval?.fingerprint === fingerprint) return null;
  return {
    outcome: "needs_approval",
    approval: { summary: verdict.summary, recipients: verdict.recipients, preview: verdict.preview, fingerprint },
  };
}
