// L'onglet « Preuves » de la page d'une feature, partagé par le Mac (dans un Form
// groupé) et l'iPhone/iPad (dans la liste groupée de la page) : le tour de revue
// courant d'abord — l'avant et l'après de chaque critère côte à côte, les autres
// captures en vignettes, les rapports de tests par critère, les journaux et les
// vidéos —, puis les tours précédents, repliés. Rien de vide n'est montré : une partie
// sans preuve n'a pas de section.
//
// Le contenu d'une preuve se lit quand sa vue paraît (`HarnessRunProofs.read`) ; une
// capture se décode par ImageIO, sans AppKit ni UIKit.

import ConsoleClient
import ConsoleCore
import ImageIO
import SwiftUI

/// Les sections de l'onglet « Preuves ». Rien tant que la lecture n'est pas tranchée,
/// ni quand le serveur ne sert pas les preuves (l'onglet n'existe pas alors).
public struct RunProofsSections: View {
    @ObservedObject var proofs: HarnessRunProofs

    public init(proofs: HarnessRunProofs) {
        self.proofs = proofs
    }

    public var body: some View {
        switch proofs.availability {
        case .loading, .absent:
            EmptyView()
        case .failed(let failure):
            Section {
                Label(failure.message, systemImage: DashboardText.alertsSymbol)
                    .foregroundStyle(.orange)
                Button(MonitoringText.refresh) {
                    Task { await proofs.load() }
                }
            } header: {
                Text(ProofsText.failed)
            }
            .accessibilityIdentifier("run.proofs.failed")
        case .loaded(let rounds):
            if rounds.current.isEmpty {
                Section {
                    Text(ProofsText.none)
                        .foregroundStyle(.secondary)
                }
            }
            ProofRoundSections(proofs: proofs, round: rounds.current)
            if !rounds.previous.isEmpty {
                Section {
                    DisclosureGroup(ProofsText.previousRounds) {
                        ProofRoundStack(proofs: proofs, round: rounds.previous)
                            .padding(.top, 6)
                    }
                    .accessibilityIdentifier("run.proofs.previous")
                } footer: {
                    Text(ProofsText.previousRoundsHint)
                }
            }
        }
    }
}

/// Un tour en sections : celui qu'on montre d'emblée.
private struct ProofRoundSections: View {
    @ObservedObject var proofs: HarnessRunProofs
    let round: HarnessProofRound

    var body: some View {
        if !round.pairs.isEmpty {
            Section {
                ForEach(round.pairs) { pair in
                    ProofPairView(proofs: proofs, pair: pair)
                }
            } header: {
                Text(ProofsText.pairs)
            }
        }
        if !round.captures.isEmpty {
            Section {
                ProofThumbnails(proofs: proofs, captures: round.captures)
            } header: {
                Text(ProofsText.captures)
            }
        }
        if !round.reports.isEmpty {
            Section {
                ForEach(round.reports) { report in
                    ProofReportView(proofs: proofs, proof: report)
                }
            } header: {
                Text(ProofsText.reports)
            }
        }
        if !round.logs.isEmpty {
            Section {
                ForEach(round.logs) { log in
                    ProofLogView(proofs: proofs, proof: log)
                }
            } header: {
                Text(ProofsText.logs)
            }
        }
        if !round.videos.isEmpty {
            Section {
                ForEach(round.videos) { video in
                    ProofVideoRow(proof: video)
                }
            } header: {
                Text(ProofsText.videos)
            }
        }
    }
}

/// Un tour en une pile, sous ses intertitres : les tours précédents, repliés.
private struct ProofRoundStack: View {
    @ObservedObject var proofs: HarnessRunProofs
    let round: HarnessProofRound

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !round.pairs.isEmpty {
                group(ProofsText.pairs) {
                    ForEach(round.pairs) { pair in
                        ProofPairView(proofs: proofs, pair: pair)
                    }
                }
            }
            if !round.captures.isEmpty {
                group(ProofsText.captures) {
                    ProofThumbnails(proofs: proofs, captures: round.captures)
                }
            }
            if !round.reports.isEmpty {
                group(ProofsText.reports) {
                    ForEach(round.reports) { report in
                        ProofReportView(proofs: proofs, proof: report)
                    }
                }
            }
            if !round.logs.isEmpty {
                group(ProofsText.logs) {
                    ForEach(round.logs) { log in
                        ProofLogView(proofs: proofs, proof: log)
                    }
                }
            }
            if !round.videos.isEmpty {
                group(ProofsText.videos) {
                    ForEach(round.videos) { video in
                        ProofVideoRow(proof: video)
                    }
                }
            }
        }
    }

    private func group<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }
}

