# GeoTIFF-Inspektor

**Version 26.6.1** — Online: https://mradeck.github.io/geotiff-inspector/

GeoTIFF-Inspektor ist eine Single-Page-App. Sie liest die Metadaten von GeoTIFF-Dateien aus und ordnet die Dateien fachlich ein: Geoidgitter, Höhensystem-Differenzgitter, Lage-Transformationsgitter, Gelände-/Oberflächenmodell, Orthofoto oder sonstiges Raster. Außerdem zeigt sie die Dateien lagerichtig auf einer Karte. Gerechnet wird ausschließlich lokal im Browser, es wird keine Datei hochgeladen. Online geladen werden nur die OpenStreetMap-Kacheln der Grundkarte.

## Bedienung

Öffne `index.html` in einem aktuellen Browser. Ein Build-Schritt ist nicht nötig, ein einfacher statischer Server oder GitHub Pages genügt. Danach ziehst du eine oder mehrere `.tif`-/`.tiff`-Dateien auf die Ablagefläche.

Für jede Datei erscheint eine Kachel mit diesen Inhalten:

- **Einordnung** mit Sicherheitsangabe und den Gründen, auf denen sie beruht. Ausgewertet werden die GDAL-Metadaten (`TYPE`, `DESCRIPTION`, `target_crs_epsg_code`), die GeoKeys, Bandzahl und Datentyp, Photometrie, Kompression, Lagebezug, Wertebereich und Dateiname.
- **Erkennung bekannter Dateien.** Derzeit wird die GCG2016-Familie des BKG erkannt, also das German Combined Quasigeoid 2016 (ETRS89 → DHHN2016). Erkannt werden die PROJ-CDN-Fassung `de_bkg_GCG2016v2023.tif`, das BKG-Gesamtgitter `GCG2016v2023.tif` und der Süddeutschland-Ausschnitt `GCG2016v2023_S.tif`. Jeder andere Ausschnitt auf demselben Knotengitter wird mit seiner Lage im Gesamtgitter ausgewiesen.
- **Hinweise:**
  - Dateigröße gegenüber den Rohdaten sowie Kompression und Prädiktor
  - die Registrierung (PixelIsArea oder PixelIsPoint) mit Lage des ersten Knotens und der Pixelecke
  - der Lagefehler eines Lesers, der die Registrierung ignoriert
  - NoData-Kennung und Anteil leerer Zellen
  - Ziel-Höhensystem
  - Einheiten
  - Tauglichkeit als Geoid in pointcloud-manager
- **Metadaten-Tabellen:** Übersicht, GeoKeys, GDAL-Metadaten (als Tabelle und als XML) und alle TIFF-Tags.

Auf der Karte zeichnet die App die Zellhülle als durchgezogene Linie und die Knotenhülle gestrichelt. Der erste Knoten ist als gefüllter Punkt markiert, die äußere Pixelecke als offener Kreis. Darunter liegt das Rasterbild:

- Orthofotos erscheinen in Echtfarbe.
- Einbandige Gitter werden über eine Farbskala von Blau nach Rot dargestellt, NoData bleibt transparent.

Das Bild wird pixelweise aus dem Quell-CRS nach Web-Mercator umgerechnet. Deshalb erscheint ein UTM-Orthofoto abseits des Mittelmeridians korrekt um die Meridiankonvergenz gedreht.

Bei mehreren Dateien prüft die App jedes Paar mit gleichem CRS und gleicher Zellgröße auf ein gemeinsames Knotengitter. Die Registrierung beider Dateien wird dabei berücksichtigt. Einbandige Gitter vergleicht sie im Überlappungsbereich Zelle für Zelle, sodass etwa zwei verschieden große Fassungen desselben Geoids als bitgleich erkannt werden.

## Oberfläche

