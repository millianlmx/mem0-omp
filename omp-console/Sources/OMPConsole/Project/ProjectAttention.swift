// Le signal d'attention (S-9, S-10, BR-4) : une décision PURE et deux adaptateurs
// — la demande système et la présence de la fenêtre.
//
// La règle vit dans `AttentionDecision.action(for:)`, une fonction totale : elle
// se prouve sans `NSApp`, et le modèle ne fait qu'appliquer le verdict. C'est ce
// qui rend tenable l'invariant « UNE seule demande active à la fois ».

import AppKit
import ConsoleCore
import Foundation

/// Deux intensités : `critical` pour une attente de l'utilisateur, `informational`
/// pour la fin du projet.
enum AttentionKind: Equatable, Sendable {
    case informational
    case critical
}

/// L'émetteur d'une demande d'attention. `@MainActor` : `NSApp` l'est, et les
/// appelants (le modèle de conduite) le sont aussi.
@MainActor
protocol AttentionRequesting: AnyObject {
    /// Rend un identifiant à conserver pour l'annulation.
    @discardableResult func request(_ kind: AttentionKind) -> Int
    /// Idempotent, ne lève jamais.
    func cancel(_ id: Int)
}

/// L'implémentation réelle, branchée sur `NSApplication`.
@MainActor
final class SystemAttention: AttentionRequesting {
    @discardableResult
    func request(_ kind: AttentionKind) -> Int {
        let type: NSApplication.RequestUserAttentionType = kind == .critical ? .criticalRequest : .informationalRequest
        return NSApp.requestUserAttention(type)
    }

    func cancel(_ id: Int) {
        NSApp.cancelUserAttentionRequest(id)
    }
}

/// Les quatre entrées de la décision.
struct AttentionInput: Equatable {
    /// `state == .live` ET un dialogue répondable en attente (définition figée de
    /// S-9).
    var awaitingUser: Bool
    /// `project.status == .done`.
    var projectDone: Bool
    /// `NSApp.isActive && fenêtre « Projet » isKeyWindow`.
    var windowFrontmost: Bool
    /// Une demande est déjà active (identifiant conservé).
    var activeRequest: Bool
}

/// Le verdict de la décision.
enum AttentionAction: Equatable {
    case none
    case request(AttentionKind)
    case cancel
}

/// La table de décision de S-9. PURE : aucune lecture d'`NSApp`, aucune horloge.
///
/// L'ordre des règles est celui du contrat, la règle « informative » passant AVANT
/// la règle « annuler » — sans quoi un projet terminé hors premier plan
/// n'émettrait jamais son signal, puisque `!awaitingUser` est vrai dans les deux
/// cas.
enum AttentionDecision {
    static func action(for input: AttentionInput) -> AttentionAction {
        // 1) attente hors premier plan, rien d'actif ⇒ demande critique.
        if input.awaitingUser {
            if input.windowFrontmost { return input.activeRequest ? .cancel : .none }
            if input.activeRequest { return .none }
            return .request(.critical)
        }
        // 2) projet terminé hors premier plan, rien d'actif ⇒ demande informative.
        if input.projectDone, !input.windowFrontmost, !input.activeRequest {
            return .request(.informational)
        }
        // 3) plus d'attente, ou fenêtre au premier plan ⇒ annulation.
        if input.windowFrontmost || input.activeRequest {
            return input.activeRequest ? .cancel : .none
        }
        // 4) rien à faire.
        return .none
    }
}
