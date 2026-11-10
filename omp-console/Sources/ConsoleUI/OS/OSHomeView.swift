// L'« OS agentique » : MAINTENANT, l'accueil, partagé par le Mac et l'iPhone/iPad. C'est
// le BRIEF du serveur : sa phrase de tête et depuis quand (« Vu » le marque lu), le
// composeur « Demander » et, dessous, la réponse de l'OS à une question d'état ; les
// trois chiffres de la boucle ; les agents au travail avec ce qu'ils font ; puis les
// sections du brief. Chaque ligne ouvre son fil. Un serveur sans brief garde l'accueil
// d'avant : cinq chiffres, les agents au travail, le livré du jour.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSHomeView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var brief: HarnessBriefModel
    @ObservedObject var intakes: HarnessIntakes
    let threads: [OSThread]
    let decisions: Int

    @State private var draft = ""
    @State private var sending = false
    /// Les chiffres des trois derniers jours : ce que les tuiles comparent à la semaine.
    @State private var recentScores: HarnessScoreboard?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// `decisions` : le nombre de décisions qui attendent (`OSDecisions.all`).
    public init(server: HarnessModel, pulse: OSPulse, workspace: OSWorkspace, threads: [OSThread], decisions: Int) {
        self.server = server
        self.pulse = pulse
        self.workspace = workspace
        _brief = ObservedObject(wrappedValue: server.brief)
        _intakes = ObservedObject(wrappedValue: server.intakes)
        self.threads = threads
        self.decisions = decisions
    }

    public var body: some View {
        let working = threads.filter { $0.phase == .working }
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                if brief.isServed {
                    asking
                    OSScoreTiles(server: server, recent: recentScores)
                    atWork(working)
                    if let current = brief.brief {
                        OSBriefSections(server: server, workspace: workspace, brief: current, threads: threads)
                    }
                } else {
                    legacyTiles(working: working.count)
                    atWork(working)
                    deliveredToday
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .osPagePadding(28)
            .frame(maxWidth: .infinity)
        }
        .task(id: server.address) {
            await brief.refresh()
            if brief.isServed {
                recentScores = await OSScoreTiles.load(server)
            } else {
                // Sans brief, l'accueil d'avant lit le rapport du matin.
                await server.refreshServices()
            }
        }
    }

    // MARK: En-tête

    /// « Maintenant », puis la phrase du brief et sa fenêtre ; sans brief, la date du jour.
    private var header: some View {
        // Aux tailles de texte d'accessibilité (iPhone, iPad), « Vu » passe sous la phrase.
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        return layout {
            VStack(alignment: .leading, spacing: 4) {
                // Sur l'iPhone et l'iPad, « Maintenant » est le titre de la barre.
                #if os(macOS)
                Text(OSText.now).font(.largeTitle.weight(.bold))
                #endif
                if let current = brief.brief {
                    Text(current.headline)
                        .font(.title3)
                        .osSelectable()
                    Text(OSWatchText.since(ms: current.since, nowMs: max(current.until, Date().timeIntervalSince1970 * 1000)))
                        .foregroundStyle(.secondary)
                } else {
                    Text(Date().formatted(Date.FormatStyle(date: .complete, time: .omitted).locale(ConsoleFormat.locale)))
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            if let current = brief.brief {
                // Déjà vu jusqu'ici : le prochain brief repartira de ce moment.
                let seen = (current.seenAt ?? 0) >= current.until
                Button(OSWatchText.seen, systemImage: seen ? "checkmark.circle.fill" : "checkmark.circle") {
                    Task { await brief.markSeen() }
                }
                .disabled(seen)
                .osRowButton()
            }
        }
    }

    // MARK: Demander, et la réponse de l'OS

    /// Le composeur, et sous lui les Demandes que l'OS classe encore ou auxquelles il a
    /// répondu tout de suite (une question d'état) : sa réponse, en bulle, jusqu'à « OK ».
    private var asking: some View {
        VStack(alignment: .leading, spacing: 8) {
            OSAskComposer(intakes: intakes, draft: $draft, sending: $sending, focusShortcut: false)
            ForEach(intakes.open.filter { $0.isClassifying || $0.isSettled }) { intake in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "sparkles")
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(intake.text)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        if intake.isClassifying {
                            ProgressView().controlSize(.small)
                        } else if let answer = intake.answer, !answer.isEmpty {
                            ConsoleMarkdown(markdown: answer)
                        } else if let reason = intake.reason {
                            Text(reason).foregroundStyle(.red)
                        }
                    }
                    Spacer(minLength: 0)
                    if intake.isSettled {
                        Button(OSText.done) { Task { _ = try? await intakes.cancel(intake) } }
                            .osBorderless()
                            .disabled(intakes.busy.contains(intake.id))
                    }
                }
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.accentColor.opacity(0.08)))
            }
        }
    }

    // MARK: Les agents au travail

    /// Une ligne par texte dans la colonne du Mac, deux sur l'iPhone et l'iPad.
    #if os(macOS)
    private static let rowLines = 1
    #else
    private static let rowLines = 2
    #endif

    private func atWork(_ working: [OSThread]) -> some View {
        section(OSText.atWork) {
            if working.isEmpty {
                Text(OSText.calm).foregroundStyle(.secondary)
            }
            TimelineView(.periodic(from: .now, by: 5)) { context in
                VStack(spacing: 8) {
                    ForEach(working) { thread in
                        workingRow(thread, now: context.date)
                    }
                }
            }
        }
    }

    private func workingRow(_ thread: OSThread, now: Date) -> some View {
        let run = thread.runs.last { $0.phase == .running || $0.phase == .merging || $0.phase == .queued } ?? thread.focusRun
        let line = thread.osActivity(pulse, now: now) ?? run?.osState ?? ""
        return Button {
            workspace.open(thread.id)
        } label: {
            OSCard(tint: .accentColor, emphasized: true) {
                HStack(spacing: 10) {
                    if thread.isLocalSession {
                        Image(systemName: "laptopcomputer")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 22, height: 22)
                    } else {
                        OSPhaseMark(phase: .working, size: 16)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(thread.title).font(.headline).lineLimit(Self.rowLines).multilineTextAlignment(.leading)
                        Text("↳ " + line).foregroundStyle(.secondary).lineLimit(Self.rowLines)
                    }
                    Spacer()
                    if let run { OSStepDots(run: run) }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Sans brief : l'accueil d'avant

    /// Cinq tuiles : en ligne sur le Mac, en grille sur l'iPhone et l'iPad.
    @ViewBuilder
    private func legacyTiles(working: Int) -> some View {
        #if os(macOS)
        HStack(spacing: 10) { legacyTileItems(working: working) }
        #else
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 10)], spacing: 10) { legacyTileItems(working: working) }
        #endif
    }

    @ViewBuilder
    private func legacyTileItems(working: Int) -> some View {
        tile(decisions, OSText.yours, tint: decisions > 0 ? .orange : .secondary) { workspace.triage = decisions > 0 }
        tile(working, OSText.atWork, tint: .accentColor, action: nil)
        if let counts = server.digest?.counts {
            tile(counts.merged, OSText.mergedTile, tint: .green, action: nil)
            tile(counts.decisions, OSText.aloneTile, tint: .purple, action: nil)
            tile(counts.failed, OSText.failedTile, tint: counts.failed > 0 ? .red : .secondary, action: nil)
        }
    }

    @ViewBuilder
    private var deliveredToday: some View {
        let today = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        let delivered = threads.filter { $0.phase == .done && $0.updatedAt >= today }
        if !delivered.isEmpty {
            section(OSText.delivered) {
                ForEach(delivered) { thread in
                    Button {
                        workspace.open(thread.id)
                    } label: {
                        HStack(spacing: 8) {
                            OSPhaseMark(phase: .done, size: 12)
                            Text(thread.title).lineLimit(1)
                            Spacer()
                            Text(ConsoleFormat.time(ms: thread.updatedAt))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .frame(minHeight: ConsolePlatform.minimumTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func tile(_ value: Int, _ label: String, tint: Color, action: (() -> Void)?) -> some View {
        Button {
            action?()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(value)")
                    .font(.system(size: 30, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(value > 0 ? tint : .secondary)
                Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
        }
        .buttonStyle(.plain)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            content()
        }
    }
}
