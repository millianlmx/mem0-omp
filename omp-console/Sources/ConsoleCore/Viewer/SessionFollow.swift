// La politique de collage au bas d'un fil et l'état de lecture d'une session,
// PARTAGÉS par les deux coques (S-8 de `ios-sessions`).
//
// Ces déclarations ont DÉMÉNAGÉ de
// `Sources/OMPConsole/Viewer/SessionViewerModel.swift`, dont il ne reste que le
// modèle macOS : `FollowPolicy` décide du suivi à partir de deux entrées — le
// geste de l'utilisateur et la géométrie mesurée — et ne dépend donc d'aucune vue.
//
// `ScrollGeometry` du dépôt est RENOMMÉ `ViewerScrollGeometry` : sous ce nom, il
// heurterait `SwiftUI.ScrollGeometry` dans les vues qui importent SwiftUI (l'app
// iOS l'importe partout).

import CoreGraphics

/// Point d'ancrage du bas de fil (S-2) : c'est la distance sous laquelle la vue
/// est considérée « au direct ». Quelques points absorbent l'arrondi du layout,
/// jamais une ligne.
public let viewerBottomSlackPoints: CGFloat = 8

/// Nombre de fois où un défilement DEMANDÉ est redemandé quand il n'est pas arrivé
/// au bas (le contenu s'allonge après lui). Borné : au-delà, la demande est
/// abandonnée et le rapport redevient un geste de l'utilisateur.
public let viewerFollowRetries = 3

/// L'état de lecture du fichier, tel qu'il est MONTRÉ.
public enum SessionViewerState: Equatable, Sendable {
    /// Le fichier n'existe pas (encore) : « en attente des premiers faits ».
    case waiting
    /// Le fichier existe mais n'a pas pu être lu : message à afficher.
    case unreadable(String)
    /// La lecture est cohérente ; zéro ligne est un état affichable de plein droit.
    case ready
}

/// La géométrie mesurée du défilement, telle que la vue la rend.
public struct ViewerScrollGeometry: Equatable, Sendable {
    /// Distance entre le bas du contenu et le bas de la zone visible, en points :
    /// `0` quand le fil est vu jusqu'au bout.
    public var gap: CGFloat
    /// Origine du défilement dans le document (`0` = début du fil). Sert au
    /// diagnostic et aux mesures, JAMAIS à décider du suivi (voir ci-dessous).
    public var origin: CGFloat

    public init(gap: CGFloat, origin: CGFloat) {
        self.gap = gap
        self.origin = origin
    }
}

/// La décision de suivi, isolée du modèle pour être PROUVABLE sans interface.
///
/// TROIS formulations écartées, chacune par une MESURE du 2026-09-28 (sonde GUI sur
/// le bundle réel, journal des distances au bas) :
///   1. `onScrollGeometryChange` (Documentation §2) était hors de portée en macOS 14,
///      cible de l'époque ; la cible est aujourd'hui macOS 26, mais le mécanisme
///      mesuré ci-dessous est CONSERVÉ tel quel (aucune nouvelle mesure ne le
///      remplace) ;
///   2. `GeometryReader` + `PreferenceKey` en arrière-plan (Documentation §2) délivre
///      UN rapport puis plus jamais — le défilement est invisible ;
///   3. la DISTANCE et l'ORIGINE seules ne distinguent pas un geste de l'utilisateur
///      d'un défilement que NOUS avons demandé : après un `scrollTo`, le document
///      s'allonge (layout paresseux) et la distance repart de 0 à ~170 points ;
///      et l'origine peut RECULER sans geste quand le document rétrécit. Une
///      politique fondée sur elles se suspendait donc elle-même, puis ne pouvait
///      plus jamais se suspendre pour de bon.
///
/// Le seul signal fiable est l'ÉVÉNEMENT de l'utilisateur : la vue observe les
/// événements de molette destinés à son propre défilement et rapporte leur sens.
/// Remonter le fil (`deltaY > 0`) suspend le suivi ; la géométrie le rétablit dès
/// que le bas du fil est atteint (c'est ce qui fait qu'un défilement vers le bas,
/// ou notre propre défilement, ne suspendent rien).
public struct FollowPolicy: Equatable, Sendable {
    /// Le suivi automatique est-il actif ?
    public var following = true
    /// Un défilement vers le bas a été DEMANDÉ et n'est pas encore arrivé : sert à
    /// savoir si une distance au bas qui ne se résorbe pas peut être redemandée.
    public var pendingFollow = false

    public init(following: Bool = true, pendingFollow: Bool = false) {
        self.following = following
        self.pendingFollow = pendingFollow
    }

    /// Un geste de l'utilisateur : `deltaY > 0` remonte le fil, donc quitte le direct.
    public mutating func applyUserScroll(deltaY: CGFloat) {
        if deltaY > 0 { following = false }
    }

    /// La géométrie mesurée : atteindre le bas du fil rend le suivi vrai.
    public mutating func applyGeometry(gap: CGFloat, slack: CGFloat) {
        if gap <= slack { following = true }
    }
}
