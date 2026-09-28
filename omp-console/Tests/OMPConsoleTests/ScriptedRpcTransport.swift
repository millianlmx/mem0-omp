// Transport scripté : le double qui permet de prouver S-2 à S-8 SANS lancer `omp`
// (BR-5 step 1).
//
// Il n'ouvre aucun process : le test décide quand la trame `ready` arrive, quand
// une réponse arrive (et dans quel ordre), quand un dialogue est émis et quand le
// process meurt. C'est ce qui rend déterministes des cas réels impossibles à
// déclencher à la demande — réponse inversée (AC-3), expiration (AC-13), mort
// subie (AC-10), escalade SIGTERM/SIGKILL (AC-15).

import Foundation
@testable import OMPConsole

@MainActor
final class ScriptedRpcTransport: RpcTransport {
    var onLine: ((String) -> Void)?
    var onLog: ((String) -> Void)?
    var onExit: ((ProcessExit) -> Void)?

    /// Toutes les lignes écrites par le host, dans l'ordre — c'est la matière
    /// première des assertions « rien n'est écrit ».
    private(set) var written: [String] = []
    private(set) var closeStdinCount = 0
    private(set) var signals: [Int32] = []
    private(set) var startCount = 0
    private(set) var startedWith: (binary: URL, arguments: [String], cwd: URL)?

    var isRunning = true

    /// `nil` tant qu'aucun lancement n'a eu lieu : `pid == nil` prouve « aucun
    /// process n'a été lancé » (AC-14), ce qu'un pid factice constant ne
    /// prouverait pas.
    var pid: Int32? { isRunning && startedWith != nil ? 4_242 : nil }

    /// Réponse automatique à chaque écriture, appelée APRÈS l'enregistrement de la
    /// ligne. Elle permet de répondre PENDANT l'écriture, donc de prouver qu'une
    /// réponse qui devance le garde-fou de délai n'est pas perdue (S-3).
    var onWrite: ((String) -> Void)?

    /// Trame `ready` livrée pendant `start` : la poignée de main est ainsi délivrée
    /// dans le même tour que le lancement, sans course avec le test.
    var readyLine: String?

    /// Appelé par `closeStdin` : permet de simuler un process qui rend la main à
    /// la fermeture de stdin (`onExit` synchrone) ou qui l'ignore (pas d'appel).
    var onCloseStdin: (() -> Void)?

    func start(binary: URL, arguments: [String], cwd: URL) throws {
        startCount += 1
        startedWith = (binary, arguments, cwd)
        isRunning = true
        if let readyLine { onLine?(readyLine) }
    }

    func write(_ line: String) throws {
        guard isRunning else { throw TransportFailure.notRunning }
        written.append(line)
        onWrite?(line)
    }

    func closeStdin() {
        closeStdinCount += 1
        onCloseStdin?()
    }

    /// N'arrête PAS le process : un `SIGTERM`/`SIGKILL` qui suffirait à faire
    /// tomber `isRunning` masquerait l'escalade qu'on veut prouver.
    func signal(_ number: Int32) {
        signals.append(number)
    }

    // MARK: - Pilotage depuis le test

    func emit(_ line: String) { onLine?(line) }
    func emitLog(_ line: String) { onLog?(line) }

    func emitExit(_ exit: ProcessExit) {
        isRunning = false
        onExit?(exit)
    }

    /// Lignes écrites hors poignée de main : ce que le host a émis en réaction à
    /// une commande, à un dialogue ou à un arrêt.
    var writtenCommands: [String] {
        written.filter { !$0.contains("\"negotiate_protocol\"") && !$0.contains("\"get_state\"") }
    }
}
