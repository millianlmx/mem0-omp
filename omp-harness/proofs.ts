// Les preuves d'un run : captures, logs, rapports de tests, jointes à la revue.
//
// Elles vivent hors du dépôt, sous `<dataDir>/proofs/<runId>/` : un fichier `<n>.<ext>` par
// preuve et un `index.json` écrit atomiquement (aucune table, aucune migration). Le store est
// synchrone de bout en bout (`fs.*Sync`) : deux `add` d'un même process ne s'entrelacent jamais.
// Aucun chemin n'est composé d'autre chose que `dataDir`, `proofs`, un `runId` gardé et un nom
// recalculé depuis l'index : jamais depuis une entrée d'un client ou d'un agent.
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessError } from "./errors.ts";
import type { StepKind } from "./machine.ts";

export type ProofKind = "screenshot" | "video" | "log" | "test_report";
export type ProofSide = "before" | "after";

export type Proof = {
  /** Le rang, à partir de 1 : il désigne le contenu (`/proofs/{n}`) et n'est jamais réutilisé. */
  n: number;
  kind: ProofKind;
  title: string;
  step: StepKind;
  mime: string;
  size: number;
  /** En ms epoch. */
  createdAt: number;
  /** Le critère d'acceptation (`AC-n`) que la preuve illustre. */
  acRef: string | null;
  /** Le côté d'une comparaison : la base (`before`) ou le worktree du run (`after`). */
  side: ProofSide | null;
};

/** Le nombre de preuves d'un run : au-delà, la nouvelle preuve est refusée (rien n'est évincé). */
export const MAX_PROOFS = 50;
/** La taille d'une preuve, en octets (8 Mio). */
export const MAX_PROOF_BYTES = 8 * 1024 * 1024;
/** La taille cumulée des preuves d'un run, en octets (64 Mio). */
export const MAX_RUN_PROOF_BYTES = 64 * 1024 * 1024;
/** La taille d'un log texte, en octets (64 Kio). */
export const MAX_PROOF_LOG_BYTES = 64 * 1024;
/** La longueur d'un titre, en caractères. */
export const MAX_PROOF_TITLE = 200;

/** La liste fermée des types MIME permis par type de preuve, avec l'extension du fichier. */
export const PROOF_MIMES: Record<ProofKind, Record<string, string>> = {
  screenshot: { "image/png": "png", "image/jpeg": "jpg" },
  video: { "video/webm": "webm", "video/mp4": "mp4" },
  log: { "text/plain; charset=utf-8": "txt" },
  test_report: { "application/json": "json" },
};

const STEPS: readonly string[] = ["req", "specs", "impl", "review", "fix"];
const RUN_ID = /^[A-Za-z0-9][\w.-]*$/;
const AC_REF = /^AC-\d+$/;

/** Les preuves du tour courant : celles créées depuis le début de la dernière étape impl ou fix. */
export function currentRound(
  proofs: readonly Proof[],
  steps: readonly { kind: StepKind; startedAt: number }[],
): Proof[] {
  const last = steps.findLast((step) => step.kind === "impl" || step.kind === "fix");
  const kept = last === undefined ? proofs : proofs.filter((proof) => proof.createdAt >= last.startedAt);
  return [...kept].sort((a, b) => a.n - b.n);
}

/** Le nombre de preuves, en une locution de notification. */
export function proofCountText(n: number): string {
  return n === 0 ? "aucune preuve" : n === 1 ? "1 preuve" : `${n} preuves`;
}

export type ProofInput = {
  kind: ProofKind;
  title: string;
  step: StepKind;
  mime: string;
  data: Buffer;
  acRef?: string | null;
  side?: ProofSide | null;
};

const isProofShape = (value: unknown, n: number): value is Proof => {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const mimes = typeof p.kind === "string" ? PROOF_MIMES[p.kind as ProofKind] : undefined;
  return (
    p.n === n &&
    mimes !== undefined &&
    typeof p.mime === "string" &&
    Object.hasOwn(mimes, p.mime) &&
    typeof p.title === "string" &&
    typeof p.step === "string" &&
    STEPS.includes(p.step) &&
    typeof p.size === "number" &&
    Number.isInteger(p.size) &&
    p.size >= 0 &&
    typeof p.createdAt === "number" &&
    (p.acRef === null || (typeof p.acRef === "string" && AC_REF.test(p.acRef))) &&
    (p.side === null || p.side === "before" || p.side === "after")
  );
};

export class ProofStore {
  readonly #root: string;

  constructor(dataDir: string) {
    this.#root = path.join(dataDir, "proofs");
  }

  #dir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new HarnessError(404, `run inconnu : ${runId}`);
    return path.join(this.#root, runId);
  }

