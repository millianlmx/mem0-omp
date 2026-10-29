// Ce que la garde d'envoi lit de la page avant un geste : la description de l'élément visé
// (pour `classifyOutbound`), le compositeur qui l'entoure, TOUT le texte qui partirait
// (éditeurs riches ET champs texte d'une ligne), les indices de destinataires, et
// l'empreinte de l'envoi (`inspectGesture`).
//
// Module PUR : le DOM est décrit par des interfaces STRUCTURELLES (un `Element` réel les
// satisfait) ; page/agent.ts l'appelle sur le vrai document, les tests sur une doublure.

import { isSecretInput } from "./observation.ts";
import type { ElementDescriptor, Gesture, OutboundVerdict } from "./outbound.ts";
import { COMPOSER_LABEL, EMAIL, SEARCH_LABEL, SEND_LABEL, guardGesture, sendFingerprint } from "./outbound.ts";
import type { NamedElement, SnapDocument } from "./snapshot.ts";
import { isVisible, labelOf, roleOf } from "./snapshot.ts";

export type PageNode = NamedElement & {
  readonly parentElement: PageNode | null;
  /** Le formulaire d'un champ ou d'un bouton (`HTMLInputElement.form`, attribut `form` compris). */
  readonly form?: PageNode | null;
  /** Valeur courante d'un champ (`<input>`, `<textarea>`). */
  readonly value?: string;
  readonly innerText?: string;
  matches(selector: string): boolean;
  closest(selector: string): PageNode | null;
  querySelector(selector: string): PageNode | null;
  querySelectorAll(selector: string): Iterable<PageNode>;
  checkVisibility?(): boolean;
  getClientRects?(): { readonly length: number };
};

export type PageDocument = Pick<SnapDocument, "getElementById"> & {
  /** Le titre de l'onglet : la conversation, pour un envoi. */
  readonly title: string;
  readonly body: PageNode | null;
  readonly documentElement: PageNode | null;
  querySelectorAll(selector: string): Iterable<PageNode>;
};

/** L'adresse de l'onglet (`location`) : seuls l'origine, l'hôte et le chemin comptent, jamais query ni fragment. */
export type PageLocation = { readonly origin: string; readonly hostname: string; readonly pathname: string };

const RICH_EDITOR = "textarea, [contenteditable]:not([contenteditable=false]), [role=textbox][aria-multiline=true]";

const TEXT_INPUT_TYPES: Record<string, true> = {
  "": true,
  text: true,
  search: true,
  email: true,
  url: true,
  tel: true,
  number: true,
};

/**
 * Le libellé d'un puits de destinataires (À, A, To, Cc, Cci, Bcc), suivi de rien ou d'un
 * non-mot. Bornée en Unicode : `\b` est ASCII et ne voit aucune frontière après « À ».
 */
export const RECIPIENT_WELL = /^(à|a|to|cc|cci|bcc)(?![\p{L}\p{N}])/iu;

/** L'indice d'un puits de destinataires présent dont on ne lit pas toutes les adresses. */
const UNREADABLE = "destinataires illisibles";

