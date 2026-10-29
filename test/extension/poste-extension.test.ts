// Tests de l'extension Chrome du poste de travail (omp-chrome/) : les modules purs de
// omp-chrome/src/lib/ importés tels quels sous node (appairage, adresses, observation,
// lots, garde d'envoi et empreinte sur une doublure du DOM, snapshot, paramètres des
// actions, requête STT), puis la construction par scripts/chrome-extension.sh dans un
// dossier jetable. Ce qui exige un vrai Chrome (service worker, offscreen, tabCapture,
// executeScript) n'est pas simulé ici.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { decodePairing as pluginDecodePairing } from "../../omp-mem0-req/harness.ts";
import { MAX_TYPE_TEXT, MAX_WAIT_MS, validateAction } from "../../omp-chrome/src/lib/actions.ts";
import {
  type PageDocument,
  type PageLocation,
  type PageNode,
  RECIPIENT_WELL,
  inspectGesture,
} from "../../omp-chrome/src/lib/composer.ts";
import {
  MAX_BATCH,
  MAX_LABEL,
  type Observation,
  type RawInteraction,
  appendCapped,
  isRawInteraction,
  sanitizeInteraction,
  sanitizeVisit,
  takeBatch,
} from "../../omp-chrome/src/lib/observation.ts";
import {
  type ElementDescriptor,
  type OutboundContext,
  MAX_PREVIEW,
  approvalGate,
  classifyOutbound,
  extractRecipients,
  guardGesture,
  sendFingerprint,
} from "../../omp-chrome/src/lib/outbound.ts";
import { APPROVER_CODE_REFUSAL, decodePairing } from "../../omp-chrome/src/lib/pairing.ts";
import {
  INTERACTIVE_SELECTOR,
  MAX_TEXT,
  REF_ATTRIBUTE,
  type SnapDocument,
  type SnapElement,
  labelOf,
  takeSnapshot,
} from "../../omp-chrome/src/lib/snapshot.ts";
import { sha256Hex } from "../../omp-chrome/src/lib/sha256.ts";
import { transcribe, transcriptionRequest, validateSttUrl } from "../../omp-chrome/src/lib/stt.ts";
import { hostOf, isExcludedHost, parseExcludedSites, stripUrl } from "../../omp-chrome/src/lib/url.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const encode = (lines: string[]) => `omp1:${Buffer.from(lines.join("\n")).toString("base64url")}`;

test("poste-extension/AC-1 : le code omp1: se décode exactement comme le plugin omp-mem0-req (valide, invalide, bourrage)", () => {
  const valid = encode(["https://harness.tail.ts.net/", "jeton-123", "https://mem0.tail.ts.net//", "jeton-mem0"]);
  assert.deepEqual(decodePairing(valid), {
    url: "https://harness.tail.ts.net",
    token: "jeton-123",
    mem0Url: "https://mem0.tail.ts.net",
    mem0Token: "jeton-mem0",
  });
  assert.deepEqual(decodePairing(`  ${encode(["http://10.0.0.2:8787", "t"])}\n`), {
    url: "http://10.0.0.2:8787",
    token: "t",
    mem0Url: "",
    mem0Token: "",
  });

  const body = Buffer.from("https://h.example\njeton-é\n\n").toString("base64url");
  const cases = [
    valid,
    encode(["https://h.example", "jeton"]),
    `omp1:${body}`,
    // Bourrage `=` accepté (base64 classique recopié), et toutes ses longueurs.
    `omp1:${body}=`,
    `omp1:${body}==`,
    `omp1:${Buffer.from("https://h.example\njeton").toString("base64url")}=`,
    // Un dernier caractère isolé (6 bits) ne produit rien, comme Buffer.
    `omp1:${body}A`,
    // Invalides.
    "",
    "omp1:",
    "omp2:aGVsbG8",
    `OMP1:${body}`,
    "omp1:ab+cd/ef",
    "omp1:abc=def",
    encode(["ftp://h.example", "jeton"]),
    encode(["https://h.example", "jeton avec espace"]),
    encode(["https://h.example", ""]),
    encode(["https://h.example", "jeton", "pas-une-url"]),
    encode(["pas une url"]),
  ];
  for (const code of cases) {
    assert.deepEqual(
      decodePairing(code),
      pluginDecodePairing(code),
      `écart avec le plugin pour ${JSON.stringify(code)}`,
    );
  }
  assert.equal(decodePairing("omp1:ab+cd/ef"), null);
  assert.equal(decodePairing(encode(["ftp://h.example", "jeton"])), null);
  assert.deepEqual(decodePairing(`omp1:${body}==`), {
    url: "https://h.example",
    token: "jeton-é",
    mem0Url: "",
    mem0Token: "",
  });
});

test("poste-extension/AC-18 : un code approbateur (5e ligne non vide) est refusé avec un message, comme le plugin ; une 5e ligne vide ne change rien", () => {
  const ordinary = ["https://harness.tail.ts.net", "jeton-ordinaire", "https://mem0.tail.ts.net", "jeton-mem0"];
  // Le format de `harness.sh approver` : printf termine par un saut de ligne.
  const approver = encode([...ordinary, "a".repeat(64), ""]);
  const refused = decodePairing(approver);
  assert.deepEqual(refused, { refusal: APPROVER_CODE_REFUSAL });
  assert.equal(APPROVER_CODE_REFUSAL, "code des apps : collez-le dans OMP Console ; ici, le code de `harness.sh pair`");
  // Le plugin refuse aussi (avec ses mots à lui) : aucun des deux ne rend le jeton.
  assert.ok(pluginDecodePairing(approver) !== null && "refusal" in (pluginDecodePairing(approver) as object));
  assert.ok(!JSON.stringify(refused).includes("a".repeat(64)) && !JSON.stringify(refused).includes("jeton-ordinaire"));
  // Même illisible par ailleurs, une 5e ligne non vide est un refus, jamais un code.
  assert.deepEqual(decodePairing(encode(["pas une url", "", "", "", "jeton-approbateur"])), {
    refusal: APPROVER_CODE_REFUSAL,
  });
  // Une 5e ligne vide (code ordinaire terminé par un saut de ligne) se décode comme avant.
  const trailing = encode([...ordinary, ""]);
  assert.deepEqual(decodePairing(trailing), {
    url: "https://harness.tail.ts.net",
    token: "jeton-ordinaire",
    mem0Url: "https://mem0.tail.ts.net",
    mem0Token: "jeton-mem0",
  });
  assert.deepEqual(decodePairing(trailing), pluginDecodePairing(trailing));

  // La page d'options dit le refus et n'enregistre rien : le refus précède tout saveSettings.
  const options = fs.readFileSync(path.join(ROOT, "omp-chrome/src/options/options.ts"), "utf8");
  const handler = options.slice(options.indexOf('element("pair"'), options.indexOf('element("unpair"'));
  const refusal = handler.indexOf('"refusal" in pairing');
  assert.ok(refusal > 0, "la page d'options teste le refus");
  assert.ok(refusal < handler.indexOf("saveSettings("), "le refus part avant tout enregistrement");
  assert.match(handler.slice(refusal, handler.indexOf("saveSettings(")), /pairing\.refusal[\s\S]*return;/);
});

