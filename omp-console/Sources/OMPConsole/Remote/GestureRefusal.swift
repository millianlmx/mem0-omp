// Les gestes typés de `RemoteActions` (feature validations-de-geste-enfermees-dans-le-h) :
// leurs entrées et la cause typée de leurs refus. Du code Swift du Mac appelle
// un geste sans corps HTTP ; le routeur décode le corps, convertit vers ces types
// et traduit un refus par `GestureRefusal.apiError`, SEULE table vers l'API distante.

import ConsoleCore

/// La file de dialogues visée par un refus : la conduite de projet ou la
/// session OMP hébergée. Elle ne change que le message rendu.
enum DialogQueue: Equatable, Sendable {
    case conduite, hosted
}

/// La réponse à la question en vol d'une carte.
enum CardAnswer: Equatable, Sendable {
    case selected(label: String)
    case custom(text: String)
}

/// La réponse à un dialogue (conduite ou session hébergée).
enum DialogAnswer: Equatable, Sendable {
    case value(String)
    case confirmed(Bool)
    case cancelled
}

/// Pourquoi un geste typé a été refusé : un cas par règle. Sauf les cas d'échec
/// d'un geste TENTÉ (`journalFailure`, `nothingRecorded`, `relaunchRefused`,
/// `commandRefused`, `serviceFailure`, `serviceBadRequest/NotFound/Conflict`,
/// `conduiteNotLive`, `mergeRefused`, `mergeFailed`, `pullRequestChanged`), un
/// refus garantit qu'aucun geste de modèle n'a été appelé.
enum GestureRefusal: Error, Equatable, Sendable {
    // cartes
    case unknownCard, cardWithoutGesture, noQuestionInFlight, missingQuestionId, staleQuestion, labelNotInOptions,
         emptyText, notAwaitingReply, noLiveRun, milestoneNotAwaited, cardWithoutRepository, cardWithoutLot
    /// L'arbitre tient l'élément (`ArbiterState.isArbitrating`) : ni réponse,
    /// ni jalon, ni relance de l'utilisateur tant qu'il décide.
    case arbiterHandles
    /// Motif relu en tête du journal par `checkJournal`.
    case journalFailure(String)
    /// Anomalie interne de reprise ou de relance (le geste n'a rien consigné) :
    /// jamais produite par une règle.
    case nothingRecorded
    /// Refus du service à une relance ; motif absent possible.
    case relaunchRefused(String?)
    /// Refus du service, relu dans l'accusé d'une commande déjà postée
    /// (`RemoteActions.settlement(of:)`) ; motif absent possible.
    case commandRefused(String?)
    /// Message utilisateur d'une panne du service.
    case serviceFailure(String)
    // lancer une feature
    case emptyTitle, emptyDescription, invalidRepoRoot
    // dialogues (conduite et session hébergée)
    case noPendingDialog
    case staleDialog(DialogQueue), dialogLabelNotInOptions(DialogQueue),
         valueNotExpected(DialogQueue), confirmationNotExpected(DialogQueue)
    // conduite, projets
    case unknownRepository, emptyName, noConductedProject, unknownProject
    case conduiteRefused(String), conduiteNotLive(String)
    // session hébergée
    case sessionNotRunning, sessionBusy, sessionNotRelaunchable
    case noHostedSession, hostedSessionStopped, hostedDialogPending
    // audits
    case unknownAudit
    case serviceBadRequest(String), serviceNotFound(String), serviceConflict(String)
    // PR
    case malformedHeadOid, unknownPullRequest, invalidPullRequestURL, pullRequestChanged
    case ghMissing(String), mergeRefused(String), mergeFailed(String)

