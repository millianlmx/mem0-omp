// Une tâche de navigation : un contexte de Moli ouvert pour `fn` et supprimé dans TOUS les cas
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
    // `close` ne lève jamais : l'erreur d'origine n'est pas masquée.
    await session.close();
  }
}
