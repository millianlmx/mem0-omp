// Le mode de la feuille Connexion (S-3 de connexion-ios-feuille-intrusive-et-sans) :
// une résolution PURE, testable hors SwiftUI, de ce que la feuille montre — et de
// la règle d'ouverture automatique (S-2).
//
// Le mode se lit dans le statut d'APPAIRAGE (`ClientPairingStatus`), jamais dans
// le seul état de connexion : un Mac injoignable ne fait pas d'un appareil appairé
// un appareil à appairer.

import ConsoleClient
import Foundation

enum ConnectionSheetMode: Equatable {
    /// Le trousseau n'est pas encore lu : rien d'autre que l'attente.
    case restoring
    /// Aucun jeton (ou jeton refusé par le Mac) : découverte, adresse, code.
    /// `prefill` est l'adresse à placer dans un champ d'adresse vide.
    case unpaired(refused: Bool, prefill: String?)
    /// Appairé et connecté : l'état, l'adresse une fois, « Oublier ce Mac ».
    case connected(address: String)
    /// Appairé mais pas connecté : l'état, l'adresse si connue, « Réessayer »,
    /// l'adresse modifiable dans un groupe replié, « Oublier ce Mac ».
    case disconnected(address: String?)

    static func resolve(
        pairing: ClientPairingStatus,
        state: ClientState,
        effectiveEndpoint: ClientEndpoint?,
        manualAddress: ClientAddress?
    ) -> ConnectionSheetMode {
        switch pairing {
        case .restoring:
            return .restoring
        case .unpaired:
            return .unpaired(refused: false, prefill: nil)
        case .refused(let endpoint):
            return .unpaired(refused: true, prefill: manualAddress?.text ?? endpoint?.address)
        case .paired:
            if case .connected(let endpoint) = state {
                return .connected(address: endpoint.display)
            }
            return .disconnected(address: (state.endpoint ?? effectiveEndpoint)?.display)
        }
    }

    /// La feuille s'ouvre-t-elle d'elle-même pour ce statut (S-2) ? Seulement sans
    /// jeton ou quand le Mac l'a refusé — jamais pendant la lecture du trousseau,
    /// jamais pour un appareil appairé, quel que soit l'état de la connexion.
    static func autoPresents(_ pairing: ClientPairingStatus) -> Bool {
        switch pairing {
        case .unpaired, .refused:
            return true
        case .restoring, .paired:
            return false
        }
    }

    /// « Utiliser cette adresse » n'est actif qu'avec un caractère non blanc (S-6).
    static func canSaveAddress(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Seul le mode non appairé focalise le champ du code à l'apparition ; les
    /// autres modes ne touchent jamais au focus : aucun clavier (S-3, B-3).
    var initialFocusOnCode: Bool {
        if case .unpaired = self { return true }
        return false
    }
}
