// L'appairage par QR code côté Mac : la mémoire que la feuille joint au ticket (celle d'un serveur,
// jamais l'agent local) et le dessin du QR code (noir sur blanc, bords nets, relisible).

import CoreImage
import Foundation
import Testing

@testable import ConsoleClient
@testable import ConsoleUI
@testable import OMPConsole

/// Un HOME jetable, avec ou sans `.omp/mem0.json`.
private func home(settings: [String: Any]?) throws -> String {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pair-memory-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent(".omp"), withIntermediateDirectories: true)
    if let settings {
        try JSONSerialization.data(withJSONObject: settings).write(to: dir.appendingPathComponent(".omp/mem0.json"))
    }
    return dir.path
}

@Suite("Appairer un iPhone — Mac")
struct PairDeviceTests {
    @Test("la mémoire jointe au ticket est celle d'un serveur (~/.omp/mem0.json) avec son jeton ; la mémoire de ce Mac n'est jamais jointe")
    func memoryAttached() throws {
        let remote = try home(settings: ["url": "https://vps.tailnet.ts.net:8443", "token": "memoire"])
        let attached = PairMemory.current(environment: ["HOME": remote])
        #expect(attached == HarnessPairMemory(url: "https://vps.tailnet.ts.net:8443", token: "memoire"))

        let local = try home(settings: ["url": "http://localhost:8321", "token": "x"])
        #expect(PairMemory.current(environment: ["HOME": local]) == nil, "un iPhone n'atteint pas le localhost du Mac")
        #expect(PairMemory.current(environment: ["HOME": try home(settings: nil)]) == nil, "sans fichier : l'agent de l'app")

        // L'environnement prime sur le fichier, et son jeton n'est pas celui du fichier.
        let env = PairMemory.current(environment: ["HOME": remote, "MEM0_HTTP_URL": "https://autre.example", "MEM0_HTTP_TOKEN": "autre"])
        #expect(env == HarnessPairMemory(url: "https://autre.example", token: "autre"))
    }

    @Test("une mémoire que le serveur refuserait (jeton blanc ou trop long, adresse non http) n'est pas jointe : le ticket s'afficherait")
    func memoryRefusedByServer() throws {
        let spaced = try home(settings: ["url": "https://vps.example", "token": "a b"])
        #expect(PairMemory.current(environment: ["HOME": spaced]) == nil)
        let long = try home(settings: ["url": "https://vps.example", "token": String(repeating: "a", count: 513)])
        #expect(PairMemory.current(environment: ["HOME": long]) == nil)
        let ssh = try home(settings: ["url": "ssh://vps.example", "token": "x"])
        #expect(PairMemory.current(environment: ["HOME": ssh]) == nil)
    }

    @Test("le QR code est un CGImage net, noir sur blanc quel que soit le mode, avec une zone de silence, et se relit comme le lien")
    func qrCode() throws {
        let link = try #require(HarnessPairLink(address: "https://vps.tailnet.ts.net", ticket: "tk-secret_1"))
        let text = link.url.absoluteString
        let image = try #require(PairQRCode.image(for: text, moduleSize: 8))
        #expect(image.width == image.height)
        #expect(image.width % 8 == 0, "chaque module est un carré entier de pixels : aucun lissage")
        let modules = image.width / 8 - 8
        #expect(modules >= 21 && (modules - 21) % 4 == 0, "la taille d'un QR code : 21 + 4·n modules")

        // Les pixels : blanc (zone de silence) au coin, noir au premier module du motif de repérage.
        var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let context = try #require(CGContext(
            data: &pixels, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        func rgba(_ x: Int, _ y: Int) -> [UInt8] { Array(pixels[(y * image.width + x) * 4 ..< (y * image.width + x) * 4 + 4]) }
        #expect(rgba(0, 0) == [255, 255, 255, 255])
        #expect(rgba(image.width - 1, image.height - 1) == [255, 255, 255, 255])
        #expect(rgba(4 * 8 + 3, 4 * 8 + 3) == [0, 0, 0, 255], "le coin du motif de repérage est noir")
        let values = Set(stride(from: 0, to: pixels.count, by: 4).map { pixels[$0] })
        #expect(values == [0, 255], "deux valeurs seulement : noir et blanc")

        // Relu par le détecteur du système : le contenu du QR code est le lien.
        let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let found = detector.features(in: CIImage(cgImage: image)).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        #expect(found == [text])
    }
}