test("poste-extension/AC-2 : une adresse observée garde l'origine et le chemin, jamais la query, le fragment ni les identifiants", () => {
  assert.equal(
    stripUrl("https://user:motdepasse@Mail.Google.com:443/mail/u/0/?compose=new&tok=abc#inbox/FMfcg"),
    "https://mail.google.com/mail/u/0/",
  );
  assert.equal(stripUrl("http://intranet.local:8080/projets/42?q=secret"), "http://intranet.local:8080/projets/42");
  for (const other of [
    "chrome://extensions/",
    "file:///Users/moi/a.pdf",
    "javascript:alert(1)",
    "about:blank",
    "pas une url",
  ]) {
    assert.equal(stripUrl(other), null, other);
  }
  assert.equal(hostOf("https://www.Banque.fr/compte?id=1"), "banque.fr");
  assert.equal(hostOf("chrome-extension://abc/options.html"), null);

  const excluded = parseExcludedSites("https://www.banque.fr/espace\n impots.gouv.fr ,\n*.medecin.fr\n\nbanque.fr");
  assert.deepEqual(excluded, ["banque.fr", "impots.gouv.fr", "medecin.fr"]);
  assert.equal(isExcludedHost("banque.fr", excluded), true);
  assert.equal(isExcludedHost("pro.banque.fr", excluded), true);
  assert.equal(isExcludedHost("www.medecin.fr", excluded), true);
  assert.equal(isExcludedHost("mabanque.fr", excluded), false, "un suffixe sans point n'est pas un sous-domaine");
});

function interaction(
  overrides: Partial<RawInteraction> = {},
  target: Partial<RawInteraction["target"]> = {},
): RawInteraction {
  return {
    at: 1_700_000_000_123.4,
    url: "https://app.example.com/dossiers/7?filtre=urgent#haut",
    title: "  Dossiers\n — App  ",
    action: "click",
    ...overrides,
    target: { tag: "button", role: "button", type: "", autocomplete: "", label: "Enregistrer", ...target },
  };
}

test("poste-extension/AC-3 : une interaction ne porte jamais de valeur, ni mot de passe, ni site exclu, et son libellé est borné", () => {
  // Un champ en trop (une valeur glissée par erreur) disparaît : l'objet est reconstruit.
  const smuggled = {
    ...interaction({ action: "input" }, { tag: "input", role: "textbox", type: "text" }),
    value: "4970 1234",
  };
  const clean = sanitizeInteraction(smuggled, []);
  assert.deepEqual(clean, {
    kind: "interaction",
    at: 1_700_000_000_123,
    url: "https://app.example.com/dossiers/7",
    title: "Dossiers — App",
    action: "input",
    target: { role: "textbox", label: "Enregistrer" },
  });
  assert.ok(!JSON.stringify(clean).includes("4970"));

  for (const secret of [
    { type: "password" },
    { type: "PASSWORD" },
    { autocomplete: "current-password" },
    { autocomplete: "section-x new-password" },
    { autocomplete: "one-time-code" },
    { autocomplete: "cc-number" },
  ]) {
    assert.equal(
      sanitizeInteraction(interaction({ action: "input" }, { tag: "input", ...secret }), []),
      null,
      JSON.stringify(secret),
    );
  }
  assert.equal(sanitizeInteraction(interaction({ url: "https://compte.banque.fr/virement" }), ["banque.fr"]), null);
  assert.equal(sanitizeInteraction(interaction({ url: "chrome://settings/" }), []), null);
  assert.equal(sanitizeInteraction({ ...interaction(), action: "scroll" as RawInteraction["action"] }, []), null);

  const long = sanitizeInteraction(interaction({}, { label: `${"Libellé très long ".repeat(20)}🙂🙂` }), []);
  assert.ok(long?.kind === "interaction");
  assert.ok(long.target.label.length <= MAX_LABEL, `${long.target.label.length} > ${MAX_LABEL}`);
  assert.ok(long.target.label.endsWith("…"));
  assert.equal(sanitizeInteraction(interaction({}, { label: "x".repeat(MAX_LABEL) }), [])?.kind, "interaction");

  // La forme d'un message de script de contenu est vérifiée avant tout nettoyage.
  assert.equal(isRawInteraction(interaction()), true);
  assert.equal(isRawInteraction({ ...interaction(), target: { role: "button", label: "x" } }), false);
  assert.equal(isRawInteraction({ ...interaction(), at: "maintenant" }), false);
  assert.equal(isRawInteraction(null), false);

  // Visites : une visite d'une seconde au moins, jamais sur un site exclu.
  const visit = { at: 1000, url: "https://doc.example.com/a?b=c", title: "Doc", durationMs: 42_000 };
  assert.deepEqual(sanitizeVisit(visit, []), {
    kind: "visit",
    at: 1000,
    url: "https://doc.example.com/a",
    title: "Doc",
    durationMs: 42_000,
  });
  assert.equal(sanitizeVisit({ ...visit, durationMs: 999 }, []), null);
  assert.equal(sanitizeVisit(visit, ["example.com"]), null);
});

