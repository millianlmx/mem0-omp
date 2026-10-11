// Dessin de l'icône d'OMP Console (feature ios-identite-app, S-2, BR-1).
// Lancé par scripts/app-icon.sh :
//   xcrun swift scripts/app-icon/dessin.swift <dossier de sortie>
//
// Écrit dans <dossier de sortie> les trois variantes iOS, chacune un PNG CARRÉ
// 1024 × 1024 px, plein cadre, coins NON arrondis (le système applique le masque,
// HIG App icons), sans texte et sans alpha :
//   AppIcon.png         claire : dégradé #3D9BFF → #0058D6, motif #FFFFFF (sRGB, PNG type 2)
//   AppIcon-dark.png    sombre : dégradé #1B3354 → #070D18, motif #6CB4FF (sRGB, PNG type 2)
//   AppIcon-tinted.png  teintée : dégradé #2E2E2E → #0A0A0A, motif #FFFFFF (Gray Gamma 2.2, PNG type 0)
// Le motif, commun aux trois : un chevron « › » (300,332) → (500,512) → (300,692) et
// un trait « _ » (572,692) → (724,692), épaisseur 104 px, extrémités et jonctions
// arrondies. Coordonnées en pixels, origine en HAUT à gauche ; le dégradé est
// vertical, première couleur en y = 0.
//
// CoreGraphics + ImageIO seulement, aucune dépendance. Sortie 0 quand les trois
// fichiers sont écrits ; 1 sinon, avec un message `✗ …` sur stderr.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let side = 1024

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("✗ \(message)\n".utf8))
    exit(1)
}

/// Une couleur `#RRGGBB` en composantes 0…1.
struct RGB {
    let red: CGFloat
    let green: CGFloat
    let blue: CGFloat

    init(_ hex: UInt32) {
        red = CGFloat((hex >> 16) & 0xFF) / 255
        green = CGFloat((hex >> 8) & 0xFF) / 255
        blue = CGFloat(hex & 0xFF) / 255
    }
}

/// Le chevron et le trait, dans le repère à origine en haut à gauche.
func motif() -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 300, y: 332))
    path.addLine(to: CGPoint(x: 500, y: 512))
    path.addLine(to: CGPoint(x: 300, y: 692))
    path.move(to: CGPoint(x: 572, y: 692))
    path.addLine(to: CGPoint(x: 724, y: 692))
    return path
}

/// Remplit le fond par le dégradé vertical puis trace le motif ; les composantes
/// sont exprimées dans `space`, l'espace du contexte.
func draw(
    in context: CGContext,
    space: CGColorSpace,
    top: [CGFloat],
    bottom: [CGFloat],
    stroke: [CGFloat]
) {
    // Origine en haut à gauche : CoreGraphics place la sienne en bas à gauche.
    context.translateBy(x: 0, y: CGFloat(side))
    context.scaleBy(x: 1, y: -1)

    guard let gradient = CGGradient(
        colorSpace: space,
        colorComponents: top + bottom,
        locations: [0, 1],
        count: 2
    ) else { fail("dégradé impossible à créer") }
    context.drawLinearGradient(
        gradient,
        start: CGPoint(x: 0, y: 0),
        end: CGPoint(x: 0, y: CGFloat(side)),
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    )

    guard let strokeColor = CGColor(colorSpace: space, components: stroke) else {
        fail("couleur du motif impossible à créer")
    }
    context.setShouldAntialias(true)
    context.setStrokeColor(strokeColor)
    context.setLineWidth(104)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.addPath(motif())
    context.strokePath()
}

func writePNG(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.png.identifier as CFString, 1, nil
    ) else { fail("PNG impossible à créer : \(url.path)") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        fail("PNG impossible à écrire : \(url.path)")
    }
}

/// Variante couleur : sRGB 8 bits, sans alpha (`noneSkipLast`).
func colorVariant(top: UInt32, bottom: UInt32, stroke: UInt32, to url: URL) {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { fail("espace sRGB indisponible") }
    guard let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
        space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { fail("contexte sRGB impossible à créer") }
    func rgba(_ hex: UInt32) -> [CGFloat] {
        let color = RGB(hex)
        return [color.red, color.green, color.blue, 1]
    }
    draw(in: context, space: space, top: rgba(top), bottom: rgba(bottom), stroke: rgba(stroke))
    guard let image = context.makeImage() else { fail("image sRGB impossible à produire") }
    writePNG(image, to: url)
}

/// Variante teintée : niveaux de gris Gray Gamma 2.2, 8 bits, sans alpha.
func grayVariant(top: UInt8, bottom: UInt8, stroke: UInt8, to url: URL) {
    guard let space = CGColorSpace(name: CGColorSpace.genericGrayGamma2_2) else {
        fail("espace Gray Gamma 2.2 indisponible")
    }
    guard let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
        space: space, bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { fail("contexte gris impossible à créer") }
    func gray(_ level: UInt8) -> [CGFloat] { [CGFloat(level) / 255, 1] }
    draw(in: context, space: space, top: gray(top), bottom: gray(bottom), stroke: gray(stroke))
    guard let image = context.makeImage() else { fail("image grise impossible à produire") }
    writePNG(image, to: url)
}

let arguments = CommandLine.arguments.dropFirst()
guard arguments.count == 1, let output = arguments.first else {
    fail("usage : dessin.swift <dossier de sortie>")
}
let folder = URL(fileURLWithPath: output, isDirectory: true)
do {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
} catch {
    fail("dossier de sortie impossible à créer : \(folder.path)")
}

colorVariant(top: 0x3D9BFF, bottom: 0x0058D6, stroke: 0xFFFFFF,
             to: folder.appendingPathComponent("AppIcon.png"))
colorVariant(top: 0x1B3354, bottom: 0x070D18, stroke: 0x6CB4FF,
             to: folder.appendingPathComponent("AppIcon-dark.png"))
grayVariant(top: 0x2E, bottom: 0x0A, stroke: 0xFF,
            to: folder.appendingPathComponent("AppIcon-tinted.png"))
