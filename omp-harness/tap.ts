// Le décompte des tests TAP, critère par critère, au fil du flux stdout d'un passage de tests.
//
// Sans import du harness : une fonction pure et un compteur borné en mémoire (le nombre d'ids
// distincts, jamais la taille de la sortie).
import { StringDecoder } from "node:string_decoder";

export type TapCount = { tests: number; passed: number; failed: number };

/** `ids` : un compte par clé `<slug>/AC-n` (id qualifié) ou `AC-n` (id nu) ; `other` : les tests sans id. */
export type TapTally = { ids: Record<string, TapCount>; other: TapCount };

const QUALIFIED = /(?<![\w.-])([A-Za-z0-9][\w.-]*)\/AC-(\d+)(?![0-9])/;
const BARE = /(?<![\w/.-])AC-(\d+)(?![0-9])/;
const TAP_LINE = /^\s*(not ok|ok) \d+ - (.*?)(?:\s+# (SKIP|TODO)\b.*)?$/;

/** Une ligne en cours au-delà de cette taille est jetée jusqu'au prochain saut de ligne. */
const MAX_LINE = 64 * 1024;

/** L'id d'un titre de test : le qualifié l'emporte toujours, puis le nu (slug `null`), sinon `null`. */
export function testIdOf(title: string): { slug: string | null; ac: string } | null {
  const qualified = QUALIFIED.exec(title);
  if (qualified) return { slug: qualified[1] as string, ac: `AC-${qualified[2]}` };
  const bare = BARE.exec(title);
  return bare ? { slug: null, ac: `AC-${bare[1]}` } : null;
}

const zero = (): TapCount => ({ tests: 0, passed: 0, failed: 0 });

export class TapCounter {
  readonly #decoder = new StringDecoder("utf8");
  readonly #ids: Record<string, TapCount> = {};
  readonly #other = zero();
  #line = "";
  #skipping = false;
  /** Au moins un octet est arrivé. */
  seen = false;

  push(chunk: Buffer): void {
    if (chunk.length > 0) this.seen = true;
    const parts = this.#decoder.write(chunk).split("\n");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      if (i > 0) {
        if (!this.#skipping) this.#count(this.#line);
        this.#line = "";
        this.#skipping = false;
      }
      if (this.#skipping) continue;
      this.#line += part;
      if (this.#line.length > MAX_LINE) {
        this.#line = "";
        this.#skipping = true;
      }
    }
  }

  #count(raw: string): void {
    const match = TAP_LINE.exec(raw.replace(/\r$/, ""));
    if (!match || match[3]) return;
    const id = testIdOf(match[2] as string);
    const key = id ? (id.slug === null ? id.ac : `${id.slug}/${id.ac}`) : null;
    let count = key === null ? this.#other : this.#ids[key];
    if (count === undefined && key !== null) {
      count = zero();
      this.#ids[key] = count;
    }
    count.tests++;
    if (match[1] === "ok") count.passed++;
    else count.failed++;
  }

  /** Compte la dernière ligne (même sans saut final), puis rend le décompte. */
  result(): TapTally {
    this.#line += this.#decoder.end();
    if (!this.#skipping) this.#count(this.#line);
    this.#line = "";
    this.#skipping = false;
    return { ids: this.#ids, other: this.#other };
  }
}

/** Le même décompte sur une chaîne entière. */
export function tapTally(text: string): TapTally {
  const counter = new TapCounter();
  counter.push(Buffer.from(text, "utf8"));
  return counter.result();
}