test("poste-extension/AC-4 : les lots partent par 500 au plus, les plus anciens d'abord, et le tampon borné garde les plus récents", () => {
  const events = (n: number, from = 0): Observation[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "visit",
      at: from + i,
      url: "https://a.example/",
      title: "a",
      durationMs: 1000,
    }));
  assert.equal(MAX_BATCH, 500);
  for (const [size, batch, rest] of [
    [0, 0, 0],
    [499, 499, 0],
    [500, 500, 0],
    [501, 500, 1],
    [1000, 500, 500],
  ] as const) {
    const out = takeBatch(events(size));
    assert.equal(out.batch.length, batch, `${size} : lot`);
    assert.equal(out.rest.length, rest, `${size} : reste`);
    if (size > 0) assert.equal(out.batch[0]?.at, 0);
    if (rest > 0) assert.equal(out.rest[0]?.at, 500);
  }
  const capped = appendCapped(events(8), events(5, 100), 10);
  assert.equal(capped.length, 10);
  assert.deepEqual(
    capped.map((event) => event.at),
    [3, 4, 5, 6, 7, 100, 101, 102, 103, 104],
  );
});

function el(overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    tag: "button",
    role: "button",
    type: "",
    label: "",
    inComposer: false,
    editable: false,
    formHasFreeText: false,
    formIsSearch: false,
    submitsForm: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<OutboundContext>): OutboundContext {
  return {
    host: "example.org",
    path: "/",
    title: "",
    gesture: "click",
    target: el(),
    composerText: "",
    recipientHints: [],
    ...overrides,
  };
}

test("poste-extension/AC-5 : classifyOutbound garde tout envoi à autrui et laisse passer recherche et navigation", () => {
  // Gmail : le bouton Envoyer du compositeur, destinataires lus sur les puces.
  const gmail = classifyOutbound(
    ctx({
      host: "mail.google.com",
      target: el({ tag: "div", label: "Envoyer ‪(⌘Entrée)‬", inComposer: true }),
      composerText: `Bonjour Paul,\n\nci-joint le devis.\n${"x".repeat(3000)}`,
      recipientHints: ["Paul.Martin@client.fr", "compta@client.fr", "paul.martin@client.fr"],
    }),
  );
  assert.equal(gmail.outbound, true);
  assert.deepEqual(gmail.recipients, ["paul.martin@client.fr", "compta@client.fr"]);
  assert.match(gmail.summary, /Gmail/);
  assert.match(gmail.summary, /paul\.martin@client\.fr/);
  assert.ok(gmail.preview.startsWith("Bonjour Paul, ci-joint le devis."));
  assert.ok(gmail.preview.length <= 2000);

  // Une liste de destinataires incomplète (un nom sans adresse) n'est jamais rendue partielle.
  assert.deepEqual(extractRecipients(["moi@exemple.fr", "Paul Martin"]), []);
  assert.deepEqual(extractRecipients(["moi@exemple.fr", "destinataires masqués"]), []);
  assert.deepEqual(extractRecipients(["", "  ", "Moi <moi@exemple.fr>"]), ["moi@exemple.fr"]);

  // Slack : Enter dans le compositeur.
  const slack = classifyOutbound(
    ctx({
      host: "acme.slack.com",
      gesture: "key-enter",
      target: el({
        tag: "div",
        role: "textbox",
        label: "Envoyer un message à #général",
        editable: true,
        inComposer: true,
      }),
      composerText: "On livre vendredi",
    }),
  );
  assert.equal(slack.outbound, true);
  assert.deepEqual(slack.recipients, [], "hors Gmail et Outlook, aucun destinataire n'est déduit");
  assert.match(slack.summary, /Slack/);
  assert.equal(slack.preview, "On livre vendredi");

  // Un site quelconque : le bouton « Publier ».
  assert.equal(classifyOutbound(ctx({ host: "forum.exemple.fr", target: el({ label: "Publier" }) })).outbound, true);
  assert.equal(classifyOutbound(ctx({ host: "blog.example.com", target: el({ label: "Reply" }) })).outbound, true);

  // Un formulaire de recherche soumis : pas un envoi.
  const search = classifyOutbound(
    ctx({
      gesture: "type-submit",
      target: el({
        tag: "input",
        role: "searchbox",
        type: "search",
        label: "Rechercher",
        editable: true,
        formIsSearch: true,
      }),
      composerText: "devis 2026",
    }),
  );
  assert.equal(search.outbound, false);
  assert.equal(search.summary, "");
  assert.equal(
    classifyOutbound(ctx({ target: el({ label: "Rechercher", submitsForm: true, formIsSearch: true }) })).outbound,
    false,
  );

  // Un lien ordinaire : navigation.
  assert.equal(classifyOutbound(ctx({ target: el({ tag: "a", role: "link", label: "Tarifs" }) })).outbound, false);
  // Un champ d'une ligne d'un formulaire de connexion : Enter n'envoie rien à personne.
  assert.equal(
    classifyOutbound(
      ctx({
        gesture: "key-enter",
        target: el({ tag: "input", role: "textbox", type: "email", label: "Adresse e-mail", editable: true }),
      }),
    ).outbound,
    false,
  );

  // Un compositeur inconnu soumis : envoi, destinataires inconnus.
  const unknown = classifyOutbound(
    ctx({
      host: "intranet.example",
      gesture: "type-submit",
      target: el({
        tag: "textarea",
        role: "textbox",
        label: "",
        editable: true,
        inComposer: true,
        formHasFreeText: true,
      }),
      composerText: "Merci pour votre retour",
    }),
  );
  assert.equal(unknown.outbound, true);
  assert.deepEqual(unknown.recipients, []);
  assert.equal(
    classifyOutbound(ctx({ target: el({ label: "OK", submitsForm: true, formHasFreeText: true }) })).outbound,
    true,
    "un submit de formulaire qui porte un texte libre",
  );

  // Le doute vaut garde : une erreur du classifieur rend un envoi.
  const broken = ctx({});
  Object.defineProperty(broken.target, "label", {
    get() {
      throw new Error("libellé illisible");
    },
  });
  assert.equal(guardGesture(broken).outbound, true);
});

