// L'« OS agentique » : la PREUVE d'une décision, montrée avant ses gestes. Pour une revue :
// l'avant/après du premier critère (sinon les premières captures) en vignettes, les tests
// du dernier rapport, l'ampleur (fichiers, lignes) et le risque. Les preuves sont celles de
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
            OSFlow(spacing: 6) {
                if let report = round?.reports.last { tests(report) }
                if let verdict = run.verdict {
                    if !verdict.files.isEmpty {
                        OSTag(text: OSDecideText.files(verdict.files.count), symbol: "doc.on.doc")
                    }
                    if let lines = OSReviewFacts.diffLines(reason: run.reason) {
                        OSTag(text: OSDecideText.lines(lines), symbol: "plusminus")
                    }
                    OSTag(text: PipelineServerText.risk(verdict.risk), symbol: "shield", tint: verdict.isLowRisk ? .green : .orange)
                    if !verdict.blockers.isEmpty {
                        OSTag(text: PipelineServerText.blockers, symbol: "exclamationmark.octagon", tint: .red)
                    }
                    if verdict.isWeak {
                        OSTag(text: PipelineServerText.unverified, symbol: PipelineServerText.weakVerdictSymbol, tint: .orange)
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

    /// Les tests du dernier rapport : verts, ou combien ont échoué.
    @ViewBuilder
    private func tests(_ proof: HarnessProof) -> some View {
        if case let .report(report)? = proofs.contents[proof.n] {
            let tally = OSTestTally(report)
            let green = OSTestTally.isGreen(report)
            OSTag(
                text: ProofsText.counts(passed: tally.passed, failed: tally.failed),
                symbol: green ? "checkmark.circle.fill" : "xmark.octagon.fill", tint: green ? .green : .red
            )
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
