// PROTOTYPE « OS agentique » (branche proto/os-fils) : les AUTOMATISMES, tout ce que l'OS
// lance seul, sur une page : les planifications (features, audits, relève d'issues, routines
// du poste à heure fixe), les routines du poste, le service 24/24 du poste, Jira et
// Confluence (plan du jour, savoir de la boîte) et la vigie. Chaque ligne dit où ça tourne,
// quand, ce que ça a donné la dernière fois, et se lance tout de suite.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSAutomationsView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var schedules: HarnessSchedules
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var atlassian: AtlassianModel
    @ObservedObject var vigie: HarnessVigie

    init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
        _schedules = ObservedObject(wrappedValue: server.schedules)
        _workstation = ObservedObject(wrappedValue: server.workstation)
        _atlassian = ObservedObject(wrappedValue: server.atlassian)
        _vigie = ObservedObject(wrappedValue: server.vigie)
    }

    var body: some View {
        Form {
            Section {
                if schedules.schedules.isEmpty {
                    Text(OSText.noSchedule).foregroundStyle(.secondary)
                }
                ForEach(schedules.schedules) { schedule in
                    row(
                        symbol: "calendar.badge.clock",
                        title: schedule.name,
                        place: OSText.target(schedule.target),
                        when: [schedule.cron, schedule.nextRunAt.map { OSText.next($0.osDate) }].compactMap { $0 }.joined(separator: " · "),
                        last: schedule.lastOutcome.map { $0.status + " · " + OSText.last($0.at.osDate) },
                        enabled: Binding(get: { schedule.enabled }, set: { on in Task { await schedules.setEnabled(schedule, on) } })
                    ) {
                        Task { await schedules.runNow(schedule) }
                    }
                }
            } header: {
                HStack {
                    Text(OSText.scheduled)
                    Spacer()
                    Button(OSText.newSchedule) { drafts.scheduleSheetShown = true }
                        .buttonStyle(.borderless)
                }
            }

            if workstation.availability == .available {
                Section(OSText.posteRoutines) {
                    if let status = workstation.status {
                        row(
                            symbol: "infinity",
                            title: OSText.posteService,
                            place: OSText.autonomy(status.autonomy.effective) + " · " + (status.online ? OSText.yourChrome : OSText.offline),
                            when: status.nextShiftAt.map { OSText.next($0.osDate) } ?? "",
                            last: status.lastShift.map { $0.outcome + " · \($0.actions) actions · " + OSText.last($0.at.osDate) },
                            enabled: nil,
                            run: nil
                        )
                    }
                    let routines = workstation.automations ?? []
                    if routines.isEmpty {
                        Text(OSText.noRoutine).foregroundStyle(.secondary)
                    }
                    ForEach(routines) { routine in
                        row(
                            symbol: "repeat",
                            title: routine.title,
                            place: browserName(routine.browserId),
                            when: routine.schedule ?? routine.frequency,
                            last: nil,
                            enabled: nil
                        ) {
                            Task { await workstation.launchAutomation(routine) }
                        }
                    }
                }
            }

            Section(OSText.atlassian) {
                switch atlassian.availability {
                case .available:
                    AtlassianSections(server: server, atlassian: atlassian)
                case .absent:
                    Label(OSText.absentHere, systemImage: "icloud.slash").foregroundStyle(.secondary)
                case .reserved, .unknown:
                    ProgressView()
                }
            }

            if let view = vigie.view {
                Section(OSText.watch) {
                    row(
                        symbol: "binoculars",
                        title: OSText.vigieMode(view.settings.mode),
                        place: view.settings.repos.isEmpty ? OSText.vps : view.settings.repos.joined(separator: ", "),
                        when: view.heartbeat.map { OSText.last($0.at.osDate) } ?? "",
                        last: OSText.incidents(view.incidents["new"] ?? 0),
                        enabled: nil,
                        run: nil
                    )
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(OSText.automations)
        .task {
            await schedules.refresh()
            await workstation.load()
            await atlassian.refresh()
            await vigie.load()
        }
    }

    private func browserName(_ id: String?) -> String {
        let browsers = workstation.status?.browsers ?? []
        let browser = browsers.first { $0.id == id } ?? browsers.first { $0.isDefault }
        guard let browser else { return OSText.poste }
        return (browser.id == WorkstationBrowser.serverID ? OSText.vpsBrowser : OSText.yourChrome) + " · " + browser.name
    }

    private func row(
        symbol: String, title: String, place: String, when: String, last: String?,
        enabled: Binding<Bool>?, run: (() -> Void)?
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(Color.accentColor)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).fontWeight(.semibold).lineLimit(1)
                HStack(spacing: 6) {
                    OSTag(text: place, symbol: "mappin.and.ellipse")
                    if !when.isEmpty { OSTag(text: when, symbol: "clock") }
                }
                if let last, !last.isEmpty {
                    Text(last).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let enabled {
                Toggle("", isOn: enabled).labelsHidden().toggleStyle(.switch).controlSize(.small)
            }
            if let run {
                Button(OSText.runNow, systemImage: "play.fill", action: run)
                    .disabled(!server.canAct)
            }
        }
        .padding(.vertical, 2)
    }
}