test("poste-extension/AC-6 : un envoi ne part qu'approuvé et identique à ce que l'humain a vu ; sans approbation il n'est pas exécuté", () => {
  const verdict = classifyOutbound(
    ctx({
      host: "mail.google.com",
      target: el({ label: "Envoyer", inComposer: true }),
      composerText: "Le devis est prêt.",
      recipientHints: ["b@client.fr", "a@client.fr"],
    }),
  );
  assert.equal(verdict.outbound, true);
  const seen = sendFingerprint({
    origin: "https://mail.google.com",
    path: "/mail/u/0/",
    title: "Devis",
    recipients: verdict.recipients,
    text: "Le devis est prêt.",
  });

  assert.deepEqual(approvalGate(verdict, { approved: false, approval: null }, seen), {
    outcome: "needs_approval",
    approval: {
      summary: verdict.summary,
      recipients: ["b@client.fr", "a@client.fr"],
      preview: "Le devis est prêt.",
      fingerprint: seen,
    },
  });
  // approved: true et la même empreinte que l'envoi recalculé : le geste part.
  assert.equal(approvalGate(verdict, { approved: true, approval: { fingerprint: seen } }, seen), null);
  // Envoi changé (autre empreinte), approbation sans empreinte (nulle, ou absente comme la
  // rend Chrome après executeScript), ou empreinte sans approbation : nouvelle demande.
  const other = sendFingerprint({
    origin: "https://mail.google.com",
    path: "/mail/u/0/",
    title: "Devis",
    recipients: verdict.recipients,
    text: "Un autre texte.",
  });
  for (const gate of [
    { approved: true, approval: { fingerprint: other } },
    { approved: true, approval: { fingerprint: null } },
    { approved: true, approval: {} },
    { approved: true, approval: null },
    { approved: true },
    { approved: false, approval: { fingerprint: seen } },
  ]) {
    assert.equal(approvalGate(verdict, gate, seen)?.outcome, "needs_approval", JSON.stringify(gate));
  }
  // Un geste qui n'envoie rien n'attend rien.
  const link = classifyOutbound(ctx({ target: el({ tag: "a", role: "link", label: "Accueil" }) }));
  assert.equal(approvalGate(link, { approved: false, approval: null }, seen), null);
});

/** Une doublure minimale du DOM : attributs, visibilité, et le sous-ensemble des sélecteurs CSS du module. */
class FakeElement implements SnapElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  textContent: string | null;
  value?: string;
  labels?: { textContent: string | null }[];
  visible = true;
  constructor(
    tag: string,
    attributes: Record<string, string> = {},
    options: { text?: string; value?: string; labels?: string[] } = {},
  ) {
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
    this.textContent = options.text ?? "";
    if (options.value !== undefined) this.value = options.value;
    if (options.labels) this.labels = options.labels.map((text) => ({ textContent: text }));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  checkVisibility(): boolean {
    return this.visible;
  }
}

type Attributed = Pick<SnapElement, "tagName" | "getAttribute" | "hasAttribute">;

