// La CARTE d'une question (session en graphe), partagée par le Mac et l'iPhone/iPad, en
// trois couches de la plus courte à la plus visuelle :
// 1. l'explication synthétique (`DecisionCardSummary`) : la question, l'enjeu, une ligne
//    par option — sa conséquence, réversible ou non, son coût, la recommandée marquée ;
// 2. le schéma de bifurcation (`BifurcationSchemaView`) dessiné nativement : établi →
//    ambiguïté → options → impacts, la fourche tracée par une `Shape` ; les options s'y
//    choisissent d'un geste quand la carte attend une réponse ;
// 3. la carte d'exploration (`CardExplorationView`, SessionGraphViews.swift), puis les
//    « Détails » repliés (`CardDetailsView`) : le contexte technique et la raison de l'agent.
// Le briefing des specs et des arbitrages (`BriefingView`) met les mêmes cartes en tête.
// Aucun mot en dur : tout vient de `SessionGraphText` et `PipelineServerText`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'explication synthétique : la question, l'enjeu, une ligne par option.
public struct DecisionCardSummary: View {
    let card: HarnessCard

    public init(card: HarnessCard) {
        self.card = card
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(card.headline)
                .font(.headline)
                .consoleReadable()
            Text(SessionGraphText.stake(card.stake))
                .font(.callout)
                .foregroundStyle(.secondary)
                .consoleReadable()
            VStack(alignment: .leading, spacing: 4) {
                ForEach(card.options) { option in
                    DecisionOptionLine(option: option, recommended: card.isRecommended(option))
                }
            }
            if !card.reviewed {
                Text(SessionGraphText.notReviewed)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .consoleID("card.summary")
    }
}

/// Une option en une ligne : son libellé et sa conséquence, puis réversible ou non, son coût, la recommandée.
struct DecisionOptionLine: View {
    let option: HarnessCardOption
    let recommended: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(line)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Label(
                    option.reversible ? SessionGraphText.reversible : SessionGraphText.irreversible,
                    systemImage: option.reversible ? SessionGraphText.reversibleSymbol : SessionGraphText.irreversibleSymbol
                )
                .foregroundStyle(option.reversible ? Color.secondary : Color.orange)
                if let cost = option.cost {
                    Text(SessionGraphText.cost(cost))
                        .foregroundStyle(.secondary)
                }
                if recommended {
                    RecommendedBadge()
                }
            }
            .font(.caption)
        }
        .accessibilityElement(children: .combine)
    }

    /// Le libellé en gras, puis sa conséquence.
    private var line: AttributedString {
        var label = AttributedString(option.label)
        label.inlinePresentationIntent = .stronglyEmphasized
        return label + AttributedString(" — " + option.impact)
    }
}

/// La marque verte de l'option recommandée.
struct RecommendedBadge: View {
    var body: some View {
        Text(PipelineServerText.recommendedBadge)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.green)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Color.green.opacity(0.12), in: .capsule)
    }
}

// MARK: - Schéma de bifurcation

/// Le schéma de compréhension dessiné nativement : ce qui est établi, le point
/// d'ambiguïté, puis une branche par option avec son impact. `choose` donné : chaque
/// option se choisit (la réponse de l'escalade) ; `selected` la marque.
public struct BifurcationSchemaView: View {
    let schema: HarnessCardSchema
    var selected: String?
    var choose: (@MainActor (String) -> Void)?

    public init(schema: HarnessCardSchema, selected: String? = nil, choose: (@MainActor (String) -> Void)? = nil) {
        self.schema = schema
        self.selected = selected
        self.choose = choose
    }

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif

    /// Trop de branches pour une rangée sur un écran étroit : elles s'empilent.
    private var stacks: Bool {
        #if os(iOS)
        sizeClass == .compact && schema.branches.count > 2
        #else
        false
        #endif
    }

