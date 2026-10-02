// Preuve de S-2 (omp-console-redesign, AC-3) : la version minimale de macOS vaut 26,
// dans la plist du bundle ET dans le binaire compilé.
//
// La plist est lue à sa source (`omp-console/Bundle/Info.plist`, recopiée telle
// quelle dans le bundle par scripts/swift-app.sh). Le binaire est l'image de CE
// test : elle contient le module `OMPConsole`, compilé avec la cible de
// déploiement du paquet, donc sa commande `LC_BUILD_VERSION` porte la même
// version minimale que l'exécutable de l'app.

import Foundation
import Testing

@Test("omp-console-redesign/AC-3 : le bundle et le binaire exigent macOS 26")
func bundleAndBinaryRequireMacOS26() throws {
    let plistURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("../../Bundle/Info.plist")
        .standardizedFileURL
    let data = try Data(contentsOf: plistURL)
    let plist = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    #expect(plist?["LSMinimumSystemVersion"] as? String == "26.0")

    var info = Dl_info()
    guard dladdr(#dsohandle, &info) != 0, let imagePath = info.dli_fname else {
        Issue.record("dladdr n'a pas rendu le chemin de l'image de test")
        return
    }
    let otool = Process()
    otool.executableURL = URL(fileURLWithPath: "/usr/bin/otool")
    otool.arguments = ["-l", String(cString: imagePath)]
    let output = Pipe()
    otool.standardOutput = output
    otool.standardError = FileHandle.nullDevice
    try otool.run()
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    otool.waitUntilExit()
    #expect(otool.terminationStatus == 0)

    // La ligne `minos` qui compte est celle de la commande LC_BUILD_VERSION.
    let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let start = lines.firstIndex(of: "cmd LC_BUILD_VERSION") else {
        Issue.record("aucune commande LC_BUILD_VERSION dans \(String(cString: imagePath))")
        return
    }
    let minos = lines[start...].first { $0.hasPrefix("minos ") }
    #expect(minos == "minos 26.0")
}
