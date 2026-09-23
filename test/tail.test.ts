// Tests du LECTEUR DE FIN DE SESSION (S-8 / AC-8) : le lecteur lit le JSONL
// d'une session depuis la FIN, borne sa première peinture à
// `SESSION_VIEW_READ_BYTES`, ne relit que les octets NEUFS quand le fichier a
// grandi, reporte une ligne partielle à la lecture suivante, repart de zéro sur
// une réécriture ou une troncature, et étend sa fenêtre vers le début par blocs
// bornés (`extendSessionTail`, plafonnée par `SESSION_VIEW_MAX_BYTES`).
//
// Les octets réellement lus sont COMPTÉS : `read` est un seam injecté, et le
// lecteur de test lit le VRAI fichier en ajoutant la longueur demandée à un
// compteur. La borne de S-8.1 est un critère d'acceptation, donc elle se prouve
// sur un compteur, jamais sur une intention. Les fichiers sont RÉELS, sous
// `mkdtempSync` ; aucune attente, aucun timer : tout est synchrone.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extendSessionTail,
  readSessionTail,
  SESSION_VIEW_MAX_BYTES,
  SESSION_VIEW_MAX_ENTRIES,
  SESSION_VIEW_READ_BYTES,
  type SessionEntryLike,
  type SessionReader,
  type SessionTail,
} from "../omp-mem0-req/extension.ts";

// ---------------------------------------------------------------------------
// Répertoire temporaire, fabriques de lignes, lecteur compteur
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

/** Le compte des octets DEMANDÉS au fichier : c'est lui qui prouve les bornes de S-8. */
type ReadStats = { bytes: number };

function newStats(): ReadStats {
  return { bytes: 0 };
}

/**
 * Le lecteur des tests : il lit le vrai fichier (comme `readBytesAt`) et compte
 * `length` octets par appel. Il rend `null` quand le fichier n'est pas ouvrable,
 * exactement comme le lecteur de la source.
 */
function countingReader(stats: ReadStats): SessionReader {
  return (file, offset, length) => {
    if (length <= 0) return Buffer.alloc(0);
    stats.bytes += length;
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const got = fs.readSync(fd, buf, filled, length - filled, offset + filled);
        if (got <= 0) break;
        filled += got;
      }
      return buf.subarray(0, filled);
    } catch {
      return null;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* descripteur déjà fermé : rien de mieux à faire */
      }
    }
  };
}

const STAMP = "2026-09-23T00:00:00.000Z";

/** L'en-tête de session : le lecteur le classe `other`, il compte quand même. */
function headerLine(id: string): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: STAMP, cwd: "/x" });
}

function messageLine(id: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: STAMP,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/** Écrit un fichier de session (une ligne JSON par entrée, terminée par `\n`). */
function sessionFile(dir: string, lines: string[]): string {
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => line + "\n").join(""));
  return file;
}

function appendLines(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map((line) => line + "\n").join(""));
}

function bytesOf(lines: string[]): number {
  return lines.reduce((total, line) => total + Buffer.byteLength(line + "\n", "utf8"), 0);
}

/** L'identifiant d'un message d'un gros fichier : longueur FIXE, donc lignes de taille égale. */
function bigId(i: number): string {
  return `m${String(i).padStart(5, "0")}`;
}

/** Un fichier de `count` messages d'environ `pad + 135` octets par ligne. */
function bigFile(dir: string, count: number, pad: number): string {
  const lines: string[] = [headerLine("s")];
  for (let i = 0; i < count; i += 1) lines.push(messageLine(bigId(i), "x".repeat(pad)));
  return sessionFile(dir, lines);
}

/** Le texte du dernier message rendu, ou `undefined` — jamais une assertion sur l'interne. */
function lastMessageText(entries: SessionEntryLike[]): string | undefined {
  const last = entries[entries.length - 1];
  if (!last || last.type !== "message") return undefined;
  const content = last.message.content;
  if (!Array.isArray(content)) return undefined;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : undefined;
}

