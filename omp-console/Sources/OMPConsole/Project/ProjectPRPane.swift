// Le volet « PR et CI » de la vue « Projet » (BR-3) : une VStack bordée insérée
// entre l'en-tête et le split Plan/Document. Au-delà de quelques PR, la liste
// défile dans une hauteur bornée : le volet ne pousse jamais Plan et Document
// hors de la fenêtre.
//
// Aucun texte n'est composé ici : tous viennent de `ProjectViewText`, et la veille
// est attachée à la vie de la vue (S-3).

import ConsoleCore
import SwiftUI

struct ProjectPRPane: View {
    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(ProjectViewText.prPaneTitle)
                    .font(.headline)
                if isLoading {
                    ProgressView().controlSize(.small)
                    Text(ProjectViewText.prLoading)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

            if model.prRows.isEmpty {
                Text(ProjectViewText.prEmpty)
                    .foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(model.prRows, id: \.slug) { row in
                            PRRowView(row: row, model: model)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: Self.rowsMaxHeight)
                .fixedSize(horizontal: false, vertical: true)
            }

            if let failure = model.prFailure {
                Text(ProjectViewText.prUnavailable(failure))
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("projet.prs.message")
            }
            if let action = model.prActionFailure {
                Text(action)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("projet.prs.action")
            }
        }
        .padding(8)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.secondary.opacity(0.3))
        )
        .accessibilityIdentifier("projet.prs")
        .onAppear { model.attachPRWatch() }
        .onDisappear { model.detachPRWatch() }
    }

    /// La hauteur au-delà de laquelle la liste des PR défile.
    private static let rowsMaxHeight: CGFloat = 160

    /// « Lecture des statuts… » : une lecture est en cours ET au moins une ligne n'a
    /// jamais été lue.
    private var isLoading: Bool {
        model.isRefreshingPRs && model.prRows.contains { $0.freshness == .unknown }
    }
}

/// Une ligne de PR : son en-tête, son slug, ses trois statuts, ses deux gestes.
struct PRRowView: View {
    let row: ProjectPRRow
    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(row.headline)
                    .font(.callout.weight(.medium))
                    .accessibilityIdentifier("projet.pr.\(row.slug).title")
                if !freshnessSuffix.isEmpty {
                    Text(freshnessSuffix)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("projet.pr.\(row.slug).stale")
                }
                Spacer(minLength: 4)
            }
            Text(row.slug)
                .font(.caption)
                .foregroundStyle(.secondary)

            ForEach(row.checks, id: \.required) { check in
                HStack(spacing: 6) {
                    Text(ProjectViewText.prCheckLine(name: check.required.name, state: check.state.label))
                        .font(.callout)
                        .accessibilityIdentifier("projet.pr.\(row.slug).check.\(check.required.id)")
                    if check.state == .red, let link = check.link, let url = ProjectPlanRowView.linkURL(link),
                       runIdentifier(of: link) != nil {
                        Link(ProjectViewText.prRunLink, destination: url)
                            .font(.caption)
                            .accessibilityIdentifier("projet.pr.\(row.slug).check.\(check.required.id).run")
                    }
                    Spacer(minLength: 0)
                }
            }

            HStack(spacing: 6) {
                Button(ProjectViewText.prOpen) {
                    model.openPR(slug: row.slug)
                }
                .accessibilityIdentifier("projet.pr.\(row.slug).open")

                Button(ProjectViewText.prMerge) {
                    Task { @MainActor in await model.beginMerge(slug: row.slug) }
                }
                .disabled(!row.isMergeAvailable)
                .help(row.isMergeAvailable ? ProjectViewText.prMerge : ProjectViewText.prMergeHelp)
                .accessibilityIdentifier("projet.pr.\(row.slug).merge")
            }
        }
        .padding(.vertical, 2)
    }

    private var freshnessSuffix: String {
        switch row.freshness {
        case .unknown: ProjectViewText.prUnknownSuffix
        case .stale: ProjectViewText.prStaleSuffix
        case .fresh: ""
        }
    }
}
