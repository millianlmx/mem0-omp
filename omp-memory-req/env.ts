// Lecture d'une variable d'environnement renommée : le nouveau nom l'emporte, l'ancien sert de repli pendant la
// version de transition (retiré à la version suivante). « Posée » = définie et non vide.
// Trois copies identiques (omp-memory/env.ts, omp-memory-req/env.ts, omp-harness/config/env.ts) : chaque image copie
// son dossier et le code partagé reste sous un dossier copié.
export function renamedEnv(
  env: Record<string, string | undefined>,
  name: string,
  legacy: string,
): string | undefined {
  const value = env[name];
  if (value !== undefined && value !== "") return value;
  const old = env[legacy];
  if (old !== undefined && old !== "") return old;
  return undefined;
}
