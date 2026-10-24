// La sortie des jobs de tests EN DIRECT : chaque morceau que la commande écrit part en
// événement éphémère `test_output` (regroupé, au plus une fois par
// TEST_OUTPUT_THROTTLE_MS), et la fin de chaque job reste en mémoire — les
// TEST_JOBS_KEEP derniers jobs de chaque run, TEST_OUTPUT_KEEP caractères chacun —
// pour l'app qui ouvre la sortie en cours de route (`GET /v1/runs/{id}/tests/live`).
// Rien n'est écrit sur disque : le résultat d'un job, lui, est dans `test_runs` et le
// cache. Les secrets reconnus sont masqués comme dans le direct des sessions.
import type { HeavyOutcome, TestScope } from "./heavy.ts";
import { redact } from "./session-feed.ts";

export const TEST_OUTPUT_KEEP = 16_000;
export const TEST_JOBS_KEEP = 4;
export const TEST_OUTPUT_THROTTLE_MS = 300;
/** Les runs dont les jobs sont gardés (les plus récents). */
export const TEST_RUNS_KEEP = 32;

export type TestJobView = {
  id: number;
  scope: TestScope;
  attempt: number;
  startedAt: number;
  endedAt: number | null;
  outcome: HeavyOutcome | null;
  /** La fin de la sortie (stdout et stderr mêlés, dans l'ordre d'arrivée). */
  output: string;
};

type Job = TestJobView & { runId: string; pending: string; sentAt: number; timer: NodeJS.Timeout | null };

/** Le récepteur de la sortie des jobs, tel que le runner heavy le voit. */
export type TestOutputSink = {
  start(runId: string, scope: TestScope, attempt: number): number;
  append(jobId: number, chunk: string): void;
  finish(jobId: number, outcome: HeavyOutcome): void;
};

export class TestFeeds implements TestOutputSink {
  readonly #publish: (runId: string, payload: Record<string, unknown>) => void;
  readonly #now: () => number;
  readonly #jobs = new Map<number, Job>();
  readonly #byRun = new Map<string, number[]>();
  #seq = 0;

  constructor(options: { publish: (runId: string, payload: Record<string, unknown>) => void; now?: () => number }) {
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
  }

  start(runId: string, scope: TestScope, attempt: number): number {
    const id = ++this.#seq;
    const at = this.#now();
    this.#jobs.set(id, {
      id,
      runId,
      scope,
      attempt,
      startedAt: at,
      endedAt: null,
      outcome: null,
      output: "",
      pending: "",
      sentAt: at,
      timer: null,
    });
    // Le run passe en dernier (le plus récent) ; ses jobs au-delà de TEST_JOBS_KEEP partent.
    const list = [...(this.#byRun.get(runId) ?? []), id];
    this.#byRun.delete(runId);
    while (list.length > TEST_JOBS_KEEP) this.#drop(list.shift() as number);
    this.#byRun.set(runId, list);
    while (this.#byRun.size > TEST_RUNS_KEEP) {
      const oldest = this.#byRun.keys().next().value;
      if (oldest === undefined) break;
      for (const job of this.#byRun.get(oldest) ?? []) this.#drop(job);
      this.#byRun.delete(oldest);
    }
    this.#publish(runId, { jobId: id, scope, attempt, chunk: "", done: false, outcome: null });
    return id;
  }

  append(jobId: number, chunk: string): void {
    const job = this.#jobs.get(jobId);
    if (!job || job.endedAt !== null || chunk === "") return;
    const clean = redact(chunk);
    job.output = (job.output + clean).slice(-TEST_OUTPUT_KEEP);
    job.pending = (job.pending + clean).slice(-TEST_OUTPUT_KEEP);
    if (this.#now() - job.sentAt >= TEST_OUTPUT_THROTTLE_MS) this.#flush(job);
    else if (job.timer === null) {
      job.timer = setTimeout(() => {
        job.timer = null;
        this.#flush(job);
      }, TEST_OUTPUT_THROTTLE_MS);
      job.timer.unref?.();
    }
  }

  finish(jobId: number, outcome: HeavyOutcome): void {
    const job = this.#jobs.get(jobId);
    if (!job || job.endedAt !== null) return;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.endedAt = this.#now();
    job.outcome = outcome;
    this.#publish(job.runId, {
      jobId,
      scope: job.scope,
      attempt: job.attempt,
      chunk: job.pending,
      done: true,
      outcome,
    });
    job.pending = "";
  }

  /** Les derniers jobs d'un run, du plus ancien au plus récent. */
  jobs(runId: string): TestJobView[] {
    return (this.#byRun.get(runId) ?? []).flatMap((id) => {
      const job = this.#jobs.get(id);
      if (!job) return [];
      const { id: jobId, scope, attempt, startedAt, endedAt, outcome, output } = job;
      return [{ id: jobId, scope, attempt, startedAt, endedAt, outcome, output }];
    });
  }

  #flush(job: Job): void {
    if (job.pending === "" || job.endedAt !== null) return;
    job.sentAt = this.#now();
    const chunk = job.pending;
    job.pending = "";
    this.#publish(job.runId, {
      jobId: job.id,
      scope: job.scope,
      attempt: job.attempt,
      chunk,
      done: false,
      outcome: null,
    });
  }

  #drop(id: number): void {
    const job = this.#jobs.get(id);
    if (job?.timer) clearTimeout(job.timer);
    this.#jobs.delete(id);
  }
}
