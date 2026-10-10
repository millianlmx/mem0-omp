// Le statut d'appairage publié par le client : la SEULE source de la décision
// d'ouvrir d'elle-même la feuille Connexion (`.unpaired` ou `.refused`).
//
// Il est indépendant de `ClientState` : une panne de transport, l'absence de
// réseau ou un verrou de version ne le changent jamais, et un appareil appairé
// dont le Mac est injoignable reste `.paired`. Le refus n'est pas persisté : un
// relancement après un refus publie `.restoring` puis `.unpaired`.

import Foundation

public enum ClientPairingStatus: Equatable, Sendable {
    /// Le trousseau n'a pas encore été lu.
    case restoring
    /// Aucun jeton.
    case unpaired
    /// Le Mac a refusé le jeton (401) ; le jeton est effacé. `endpoint` est celui
    /// vers lequel la requête ou le flux refusé était parti, s'il est connu.
    case refused(endpoint: ClientEndpoint?)
    /// Un jeton est détenu.
    case paired
}
