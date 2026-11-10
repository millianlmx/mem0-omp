// L'« OS agentique » : la PREUVE d'une décision, montrée avant ses gestes. Pour une revue :
// l'avant/après du premier critère (sinon les premières captures) en vignettes, les tests
// du dernier rapport, l'ampleur (fichiers) et le risque ; la taille du changement se lit
// dans la raison de la porte, sur la carte. Les preuves sont celles de
// l'onglet « Preuves » (`HarnessRunProofs`, `ProofImage`) ; un serveur qui ne les sert pas
// ne montre que les faits du verdict.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct OSDecideReviewProof: View {
    @StateObject private var proofs: HarnessRunProofs
    let run: HarnessRun
    let large: Bool
    @State private var opened: HarnessProof?

    init(server: HarnessModel, run: HarnessRun, large: Bool) {
        _proofs = StateObject(wrappedValue: HarnessRunProofs(harness: server, runId: run.id))
        self.run = run
        self.large = large
    }

    private var round: HarnessProofRound? {
        if case let .loaded(rounds) = proofs.availability { return rounds.current }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let round { captures(round) }
            OSFlow(spacing: 8) {
                if let report = round?.reports.last { tests(report) }
                if let verdict = run.verdict {
                    if !verdict.files.isEmpty {
                        OSMetric(symbol: "doc.on.doc", value: "\(verdict.files.count)", tint: .secondary, label: OSDecideText.files(verdict.files.count)) {
                            EmptyView()
                        }
                    }
                    if let level = OSGlyph.riskLevel(verdict.risk) {
                        let tint: Color = level == 1 ? .green : level == 2 ? .orange : .red
                        OSMetric(symbol: "shield.fill", value: nil, tint: tint, label: PipelineServerText.risk(verdict.risk)) {
                            OSLevelBars(level: level, tint: tint)
                        }
                    } else {
                        OSTag(text: PipelineServerText.risk(verdict.risk), symbol: "shield", tint: .orange)
                    }
                    if !verdict.blockers.isEmpty {
                        OSMetric(symbol: "exclamationmark.octagon.fill", value: "\(verdict.blockers.count)", tint: .red, label: PipelineServerText.blockers) {
                            EmptyView()
                        }
                    }
                    if verdict.isWeak {
                        OSMetric(symbol: PipelineServerText.weakVerdictSymbol, value: nil, tint: .orange, label: PipelineServerText.unverified) {
                            EmptyView()
                        }
                    }
                }
            }
        }
        .task { await proofs.load() }
        // Le dernier rapport de tests se lit dès que la liste des preuves est connue.
        .task(id: round?.reports.last?.n) {
            if let report = round?.reports.last { await proofs.read(report) }
        }
        .sheet(item: $opened) { proof in
            ProofImageSheet(proofs: proofs, proof: proof)
        }
    }

    /// L'avant et l'après du premier critère ; sans paire, les trois premières captures.
    @ViewBuilder
    private func captures(_ round: HarnessProofRound) -> some View {
        if let pair = round.pairs.first {
            HStack(alignment: .top, spacing: 10) {
                if let before = pair.before { thumbnail(before, label: ProofsText.before) }
                if let after = pair.after { thumbnail(after, label: ProofsText.after) }
            }
        } else if !round.captures.isEmpty {
            HStack(alignment: .top, spacing: 10) {
                ForEach(round.captures.prefix(3)) { capture in
                    thumbnail(capture, label: nil)
                }
            }
        }
    }

    private func thumbnail(_ proof: HarnessProof, label: String?) -> some View {
        Button {
            opened = proof
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                if let label {
                    Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
                ProofImage(proofs: proofs, proof: proof)
                    .frame(height: large ? 150 : 96)
                    .frame(maxWidth: large ? 260 : 170, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(proof.title)
    }

    /// Les tests du dernier rapport : le nombre passé sur le total, et une barre verte ou rouge.
    @ViewBuilder
    private func tests(_ proof: HarnessProof) -> some View {
        if case let .report(report)? = proofs.contents[proof.n] {
            let tally = OSTestTally(report)
            let green = OSTestTally.isGreen(report)
            let tint: Color = green ? .green : .red
            OSMetric(
                symbol: green ? "checkmark.circle.fill" : "xmark.octagon.fill",
                value: "\(tally.passed)/\(tally.passed + tally.failed)", tint: tint,
                label: ProofsText.counts(passed: tally.passed, failed: tally.failed)
            ) {
                if let share = OSGlyph.testShare(passed: tally.passed, failed: tally.failed) {
                    OSBar(fill: share, tint: tint)
                }
            }
        }
    }
}

/// Des étiquettes à la suite, qui passent à la ligne quand la carte est étroite.
struct OSFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = place(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for index in subviews.indices where isSpacer(subviews[index]) {
            subviews[index].place(at: bounds.origin, proposal: .zero)
        }
        for row in place(subviews, width: bounds.width) {
            var x = bounds.minX
            for index in row.indices {
                let size = fitted(subviews[index], width: bounds.width)
                // Chaque élément est centré dans la hauteur de sa ligne.
                let y = bounds.minY + row.y + (row.height - size.height) / 2
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
        var y: CGFloat = 0
    }

    /// La taille d'un élément : la sienne, bornée à la largeur offerte (un texte plus large
    /// que la carte passe à la ligne au lieu d'en sortir).
    private func fitted(_ subview: LayoutSubview, width: CGFloat) -> CGSize {
        let ideal = subview.sizeThatFits(.unspecified)
        return ideal.width > width ? subview.sizeThatFits(ProposedViewSize(width: width, height: nil)) : ideal
    }

    /// Un écarteur (`Spacer`) : il prend toute la largeur qu'on lui offre et n'a pas de
    /// taille à lui. Dans une rangée qui passe à la ligne, il ne prend aucune place.
    private func isSpacer(_ subview: LayoutSubview) -> Bool {
        let offered: CGFloat = 100_000
        return subview.sizeThatFits(.unspecified).width < 20
            && subview.sizeThatFits(ProposedViewSize(width: offered, height: nil)).width >= offered
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices where !isSpacer(subviews[index]) {
            let size = fitted(subviews[index], width: width)
            let extended = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            if !row.indices.isEmpty, extended > width {
                rows.append(row)
                row = Row(indices: [index], width: size.width, height: size.height, y: row.y + row.height + spacing)
            } else {
                row.indices.append(index)
                row.width = extended
                row.height = max(row.height, size.height)
            }
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}
