// L'« OS agentique » : les REPÈRES VISUELS qui se lisent sans phrase, partagés par le Mac et
// l'iPhone/iPad. Le chemin d'une feature (`OSJourney`), les cinq compteurs de « Maintenant »
// (`OSCountStrip`), un anneau (`OSRing`), une barre de grandeur (`OSBar`), un niveau
// (`OSLevelBars`), un compte à rebours (`OSCountdown`) et une mesure de preuve (`OSMetric`).
// Règle : un repère montre un nombre, une forme ou une couleur ; le mot ne sert qu'à
// VoiceOver et à l'infobulle. La logique (états, échelles) est dans `OSGlyph`, pure.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La logique des repères : sans vue, donc testable.
public enum OSGlyph {
    public enum Node: Equatable, Sendable { case done, current, upcoming }

    /// Un symbole par étape : Besoins, Specs, Implémentation, Revue, Fusion.
    public static let stepSymbols = ["text.bubble", "checklist", "hammer", "eye", "flag.checkered"]

    /// La part du plafond déjà dépensée (1 = plafond atteint, au-delà : dépassé) ; 0 sans plafond valide.
    public static func budgetShare(spent: Double, ceiling: Double) -> Double {
        ceiling > 0 ? max(0, spent) / ceiling : 0
    }

    /// Le symbole de ce qui retient une feature en file ; un code d'une version plus récente garde le sablier.
    public static func waitSymbol(_ cause: String) -> String {
        switch cause {
        case "memory": "memorychip"
        case "slots": "person.3.fill"
        case "repo_cap": "shippingbox"
        case "modules": "square.on.square"
        case "daily_budget", "space_budget": "dollarsign.circle"
        case "paused": "pause.circle"
        case "parent": "link"
        case "backoff": "arrow.clockwise.circle"
        case "unknown_repo": "questionmark.folder"
        default: "hourglass"
        }
    }

    /// L'état des cinq points du chemin d'une feature : tout est fait une fois fusionnée.
    public static func nodes(step: Int, merged: Bool) -> [Node] {
        (0..<5).map { index in merged || index < step ? .done : index == step ? .current : .upcoming }
    }

    /// Le niveau d'un risque (1 faible, 2 moyen, 3 élevé) ; `nil` pour un risque que cette version ne connaît pas.
    public static func riskLevel(_ risk: String) -> Int? {
        switch risk {
        case "low": 1
        case "medium": 2
        case "high": 3
        default: nil
        }
    }

    /// La part des tests passés, de 0 à 1 ; `nil` sans aucun test.
    public static func testShare(passed: Int, failed: Int) -> Double? {
        let total = passed + failed
        return total > 0 ? Double(passed) / Double(total) : nil
    }

    /// Ce qu'il reste d'un délai, de 1 (entier) à 0 (échu).
    public static func remaining(_ seconds: Double, of total: Double) -> Double {
        guard total > 0 else { return 0 }
        return min(1, max(0, seconds / total))
    }
}

/// Le chemin d'une feature en cinq points reliés : fait (vert, coche), en cours (teinte de l'état,
/// symbole de l'étape), à venir (gris). `large` nomme l'étape en cours sous son point.
public struct OSJourney: View {
    let run: HarnessRun
    let tint: Color
    let large: Bool

    public init(run: HarnessRun, tint: Color = .accentColor, large: Bool = false) {
        self.run = run
        self.tint = tint
        self.large = large
    }

    public var body: some View {
        let step = OSThreads.stepIndex(of: run)
        let nodes = OSGlyph.nodes(step: step, merged: run.phase == .merged)
        let size: CGFloat = large ? 30 : 16
        HStack(spacing: 0) {
            ForEach(0..<5, id: \.self) { index in
                node(index, nodes[index], size: size, showsName: large && nodes[index] == .current)
                if index < 4 {
                    Capsule()
                        .fill(nodes[index] == .done ? Color.green : Color.secondary.opacity(0.25))
                        .frame(height: large ? 3 : 2)
                        .frame(maxWidth: large ? .infinity : 10)
                }
            }
        }
        .padding(.bottom, large ? 18 : 0)
        .frame(maxWidth: large ? 360 : nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(OSText.steps[step])
        .accessibilityValue("\(step + 1) / 5")
    }

    private func node(_ index: Int, _ state: OSGlyph.Node, size: CGFloat, showsName: Bool) -> some View {
        let symbol = state == .done ? "checkmark" : OSGlyph.stepSymbols[index]
        return ZStack {
            Circle().fill(state == .done ? Color.green : state == .current ? tint : Color.secondary.opacity(0.18))
            Image(systemName: symbol)
                .font(.system(size: size * 0.5, weight: .bold))
                .foregroundStyle(state == .upcoming ? Color.secondary.opacity(0.7) : Color.white)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .top) {
            if showsName {
                Text(OSText.steps[index])
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tint)
                    .fixedSize()
                    .offset(y: size + 3)
            }
        }
        .help(OSText.steps[index])
    }
}

