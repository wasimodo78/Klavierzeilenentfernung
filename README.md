# Noten Extraktor - Projektplan & Architektur (Vektor-Ansatz)

## Aktueller Stand (v10)
Bisher nutzt die App einen **pixelbasierten Ansatz (Projektionsprofile)**, bei dem die PDF-Seiten in Bilder (Canvas) umgewandelt und die Schwarzanteile in horizontalen Linien gezählt werden, um Notensysteme und Lücken zu finden. 
**Problem:** Dieser Ansatz ist extrem fehleranfällig bei leicht abweichenden Layouts, starkem Textanteil oder unregelmäßigen Abständen. Die pixelbasierte Methode hat ihr Limit erreicht.

## Der neue Weg: Vektoranalyse (Ansatz 2)
Um das Drucklayout semantisch und präzise zu verstehen, wechseln wir von der Pixelanalyse zur **direkten Vektor- und Objektanalyse der PDF-Datei**. 

Statt ein gerastertes Bild anzuschauen, lesen wir die nativen Zeichenbefehle (Paths, Lines, Glyphs) der PDF über Bibliotheken wie `pdf.js` aus.

### Kernkonzepte der neuen Architektur

1. **Systemlinien erkennen (Vektoriell)**
   - Suchen nach Gruppen von exakt 5 horizontalen, parallelen Linien mit identischem Abstand. Dies definiert zweifelsfrei ein Notensystem.

2. **Klammer-Erkennung (Der Schlüssel zur Struktur)**
   - **Gerade Chorklammer:** Eine lange vertikale Linie, oft mit kleinen horizontalen Haken an den Enden. Sie fasst die Gesangsstimmen zusammen.
   - **Geschweifte Klammer (Akkolade / Klavier):** Besteht entweder aus komplexen Bezier-Kurven oder ist ein spezielles Text-Zeichen (Glyph) aus einem Musik-Font (z.B. Maestro, Sonata, Bravura). Sie fasst die beiden Klaviersysteme zusammen.
   - *Ziel:* Diese Objekte über ihre Vektoreigenschaften (Länge, Kurvenform, SVG-Path-Ähnlichkeit) zweifelsfrei identifizieren, nicht über Pixel.

3. **Semantisches Mapping (Strukturbaum aufbauen)**
   - Durch die Y-Koordinaten der gefundenen Klammern wissen wir exakt, welche Notensysteme zum Chor (gerade Klammer) und welche zum Klavier (geschweifte Klammer) gehören.
   - Texte (Liedtext, Titel, Dynamik) werden als PDF-Textobjekte erkannt und über ihre Bounding-Box dem jeweiligen System zugeordnet.

4. **Präziser Zuschnitt (Cropping) oder Neu-Rendering**
   - Da wir die exakten mathematischen Koordinaten jedes Elements kennen, können wir die Klavier-Systeme chirurgisch präzise herausschneiden oder ausblenden.
   - Der Export kann potenziell verlustfrei erfolgen, indem wir einfach die Zeichenbefehle für das Klavier aus dem PDF-Datenstrom entfernen, anstatt Bilder zuzuschneiden.

## Synergie-Potenzial (Zukunft)
Dieses Vektor-Verständnis ist die Grundlage für echte **Optical Music Recognition (OMR)**. 
Wenn die App versteht, wie Notenlinien, Klammern und Hälse vektoriell aufgebaut sind, lässt sich diese Engine in einer zukünftigen App nutzen, um **schlechte Scans zu verbessern**. Wir können unsaubere Pixelstrukturen mit sauberen, deckungsgleichen Vektor-Templates abgleichen und das Notenbild in perfekter Druckqualität neu aufbauen.

## Nächste Schritte für Entwickler
1. `pdf.js` (oder eine alternative Node/Browser-PDF-Lib) so konfigurieren, dass sie `getOperatorList()` aufruft, um Pfade, Linien und Schriften zu extrahieren.
2. Einen Algorithmus schreiben, der die `moveTo` / `lineTo` / `curveTo` Befehle auswertet, um die geschweiften Klammern zu detektieren.
3. Den Bounding-Box-Algorithmus umschreiben, sodass er auf diesen Metadaten aufbaut, statt den Canvas zu rastern.

## Ansatz 3: Vektorisierung aus Pixeln (Computer Vision / OMR)

Da du korrekterweise angemerkt hast, dass wir nicht davon ausgehen können, dass die PDF saubere Vektordaten liefert (viele Partituren sind einfach eingescannte Bilder in einem PDF-Container), müssen wir die **Vektorisierung selbst aus den gerasterten Pixeln berechnen**. 

Wir rendern die Seite weiterhin als Bild, aber anstatt nur simple horizontale Pixel-Summen zu bilden, nutzen wir **Computer Vision Techniken**, um die Pixel in geometrische Vektoren (Linien, Kurven, Boxen) zurückzurechnen.

### Kernkonzepte der Pixel-zu-Vektor Analyse

1. **Kantendetektion & Binarisierung (Thresholding)**
   - Das gerasterte Bild wird in harte Schwarz/Weiß-Werte umgewandelt, um Graustufen-Artefakte und Rauschen von schlechten Scans zu eliminieren.

