// Mesure image par image d'une vidéo de lancement (feature ios-identite-app, S-6),
// compilée par scripts/recette/ios-identite-recette.sh :
//
//   swiftc -O scripts/recette/ios-identite-recette/images.swift -o <build>/images
//   <build>/images <video.mp4>
//
// Pour chaque image au pas de 1/30 s (AVAssetImageGenerator, tolérances nulles),
// une marge de 4 % est retirée sur chaque bord, puis l'image est réduite à
// 32 × 32 px sRGB ; sortie, une ligne par image :
//   index<TAB>R<TAB>G<TAB>B<TAB>u
// où (R, G, B) est la médiane par canal des 1 024 échantillons et u la part des
// échantillons à ±3 de cette médiane sur chaque canal (0 à 1, trois décimales).
// La marge écarte le chrome du système, qui n'est pas l'écran de lancement : barre
// d'état, indicateur d'accueil, coins arrondis et liseré noir de la fenêtre iPad
// (MESURÉ le 2026-10-11, iPad Pro 13 pouces iOS 27.0 en clair : sans marge, le
// liseré occupe le pourtour des 32 × 32 et plafonne u à 0,904 ; aucune image
// uniforme).
//
// Codes de sortie : 0 mesure écrite ; 1 vidéo illisible ou sans image ; 2 usage.
import AVFoundation
import CoreGraphics
import Foundation

let side = 32
let margin = 0.04
let step = CMTime(value: 1, timescale: 30)

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("✗ \(message)\n".utf8))
    exit(code)
}

func median(_ values: [UInt8]) -> Int {
    let sorted = values.sorted()
    return Int(sorted[sorted.count / 2])
}

/// Médiane par canal et part uniforme d'une image réduite à 32 × 32.
func measure(_ image: CGImage) -> (r: Int, g: Int, b: Int, u: Double)? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
            data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
            space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { return nil }
    context.interpolationQuality = .medium
    let dx = Int(Double(image.width) * margin), dy = Int(Double(image.height) * margin)
    let core = image.cropping(
        to: CGRect(x: dx, y: dy, width: image.width - 2 * dx, height: image.height - 2 * dy)) ?? image
    context.draw(core, in: CGRect(x: 0, y: 0, width: side, height: side))
    guard let data = context.data else { return nil }
    let bytes = data.bindMemory(to: UInt8.self, capacity: side * side * 4)
    var reds: [UInt8] = [], greens: [UInt8] = [], blues: [UInt8] = []
    reds.reserveCapacity(side * side)
    greens.reserveCapacity(side * side)
    blues.reserveCapacity(side * side)
    for index in 0..<(side * side) {
        reds.append(bytes[index * 4])
        greens.append(bytes[index * 4 + 1])
        blues.append(bytes[index * 4 + 2])
    }
    let r = median(reds), g = median(greens), b = median(blues)
    var near = 0
    for index in 0..<(side * side)
    where abs(Int(reds[index]) - r) <= 3 && abs(Int(greens[index]) - g) <= 3 && abs(Int(blues[index]) - b) <= 3 {
        near += 1
    }
    return (r, g, b, Double(near) / Double(side * side))
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else { fail("usage : images <video.mp4>", code: 2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: arguments[1]))
let duration: CMTime
do {
    duration = try await asset.load(.duration)
} catch {
    fail("vidéo illisible : \(arguments[1]) (\(error.localizedDescription))", code: 1)
}
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

var index = 0
var time = CMTime.zero
var written = 0
while CMTimeCompare(time, duration) < 0 {
    if let image = try? await generator.image(at: time).image, let m = measure(image) {
        print("\(index)\t\(m.r)\t\(m.g)\t\(m.b)\t\(String(format: "%.3f", m.u))")
        written += 1
    }
    index += 1
    time = CMTimeAdd(time, step)
}
if written == 0 { fail("aucune image lue dans \(arguments[1])", code: 1) }