/// Les cinq compteurs de « Maintenant » : une icône, un nombre, un mot. Un compteur à zéro
/// s'éteint, un compteur plein prend la couleur de son sens ; celui qui a un geste est un bouton.
public struct OSCountStrip: View {
    public struct Item: Identifiable {
        public let phase: OSPhase
        public let label: String
        public let count: Int
        public let action: (() -> Void)?

        public var id: Int { phase.rawValue }

        public init(phase: OSPhase, label: String, count: Int, action: (() -> Void)? = nil) {
            self.phase = phase
            self.label = label
            self.count = count
            self.action = action
        }
    }

    let items: [Item]
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    public init(items: [Item]) {
        self.items = items
    }

    public var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(items) { cell($0) }
            }
        } else {
            HStack(spacing: 10) {
                ForEach(items) { cell($0) }
            }
        }
    }

    @ViewBuilder
    private func cell(_ item: Item) -> some View {
        if let action = item.action, item.count > 0 {
            Button(action: action) { face(item) }
                .buttonStyle(.plain)
        } else {
            face(item)
        }
    }

    private func face(_ item: Item) -> some View {
        let lit = item.count > 0
        let tint = item.phase.color
        return VStack(spacing: 4) {
            Image(systemName: item.phase.symbol)
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(lit ? tint : Color.secondary.opacity(0.5))
                .symbolEffect(.rotate, options: .repeat(.continuous), isActive: lit && item.phase == .working)
            Text("\(item.count)")
                .font(.system(size: 30, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(lit ? tint : Color.secondary.opacity(0.5))
            Text(item.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(lit ? tint.opacity(0.12) : Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(lit ? tint.opacity(0.45) : Color.clear))
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.label)
        .accessibilityValue("\(item.count)")
    }
}

/// Un anneau qui se remplit de 0 à 1 ; son centre porte un symbole ou un nombre.
public struct OSRing<Center: View>: View {
    let fraction: Double
    let tint: Color
    let size: CGFloat
    let center: Center

    public init(fraction: Double, tint: Color, size: CGFloat = 30, @ViewBuilder center: () -> Center) {
        self.fraction = fraction
        self.tint = tint
        self.size = size
        self.center = center()
    }

    public var body: some View {
        ZStack {
            Circle().stroke(tint.opacity(0.18), lineWidth: size / 7)
            Circle()
                .trim(from: 0, to: max(0.001, min(1, fraction)))
                .stroke(tint, style: StrokeStyle(lineWidth: size / 7, lineCap: .round))
                .rotationEffect(.degrees(-90))
            center
        }
        .frame(width: size, height: size)
    }
}

/// Une barre de grandeur : la part de la longueur qui est pleine.
struct OSBar: View {
    let fill: Double
    let tint: Color
    var width: CGFloat = 56

    var body: some View {
        Capsule()
            .fill(tint.opacity(0.18))
            .frame(width: width, height: 5)
            .overlay(alignment: .leading) {
                Capsule().fill(tint).frame(width: width * max(0, min(1, fill)), height: 5)
            }
    }
}

/// Un niveau en trois barres montantes (risque faible, moyen, élevé).
struct OSLevelBars: View {
    let level: Int
    let tint: Color

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1...3, id: \.self) { index in
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(index <= level ? tint : tint.opacity(0.2))
                    .frame(width: 5, height: CGFloat(5 + index * 4))
            }
        }
    }
}

/// Le temps qu'il reste avant qu'une réponse s'applique seule : un anneau qui se vide, et la durée.
/// Le serveur ne donne que l'échéance : l'anneau part de ce qu'il restait quand il est apparu.
struct OSCountdown: View {
    let seconds: Double
    let tint: Color
    @State private var total: Double = 0

    var body: some View {
        HStack(spacing: 6) {
            OSRing(fraction: OSGlyph.remaining(seconds, of: max(total, seconds)), tint: tint, size: 18) { EmptyView() }
            Text(seconds < 1 ? "0 s" : PipelineServerText.duration(seconds))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
        }
        .onAppear { total = max(total, seconds) }
    }
}

/// Une mesure de preuve : un symbole, un nombre, et au besoin une forme dessous (anneau, barre,
/// niveau). Le mot est dans l'infobulle et pour VoiceOver.
struct OSMetric<Shape: View>: View {
    let symbol: String
    let value: String?
    let tint: Color
    let label: String
    @ViewBuilder var shape: Shape

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 3) {
                if let value {
                    Text(value)
                        .font(.callout.weight(.semibold).monospacedDigit())
                }
                shape
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(tint.opacity(0.1)))
        .help(label)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(value ?? "")
    }
}
