// Le contenu PUR de la section « Dépôts » de l'app iOS (S-6 de
// orchestrator-living-in-a-vps) : chaque ligne de la vue unifiée devient une rangée
// dont chaque mot vient de `ReposText` (ConsoleCore) — la vue ne compose aucune
// phrase. Aucun SwiftUI ici : le test fige la dérivation.

import ConsoleClient
import ConsoleCore

/// Un chemin d'un dépôt sur UNE machine.
struct IOSReposPath: Equatable {
    let machine: RepoMachine
    let text: String
}

/// Une rangée de la section « Dépôts ».
struct IOSReposRow: Equatable, Identifiable {
    let id: String
    let name: String
    /// Les machines marquées sur la rangée : la conductrice ; les deux en conflit.
    let badges: [RepoMachine]
    /// Le chemin par machine qui connaît le dépôt, via `ConsoleFormat.path`.
    let paths: [IOSReposPath]
    /// L'état de la ligne, `nil` quand elle est pilotable.
    let status: String?
    /// « N feature(s) finissent sur le Mac », quand la machine non conductrice en a encore.
    let finishing: String?
    /// « Annuler la bascule » : une bascule gelée dont le retrait final n'a pas échoué.
    let canCancel: Bool
    /// « Réessayer » : une bascule à terminer.
    let canRetry: Bool
    /// Les gestes « Confier au … » de la ligne, actifs ou désactivés avec leur motif.
    let offers: [HandoverOffer]
    /// Une bascule de cette ligne s'exécute : ses gestes sont grisés.
    let busy: Bool
}

enum IOSReposContent {
    /// Les rangées de la vue unifiée. `home` rend le dossier personnel d'une machine
    /// (publié par ses composants) : un chemin ne s'abrège jamais contre celui de l'iPhone.
    static func rows(
        _ lines: [UnifiedRepo],
        busy: Set<String>,
        home: (RepoMachine) -> String?
    ) -> [IOSReposRow] {
        lines.map { line in
            let paths = RepoMachine.allCases.compactMap { machine -> IOSReposPath? in
                guard let row = line.row(on: machine) else { return nil }
                return IOSReposPath(machine: machine, text: ConsoleFormat.path(row.repoRoot, home: home(machine)))
            }
            let toFinish: Bool
            if case .handoverToFinish = line.status { toFinish = true } else { toFinish = false }
            let frozen: Bool
            if case .handoverInProgress = line.status { frozen = true } else { frozen = false }
            return IOSReposRow(
                id: line.id,
                name: line.name,
                badges: line.conductor.map { [$0] } ?? RepoMachine.allCases,
                paths: paths,
                status: status(of: line),
                finishing: line.finishing.map { ReposText.finishing($0.count, on: $0.machine) },
                canCancel: frozen,
                canRetry: toFinish,
                offers: line.offers,
                busy: busy.contains(line.id)
            )
        }
    }

    /// L'état d'une ligne : exactement les textes de S-6.
    static func status(of line: UnifiedRepo) -> String? {
        switch line.status {
        case .drivable: nil
        case .unreachable(let machine): ReposText.unreachable(machine)
        case .handoverInProgress(let target): ReposText.handoverInProgress(to: target)
        case .handoverToFinish: ReposText.handoverToFinish
        case .conflict: ReposText.conflict
        }
    }

    /// Le libellé d'accessibilité d'un badge : le texte visible puis la machine.
    static func badgeLabel(_ machine: RepoMachine) -> String {
        ReposText.accessibility(machine.label, machine: machine)
    }

    /// Les bandeaux de l'Accueil et de Pipelines : aucun sans VPS configuré (rendu
    /// inchangé), sinon un par machine configurée qui ne répond pas.
    @MainActor static func boardBanners(_ clients: MachineClients) -> [RepoMachine] {
        clients.vpsConfigured ? unreachableBanners(clients) : []
    }

    /// Les machines dont un bandeau « <Machine> injoignable » s'affiche en tête de
    /// la section : celles qui sont configurées mais ne répondent pas.
    @MainActor static func unreachableBanners(_ clients: MachineClients) -> [RepoMachine] {
        RepoMachine.allCases.filter { clients.availability(of: $0) == .unreachable }
    }
}
