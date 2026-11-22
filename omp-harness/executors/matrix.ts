// La matrice d'un dépôt qui déclare ses cibles (`.harness-env.json`) : chaque passage (une
// cible, une configuration) part sur un exécuteur qui en porte les exigences, en parallèle ;
// leurs issues se fondent en UN résultat heavy (le verdict, le cache et la revue le lisent
// comme avant). Le résultat garde le détail par passage et les tests réellement exécutés.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HarnessConfig, RepoConfig } from "../config/config.ts";
import type { Store } from "../db/db.ts";
import type { Git } from "../forge/git.ts";
import type { Exec } from "../runners/proc.ts";
import { engine } from "../runners/runner.ts";
import { classify, clientEnv, heavyEnv, OUTPUT_TAIL } from "../heavy/heavy.ts";
import type { HeavyOutcome } from "../heavy/heavy.ts";
import type { EnvSpec, EnvTarget, Leg } from "./env-spec.ts";
import { legName } from "./env-spec.ts";
import type { ExecutorPool, ExecutorRun } from "./executors.ts";
import { failedProc, requirementText } from "./executors.ts";
import { junitExecuted, tapExecuted } from "./reports.ts";

/** Le détail d'un passage, rendu avec le résultat agrégé. */
export type LegSummary = {
  name: string;
  executor: string | null;
  outcome: HeavyOutcome;
  exitCode: number | null;
  attempts: number;
  required: boolean;
  /** Le nombre de tests exécutés relevés (rapports JUnit, sortie TAP). */
  executed: number;
};

export type MatrixOutcome = {
  outcome: HeavyOutcome;
  exitCode: number | null;
  output: string;
  attempts: number;
  legs: LegSummary[];
  /** Les noms des tests réellement exécutés, tous passages confondus. */
  executed: string[];
};

export type MatrixDeps = {
  config: HarnessConfig;
  store: Store;
  git: Git;
  exec: Exec;
  pool: ExecutorPool;
};

/** Le passage d'un job heavy : qui il sert, sur quel arbre, avec quelle priorité. */
export type MatrixJob = {
  runId: string;
  repo: RepoConfig;
  worktree: string;
  base: string;
  priority?: number;
  retry?: boolean;
};

/** L'issue la plus grave d'abord : un rouge l'emporte sur un échec structuré, qui l'emporte sur un vert. */
const SEVERITY: HeavyOutcome[] = ["fail", "oom", "timeout", "error", "aborted", "pass"];

/** Les noms TAP au fil du flux complet (la sortie gardée n'en est que la fin). */
class TapNames {
  readonly #decoder = new StringDecoder("utf8");
  #line = "";
  readonly names: string[] = [];

