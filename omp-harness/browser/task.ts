// Une tâche de navigation : un contexte Obscura ouvert pour `fn` et fermé dans TOUS les cas
// (succès, erreur de `fn`, délai CDP, abandon). L'erreur d'origine est rendue telle quelle.
import { abortError } from "./cdp.ts";
import { BrowserSession } from "./session.ts";
import type { SessionTarget } from "./session.ts";

export async function runBrowserTask<T>(
  target: SessionTarget,
  fn: (session: BrowserSession) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  if (options.signal?.aborted) throw abortError();
  const session = await BrowserSession.open(target, options);
  try {
    return await fn(session);
  } finally {
    try {
      session.close();
    } catch {
      // Une erreur de fermeture ne masque pas l'erreur d'origine.
    }
  }
}
