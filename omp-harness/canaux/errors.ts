// Les erreurs typées du client des canaux (Gmail, Agenda, Slack). Leurs messages sont
// construits à partir de codes : jamais d'un corps de réponse, d'un jeton ou d'un contenu.

/** Les états d'un canal que le client refuse de lire (`ChannelUnavailable`). */
export type UnavailableState = "disconnected" | "reconnect" | "blocked" | "error";

/** Un appel hors de la liste blanche des points d'API, ou d'un autre canal : refusé sans appel réseau. */
export class ChannelRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelRefused";
  }
}

/** Le canal n'est pas lisible (non connecté, à reconnecter, bloqué par l'administrateur) : aucun appel réseau. */
export class ChannelUnavailable extends Error {
  readonly state: UnavailableState;
  constructor(state: UnavailableState) {
    super(`canal indisponible : ${state}`);
    this.name = "ChannelUnavailable";
    this.state = state;
  }
}

/** Limite de débit du fournisseur : à retenter après `retryAfterMs`, l'état du canal ne change pas. */
export class ChannelRateLimited extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`limite de débit : réessayer dans ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = "ChannelRateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Le fournisseur a refusé l'appel : `status` (0 pour Slack) et `code` (statut HTTP ou code d'erreur Slack). */
export class ChannelApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`erreur du fournisseur : ${code}`);
    this.name = "ChannelApiError";
    this.status = status;
    this.code = code;
  }
}

/** Coupure : réseau, délai, réponse illisible ou 5xx. L'état du canal ne change pas. */
export class ChannelNetworkError extends Error {
  readonly code: "network" | "timeout" | "invalid_json" | "server";
  constructor(code: ChannelNetworkError["code"]) {
    super(`coupure : ${code}`);
    this.name = "ChannelNetworkError";
    this.code = code;
  }
}
