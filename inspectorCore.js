/*
 * GeoTIFF-Inspektor — Kern (ohne DOM, auch in Node lauffähig).
 *
 * Liest die Metadaten einer GeoTIFF-Datei über geotiff.js, leitet daraus die
 * Gittergeometrie ab (Registrierung PixelIsArea / PixelIsPoint), ordnet die
 * Datei ein (Geoid, Datumsgitter, Geländemodell, Orthofoto, Sonstiges),
 * erkennt bekannte Dateien (GCG2016-Familie) und formuliert Hinweise.
 *
 * Abhängigkeiten werden übergeben (GeoTIFF, proj4), damit der Kern im Browser
 * und im Smoke-Test identisch läuft.
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Konstanten und Nachschlagetabellen
  // ---------------------------------------------------------------------------

  const COMPRESSION = {
    1: "keine", 2: "CCITT RLE", 3: "CCITT G3", 4: "CCITT G4", 5: "LZW",
    6: "JPEG (alt)", 7: "JPEG", 8: "Deflate (Adobe)", 32773: "PackBits",
    32946: "Deflate", 34887: "LERC", 34925: "LZMA", 50000: "Zstandard",
    50001: "WebP", 50002: "JPEG XL",
  };
  const PREDICTOR = { 1: "kein", 2: "horizontale Differenz (Ganzzahl)", 3: "Gleitkomma-Prädiktor" };
  const PHOTOMETRIC = {
    0: "WhiteIsZero", 1: "BlackIsZero (Graustufen/Daten)", 2: "RGB", 3: "Palette",
    4: "Transparenzmaske", 5: "CMYK", 6: "YCbCr", 8: "CIELab",
  };
  const SAMPLE_FORMAT = { 1: "unsigned int", 2: "signed int", 3: "float", 4: "undefiniert" };
  const MODEL_TYPE = { 1: "projiziert", 2: "geografisch", 3: "geozentrisch" };
  const RASTER_TYPE = { 1: "PixelIsArea", 2: "PixelIsPoint" };

  /** Namen der Tags, die geotiff.js als „deferred" nur über die Nummer kennt. */
  const DEFERRED_TAG_NAMES = { 42112: "GDAL_METADATA", 42113: "GDAL_NODATA", 34264: "ModelTransformation" };

  const KNOWN_GEOGRAPHIC = {
    "EPSG:4326": ["WGS 84 (geografisch)", "+proj=longlat +datum=WGS84 +no_defs"],
    "EPSG:4258": ["ETRS89 (geografisch)", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:4937": ["ETRS89 (geografisch 3D)", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:4979": ["WGS 84 (geografisch 3D)", "+proj=longlat +datum=WGS84 +no_defs"],
    "EPSG:4269": ["NAD83 (geografisch)", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:4283": ["GDA94 (geografisch)", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:7844": ["GDA2020 (geografisch)", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:3857": ["WGS 84 / Pseudo-Mercator", "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs"],
  };

  /** Bekannte vertikale Bezüge, wie sie in Geoid-GeoTIFFs auftauchen. */
  const VERTICAL_CRS = {
    7837: "DHHN2016 Höhe (Deutschland)", 5783: "DHHN92 Höhe (Deutschland)",
    5728: "LN02 Höhe (Schweiz)", 8228: "NAVD88 Höhe (ftUS)", 5703: "NAVD88 Höhe",
    3855: "EGM2008 Höhe", 5773: "EGM96 Höhe", 9274: "EVRF2000 Austria Höhe",
    5730: "EVRF2000 Höhe", 9389: "EVRF2019 Höhe", 5709: "NAP Höhe (Niederlande)",
    4937: "ETRS89 geografisch 3D (Ausgangs-CRS ellipsoidischer Höhen)",
    4979: "WGS 84 geografisch 3D (Ausgangs-CRS ellipsoidischer Höhen)",
  };

  const KIND_LABEL = {
    geoid: "Geoid / Höhenbezugsfläche",
    vgrid: "Höhensystem-Differenzgitter",
    datumgrid: "Lage-Transformationsgitter",
    dem: "Gelände-/Oberflächenmodell",
    ortho: "Orthofoto / Bild",
    other: "Sonstiges Raster",
  };

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  function fmtNum(v, d) {
    if (v === undefined || v === null || Number.isNaN(v)) return String(v);
    return Number(v).toLocaleString("de-DE", { maximumFractionDigits: d ?? 6, minimumFractionDigits: 0 });
  }
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "–";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${fmtNum(n / 1024, 1)} KiB`;
    if (n < 1024 ** 3) return `${fmtNum(n / 1024 / 1024, 2)} MiB`;
    return `${fmtNum(n / 1024 ** 3, 2)} GiB`;
  }
  function arr(v) {
    if (v === undefined || v === null) return [];
    if (typeof v === "number" || typeof v === "string") return [v];
    return Array.from(v);
  }
  function valueToText(v) {
    if (v === undefined) return "–";
    if (v === null) return "null";
    if (typeof v === "string") return v.replace(/\0+$/, "");
    if (typeof v === "number") return String(v);
    if (ArrayBuffer.isView(v) || Array.isArray(v)) {
      const a = Array.from(v);
      if (a.length > 16) return `${a.slice(0, 16).join(", ")} … (${a.length} Werte)`;
      return a.join(", ");
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  /** GDAL_METADATA-XML in Einträge zerlegen (ohne DOMParser, damit Node genügt). */
  function parseGdalMetadata(xml) {
    const items = [];
    if (!xml || typeof xml !== "string") return items;
    const re = /<Item\s+([^>]*)>([\s\S]*?)<\/Item>/g;
    let m;
    while ((m = re.exec(xml))) {
      const attrs = {};
      m[1].replace(/(\w+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ""; });
      const value = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
      items.push({ name: attrs.name ?? "", sample: attrs.sample, role: attrs.role, value });
    }
    return items;
  }
  function metaValue(items, re) {
    const hit = items.find((it) => re.test(it.name) || (it.role && re.test(it.role)));
    return hit ? hit.value : undefined;
  }

  // ---------------------------------------------------------------------------
  // Einlesen
  // ---------------------------------------------------------------------------

  async function readAllTags(fd) {
    const out = [];
    const obj = fd.toObject ? fd.toObject() : fd;
    for (const [name, value] of Object.entries(obj)) out.push({ name, value });
    const deferredIds = fd.deferredFields && fd.deferredFields.keys ? [...fd.deferredFields.keys()] : [];
    for (const id of deferredIds) {
      const name = DEFERRED_TAG_NAMES[id] || String(id);
      if (out.some((t) => t.name === name)) continue;
      let value;
      try { value = await fd.loadValue(name); } catch {
        try { value = await fd.loadValue(id); } catch (e) { value = `(nicht lesbar: ${e.message})`; }
      }
      out.push({ name, value });
    }
    return out;
  }

  function tagValue(tags, name) {
    const t = tags.find((x) => x.name === name);
    return t ? t.value : undefined;
  }

  /**
   * Liest eine GeoTIFF-Datei und liefert alle für Anzeige und Einordnung
   * nötigen Angaben. `tiff` stammt aus GeoTIFF.fromArrayBuffer/fromBlob.
   */
  async function readTiffInfo(tiff, file) {
    const imageCount = await tiff.getImageCount();
    const image = await tiff.getImage(0);
    const fd = image.fileDirectory;
    const tags = await readAllTags(fd);

    const images = [];
    for (let i = 0; i < imageCount; i++) {
      const im = i === 0 ? image : await tiff.getImage(i);
      const ifd = im.fileDirectory;
      const photometric = ifd.getValue ? ifd.getValue("PhotometricInterpretation") : ifd.PhotometricInterpretation;
      const subfile = ifd.getValue ? ifd.getValue("NewSubfileType") : ifd.NewSubfileType;
      images.push({
        index: i, width: im.getWidth(), height: im.getHeight(),
        samples: im.getSamplesPerPixel(), photometric, subfile: subfile ?? 0,
        isMask: photometric === 4 || ((subfile ?? 0) & 4) === 4,
      });
    }

    let geoKeys = {};
    try { geoKeys = image.getGeoKeys() || {}; } catch { geoKeys = {}; }

    const spp = image.getSamplesPerPixel();
    const bps = arr(tagValue(tags, "BitsPerSample"));
    const sampleFormat = arr(tagValue(tags, "SampleFormat"));
    const gdalXml = tagValue(tags, "GDAL_METADATA");
    const gdalItems = parseGdalMetadata(typeof gdalXml === "string" ? gdalXml : "");
    const nodataRaw = tagValue(tags, "GDAL_NODATA");
    const nodataText = typeof nodataRaw === "string" ? nodataRaw.replace(/\0+$/, "").trim() : undefined;
    let nodata;
    if (nodataText !== undefined && nodataText !== "") {
      nodata = /^-?nan$/i.test(nodataText) ? NaN : Number(nodataText);
    }

    return {
      fileName: file.name,
      fileSize: file.size,
      imageCount,
      images,
      width: image.getWidth(),
      height: image.getHeight(),
      spp,
      bps,
      sampleFormat,
      compression: tagValue(tags, "Compression"),
      predictor: tagValue(tags, "Predictor"),
      photometric: tagValue(tags, "PhotometricInterpretation"),
      planar: tagValue(tags, "PlanarConfiguration"),
      tileWidth: tagValue(tags, "TileWidth"),
      tileHeight: tagValue(tags, "TileLength"),
      rowsPerStrip: tagValue(tags, "RowsPerStrip"),
      extraSamples: arr(tagValue(tags, "ExtraSamples")),
      tiepoint: arr(tagValue(tags, "ModelTiepoint")),
      pixelScale: arr(tagValue(tags, "ModelPixelScale")),
      modelTransformation: arr(tagValue(tags, "ModelTransformation")),
      description: tagValue(tags, "ImageDescription"),
      software: tagValue(tags, "Software"),
      copyright: tagValue(tags, "Copyright"),
      dateTime: tagValue(tags, "DateTime"),
      smin: arr(tagValue(tags, "SMinSampleValue"))[0],
      smax: arr(tagValue(tags, "SMaxSampleValue"))[0],
      geoKeys,
      gdalXml: typeof gdalXml === "string" ? gdalXml : undefined,
      gdalItems,
      nodata,
      nodataText,
      tags,
    };
  }

  // ---------------------------------------------------------------------------
  // Geometrie: Registrierung, Knoten, Zellkanten
  // ---------------------------------------------------------------------------

  /**
   * Leitet die Gittergeometrie ab.
   *
   * Raster-Koordinaten (u, v) zählen ab der linken oberen ECKE des ersten
   * Pixels in Pixeleinheiten. Bei PixelIsArea bezeichnet der Tiepoint diese
   * Ecke, bei PixelIsPoint die MITTE des ersten Pixels. Ein Gitterknoten
   * (Wertestelle) liegt immer in der Pixelmitte (u = c + 0,5).
   */
  function deriveGeometry(info) {
    const rt = info.geoKeys.GTRasterTypeGeoKey;
    const rasterType = rt === 2 ? "point" : rt === 1 ? "area" : "unset";
    const shift = rasterType === "point" ? 0.5 : 0; // Raster-Ursprung → Ecken-Ursprung

    let a, b, c, d, e, f; // x = a·i + b·j + c ; y = d·i + e·j + f  (i, j = Raster-Koordinate laut Datei)
    let source;
    const mt = info.modelTransformation;
    if (mt.length >= 16) {
      [a, b, , c, d, e, , f] = mt;
      source = "ModelTransformation";
    } else if (info.tiepoint.length >= 6 && info.pixelScale.length >= 2) {
      const [I, J, , X, Y] = info.tiepoint;
      const [sx, sy] = info.pixelScale;
      a = sx; b = 0; c = X - I * sx;
      d = 0; e = -sy; f = Y + J * sy;
      source = "Tiepoint + PixelScale";
      if (info.tiepoint.length > 6) source += ` (${info.tiepoint.length / 6} Tiepoints, nur der erste ausgewertet)`;
    } else {
      return { ok: false, rasterType, reason: "Keine Georeferenz (weder Tiepoint/PixelScale noch ModelTransformation)." };
    }

    const rasterToModel = (i, j) => [a * i + b * j + c, d * i + e * j + f];
    const edgeToModel = (u, v) => rasterToModel(u - shift, v - shift);
    const nodeToModel = (col, row) => edgeToModel(col + 0.5, row + 0.5);
    const det = a * e - b * d;
    const modelToEdge = (x, y) => {
      const dx = x - c, dy = y - f;
      const i = (e * dx - b * dy) / det;
      const j = (-d * dx + a * dy) / det;
      return [i + shift, j + shift];
    };

    const W = info.width, H = info.height;
    const corners = [edgeToModel(0, 0), edgeToModel(W, 0), edgeToModel(W, H), edgeToModel(0, H)];
    const nodeCorners = [nodeToModel(0, 0), nodeToModel(W - 1, 0), nodeToModel(W - 1, H - 1), nodeToModel(0, H - 1)];
    const ext = (pts) => ({
      minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
    });
    const rotated = Math.abs(b) > 1e-15 || Math.abs(d) > 1e-15;

    return {
      ok: true, source, rasterType, rotated,
      cellX: Math.hypot(a, d), cellY: Math.hypot(b, e),
      affine: { a, b, c, d, e, f },
      rasterToModel, edgeToModel, nodeToModel, modelToEdge,
      cellExtent: ext(corners), nodeExtent: ext(nodeCorners),
      corners, firstNode: nodeToModel(0, 0), firstCorner: edgeToModel(0, 0),
    };
  }

  // ---------------------------------------------------------------------------
  // Koordinatenreferenzsystem
  // ---------------------------------------------------------------------------

  function resolveCrs(info, catalog) {
    const gk = info.geoKeys;
    const modelType = gk.GTModelTypeGeoKey;
    const projCode = gk.ProjectedCSTypeGeoKey;
    const geoCode = gk.GeographicTypeGeoKey;
    let code = null;
    if (modelType === 1 && projCode && projCode !== 32767) code = projCode;
    else if (modelType === 2 && geoCode && geoCode !== 32767) code = geoCode;
    else if (projCode && projCode !== 32767) code = projCode;
    else if (geoCode && geoCode !== 32767) code = geoCode;
    const key = code ? `EPSG:${code}` : null;
    let label = null, proj4def = null, source = null;
    if (key && catalog && catalog[key]) { [label, proj4def] = catalog[key]; source = "Katalog pointcloud-manager"; }
    else if (key && KNOWN_GEOGRAPHIC[key]) { [label, proj4def] = KNOWN_GEOGRAPHIC[key]; source = "eingebaut"; }
    else if (modelType === 2) {
      label = `geografisch${key ? ` (${key}, Datum nicht im Katalog)` : " (ohne EPSG-Code)"}`;
      proj4def = gk.GeogEllipsoidGeoKey === 7019 || gk.GeogSemiMajorAxisGeoKey === 6378137
        ? "+proj=longlat +ellps=GRS80 +no_defs" : "+proj=longlat +datum=WGS84 +no_defs";
      source = "Annahme Länge/Breite";
    }
    const vcode = gk.VerticalCSTypeGeoKey ?? gk.VerticalGeoKey;
    return {
      modelType, modelTypeLabel: MODEL_TYPE[modelType] ?? (modelType ? `unbekannt (${modelType})` : "fehlt"),
      code: key, label, proj4: proj4def, source,
      isGeographic: modelType === 2 || (!!proj4def && /\+proj=longlat/.test(proj4def)),
      citation: gk.GTCitationGeoKey || gk.PCSCitationGeoKey || gk.GeogCitationGeoKey,
      vertical: vcode ? { code: vcode, label: VERTICAL_CRS[vcode] ?? "unbekannt" } : null,
    };
  }

  /** Grobe Meter je Zelle, für Hinweise (keine Vermessungsgenauigkeit nötig). */
  function cellMeters(geom, crs) {
    if (!geom.ok) return null;
    if (!crs.isGeographic) return { x: geom.cellX, y: geom.cellY };
    const lat = (geom.cellExtent.minY + geom.cellExtent.maxY) / 2;
    const mPerDeg = 111320;
    return { x: geom.cellX * mPerDeg * Math.cos((lat * Math.PI) / 180), y: geom.cellY * 110574, lat };
  }

  // ---------------------------------------------------------------------------
  // Statistik
  // ---------------------------------------------------------------------------

  function bandStats(values, nodata) {
    let min = Infinity, max = -Infinity, sum = 0, n = 0, nan = 0, nd = 0;
    const ndIsNum = typeof nodata === "number" && !Number.isNaN(nodata);
    for (let k = 0; k < values.length; k++) {
      const v = values[k];
      if (Number.isNaN(v)) { nan++; continue; }
      if (ndIsNum && v === nodata) { nd++; continue; }
      if (ndIsNum && Math.abs(v - nodata) <= Math.abs(nodata) * 1e-7) { nd++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v; n++;
    }
    return { count: values.length, valid: n, nan, nodata: nd, min: n ? min : NaN, max: n ? max : NaN, mean: n ? sum / n : NaN };
  }

  // ---------------------------------------------------------------------------
  // Einordnung
  // ---------------------------------------------------------------------------

  function classify(info, crs, geom, stats) {
    const reasons = { geoid: [], vgrid: [], datumgrid: [], dem: [], ortho: [], other: [] };
    const score = { geoid: 0, vgrid: 0, datumgrid: 0, dem: 0, ortho: 0, other: 0.5 };
    const add = (k, s, why) => { score[k] += s; reasons[k].push(why); };
    const name = info.fileName.toLowerCase();
    const items = info.gdalItems;
    const type = metaValue(items, /^TYPE$/i) || "";
    const desc = (metaValue(items, /^description$/i) || "").toLowerCase();
    const allMeta = items.map((i) => `${i.name}=${i.value}`).join(" ").toLowerCase() + " " + String(info.description ?? "").toLowerCase();
    const titleMeta = items.filter((i) => /title|history|long_name|model|source/i.test(i.name)).map((i) => i.value).join(" ").toLowerCase();
    const isFloat = info.sampleFormat.includes(3);
    const singleBand = info.spp === 1;

    if (/^VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL$/i.test(type)) add("geoid", 6, "GDAL-Metadatum TYPE = VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL (PROJ-Konvention für Geoidgitter)");
    if (/^VERTICAL_OFFSET_VERTICAL_TO_VERTICAL$/i.test(type)) add("vgrid", 8, "GDAL-Metadatum TYPE = VERTICAL_OFFSET_VERTICAL_TO_VERTICAL (Differenz zweier Höhensysteme)");
    if (/^HORIZONTAL_OFFSET$/i.test(type) || /GEOCENTRIC_TRANSLATION|VELOCITY|DEFORMATION/i.test(type)) add("datumgrid", 8, `GDAL-Metadatum TYPE = ${type} (Lage-/Datumsgitter)`);
    if (/geoid_undulation/.test(desc)) add("geoid", 4, "Banddeskription geoid_undulation");
    if (/latitude_offset|longitude_offset/.test(allMeta)) add("datumgrid", 4, "Bänder latitude_offset/longitude_offset");
    if (metaValue(items, /target_crs_epsg_code/i)) add("geoid", 1, `Ziel-CRS EPSG:${metaValue(items, /target_crs_epsg_code/i)} angegeben`);
    if (crs.vertical && crs.isGeographic) add("geoid", 1.5, `VerticalCSTypeGeoKey = ${crs.vertical.code} bei geografischem Lagebezug`);
    if (/geoid|undulat|gcg20|gcg_|egm9|egm08|egm2008|egm96|gsigma|ausgeoid|nzgeoid|hbg\d|geoid\d\d/.test(name)) add("geoid", 2, "Dateiname deutet auf ein Geoidmodell");
    if (/geoid|gcg20|egm/.test(titleMeta)) add("geoid", 2, "Metadaten nennen ein Geoidmodell (z. B. GMT-Titel)");
    if (singleBand && isFloat && crs.isGeographic) add("geoid", 1.5, "Ein Float-Band in geografischen Koordinaten");
    if (stats && Number.isFinite(stats.min) && crs.isGeographic && singleBand && stats.min >= -110 && stats.max <= 90 && stats.max - stats.min < 200)
      add("geoid", 2, `Wertebereich ${fmtNum(stats.min, 2)} … ${fmtNum(stats.max, 2)} passt zu Undulationen (−107 … +86 m weltweit)`);
    if (crs.isGeographic && geom.ok && geom.cellX >= 0.001) add("geoid", 0.5, "Grobe Winkelauflösung (Geoidgitter sind typischerweise 0,5′ … 15′)");
    if (info.spp === 2 && isFloat && crs.isGeographic) add("datumgrid", 2, "Zwei Float-Bänder in geografischen Koordinaten");

    if (info.spp >= 3 && info.bps[0] === 8) add("ortho", 5, `${info.spp} Bänder à 8 Bit`);
    if (info.photometric === 2 || info.photometric === 6) add("ortho", 3, `Photometrie ${PHOTOMETRIC[info.photometric]}`);
    if (info.compression === 7 || info.compression === 50001) add("ortho", 2, `Bildkompression ${COMPRESSION[info.compression]}`);
    if (info.photometric === 3) add("ortho", 2, "Palettenbild");
    if (singleBand && info.bps[0] === 8 && !isFloat) add("other", 1, "Ein 8-Bit-Band (Graustufenbild, Klassifikation oder Maske)");
    if (!crs.isGeographic && geom.ok && geom.cellX <= 1 && info.spp >= 3) add("ortho", 1, `Bodenauflösung ${fmtNum(geom.cellX, 3)} m`);

    if (singleBand && (isFloat || (info.bps[0] === 16 && info.sampleFormat.includes(2)))) add("dem", 2, "Ein Höhen-taugliches Band (Float bzw. Int16)");
    if (singleBand && !crs.isGeographic && crs.modelType) add("dem", 1.5, "Projiziertes CRS (typisch für DGM/DOM-Kacheln)");
    if (/dgm|dtm|dem|dom|dsm|elev|height|hoehe|terrain|srtm|copernicus|aw3d/.test(name)) add("dem", 2, "Dateiname deutet auf ein Höhenmodell");
    if (stats && Number.isFinite(stats.min) && singleBand && (stats.max - stats.min > 0) && (!crs.isGeographic || stats.max - stats.min >= 200)) add("dem", 0.5, "Wertebereich wie bei Geländehöhen");
    if (singleBand && geom.ok && !crs.isGeographic && geom.cellX < 50) add("dem", 0.5, `Feines Raster (${fmtNum(geom.cellX, 3)} m)`);

    const ranked = Object.keys(score).sort((p, q) => score[q] - score[p]);
    const kind = ranked[0];
    const top = score[kind], second = score[ranked[1]];
    const confidence = top >= 6 && top - second >= 3 ? "hoch" : top >= 3 && top - second >= 1.5 ? "mittel" : "niedrig";
    return { kind, label: KIND_LABEL[kind], confidence, score, reasons: reasons[kind], allReasons: reasons };
  }

  // ---------------------------------------------------------------------------
  // Bekannte Dateien: GCG2016-Familie
  // ---------------------------------------------------------------------------

  /** Knoten-Gitter des bundesweiten GCG2016 (BKG), wie im Chat ermittelt. */
  const GCG2016 = {
    dx: 0.0125, dy: 1 / 120,
    lon0: 3.25625, lat0: 55.97916666666667, // erster Knoten (Nordwest), Zellmitte
    cols: 950, rows: 1052,
    zmin: 34.16429901123047, zmax: 50.61709976196289,
  };

  function recognizeKnown(info, crs, geom) {
    if (!geom.ok || !crs.isGeographic) return null;
    const relX = Math.abs(geom.cellX - GCG2016.dx) / GCG2016.dx;
    const relY = Math.abs(geom.cellY - GCG2016.dy) / GCG2016.dy;
    if (relX > 1e-6 || relY > 1e-6 || geom.rotated) return null;
    const [lon, lat] = geom.firstNode;
    const colF = (lon - GCG2016.lon0) / GCG2016.dx;
    const rowF = (GCG2016.lat0 - lat) / GCG2016.dy;
    const col = Math.round(colF), row = Math.round(rowF);
    const offCells = Math.max(Math.abs(colF - col), Math.abs(rowF - row));
    if (offCells > 1e-3) return null;
    const devM = Math.hypot((colF - col) * GCG2016.dx * 111320 * Math.cos((lat * Math.PI) / 180), (rowF - row) * GCG2016.dy * 110574);
    const full = col === 0 && row === 0 && info.width === GCG2016.cols && info.height === GCG2016.rows;
    const type = metaValue(info.gdalItems, /^TYPE$/i);
    const gmt = info.gdalItems.find((it) => /GMT_version/i.test(it.name));
    const hist = metaValue(info.gdalItems, /history/i);

    const r = {
      family: "GCG2016 (German Combined Quasigeoid 2016, BKG) — Bezug ETRS89 → DHHN2016",
      title: "", notes: [],
      lattice: { col, row, deviationM: devM },
      full,
    };
    r.notes.push(`Das Gitter liegt exakt auf den Knoten des bundesweiten GCG2016 (45″ × 30″, ${GCG2016.cols} × ${GCG2016.rows} Knoten). Erster Knoten = Spalte ${col}, Zeile ${row} im Gesamtgitter.`);
    if (devM > 1e-4) r.notes.push(`Die gespeicherte Georeferenz weicht um ${fmtNum(devM * 1000, 3)} mm vom ideellen Gitter ab (gerundete Gleitkommawerte im Tiepoint) — praktisch bedeutungslos.`);

    if (full && info.compression === 8 && geom.rasterType === "point" && /VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL/i.test(type || "")) {
      r.title = "de_bkg_GCG2016v2023.tif — PROJ-CDN-Fassung";
      r.notes.push("Diese Fassung verteilt PROJ über cdn.proj.org (Namensschema Land_Herausgeber_Name). Deflate + Gleitkomma-Prädiktor in 256er-Kacheln ⇒ rund 1 MB statt 4 MB.");
      r.notes.push("Registrierung PixelIsPoint: der Tiepoint (3,25625° / 55,97917°) IST der erste Knoten. NoData = 999999, PROJ-Metadaten (TYPE, DESCRIPTION, target_crs_epsg_code = 7837).");
      r.notes.push("Werte bitgleich mit dem BKG-Gesamtgitter GCG2016v2023.tif (unkomprimiert, PixelIsArea) — im Chat Zelle für Zelle geprüft.");
    } else if (full) {
      r.title = "GCG2016v2023.tif — BKG-Gesamtgitter (GMT → GDAL)";
      r.notes.push("Unkomprimierte Fassung (4 Byte × 950 × 1052 = 3 997 600 Byte Rasterdaten). Metadaten stammen aus einem GMT/netCDF-Gitter (GCG2016_BSCD2000.grd).");
      if (geom.rasterType === "area") r.notes.push("Registrierung PixelIsArea: der Tiepoint (3,25° / 55,98333°) ist die äußere Pixelecke; der erste Knoten liegt eine halbe Zelle weiter innen und ist identisch mit dem der PROJ-Fassung.");
      r.notes.push("Kein Ziel-Höhensystem in den Metadaten, NoData = NaN. Werte bitgleich mit de_bkg_GCG2016v2023.tif.");
    } else if (col === 336 && row === 644 && info.width === 518 && info.height === 408) {
      r.title = "GCG2016v2023_S.tif — Ausschnitt Süddeutschland";
      r.notes.push("Unveränderter Ausschnitt des Gesamtgitters (grdcut -R07:27:00/13:55:30/47:13:00/50:37:00), Werte bitgleich.");
      r.notes.push("Abgedeckt: Bayern und Baden-Württemberg vollständig, Südhessen, Thüringen bis ca. 50,6° N, Südsachsen westlich 13,9° O.");
      r.notes.push("Nicht abgedeckt: Saarland und großer Teil von Rheinland-Pfalz (Westgrenze 7,45° O) sowie Ostsachsen (Dresden, Lausitz). Für Projekte nahe 7,45° O die bundesweite Fassung nehmen.");
    } else {
      r.title = "Ausschnitt des GCG2016";
      r.notes.push(`Ausschnitt mit ${info.width} × ${info.height} Knoten. Gegenüber dem Gesamtgitter kein Genauigkeitsvorteil, nur weniger Speicher.`);
    }
    if (gmt && hist) r.notes.push(`Erzeugt mit GMT: „${hist}".`);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Hinweise („Erkenntnisse")
  // ---------------------------------------------------------------------------

  function buildFindings(info, crs, geom, cls, stats) {
    const out = []; // {level: info|ok|warn|err, text}
    const push = (level, text) => out.push({ level, text });
    const W = info.width, H = info.height;

    // Größe und Kompression
    const bitsPerPixel = info.bps.reduce((s, b) => s + b, 0) || (info.bps[0] ?? 8) * info.spp;
    const raw = (W * H * bitsPerPixel) / 8;
    const ratio = info.fileSize / raw;
    const comp = COMPRESSION[info.compression] ?? `Code ${info.compression}`;
    const layout = info.tileWidth ? `${info.tileWidth} × ${info.tileHeight}-Kacheln` : `Streifen à ${info.rowsPerStrip ?? "?"} Zeile(n)`;
    let sizeText = `Dateigröße ${fmtBytes(info.fileSize)}, Rohdaten ${fmtBytes(raw)} (${W} × ${H} × ${bitsPerPixel / 8} Byte) ⇒ ${fmtNum(ratio * 100, 1)} %. Kompression ${comp}`;
    if (info.predictor && info.predictor !== 1) sizeText += ` mit ${PREDICTOR[info.predictor] ?? `Prädiktor ${info.predictor}`}`;
    sizeText += `, ${layout}.`;
    const overviews = info.images.filter((im) => im.index > 0 && !im.isMask).length;
    if (overviews) sizeText += ` ${overviews} Übersichtsstufe(n) eingebettet (zählen zur Dateigröße).`;
    push("info", sizeText);
    if (info.compression === 1 && raw > 2 * 1024 * 1024) push("info", "Unkomprimiert: Deflate oder LZW (bei Float mit Prädiktor 3) würde die Datei meist auf ein Viertel bis die Hälfte verkleinern, ohne einen Wert zu ändern. Eine kleinere Datei ist also nicht automatisch ein anderes oder gröberes Modell.");

    // Georeferenz
    if (!geom.ok) { push("err", geom.reason); return out; }
    if (geom.rotated) push("warn", "ModelTransformation mit Drehung/Scherung: Das Raster ist nicht achsparallel. Viele Geoid-Leser (auch pointcloud-manager) lehnen das ab.");
    const m = cellMeters(geom, crs);
    const halfX = m ? m.x / 2 : NaN, halfY = m ? m.y / 2 : NaN;
    const unit = crs.isGeographic ? "°" : " m";
    if (geom.rasterType === "area") {
      push("info", `Registrierung PixelIsArea: Der Tiepoint bezeichnet die äußere Ecke des ersten Pixels (${fmtNum(geom.firstCorner[0], 8)}${unit} / ${fmtNum(geom.firstCorner[1], 8)}${unit}). Die Werte gelten in den Zellmitten; erster Knoten bei ${fmtNum(geom.firstNode[0], 8)}${unit} / ${fmtNum(geom.firstNode[1], 8)}${unit}.`);
    } else if (geom.rasterType === "point") {
      push("info", `Registrierung PixelIsPoint: Der Tiepoint IST der erste Knoten (${fmtNum(geom.firstNode[0], 8)}${unit} / ${fmtNum(geom.firstNode[1], 8)}${unit}). Die Zellhülle reicht eine halbe Zelle darüber hinaus.`);
    } else {
      push("warn", "GTRasterTypeGeoKey fehlt. Nach TIFF-Vorgabe gilt dann PixelIsArea; diese Annahme ist hier verwendet. Ist die Datei in Wahrheit knotenbezogen, liegt jede Abfrage eine halbe Zelle daneben.");
    }
    if (m && geom.rasterType !== "unset") {
      push("info", `Wer die Registrierung ignoriert, liest das Gitter um eine halbe Zelle verschoben: rund ${fmtNum(halfX, halfX < 10 ? 3 : 0)} m in X und ${fmtNum(halfY, halfY < 10 ? 3 : 0)} m in Y${crs.isGeographic ? ` (bei ${fmtNum(m.lat, 1)}° Breite)` : ""}. Ein Leser, der die Schrittweite aus Hülle / (Anzahl − 1) bildet, liegt zusätzlich um den Faktor ${fmtNum(W / (W - 1), 5)} daneben.`);
    }

    // CRS
    if (!crs.code && !crs.proj4) push("warn", "Kein EPSG-Code in den GeoKeys. Für die Kartenanzeige kann unten eine proj4-Definition eingetragen werden.");
    else if (crs.code && !crs.source) push("warn", `${crs.code} ist nicht im eingebauten Katalog (679 Codes aus pointcloud-manager). Für die Kartenanzeige unten eine proj4-Definition eintragen.`);
    if (crs.vertical) push("info", `VerticalCSTypeGeoKey = ${crs.vertical.code} (${crs.vertical.label}).${crs.vertical.code === 4937 || crs.vertical.code === 4979 ? " PROJ verwendet hier das 3D-Ausgangs-CRS der ellipsoidischen Höhen, nicht das Zielsystem." : ""}`);

    // Metadaten
    const type = metaValue(info.gdalItems, /^TYPE$/i);
    const unitType = (metaValue(info.gdalItems, /^UNITTYPE$|unittype/i) || "").toLowerCase();
    const target = metaValue(info.gdalItems, /target_crs_epsg_code/i);
    if (target) push("info", `Zielsystem laut Metadaten: EPSG:${target}${VERTICAL_CRS[target] ? ` (${VERTICAL_CRS[target]})` : ""}.`);
    if (/us.?survey|us_survey|ftus/.test(unitType)) push("err", "Einheit US Survey Foot: pointcloud-manager lehnt solche Geoidgitter ab (keine stille Umrechnung).");
    else if (/foot|feet|\bft\b/.test(unitType)) push("warn", "Einheit Fuß (international): Werte müssen mit 0,3048 in Meter umgerechnet werden.");
    if (info.gdalItems.some((it) => /GMT_version|NC_GLOBAL/i.test(it.name))) push("info", "Metadaten aus einem GMT/netCDF-Gitter (per GDAL umgewandelt). node_offset = 1 heißt dort pixelbezogen (≙ PixelIsArea), 0 knotenbezogen.");

    // NoData
    if (info.nodataText !== undefined) {
      const ndt = Number.isNaN(info.nodata) ? "NaN" : info.nodataText;
      let t = `NoData-Kennung: ${ndt}.`;
      if (stats) {
        const n = stats.nan + stats.nodata;
        t += ` ${fmtNum(n, 0)} von ${fmtNum(stats.count, 0)} Zellen (${fmtNum((100 * n) / stats.count, 1)} %) sind leer${stats.fromOverview ? " (gezählt in der Übersicht)" : ""}.`;
      }
      if (info.nodata === 999999 || info.nodata === -9999 || info.nodata === -32767) t += " Endliche Zahlen als NoData müssen von jedem Leser ausgewertet werden, sonst entstehen Krater bzw. Spitzen.";
      push("info", t);
    } else if (info.sampleFormat.includes(3) && stats && stats.nan > 0) {
      push("warn", `Kein GDAL_NODATA gesetzt, aber ${fmtNum(stats.nan, 0)} NaN-Zellen vorhanden.`);
    }
    if (info.smin !== undefined && info.smax !== undefined) push("info", `SMin/SMaxSampleValue im TIFF-Kopf: ${fmtNum(info.smin, 4)} … ${fmtNum(info.smax, 4)}.`);

    // Geoid-spezifisch: pointcloud-manager-Tauglichkeit
    if (cls.kind === "geoid" || cls.kind === "vgrid") {
      const problems = [];
      if (cls.kind === "vgrid") problems.push("VERTICAL_TO_VERTICAL-Gitter werden als Geoid abgelehnt");
      if (!crs.isGeographic) problems.push("kein geografisches Gitter");
      if (info.spp !== 1) problems.push("mehr als ein Band");
      if (geom.rotated) problems.push("gedrehtes Raster");
      if (/us.?survey|ftus/.test(unitType)) problems.push("US Survey Foot");
      if (crs.code && !["EPSG:4258", "EPSG:4326", "EPSG:4937", "EPSG:4979"].includes(crs.code)) problems.push(`Lagebezug ${crs.code}: in pointcloud-manager nur zulässig, wenn das Datum höchstens wenige Meter von ETRS89/WGS 84 abweicht (Tabelle seit v209)`);
      if (problems.length) push("warn", `pointcloud-manager: ${problems.join("; ")}.`);
      else push("ok", "pointcloud-manager liest diese Datei als Geoid (Registrierung wird ausgewertet, NoData wird zu NaN).");
    }
    if (cls.kind === "ortho" && crs.isGeographic) push("info", "Bild in geografischen Koordinaten: Pixel sind in Metern nicht quadratisch, eine Anzeige in einem projizierten System verzerrt leicht.");
    return out;
  }

  // ---------------------------------------------------------------------------
  // Vergleich zweier Gitter
  // ---------------------------------------------------------------------------

  /**
   * Prüft, ob zwei Raster dasselbe Knotengitter teilen, und liefert das
   * Überlappungsfenster. Berücksichtigt die Registrierung beider Dateien.
   */
  function compareLattice(A, B) {
    if (!A.geom.ok || !B.geom.ok) return { ok: false, reason: "Mindestens eine Datei ist nicht georeferenziert." };
    if (A.geom.rotated || B.geom.rotated) return { ok: false, reason: "Gedrehte Raster werden nicht verglichen." };
    if ((A.crs.code || "?") !== (B.crs.code || "?")) return { ok: false, reason: `Unterschiedliches CRS (${A.crs.code} / ${B.crs.code}).` };
    const rel = (p, q) => Math.abs(p - q) / Math.max(Math.abs(p), 1e-300);
    if (rel(A.geom.cellX, B.geom.cellX) > 1e-6 || rel(A.geom.cellY, B.geom.cellY) > 1e-6)
      return { ok: false, reason: `Unterschiedliche Zellgröße (${fmtNum(A.geom.cellX, 10)} × ${fmtNum(A.geom.cellY, 10)} gegen ${fmtNum(B.geom.cellX, 10)} × ${fmtNum(B.geom.cellY, 10)}).` };
    const [ax, ay] = A.geom.firstNode, [bx, by] = B.geom.firstNode;
    const colF = (bx - ax) / A.geom.cellX, rowF = (ay - by) / A.geom.cellY;
    const col = Math.round(colF), row = Math.round(rowF);
    const frac = Math.max(Math.abs(colF - col), Math.abs(rowF - row));
    if (frac > 1e-3) return { ok: false, sameCell: true, reason: `Gleiche Zellgröße, aber die Knoten sind um ${fmtNum(colF - col, 4)} / ${fmtNum(rowF - row, 4)} Zellen gegeneinander versetzt.` };
    const c0 = Math.max(0, col), r0 = Math.max(0, row);
    const c1 = Math.min(A.info.width, col + B.info.width), r1 = Math.min(A.info.height, row + B.info.height);
    if (c1 <= c0 || r1 <= r0) return { ok: true, col, row, overlap: null, fracCells: frac };
    return { ok: true, col, row, fracCells: frac, overlap: { colA: c0, rowA: r0, colB: c0 - col, rowB: r0 - row, width: c1 - c0, height: r1 - r0 } };
  }

  /** Vergleicht zwei Wertefelder (je eine Zeile × Spalte) im Überlappungsfenster. */
  function compareValues(valsA, widthA, ndA, valsB, widthB, ndB, ov) {
    const isNd = (v, nd) => Number.isNaN(v) || (typeof nd === "number" && !Number.isNaN(nd) && v === nd);
    let same = 0, diff = 0, maxAbs = 0, ndBoth = 0, ndMismatch = 0;
    for (let r = 0; r < ov.height; r++) {
      const ia = (ov.rowA + r) * widthA + ov.colA, ib = (ov.rowB + r) * widthB + ov.colB;
      for (let c = 0; c < ov.width; c++) {
        const a = valsA[ia + c], b = valsB[ib + c];
        const na = isNd(a, ndA), nb = isNd(b, ndB);
        if (na || nb) { if (na && nb) ndBoth++; else ndMismatch++; continue; }
        if (a === b) same++;
        else { diff++; const d = Math.abs(a - b); if (d > maxAbs) maxAbs = d; }
      }
    }
    return { cells: ov.width * ov.height, same, diff, maxAbs, ndBoth, ndMismatch, identical: diff === 0 && ndMismatch === 0 };
  }

  // ---------------------------------------------------------------------------
  // Farbrampen
  // ---------------------------------------------------------------------------

  const RAMP = [ // blau = tief, rot = hoch (wie in pointcloud-manager)
    [0, [43, 83, 186]], [0.25, [41, 170, 218]], [0.5, [116, 204, 114]],
    [0.75, [247, 207, 72]], [1, [214, 47, 39]],
  ];
  function rampColor(t) {
    if (!(t >= 0)) t = 0; if (t > 1) t = 1;
    for (let k = 1; k < RAMP.length; k++) {
      if (t <= RAMP[k][0]) {
        const [t0, c0] = RAMP[k - 1], [t1, c1] = RAMP[k];
        const s = (t - t0) / (t1 - t0);
        return [c0[0] + s * (c1[0] - c0[0]), c0[1] + s * (c1[1] - c0[1]), c0[2] + s * (c1[2] - c0[2])];
      }
    }
    return RAMP[RAMP.length - 1][1];
  }

  const api = {
    COMPRESSION, PREDICTOR, PHOTOMETRIC, SAMPLE_FORMAT, MODEL_TYPE, RASTER_TYPE, KIND_LABEL, GCG2016,
    fmtNum, fmtBytes, valueToText, parseGdalMetadata,
    readTiffInfo, deriveGeometry, resolveCrs, cellMeters, bandStats, classify, recognizeKnown,
    buildFindings, compareLattice, compareValues, rampColor, RAMP,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GeoTiffInspector = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
