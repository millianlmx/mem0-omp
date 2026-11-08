// Un DOM minimal pour le côté page de l'extension (omp-chrome/src/page/agent.ts) : éléments
// et attributs, sélecteurs simples, shadow DOM ouvert, listes <select>, champs fichier,
// positions à l'écran (chaque élément a sa bande verticale, `elementFromPoint` la retrouve),
// frames, événements. `install` pose le document, la fenêtre et les classes sur `globalThis`
// AVANT l'import du module.
import assert from "node:assert/strict";

type Init = Record<string, unknown>;
type Rect = { left: number; top: number; width: number; height: number };

function attributeMatches(el: FakeElement, expression: string): boolean {
  const [name = "", value] = expression.split("=");
  return value === undefined ? el.hasAttribute(name) : el.getAttribute(name) === value.replace(/^["']|["']$/g, "");
}

function matches(el: FakeElement, selector: string): boolean {
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

/** L'état de la page : focus, défilement, sélection, et ce qui recouvre l'écran. */
export const page = {
  active: null as FakeElement | null,
  scrolled: 0,
  selected: null as FakeElement | null,
  /** Un élément qui recouvre tout (une modale) : `elementFromPoint` le rend, quel que soit le point. */
  cover: null as FakeElement | null,
  elements: [] as FakeElement[],
};

/** Une racine fantôme ouverte : ses enfants, son hôte, et le test de point de son arbre. */
export class FakeShadowRoot {
  readonly children: FakeElement[];
  readonly host: FakeElement;
  constructor(host: FakeElement, children: FakeElement[]) {
    this.host = host;
    this.children = children;
    for (const child of children) child.setRoot(this);
  }
  elementFromPoint(x: number, y: number): FakeElement | null {
    return hitTest(x, y);
  }
}

function hitTest(x: number, y: number): FakeElement | null {
  if (page.cover !== null) return page.cover;
  return (
    [...page.elements]
      .reverse()
      .find(
        (el) =>
          x >= el.rect.left &&
          x <= el.rect.left + el.rect.width &&
          y >= el.rect.top &&
          y <= el.rect.top + el.rect.height,
      ) ?? null
  );
}

export class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[];
  parentElement: FakeElement | null = null;
  shadowRoot: FakeShadowRoot | null = null;
  /** La racine où vit l'élément : le document (`null`) ou une racine fantôme. */
  root: FakeShadowRoot | null = null;
  readonly events: string[] = [];
  /** Les événements reçus, avec leur initialisation (touches, modificateurs). */
  readonly received: Event[] = [];
  ownText: string;
  visible = true;
  rect: Rect;
  readonly clientLeft = 0;
  readonly clientTop = 0;
  constructor(tag: string, attributes: Record<string, string> = {}, children: FakeElement[] = [], text = "") {
    super();
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
    this.children = children;
    this.ownText = text;
    for (const child of children) child.parentElement = this;
    // Une bande de l'écran à lui : son centre ne touche que lui.
    this.rect = { left: 0, top: page.elements.length * 40, width: 200, height: 30 };
    page.elements.push(this);
  }
  setRoot(root: FakeShadowRoot): void {
    this.root = root;
    for (const child of this.children) child.setRoot(root);
  }
  /** Ouvre une racine fantôme (`mode: "open"`) avec ces enfants. */
  attachShadowWith(children: FakeElement[]): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot(this, children);
    return this.shadowRoot;
  }
  get textContent(): string {
    return `${this.ownText}${this.children.map((child) => child.textContent).join("")}`;
  }
  set textContent(text: string) {
    this.ownText = text;
  }
  get innerText(): string {
    return this.textContent;
  }
  get isContentEditable(): boolean {
    const own = this.getAttribute("contenteditable");
    return own !== null ? own !== "false" : (this.parentElement?.isContentEditable ?? false);
  }
  get form(): FakeElement | null {
    return this.closest("form");
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
  matches(selector: string): boolean {
    return matches(this, selector);
  }
  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  querySelectorAll(selector: string): FakeElement[] {
    return [...this.descendants()].filter((node) => node.matches(selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node !== null; node = node.parentElement)
      if (node.matches(selector)) return node;
    return null;
  }
  /** Vrai si `other` est l'élément ou l'un de ses descendants, racines fantômes comprises. */
  contains(other: FakeElement | null): boolean {
    for (let node = other; node !== null; node = node.parentElement ?? node.root?.host ?? null)
      if (node === this) return true;
    return false;
  }
  getRootNode(): { elementFromPoint(x: number, y: number): FakeElement | null } {
    return this.root ?? { elementFromPoint: hitTest };
  }
  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
  }
  override dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    this.received.push(event);
    return super.dispatchEvent(event);
  }
  scrollIntoView(): void {}
  focus(): void {
    page.active = this;
  }
  click(): void {
    this.events.push("click()");
  }
}

export class FakeInput extends FakeElement {
  value = "";
  files: unknown = null;
  get type(): string {
    return (this.getAttribute("type") ?? "text").toLowerCase();
  }
  select(): void {
    this.events.push("select()");
    page.selected = this;
  }
}
export class FakeTextArea extends FakeInput {}

export class FakeOption extends FakeElement {
  selected = false;
  get value(): string {
    return this.getAttribute("value") ?? this.textContent;
  }
  get label(): string {
    return this.getAttribute("label") ?? this.textContent;
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
}

export class FakeSelect extends FakeElement {
  get options(): FakeOption[] {
    return this.children.filter((child): child is FakeOption => child instanceof FakeOption);
  }
  get multiple(): boolean {
    return this.hasAttribute("multiple");
  }
  /** La valeur de l'option choisie ; l'affecter choisit l'option (le setter natif que React contourne). */
  get value(): string {
    return this.options.find((option) => option.selected)?.value ?? "";
  }
  set value(value: string) {
    for (const option of this.options) option.selected = option.value === value;
  }
}

export class FakeLabel extends FakeElement {
  get control(): FakeElement | null {
    return this.querySelector("input");
  }
}

export class KeyboardEvent extends Event {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.key = String(init.key ?? "");
    this.code = String(init.code ?? "");
    this.ctrlKey = init.ctrlKey === true;
    this.metaKey = init.metaKey === true;
    this.shiftKey = init.shiftKey === true;
    this.altKey = init.altKey === true;
  }
}
export class MouseEvent extends Event {}
export class InputEvent extends Event {}
export class DragEvent extends Event {
  readonly dataTransfer: unknown;
  constructor(type: string, init: Init = {}) {
    super(type, init);
    this.dataTransfer = init.dataTransfer;
  }
}
export class DataTransfer {
  readonly files: File[] = [];
  readonly items = { add: (file: File) => this.files.push(file) };
}

/**
 * Pose le document et la fenêtre. `frame` : la page est une frame — de même origine que sa
 * page parente (l'élément `<iframe>` qui la porte, sa position s'ajoute) ou d'une autre
 * (`null` : `frameElement` est illisible).
 */
export function install(title: string, url: string, root: FakeElement, frame?: FakeElement | null): void {
  const html = new FakeElement("html", {}, [root]);
  const top = { top: undefined as unknown, parent: undefined as unknown, frameElement: null };
  top.top = top;
  top.parent = top;
  const own = {
    scrollBy: ({ top: dy }: { top: number }) => {
      page.scrolled += dy;
    },
    get scrollY() {
      return page.scrolled;
    },
    top: frame === undefined ? undefined : top,
    parent: frame === undefined ? undefined : top,
    frameElement: frame ?? null,
  } as Record<string, unknown>;
  if (frame === undefined) {
    own.top = own;
    own.parent = own;
  }
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, {
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    HTMLLabelElement: FakeLabel,
    KeyboardEvent,
    MouseEvent,
    InputEvent,
    DragEvent,
    DataTransfer,
    window: own,
    location: {
      href: url,
      origin: new URL(url).origin,
      hostname: new URL(url).hostname,
      pathname: new URL(url).pathname,
    },
    document: {
      title,
      body: root,
      documentElement: html,
      location: { href: url, origin: new URL(url).origin },
      get activeElement() {
        return page.active;
      },
      querySelector: (selector: string) => html.querySelector(selector),
      querySelectorAll: (selector: string) => html.querySelectorAll(selector),
      getElementById: (id: string) => [...html.descendants()].find((node) => node.getAttribute("id") === id) ?? null,
      elementFromPoint: hitTest,
      getSelection: () => ({
        selectAllChildren: (el: FakeElement) => {
          page.selected = el;
        },
      }),
      execCommand: () => false,
    },
  });
}
