# Changelog

Versionsschema `Jahr.Push.Iteration` (zweistellige Jahreszahl · laufende GitHub-Pushes im Jahr · lokale Iteration zwischen zwei Pushes).

## 26.6.1 — 2026-11-02

- Erscheinungsbild an den Geodata Inspector & Cleaner angeglichen: Kopfleiste mit Markenzeichen, Titel in Großbuchstaben mit kleiner Version und Unterzeile, Datenschutz-Hinweis, Knöpfe, Kacheln, Eyebrow-Überschriften, Ablagefläche und Dialoge. Kartenansicht und Funktionen bleiben unverändert.
- Kopfleiste rechts in fester Reihenfolge: „Über“ (Menü mit „Über mich“ und „Copyright“), Hilfe „(i)“, Interface-Knopf, Sprachknopf.
- Neuer Dialog „Über mich“ (Text wie im Geodata Inspector & Cleaner) und neuer Hilfedialog mit Kurzanleitung, beides auf Deutsch und Englisch. Die Schaltfläche „Hilfe öffnen“ im Kontaktdialog führt jetzt dorthin.
- Schrift Inter (Variable) selbst ausgeliefert unter `vendor/fonts/` mit Lizenztext `OFL.txt`, aufgeführt im Lizenzdialog und im README. Keine Anfragen an externe Schriftdienste.
- MeasureMap-Link zeigt auf https://measuremap-viewer-editor.netlify.app/.

## 26.4.1 — 2026-11-02

- Sprachwahl Deutsch/Englisch über einen Knopf mit Fahne (Vektorgrafik). Alle Texte sind übersetzt, auch Einordnung, Hinweise, Erkennung und Vergleich, und wechseln bei bereits geladenen Dateien mit. Die Wahl wird im Browser gespeichert.
- Interface-Knopf automatisch / hell / dunkel. Die Wahl wird im Browser gespeichert. Das neutrale Farbschema bleibt.
- Zwei Fußleisten: „Weitere Apps“ sowie Autor, Version, OpenStreetMap, Quellcode, Hilfe / Bugreport / Kontakt, Lizenzen / Copyright, Impressum und Ko-fi. Hilfe/Kontakt und Lizenzen öffnen je ein Dialogfenster.
- Die Version steht in der Kopfzeile, in der Fußleiste, im Fenstertitel und im Betreff der Kontakt-Mails.
- Umstellung des Versionsschemas von `vYY.MM.major.sub` (v26.11.1.0) auf `Jahr.Push.Iteration`.

## 26.3 — 2026-11-02

- Inhaber der MIT-Lizenz: Michael Radeck.

## 26.2 — 2026-11-02

- MIT-Lizenz ergänzt.

## 26.1 (v26.11.1.0) — 2026-11-02

- Erste Fassung: Metadaten, Einordnung Geoid / Datumsgitter / Höhenmodell / Orthofoto, Erkennung der GCG2016-Familie, Gittervergleich, lagerichtige Kartenanzeige.
