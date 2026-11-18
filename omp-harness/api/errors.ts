// Les erreurs du harness que l'API rend telles quelles : un statut HTTP et un
// message lisible. Module feuille : tout le monde l'importe, il n'importe rien.

export class HarnessError extends Error {
  readonly status: number;
  /** Des en-têtes de la réponse d'erreur (`Retry-After` d'un 429). */
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}
