// PROTOTYPE « OS agentique » (branche proto/os-fils) : l'état de l'espace de travail
// (fil choisi, feature comprise, niveau de zoom, tri), les décisions qui attendent
// l'humain, et le langage visuel commun : une couleur = un sens, un état = un symbole.

import ConsoleClient
import ConsoleCore
import SwiftUI

@MainActor
final class OSWorkspace: ObservableObject {
    /// La sélection de « Maintenant » (l'accueil), à la place d'un fil.
    static let now = "now"

    @Published var selection: String? = OSWorkspace.now
    /// La feature que montre « Comprendre » (sinon celle du fil choisi).
    @Published var focusRunId: String?
    @Published var understanding = false
    @Published var level: OSText.Level = .summary
    @Published var triage = false
    let pulse: OSPulse

    init(server: HarnessModel) {
        pulse = OSPulse(harness: server)
    }

    func open(_ threadId: String) {
        selection = threadId
        focusRunId = nil
    }

    func understand(runId: String, level: OSText.Level) {
        focusRunId = runId
        self.level = level
        understanding = true
    }
}

/// Une décision qui attend l'humain, d'où qu'elle vienne.
enum OSDecision: Identifiable {
    case questions(HarnessEscalationBatch)
    case specs(HarnessRun)
    case verdict(HarnessRun)
    case approval(WorkstationAction)
    case intake(HarnessIntake)
    case audit(HarnessAudit)

    var id: String {
        switch self {
        case let .questions(batch): "q:" + batch.id
        case let .specs(run): "s:" + run.id
        case let .verdict(run): "v:" + run.id
        case let .approval(action): "w:\(action.seq)"
        case let .intake(intake): "i:" + intake.id
        case let .audit(audit): "a:" + audit.id
        }
    }

    var runId: String? {
        switch self {
        case let .questions(batch): batch.id
        case let .specs(run), let .verdict(run): run.id
        default: nil
        }
    }

    /// Toutes les décisions en attente, les plus anciennes d'abord dans chaque sorte.
    @MainActor
    static func all(server: HarnessModel, workstation: WorkstationModel) -> [OSDecision] {
        var items: [OSDecision] = []
        if let inbox = server.inbox {
            items += inbox.openBatches.map(OSDecision.questions)
            items += inbox.awaiting.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
            items += inbox.auditsProposed.map(OSDecision.audit)
        }
        items += workstation.approvals.map(OSDecision.approval)
        items += server.intakes.open.filter { $0.isPlanned || $0.isClarifying }.map(OSDecision.intake)
        return items
    }

    /// Les décisions d'une feature.
    @MainActor
    static func of(runId: String, server: HarnessModel) -> [OSDecision] {
        guard let inbox = server.inbox else { return [] }
        var items: [OSDecision] = inbox.openBatches.filter { $0.id == runId }.map(OSDecision.questions)
        items += inbox.awaiting.filter { $0.id == runId }.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
        return items
    }
}

extension OSPhase {
    var color: Color {
        switch self {
        case .yours: .orange
        case .working: .accentColor
        case .queued: .secondary
        case .done: .green
        case .failed: .red
        case .stopped: .secondary
        }
    }

    var symbol: String {
        switch self {
        case .yours: "hand.raised.circle.fill"
        case .working: "circle.dotted.circle"
        case .queued: "circle.dashed"
        case .done: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .stopped: "minus.circle"
        }
    }
}

/// L'état d'un agent ou d'un fil en un symbole : il tourne quand l'agent travaille.
struct OSPhaseMark: View {
    let phase: OSPhase
    var size: CGFloat = 15

    var body: some View {
        Image(systemName: phase.symbol)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(phase.color)
            .symbolEffect(.rotate, options: .repeat(.continuous), isActive: phase == .working)
            .frame(width: size + 6, height: size + 6)
    }
}

/// Le chemin d'une feature en cinq points : fait, en cours, à venir.
struct OSStepDots: View {
    let run: HarnessRun

    var body: some View {
        let current = OSThreads.stepIndex(of: run)
        let merged = run.phase == .merged
        HStack(spacing: 4) {
            ForEach(0..<5, id: \.self) { index in
                Circle()
                    .fill(index < current || merged ? Color.green : index == current ? Color.accentColor : Color.secondary.opacity(0.25))
                    .frame(width: 7, height: 7)
                    .help(OSText.steps[index])
            }
        }
        .accessibilityLabel(OSText.steps[current])
    }
}

/// Une carte du fil : un liseré de couleur, un contenu, rien d'autre.
struct OSCard<Content: View>: View {
    var tint: Color = .secondary
    var emphasized = false
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(emphasized ? tint.opacity(0.08) : Color.primary.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(emphasized ? tint.opacity(0.6) : Color.primary.opacity(0.08))
            )
    }
}

/// Une étiquette courte : un symbole et un mot.
struct OSTag: View {
    let text: String
    var symbol: String?
    var tint: Color = .secondary

    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol) }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(tint.opacity(0.12)))
    }
}

extension Double {
    /// Un instant du serveur (millisecondes) en date.
    var osDate: Date { Date(timeIntervalSince1970: self / 1000) }
}
