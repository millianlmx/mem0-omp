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
 */
export function spawnAsync(command: string, args: string[], options: SpawnOptions): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const child = spawn(command, args, options);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => resolve({ status: null, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (status) => resolve({ status, stdout, stderr }));
  child.stdin.end();
  return promise;
}