function idsOf(entries: SessionEntryLike[]): string[] {
  return entries.map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// AC-8 — bornes et performance du lecteur de session
// ---------------------------------------------------------------------------

test("une entrée ajoutée ne coûte que ses propres octets", () => {
  const dir = mktmp("tail-append-");
  // Une session de plus d'un mégaoctet : la première peinture n'en charge que la fin,
  // et un ajout doit coûter ses propres octets, jamais la transcription entière.
  const file = bigFile(dir, 3000, 320);
  const size1 = fs.statSync(file).size;
  assert.ok(size1 > 1024 * 1024, `fichier de départ trop petit pour que la mesure veuille dire quelque chose : ${size1}`);

  const stats1 = newStats();
  const first = readSessionTail(file, null, countingReader(stats1));
  assert.equal(first.mode, "reset", "la première lecture reconstruit la fenêtre");
  assert.ok(first.tail, "une première lecture réussie doit rendre un état");
  assert.ok(first.tail.start > 0, "la première peinture ne charge que la fin du fichier");
  assert.equal(first.truncated, true, "le début du fichier n'est pas chargé");
  assert.ok(first.entries.length > 0, "la première lecture doit rendre des entrées");

  const added = [messageLine("n0", "b".repeat(250)), messageLine("n1", "b".repeat(250)), messageLine("n2", "b".repeat(250))];
  const addedBytes = bytesOf(added);
  appendLines(file, added);

  const stats2 = newStats();
  const second = readSessionTail(file, first.tail, countingReader(stats2));
  assert.equal(second.mode, "append", "un fichier qui n'a fait que grandir s'ajoute à la fenêtre");
  assert.equal(second.entries.length, 3, "seules les trois entrées neuves sont analysées");
  assert.deepEqual(idsOf(second.entries), ["n0", "n1", "n2"]);
  assert.equal(second.entries[0].at, size1, "la première entrée neuve commence au premier octet ajouté");
  assert.ok(second.tail, "une lecture en ajout doit rendre un état");
  assert.equal(second.tail.start, first.tail.start, "la fenêtre déjà chargée n'est pas reconstruite");
  // Sondes d'identité (au plus 6 blocs de 4 Kio : trois pour vérifier, trois pour
  // recalculer) + les trois lignes neuves. Jamais le fichier entier.
  assert.ok(
    stats2.bytes <= 6 * 4096 + addedBytes,
    `le second appel a lu ${stats2.bytes} octets pour ${addedBytes} octets neufs`,
  );
  assert.ok(stats2.bytes * 10 < size1, `un ajout a lu ${stats2.bytes} octets sur un fichier de ${size1}`);
  assert.ok(stats2.bytes < stats1.bytes, "un ajout doit coûter moins que la première peinture");

  // Le cas d'AC-8.2 : dix entrées ajoutées, dix ré-analysées, jamais la totalité.
  const later = Array.from({ length: 7 }, (_, i) => messageLine(`p${i}`, "c".repeat(250)));
  const laterBytes = bytesOf(later);
  appendLines(file, later);
  const stats3 = newStats();
  const third = readSessionTail(file, second.tail, countingReader(stats3));
  assert.equal(third.mode, "append");
  assert.equal(third.entries.length, 7, "sept entrées ajoutées, sept ré-analysées");
  assert.deepEqual(idsOf(third.entries), ["p0", "p1", "p2", "p3", "p4", "p5", "p6"]);
  assert.ok(third.tail, "une lecture en ajout doit rendre un état");
  assert.equal(third.tail.start, first.tail.start, "la fenêtre reste celle de la première peinture");
  assert.equal(third.tail.offset, fs.statSync(file).size, "la reprise se fait à la fin du fichier");
  assert.equal(third.tail.pending, "", "le fichier se termine par une ligne complète");
  assert.ok(
    stats3.bytes <= 6 * 4096 + laterBytes,
    `le troisième appel a lu ${stats3.bytes} octets pour ${laterBytes} octets neufs`,
  );
});

test("tail/AC-8 : la première peinture est bornée à 256 Kio", () => {
  const dir = mktmp("tail-first-");
  const file = bigFile(dir, 3000, 320);
  const size = fs.statSync(file).size;
  assert.ok(size > 1024 * 1024, `il faut plus d'un mégaoctet pour que la borne veuille dire quelque chose : ${size}`);

  const stats = newStats();
  const read = readSessionTail(file, null, countingReader(stats));

  assert.equal(read.mode, "reset");
  assert.equal(read.error, null, `aucune erreur attendue : ${read.error}`);
  assert.ok(
    stats.bytes <= SESSION_VIEW_READ_BYTES,
    `la première peinture a lu ${stats.bytes} octets, au-delà de ${SESSION_VIEW_READ_BYTES}`,
  );
  assert.equal(read.truncated, true, "le début du fichier n'est pas chargé");
  assert.equal(read.more, true, "il reste des octets avant la fenêtre");
  assert.ok(read.tail, "une lecture réussie doit rendre un état");
  assert.ok(read.tail.start > 0, "la fenêtre ne part pas du début du fichier");
  assert.ok(
    read.entries.length <= SESSION_VIEW_MAX_ENTRIES,
    `${read.entries.length} entrées gardées, au-delà de ${SESSION_VIEW_MAX_ENTRIES}`,
  );
  assert.ok(read.entries.length > 0, "la fenêtre doit porter des entrées");
  // La fenêtre est ancrée sur la FIN : la dernière entrée est la dernière écrite.
  assert.equal(idsOf(read.entries).at(-1), bigId(2999), "la fenêtre montre le plus récent");
});

test("une ligne partielle est reportée, puis rendue UNE fois entière", () => {
  const dir = mktmp("tail-partial-");
  const file = sessionFile(dir, [headerLine("s"), messageLine("m0", "a"), messageLine("m1", "b")]);
  const before = fs.statSync(file).size;

  const first = readSessionTail(file, null, countingReader(newStats()));
  assert.equal(first.mode, "reset");
  assert.ok(first.tail);
  assert.equal(first.tail.pending, "", "aucun reste de ligne après la première lecture");

  // Une demi-ligne : elle n'est pas émise, elle est REPORTÉE.
  const half = `{"type":"message","id":"x","timestamp":"${STAMP}",`;
  fs.appendFileSync(file, half);
  const partial = readSessionTail(file, first.tail, countingReader(newStats()));
  assert.equal(partial.mode, "append");
  assert.equal(partial.entries.length, 0, "une ligne incomplète n'est jamais rendue");
  assert.ok(partial.tail, "l'état doit survivre à une ligne partielle");
  assert.equal(partial.tail.pending, half, "le reste de ligne est gardé tel quel");
  assert.ok(partial.tail.pending.length > 0);

  // La fin de la ligne : elle est rendue UNE fois, ENTIÈRE.
  const rest = '"message":{"role":"user","content":[]}}\n';
  fs.appendFileSync(file, rest);
  const completed = readSessionTail(file, partial.tail, countingReader(newStats()));
  assert.equal(completed.mode, "append");
  assert.equal(completed.entries.length, 1, "la ligne complétée est rendue exactement une fois");
  const entry = completed.entries[0];
  assert.equal(entry.type, "message", "l'entrée complétée est bien un message");
  assert.equal(entry.id, "x");
  assert.equal(entry.at, before, "l'entrée commence à l'octet de la ligne reportée");
  assert.equal(entry.timestamp, STAMP, "l'entrée est rendue entière, pas seulement son début");
  assert.deepEqual(
    entry.type === "message" ? entry.message.content : null,
    [],
    "le corps de la ligne complétée est rendu entier",
  );
  assert.ok(completed.tail);
  assert.equal(completed.tail.pending, "", "plus aucun reste de ligne");
  assert.equal(completed.tail.size, before + Buffer.byteLength(half + rest, "utf8"), "l'état suit la taille réelle");

  // Relire sans rien écrire ne la rend PAS une seconde fois.
  const again = readSessionTail(file, completed.tail, countingReader(newStats()));
  assert.equal(again.entries.length, 0, "une entrée déjà rendue n'est jamais rejouée");
});

test("un fichier réécrit ou tronqué repart de zéro", () => {
  const dir = mktmp("tail-rewrite-");
  const lines = [headerLine("s")];
  for (let i = 0; i < 30; i += 1) lines.push(messageLine(`m${i}`, "a".repeat(200)));
  const file = sessionFile(dir, lines);
  const before = fs.statSync(file).size;

  const first = readSessionTail(file, null, countingReader(newStats()));
  assert.equal(first.mode, "reset");
  assert.ok(first.tail);
  assert.equal(lastMessageText(first.entries), "a".repeat(200));

  // (a) Réécriture EN PLACE : même chemin, même taille, contenu différent — `dev`,
  // `ino` et `size` n'y voient rien, seules les sondes d'identité le voient.
  const rewritten = [headerLine("s")];
  for (let i = 0; i < 30; i += 1) rewritten.push(messageLine(`m${i}`, "b".repeat(200)));
  fs.writeFileSync(file, rewritten.map((line) => line + "\n").join(""));
  assert.equal(fs.statSync(file).size, before, "la réécriture doit garder la taille du fichier");

  const again = readSessionTail(file, first.tail, countingReader(newStats()));
  assert.equal(again.mode, "reset", "une réécriture en place impose une reconstruction");
  assert.equal(lastMessageText(again.entries), "b".repeat(200), "la fenêtre reflète le nouveau contenu");
  assert.ok(again.tail);
  assert.equal(again.tail.start, 0, "le fichier tient dans la fenêtre : rien n'est tronqué");

  // (b) Troncature : le fichier rétrécit sous l'offset de reprise.
  fs.truncateSync(file, Math.floor(before / 2));
  const shrunk = readSessionTail(file, again.tail, countingReader(newStats()));
  assert.equal(shrunk.mode, "reset", "une troncature impose une reconstruction");
  assert.ok(shrunk.tail);
  assert.ok(shrunk.tail.size < before, "l'état reflète la taille tronquée");
  assert.equal(shrunk.error, null);
});

test("le début se charge à la demande, par blocs bornés", () => {
  const dir = mktmp("tail-prepend-");
  const file = bigFile(dir, 12000, 320);
  const size = fs.statSync(file).size;
  const messageBytes = Buffer.byteLength(messageLine(bigId(0), "x".repeat(320)) + "\n", "utf8");

  const first = readSessionTail(file, null, countingReader(newStats()));
  assert.ok(first.tail, "une première lecture réussie doit rendre un état");
  assert.ok(first.tail.start > 0, "la fenêtre initiale ne part pas du début");

  let previous: SessionTail = first.tail;
  let oldest: SessionEntryLike[] = [];
  let steps = 0;
  let total = 0;
  for (;;) {
    const stepStats = newStats();
    const read = extendSessionTail(file, previous, countingReader(stepStats));
    steps += 1;
    total += stepStats.bytes;
    assert.equal(read.mode, "prepend", "l'extension précède la fenêtre");
    assert.ok(read.tail, "une extension réussie doit rendre un état");
    assert.ok(
      stepStats.bytes <= SESSION_VIEW_READ_BYTES,
      `un bloc a lu ${stepStats.bytes} octets, au-delà de ${SESSION_VIEW_READ_BYTES}`,
    );
    assert.ok(
      read.tail.size - read.tail.start <= SESSION_VIEW_MAX_BYTES,
      `fenêtre de ${read.tail.size - read.tail.start} octets, au-delà de ${SESSION_VIEW_MAX_BYTES}`,
    );
    if (read.entries.length > 0) {
      oldest = read.entries;
      assert.ok(
        read.entries.every((entry) => entry.at < previous.start),
        "les entrées chargées sont PLUS ANCIENNES que la fenêtre",
      );
      assert.ok(read.tail.start < previous.start, "le début de la fenêtre a RECULÉ");
      // Contiguïté : le bloc s'arrête EXACTEMENT où commence la fenêtre déjà chargée.
      const last = read.entries[read.entries.length - 1];
      if (last.type === "message") {
        assert.equal(last.at + messageBytes, previous.start, "le bloc butte sans trou sur la fenêtre");
      }
    }
    if (read.tail.start === previous.start) break;
    previous = read.tail;
    assert.ok(steps < 200, "l'extension doit progresser vers le début");
  }

  assert.equal(previous.start, 0, "le début du fichier finit par être atteint");
  assert.ok(steps >= 4, `le fichier doit se charger en plusieurs blocs (${steps} pas)`);
  assert.ok(total <= size + SESSION_VIEW_READ_BYTES, `chargement total de ${total} octets pour un fichier de ${size}`);
  // Le bloc le plus ancien porte le tout premier octet du fichier : rien n'est perdu.
  assert.ok(oldest.length > 0, "le début du fichier doit avoir été chargé en au moins un bloc");
  assert.equal(oldest[0].at, 0, "le bloc le plus ancien commence au premier octet");
  assert.equal(oldest[0].id, "s", "l'en-tête de session est chargé au début");

  // Au-delà du début, il n'y a plus rien : la fonction le dit sans relire.
  const stats4 = newStats();
  const beyond = extendSessionTail(file, previous, countingReader(stats4));
  assert.equal(beyond.mode, "prepend");
  assert.deepEqual(beyond.entries, []);
  assert.equal(beyond.more, false, "plus aucun octet avant la fenêtre");
  assert.equal(beyond.truncated, false);
  assert.equal(beyond.error, null);
  assert.equal(stats4.bytes, 0, "rien à charger : aucun octet n'est lu");

  // (b) Au-delà de la fenêtre maximale, le début n'est PLUS chargé : la borne tient.
  const huge = bigFile(dir, 20000, 320);
  const hugeSize = fs.statSync(huge).size;
  assert.ok(hugeSize > SESSION_VIEW_MAX_BYTES, `fichier de ${hugeSize} octets, sous la borne maximale`);
  let current = readSessionTail(huge, null, countingReader(newStats())).tail;
  assert.ok(current, "la première lecture du gros fichier doit réussir");
  let hugeSteps = 0;
  for (;;) {
    const read = extendSessionTail(huge, current, countingReader(newStats()));
    assert.ok(read.tail, "une extension réussie doit rendre un état");
    assert.ok(
      read.tail.size - read.tail.start <= SESSION_VIEW_MAX_BYTES,
      `fenêtre de ${read.tail.size - read.tail.start} octets, au-delà de ${SESSION_VIEW_MAX_BYTES}`,
    );
    hugeSteps += 1;
    if (read.tail.start === current.start) break;
    current = read.tail;
    assert.ok(hugeSteps < 200, "l'extension doit progresser vers le début");
  }
  assert.ok(current.start > 0, "le début du fichier reste hors de la fenêtre : il est au-delà de la borne");
  assert.ok(
    hugeSize - current.start <= SESSION_VIEW_MAX_BYTES,
    `fenêtre de ${hugeSize - current.start} octets pour une borne de ${SESSION_VIEW_MAX_BYTES}`,
  );
});

test("un fichier absent ou illisible ne jette pas", () => {
  const dir = mktmp("tail-missing-");
  const missing = path.join(dir, "absent.jsonl");

  const absent = readSessionTail(missing, null, countingReader(newStats()));
  assert.deepEqual(absent.entries, []);
  assert.equal(absent.tail, null);
  assert.equal(absent.error, missing, "l'erreur porte le chemin, pas une exception");

  // Un RÉPERTOIRE à la place du fichier : même refus, jamais une exception.
  const asDir = path.join(dir, "dossier.jsonl");
  fs.mkdirSync(asDir);
  const notAFile = readSessionTail(asDir, null, countingReader(newStats()));
  assert.deepEqual(notAFile.entries, []);
  assert.equal(notAFile.tail, null);
  assert.equal(notAFile.error, asDir);

  // Illisible : le fichier existe, mais la lecture ne rend rien.
  const file = sessionFile(dir, [headerLine("s"), messageLine("m0", "a")]);
  const blind = readSessionTail(file, null, () => null);
  assert.deepEqual(blind.entries, []);
  assert.equal(blind.tail, null);
  assert.equal(blind.error, file);

  // Le pendant « étendre » : le fichier disparaît sous la fenêtre déjà chargée.
  const big = bigFile(dir, 3000, 320);
  const loaded = readSessionTail(big, null, countingReader(newStats())).tail;
  assert.ok(loaded, "la première lecture du gros fichier doit réussir");
  assert.ok(loaded.start > 0, "la fenêtre doit avoir un début hors du fichier chargé");
  const gone = extendSessionTail(missing, loaded, countingReader(newStats()));
  assert.equal(gone.mode, "prepend");
  assert.deepEqual(gone.entries, []);
  assert.equal(gone.error, missing);
  assert.equal(gone.tail, loaded, "l'état précédent est rendu intact");
});

test("un simple défilement ne relit pas le fichier", () => {
  const dir = mktmp("tail-scroll-");
  // Une session de plus d'un mégaoctet dont la première peinture n'a chargé que la fin :
  // relire quoi que ce soit de son contenu serait une ré-analyse pure, visible au compteur.
  const file = bigFile(dir, 3000, 320);
  const size = fs.statSync(file).size;
  assert.ok(size > 1024 * 1024, `fichier trop petit pour que la mesure veuille dire quelque chose : ${size}`);

  const first = readSessionTail(file, null, countingReader(newStats()));
  assert.ok(first.tail, "une première lecture réussie doit rendre un état");
  assert.ok(first.tail.start > 0, "la fenêtre initiale ne part pas du début");
  assert.ok(first.entries.length > 0);

  // Fichier inchangé : ni entrée neuve, ni ré-analyse. Le seul coût est celui des
  // sondes d'identité (au plus 6 blocs de 4 Kio), jamais celui du contenu.
  const stats = newStats();
  const again = readSessionTail(file, first.tail, countingReader(stats));
  assert.equal(again.mode, "append");
  assert.deepEqual(again.entries, [], "rien de neuf : aucune entrée n'est rejouée");
  assert.equal(again.error, null);
  assert.ok(again.tail);
  assert.equal(again.tail.start, first.tail.start, "la fenêtre reste celle déjà chargée");
  assert.equal(again.tail.offset, size);
  assert.ok(stats.bytes <= 6 * 4096, `un défilement a lu ${stats.bytes} octets : au-delà des sondes d'identité`);
  assert.ok(stats.bytes * 10 < size, `un défilement a lu ${stats.bytes} octets sur un fichier de ${size}`);

  // Le même fichier, sondé une seconde fois : même conclusion, même coût borné.
  const stats2 = newStats();
  const third = readSessionTail(file, again.tail, countingReader(stats2));
  assert.deepEqual(third.entries, []);
  assert.ok(stats2.bytes <= 6 * 4096, `seconde relecture à vide : ${stats2.bytes} octets`);
});
