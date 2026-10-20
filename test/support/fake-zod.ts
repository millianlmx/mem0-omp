// La façade `pi.zod` des `pi` factices du plugin mémoire.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent. Il n'importe pas le plugin : les tests qui posent HOME ou
// MEM0_AUTOSETUP avant l'import dynamique de l'extension peuvent le charger
// statiquement.

export type FakeSchema = { [method: string]: (...args: unknown[]) => FakeSchema };

/**
 * Façade minimale de `pi.zod` : l'extension DÉCLARE ses schémas à l'enregistrement
 * des tools, elle ne les exécute jamais. Chaque méthode renvoie le même
 * descripteur chaînable (`.describe/.optional/.default/.int/.min/.max`).
 */
export function fakeSchema(): FakeSchema {
  const builder = new Proxy({} as FakeSchema, {
    get:
      () =>
      (..._args: unknown[]) =>
        builder,
  });
  return builder;
}