function attributeMatches(el: Attributed, expression: string): boolean {
  const [name = "", value] = expression.split("=");
  return value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value.replace(/^["']|["']$/g, "");
}

function matches(el: Attributed, selector: string): boolean {
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

function fakeDocument(elements: FakeElement[], bodyText: string): SnapDocument {
  return {
    title: "Devis — CRM",
    location: { href: "https://crm.example.com/devis/12?onglet=lignes" },
    body: { innerText: bodyText, textContent: bodyText },
    querySelectorAll: (selector: string) => elements.filter((candidate) => matches(candidate, selector)),
    getElementById: (id: string) => elements.find((candidate) => candidate.getAttribute("id") === id) ?? null,
  };
}

test("poste-extension/AC-7 : le snapshot numérote les seuls éléments interactifs visibles, nomme sans lire les saisies et renumérote", () => {
  const stale = new FakeElement("div", { [REF_ATTRIBUTE]: "e9" }, { text: "vieux" });
  const send = new FakeElement("button", { "aria-label": "Envoyer" }, { text: "✉" });
  const hidden = new FakeElement("button", {}, { text: "Caché" });
  hidden.visible = false;
  const subject = new FakeElement("input", { type: "text" }, { value: "Devis 12", labels: ["Objet"] });
  const password = new FakeElement("input", { type: "password" }, { value: "motdepasse", labels: ["Mot de passe"] });
  const token = new FakeElement("input", { type: "hidden" }, { value: "csrf" });
  const link = new FakeElement("a", { href: "/accueil" }, { text: "  Accueil  " });
  const editor = new FakeElement("div", { contenteditable: "true" }, { text: "brouillon confidentiel" });
  const disabled = new FakeElement("button", { disabled: "" }, { text: "Supprimer" });
  const caption = new FakeElement("span", { id: "titre-publier" }, { text: "Publier le devis" });
  const publish = new FakeElement("div", { role: "button", "aria-labelledby": "titre-publier" }, { text: "" });
  const submit = new FakeElement("input", { type: "submit", value: "Valider" });
  const all = [stale, send, hidden, subject, password, token, link, editor, disabled, caption, publish, submit];
  const body = `Lignes du devis\n\n\n\n${"é".repeat(MAX_TEXT + 500)}`;
  const doc = fakeDocument(all, body);

  const first = takeSnapshot(doc, { fullUrl: true });
  assert.equal(first.title, "Devis — CRM");
  assert.equal(first.url, "https://crm.example.com/devis/12?onglet=lignes");
  assert.ok(first.text.startsWith("Lignes du devis\n\né"));
  assert.equal(first.text.length, MAX_TEXT);
  assert.deepEqual(first.elements, [
    { ref: "e1", role: "button", label: "Envoyer" },
    { ref: "e2", role: "textbox", label: "Objet", value: "Devis 12" },
    { ref: "e3", role: "textbox", label: "Mot de passe" },
    { ref: "e4", role: "link", label: "Accueil" },
    { ref: "e5", role: "textbox", label: "" },
    { ref: "e6", role: "button", label: "Publier le devis" },
    { ref: "e7", role: "button", label: "Valider" },
  ]);
  assert.equal(stale.hasAttribute(REF_ATTRIBUTE), false, "une référence d'un ancien snapshot est retirée");
  for (const skipped of [hidden, token, disabled, caption]) assert.equal(skipped.hasAttribute(REF_ATTRIBUTE), false);
  assert.equal(editor.getAttribute(REF_ATTRIBUTE), "e5");
  assert.ok(!JSON.stringify(first).includes("motdepasse"));
  assert.ok(!JSON.stringify(first.elements).includes("brouillon"));
  assert.ok(INTERACTIVE_SELECTOR.includes("[contenteditable]"));

  // Le bouton disparaît : le snapshot suivant renumérote, l'ancienne référence ne désigne plus rien.
  send.visible = false;
  const second = takeSnapshot(doc);
  assert.equal(second.elements[0]?.label, "Objet");
  assert.equal(second.elements[0]?.ref, "e1");
  assert.equal(send.hasAttribute(REF_ATTRIBUTE), false);
  assert.equal(second.elements.length, 6);
  assert.equal(takeSnapshot(doc, { maxElements: 2 }).elements.length, 2);
});

test("poste-extension/AC-8 : chaque kind d'action valide ses paramètres avant toute exécution", () => {
  const ok = (kind: string, params: unknown) => {
    const result = validateAction(kind, params);
    assert.ok(result.ok, `${kind} ${JSON.stringify(params)} : ${result.ok ? "" : result.error}`);
    return result.params;
  };
  const refused = (kind: string, params: unknown, pattern: RegExp) => {
    const result = validateAction(kind, params);
    assert.equal(result.ok, false, `${kind} ${JSON.stringify(params)} accepté`);
    if (!result.ok) assert.match(result.error, pattern);
  };

  assert.deepEqual(ok("tabs", {}), { kind: "tabs" });
  assert.deepEqual(ok("decision", undefined), { kind: "decision" });
  assert.deepEqual(ok("open", { url: "https://exemple.fr/a?b=1" }), { kind: "open", url: "https://exemple.fr/a?b=1" });
  refused("open", { url: "javascript:alert(1)" }, /http\(s\)/);
  refused("open", { url: "file:///etc/passwd" }, /http\(s\)/);
  refused("open", {}, /url/);
  assert.deepEqual(ok("navigate", { tabId: 4, url: "http://intra/x" }), {
    kind: "navigate",
    tabId: 4,
    url: "http://intra/x",
  });
  refused("navigate", { url: "https://exemple.fr" }, /tabId/);
  for (const kind of ["snapshot", "screenshot", "close"]) {
    assert.deepEqual(ok(kind, { tabId: 0 }), { kind, tabId: 0 });
    refused(kind, { tabId: -1 }, /tabId/);
    refused(kind, { tabId: 1.5 }, /tabId/);
    refused(kind, { tabId: "3" }, /tabId/);
  }
  assert.deepEqual(ok("click", { tabId: 3, ref: "e12" }), { kind: "click", tabId: 3, ref: "e12" });
  refused("click", { tabId: 3, ref: "bouton" }, /ref/);
  refused("click", { tabId: 3, ref: 'e1"] , body [x="' }, /ref/);
  assert.deepEqual(ok("type", { tabId: 3, ref: "e2", text: "Bonjour" }), {
    kind: "type",
    tabId: 3,
    ref: "e2",
    text: "Bonjour",
    submit: false,
  });
  assert.equal((ok("type", { tabId: 3, ref: "e2", text: "", submit: true }) as { submit: boolean }).submit, true);
  refused("type", { tabId: 3, ref: "e2" }, /text/);
  refused("type", { tabId: 3, ref: "e2", text: "x", submit: "oui" }, /submit/);
  refused("type", { tabId: 3, ref: "e2", text: "x".repeat(MAX_TYPE_TEXT + 1) }, /text/);
  assert.deepEqual(ok("key", { tabId: 3, key: "Enter" }), { kind: "key", tabId: 3, ref: null, key: "Enter" });
  assert.deepEqual(ok("key", { tabId: 3, ref: "e1", key: "Backspace" }), {
    kind: "key",
    tabId: 3,
    ref: "e1",
    key: "Backspace",
  });
  refused("key", { tabId: 3, key: "a" }, /key/);
  refused("key", { tabId: 3, key: "Enter", ref: "x" }, /ref/);
  assert.deepEqual(ok("scroll", { tabId: 3, dy: -400 }), { kind: "scroll", tabId: 3, dy: -400 });
  refused("scroll", { tabId: 3, dy: Number.NaN }, /dy/);
  refused("scroll", { tabId: 3 }, /dy/);
  assert.deepEqual(ok("wait", { ms: MAX_WAIT_MS }), { kind: "wait", ms: MAX_WAIT_MS });
  refused("wait", { ms: MAX_WAIT_MS + 1 }, /ms/);
  refused("wait", { ms: -1 }, /ms/);
  refused("supprimer", {}, /action inconnue : supprimer/);
});

test("poste-extension/AC-9 : un segment part en multipart à l'oMLX local (file, model, response_format, Bearer), jamais à une adresse distante", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ text: "  On vise le 12 mars.  " }), { status: 200 });
  }) as typeof fetch;
  const audio = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm" });
  const settings = { url: "http://127.0.0.1:8000/", key: " cle-omlx ", model: "whisper-large-v3-turbo" };

  assert.equal(await transcribe(settings, audio, "segment-moi-1.webm", fetcher), "On vise le 12 mars.");
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call?.url, "http://127.0.0.1:8000/v1/audio/transcriptions");
  assert.equal(call?.init.method, "POST");
  assert.deepEqual(call?.init.headers, { Authorization: "Bearer cle-omlx" });
  const form = call?.init.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "whisper-large-v3-turbo");
  assert.equal(form.get("response_format"), "json");
  const file = form.get("file");
  assert.ok(file instanceof Blob);
  assert.equal((file as File).name, "segment-moi-1.webm");
  assert.equal(file.size, 4);
  assert.deepEqual([...form.keys()].sort(), ["file", "model", "response_format"]);

  // Sans clé : aucun en-tête d'autorisation.
  assert.deepEqual(transcriptionRequest({ ...settings, key: "" }, audio, "s.webm").init.headers, {});
  assert.equal(
    transcriptionRequest({ ...settings, url: "http://localhost:9000/omlx" }, audio, "s.webm").url,
    "http://localhost:9000/omlx/v1/audio/transcriptions",
  );

  // Une réponse en erreur est nommée ; une adresse non locale est refusée AVANT tout appel.
  const failing = (async () => new Response("modèle absent", { status: 404 })) as typeof fetch;
  await assert.rejects(transcribe(settings, audio, "s.webm", failing), /oMLX a répondu 404 : modèle absent/);
  for (const remote of ["http://192.168.1.20:8000", "https://stt.example.com", "http://127.0.0.1.evil.example"]) {
    assert.equal(validateSttUrl(remote).ok, false, remote);
    const before: number = calls.length;
    await assert.rejects(transcribe({ ...settings, url: remote }, audio, "s.webm", fetcher), /ne quitte jamais le Mac/);
    assert.equal(calls.length, before, `${remote} : aucun appel`);
  }
  assert.deepEqual(validateSttUrl("http://[::1]:8000/"), { ok: true, url: "http://[::1]:8000" });
});

