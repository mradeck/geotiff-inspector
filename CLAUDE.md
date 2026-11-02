# geotiff-inspector — Projektkontext

Öffentliche Single-Page-App (GitHub Pages: https://mradeck.github.io/geotiff-inspector/), ohne Build-Schritt. Alle Bibliotheken liegen in `vendor/`.

## Gemeinsame Regeln der Vermessertools

Für diese App gelten die gemeinsamen Regeln aller öffentlichen Vermessertools von Michael Radeck (Version `Jahr.Push.Iteration`, Look wie Geodata Inspector & Cleaner, Kopf- und Fußleisten, Sprache/Interface, Schrift Inter, Favicon, Prüfung). Sie stehen an einer Stelle: `CLAUDE-APPS.md` im privaten Repo [mradeck/vermessertools-notizen](https://github.com/mradeck/vermessertools-notizen/blob/main/CLAUDE-APPS.md). Bei Arbeit an dieser App das Repo in die Sitzung holen und die Datei lesen. Diese CLAUDE.md enthält nur app-eigene Regeln.

**Notizen nachziehen:** Nach jedem Push dieser App auf `main` in derselben Sitzung im Repo `mradeck/vermessertools-notizen` die Projektseite der App und die Zeile in `Übersicht Vermessertools Code Entwicklung.md` (samt Änderungsprotokoll) aktualisieren.

## Arbeitsweise

- Kern ohne DOM in `inspectorCore.js`, Texte in `i18n.js`. Prüfen mit `node smoke-test.cjs <dateien.tif>` (mit `LANG_UI=en` auf Englisch).
- Neue Texte immer in DE und EN anlegen. Die Schlüssel beider Sprachen müssen gleich sein.
- Bibliotheken lokal in `vendor/` mitliefern und im Lizenzdialog sowie im README aufführen.