  push(chunk: Buffer): void {
    const lines = (this.#line + this.#decoder.write(chunk)).split("\n");
    this.#line = (lines.pop() ?? "").slice(-64 * 1024);
    for (const line of lines) if (this.names.length < 50_000) this.names.push(...tapExecuted(line));
  }

  end(): string[] {
    if (this.#line !== "") this.names.push(...tapExecuted(this.#line));
    this.#line = "";
    return this.names;
  }
}

/** Le script d'un passage : setup de la cible, puis la commande ; le premier échec arrête tout. */
export function legScript(target: EnvTarget, command: string): string {
  return ["set -e", ...target.setup, command].join("\n");
}

export class Matrix {
  readonly #deps: MatrixDeps;
  /** Les images construites (Dockerfile d'une cible), par tag : une construction à la fois par tag. */
  readonly #images = new Map<string, Promise<{ tag: string } | { error: string }>>();
  /** Les tests exécutés d'un résultat mis en cache (clé de cache) : la preuve survit au cache, pas au redémarrage. */
  readonly #executed = new Map<string, string[]>();
  #seq = 0;

  constructor(deps: MatrixDeps) {
    this.#deps = deps;
  }

  executedFor(key: string): string[] | undefined {
    return this.#executed.get(key);
  }

  remember(key: string, executed: string[]): void {
    this.#executed.set(key, executed);
    // Une mémoire bornée : les clés les plus anciennes partent.
    if (this.#executed.size > 500) this.#executed.delete(this.#executed.keys().next().value as string);
  }

  /** L'image Linux d'une cible pour le heavy local en conteneur : déclarée, construite de son Dockerfile, ou `null`. */
  async image(job: MatrixJob, target: EnvTarget): Promise<{ tag: string | null } | { error: string }> {
    if (this.#deps.config.heavy.isolation !== "container") return { tag: null };
    if (target.image !== null) return { tag: target.image };
    if (target.dockerfile === null) return { tag: null };
    const { git, exec, config } = this.#deps;
    const shown = await git.raw(job.worktree, ["show", `${job.base}:${target.dockerfile}`]);
    if (shown.code !== 0) return { error: `${target.dockerfile} introuvable au commit de base` };
    const hash = createHash("sha256").update(shown.stdout).digest("hex").slice(0, 16);
    const tag = `omp-env-${job.repo.name.toLowerCase()}-${target.name}:${hash}`;
    let built = this.#images.get(tag);
    if (!built) {
      built = (async () => {
        const inspect = engine(config, ["image", "inspect", tag]);
        const known = await exec(inspect.command, inspect.args, { env: clientEnv(), timeoutMs: 30_000 });
        if (known.code === 0) return { tag };
        // Le contexte est l'archive du commit de base : jamais le worktree que l'agent écrit.
        const build = engine(config, ["build", "-t", tag, "-f", target.dockerfile as string, "-"]);
        const result = await exec(
          "bash",
          [
            "-c",
            'set -o pipefail; git -C "$1" archive "$2" | "${@:3}"',
            "build",
            job.worktree,
            job.base,
            build.command,
            ...build.args,
          ],
          { env: clientEnv(), timeoutMs: 3_600_000, maxBytes: OUTPUT_TAIL },
        );
        return result.code === 0
          ? { tag }
          : {
              error: `construction de l'image ${tag} impossible :\n${`${result.stdout}\n${result.stderr}`.trim().slice(-4000)}`,
            };
      })();
      this.#images.set(tag, built);
      // Un échec se retente au passage suivant (le Dockerfile ou le réseau a pu être réparé).
      void built.then((outcome) => {
        if ("error" in outcome) this.#images.delete(tag);
      });
    }
    return built;
  }

  /** Les passages, en parallèle, fondus en un résultat. Un passage d'une cible non requise n'en décide pas l'issue. */
  async run(
    job: MatrixJob,
    legs: Leg[],
    signal: AbortSignal,
    onOutput?: (chunk: string) => void,
  ): Promise<MatrixOutcome> {
    const results = await Promise.all(legs.map((leg) => this.#leg(job, leg, signal, onOutput)));
    const deciding = results.filter((result) => result.summary.required);
    const outcome =
      SEVERITY.find((severity) =>
        (deciding.length > 0 ? deciding : results).some((r) => r.summary.outcome === severity),
      ) ?? "pass";
    const share = Math.floor(OUTPUT_TAIL / Math.max(1, results.length));
    const output = results
      .map((r) => {
        const head = `=== ${r.summary.name} — ${r.summary.executor ?? "aucun exécuteur"} : ${r.summary.outcome}${r.summary.required ? "" : " (cible non requise)"} ===`;
        return `${head}\n${r.output.slice(-share)}`;
      })
      .join("\n\n");
    const first = results.find((r) => r.summary.required && r.summary.outcome === outcome) ?? results[0];
    return {
      outcome,
      exitCode: first?.summary.exitCode ?? null,
      output,
      attempts: Math.max(0, ...results.map((r) => r.summary.attempts)),
      legs: results.map((r) => r.summary),
      executed: [...new Set(results.flatMap((r) => r.executed))],
    };
  }

  /** Un passage : un exécuteur qui en porte les exigences, une relance d'un rouge frais, les relances d'OOM. */
  async #leg(
    job: MatrixJob,
    leg: Leg,
    signal: AbortSignal,
    onOutput?: (chunk: string) => void,
  ): Promise<{ summary: LegSummary; output: string; executed: string[] }> {
    const { config, store, pool } = this.#deps;
    const name = legName(leg);
    const base = { name, required: leg.target.required, executed: 0 };
    const image = await this.image(job, leg.target);
    if ("error" in image)
      return {
        summary: { ...base, executor: null, outcome: "error", exitCode: null, attempts: 0 },
        output: image.error,
        executed: [],
      };
    let attempts = 0;
    let oomRetries = 0;
    let failRetried = false;
    for (;;) {
      if (signal.aborted) throw new Error("job heavy annulé : appel arrêté");
      const lease = await pool.acquire(leg.target.requires, `${job.runId}:${name}`, signal, job.priority ?? 0);
      if (lease === null) {
        const missing = `aucun exécuteur ne porte ${requirementText(leg.target.requires)} : la cible « ${leg.target.name} » ne peut tourner nulle part — déclare-en un dans \`executors\` de la configuration du harness`;
        store.appendEvent("heavy_unplaced", job.runId, { leg: name, requires: leg.target.requires });
        return {
          summary: { ...base, executor: null, outcome: "error", exitCode: null, attempts },
          output: missing,
          executed: [],
        };
      }
      attempts++;
      const executor = lease.executor.config.name;
      const unit = `omp-heavy-${job.runId}-${leg.target.name}-${++this.#seq}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const tap = new TapNames();
      store.appendEvent("heavy_started", job.runId, { leg: name, executor, attempt: attempts, unit });
      let run: ExecutorRun;
      try {
        run = await lease.executor.run({
          unit,
          repo: job.repo,
          worktree: job.worktree,
          script: legScript(leg.target, leg.command),
          env: heavyEnv(config, job.worktree),
          image: image.tag,
          reports: leg.target.reports,
          patch: false,
          timeoutMs: config.heavy.timeoutSec * 1000,
          signal,
          onStdout: (chunk) => tap.push(chunk),
          ...(onOutput ? { onOutput } : {}),
        });
      } catch (err) {
        run = { proc: failedProc(err instanceof Error ? err.message : String(err)), reports: [], patch: null };
      } finally {
        lease.release();
      }
      const outcome = classify(run.proc);
      store.appendEvent("heavy_done", job.runId, {
        leg: name,
        executor,
        attempt: attempts,
        outcome,
        exitCode: run.proc.code,
      });
      const output = `${run.proc.stdout}${run.proc.stderr ? `\n${run.proc.stderr}` : ""}`.slice(-OUTPUT_TAIL);
      if (outcome === "fail" && !failRetried && job.retry !== false) {
        failRetried = true;
        store.appendEvent("heavy_fail_retry", job.runId, { leg: name, attempt: attempts, exitCode: run.proc.code });
        continue;
      }
      if (outcome === "oom" && oomRetries < config.heavy.oomRetries) {
        oomRetries++;
        continue;
      }
      if (outcome === "pass" && failRetried)
        store.appendEvent("heavy_flaky", job.runId, { leg: name, repo: job.repo.name });
      const executed = [...tap.end(), ...run.reports.flatMap((report) => junitExecuted(report.content))];
      return {
        summary: { ...base, executor, outcome, exitCode: run.proc.code, attempts, executed: executed.length },
        output,
        executed,
      };
    }
  }

  /**
   * `run_on` : la commande nommée d'une cible, sur un exécuteur qui la porte ; ses modifications reviennent au
   * worktree (en place pour le heavy local, en patch appliqué pour un exécuteur distant).
   */
  async runOn(
    job: MatrixJob,
    spec: EnvSpec,
    targetName: string,
    commandName: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; text: string; files: string[] }> {
    const { config, git, pool, exec } = this.#deps;
    const target = spec.targets.find((candidate) => candidate.name === targetName);
    if (!target)
      return {
        ok: false,
        text: `cible inconnue : « ${targetName} » (connues : ${spec.targets.map((t) => t.name).join(", ")})`,
        files: [],
      };
    const command = target.commands[commandName];
    if (command === undefined) {
      const known = Object.keys(target.commands);
      return {
        ok: false,
        text: `commande inconnue sur « ${target.name} » : « ${commandName} » (${known.length > 0 ? `connues : ${known.join(", ")}` : "la cible n'en déclare aucune (`commands`)"})`,
        files: [],
      };
    }
    const image = await this.image(job, target);
    if ("error" in image) return { ok: false, text: image.error, files: [] };
    const lease = await pool.acquire(target.requires, `${job.runId}:run_on`, signal, job.priority ?? 0);
    if (lease === null)
      return {
        ok: false,
        text: `aucun exécuteur ne porte ${requirementText(target.requires)} : « ${target.name} » ne peut tourner nulle part`,
        files: [],
      };
    const before = new Set(await git.touchedFiles(job.worktree, "HEAD").catch(() => []));
    let run: ExecutorRun;
    try {
      run = await lease.executor.run({
        unit: `omp-run-on-${job.runId}-${++this.#seq}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        repo: job.repo,
        worktree: job.worktree,
        script: legScript(target, command),
        env: heavyEnv(config, job.worktree),
        image: image.tag,
        reports: [],
        patch: true,
        timeoutMs: config.heavy.timeoutSec * 1000,
        signal,
      });
    } finally {
      lease.release();
    }
    const outcome = classify(run.proc);
    const output = `${run.proc.stdout}${run.proc.stderr ? `\n${run.proc.stderr}` : ""}`.slice(-4000);
    const where = `${target.name} (${lease.executor.config.name})`;
    if (run.patch !== null && run.patch.trim() !== "") {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-run-on-")), "changes.patch");
      fs.writeFileSync(file, run.patch);
      try {
        const applied = await exec("git", ["apply", "--binary", "--whitespace=nowarn", file], {
          cwd: job.worktree,
          timeoutMs: 60_000,
        });
        if (applied.code !== 0)
          return {
            ok: false,
            text: `« ${commandName} » a tourné sur ${where}, mais ses modifications ne s'appliquent pas au worktree :\n${applied.stderr.trim().slice(-2000)}`,
            files: [],
          };
      } finally {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      }
    }
    const after = await git.touchedFiles(job.worktree, "HEAD").catch(() => []);
    const files = after.filter((file) => !before.has(file));
    const changed = files.length > 0 ? `fichiers modifiés : ${files.join(", ")}` : "aucun fichier modifié";
    return {
      ok: outcome === "pass",
      text: `${outcome === "pass" ? "OK" : `ÉCHEC (${outcome}, code ${run.proc.code})`} — « ${commandName} » sur ${where} ; ${changed}\n${output}`,
      files,
    };
  }
}