/** L'élément est-il lui-même éditable (`<textarea>`, champ texte, `contenteditable`, rôle de saisie) ? */
export function isEditable(node: PageNode): boolean {
  const tag = node.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") return TEXT_INPUT_TYPES[(node.getAttribute("type") ?? "").toLowerCase()] === true;
  if (node.isContentEditable === true) return true;
  const role = (node.getAttribute("role") ?? "").toLowerCase();
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

/** Un champ texte d'une ligne qui peut porter un message : ni recherche, ni champ secret. */
function isMessageInput(node: PageNode, doc: PageDocument): boolean {
  if (node.tagName.toLowerCase() !== "input") return false;
  const type = (node.getAttribute("type") ?? "").toLowerCase();
  if (TEXT_INPUT_TYPES[type] !== true || type === "search") return false;
  if (isSecretInput(type, node.getAttribute("autocomplete") ?? "")) return false;
  return roleOf(node) !== "searchbox" && !SEARCH_LABEL.test(labelOf(node, doc));
}

/**
 * L'éditeur de message qui entoure l'élément : le dialogue ou le formulaire englobant s'il
 * porte un éditeur riche (compositeur de Gmail, d'Outlook), sinon le plus proche ancêtre
 * (15 niveaux au plus, jamais <body>) qui en porte un.
 */
function composerRoot(el: PageNode, doc: PageDocument): PageNode | null {
  const carries = (node: PageNode) => node.matches(RICH_EDITOR) || node.querySelector(RICH_EDITOR) !== null;
  const container = el.closest("[role=dialog], form");
  if (container !== null && carries(container)) return container;
  let node: PageNode | null = el;
  for (let depth = 0; node !== null && depth < 15; depth++) {
    if (node === doc.body || node === doc.documentElement) return null;
    if (carries(node)) return node;
    node = node.parentElement;
  }
  return null;
}

/** Le formulaire de l'élément : celui qu'il soumet (attribut `form` compris), sinon l'englobant. */
function formOf(el: PageNode): PageNode | null {
  const tag = el.tagName.toLowerCase();
  if ((tag === "input" || tag === "button" || tag === "textarea" || tag === "select") && el.form !== undefined) {
    return el.form;
  }
  return el.closest("form");
}

/**
 * TOUT le texte qu'enverrait le geste, jamais coupé : les éditeurs riches du compositeur
 * (sans compositeur trouvé, ceux de toute la page), puis les champs texte d'une ligne de
 * l'élément visé, du compositeur (ou de la page) et du formulaire — hors recherche et champs
 * secrets. `typed` : le texte que l'action `type` va saisir dans l'élément visé, à la place
 * de son contenu actuel.
 */
function composerText(el: PageNode, root: PageNode | null, doc: PageDocument, typed: string | null): string {
  const fields = new Set<PageNode>();
  const scope = root ?? doc;
  const form = formOf(el);
  if (root?.matches(RICH_EDITOR) === true) fields.add(root);
  else for (const editor of scope.querySelectorAll(RICH_EDITOR)) fields.add(editor);
  if (form !== null) for (const editor of form.querySelectorAll(RICH_EDITOR)) fields.add(editor);
  if (isMessageInput(el, doc)) fields.add(el);
  for (const container of form === null ? [scope] : [scope, form]) {
    for (const input of container.querySelectorAll("input")) if (isMessageInput(input, doc)) fields.add(input);
  }
  const texts = Array.from(fields, (field) => {
    if (field === el && typed !== null) return typed;
    const tag = field.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" ? (field.value ?? "") : (field.innerText ?? field.textContent ?? "");
  });
  if (typed !== null && !fields.has(el)) texts.unshift(typed);
  return texts.filter((text) => text.trim() !== "").join("\n");
}

/**
 * Ce qu'on lit d'un puits de destinataires : ses adresses, ou `UNREADABLE` dès qu'il porte
 * autre chose qu'elles (un nom sans adresse, une saisie non résolue, un puits vide dont les
 * puces ne se lisent pas). Un champ de saisie vide n'a aucun destinataire en attente.
 */
function wellHint(well: PageNode): string {
  const tag = well.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") return well.value ?? "";
  const addresses: string[] = [];
  let rest = well.textContent ?? "";
  for (const chip of well.querySelectorAll("[email]")) {
    addresses.push(chip.getAttribute("email") ?? "");
    rest = rest.replace(chip.textContent ?? "", " ");
  }
  for (const input of well.querySelectorAll("input")) rest += ` ${input.value ?? ""}`;
  addresses.push(...(rest.match(EMAIL) ?? []));
  rest = rest.replace(EMAIL, " ").trim().replace(RECIPIENT_WELL, "");
  const readable =
    addresses.length > 0 &&
    addresses.every((address) => (address.match(EMAIL) ?? []).join("") === address.trim()) &&
    !/[\p{L}\p{N}]/u.test(rest);
  return readable ? addresses.join(" ") : UNREADABLE;
}

/**
 * Les indices de destinataires (puces de Gmail, puits À / Cc / Cci d'Outlook, champs to/cc).
 * Tout puits présent mais illisible, toute trace de destinataires masqués (« +2 »,
 * « 3 autres ») ou de saisie non résolue ajoute un indice sans adresse : la liste devient
 * incomplète (`extractRecipients` rend `[]`) et l'approbation humaine est exigée.
 */
function recipientHints(root: PageNode | null, doc: PageDocument): string[] {
  const scope = root ?? doc;
  const hints: string[] = [];
  for (const chip of scope.querySelectorAll("[email]")) hints.push(chip.getAttribute("email") ?? UNREADABLE);
  for (const well of scope.querySelectorAll("[aria-label]")) {
    if (RECIPIENT_WELL.test((well.getAttribute("aria-label") ?? "").trim())) hints.push(wellHint(well));
  }
  for (const input of scope.querySelectorAll("input[name=to], input[name=cc], input[name=bcc], textarea[name=to]")) {
    hints.push(input.value ?? "");
  }
  for (const input of scope.querySelectorAll("input")) {
    const value = input.value ?? "";
    if (/destinataire|recipient|^(à|to|cc|cci|bcc)$/i.test(input.getAttribute("aria-label") ?? "") && value.trim()) {
      hints.push(value);
    }
  }
  if (/(^|\s)\+\d+\b|\b\d+\s+(autres?|more|others?)\b/i.test(root?.innerText ?? ""))
    hints.push("destinataires masqués");
  return hints;
}

/**
 * Le formulaire porte-t-il un texte libre ? Un éditeur riche ; un champ texte nommé comme un
 * message (`COMPOSER_LABEL` / `SEND_LABEL`) ; ou un seul champ texte visible hors recherche,
 * dans un formulaire sans champ secret (une connexion n'envoie rien à personne).
 */
function formHasFreeText(form: PageNode, doc: PageDocument): boolean {
  if (form.querySelector(RICH_EDITOR) !== null) return true;
  let visible = 0;
  let secret = false;
  for (const input of form.querySelectorAll("input")) {
    if (isSecretInput(input.getAttribute("type") ?? "", input.getAttribute("autocomplete") ?? "")) secret = true;
    if (!isMessageInput(input, doc)) continue;
    const label = labelOf(input, doc);
    if (COMPOSER_LABEL.test(label) || SEND_LABEL.test(label)) return true;
    if (isVisible(input)) visible++;
  }
  return visible === 1 && !secret;
}

/** La description de l'élément visé, telle que `classifyOutbound` la juge. */
function describeTarget(el: PageNode, root: PageNode | null, doc: PageDocument): ElementDescriptor {
  const form = formOf(el);
  const tag = el.tagName.toLowerCase();
  const explicitType = el.getAttribute("type") ?? "";
  const type = tag === "button" && explicitType === "" && form !== null ? "submit" : explicitType;
  const submitsForm =
    form !== null &&
    ((tag === "button" && type.toLowerCase() === "submit") ||
      (tag === "input" && (type.toLowerCase() === "submit" || type.toLowerCase() === "image")));
  const formIsSearch =
    el.closest("[role=search]") !== null ||
    (form !== null &&
      (form.querySelector("input[type=search], [role=searchbox]") !== null ||
        /search|recherche/i.test(form.getAttribute("action") ?? "")));
  return {
    tag,
    role: roleOf(el),
    type,
    label: labelOf(el, doc),
    inComposer: root !== null,
    editable: isEditable(el),
    formHasFreeText: form !== null && formHasFreeText(form, doc),
    formIsSearch,
    submitsForm,
  };
}

/**
 * La garde d'un geste sur la page telle qu'elle est : le verdict de `classifyOutbound` (sans
 * exception) et l'empreinte de l'envoi — origine, chemin, titre de l'onglet, destinataires
 * triés et TOUT le texte, jamais coupé. `typed` : le texte que l'action `type` va saisir
 * dans l'élément visé.
 */
export function inspectGesture(
  el: PageNode,
  doc: PageDocument,
  location: PageLocation,
  gesture: Gesture,
  typed: string | null,
): { verdict: OutboundVerdict; fingerprint: string } {
  const root = composerRoot(el, doc);
  const text = composerText(el, root, doc, typed);
  const verdict = guardGesture({
    host: location.hostname,
    path: location.pathname,
    title: doc.title,
    gesture,
    target: describeTarget(el, root, doc),
    composerText: text,
    recipientHints: recipientHints(root, doc),
  });
  const fingerprint = sendFingerprint({
    origin: location.origin,
    path: location.pathname,
    title: doc.title,
    recipients: verdict.recipients,
    text,
  });
  return { verdict, fingerprint };
}