- **Kopfleiste:** Markenzeichen mit Titel und Version links, rechts in fester Reihenfolge „Über“ (Menü mit „Über mich“ und „Copyright“), Hilfe „(i)“ mit einer Kurzanleitung, der Interface-Knopf und der Sprachknopf. Das Erscheinungsbild (Schrift, Knöpfe, Kacheln, Dialoge) folgt dem Geodata Inspector & Cleaner.
- **Schrift:** Inter (Variable) liegt in `vendor/fonts/` und wird selbst ausgeliefert. Es werden keine externen Schriftdienste wie Google Fonts angefragt.
- **Sprache DE/EN:** Der Knopf oben rechts mit Fahne wechselt die Sprache. Alle Texte wechseln mit, auch die Hinweise und die Einordnung bereits geladener Dateien. Gespeichert wird die Wahl im Browser (`gti.lang`), beim ersten Aufruf gilt die Browsersprache.
- **Interface automatisch / hell / dunkel:** Der Knopf daneben schaltet der Reihe nach um. „Automatisch“ folgt der Systemeinstellung. Die Wahl wird ebenfalls im Browser gespeichert (`gti.theme`).
- **Fußleisten:** Die erste Leiste enthält „Weitere Apps“, die zweite Autor, Version, OpenStreetMap, Quellcode, Hilfe / Bugreport / Kontakt (per E-Mail, mit Version im Betreff), Lizenzen / Copyright, Impressum und Ko-fi.

## Koordinatenreferenzsysteme

Der Katalog `crsCatalog.js` enthält 679 EPSG-Definitionen. Er ist aus dem CRS-Katalog von pointcloud-manager erzeugt und deckt Europa, UTM weltweit, US State Plane, GDA/MGA, NZTM, JGD2011, CGCS2000, SIRGAS und einige ältere Landesdatums ab. Dazu kommen geografische Systeme wie EPSG:4326, 4258, 4937, 4979 und 3857.

Fehlt ein Code im Katalog, kann in der Kachel eine proj4-Definition eingetragen werden. Datumsgitter (`+nadgrids`) werden nicht geladen. Die Kartenposition älterer Landesdatums ist deshalb nur auf etwa einen bis fünf Meter genau, was für die Übersicht genügt.

## Grenzen

- Raster bis 25 Mio. Zellen werden für Statistik und Vergleich vollständig gelesen. Größere Raster wertet die App nur über eingebettete Übersichten aus. Für die Kartenanzeige liest sie höchstens rund 1400 Pixel je Kante, aus einer Übersicht, wenn eine vorhanden ist.
- Ausgewertet wird nur der erste Tiepoint. Raster, die über mehrere Tiepoints (GCPs) georeferenziert sind, werden nur näherungsweise platziert.
- Die Einordnung ist eine begründete Schätzung und keine Normprüfung.

## Versionsschema

`Jahr.Push.Iteration`: zweistellige Jahreszahl, laufende Nummer der GitHub-Pushes im Jahr, lokale Iteration zwischen zwei Pushes. Die Versionsgeschichte steht in [`CHANGELOG.md`](./CHANGELOG.md).

## Dateien

| Datei | Inhalt |
| --- | --- |
| `index.html` | Oberfläche, Karte, Vergleich |
| `i18n.js` | Alle Texte auf Deutsch und Englisch |
| `inspectorCore.js` | Kern ohne DOM: Einlesen, Geometrie, CRS, Einordnung, Erkennung, Hinweise, Gittervergleich |
| `crsCatalog.js` | EPSG-Code → [Bezeichnung, proj4] |
| `smoke-test.cjs` | Test des Kerns mit echten Dateien: `node smoke-test.cjs a.tif b.tif …` (Exit-Code 1, wenn sich Gitter auf gemeinsamem Knotengitter in den Werten unterscheiden) |
| `vendor/` | geotiff.js 3.0.5, proj4 2.20.8, Leaflet 1.9.4, Schrift Inter (`vendor/fonts/`, aus `@fontsource-variable/inter` 5.3.0) |

## Lizenzen

- GeoTIFF-Inspektor selbst: MIT (`LICENSE`)
- geotiff.js: MIT
- proj4js: MIT
- Leaflet: BSD-2-Clause (`vendor/LICENSE-leaflet.txt`)
- Inter (Schrift): SIL Open Font License 1.1, © The Inter Project Authors (`vendor/fonts/OFL.txt`)
- Grundkarte: © OpenStreetMap-Mitwirkende (ODbL)
- GCG2016: Bundesamt für Kartographie und Geodäsie (BKG). Die Gitterdateien sind nicht Teil dieses Repos, die App liest nur deren Metadaten und Werte lokal.