function build(out: string, cwd = ROOT) {
  return spawnSync("bash", [path.join(cwd, "scripts", "chrome-extension.sh"), out], { cwd, encoding: "utf8" });
}

const REQUIRED_PERMISSIONS = ["storage", "tabs", "scripting", "idle", "alarms", "offscreen", "tabCapture", "activeTab"];

test("poste-extension/AC-10 : scripts/chrome-extension.sh produit une extension MV3 complète dont chaque script se charge", () => {
  const root = tmpdir("poste-extension-");
  // Les modules sont jugés comme Chrome les lit : des modules ES (package.json voisin de type module).
  fs.writeFileSync(path.join(root, "package.json"), '{ "type": "module" }\n');
  const out = path.join(root, "dist");
  const run = build(out);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /✓ extension construite/);

  const read = (rel: string) => fs.readFileSync(path.join(out, rel), "utf8");
  const files = fs
    .readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(out, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
  const manifest = JSON.parse(read("manifest.json"));
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, "omp-chrome", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, source.version);
  assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
  for (const permission of REQUIRED_PERMISSIONS) assert.ok(manifest.permissions.includes(permission), permission);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.background.type, "module");

  // Chaque fichier cité par le manifeste existe ; les icônes sont des PNG de la taille annoncée.
  const cited = [
    manifest.background.service_worker,
    manifest.options_ui.page,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((script: { js: string[] }) => script.js),
  ];
  for (const file of cited) assert.ok(files.includes(file), `${file} cité par le manifeste, absent`);
  for (const icons of [manifest.icons, manifest.action.default_icon]) {
    for (const [size, file] of Object.entries(icons as Record<string, string>)) {
      const png = fs.readFileSync(path.join(out, file));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], file);
      assert.equal(png.readUInt32BE(16), Number(size), `${file} : largeur`);
      assert.equal(png.readUInt32BE(20), Number(size), `${file} : hauteur`);
    }
  }
  for (const entry of manifest.web_accessible_resources) {
    for (const pattern of entry.resources as string[]) {
      const regexp = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`);
      assert.ok(
        files.some((file) => regexp.test(file)),
        `web_accessible_resources : rien pour ${pattern}`,
      );
    }
  }
  // Les pages HTML ne citent que des fichiers construits.
  for (const page of files.filter((file) => file.endsWith(".html"))) {
    for (const [, ref = ""] of read(page).matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(files.includes(path.posix.join(path.posix.dirname(page), ref)), `${page} cite ${ref}, absent`);
    }
  }

  // Aucun TypeScript ne survit ; chaque import relatif désigne un fichier construit.
  assert.deepEqual(
    files.filter((file) => file.endsWith(".ts")),
    [],
  );
  const scripts = files.filter((file) => file.endsWith(".js"));
  assert.ok(scripts.includes("page/agent.js") && scripts.includes("offscreen/offscreen.js"));
  for (const file of scripts) {
    for (const [, specifier = ""] of read(file).matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      assert.ok(
        files.includes(path.posix.join(path.posix.dirname(file), specifier)),
        `${file} importe ${specifier}, absent`,
      );
    }
    const check = spawnSync(process.execPath, ["--check", path.join(out, file)], { encoding: "utf8" });
    assert.equal(check.status, 0, `${file} ne se charge pas :\n${check.stderr}`);
  }
  // Un script de contenu MV3 est un script classique : ni import ni export statiques.
  for (const file of manifest.content_scripts.flatMap((script: { js: string[] }) => script.js)) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }), `${file} n'est pas un script classique`);
  }
});

