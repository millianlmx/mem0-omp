// Les doublures de la QA de /review : le faux moteur de conteneurs (fake-docker.ts) et ce qu'il laisse
// lire au test (appels journalisés, navigateurs lancés).
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les tests l'importent.
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-docker.ts");

export type DockerCall = { argv: string[]; tokenEnv: string | null };

export type QaRun = { name: string; argv: string[]; network: string | null; image: string };

export type FakeDocker = {
  /** `container.command` de la configuration : le faux CLI, son dossier d'état en premier argument. */
  command: string[];
  /** Pilote les pannes et le réseau modélisé (voir fake-docker.ts). */
  control: (patch: Record<string, unknown>) => void;
  /** Tous les appels, dans l'ordre. */
  calls: () => DockerCall[];
  /** Les appels qui nomment une unité de la QA (`omp-qa-…`). */
  qaCalls: () => DockerCall[];
  /** Les `docker run` de la QA : nom, réseau, image, arguments. */
  qaRuns: () => QaRun[];
  /**
   * Les navigateurs de QA que le faux moteur a lancés et que personne n'a retirés : nom, pid de la vraie porte CDP
   * (chef du groupe de Moli) et son port d'écoute (le 9222 du conteneur).
   */
  browsers: () => { name: string; pid: number; port: number }[];
  /** Les navigateurs de QA lancés, retirés ou non, dans l'ordre. */
  started: () => { name: string; pid: number }[];
};

/** Le process `pid` vit encore (un zombie, tué mais pas encore recueilli par son parent, est mort). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

const dirs = new Set<string>();

function stateOf(dir: string): { name: string; pid?: number; port?: number }[] {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== "control.json")
    .map((file) => ({
      name: file.slice(0, -5),
      ...(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { pid?: number; port?: number }),
    }));
}

/** Les navigateurs que le faux moteur a laissés (un test qui échoue n'a pas nettoyé) sont tués à la fin, Moli compris. */
test.after(() => {
  for (const dir of dirs) {
    for (const { pid } of stateOf(dir))
      if (pid !== undefined && isAlive(pid))
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Déjà parti.
        }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Un faux moteur de conteneurs ; `moliBin` : le vrai binaire que lance le navigateur de QA. */
export function fakeDocker(moliBin: string | null): FakeDocker {
  // Hors de `tmpdir()` : son nettoyage passe avant `test.after`, qui a besoin des pid pour tuer ce qui reste.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fake-docker-"));
  dirs.add(dir);
  const controlFile = path.join(dir, "control.json");
  const write = (patch: Record<string, unknown>): void => {
    const current = fs.existsSync(controlFile)
      ? (JSON.parse(fs.readFileSync(controlFile, "utf8")) as Record<string, unknown>)
      : {};
    fs.writeFileSync(controlFile, JSON.stringify({ ...current, ...patch }));
  };
  write(moliBin === null ? {} : { moliBin });
  const lines = (): Record<string, unknown>[] => {
    const file = path.join(dir, "log.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  const calls = (): DockerCall[] => lines().filter((line): line is DockerCall => Array.isArray(line.argv));
  return {
    command: [process.execPath, "--experimental-strip-types", "--no-warnings", SCRIPT, dir],
    control: write,
    calls,
    qaCalls: () => calls().filter((call) => call.argv.some((arg) => arg.includes("omp-qa-"))),
    qaRuns: () =>
      calls()
        .filter((call) => call.argv[0] === "run" && call.argv.includes("--label=omp-harness=qa"))
        .map(({ argv }) => ({
          name: argv.find((arg) => arg.startsWith("--name="))?.slice(7) ?? "",
          argv,
          network: argv.find((arg) => arg.startsWith("--network="))?.slice(10) ?? null,
          image: argv.find((arg) => /^(omp-harness-moli:local|docker\.io\/)/.test(arg)) ?? "",
        })),
    browsers: () =>
      stateOf(dir)
        .filter((entry): entry is { name: string; pid: number; port: number } => entry.pid !== undefined)
        .map(({ name, pid, port }) => ({ name, pid, port })),
    started: () =>
      lines()
        .map((line) => line.started as { name: string; pid: number } | undefined)
        .filter((entry): entry is { name: string; pid: number } => entry !== undefined),
  };
}
