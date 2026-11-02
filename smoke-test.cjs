/*
 * Smoke-Test des Kerns gegen echte GeoTIFF-Dateien.
 * Aufruf: node smoke-test.cjs <datei.tif> [<datei2.tif> …]
 * Liest jede Datei, gibt Einordnung, Erkennung und Hinweise aus und vergleicht
 * alle Paare mit gemeinsamem Knotengitter Zelle für Zelle.
 */
const fs = require("fs");
const path = require("path");
const GeoTIFF = require("./vendor/geotiff.js");
const I18N = require("./i18n.js");
const C = require("./inspectorCore.js");
if (process.env.LANG_UI) I18N.setLanguage(process.env.LANG_UI);
global.window = global;
require("./crsCatalog.js");
(async () => {
  const items = [];
  for (const f of process.argv.slice(2)) {
    const buf = fs.readFileSync(f);
    const tiff = await GeoTIFF.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const info = await C.readTiffInfo(tiff, { name: path.basename(f), size: buf.length });
    const geom = C.deriveGeometry(info);
    const crs = C.resolveCrs(info, global.CRS_CATALOG);
    const img = await tiff.getImage(0);
    const vals = info.spp === 1 ? (await img.readRasters({ samples: [0] }))[0] : null;
    const stats = vals ? C.bandStats(vals, info.nodata) : null;
    const cls = C.classify(info, crs, geom, stats);
    const known = C.recognizeKnown(info, crs, geom);
    const findings = C.buildFindings(info, crs, geom, cls, stats);
    console.log("\n#", info.fileName, "→", C.kindLabel(cls.kind), `(${cls.confidence})`, "| CRS", crs.code, C.crsLabel(crs));
    console.log("  Gründe:", cls.reasons.map(C.reasonText).join(" | "));
    console.log("  Erkannt:", known ? C.knownText(known).title : "–");
    console.log("  Stats:", stats && { min: stats.min, max: stats.max, nan: stats.nan, nd: stats.nodata });
    for (const x of findings) console.log("  [" + x.level + "]", x.text);
    items.push({ info, geom, crs, vals });
  }
  let fail = 0;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const L = C.compareLattice(items[i], items[j]);
    let line = `\nVergleich ${items[i].info.fileName} ↔ ${items[j].info.fileName}: ${L.ok ? `Gitter gleich, Versatz ${L.col}/${L.row}` : L.reason}`;
    if (L.ok && L.overlap && items[i].vals && items[j].vals) {
      const V = C.compareValues(items[i].vals, items[i].info.width, items[i].info.nodata, items[j].vals, items[j].info.width, items[j].info.nodata, L.overlap);
      line += ` | ${V.cells} Zellen, identisch: ${V.identical}, abweichend ${V.diff}, NoData-Abweichung ${V.ndMismatch}`;
      if (!V.identical) fail++;
    }
    console.log(line);
  }
  process.exitCode = fail ? 1 : 0;
})();
