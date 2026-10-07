// Les décisions PURES d'une escalade de projet côté iOS (BR-5) : le miroir exact
// de `ProjectConsoleModel.canAnswerDialog` / `dialogAppeared` / `answer*` de la
// coque macOS. Aucun état, aucune vue : c'est ce que les tests éprouvent sans
// rendre de SwiftUI.
//
// Les mots de `kind` vivent dans `ProjectText.swift` (fichier de vocabulaire) :
// la garde `design-ios/AC-5` refuserait ici des littéraux alphabétiques.

import ConsoleClient
import Foundation

enum IOSDialogGating {
    /// « Répondre » est-il actif pour cette escalade ? (parité macOS)
    static func canAnswer(dialog: RpcDialogRequest, text: String, selectedIndex: Int?) -> Bool {
        switch dialog.method {
        case .select:
            guard let selectedIndex else { return false }
            return dialog.options.indices.contains(selectedIndex)
        case .confirm, .editor:
            return true
        case .input:
            return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Le texte initial de l'éditeur : le `prefill` d'un `editor`, rien sinon
    /// (parité `dialogAppeared`).
    static func initialText(dialog: RpcDialogRequest) -> String {
        dialog.method == .editor ? (dialog.prefill ?? "") : ""
    }

    /// Le corps envoyé pour « Répondre » selon la forme, ou `nil` quand le geste
    /// n'est pas licite (forme `confirm`, choix absent, saisie blanche).
    static func request(
        dialog: RpcDialogRequest,
        selectedIndex: Int?,
        text: String
    ) -> RemoteDialogAnswerRequest? {
        switch dialog.method {
        case .select:
            guard let selectedIndex, dialog.options.indices.contains(selectedIndex) else { return nil }
            return RemoteDialogAnswerRequest(
                kind: ProjectDialogKind.value,
                value: dialog.options[selectedIndex],
                confirmed: nil
            )
        case .input:
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return RemoteDialogAnswerRequest(kind: ProjectDialogKind.value, value: text, confirmed: nil)
        case .editor:
            // Une valeur vide est ACCEPTÉE : c'est la coque qui juge le plan (S-4).
            return RemoteDialogAnswerRequest(kind: ProjectDialogKind.value, value: text, confirmed: nil)
        case .confirm:
            return nil
        }
    }

    /// Le corps d'une confirmation (« Confirmer » / « Refuser »).
    static func confirmation(_ confirmed: Bool) -> RemoteDialogAnswerRequest {
        RemoteDialogAnswerRequest(kind: ProjectDialogKind.confirmed, value: nil, confirmed: confirmed)
    }

    /// Le corps d'une annulation.
    static func cancellation() -> RemoteDialogAnswerRequest {
        RemoteDialogAnswerRequest(kind: ProjectDialogKind.cancelled, value: nil, confirmed: nil)
    }
}