test("poste-extension/AC-11 : une syntaxe non effaçable ou un import vers un fichier absent fait échouer la construction sans toucher la précédente", () => {
  // Un arbre jetable : le script, sa logique et les sources de l'extension.
  const tree = tmpdir("poste-extension-arbre-");
  for (const rel of ["scripts/chrome-extension.sh", "scripts/chrome-extension/build.ts", "omp-chrome/manifest.json"]) {
    fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(tree, rel));
  }
  fs.cpSync(path.join(ROOT, "omp-chrome", "src"), path.join(tree, "omp-chrome", "src"), { recursive: true });
  const out = path.join(tree, "sortie");
  const first = build(out, tree);
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  const before = fs.readFileSync(path.join(out, "background.js"), "utf8");

  for (const [file, content, expected] of [
    ["omp-chrome/src/lib/zz-enum.ts", "export enum Etat { A, B }\n", /omp-chrome\/src\/lib\/zz-enum\.ts/],
    [
      "omp-chrome/src/lib/zz-import.ts",
      'import { x } from "./absent.ts";\nexport const y = x;\n',
      /lib\/zz-import\.js importe \.\/absent\.js/,
    ],
  ] as const) {
    fs.writeFileSync(path.join(tree, file), content);
    const run = build(out, tree);
    assert.equal(run.status, 1, `${file} :\n${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /✗ construction de l'extension/);
    assert.match(run.stderr, expected);
    assert.equal(
      fs.readFileSync(path.join(out, "background.js"), "utf8"),
      before,
      "la construction précédente est intacte",
    );
    assert.equal(fs.existsSync(path.join(out, "lib", "zz-enum.js")), false);
    fs.rmSync(path.join(tree, file));
  }

  // Un dossier de sortie qui n'est pas une construction de l'extension n'est jamais écrasé.
  const foreign = path.join(tree, "documents");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "notes.txt"), "à garder\n");
  const refused = build(foreign, tree);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(fs.readFileSync(path.join(foreign, "notes.txt"), "utf8"), "à garder\n");
});

/** Une doublure d'arbre DOM pour la garde d'envoi : parents, descendants, texte, valeurs, éditabilité héritée. */
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

test("poste-extension/AC-12 : l'empreinte lie l'approbation à l'onglet, à la conversation, aux destinataires et au texte entier ; une approbation sans empreinte n'envoie rien", () => {
  // SHA-256 pur (calculable sur une page http://), conforme à node:crypto.
  for (const text of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "À bientôt 🙂".repeat(300)]) {
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"));
  }
  const base = {
    origin: "https://acme.slack.com",
    path: "/client/T1/C42",
    title: "#clients - Acme - Slack",
    recipients: ["b@x.fr", "a@x.fr"],
    text: "On livre vendredi.",
  };
  const fingerprint = sendFingerprint(base);
  // Révision 2 §1 : SHA-256 hex de JSON.stringify([origine, chemin, titre, destinataires triés, texte complet]).
  assert.equal(
    fingerprint,
    createHash("sha256")
      .update(JSON.stringify([base.origin, base.path, base.title, ["a@x.fr", "b@x.fr"], base.text]))
      .digest("hex"),
  );
  assert.equal(sendFingerprint({ ...base, recipients: ["a@x.fr", "b@x.fr"] }), fingerprint, "ordre indifférent");
  for (const changed of [
    { ...base, text: "On livre lundi." },
    { ...base, recipients: ["a@x.fr"] },
    { ...base, recipients: [...base.recipients, "c@x.fr"] },
    { ...base, path: "/client/T1/C99" },
    { ...base, title: "#direction - Acme - Slack" },
    { ...base, origin: "https://autre.slack.com" },
  ]) {
    assert.notEqual(sendFingerprint(changed), fingerprint, JSON.stringify(changed));
  }
  // Le texte n'est jamais coupé : une fin changée au-delà de l'aperçu change l'empreinte.
  const long = "x".repeat(MAX_PREVIEW * 2);
  assert.notEqual(sendFingerprint({ ...base, text: `${long}a` }), sendFingerprint({ ...base, text: `${long}b` }));

  // Un envoi à aperçu vide et sans destinataire, approuvé en mode proposer (empreinte nulle,
  // ou absente comme la rend Chrome) : jamais exécuté.
  const send = classifyOutbound(
    ctx({ host: "acme.slack.com", path: base.path, title: base.title, target: el({ label: "Envoyer" }) }),
  );
  assert.equal(send.outbound, true);
  assert.equal(send.preview, "");
  assert.deepEqual(send.recipients, []);
  const sentAs = sendFingerprint({ ...base, recipients: [], text: "" });
  const proposeMode = { summary: "Cliquer sur e2 dans l'onglet 123", recipients: [], preview: "", fingerprint: null };
  for (const approval of [proposeMode, { ...proposeMode, fingerprint: undefined }]) {
    assert.equal(approvalGate(send, { approved: true, approval }, sentAs)?.outcome, "needs_approval");
  }
  // La demande porte l'empreinte, et l'humain voit la destination : service, hôte, chemin, conversation.
  assert.equal(approvalGate(send, { approved: false }, sentAs)?.approval.fingerprint, sentAs);
  assert.match(send.summary, /Slack/);
  assert.ok(send.summary.includes("acme.slack.com/client/T1/C42"), send.summary);
  assert.ok(send.summary.includes("« #clients - Acme - Slack »"), send.summary);
});

test("poste-extension/AC-13 : le texte d'un champ <input> du compositeur entre dans l'aperçu et l'empreinte ; recherche et champs secrets n'y entrent jamais", () => {
  const message = field({ "aria-label": "Message" }, "Bonjour, voici le lien");
  const send = h("button", { "aria-label": "Envoyer" }, "➤");
  const search = field({ type: "search", "aria-label": "Rechercher" }, "facture 12");
  const code = field({ type: "text", autocomplete: "one-time-code" }, "424242");
  const page = fakePage(
    "Support - Acme",
    h("div", {}, search),
    h("div", { role: "region" }, message, send),
    h("div", {}, code),
  );
  const where = at("https://support.acme.example/tickets/7?onglet=chat#bas");

  const first = inspectGesture(send, page, where, "click", null);
  assert.equal(first.verdict.outbound, true);
  assert.equal(first.verdict.preview, "Bonjour, voici le lien");
  assert.ok(
    first.verdict.summary.includes("support.acme.example/tickets/7 · « Support - Acme »"),
    first.verdict.summary,
  );
  assert.ok(!first.verdict.summary.includes("onglet=chat"));
  // Enter dans le champ : même envoi, même empreinte.
  const enter = inspectGesture(message, page, where, "key-enter", null);
  assert.equal(enter.verdict.outbound, true);
  assert.equal(enter.fingerprint, first.fingerprint);

  // Le champ réécrit après l'approbation : l'empreinte change, le clic approuvé ne part pas.
  message.value = "Autre texte";
  const rewritten = inspectGesture(send, page, where, "click", null);
  assert.notEqual(rewritten.fingerprint, first.fingerprint);
  assert.equal(
    approvalGate(
      rewritten.verdict,
      { approved: true, approval: { fingerprint: first.fingerprint } },
      rewritten.fingerprint,
    )?.outcome,
    "needs_approval",
  );

  // Au-delà de l'aperçu (coupé pour l'affichage), l'empreinte porte encore tout le texte.
  message.value = "y".repeat(MAX_PREVIEW + 100);
  const long = inspectGesture(send, page, where, "click", null);
  message.value = `${"y".repeat(MAX_PREVIEW + 99)}z`;
  const longer = inspectGesture(send, page, where, "click", null);
  assert.ok(long.verdict.preview.length <= MAX_PREVIEW);
  assert.equal(long.verdict.preview, longer.verdict.preview);
  assert.notEqual(long.fingerprint, longer.fingerprint);

  // `type` avec submit : le texte saisi remplace le contenu actuel du champ.
  const typed = inspectGesture(message, page, where, "type-submit", "Texte saisi");
  assert.equal(typed.verdict.preview, "Texte saisi");
  for (const { verdict } of [first, enter, typed]) {
    assert.ok(!verdict.preview.includes("facture") && !verdict.preview.includes("424242"), verdict.preview);
  }
});

test("poste-extension/AC-14 : le puits « À » d'Outlook en français est lu, et un puits de destinataires illisible rend la liste vide", () => {
  for (const label of ["À", "À : Paul", "à", "A", "To", "Cc", "Cci", "Bcc", "CC :"]) {
    assert.ok(RECIPIENT_WELL.test(label), label);
  }
  for (const label of ["Accueil", "Àpropos", "Total", "Ccomptes", "Toolbar", "Adresse"]) {
    assert.ok(!RECIPIENT_WELL.test(label), label);
  }

  const compose = (to: FakeNode) => {
    const send = h("button", { "aria-label": "Envoyer" }, "Envoyer");
    const page = fakePage(
      "Nouveau message - Outlook",
      h(
        "div",
        { role: "dialog" },
        to,
        h("div", { "aria-label": "Cc" }, h("span", {}, "moi@exemple.fr")),
        h("div", { contenteditable: "true", "aria-label": "Corps du message" }, "Bonjour"),
        send,
      ),
    );
    return inspectGesture(send, page, at("https://outlook.office.com/mail/deeplink/compose"), "click", null).verdict;
  };
  // Le champ À est lu : le client compte, l'envoi n'est pas « à soi ».
  const both = compose(h("div", { "aria-label": "À" }, h("span", {}, "client@acme.com")));
  assert.equal(both.outbound, true);
  assert.deepEqual([...both.recipients].sort(), ["client@acme.com", "moi@exemple.fr"]);
  // Cc à soi lisible, champ À présent mais illisible : la liste est vide (approbation humaine exigée).
  for (const to of [
    h("div", { "aria-label": "À" }, h("span", {}, "Client Acme")),
    h("div", { "aria-label": "À" }, h("span", { role: "button" })),
    h("div", { "aria-label": "To" }, h("span", {}, "client@acme.com"), h("span", {}, "Paul Martin")),
    h("div", { "aria-label": "À" }, h("span", {}, "moi@exemple.fr"), field({ "aria-label": "Ajouter" }, "paul")),
  ]) {
    assert.deepEqual(compose(to).recipients, [], to.textContent);
  }
});

test("poste-extension/AC-15 : le submit d'un formulaire qui porte un message (champ « Message », seul champ texte) est un envoi ; connexion et recherche n'en sont pas", () => {
  const click = (...fields: FakeNode[]) => {
    const ok = h("button", {}, "OK");
    const page = fakePage("Contact", h("form", {}, ...fields, ok));
    return inspectGesture(ok, page, at("https://www.exemple.fr/contact"), "click", null).verdict;
  };
  const composer = click(field({ "aria-label": "Message" }, "Bonjour"));
  assert.equal(composer.outbound, true);
  assert.equal(composer.preview, "Bonjour");
  assert.equal(click(field({ placeholder: "Votre texte" }, "Salut")).outbound, true, "seul champ texte visible");
  assert.equal(
    click(field({ "aria-label": "Nom" }, "Jean"), field({ "aria-label": "Votre commentaire" }, "Super")).outbound,
    true,
  );
  // Connexion (mot de passe) et recherche : rien ne part vers quelqu'un.
  assert.equal(
    click(
      field({ type: "email", "aria-label": "Adresse e-mail" }, "moi@exemple.fr"),
      field({ type: "password", "aria-label": "Mot de passe" }, "secret"),
    ).outbound,
    false,
  );
  assert.equal(click(field({ name: "q", "aria-label": "Rechercher" }, "devis")).outbound, false);
  assert.equal(click(field({ type: "search", name: "q" }, "devis")).outbound, false);
});

test("poste-extension/AC-16 : le snapshot ne rend jamais la valeur d'un champ secret, et l'adresse d'un onglet de l'utilisateur perd query et fragment", () => {
  const secrets = [
    new FakeElement("input", { type: "text", autocomplete: "cc-number" }, { value: "4970101010101010" }),
    new FakeElement("input", { type: "text", autocomplete: "cc-csc" }, { value: "731" }),
    new FakeElement("input", { type: "text", autocomplete: "one-time-code" }, { value: "908172" }),
    new FakeElement("input", { type: "text", autocomplete: "username current-password" }, { value: "motdepasse1" }),
    new FakeElement("input", { autocomplete: "new-password" }, { value: "motdepasse2" }),
    new FakeElement("input", { type: "password" }, { value: "motdepasse3" }),
  ];
  const name = new FakeElement(
    "input",
    { type: "text", autocomplete: "name" },
    { value: "Jean Dupont", labels: ["Nom"] },
  );
  const doc: SnapDocument = {
    ...fakeDocument([...secrets, name], "Paiement"),
    location: { href: "https://pay.example.com/checkout/42?reset_token=abc123&code=xyz#etape-2" },
  };
  const snapshot = takeSnapshot(doc);
  assert.equal(snapshot.url, "https://pay.example.com/checkout/42");
  assert.equal(snapshot.elements.length, 7);
  assert.deepEqual(
    snapshot.elements.flatMap((element) => (element.value === undefined ? [] : [element.value])),
    ["Jean Dupont"],
  );
  const json = JSON.stringify(snapshot);
  for (const secret of ["4970101010101010", "731", "908172", "motdepasse", "abc123", "etape-2"]) {
    assert.ok(!json.includes(secret), secret);
  }
  // Un onglet de la fenêtre de l'agent garde son adresse complète.
  assert.equal(takeSnapshot(doc, { fullUrl: true }).url, doc.location.href);
});

test("poste-extension/AC-17 : un éditable ou un champ de saisie ne se nomme jamais par son contenu, quel que soit son rôle explicite", () => {
  const doc = { getElementById: () => null };
  for (const [tag, attributes] of [
    ["div", { role: "combobox", contenteditable: "true" }],
    ["div", { role: "combobox", contenteditable: "" }],
    ["span", { role: "combobox" }],
    ["div", { role: "searchbox" }],
    ["div", { role: "textbox" }],
    ["div", { role: "button", contenteditable: "plaintext-only" }],
    ["textarea", { role: "presentation" }],
  ] as const) {
    const editor = new FakeElement(tag, attributes, { text: "@Paul Martin le devis confidentiel" });
    assert.equal(labelOf(editor, doc), "", `${tag} ${JSON.stringify(attributes)}`);
  }
  // Éditable par héritage (un paragraphe dans l'éditeur) : rien non plus.
  const paragraph = Object.assign(new FakeElement("p", {}, { text: "brouillon" }), { isContentEditable: true });
  assert.equal(labelOf(paragraph, doc), "");
  // Le nom explicite reste lu ; un bouton se nomme toujours par son texte.
  const named = new FakeElement(
    "div",
    { role: "combobox", contenteditable: "true", "aria-label": "À" },
    { text: "paul" },
  );
  assert.equal(labelOf(named, doc), "À");
  assert.equal(labelOf(new FakeElement("div", { role: "button" }, { text: "Envoyer" }), doc), "Envoyer");
});