    public var body: some View {
        let branches = schema.branches
        VStack(alignment: .leading, spacing: 6) {
            Label(SessionGraphText.schemaTitle, systemImage: SessionGraphText.schemaSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            VStack(spacing: 0) {
                if let established = schema.established {
                    SchemaBox(caption: SessionGraphText.established, label: established.label, tone: .neutral)
                    SchemaStem()
                }
                if let ambiguity = schema.ambiguity {
                    SchemaBox(caption: SessionGraphText.ambiguity, label: ambiguity.label, tone: .attention)
                }
                if stacks {
                    VStack(spacing: 8) {
                        ForEach(branches) { branch in
                            VStack(spacing: 0) {
                                SchemaStem()
                                HStack(alignment: .top, spacing: 6) {
                                    option(branch.option)
                                    if let impact = branch.impact {
                                        Image(systemName: SessionGraphText.arrowSymbol)
                                            .foregroundStyle(.secondary)
                                            .padding(.top, 14)
                                            .accessibilityHidden(true)
                                        SchemaBox(caption: nil, label: impact.label, tone: .quiet)
                                    }
                                }
                            }
                        }
                    }
                } else if !branches.isEmpty {
                    SchemaFork(branches: branches.count)
                        .stroke(Color.secondary.opacity(0.6), lineWidth: 1.2)
                        .frame(height: 22)
                        .accessibilityHidden(true)
                    HStack(alignment: .top, spacing: SchemaFork.spacing) {
                        ForEach(branches) { branch in
                            VStack(spacing: 0) {
                                option(branch.option)
                                if let impact = branch.impact {
                                    SchemaStem()
                                    SchemaBox(caption: nil, label: impact.label, tone: .quiet)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .top)
                        }
                    }
                }
            }
        }
        .consoleID("card.schema")
    }

    @ViewBuilder
    private func option(_ node: HarnessSchemaNode) -> some View {
        let box = SchemaBox(
            caption: nil, label: node.label, tone: node.recommended ? .recommended : .option,
            selected: selected == node.label, badge: node.recommended
        )
        if let choose {
            Button { choose(node.label) } label: { box }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected == node.label ? .isSelected : [])
                .accessibilityHint(SessionGraphText.chooseHint)
                .consoleID("card.schema.option")
        } else {
            box
        }
    }
}

/// La couleur d'un nœud du schéma.
enum SchemaTone {
    case neutral, attention, option, recommended, quiet
}

/// Un nœud du schéma : une boîte arrondie, son intitulé éventuel et son texte.
struct SchemaBox: View {
    let caption: String?
    let label: String
    let tone: SchemaTone
    var selected = false
    var badge = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let caption {
                Text(caption)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(tone == .attention ? Color.orange : Color.secondary)
            }
            Text(label)
                .font(tone == .quiet ? .caption : .callout)
                .foregroundStyle(tone == .quiet ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
            if badge {
                RecommendedBadge()
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: tone == .option || tone == .recommended ? ConsolePlatform.minimumTarget : 0, alignment: .leading)
        .background(fill, in: .rect(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(stroke, lineWidth: selected ? 2 : 1)
        }
        .contentShape(.rect)
    }

    private var fill: Color {
        switch tone {
        case .attention: .orange.opacity(0.12)
        case .recommended: .green.opacity(0.08)
        case .option: .accentColor.opacity(0.06)
        case .neutral, .quiet: .secondary.opacity(0.08)
        }
    }

    private var stroke: Color {
        if selected { return .accentColor }
        switch tone {
        case .attention: return .orange
        case .recommended: return .green
        case .option: return .accentColor.opacity(0.5)
        case .neutral, .quiet: return .secondary.opacity(0.3)
        }
    }
}

/// Le trait vertical qui relie deux nœuds.
struct SchemaStem: View {
    var body: some View {
        Rectangle()
            .fill(Color.secondary.opacity(0.6))
            .frame(width: 1.2, height: 14)
            .accessibilityHidden(true)
    }
}

/// La fourche de l'ambiguïté vers ses options : un trait descend du milieu, se partage à
/// l'horizontale, et redescend au milieu de chaque colonne (colonnes égales, `spacing` entre elles).
struct SchemaFork: Shape {
    static let spacing: CGFloat = 8
    let branches: Int

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard branches > 0 else { return path }
        let count = CGFloat(branches)
        let column = (rect.width - Self.spacing * (count - 1)) / count
        let centers = (0..<branches).map { rect.minX + CGFloat($0) * (column + Self.spacing) + column / 2 }
        let middle = rect.midY
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: middle))
        if let first = centers.first, let last = centers.last {
            path.move(to: CGPoint(x: first, y: middle))
            path.addLine(to: CGPoint(x: last, y: middle))
        }
        for x in centers {
            path.move(to: CGPoint(x: x, y: middle))
            path.addLine(to: CGPoint(x: x, y: rect.maxY))
        }
        return path
    }
}

// MARK: - Détails

/// Le contexte technique et la raison de l'agent, repliés sous « Détails ».
public struct CardDetailsView: View {
    let context: String?
    let rationale: String?

    public init(context: String?, rationale: String?) {
        self.context = context
        self.rationale = rationale
    }

    public var body: some View {
        if context != nil || rationale != nil {
            DisclosureGroup(SessionGraphText.details) {
                VStack(alignment: .leading, spacing: 8) {
                    if let context {
                        QuestionContextView(context: context)
                    }
                    if let rationale {
                        QuestionReasonView(title: PipelineServerText.whyRecommended, text: rationale)
                    }
                }
                .padding(.top, 6)
            }
            .consoleID("card.details")
        }
    }
}

// MARK: - Briefing

/// La carte en tête des specs à valider et d'un arbitrage : ce que fait la feature, puis
/// chaque point qui demande un regard (sa synthèse et son schéma).
public struct BriefingView: View {
    let briefing: HarnessBriefing

    public init(briefing: HarnessBriefing) {
        self.briefing = briefing
    }

    public var body: some View {
        if !briefing.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                if !briefing.feature.isEmpty {
                    Text(SessionGraphText.feature(briefing.feature))
                        .font(.callout.weight(.semibold))
                        .consoleReadable()
                }
                if !briefing.cards.isEmpty {
                    Text(SessionGraphText.briefingPoints)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(Array(briefing.cards.enumerated()), id: \.offset) { _, card in
                        VStack(alignment: .leading, spacing: 10) {
                            DecisionCardSummary(card: card)
                            BifurcationSchemaView(schema: card.schema)
                        }
                        .padding(12)
                        .consoleCardSurface()
                    }
                }
            }
            .consoleID("card.briefing")
        }
    }
}
