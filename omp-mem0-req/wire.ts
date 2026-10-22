// Ce que le harness envoie sur le fil, validé à la frontière : la vue d'un run
// (`GET /v1/runs/{id}`) telle que `harness_run` et les gestes la lisent. Un champ
// absent ou mal typé prend sa valeur vide ; seuls `run.id` et `run.rev` sont exigés.
//
// Ce module porte aussi la seule garde d'objet du plugin : importe-la, ne la recopie pas.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function strOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function strList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function records(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export type RunSummary = {
  id: string;
  rev: number;
  title: string;
  state: string;
  step: string | null;
  reason: string | null;
  branch: string;
  modules: string[];
  fixes: number;
  attempts: number;
  prUrl: string | null;
  lastFailCause: string | null;
  notBefore: number | null;
};

export type DecisionSummary = {
  seq: number;
  question: string;
  chosen: string;
  status: string;
  category: string;
  options: string[];
};

export type EscalationSummary = {
  id: number;
  status: string;
  category: string;
  question: string;
  options: string[];
  recommended: string | null;
  context: string;
  answer: string | null;
};

export type CriterionSummary = { id: string; test: string; status: string };

export type VerdictSummary = {
  risk: string;
  summary: string;
  confidence: string;
  blockers: string[];
  risks: string[];
  unverified: string[];
  criteria: CriterionSummary[];
};

export type RunView = {
  run: RunSummary;
  decisions: DecisionSummary[];
  escalations: EscalationSummary[];
  verdict: VerdictSummary | null;
  artifacts: { name: string; content: string }[];
};

function parseVerdict(raw: unknown): VerdictSummary | null {
  if (!isRecord(raw)) return null;
  return {
    risk: str(raw, "risk"),
    summary: str(raw, "summary"),
    confidence: str(raw, "confidence"),
    blockers: strList(raw, "blockers"),
    risks: strList(raw, "risks"),
    unverified: strList(raw, "unverified"),
    criteria: records(raw, "criteria").map((item) => ({
      id: str(item, "id"),
      test: str(item, "test"),
      status: str(item, "status"),
    })),
  };
}

/** La vue d'un run reçue du serveur ; `null` si elle ne porte pas un run identifié et versionné. */
export function parseRunView(raw: unknown): RunView | null {
  if (!isRecord(raw) || !isRecord(raw.run)) return null;
  const run = raw.run;
  if (typeof run.id !== "string" || typeof run.rev !== "number") return null;
  return {
    run: {
      id: run.id,
      rev: run.rev,
      title: str(run, "title"),
      state: str(run, "state"),
      step: strOrNull(run, "step"),
      reason: strOrNull(run, "reason"),
      branch: str(run, "branch"),
      modules: strList(run, "modules"),
      fixes: typeof run.fixes === "number" ? run.fixes : 0,
      attempts: typeof run.attempts === "number" ? run.attempts : 0,
      prUrl: strOrNull(run, "prUrl"),
      lastFailCause: strOrNull(run, "lastFailCause"),
      notBefore: typeof run.notBefore === "number" ? run.notBefore : null,
    },
    decisions: records(raw, "decisions").map((item) => ({
      seq: typeof item.seq === "number" ? item.seq : 0,
      question: str(item, "question"),
      chosen: str(item, "chosen"),
      status: str(item, "status"),
      category: str(item, "category"),
      options: strList(item, "options"),
    })),
    escalations: records(raw, "escalations").map((item) => ({
      id: typeof item.id === "number" ? item.id : 0,
      status: str(item, "status"),
      category: str(item, "category"),
      question: str(item, "question"),
      options: strList(item, "options"),
      recommended: strOrNull(item, "recommended"),
      context: str(item, "context"),
      answer: strOrNull(item, "answer"),
    })),
    verdict: parseVerdict(run.verdict),
    artifacts: records(raw, "artifacts").map((item) => ({ name: str(item, "name"), content: str(item, "content") })),
  };
}