    /// La SEULE traduction d'un refus vers l'API distante : codes et messages
    /// de l'enveloppe `{"error":{"code","message"}}` existante.
    var apiError: ConsoleAPIError {
        switch self {
        case .unknownCard: return .notFound("carte inconnue")
        case .cardWithoutGesture: return .conflict("carte sans geste")
        case .noQuestionInFlight: return .conflict("aucune question en vol")
        case .missingQuestionId: return .badRequest("identifiant de question manquant")
        case .staleQuestion: return .conflict("la question a changé depuis la demande")
        case .labelNotInOptions: return .badRequest("libellé hors des options de la question")
        case .emptyText: return .badRequest("texte vide")
        case .notAwaitingReply: return .conflict("cette carte n'attend pas de réponse")
        case .noLiveRun: return .conflict("aucun run vivant sur cette carte")
        case .milestoneNotAwaited: return .conflict("ce jalon n'est pas attendu")
        case .cardWithoutRepository: return .conflict("carte sans dépôt")
        case .cardWithoutLot: return .conflict("carte sans lot")
        case .arbiterHandles: return .conflict("arbitrage en cours — la décision sera consignée au journal")
        case .journalFailure(let reason): return .conflict(reason)
        case .nothingRecorded: return .server("le geste de reprise n'a rien consigné")
        case .relaunchRefused(let reason): return .conflict(reason ?? "relance refusée")
        case .commandRefused(let reason): return .conflict(reason ?? "geste refusé")
        case .serviceFailure(let message): return .unavailable(message)
        case .emptyTitle: return .badRequest("titre vide")
        case .emptyDescription: return .badRequest("description vide")
        case .invalidRepoRoot: return .badRequest("racine de dépôt git invalide")
        case .noPendingDialog: return .conflict("aucun dialogue en attente")
        case .staleDialog(.conduite): return .conflict("l'escalade a changé depuis la demande")
        case .staleDialog(.hosted): return .conflict("le dialogue a changé depuis la demande")
        case .dialogLabelNotInOptions(.conduite): return .badRequest("libellé hors des options de l'escalade")
        case .dialogLabelNotInOptions(.hosted): return .badRequest("libellé hors des options du dialogue")
        case .valueNotExpected(.conduite): return .badRequest("cette escalade n'attend pas de valeur")
        case .valueNotExpected(.hosted): return .badRequest("ce dialogue n'attend pas de valeur")
        case .confirmationNotExpected(.conduite): return .badRequest("cette escalade n'attend pas de confirmation")
        case .confirmationNotExpected(.hosted): return .badRequest("ce dialogue n'attend pas de confirmation")
        case .unknownRepository: return .notFound("dépôt inconnu")
        case .emptyName: return .badRequest("nom vide")
        case .noConductedProject: return .conflict("aucun projet conduit")
        case .unknownProject: return .notFound("projet inconnu")
        case .conduiteRefused(let message), .conduiteNotLive(let message): return .conflict(message)
        case .sessionNotRunning: return .conflict("la session n'est pas en marche")
        case .sessionBusy: return .conflict(SessionConsoleText.launchBusy)
        case .sessionNotRelaunchable: return .conflict(SessionConsoleText.relaunchNotDead)
        case .noHostedSession: return .conflict("aucune session OMP n'est lancée")
        case .hostedSessionStopped: return .conflict("la session OMP est arrêtée")
        case .hostedDialogPending: return .conflict("un dialogue de la session attend une réponse")
        case .unknownAudit: return .notFound("audit inconnu")
        case .serviceBadRequest(let message): return .badRequest(message)
        case .serviceNotFound(let message): return .notFound(message)
        case .serviceConflict(let message): return .conflict(message)
        case .malformedHeadOid: return .badRequest("headOid mal formé")
        case .unknownPullRequest: return .notFound("PR inconnue")
        case .invalidPullRequestURL: return .notFound("adresse de PR invalide")
        case .pullRequestChanged: return .conflict("la PR a changé depuis la demande ; relisez-la")
        case .ghMissing(let message): return .unavailable(message)
        case .mergeRefused(let message): return .conflict(message)
        case .mergeFailed(let message): return .server(message)
        }
    }
}
