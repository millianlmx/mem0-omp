// Le volet « PR et CI » de la section Projet, en LECTURE seule (S-3, BR-4) :
// chaque PR suivie affiche « PR #<n> — <titre> » (ou l'URL quand le numéro
// manque), un lien ouvrable, et l'état des TROIS contrôles requis dans l'ordre de
// `RequiredCheck.allCases`, chacun en mots.
//
// AUCUN bouton de fusion : l'app n'appelle jamais `client.merge(...)` et ne cite
// ni `prMerge`, ni `prMergeHelp`, ni `prMergeConfirm*`.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSProjectPRView: View {
    let rows: [ProjectPRRow]
    let failure: String?
    let stale: Bool
    let isLoading: Bool
    /// Faux hors connexion : « Relire les statuts » est alors grisé
    /// (etats-non-connecte-heterogenes-ios, S-5).
    let gesturesEnabled: Bool
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(ProjectViewText.prPaneTitle)
                    .font(.headline)
                Spacer(minLength: 8)
                Button(action: onRefresh) {
                    Label(ProjectText.refresh, systemImage: "arrow.clockwise")
                }
                .disabled(!gesturesEnabled || isLoading)
                .accessibilityIdentifier(ProjectAccessibility.refresh)
            }
            if isLoading {
                ProgressView()
                    .accessibilityIdentifier(ProjectAccessibility.prPane)
            } else if let failure {
                Text(ProjectViewText.prUnavailable(failure))
                    .font(.callout)
                    .iosBanner(tone: .danger)
            } else if rows.isEmpty {
                Text(ProjectViewText.prEmpty)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                if stale {
                    Text(ProjectViewText.prStaleSuffix)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    pr(row, index: index)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pr(_ row: ProjectPRRow, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            let headline = ProjectViewText.prHeadline(number: row.number, title: row.title, url: row.url)
            if let link = ProjectViewText.prLinkURL(row.url) {
                Link(destination: link) {
                    Text(headline + freshness(row))
                        .font(.headline)
                }
            } else {
                Text(headline + freshness(row))
                    .font(.headline)
            }
            ForEach(RequiredCheck.allCases, id: \.self) { check in
                checkLine(row, check: check)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(ProjectAccessibility.prRow(index))
    }

    private func checkLine(_ row: ProjectPRRow, check: RequiredCheck) -> some View {
        let entry = row.checks.first { $0.required == check }
        let state = entry?.state ?? .pending
        return HStack(spacing: 8) {
            Text(ProjectViewText.prCheckLine(name: check.rawValue, state: state.label))
                .font(.callout)
            if state == .red, let link = entry?.link, let url = ProjectViewText.prLinkURL(link) {
                Link(ProjectViewText.prRunLink, destination: url)
                    .font(.callout)
            }
        }
        .accessibilityIdentifier(ProjectAccessibility.check(check.rawValue))
    }

    private func freshness(_ row: ProjectPRRow) -> String {
        switch row.freshness {
        case .unknown: return ProjectViewText.prUnknownSuffix
        case .stale: return ProjectViewText.prStaleSuffix
        case .fresh: return ""
        }
    }
}