/// L'avant et l'après d'un critère, côte à côte ; un côté sans capture n'a pas de colonne.
private struct ProofPairView: View {
    @ObservedObject var proofs: HarnessRunProofs
    let pair: HarnessProofPair

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ProofsText.criterion(pair.acRef))
                .font(.subheadline.weight(.semibold))
            HStack(alignment: .top, spacing: 10) {
                if let before = pair.before {
                    side(ProofsText.before, before)
                }
                if let after = pair.after {
                    side(ProofsText.after, after)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("run.proofs.pair")
    }

    private func side(_ label: String, _ proof: HarnessProof) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ProofImage(proofs: proofs, proof: proof)
                .frame(maxHeight: 360)
            Text(proof.title)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Les captures sans avant/après, en vignettes ; une vignette touchée s'ouvre en grand.
private struct ProofThumbnails: View {
    @ObservedObject var proofs: HarnessRunProofs
    let captures: [HarnessProof]
    @State private var opened: HarnessProof?

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10, alignment: .top)], alignment: .leading, spacing: 10) {
            ForEach(captures) { capture in
                Button {
                    opened = capture
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        ProofImage(proofs: proofs, proof: capture)
                            .frame(height: 110)
                            .frame(maxWidth: .infinity)
                        Text(capture.title)
                            .font(.caption)
                            .lineLimit(2)
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("run.proofs.thumbnail")
            }
        }
        .padding(.vertical, 4)
        .sheet(item: $opened) { capture in
            ProofImageSheet(proofs: proofs, proof: capture)
        }
    }
}

/// Une capture en grand, avec son titre.
struct ProofImageSheet: View {
    @ObservedObject var proofs: HarnessRunProofs
    let proof: HarnessProof
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(proof.title)
                    .font(.headline)
                Spacer()
                Button(PipelineServerText.close) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            ProofImage(proofs: proofs, proof: proof)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding()
        .frame(minWidth: 480, minHeight: 360)
    }
}

/// Une capture lue au serveur et décodée.
struct ProofImage: View {
    @ObservedObject var proofs: HarnessRunProofs
    let proof: HarnessProof
    @State private var image: CGImage?

    var body: some View {
        Group {
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            } else {
                switch proofs.contents[proof.n] {
                case nil:
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 60)
                case .missing:
                    notice(ProofsText.missing)
                case .failed(let failure):
                    notice(failure.message)
                default:
                    notice(ProofsText.unreadable)
                }
            }
        }
        .accessibilityLabel(proof.title)
        .task(id: proof.n) { await proofs.read(proof) }
        .task(id: proofs.contents[proof.n]) {
            if case .image(let data)? = proofs.contents[proof.n] { image = Self.decoded(data) }
        }
    }

    private func notice(_ text: String) -> some View {
        Label(text, systemImage: DashboardText.alertsSymbol)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    /// Une image PNG ou JPEG ; `nil` pour des octets qui n'en sont pas.
    static func decoded(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

/// Un rapport de tests : chaque critère des specs, réussis et échoués, puis les autres tests.
private struct ProofReportView: View {
    @ObservedObject var proofs: HarnessRunProofs
    let proof: HarnessProof

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(proof.title)
                .font(.subheadline.weight(.semibold))
            switch proofs.contents[proof.n] {
            case .report(let report):
                if report.truncated {
                    Label(ProofsText.truncated, systemImage: DashboardText.alertsSymbol)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if report.criteria.isEmpty {
                    Text(ProofsText.noCriteria)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                ForEach(report.criteria) { criterion in
                    HStack(alignment: .firstTextBaseline) {
                        Image(systemName: criterion.failed > 0 ? "xmark.circle.fill" : "checkmark.circle.fill")
                            .foregroundStyle(criterion.failed > 0 ? Color.red : Color.green)
                            .accessibilityHidden(true)
                        Text(criterion.id)
                            .font(.callout.monospaced())
                        Spacer(minLength: 8)
                        Text(ProofsText.counts(passed: criterion.passed, failed: criterion.failed))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                if report.other.tests > 0 {
                    HStack(alignment: .firstTextBaseline) {
                        Text(ProofsText.otherTests)
                            .font(.callout)
                        Spacer(minLength: 8)
                        Text(ProofsText.counts(passed: report.other.passed, failed: report.other.failed))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            case nil:
                ProgressView()
            case .missing:
                Text(ProofsText.missing).foregroundStyle(.secondary)
            case .failed(let failure):
                Text(failure.message).foregroundStyle(.secondary)
            default:
                Text(ProofsText.unreadable).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .task(id: proof.n) { await proofs.read(proof) }
        .accessibilityIdentifier("run.proofs.report")
    }
}

/// Un journal joint par l'agent, replié sous son titre.
private struct ProofLogView: View {
    @ObservedObject var proofs: HarnessRunProofs
    let proof: HarnessProof

    var body: some View {
        DisclosureGroup(proof.title) {
            switch proofs.contents[proof.n] {
            case .text(let text):
                Text(text)
                    .font(.caption.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
            case nil:
                ProgressView()
            case .missing:
                Text(ProofsText.missing).foregroundStyle(.secondary)
            case .failed(let failure):
                Text(failure.message).foregroundStyle(.secondary)
            default:
                Text(ProofsText.unreadable).foregroundStyle(.secondary)
            }
        }
        .task(id: proof.n) { await proofs.read(proof) }
    }
}

/// Une vidéo : son titre et sa taille ; l'onglet ne la joue pas.
private struct ProofVideoRow: View {
    let proof: HarnessProof

    var body: some View {
        LabeledContent(proof.title, value: ProofsText.size(proof.size))
    }
}
