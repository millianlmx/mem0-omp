// Les sections d'EXPLOITATION de la coque Mac — Vigie, Planifications, Issues et
// Administration : le cadre des sections du serveur (`HarnessSection`, formulaire
// groupé) autour du contenu PARTAGÉ avec l'app iOS (cible ConsoleUI). Les confirmations
// des gestes destructifs sont posées par `controlGestures`.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct HarnessVigieView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, reload: { await server.vigie.load() }) {
            VigieSections(server: server, drafts: drafts)
        }
        .task { await server.vigie.load() }
        .accessibilityIdentifier("vigie.harness")
    }
}

struct HarnessSchedulesView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, reload: { await server.schedules.refresh() }) {
            SchedulesSections(server: server, drafts: drafts)
        }
        .task { await server.schedules.refresh() }
        .controlGestures(server: server, drafts: drafts)
        .accessibilityIdentifier("schedules.harness")
    }
}

struct HarnessIssuesView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, reload: {
            await server.issues.refresh(repo: drafts.issuesRepo(in: server.repos))
        }) {
            IssuesSections(server: server, drafts: drafts)
        }
        .accessibilityIdentifier("issues.harness")
    }
}

struct HarnessAdminView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, reload: { await server.admin.refresh() }) {
            AdminSections(server: server, drafts: drafts)
        }
        .task(id: server.isAdmin) { await server.admin.refresh() }
        .controlGestures(server: server, drafts: drafts)
        .accessibilityIdentifier("admin.harness")
    }
}
