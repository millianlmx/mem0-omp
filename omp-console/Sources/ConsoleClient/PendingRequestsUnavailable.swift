// L'échec typé de la liste des attentes côté iPhone (attentes-dispersees-entre-
// sources, S-8) : la source qui n'a pu être lue et l'erreur du client qu'elle a
// levée. Jamais de liste partielle.

import Foundation

/// Une source de la liste des attentes, telle que l'iPhone la lit sur le Mac.
public enum PendingRequestsSource: String, CaseIterable, Sendable, Equatable {
    /// `GET /v1/store` : l'ardoise ET les escalades d'audit (`StoreSnapshot.audits`).
    case store
    /// `GET /v1/conduite` : les dialogues de la conduite de projet.
    case conduite
    /// `GET /v1/session` : les dialogues de la session hébergée.
    case session
}

/// La liste des attentes est indisponible : `source` n'a pu être lue, pour la
/// raison `cause`.
public struct PendingRequestsUnavailable: Error, Equatable, Sendable {
    public let source: PendingRequestsSource
    public let cause: ClientError

    public init(source: PendingRequestsSource, cause: ClientError) {
        self.source = source
        self.cause = cause
    }
}
