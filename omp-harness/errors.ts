// Les erreurs du harness que l'API rend telles quelles : un statut HTTP et un
// message lisible. Module feuille : tout le monde l'importe, il n'importe rien.


export class HarnessError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
