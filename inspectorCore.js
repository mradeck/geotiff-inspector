/*
 * GeoTIFF-Inspektor — Kern (ohne DOM, auch in Node lauffähig).
 *
 * Liest die Metadaten einer GeoTIFF-Datei über geotiff.js, leitet daraus die
 * Gittergeometrie ab (Registrierung PixelIsArea / PixelIsPoint), ordnet die
 * Datei ein (Geoid, Datumsgitter, Geländemodell, Orthofoto, Sonstiges),
 * erkennt bekannte Dateien (GCG2016-Familie) und formuliert Hinweise.
 * Alle Texte kommen aus i18n.js (DE/EN).
 */
(function (root) {
  "use strict";

  const I18N = typeof module !== "undefined" && module.exports ? require("./i18n.js") : root.I18N;
  const t = (k, p) => I18N.t(k, p);

  // ---------------------------------------------------------------------------
  // Nachschlagen
  // ---------------------------------------------------------------------------

  const label = (prefix, code, fallbackKey) => {
    const key = `${prefix}.${code}`;
    return I18N.has(key) ? t(key) : fallbackKey ? t(fallbackKey, { c: code, v: code }) : String(code);
  };
  const compressionName = (c) => (c === 2 ? "CCITT RLE" : c === 3 ? "CCITT G3" : c === 4 ? "CCITT G4" : label("comp", c, "comp.code"));
  const predictorName = (p) => label("pred", p);
  const photometricName = (p) => label("photo", p);
  const sampleFormatName = (s) => label("sf", s);
  const modelTypeName = (m) => (m ? label("model", m, "crs.unknownModel") : t("crs.missing"));
  const verticalName = (code) => (I18N.has(`vert.${code}`) ? t(`vert.${code}`) : t("crs.unknown"));
  const KINDS = ["geoid", "vgrid", "datumgrid", "dem", "ortho", "other"];
  const kindLabel = (k) => t(`kind.${k}`);

  /** Namen der Tags, die geotiff.js als „deferred" nur über die Nummer kennt. */
  const DEFERRED_TAG_NAMES = { 42112: "GDAL_METADATA", 42113: "GDAL_NODATA", 34264: "ModelTransformation" };

  const KNOWN_CRS = {
    "EPSG:4326": ["WGS 84", "+proj=longlat +datum=WGS84 +no_defs"],
    "EPSG:4258": ["ETRS89", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:4937": ["ETRS89 (3D)", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:4979": ["WGS 84 (3D)", "+proj=longlat +datum=WGS84 +no_defs"],
    "EPSG:4269": ["NAD83", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:4283": ["GDA94", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:7844": ["GDA2020", "+proj=longlat +ellps=GRS80 +no_defs"],
    "EPSG:3857": ["WGS 84 / Pseudo-Mercator", "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs"],
  };

  // ---------------------------------------------------------------------------
  // Formatierung
  // ---------------------------------------------------------------------------

  function fmtNum(v, d) {
    if (v === undefined || v === null || Number.isNaN(v)) return String(v);
    return Number(v).toLocaleString(I18N.locale(), { maximumFractionDigits: d ?? 6, minimumFractionDigits: 0 });
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
      if (a.length > 16) return t("nValues", { list: a.slice(0, 16).join(", "), n: a.length });
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
      if (out.some((x) => x.name === name)) continue;
      let value;
      try { value = await fd.loadValue(name); } catch {
        try { value = await fd.loadValue(id); } catch (e) { value = t("unreadable", { msg: e.message }); }
      }
      out.push({ name, value });
    }
    return out;
  }

  function tagValue(tags, name) {
    const x = tags.find((y) => y.name === name);
    return x ? x.value : undefined;
  }

  /** Liest eine GeoTIFF-Datei. `tiff` stammt aus GeoTIFF.fromArrayBuffer/fromBlob. */
  async function readTiffInfo(tiff, file) {
    const imageCount = await tiff.getImageCount();
    const image = await tiff.getImage(0);
    const tags = await readAllTags(image.fileDirectory);

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

    const gdalXml = tagValue(tags, "GDAL_METADATA");
    const nodataRaw = tagValue(tags, "GDAL_NODATA");
    const nodataText = typeof nodataRaw === "string" ? nodataRaw.replace(/\0+$/, "").trim() : undefined;
    let nodata;
    if (nodataText !== undefined && nodataText !== "") nodata = /^-?nan$/i.test(nodataText) ? NaN : Number(nodataText);

    return {
      fileName: file.name,
      fileSize: file.size,
      imageCount,
      images,
      width: image.getWidth(),
      height: image.getHeight(),
      spp: image.getSamplesPerPixel(),
      bps: arr(tagValue(tags, "BitsPerSample")),
      sampleFormat: arr(tagValue(tags, "SampleFormat")),
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
      gdalItems: parseGdalMetadata(typeof gdalXml === "string" ? gdalXml : ""),
      nodata,
      nodataText,
      tags,
    };
  }

  // ---------------------------------------------------------------------------
  // Geometrie: Registrierung, Knoten, Zellkanten
  // ---------------------------------------------------------------------------

  /**
   * Raster-Koordinaten (u, v) zählen ab der linken oberen ECKE des ersten
   * Pixels in Pixeleinheiten. Bei PixelIsArea bezeichnet der Tiepoint diese
   * Ecke, bei PixelIsPoint die MITTE des ersten Pixels. Ein Gitterknoten
   * (Wertestelle) liegt immer in der Pixelmitte (u = c + 0,5).
   */
  function deriveGeometry(info) {
    const rt = info.geoKeys.GTRasterTypeGeoKey;
    const rasterType = rt === 2 ? "point" : rt === 1 ? "area" : "unset";
    const shift = rasterType === "point" ? 0.5 : 0;

    let a, b, c, d, e, f;
    let sourceKey, tiepointCount = 0;
    const mt = info.modelTransformation;
    if (mt.length >= 16) {
      [a, b, , c, d, e, , f] = mt;
      sourceKey = "mt";
    } else if (info.tiepoint.length >= 6 && info.pixelScale.length >= 2) {
      const [I, J, , X, Y] = info.tiepoint;
      const [sx, sy] = info.pixelScale;
      a = sx; b = 0; c = X - I * sx;
      d = 0; e = -sy; f = Y + J * sy;
      sourceKey = "tp";
      tiepointCount = info.tiepoint.length / 6;
    } else {
      return { ok: false, rasterType };
    }

    const rasterToModel = (i, j) => [a * i + b * j + c, d * i + e * j + f];
    const edgeToModel = (u, v) => rasterToModel(u - shift, v - shift);
    const nodeToModel = (col, row) => edgeToModel(col + 0.5, row + 0.5);
    const det = a * e - b * d;
    const modelToEdge = (x, y) => {
      const dx = x - c, dy = y - f;
      return [(e * dx - b * dy) / det + shift, (-d * dx + a * dy) / det + shift];
    };

    const W = info.width, H = info.height;
    const corners = [edgeToModel(0, 0), edgeToModel(W, 0), edgeToModel(W, H), edgeToModel(0, H)];
    const nodeCorners = [nodeToModel(0, 0), nodeToModel(W - 1, 0), nodeToModel(W - 1, H - 1), nodeToModel(0, H - 1)];
    const ext = (pts) => ({
      minX: Math.min(...pts.map((p) => p[0])), maxX: Math.max(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])), maxY: Math.max(...pts.map((p) => p[1])),
    });

    return {
      ok: true, sourceKey, tiepointCount, rasterType,
      rotated: Math.abs(b) > 1e-15 || Math.abs(d) > 1e-15,
      cellX: Math.hypot(a, d), cellY: Math.hypot(b, e),
      affine: { a, b, c, d, e, f },
      rasterToModel, edgeToModel, nodeToModel, modelToEdge,
      cellExtent: ext(corners), nodeExtent: ext(nodeCorners),
      corners, firstNode: nodeToModel(0, 0), firstCorner: edgeToModel(0, 0),
    };
  }
  function geometrySource(geom) {
    if (geom.sourceKey === "mt") return "ModelTransformation";
    return t("geo.tiepoint") + (geom.tiepointCount > 1 ? t("geo.tiepoints", { n: geom.tiepointCount }) : "");
  }

  // ---------------------------------------------------------------------------
  // Koordinatenreferenzsystem
  // ---------------------------------------------------------------------------

  function resolveCrs(info, catalog) {
    const gk = info.geoKeys;
    const modelType = gk.GTModelTypeGeoKey;
    const projCode = gk.ProjectedCSTypeGeoKey;
    const geoCode = gk.GeographicTypeGeoKey;
    const valid = (v) => v && v !== 32767;
    let code = null;
    if (modelType === 1 && valid(projCode)) code = projCode;
    else if (modelType === 2 && valid(geoCode)) code = geoCode;
    else if (valid(projCode)) code = projCode;
    else if (valid(geoCode)) code = geoCode;
    const key = code ? `EPSG:${code}` : null;
    let name = null, proj4def = null, source = null;
    if (key && catalog && catalog[key]) { [name, proj4def] = catalog[key]; source = "catalog"; }
    else if (key && KNOWN_CRS[key]) { [name, proj4def] = KNOWN_CRS[key]; source = "builtin"; }
    else if (modelType === 2) {
      name = null;
      proj4def = gk.GeogEllipsoidGeoKey === 7019 || gk.GeogSemiMajorAxisGeoKey === 6378137
        ? "+proj=longlat +ellps=GRS80 +no_defs" : "+proj=longlat +datum=WGS84 +no_defs";
      source = "assumed";
    }
    const vcode = gk.VerticalCSTypeGeoKey ?? gk.VerticalGeoKey;
    return {
      modelType, code: key, name, proj4: proj4def, source,
      isGeographic: modelType === 2 || (!!proj4def && /\+proj=longlat/.test(proj4def)),
      citation: gk.GTCitationGeoKey || gk.PCSCitationGeoKey || gk.GeogCitationGeoKey,
      verticalCode: vcode ?? null,
    };
  }
  /** Anzeigename des CRS in der aktuellen Sprache. */
  function crsLabel(crs) {
    if (crs.name) return crs.name;
    if (crs.source === "assumed") return crs.code ? t("crs.geoNoCatalog", { code: crs.code }) : t("crs.geoNoCode");
    return null;
  }

  function cellMeters(geom, crs) {
    if (!geom.ok) return null;
    if (!crs.isGeographic) return { x: geom.cellX, y: geom.cellY };
    const lat = (geom.cellExtent.minY + geom.cellExtent.maxY) / 2;
    return { x: geom.cellX * 111320 * Math.cos((lat * Math.PI) / 180), y: geom.cellY * 110574, lat };
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
      if (ndIsNum && (v === nodata || Math.abs(v - nodata) <= Math.abs(nodata) * 1e-7)) { nd++; continue; }
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v; n++;
    }
    return { count: values.length, valid: n, nan, nodata: nd, min: n ? min : NaN, max: n ? max : NaN, mean: n ? sum / n : NaN };
  }

  // ---------------------------------------------------------------------------
  // Einordnung (sprachneutral: Gründe als Schlüssel + Parameter)
  // ---------------------------------------------------------------------------

  function classify(info, crs, geom, stats) {
    const reasons = Object.fromEntries(KINDS.map((k) => [k, []]));
    const score = Object.fromEntries(KINDS.map((k) => [k, 0]));
    score.other = 0.5;
    const add = (k, s, key, params) => { score[k] += s; reasons[k].push({ key, params }); };
    const name = info.fileName.toLowerCase();
    const items = info.gdalItems;
    const type = metaValue(items, /^TYPE$/i) || "";
    const desc = (metaValue(items, /^description$/i) || "").toLowerCase();
    const allMeta = items.map((i) => `${i.name}=${i.value}`).join(" ").toLowerCase() + " " + String(info.description ?? "").toLowerCase();
    const titleMeta = items.filter((i) => /title|history|long_name|model|source/i.test(i.name)).map((i) => i.value).join(" ").toLowerCase();
    const isFloat = info.sampleFormat.includes(3);
    const singleBand = info.spp === 1;
    const target = metaValue(items, /target_crs_epsg_code/i);

    if (/^VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL$/i.test(type)) add("geoid", 6, "why.typeGeoid");
    if (/^VERTICAL_OFFSET_VERTICAL_TO_VERTICAL$/i.test(type)) add("vgrid", 8, "why.typeVgrid");
    if (/^HORIZONTAL_OFFSET$/i.test(type) || /GEOCENTRIC_TRANSLATION|VELOCITY|DEFORMATION/i.test(type)) add("datumgrid", 8, "why.typeDatum", { type });
    if (/geoid_undulation/.test(desc)) add("geoid", 4, "why.descGeoid");
    if (/latitude_offset|longitude_offset/.test(allMeta)) add("datumgrid", 4, "why.descDatum");
    if (target) add("geoid", 1, "why.target", { code: target });
    if (crs.verticalCode && crs.isGeographic) add("geoid", 1.5, "why.vertKey", { code: crs.verticalCode });
    if (/geoid|undulat|gcg20|gcg_|egm9|egm08|egm2008|egm96|gsigma|ausgeoid|nzgeoid|hbg\d|geoid\d\d/.test(name)) add("geoid", 2, "why.nameGeoid");
    if (/geoid|gcg20|egm/.test(titleMeta)) add("geoid", 2, "why.metaGeoid");
    if (singleBand && isFloat && crs.isGeographic) add("geoid", 1.5, "why.floatGeo");
    if (stats && Number.isFinite(stats.min) && crs.isGeographic && singleBand && stats.min >= -110 && stats.max <= 90 && stats.max - stats.min < 200)
      add("geoid", 2, "why.rangeGeoid", { min: stats.min, max: stats.max });
    if (crs.isGeographic && geom.ok && geom.cellX >= 0.001) add("geoid", 0.5, "why.coarse");
    if (info.spp === 2 && isFloat && crs.isGeographic) add("datumgrid", 2, "why.twoFloat");

    if (info.spp >= 3 && info.bps[0] === 8) add("ortho", 5, "why.rgbBands", { n: info.spp });
    if (info.photometric === 2 || info.photometric === 6) add("ortho", 3, "why.photometric", { p: info.photometric });
    if (info.compression === 7 || info.compression === 50001) add("ortho", 2, "why.imgCompression", { c: info.compression });
    if (info.photometric === 3) add("ortho", 2, "why.palette");
    if (singleBand && info.bps[0] === 8 && !isFloat) add("other", 1, "why.gray8");
    if (!crs.isGeographic && geom.ok && geom.cellX <= 1 && info.spp >= 3) add("ortho", 1, "why.gsd", { v: geom.cellX });

    if (singleBand && (isFloat || (info.bps[0] === 16 && info.sampleFormat.includes(2)))) add("dem", 2, "why.heightBand");
    if (singleBand && !crs.isGeographic && crs.modelType) add("dem", 1.5, "why.projected");
    if (/dgm|dtm|dem|dom|dsm|elev|height|hoehe|terrain|srtm|copernicus|aw3d/.test(name)) add("dem", 2, "why.nameDem");
    if (stats && Number.isFinite(stats.min) && singleBand && stats.max - stats.min > 0 && (!crs.isGeographic || stats.max - stats.min >= 200)) add("dem", 0.5, "why.rangeDem");
    if (singleBand && geom.ok && !crs.isGeographic && geom.cellX < 50) add("dem", 0.5, "why.fine", { v: geom.cellX });

    const ranked = Object.keys(score).sort((p, q) => score[q] - score[p]);
    const kind = ranked[0];
    const top = score[kind], second = score[ranked[1]];
    const confidence = top >= 6 && top - second >= 3 ? "hoch" : top >= 3 && top - second >= 1.5 ? "mittel" : "niedrig";
    return { kind, confidence, score, reasons: reasons[kind], allReasons: reasons };
  }

  /** Grund-Objekt → Text in der aktuellen Sprache. */
  function reasonText(r) {
    const p = { ...(r.params || {}) };
    if (r.key === "why.rangeGeoid") { p.min = fmtNum(p.min, 2); p.max = fmtNum(p.max, 2); }
    if (r.key === "why.gsd" || r.key === "why.fine") p.v = fmtNum(p.v, 3);
    if (r.key === "why.photometric") p.p = photometricName(p.p);
    if (r.key === "why.imgCompression") p.c = compressionName(p.c);
    return t(r.key, p);
  }

  // ---------------------------------------------------------------------------
  // Bekannte Dateien: GCG2016-Familie
  // ---------------------------------------------------------------------------

  const GCG2016 = {
    dx: 0.0125, dy: 1 / 120,
    lon0: 3.25625, lat0: 55.97916666666667, // erster Knoten (Nordwest), Zellmitte
    cols: 950, rows: 1052,
  };

  function recognizeKnown(info, crs, geom) {
    if (!geom.ok || !crs.isGeographic || geom.rotated) return null;
    if (Math.abs(geom.cellX - GCG2016.dx) / GCG2016.dx > 1e-6 || Math.abs(geom.cellY - GCG2016.dy) / GCG2016.dy > 1e-6) return null;
    const [lon, lat] = geom.firstNode;
    const colF = (lon - GCG2016.lon0) / GCG2016.dx;
    const rowF = (GCG2016.lat0 - lat) / GCG2016.dy;
    const col = Math.round(colF), row = Math.round(rowF);
    if (Math.max(Math.abs(colF - col), Math.abs(rowF - row)) > 1e-3) return null;
    const devM = Math.hypot((colF - col) * GCG2016.dx * 111320 * Math.cos((lat * Math.PI) / 180), (rowF - row) * GCG2016.dy * 110574);
    const full = col === 0 && row === 0 && info.width === GCG2016.cols && info.height === GCG2016.rows;
    const type = metaValue(info.gdalItems, /^TYPE$/i) || "";
    const gmt = info.gdalItems.some((it) => /GMT_version/i.test(it.name));
    const hist = metaValue(info.gdalItems, /history/i);

    let variant;
    if (full && info.compression === 8 && geom.rasterType === "point" && /VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL/i.test(type)) variant = "cdn";
    else if (full) variant = "full";
    else if (col === 336 && row === 644 && info.width === 518 && info.height === 408) variant = "south";
    else variant = "cut";
    return { family: "gcg2016", variant, col, row, deviationM: devM, full, rasterType: geom.rasterType, w: info.width, h: info.height, hist: gmt ? hist : undefined };
  }

  /** Erkennung → Titel und Notizen in der aktuellen Sprache. */
  function knownText(k) {
    const notes = [t("gcg.lattice", { cols: GCG2016.cols, rows: GCG2016.rows, col: k.col, row: k.row })];
    if (k.deviationM > 1e-4) notes.push(t("gcg.dev", { mm: fmtNum(k.deviationM * 1000, 3) }));
    let title;
    if (k.variant === "cdn") { title = t("gcg.cdnTitle"); notes.push(t("gcg.cdn1"), t("gcg.cdn2"), t("gcg.cdn3")); }
    else if (k.variant === "full") {
      title = t("gcg.fullTitle"); notes.push(t("gcg.full1"));
      if (k.rasterType === "area") notes.push(t("gcg.full2"));
      notes.push(t("gcg.full3"));
    } else if (k.variant === "south") { title = t("gcg.southTitle"); notes.push(t("gcg.south1"), t("gcg.south2"), t("gcg.south3")); }
    else { title = t("gcg.cutTitle"); notes.push(t("gcg.cut1", { w: k.w, h: k.h })); }
    if (k.hist) notes.push(t("gcg.gmt", { hist: k.hist }));
    return { family: t("gcg.family"), title, notes };
  }

  // ---------------------------------------------------------------------------
  // Hinweise
  // ---------------------------------------------------------------------------

  function buildFindings(info, crs, geom, cls, stats) {
    const out = [];
    const push = (level, text) => out.push({ level, text });
    const W = info.width, H = info.height;

    const bitsPerPixel = info.bps.reduce((s, b) => s + b, 0) || (info.bps[0] ?? 8) * info.spp;
    const raw = (W * H * bitsPerPixel) / 8;
    const layout = info.tileWidth ? t("f.tiles", { w: info.tileWidth, h: info.tileHeight }) : t("f.strips", { n: info.rowsPerStrip ?? "?" });
    let sizeText = t("f.size", {
      file: fmtBytes(info.fileSize), raw: fmtBytes(raw), w: W, h: H, b: bitsPerPixel / 8,
      pct: fmtNum((info.fileSize / raw) * 100, 1), comp: compressionName(info.compression),
      pred: info.predictor && info.predictor !== 1 ? t("f.pred", { p: predictorName(info.predictor) }) : "", layout,
    });
    const overviews = info.images.filter((im) => im.index > 0 && !im.isMask).length;
    if (overviews) sizeText += t("f.overviews", { n: overviews });
    push("info", sizeText);
    if (info.compression === 1 && raw > 2 * 1024 * 1024) push("info", t("f.uncompressed"));

    if (!geom.ok) { push("err", t("f.noGeoref")); return out; }
    if (geom.rotated) push("warn", t("f.rotated"));
    const m = cellMeters(geom, crs);
    const unit = crs.isGeographic ? "°" : " m";
    const c8 = (v) => `${fmtNum(v, 8)}${unit}`;
    if (geom.rasterType === "area") push("info", t("f.area", { cx: c8(geom.firstCorner[0]), cy: c8(geom.firstCorner[1]), nx: c8(geom.firstNode[0]), ny: c8(geom.firstNode[1]) }));
    else if (geom.rasterType === "point") push("info", t("f.point", { nx: c8(geom.firstNode[0]), ny: c8(geom.firstNode[1]) }));
    else push("warn", t("f.unset"));
    if (m && geom.rasterType !== "unset") {
      const hx = m.x / 2, hy = m.y / 2;
      push("info", t("f.halfCell", {
        x: fmtNum(hx, hx < 10 ? 3 : 0), y: fmtNum(hy, hy < 10 ? 3 : 0),
        lat: crs.isGeographic ? t("f.atLat", { lat: fmtNum(m.lat, 1) }) : "", f: fmtNum(W / (W - 1), 5),
      }));
    }

    if (!crs.code && !crs.proj4) push("warn", t("f.noEpsg"));
    else if (crs.code && !crs.source) push("warn", t("f.unknownEpsg", { code: crs.code }));
    if (crs.verticalCode) {
      let s = t("f.vertical", { code: crs.verticalCode, label: verticalName(crs.verticalCode) });
      if (crs.verticalCode === 4937 || crs.verticalCode === 4979) s += t("f.vertical3d");
      push("info", s);
    }

    const unitType = (metaValue(info.gdalItems, /^UNITTYPE$|unittype/i) || "").toLowerCase();
    const target = metaValue(info.gdalItems, /target_crs_epsg_code/i);
    if (target) push("info", t("f.target", { code: target, label: I18N.has(`vert.${target}`) ? ` (${verticalName(target)})` : "" }));
    if (/us.?survey|ftus/.test(unitType)) push("err", t("f.usft"));
    else if (/foot|feet|\bft\b/.test(unitType)) push("warn", t("f.ft"));
    if (info.gdalItems.some((it) => /GMT_version|NC_GLOBAL/i.test(it.name))) push("info", t("f.gmt"));

    if (info.nodataText !== undefined) {
      let s = t("f.nodata", { v: Number.isNaN(info.nodata) ? "NaN" : info.nodataText });
      if (stats) {
        const n = stats.nan + stats.nodata;
        s += t("f.nodataCount", { n: fmtNum(n, 0), total: fmtNum(stats.count, 0), pct: fmtNum((100 * n) / stats.count, 1), ov: stats.fromOverview ? t("f.nodataOverview") : "" });
      }
      if ([999999, -9999, -32767, -32768].includes(info.nodata)) s += t("f.nodataFinite");
      push("info", s);
    } else if (info.sampleFormat.includes(3) && stats && stats.nan > 0) {
      push("warn", t("f.nanNoTag", { n: fmtNum(stats.nan, 0) }));
    }
    if (info.smin !== undefined && info.smax !== undefined) push("info", t("f.sminmax", { min: fmtNum(info.smin, 4), max: fmtNum(info.smax, 4) }));

    if (cls.kind === "geoid" || cls.kind === "vgrid") {
      const problems = [];
      if (cls.kind === "vgrid") problems.push(t("p.vgrid"));
      if (!crs.isGeographic) problems.push(t("p.notGeo"));
      if (info.spp !== 1) problems.push(t("p.multiBand"));
      if (geom.rotated) problems.push(t("p.rotated"));
      if (/us.?survey|ftus/.test(unitType)) problems.push(t("p.usft"));
      if (crs.code && !["EPSG:4258", "EPSG:4326", "EPSG:4937", "EPSG:4979"].includes(crs.code)) problems.push(t("p.datum", { code: crs.code }));
      push(problems.length ? "warn" : "ok", problems.length ? t("f.pcmProblems", { list: problems.join("; ") }) : t("f.pcmOk"));
    }
    if (cls.kind === "ortho" && crs.isGeographic) push("info", t("f.orthoGeo"));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Vergleich zweier Gitter
  // ---------------------------------------------------------------------------

  function compareLattice(A, B) {
    if (!A.geom.ok || !B.geom.ok) return { ok: false, reason: t("cmp.notGeoref") };
    if (A.geom.rotated || B.geom.rotated) return { ok: false, reason: t("cmp.rotated") };
    if ((A.crs.code || "?") !== (B.crs.code || "?")) return { ok: false, crsMismatch: true, reason: t("cmp.crs", { a: A.crs.code, b: B.crs.code }) };
    const rel = (p, q) => Math.abs(p - q) / Math.max(Math.abs(p), 1e-300);
    if (rel(A.geom.cellX, B.geom.cellX) > 1e-6 || rel(A.geom.cellY, B.geom.cellY) > 1e-6)
      return { ok: false, reason: t("cmp.cell", { a: `${fmtNum(A.geom.cellX, 10)} × ${fmtNum(A.geom.cellY, 10)}`, b: `${fmtNum(B.geom.cellX, 10)} × ${fmtNum(B.geom.cellY, 10)}` }) };
    const [ax, ay] = A.geom.firstNode, [bx, by] = B.geom.firstNode;
    const colF = (bx - ax) / A.geom.cellX, rowF = (ay - by) / A.geom.cellY;
    const col = Math.round(colF), row = Math.round(rowF);
    const frac = Math.max(Math.abs(colF - col), Math.abs(rowF - row));
    if (frac > 1e-3) return { ok: false, reason: t("cmp.shift", { dx: fmtNum(colF - col, 4), dy: fmtNum(rowF - row, 4) }) };
    const c0 = Math.max(0, col), r0 = Math.max(0, row);
    const c1 = Math.min(A.info.width, col + B.info.width), r1 = Math.min(A.info.height, row + B.info.height);
    if (c1 <= c0 || r1 <= r0) return { ok: true, col, row, overlap: null };
    return { ok: true, col, row, overlap: { colA: c0, rowA: r0, colB: c0 - col, rowB: r0 - row, width: c1 - c0, height: r1 - r0 } };
  }

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
  // Farbrampe (blau = tief, rot = hoch)
  // ---------------------------------------------------------------------------

  const RAMP = [[0, [43, 83, 186]], [0.25, [41, 170, 218]], [0.5, [116, 204, 114]], [0.75, [247, 207, 72]], [1, [214, 47, 39]]];
  function rampColor(v) {
    if (!(v >= 0)) v = 0; if (v > 1) v = 1;
    for (let k = 1; k < RAMP.length; k++) {
      if (v <= RAMP[k][0]) {
        const [t0, c0] = RAMP[k - 1], [t1, c1] = RAMP[k];
        const s = (v - t0) / (t1 - t0);
        return [c0[0] + s * (c1[0] - c0[0]), c0[1] + s * (c1[1] - c0[1]), c0[2] + s * (c1[2] - c0[2])];
      }
    }
    return RAMP[RAMP.length - 1][1];
  }

  const api = {
    GCG2016, KINDS, RAMP,
    fmtNum, fmtBytes, valueToText, parseGdalMetadata,
    compressionName, predictorName, photometricName, sampleFormatName, modelTypeName, verticalName, kindLabel,
    readTiffInfo, deriveGeometry, geometrySource, resolveCrs, crsLabel, cellMeters, bandStats,
    classify, reasonText, recognizeKnown, knownText, buildFindings, compareLattice, compareValues, rampColor,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GeoTiffInspector = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