2. **Horizontale Linien-Extraktion (Morphologische Operationen / Run-Length)**
   - Wir suchen nicht nach der Gesamthelligkeit einer Zeile, sondern nach zusammenhängenden, langen schwarzen horizontalen Linien.
   - Wenn wir 5 parallele Linien mit exakt dem gleichen Abstand finden, haben wir ein **Notensystem (Staff)** zweifelsfrei identifiziert – unabhängig davon, wie viele Noten oder Texte darauf liegen.

3. **Das Spatium dynamisch berechnen**
   - Genau hier kommt das **Spatium** ins Spiel: Der Abstand zwischen diesen 5 gefundenen Linien definiert das lokale Spatium dieses Systems.
   - Alle weiteren Suchparameter (wie dick darf eine Klammer sein, wie weit dürfen Systeme voneinander entfernt sein, um als Akkolade zu gelten) werden ab jetzt als Vielfaches dieses Spatiums berechnet.

4. **Klammer-Detektion am linken Rand (Connected Components / Konturanalyse)**
   - Wir scannen den linken Rand (unter Berücksichtigung von Einrückungen / Indentation im ersten System) nach vertikal verbindenden Elementen.
   - **Gerade Klammer:** Eine lange Bounding-Box, die sehr schmal ist.
   - **Geschweifte Klammer:** Eine Bounding-Box, die breiter ist und eine spezifische Kurven-Kontur aufweist (lässt sich durch das Verhältnis von schwarzen zu weißen Pixeln innerhalb der Box approximieren).

5. **Zusammenbau des Strukturbaums**
   - Anhand der Klammern wissen wir, welche Notensysteme zu einer Gruppe (Akkolade) gehören.
   - Wir wissen nun semantisch: System 1 & 2 = Chor (gerade Klammer), System 3 & 4 = Klavier (geschweifte Klammer).
   - Wir schneiden das Bild exakt anhand der Y-Koordinaten der Klavier-Systeme ab.

Dieses Vorgehen ist wesentlich robuster, da es das Prinzip von *Optical Music Recognition (OMR)* anwendet: Wir bringen dem Algorithmus bei, die Architektur des Notensatzes *visuell* zu verstehen.

## Spezifika des Notensatzes (Engraving Rules) für die Vektoranalyse

Um das PDF nicht nur als Sammlung von Linien, sondern semantisch als Partitur zu verstehen, muss der Algorithmus die fundamentalen Regeln des Notensatzes (Music Engraving) berücksichtigen:

1. **Das Spatium (Staff Space) als absolute Maßeinheit**
   - Das **Spatium** (Plural: Spatia) bezeichnet den Abstand zwischen zwei benachbarten Notenlinien innerhalb eines 5-Liniensystems.
   - **Alles ist proportional:** Im professionellen Notensatz existieren (fast) keine festen Pixel- oder Millimeter-Werte für Symbole. Die Größe von Notenköpfen, die Dicke von Notenlinien, der Abstand von Liedtexten und die Größe von Klammern berechnen sich immer relativ zum lokalen Spatium (z.B. ist ein Notenkopf exakt 1 Spatium hoch, eine Notenlinie ca. 0.1 Spatia dick).
   - *Konsequenz für die App:* Die Vektoranalyse muss als allererstes das Spatium für jedes System berechnen. Alle weiteren Schwellenwerte (Thresholds) für Abstände oder Symbolgrößen müssen dynamisch als Faktor des Spatiums (z.B. `2.5 * spatium`) formuliert werden, nicht als absolute Konstanten.

2. **Lokale Größenvarianz innerhalb einer Seite**
   - Das Spatium ist nicht global für das ganze Dokument identisch!
   - Oft wird die Klavierbegleitung etwas kleiner gedruckt als die Solostimme, oder umgekehrt (z.B. 6.5mm vs. 7.5mm Systemhöhe). Auch "Ossia"-Takte oder Stichnoten (Cue Notes) sind skaliert.
   - *Konsequenz für die App:* Die Detektion von Systemlinien muss tolerant gegenüber Skalierungen sein. Jedes gefundene System speichert seinen eigenen, lokalen Spatium-Wert ab.

3. **Einzug der Akkolade (System Indentation)**
   - Ein absolutes Standard-Merkmal im Notensatz: Das **erste System** (die erste Akkolade) eines Stückes oder eines neuen Satzes ist fast immer **horizontal eingerückt** (Indentation). Dies geschieht, um Platz für die ausgeschriebenen, vollen Instrumentennamen zu schaffen.
   - Folgesysteme haben meist nur Abkürzungen und sind nicht (oder deutlich weniger) eingerückt.
   - *Konsequenz für die App:* Der linke Rand (die X-Koordinate der Akkoladenstrichs / der Klammern) springt. Ein simpler vertikaler Scan an X=0 oder X=20 wird fehlschlagen. Die Klammernerkennung muss die X-Koordinate flexibel über die Breite suchen, kann aber davon ausgehen, dass alle Folgesysteme ab dem zweiten System linksbündig auf der gleichen X-Achse starten.

Diese typografischen Regeln sind essenziell, um das PDF wie ein Musiknotationsprogramm zu lesen und nicht wie ein dummes Bild-Zuschneide-Tool.