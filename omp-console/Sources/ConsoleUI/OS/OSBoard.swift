// Le « Tableau » de l'OS agentique : les fils en colonnes par phase. Ici, la logique PURE, sans
// vue ni réseau : le rangement en colonnes (avec la borne de 7 jours des fils terminés), le
// contenu et le libellé VoiceOver d'une carte, l'état montré (serveur relié, première lecture
// aboutie, dernier échec) et la largeur d'une colonne selon la taille de texte. La vue
// (`OSBoardView`) ne fait que les dessiner.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Une colonne du tableau : les fils d'une phase.
public struct OSBoardColumn: Identifiable, Equatable, Sendable {
    public let phase: OSPhase
    public let threads: [OSThread]

    public var id: Int { phase.rawValue }
}

/// Ce que le tableau montre.
public enum OSBoardState: Equatable {
    /// Aucun serveur relié.
    case unconfigured
    /// La première lecture des fils n'a pas abouti.
    case loading
    /// La lecture a échoué et aucun fil n'est connu.
    case failed(HarnessFailure)
    /// Lu, et aucun fil dans la portée retenue.
    case empty
    /// Des colonnes (un échec éventuel est montré en bandeau).
    case columns
}

public enum OSBoard {
    // MARK: - Colonnes

    /// Les jours pendant lesquels un fil terminé reste au tableau.
    private static let recentDays = 7

    /// Les fils rangés par phase, dans l'ordre à vous, au travail, en file, livré, en échec, arrêté.
    /// Les phases vivantes montrent tous leurs fils ; les phases terminées, ceux mis à jour depuis
    /// minuit d'aujourd'hui moins 7 jours (borne incluse, comme « Cette semaine » de la liste).
    /// Une colonne sans fil n'est pas rendue ; dans une colonne, le plus récent d'abord.
    public static func columns(_ threads: [OSThread], now: Date = Date(), calendar: Calendar = .current) -> [OSBoardColumn] {
        let oldest = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000 - Double(recentDays) * 86_400_000
        var byPhase: [OSPhase: [OSThread]] = [:]
        for thread in threads where thread.phase.isLive || thread.updatedAt >= oldest {
            byPhase[thread.phase, default: []].append(thread)
        }
        return byPhase.keys.sorted().map { phase in
            let ordered = (byPhase[phase] ?? []).sorted {
                $0.updatedAt != $1.updatedAt ? $0.updatedAt > $1.updatedAt : $0.id < $1.id
            }
            return OSBoardColumn(phase: phase, threads: ordered)
        }
    }

    // MARK: - Cartes

    /// Le lieu d'un fil : le Poste, sinon son dépôt, sinon la machine de sa session locale, sinon le VPS.
    public static func place(of thread: OSThread) -> String {
        if !thread.requests.isEmpty { return OSText.poste }
        if let repo = thread.repo, !repo.isEmpty { return repo }
        if let host = thread.localSession?.host { return host }
        return OSText.vps
    }

    /// Ce qui attend l'humain sur ce fil, ou `nil` s'il n'attend rien.
    public static func waiting(of thread: OSThread) -> Int? {
        thread.pending > 0 ? thread.pending : nil
    }

    /// Ce que VoiceOver lit d'une carte : « Corrige le bandeau, web, 2 choses vous attendent, colonne à vous ».
    public static func cardLabel(_ thread: OSThread) -> String {
        [
            thread.title,
            place(of: thread),
            waiting(of: thread).map(OSText.boardWaiting),
            OSText.boardColumn(thread.phase.label),
        ]
        .compactMap { $0 }
        .joined(separator: ", ")
    }

    /// Ce que VoiceOver lit d'un titre de colonne : « à vous, 3 fils ».
    public static func columnLabel(_ column: OSBoardColumn) -> String {
        column.phase.label + ", " + OSText.threadCount(column.threads.count)
    }

    // MARK: - État

    /// L'état montré, dans cet ordre : serveur non relié, première lecture en vol (même avec des
    /// colonnes ou un échec : jamais « aucun fil » avant la lecture), colonnes, échec, vide.
    public static func state(
        isConfigured: Bool, loaded: Bool, failure: HarnessFailure?, columns: [OSBoardColumn]
    ) -> OSBoardState {
        guard isConfigured else { return .unconfigured }
        guard loaded else { return .loading }
        if !columns.isEmpty { return .columns }
        if let failure { return .failed(failure) }
        return .empty
    }

    // MARK: - Largeur

    /// La marge du rang de colonnes.
    public static let margin: CGFloat = 16
    /// L'écart entre deux colonnes.
    public static let spacing: CGFloat = 12
    /// La part visible minimale de la colonne suivante : on voit qu'on peut défiler.
    public static let minimumPeek: CGFloat = 40

    /// La largeur lisible d'une colonne : strictement croissante avec la taille de texte.
    public static func textWidth(_ size: DynamicTypeSize) -> CGFloat {
        switch size {
        case .xSmall: 228
        case .small: 236
        case .medium: 248
        case .large: 260
        case .xLarge: 276
        case .xxLarge: 292
        case .xxxLarge: 308
        case .accessibility1: 332
        case .accessibility2: 356
        case .accessibility3: 380
        case .accessibility4: 404
        case .accessibility5: 428
        @unknown default: 428
        }
    }

    /// La largeur d'une colonne dans `available` points : la largeur lisible tant que la colonne
    /// suivante montre au moins `minimumPeek` ; sinon une colonne entière de moins, élargies, pour
    /// que la suivante en montre une demi (jamais sous la largeur lisible) ; sinon, écran plus
    /// étroit que la largeur lisible, une colonne et `minimumPeek` d'amorce.
    public static func columnWidth(_ size: DynamicTypeSize, available: CGFloat) -> CGFloat {
        let width = textWidth(size)
        let step = width + spacing
        let whole = ((available - margin + spacing) / step).rounded(.down)
        let peek = available - margin - whole * step
        if whole >= 1, peek >= minimumPeek { return width }
        if whole >= 2 {
            return ((available - margin - width / 2) / (whole - 1)).rounded(.down) - spacing
        }
        return (available - margin - spacing - minimumPeek).rounded(.down)
    }
}
