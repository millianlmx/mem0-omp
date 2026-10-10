// La feuille « Préparation d'OMP Console » (S-5, BR-5) : une ligne par étape —
// Composants, Migration de la mémoire, Pile mémoire, Prérequis — chacune avec son
// état (à venir / en cours / terminée / échouée), un bloc de progression pleine
// largeur pendant la préparation, et le pied des gestes.
//
// La présentation est une fonction PURE de `SetupState` et du mode
// (`SetupPresentation`) : les tests la lisent sans rendre une vue, et la vue ne
// décide de rien. Aucun texte n'est composé ici (`SetupText`).
//
// Deux modes (mac-omp-manquant-non-bloquant, S-1/S-2) :
// - BLOQUANT (OMP absent) : « Quitter » à gauche, « Réessayer » et « Installer »
//   (proéminent, ↩) à droite ; aucun « Fermer », rien ne consomme ⎋, et la
//   racine pose `.interactiveDismissDisabled`. ⌘Q passe par « Quitter » (Doc-3).
// - FERMABLE (OMP présent) : « Fermer » (⎋) proéminent, ou « Réessayer »
//   proéminent puis « Fermer » sur l'échec ; fermer n'interrompt rien.

import ConsoleCore
import SwiftUI

/// Une ligne de la feuille.
struct SetupRow: Equatable, Identifiable {
    enum Kind: String, CaseIterable {
        case components, migration, stack, prerequisites

        /// L'ordre des lignes, pour « avant / en cours / après ».
        var index: Int {
            switch self {
            case .components: 0
            case .migration: 1
            case .stack: 2
            case .prerequisites: 3
            }
        }
    }

    enum Status: Equatable {
        case upcoming
        case running
        case done
        case failed
    }

    let kind: Kind
    let status: Status
    /// Le mot oMLX d'une ligne terminée, ou la phrase claire de l'échec. La
    /// ligne en cours n'en a pas : son détail vit dans le bloc de progression.
    let detail: String?
    /// Le détail technique de l'échec, replié derrière « Afficher le détail » ;
    /// seulement sur la ligne `.failed`.
    let technicalDetail: String?

    var id: String { kind.rawValue }
}

extension SetupStep {
    /// La ligne qui porte l'étape.
    var row: SetupRow.Kind {
        switch self {
        case .omp, .ompInstall, .podman, .podmanInstall: .components
        case .legacyStop, .migrationCopy: .migration
        case .machine, .images, .containers, .health, .union: .stack
        case .prerequisites: .prerequisites
        }
    }

    /// La progression déterminée d'un téléchargement (0…1), `nil` sinon.
    var fraction: Double? {
        switch self {
        case .omp(let downloaded, let total), .podman(let downloaded, let total):
            guard total > 0 else { return nil }
            return min(max(Double(downloaded) / Double(total), 0), 1)
        default:
            return nil
        }
    }
}

extension SetupFailure {
    /// La ligne qui a échoué (les suivantes ne tournent pas).
    var row: SetupRow.Kind {
        switch self {
        case .components: .components
        case .migration: .migration
        case .stack: .stack
        // L'arrêt refusé de l'ancienne pile appartient à la ligne « Migration de
        // la mémoire », dont il est le geste explicite (S-6).
        case .legacy: .migration
        }
    }
}

/// Un geste du pied de la feuille.
enum SetupAction: String, CaseIterable {
    case install, retry, quit, close
}

/// Le pied de la feuille : les gestes à gauche et à droite, le proéminent (↩)
/// et ceux qui sont désactivés.
struct SetupFooter: Equatable {
    let leading: [SetupAction]
    let trailing: [SetupAction]
    let prominent: SetupAction?
    let disabled: Set<SetupAction>
}

/// Le bloc de progression : l'étape en cours et sa part faite (`nil` =
/// indéterminée).
struct SetupProgress: Equatable {
    let label: String
    let fraction: Double?
}

enum SetupPresentation {
    static let kinds: [SetupRow.Kind] = [.components, .migration, .stack, .prerequisites]

    /// Les quatre lignes dans leur ordre, avec l'état déduit de l'état global. En
    /// mode bloquant, `.ready` (OMP toujours absent) se présente comme `.idle`.
    static func rows(state: SetupState, omlx: OMLXStatus, blocking: Bool) -> [SetupRow] {
        switch state {
        case .idle:
            return kinds.map { row($0, .upcoming) }
        case .ready where blocking:
            return rows(state: .idle, omlx: omlx, blocking: blocking)
        case .preparing(let step):
            let current = step.row
            return kinds.map { kind in
                if kind.index < current.index { return row(kind, .done) }
                if kind == current { return row(kind, .running) }
                return row(kind, .upcoming)
            }
        case .ready:
            return kinds.map { kind in
                kind == .prerequisites
                    ? row(kind, .done, SetupText.omlxWord(omlx))
                    : row(kind, .done)
            }
        case .failed(let failure):
            let current = failure.row
            return kinds.map { kind in
                if kind.index < current.index { return row(kind, .done) }
                if kind == current {
                    return row(kind, .failed, SetupText.failureSummary(failure), SetupText.failureDetail(failure))
                }
                return row(kind, .upcoming)
            }
        }
    }

