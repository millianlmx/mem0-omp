// Un processus enfant lancé sans bloquer la boucle d'événements : les harnais
// qui relancent check.sh dans plusieurs copies jetables les font tourner
// ENSEMBLE au lieu de les additionner.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent.
import { spawn } from "node:child_process";

/** Un processus enfant terminé : code de sortie (null = tué, délai dépassé ou
 * commande introuvable) et sorties complètes, comme sous `spawnSync`. */
export type Run = { status: number | null; stdout: string; stderr: string };

export type SpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; timeout: number };

/**
 * `spawnSync(command, args, { encoding: "utf8", … })` en asynchrone : entrée
 * standard fermée d'emblée, et une commande introuvable rend un statut null
 * (message d'erreur ajouté à stderr) au lieu de lever — une promesse jamais
 * attendue ne fait donc pas tomber le fichier de test.
 *
 * Le délai est tenu ICI, par un minuteur `unref` annulé à la fin du processus,
 * et jamais par l'option `timeout` de `spawn` : mesuré sur node 26 et 22, cette
 * option arme un minuteur qu'elle n'annule que sur `exit`, et une commande
 * introuvable n'émet jamais `exit` — le fichier de test restait vivant jusqu'à
 * l'échéance (300 s par copie pour `bun` absent dans smoke.test.ts, soit les
 * 910 s de la section Tests de release-simulation du 2026-10-22).
 */
export function spawnAsync(command: string, args: string[], options: SpawnOptions): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const { timeout, ...rest } = options;
  const child = spawn(command, args, rest);
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
  timer.unref();
  const settle = (run: Run): void => {
    clearTimeout(timer);
    resolve(run);
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => settle({ status: null, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (status) => settle({ status, stdout, stderr }));
  child.stdin.end();
  return promise;
}
