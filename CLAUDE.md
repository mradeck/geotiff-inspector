# geotiff-inspector — Projektkontext

Öffentliche Single-Page-App (GitHub Pages: https://mradeck.github.io/geotiff-inspector/), ohne Build-Schritt. Alle Bibliotheken liegen in `vendor/`.

## Pflicht-Bausteine jeder öffentlichen App von Michael Radeck

Diese Vorgaben gelten nach Ansage des Nutzers vom 2026-11-02 für alle öffentlichen Apps, nicht nur für dieses Repo.

1. **Versionsnummer** sichtbar in der Kopfzeile, in der Fußleiste, im Fenstertitel und im Betreff von Kontakt-Mails. Schema `Jahr.Push.Iteration`: zweistellige Jahreszahl, laufende GitHub-Pushes im Jahr, lokale Iteration. Vor jedem Push den Push-Zähler erhöhen und die Iteration auf 1 setzen, dazu CHANGELOG und README nachziehen.
2. **Sprachwahl DE/EN** als Knopf mit vektorisierter Fahne (SVG inline, DE schwarz-rot-gold, GB Union Jack) und dem Kürzel „DE“/„EN“. Die Wahl wird in `localStorage` gespeichert, beim ersten Aufruf gilt die Browsersprache. Alle Texte kommen aus einem Wörterbuch mit gleichen Schlüsseln in beiden Sprachen.
3. **Interface-Knopf automatisch / hell / dunkel**, der der Reihe nach umschaltet. „Automatisch“ folgt `prefers-color-scheme`. Die Wahl wird in `localStorage` gespeichert und vor dem ersten Zeichnen gesetzt, damit nichts aufblitzt.
4. **Neutrales Farbschema** (Grau/Blau, wie hier). Das grünliche Schema des geodata-inspector-cleaner wird ausdrücklich NICHT übernommen, weder hell noch dunkel.
5. **Zwei Fußleisten** nach dem Muster geodata-inspector-cleaner:
   - Leiste 1 „Weitere Apps“ mit Links zu Geodata Inspector & Cleaner, GeoTIFF Inspector (https://mradeck.github.io/geotiff-inspector/), MeasureMap, Geoid Forge, DXF Coordinate Forge, PointCloud Manager, GPS / UTM Converter, SkyCheck und michael-radeck.de. Die eigene App wird nicht verlinkt. Zugehörige Repos: geodata-inspector-cleaner, measuremap-viewer-editor-emlid (MeasureMap), geoid-tiff2pgm-converter (Geoid Forge), dxf-gk4-utm-converter (DXF Coordinate Forge), gps-utm-coordinate-converter; PointCloud Manager, SkyCheck und michael-radeck.de sind von der Vereinheitlichung ausgenommen.
   - Leiste 2: „Ein Werkzeug von Michael Radeck · © Jahr · Version“, außerdem verwendete Datenquellen (z. B. OpenStreetMap), Quellcode, Hilfe / Bugreport / Kontakt (Dialog, `mailto:michael.radeck@email.de` mit Version im Betreff), Lizenzen / Copyright (Dialog), Impressum (https://www.multikopterschule.de/Kontakt-Impressum/IMPRESSUM/) und Ko-fi (https://ko-fi.com/mradeck/tip).

## Arbeitsweise

- Kern ohne DOM in `inspectorCore.js`, Texte in `i18n.js`. Prüfen mit `node smoke-test.cjs <dateien.tif>` (mit `LANG_UI=en` auf Englisch).
- Neue Texte immer in DE und EN anlegen. Die Schlüssel beider Sprachen müssen gleich sein.
- Bibliotheken lokal in `vendor/` mitliefern und im Lizenzdialog sowie im README aufführen.