    /// Le bloc de progression : seulement pendant une préparation.
    static func progress(state: SetupState) -> SetupProgress? {
        guard case .preparing(let step) = state else { return nil }
        return SetupProgress(label: SetupText.stepDetail(step), fraction: step.fraction)
    }

    /// La reprise de l'ancienne pile (S-6, BR-9) : proposée SEULEMENT sur un
    /// conflit dont le propriétaire EST l'ancienne pile (`legacyContainer != nil`),
    /// et maintenue — désactivée — pendant l'action qu'elle a déclenchée.
    static func showsTakeover(_ state: SetupState) -> Bool {
        switch state {
        case let .failed(.stack(.portConflict(_, owner))):
            return owner.legacyContainer != nil
        case .preparing(.legacyStop):
            return true
        default:
            return false
        }
    }

    /// Le pied de la feuille (S-1/S-2, table du lot BR-2).
    static func footer(state: SetupState, blocking: Bool) -> SetupFooter {
        switch (blocking, state) {
        case (true, .preparing):
            return SetupFooter(leading: [.quit], trailing: [.retry, .install], prominent: nil, disabled: [.retry, .install])
        case (true, _):
            return SetupFooter(leading: [.quit], trailing: [.retry, .install], prominent: .install, disabled: [])
        case (false, .failed):
            return SetupFooter(leading: [], trailing: [.retry, .close], prominent: .retry, disabled: [])
        case (false, _):
            return SetupFooter(leading: [], trailing: [.close], prominent: .close, disabled: [])
        }
    }

    /// L'état de succès (la feuille se ferme d'elle-même par la politique) ;
    /// jamais en mode bloquant, où `.ready` se présente comme `.idle`.
    static func showsDone(state: SetupState, blocking: Bool) -> Bool {
        if case .ready = state { return !blocking }
        return false
    }

    /// Le titre d'une ligne.
    static func title(_ kind: SetupRow.Kind) -> String {
        switch kind {
        case .components: SetupText.componentsRow
        case .migration: SetupText.migrationRow
        case .stack: SetupText.stackRow
        case .prerequisites: SetupText.prerequisitesRow
        }
    }

    /// Le libellé d'un geste du pied.
    static func label(_ action: SetupAction) -> String {
        switch action {
        case .install: SetupText.install
        case .retry: SetupText.retry
        case .quit: SetupText.quit
        case .close: SetupText.close
        }
    }

    private static func row(
        _ kind: SetupRow.Kind,
        _ status: SetupRow.Status,
        _ detail: String? = nil,
        _ technicalDetail: String? = nil
    ) -> SetupRow {
        SetupRow(kind: kind, status: status, detail: detail, technicalDetail: technicalDetail)
    }
}

struct SetupView: View {
    @ObservedObject var setup: SetupModel
    /// La présence d'OMP lue par `HomeModel` : `.missing` ⇒ mode bloquant.
    let omp: OmpStatus
    /// « Quitter » : ferme la feuille par programme puis termine l'app (Doc-2).
    let quit: @MainActor () -> Void

    private var blocking: Bool { omp == .missing }

    private var isPreparing: Bool {
        if case .preparing = setup.state { return true }
        return false
    }

