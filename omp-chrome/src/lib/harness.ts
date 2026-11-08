// Les appels de l'extension au harness (`/v1/workstation*`), authentifiés par le jeton
// du code d'appairage. Une réponse non 2xx lève `HarnessError`, qui porte le statut et
// le message d'erreur français du serveur (`{ error }`) ; un serveur injoignable a le
// statut 0.
//
// Chaque appel présente ce navigateur (`X-OMP-Browser`, `X-OMP-Browser-Label`) quand la
// cible le porte : le serveur distingue les profils Chrome appairés (« Perso », « ADEO »…)
// et ne livre à chacun que les actions qui le ciblent.

/** L'identité de ce navigateur : un identifiant stable et le libellé réglé dans les options. */
export type BrowserIdentity = { id: string; label: string };

export type HarnessTarget = { url: string; token: string; browser?: BrowserIdentity };

export class HarnessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type HarnessOptions = {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
};

/** Rend le corps JSON décodé (`null` pour un 204). */
export async function harnessCall<T>(
  target: HarnessTarget,
  method: "GET" | "POST" | "PUT",
  route: string,
  body?: unknown,
  options: HarnessOptions = {},
): Promise<T | null> {
  const fetcher = options.fetcher ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${target.token}`, ...options.headers };
  if (target.browser) {
    headers["X-OMP-Browser"] = target.browser.id;
    if (target.browser.label.trim() !== "")
      headers["X-OMP-Browser-Label"] = encodeURIComponent(target.browser.label.trim());
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetcher(`${target.url}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new HarnessError(
      `harness injoignable (${target.url}) : ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === "" ? null : JSON.parse(text);
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `réponse ${response.status}`;
    throw new HarnessError(message, response.status);
  }
  return payload as T;
}
