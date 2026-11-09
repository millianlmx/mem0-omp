// L'empreinte d'une réponse recalculée par l'extension (lib/composer.ts `inspectGesture`,
// lib/outbound.ts `replyFingerprint`) : destinataires du compositeur (ou conversation Slack)
// et texte des éditeurs riches, normalisé. Sous node, sur une doublure de DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  type PageDocument,
  type PageLocation,
  type PageNode,
  inspectGesture,
} from "../../omp-chrome/src/lib/composer.ts";
import { approvalGate, normalizeReplyText, replyFingerprint } from "../../omp-chrome/src/lib/outbound.ts";

/** Une doublure d'arbre DOM (celle de poste-extension.test.ts) : parents, descendants, texte, valeurs. */
class FakeNode implements PageNode {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly content: (FakeNode | string)[];
  parentElement: FakeNode | null = null;
  value?: string;
  visible = true;
  constructor(tag: string, attributes: Record<string, string>, content: (FakeNode | string)[], value?: string) {
    this.tagName = tag.toUpperCase();
    for (const [name, entry] of Object.entries(attributes)) this.attributes.set(name, entry);
    this.content = content;
    for (const child of content) if (typeof child !== "string") child.parentElement = this;
    if (value !== undefined) this.value = value;
  }
  get textContent(): string {
    return this.content.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  }
  get innerText(): string {
    return this.textContent;
  }
  get isContentEditable(): boolean {
    const own = this.getAttribute("contenteditable");
    return own !== null ? own.toLowerCase() !== "false" : (this.parentElement?.isContentEditable ?? false);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  checkVisibility(): boolean {
    return this.visible;
  }
  matches(selector: string): boolean {
    return matches(this, selector);
  }
  *descendants(): Generator<FakeNode> {
    for (const child of this.content) {
      if (typeof child === "string") continue;
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector: string): FakeNode[] {
    return [...this.descendants()].filter((node) => node.matches(selector));
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FakeNode | null {
    for (let node: FakeNode | null = this; node !== null; node = node.parentElement)
      if (node.matches(selector)) return node;
    return null;
  }
}

function attributeMatches(el: FakeNode, expression: string): boolean {
  const [name = "", value] = expression.split("=");
  return value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value.replace(/^["']|["']$/g, "");
}

function matches(el: FakeNode, selector: string): boolean {
  return selector.split(",").some((part) => {
    const parsed = /^([a-z]*)((?:\[[^\]]+\])*)(?::not\(\[([^\]]+)\]\))?$/.exec(part.trim());
    assert.ok(parsed, `sélecteur non pris en charge par la doublure : ${part}`);
    const [, tag = "", attributes = "", negated] = parsed;
    if (tag !== "" && el.tagName.toLowerCase() !== tag) return false;
    for (const [, expression = ""] of attributes.matchAll(/\[([^\]]+)\]/g))
      if (!attributeMatches(el, expression)) return false;
    return negated === undefined || !attributeMatches(el, negated);
  });
}

const h = (tag: string, attributes: Record<string, string> = {}, ...content: (FakeNode | string)[]) =>
  new FakeNode(tag, attributes, content);
const field = (attributes: Record<string, string>, value: string) => new FakeNode("input", attributes, [], value);

function fakePage(title: string, ...content: FakeNode[]): PageDocument {
  const body = new FakeNode("body", {}, content);
  const html = new FakeNode("html", {}, [body]);
  return {
    title,
    body,
    documentElement: html,
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    getElementById: (id) => [...html.descendants()].find((node) => node.getAttribute("id") === id) ?? null,
  };
}

function at(url: string): PageLocation {
  const parsed = new URL(url);
  return { origin: parsed.origin, hostname: parsed.hostname, pathname: parsed.pathname };
}

/** L'empreinte attendue, calculée par node:crypto (le contrat du serveur). */
const expected = (recipients: string[], text: string) =>
  createHash("sha256")
    .update(JSON.stringify([recipients, text]))
    .digest("hex");

const GMAIL = at("https://mail.google.com/mail/u/0/#inbox/FMfcg");

/** Un compositeur Gmail : puits « À » à puces [email], objet (champ d'une ligne), éditeur riche, bouton Envoyer. */
function gmail(body: string, subject = "Re: devis", well?: FakeNode) {
  const send = h("div", { role: "button", "aria-label": "Envoyer" }, "Envoyer");
  const page = fakePage(
    "Boîte de réception",
    h(
      "div",
      { role: "dialog" },
      well ??
        h(
          "div",
          { "aria-label": "À" },
          h("span", { email: "Bea@Exemple.test" }, "Béa"),
          " ",
          h("span", { email: "cle@exemple.test" }, "Clé"),
        ),
      field({ name: "subjectbox", "aria-label": "Objet" }, subject),
      h("div", { contenteditable: "true", role: "textbox", "aria-label": "Corps du message" }, body),
      send,
    ),
  );
  return inspectGesture(send, page, GMAIL, "click", null);
}

const TEXT = "Bonjour,\n\nVoici le devis.\n\nCordialement";

test("empreinte de réponse : un compositeur Gmail rend l'empreinte de ses destinataires et du texte de son éditeur", () => {
  const seen = gmail(TEXT);
  assert.equal(seen.verdict.outbound, true);
  assert.deepEqual([...seen.verdict.recipients].sort(), ["bea@exemple.test", "cle@exemple.test"]);
  assert.equal(seen.replyFingerprint, expected(["bea@exemple.test", "cle@exemple.test"], TEXT));
  assert.equal(
    seen.replyFingerprint,
    replyFingerprint({ recipients: [" CLE@exemple.test", "bea@exemple.test", "Bea@exemple.test "], text: TEXT }),
  );
  // L'objet (champ d'une ligne) n'entre pas dans la réponse ; il change l'empreinte de l'envoi.
  const otherSubject = gmail(TEXT, "Autre objet");
  assert.equal(otherSubject.replyFingerprint, seen.replyFingerprint);
  assert.notEqual(otherSubject.fingerprint, seen.fingerprint);
  // Le résultat needs_approval porte les deux empreintes.
  const gate = approvalGate(seen.verdict, { approved: false }, seen.fingerprint, seen.replyFingerprint);
  assert.equal(gate?.approval.replyFingerprint, seen.replyFingerprint);
  assert.equal(gate?.approval.fingerprint, seen.fingerprint);
});

test("empreinte de réponse : fins de ligne, espaces insécables et blancs de fin de ligne ne changent pas l'empreinte", () => {
  const messy = "\n  Bonjour,  \r\n\r\nVoici\u00a0le devis.\t\r\r\r\n\r\nCordialement\u00a0\n\n";
  assert.equal(normalizeReplyText(messy), TEXT);
  assert.equal(gmail(messy).replyFingerprint, gmail(TEXT).replyFingerprint);
  assert.equal(normalizeReplyText("a\n\n\n\n\nb"), "a\n\nb");
});

test("empreinte de réponse : un texte différent au-delà de 2000 caractères change l'empreinte", () => {
  const long = gmail("x".repeat(2500));
  const longer = gmail(`${"x".repeat(2499)}y`);
  assert.notEqual(long.replyFingerprint, null);
  assert.notEqual(long.replyFingerprint, longer.replyFingerprint);
  assert.equal(long.verdict.preview, longer.verdict.preview, "l'aperçu, lui, est coupé");
});

test("empreinte de réponse : sur Slack, le destinataire est la conversation lue dans l'adresse", () => {
  const paragraph = h("p", {}, "Brouillon");
  const editor = h("div", { contenteditable: "true", role: "textbox", "aria-label": "Message" }, paragraph);
  const send = h("button", { "aria-label": "Envoyer" }, "➤");
  const page = fakePage("#clients - Exemple - Slack", h("div", {}, editor, send));
  const where = at("https://app.slack.com/client/T1/C1");
  // `type` avec submit sur l'éditeur : le texte saisi remplace son contenu, qu'on vise l'éditeur ou un de ses paragraphes.
  const typed = inspectGesture(editor, page, where, "type-submit", "Bonjour\r\n");
  assert.equal(typed.replyFingerprint, expected(["c1"], "Bonjour"));
  assert.equal(
    inspectGesture(paragraph, page, where, "type-submit", "Bonjour").replyFingerprint,
    typed.replyFingerprint,
  );
  // Un clic sur Envoyer lit le texte de l'éditeur.
  assert.equal(inspectGesture(send, page, where, "click", null).replyFingerprint, expected(["c1"], "Brouillon"));
  const thread = inspectGesture(editor, page, at("https://app.slack.com/client/T1/C1/thread/C1-1"), "key-enter", null);
  assert.equal(thread.replyFingerprint, expected(["c1"], "Brouillon"));
  assert.equal(inspectGesture(send, page, at("https://app.slack.com/client/T1"), "click", null).replyFingerprint, null);
});

test("empreinte de réponse : destinataires illisibles ou texte vide rendent une empreinte nulle", () => {
  const unreadable = gmail(TEXT, "Re: devis", h("div", { "aria-label": "À" }, "Béa Martin"));
  assert.equal(unreadable.verdict.outbound, true);
  assert.deepEqual(unreadable.verdict.recipients, []);
  assert.equal(unreadable.replyFingerprint, null);
  assert.equal(gmail(" \n\u00a0\n ").replyFingerprint, null);
  assert.equal(replyFingerprint({ recipients: [], text: TEXT }), null);
  assert.equal(replyFingerprint({ recipients: ["  "], text: TEXT }), null);
});