    var body: some View {
        let footer = SetupPresentation.footer(state: setup.state, blocking: blocking)
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(SetupText.title)
                    .font(.title2.bold())
                Text(SetupText.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if blocking && !isPreparing {
                    Text(SetupText.ompMissingBody)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("sheet.setup.ompMissing")
                }
                if blocking && setup.retryMissed {
                    Text(SetupText.retryMissed)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("sheet.setup.retryMissed")
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                ForEach(SetupPresentation.rows(state: setup.state, omlx: setup.omlx, blocking: blocking)) { row in
                    SetupRowView(row: row)
                }
            }
            .padding(.vertical, 4)
            if let progress = SetupPresentation.progress(state: setup.state) {
                SetupProgressView(progress: progress)
            }
            if SetupPresentation.showsDone(state: setup.state, blocking: blocking) {
                Text(SetupText.done)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                ForEach(footer.leading, id: \.self) { button($0, footer) }
                Spacer()
                ForEach(footer.trailing, id: \.self) { button($0, footer) }
            }
            .controlSize(.large)
            // ↩ sur « Fermer » quand il est proéminent : un `Button` SwiftUI ne
            // porte qu'UN raccourci — MESURÉ le 2026-10-04
            // (`NSWindow.performKeyEquivalent` : deux `.keyboardShortcut` sur le
            // même bouton, le premier gagne et le second reste muet). « Fermer »
            // garde donc ⎋, et ce jumeau invisible — hors arbre d'accessibilité,
            // sans identifiant — porte ↩. Les autres proéminents (« Installer »,
            // « Réessayer ») portent ↩ eux-mêmes. `.background` : aucun effet sur
            // la mise en page.
            .background {
                if footer.prominent == .close {
                    Button(SetupText.close) { setup.dismiss() }
                        .keyboardShortcut(.defaultAction)
                        .frame(width: 0, height: 0)
                        .opacity(0)
                        .accessibilityHidden(true)
                }
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sheet.setup")
    }

    private func button(_ action: SetupAction, _ footer: SetupFooter) -> some View {
        Button(SetupPresentation.label(action)) { perform(action) }
            .consoleButtonProminence(action == footer.prominent)
            .disabled(footer.disabled.contains(action))
            .keyboardShortcut(shortcut(action, footer))
            .accessibilityIdentifier("sheet.setup.\(action.rawValue)")
    }

    /// Le raccourci d'un geste : ⎋ pour « Fermer » (qui n'existe qu'en mode
    /// fermable), ⌘Q pour « Quitter », ↩ pour le proéminent actif — sauf
    /// « Fermer », dont le jumeau invisible porte ↩. Aucun ⎋ en mode bloquant.
    private func shortcut(_ action: SetupAction, _ footer: SetupFooter) -> KeyboardShortcut? {
        switch action {
        case .close:
            return .cancelAction
        case .quit:
            return KeyboardShortcut("q", modifiers: .command)
        case .install, .retry:
            guard action == footer.prominent, !footer.disabled.contains(action) else { return nil }
            return .defaultAction
        }
    }

    private func perform(_ action: SetupAction) {
        switch action {
        case .install: setup.startInstall()
        case .retry: setup.retry()
        case .quit: quit()
        case .close: setup.dismiss()
        }
    }
}

/// Le bloc de progression, pleine largeur du contenu de la feuille : le nom de
/// l'étape en cours, puis une barre linéaire — chiffrée quand la taille du
/// téléchargement est connue, indéterminée sinon (Doc-4).
private struct SetupProgressView: View {
    let progress: SetupProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(progress.label)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("sheet.setup.progress.label")
            bar
                .progressViewStyle(.linear)
                .frame(maxWidth: .infinity)
                .accessibilityLabel(progress.label)
                .accessibilityIdentifier("sheet.setup.progress.bar")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("sheet.setup.progress")
    }

    @ViewBuilder
    private var bar: some View {
        if let fraction = progress.fraction {
            ProgressView(value: fraction)
        } else {
            ProgressView()
        }
    }
}

/// Une ligne : symbole d'état + titre + détail. Le symbole ET le texte portent le
/// sens (jamais la couleur seule). La ligne en échec porte la phrase claire, et
/// son détail technique se replie derrière « Afficher le détail ».
private struct SetupRowView: View {
    let row: SetupRow
    /// Le détail technique déplié ; replié à chaque nouvel échec.
    @State private var expanded = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            symbol
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(SetupPresentation.title(row.kind))
                    .font(.body.weight(.medium))
                if let detail = row.detail {
                    if row.status == .failed {
                        failure(detail)
                    } else {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .onChange(of: row.technicalDetail) { expanded = false }
        // `.contain` quand un détail existe : le bouton et la zone restent
        // atteignables ; sinon la ligne se lit d'un seul tenant.
        .accessibilityElement(children: row.technicalDetail == nil ? .combine : .contain)
        .accessibilityIdentifier("sheet.setup.row.\(row.kind.rawValue)")
    }

    private func failure(_ summary: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(summary)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .consoleBanner(tint: .orange)
                .accessibilityIdentifier("sheet.setup.failure")
            if let technical = row.technicalDetail {
                Button(expanded ? SetupText.hideDetail : SetupText.showDetail) { expanded.toggle() }
                    .buttonStyle(.link)
                    .accessibilityIdentifier("sheet.setup.detail.toggle")
                if expanded {
                    // Hauteur FIXE : la feuille ne grandit pas avec le détail, qui
                    // défile jusqu'à sa dernière ligne.
                    ScrollView {
                        Text(technical)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                    }
                    .frame(height: 120)
                    .consoleCard(selected: false)
                    .accessibilityIdentifier("sheet.setup.detail")
                }
            }
        }
    }

    @ViewBuilder
    private var symbol: some View {
        switch row.status {
        case .upcoming:
            Image(systemName: "circle.dashed")
                .foregroundStyle(.tertiary)
        case .running:
            Image(systemName: "ellipsis.circle.fill")
                .foregroundStyle(.tint)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }
}