  /** L'index d'un run : `[]` sans index, `null` s'il est illisible (JSON invalide, forme inattendue). */
  #index(runId: string): Proof[] | null {
    const indexFile = path.join(this.#dir(runId), "index.json");
    let text: string;
    try {
      text = fs.readFileSync(indexFile, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      console.error(`preuves ${runId} : index illisible : ${(err as Error).message}`);
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const list = (parsed as { version?: unknown; proofs?: unknown } | null)?.proofs;
      if (
        (parsed as { version?: unknown } | null)?.version === 1 &&
        Array.isArray(list) &&
        list.every((entry, i) => isProofShape(entry, i + 1))
      )
        return list as Proof[];
    } catch {
      /* JSON invalide : traité plus bas */
    }
    console.error(`preuves ${runId} : index illisible : forme inattendue`);
    return null;
  }

  list(runId: string): Proof[] {
    return this.#index(runId) ?? [];
  }

  count(runId: string): number {
    return this.list(runId).length;
  }

  read(runId: string, n: number): { proof: Proof; data: Buffer } {
    const proof = this.list(runId)[n - 1];
    if (!Number.isInteger(n) || proof === undefined) throw new HarnessError(404, `preuve inconnue : ${n}`);
    const file = path.join(this.#dir(runId), `${proof.n}.${PROOF_MIMES[proof.kind][proof.mime]}`);
    let fd: number;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new HarnessError(404, `preuve inconnue : ${n}`);
      // O_NOFOLLOW : un lien symbolique à la place du fichier est une altération, pas une preuve.
      if (code === "ELOOP") throw new HarnessError(500, `preuve altérée : ${n}`);
      throw err;
    }
    try {
      if (fs.fstatSync(fd).size !== proof.size) throw new HarnessError(500, `preuve altérée : ${n}`);
      const data = fs.readFileSync(fd);
      if (data.length !== proof.size) throw new HarnessError(500, `preuve altérée : ${n}`);
      return { proof, data };
    } finally {
      fs.closeSync(fd);
    }
  }

  add(runId: string, input: ProofInput): { ok: true; proof: Proof } | { ok: false; reason: string } {
    const dir = this.#dir(runId);
    const mimes = (PROOF_MIMES as Record<string, Record<string, string> | undefined>)[input.kind];
    if (mimes === undefined) return refuse(`type de preuve inconnu : ${input.kind}`);
    if (!Object.hasOwn(mimes, input.mime)) return refuse(`mime « ${input.mime} » non permis pour ${input.kind}`);
    const title = input.title.trim();
    if (title === "") return refuse("titre vide");
    if (title.length > MAX_PROOF_TITLE) return refuse(`titre au-delà de ${MAX_PROOF_TITLE} caractères`);
    const acRef = input.acRef ?? null;
    if (acRef !== null && !AC_REF.test(acRef)) return refuse("acRef attendu au format AC-n");
    const side = input.side ?? null;
    if (side !== null && side !== "before" && side !== "after") return refuse("side attendu : before ou after");
    const bytes = input.data.length;
    if (input.kind === "log" && bytes > MAX_PROOF_LOG_BYTES)
      return refuse(`log de ${bytes} octets au-delà de la borne de ${MAX_PROOF_LOG_BYTES} octets`);
    if (bytes > MAX_PROOF_BYTES)
      return refuse(`preuve de ${bytes} octets au-delà de la borne de ${MAX_PROOF_BYTES} octets`);
    // L'index illisible se détecte AVANT les bornes : sinon il se lirait « zéro preuve » et serait écrasé.
    const proofs = this.#index(runId);
    if (proofs === null) return refuse("index des preuves illisible");
    if (proofs.length >= MAX_PROOFS) return refuse(`borne atteinte : ${MAX_PROOFS} preuves par run`);
    if (proofs.reduce((sum, proof) => sum + proof.size, 0) + bytes > MAX_RUN_PROOF_BYTES)
      return refuse(`le run dépasserait ${MAX_RUN_PROOF_BYTES} octets de preuves`);

    const proof: Proof = {
      n: proofs.length + 1,
      kind: input.kind,
      title,
      step: input.step,
      mime: input.mime,
      size: bytes,
      createdAt: Date.now(),
      acRef,
      side,
    };
    const file = path.join(dir, `${proof.n}.${mimes[input.mime]}`);
    const dataTmp = `${file}.${process.pid}.tmp`;
    const indexFile = path.join(dir, "index.json");
    const indexTmp = `${indexFile}.${process.pid}.tmp`;
    let renamed = false;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(dataTmp, input.data, { mode: 0o600 });
      fs.renameSync(dataTmp, file);
      renamed = true;
      fs.writeFileSync(indexTmp, JSON.stringify({ version: 1, proofs: [...proofs, proof] }), { mode: 0o600 });
      fs.renameSync(indexTmp, indexFile);
    } catch (err) {
      for (const leftover of [dataTmp, indexTmp, ...(renamed ? [file] : [])]) fs.rmSync(leftover, { force: true });
      return refuse(`écriture impossible : ${(err as Error).message}`);
    }
    return { ok: true, proof };
  }
}

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
