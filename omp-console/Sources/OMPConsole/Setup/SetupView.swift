// La feuille « Préparation d'OMP Console » (S-5, BR-5) : une ligne par étape —
// Composants, Migration de la mémoire, Pile mémoire, Prérequis — chacune avec son
// état (à venir / en cours + détail / terminée / échouée).
//
// La présentation est une fonction PURE de `SetupState` (`SetupPresentation`) :
// les tests la lisent sans rendre une vue, et la vue ne décide de rien. Aucun
// texte n'est composé ici (`SetupText`).
//
// HIG : un seul bouton proéminent (↩) — « Réessayer » sur l'échec, sinon
// « Fermer » ; Échap ferme dans TOUS les états, et fermer n'interrompt rien.

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
    /// Détail d'une ligne en cours, d'une ligne terminée (mot oMLX) ou l'échec.
    let detail: String?
    /// Progression déterminée d'un téléchargement ; `nil` = indéterminée.
    let fraction: Double?

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

enum SetupPresentation {
    static let kinds: [SetupRow.Kind] = [.components, .migration, .stack, .prerequisites]

    /// Les quatre lignes dans leur ordre, avec l'état déduit de l'état global.
    static func rows(state: SetupState, omlx: OMLXStatus) -> [SetupRow] {
        switch state {
        case .idle:
            return kinds.map { row($0, .upcoming, nil, nil) }
        case .preparing(let step):
            let current = step.row
            return kinds.map { kind in
                if kind.index < current.index { return row(kind, .done, nil, nil) }
                if kind == current { return row(kind, .running, SetupText.stepDetail(step), step.fraction) }
                return row(kind, .upcoming, nil, nil)
            }
        case .ready:
            return kinds.map { kind in
                kind == .prerequisites
                    ? row(kind, .done, SetupText.omlxWord(omlx), nil)
                    : row(kind, .done, nil, nil)
            }
        case .failed(let failure):
            let current = failure.row
            return kinds.map { kind in
                if kind.index < current.index { return row(kind, .done, nil, nil) }
                if kind == current { return row(kind, .failed, SetupText.failureMessage(failure), nil) }
                return row(kind, .upcoming, nil, nil)
            }
        }
    }

    /// « Réessayer » : l'échec, et il RESTE visible pendant l'action de reprise
    /// (il n'est alors plus le geste principal, S-6). Il n'a de raccourci que
    /// lorsqu'il est proéminent (`showsTakeover` faux).
    static func showsRetry(_ state: SetupState) -> Bool {
        switch state {
        case .failed:
            return true
        case .preparing(.legacyStop):
            // Pendant l'arrêt de l'ancienne pile, les deux boutons d'action restent
            // affichés mais désactivés (BR-9).
            return true
        default:
            return false
        }
    }

    /// Le bouton de reprise de l'ancienne pile (S-6, BR-9) : affiché SEULEMENT sur
    /// un conflit dont le propriétaire EST l'ancienne pile (`legacyContainer != nil`),
    /// et maintenu — désactivé — pendant l'action qu'il a déclenchée.
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

    /// Vrai pendant l'action de reprise : les boutons d'action sont désactivés, la
    /// seule issue reste « Fermer » (BR-9).
    static func isActing(_ state: SetupState) -> Bool {
        if case .preparing(.legacyStop) = state { return true }
        return false
    }

    /// « Fermer » est proéminent quand rien d'autre ne l'est.
    static func closeIsProminent(_ state: SetupState) -> Bool {
        !showsRetry(state)
    }

    /// L'état de succès (la feuille se ferme d'elle-même par la politique).
    static func showsDone(_ state: SetupState) -> Bool {
        if case .ready = state { return true }
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

    private static func row(_ kind: SetupRow.Kind, _ status: SetupRow.Status, _ detail: String?, _ fraction: Double?) -> SetupRow {
        SetupRow(kind: kind, status: status, detail: detail, fraction: fraction)
    }
}

struct SetupView: View {
    @ObservedObject var setup: SetupModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(SetupText.title)
                    .font(.title2.bold())
                Text(SetupText.body)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 10) {
                ForEach(SetupPresentation.rows(state: setup.state, omlx: setup.omlx)) { row in
                    SetupRowView(row: row)
                }
            }
            .padding(.vertical, 4)
            if SetupPresentation.showsDone(setup.state) {
                Text(SetupText.done)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Spacer()
                if SetupPresentation.showsTakeover(setup.state) {
                    // Le geste de reprise (S-6) devient l'action par DÉFAUT (↩) ; il
                    // reste affiché — désactivé — pendant l'action qu'il a déclenchée.
                    Button(SetupText.takeover) { Task { await setup.takeOverLegacyStack() } }
                        .consoleButtonProminence(true)
                        .keyboardShortcut(.defaultAction)
                        .disabled(SetupPresentation.isActing(setup.state))
                        .accessibilityIdentifier("sheet.setup.takeover")
                }
                if SetupPresentation.showsRetry(setup.state) {
                    retryButton
                }
                Button(SetupText.close) { setup.dismiss() }
                    .consoleButtonProminence(SetupPresentation.closeIsProminent(setup.state))
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("sheet.setup.close")
            }
            .controlSize(.large)
            // ↩ sur le bouton PROÉMINENT dans tous les états (BR-4/BR-5) : un
            // `Button` SwiftUI ne porte qu'UN raccourci — MESURÉ le 2026-10-04
            // (`NSWindow.performKeyEquivalent` : deux `.keyboardShortcut` sur le
            // même bouton, le premier gagne et le second reste muet). « Fermer »
            // garde donc ⎋, et ce jumeau invisible — hors arbre d'accessibilité,
            // sans identifiant — porte ↩ quand « Fermer » est le bouton
            // proéminent ; sur l'échec, « Réessayer » le porte lui-même.
            // `.background` : aucun effet sur la mise en page.
            .background {
                if SetupPresentation.closeIsProminent(setup.state) {
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

    /// « Réessayer » : proéminent et porteur de ↩ quand la reprise n'est pas
    /// affichée ; sinon VISIBLE mais SANS raccourci (la reprise porte ↩) — et
    /// toujours désactivé pendant l'action de reprise.
    @ViewBuilder private var retryButton: some View {
        if SetupPresentation.showsTakeover(setup.state) {
            Button(SetupText.retry) { setup.present() }
                .disabled(SetupPresentation.isActing(setup.state))
                .accessibilityIdentifier("sheet.setup.retry")
        } else {
            Button(SetupText.retry) { setup.present() }
                .consoleButtonProminence(true)
                .keyboardShortcut(.defaultAction)
                .disabled(SetupPresentation.isActing(setup.state))
                .accessibilityIdentifier("sheet.setup.retry")
        }
    }
}

/// Une ligne : symbole d'état + titre + détail. Le symbole ET le texte portent le
/// sens (jamais la couleur seule).
private struct SetupRowView: View {
    let row: SetupRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            symbol
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                Text(SetupPresentation.title(row.kind))
                    .font(.body.weight(.medium))
                if let detail = row.detail {
                    if row.status == .failed {
                        Text(detail)
                            .font(.callout)
                            .consoleBanner(tint: .orange)
                    } else {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sheet.setup.row.\(row.kind.rawValue)")
    }

    @ViewBuilder
    private var symbol: some View {
        switch row.status {
        case .upcoming:
            Image(systemName: "circle.dashed")
                .foregroundStyle(.tertiary)
        case .running:
            if let fraction = row.fraction {
                ProgressView(value: fraction)
                    .controlSize(.small)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }
}
